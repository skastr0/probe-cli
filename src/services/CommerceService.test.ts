import { describe, expect, test } from "bun:test"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Layer, ManagedRuntime } from "effect"
import { decodeCommerceValidationPlan } from "../domain/commerce"
import { ArtifactStore } from "./ArtifactStore"
import { CommerceService, CommerceServiceLive } from "./CommerceService"
import { DaemonClient } from "./DaemonClient"

const buildArtifactStoreStub = (capture?: { readonly derivedOutputs?: Array<{ readonly sessionId: string; readonly label: string; readonly content: string }> }) =>
  ArtifactStore.of({
    getRootDirectory: () => Effect.succeed("/tmp/probe"),
    getArtifactRetentionMs: () => 60_000,
    getDaemonSocketPath: () => Effect.succeed("/tmp/probe.sock"),
    getDaemonMetadataPath: () => Effect.succeed("/tmp/daemon.json"),
    ensureDaemonDirectories: () => Effect.void,
    isDaemonRunning: () => Effect.succeed(false),
    readDaemonMetadata: () => Effect.succeed(null),
    createSessionLayout: () => Effect.die("unused createSessionLayout"),
    removeSessionLayout: () => Effect.void,
    readSessionManifest: () => Effect.succeed(null),
    listPersistedSessions: () => Effect.succeed([]),
    writeSessionManifest: () => Effect.void,
    registerArtifact: (_sessionId: string, record: any) => Effect.succeed(record),
    listArtifacts: () => Effect.succeed([]),
    getArtifact: () => Effect.die("unused getArtifact"),
    writeDerivedOutput: ({ sessionId, label, content, summary }: {
      readonly sessionId: string
      readonly label: string
      readonly content: string
      readonly summary: string
    }) => {
      capture?.derivedOutputs?.push({ sessionId, label, content })
      return Effect.succeed({
        key: `derived-${label}`,
        label,
        kind: "json" as const,
        summary,
        absolutePath: `/tmp/${label}.json`,
        relativePath: `outputs/${label}.json`,
        external: false,
        createdAt: "2026-04-14T00:00:00.000Z",
      })
    },
    writeDerivedFile: () => Effect.die("unused writeDerivedFile"),
    removeDaemonMetadata: () => Effect.void,
    writeDaemonMetadata: () => Effect.void,
    syncDaemonSessionMetadata: () => Effect.void,
    pruneExpiredSessions: () => Effect.void,
  } as any)

const buildDaemonClientStub = () =>
  DaemonClient.of({
    ping: () => Effect.die("unused ping"),
    listSessions: () => Effect.die("unused listSessions"),
    openSession: () => Effect.die("unused openSession"),
    showSession: () => Effect.die("unused showSession"),
    getSessionHealth: () => Effect.succeed({
      sessionId: "session-1",
      state: "ready",
      openedAt: "2026-04-14T00:00:00.000Z",
      updatedAt: "2026-04-14T00:00:00.000Z",
      expiresAt: "2026-04-14T00:15:00.000Z",
      artifactRoot: "/tmp/probe/session-1",
      target: {
        platform: "simulator",
        bundleId: "com.example.app",
        deviceId: "sim-1",
        deviceName: "iPhone 16",
        runtime: "iOS 18.0",
      },
      connection: {
        status: "connected",
        checkedAt: "2026-04-14T00:00:00.000Z",
        summary: "ok",
        details: [],
      },
      resources: {
        runner: "ready",
        debugger: "not-requested",
        logs: "ready",
        trace: "not-requested",
      },
      capabilities: [],
      warnings: [],
      artifacts: [],
      transport: {
        kind: "simulator-runner",
        contract: "probe.runner.transport/hybrid-v1",
        bootstrapSource: "simulator-bootstrap-manifest",
        bootstrapPath: "/tmp/bootstrap.json",
        sessionIdentifier: "session-1",
        commandIngress: "http-post",
        eventEgress: "stdout-jsonl-mixed-log",
        stdinProbeStatus: "ok",
        note: "ok",
      },
      runner: {
        kind: "simulator-runner",
        wrapperProcessId: 1,
        testProcessId: 2,
        targetProcessId: 3,
        attachLatencyMs: 100,
        runtimeControlDirectory: "/tmp/runtime",
        observerControlDirectory: "/tmp/observer",
        logPath: "/tmp/runner.log",
        buildLogPath: "/tmp/build.log",
        stdoutEventsPath: "/tmp/stdout.jsonl",
        resultBundlePath: "/tmp/result.xcresult",
        wrapperStderrPath: "/tmp/stderr.log",
        stdinProbeStatus: "ok",
      },
      healthCheck: {
        checkedAt: "2026-04-14T00:00:00.000Z",
        wrapperRunning: true,
        pingRttMs: 10,
        lastCommand: null,
        lastOk: true,
      },
      debugger: {
        attachState: "not-attached",
        targetScope: null,
        bridgePid: null,
        bridgeStartedAt: null,
        bridgeExitedAt: null,
        pythonExecutable: null,
        lldbPythonPath: null,
        lldbVersion: null,
        attachedPid: null,
        processState: null,
        stopId: null,
        stopReason: null,
        stopDescription: null,
        lastCommand: null,
        lastCommandOk: null,
        lastUpdatedAt: null,
        frameLogArtifactKey: null,
        stderrArtifactKey: null,
      },
      coordination: {
        runnerActionsBlocked: false,
        runnerActionPolicy: "normal",
        reason: null,
      },
    } as any),
    closeSession: () => Effect.die("unused closeSession"),
    getSessionLogs: () => Effect.die("unused getSessionLogs"),
    markSessionLog: () => Effect.die("unused markSessionLog"),
    captureLogWindow: () => Effect.die("unused captureLogWindow"),
    getLogDoctorReport: () => Effect.die("unused getLogDoctorReport"),
    runSessionDebugCommand: () => Effect.die("unused runSessionDebugCommand"),
    captureScreenshot: () => Effect.die("unused captureScreenshot"),
    recordVideo: () => Effect.die("unused recordVideo"),
    captureSnapshot: () => Effect.die("unused captureSnapshot"),
    performSessionAction: () => Effect.die("unused performSessionAction"),
    runSessionFlow: () => Effect.succeed({
      contract: "probe.session-flow/report-v1",
      executedAt: "2026-04-14T00:00:00.000Z",
      sessionId: "session-1",
      summary: "probe flow passed",
      verdict: "passed",
      executedSteps: [],
      failedStep: null,
      retries: 0,
      artifacts: [],
      finalSnapshotId: null,
      warnings: [],
    }),
    exportSessionRecording: () => Effect.die("unused exportSessionRecording"),
    replaySessionRecording: () => Effect.die("unused replaySessionRecording"),
    getSessionResultSummary: () => Effect.die("unused getSessionResultSummary"),
    getSessionResultAttachments: () => Effect.die("unused getSessionResultAttachments"),
    recordPerf: () => Effect.die("unused recordPerf"),
    recordPerfAroundFlow: () => Effect.die("unused recordPerfAroundFlow"),
    summarizePerfBySignpost: () => Effect.die("unused summarizePerfBySignpost"),
    drillArtifact: () => Effect.die("unused drillArtifact"),
    captureDiagnosticBundle: () => Effect.die("unused captureDiagnosticBundle"),
  })

describe("CommerceService", () => {
  test("doctor verifies local workspace commerce prerequisites and reports stubs honestly", async () => {
    const root = await mkdtemp(join(tmpdir(), "probe-commerce-doctor-"))

    try {
      const projectDirectory = join(root, "ios", "DemoApp", "DemoApp.xcodeproj")
      const configDirectory = join(root, "config")
      await mkdir(projectDirectory, { recursive: true })
      await mkdir(configDirectory, { recursive: true })
      await writeFile(
        join(projectDirectory, "project.pbxproj"),
        `PRODUCT_BUNDLE_IDENTIFIER = com.example.app;\nTargetAttributes = {\n  SystemCapabilities = {\n    com.apple.InAppPurchase = {\n      enabled = 1;\n    };\n  };\n};\n`,
        "utf8",
      )
      await writeFile(
        join(root, "ios", "DemoApp", "Local.storekit"),
        JSON.stringify({
          products: [
            {
              productID: "com.example.pro.monthly",
            },
          ],
        }, null, 2),
        "utf8",
      )
      await writeFile(
        join(root, ".env.local"),
        [
          "API_BASE_URL=https://api.example.com",
          "REVENUECAT_IOS_API_KEY=appl_public_monthly_key",
          "",
        ].join("\n"),
        "utf8",
      )
      await writeFile(
        join(configDirectory, "revenuecat-offerings.json"),
        JSON.stringify({
          offerings: {
            default: {
              packages: {
                "$rc_monthly": {
                  productId: "com.example.pro.monthly",
                  entitlement: "pro",
                },
              },
            },
          },
        }, null, 2),
        "utf8",
      )

      const baseLayer = Layer.mergeAll(
        Layer.succeed(ArtifactStore, buildArtifactStoreStub()),
        Layer.succeed(DaemonClient, buildDaemonClientStub()),
      )
      const runtime = ManagedRuntime.make(Layer.mergeAll(baseLayer, CommerceServiceLive.pipe(Layer.provide(baseLayer))))

      try {
        const service = await runtime.runPromise(Effect.gen(function* () {
          return yield* CommerceService
        }))
        const report = await runtime.runPromise(service.doctor({
          bundleId: "com.example.app",
          rootDir: root,
          mode: "local-storekit",
          provider: "revenuecat",
        }))

        expect(report.verdict).toBe("configured")
        expect(report.checks.find((check) => check.key === "workspace.bundle-id")?.verdict).toBe("verified")
        expect(report.checks.find((check) => check.key === "workspace.in-app-purchase-capability")?.verdict).toBe("verified")
        expect(report.checks.find((check) => check.key === "workspace.storekit-config")?.verdict).toBe("verified")
        expect(report.checks.find((check) => check.key === "workspace.revenuecat-sdk-key")?.verdict).toBe("configured")
        expect(report.checks.find((check) => check.key === "workspace.revenuecat-offerings")?.verdict).toBe("configured")
        expect(report.checks.find((check) => check.key === "workspace.revenuecat-package-product-mapping")?.verdict).toBe("configured")
        expect(report.checks.find((check) => check.key === "workspace.revenuecat-entitlement-mapping")?.verdict).toBe("configured")
        expect(report.checks.find((check) => check.key === "storekit.revenuecat-product-consistency")?.verdict).toBe("configured")
        expect(report.checks.find((check) => check.key === "revenuecat.offering-resolves")?.stub).toBe(true)
        expect(report.checks.find((check) => check.key === "revenuecat.offering-resolves")?.verification).toBe("externally-gated")
        expect(report.timingFacts.some((fact) => fact.includes("CustomerInfo"))).toBe(true)
      } finally {
        await runtime.dispose()
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("doctor flags test-store keys and RevenueCat-to-StoreKit mismatches locally", async () => {
    const root = await mkdtemp(join(tmpdir(), "probe-commerce-doctor-blocked-"))

    try {
      const projectDirectory = join(root, "ios", "DemoApp", "DemoApp.xcodeproj")
      const configDirectory = join(root, "config")
      await mkdir(projectDirectory, { recursive: true })
      await mkdir(configDirectory, { recursive: true })
      await writeFile(
        join(projectDirectory, "project.pbxproj"),
        `PRODUCT_BUNDLE_IDENTIFIER = com.example.app;\nTargetAttributes = {\n  SystemCapabilities = {\n    com.apple.InAppPurchase = {\n      enabled = 1;\n    };\n  };\n};\n`,
        "utf8",
      )
      await writeFile(
        join(root, "ios", "DemoApp", "Local.storekit"),
        JSON.stringify({
          products: [
            {
              productID: "com.example.pro.monthly",
            },
          ],
        }, null, 2),
        "utf8",
      )
      await writeFile(join(root, ".env.production"), "REVENUECAT_IOS_API_KEY=test_store_key_only\n", "utf8")
      await writeFile(
        join(configDirectory, "revenuecat-offerings.json"),
        JSON.stringify({
          offerings: {
            default: {
              packages: {
                "$rc_monthly": {
                  productId: "com.example.pro.yearly",
                  entitlement: "pro",
                },
              },
            },
          },
        }, null, 2),
        "utf8",
      )

      const baseLayer = Layer.mergeAll(
        Layer.succeed(ArtifactStore, buildArtifactStoreStub()),
        Layer.succeed(DaemonClient, buildDaemonClientStub()),
      )
      const runtime = ManagedRuntime.make(Layer.mergeAll(baseLayer, CommerceServiceLive.pipe(Layer.provide(baseLayer))))

      try {
        const service = await runtime.runPromise(Effect.gen(function* () {
          return yield* CommerceService
        }))
        const report = await runtime.runPromise(service.doctor({
          bundleId: "com.example.app",
          rootDir: root,
          mode: "local-storekit",
          provider: "revenuecat",
        }))

        expect(report.checks.find((check) => check.key === "workspace.revenuecat-sdk-key")?.verdict).toBe("blocked")
        expect(report.checks.find((check) => check.key === "storekit.revenuecat-product-consistency")?.verdict).toBe("blocked")
      } finally {
        await runtime.dispose()
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("validate runs executable local-storekit steps, stubs control steps, and writes a report artifact", async () => {
    const capture = { derivedOutputs: [] as Array<{ readonly sessionId: string; readonly label: string; readonly content: string }> }
    const baseLayer = Layer.mergeAll(
      Layer.succeed(ArtifactStore, buildArtifactStoreStub(capture)),
      Layer.succeed(DaemonClient, buildDaemonClientStub()),
    )
    const runtime = ManagedRuntime.make(Layer.mergeAll(baseLayer, CommerceServiceLive.pipe(Layer.provide(baseLayer))))

    try {
      const service = await runtime.runPromise(Effect.gen(function* () {
        return yield* CommerceService
      }))
      const plan = decodeCommerceValidationPlan({
        contract: "probe.commerce-plan/v1",
        productId: "com.example.pro.monthly",
        expectedEntitlement: "pro",
        steps: [
          {
            kind: "commerce.loadProducts",
            flow: {
              contract: "probe.session-flow/v1",
              steps: [
                {
                  kind: "sleep",
                  durationMs: 250,
                },
              ],
            },
          },
          {
            kind: "commerce.clearTransactions",
          },
        ],
      })

      const report = await runtime.runPromise(service.validate({
        sessionId: "session-1",
        mode: "local-storekit",
        provider: "revenuecat",
        plan,
      }))

      expect(report.verdict).toBe("configured")
      expect(report.executedSteps).toHaveLength(4)
      expect(report.executedSteps[0]?.verdict).toBe("verified")
      expect(report.executedSteps[0]?.boundary).toBe("apple-storekit")
      expect(report.executedSteps[1]?.stub).toBe(true)
      expect(report.executedSteps[1]?.boundary).toBe("apple-storekit")
      expect(report.executedSteps[2]?.kind).toBe("commerce.assertCancellationLeavesEntitlementInactive")
      expect(report.executedSteps[2]?.stub).toBe(true)
      expect(report.executedSteps[3]?.kind).toBe("commerce.assertSinglePurchaseInFlight")
      expect(report.executedSteps[3]?.stub).toBe(true)
      expect(report.reportArtifact?.label).toBe("commerce-report")
      expect(report.timingFacts.some((fact) => fact.includes("CustomerInfo"))).toBe(true)
      expect(report.warnings).toContain("Negative cases still need coverage: purchase cancellation must not unlock entitlement, and double-tap buy must keep only one purchase operation in flight.")
      expect(capture.derivedOutputs).toHaveLength(1)
      expect(capture.derivedOutputs[0]?.content).toContain("probe.commerce-validation/report-v1")
    } finally {
      await runtime.dispose()
    }
  })
})
