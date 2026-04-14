import { describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Layer, ManagedRuntime } from "effect"
import { buildSessionSnapshotResult, buildSnapshotArtifact, type RunnerSnapshotNode } from "../domain/snapshot"
import { ArtifactStore } from "./ArtifactStore"
import { AccessibilityService, AccessibilityServiceLive } from "./AccessibilityService"
import { DaemonClient } from "./DaemonClient"

const node = (overrides: Partial<RunnerSnapshotNode> = {}): RunnerSnapshotNode => ({
  type: "other",
  identifier: null,
  label: null,
  value: null,
  placeholder: null,
  frame: null,
  state: null,
  interactive: false,
  children: [],
  ...overrides,
})

const rawSnapshot = (root: RunnerSnapshotNode) => ({
  capturedAt: "2026-04-14T12:00:00.000Z",
  statusLabel: "Accessibility screen ready",
  metrics: {
    rawNodeCount: 4,
    prunedNodeCount: 4,
    interactiveNodeCount: 3,
  },
  root,
})

const buildSessionHealthStub = () => ({
  sessionId: "session-1",
  state: "ready",
  openedAt: "2026-04-14T12:00:00.000Z",
  updatedAt: "2026-04-14T12:00:00.000Z",
  expiresAt: "2026-04-14T12:15:00.000Z",
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
    checkedAt: "2026-04-14T12:00:00.000Z",
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
    checkedAt: "2026-04-14T12:00:00.000Z",
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
} as any)

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
        createdAt: "2026-04-14T12:00:00.000Z",
      })
    },
    writeDerivedFile: () => Effect.die("unused writeDerivedFile"),
    removeDaemonMetadata: () => Effect.void,
    writeDaemonMetadata: () => Effect.void,
    syncDaemonSessionMetadata: () => Effect.void,
    pruneExpiredSessions: () => Effect.void,
  } as any)

const buildDaemonClientStub = (args: {
  readonly snapshotResult: ReturnType<typeof buildSessionSnapshotResult>
  readonly screenshotArtifactPath: string
}) =>
  DaemonClient.of({
    ping: () => Effect.die("unused ping"),
    listSessions: () => Effect.die("unused listSessions"),
    openSession: () => Effect.die("unused openSession"),
    showSession: () => Effect.die("unused showSession"),
    getSessionHealth: () => Effect.succeed(buildSessionHealthStub()),
    closeSession: () => Effect.die("unused closeSession"),
    getSessionLogs: () => Effect.die("unused getSessionLogs"),
    markSessionLog: () => Effect.die("unused markSessionLog"),
    captureLogWindow: () => Effect.die("unused captureLogWindow"),
    getLogDoctorReport: () => Effect.die("unused getLogDoctorReport"),
    runSessionDebugCommand: () => Effect.die("unused runSessionDebugCommand"),
    captureScreenshot: () => Effect.succeed({
      kind: "summary+artifact" as const,
      summary: "Captured accessibility screenshot.",
      artifact: {
        key: "screenshot-a11y",
        label: "accessibility-screenshot",
        kind: "png" as const,
        summary: "accessibility screenshot",
        absolutePath: args.screenshotArtifactPath,
        relativePath: "screenshots/accessibility.png",
        external: false,
        createdAt: "2026-04-14T12:00:00.000Z",
      },
      retryCount: 0,
      retryReasons: [],
    }),
    recordVideo: () => Effect.die("unused recordVideo"),
    captureSnapshot: () => Effect.succeed(args.snapshotResult),
    performSessionAction: () => Effect.die("unused performSessionAction"),
    runSessionFlow: () => Effect.die("unused runSessionFlow"),
    exportSessionRecording: () => Effect.die("unused exportSessionRecording"),
    replaySessionRecording: () => Effect.die("unused replaySessionRecording"),
    getSessionResultSummary: () => Effect.die("unused getSessionResultSummary"),
    getSessionResultAttachments: () => Effect.die("unused getSessionResultAttachments"),
    recordPerf: () => Effect.die("unused recordPerf"),
    drillArtifact: () => Effect.die("unused drillArtifact"),
    recordPerfAroundFlow: () => Effect.die("unused recordPerfAroundFlow"),
    summarizePerfBySignpost: () => Effect.die("unused summarizePerfBySignpost"),
    captureDiagnosticBundle: () => Effect.die("unused captureDiagnosticBundle"),
  })

describe("AccessibilityService", () => {
  test("validate analyzes the current screen and writes a durable report artifact", async () => {
    const root = await mkdtemp(join(tmpdir(), "probe-accessibility-validate-"))
    const capture = { derivedOutputs: [] as Array<{ readonly sessionId: string; readonly label: string; readonly content: string }> }

    try {
      const built = buildSnapshotArtifact({
        previous: null,
        nextSnapshotIndex: 1,
        nextElementRefIndex: 1,
        raw: rawSnapshot(
          node({
            type: "application",
            frame: { x: 0, y: 0, width: 390, height: 844 },
            children: [
              node({
                type: "button",
                interactive: true,
                frame: { x: 20, y: 40, width: 120, height: 44 },
              }),
              node({
                type: "other",
                identifier: "settings.row",
                label: "Open Settings",
                interactive: true,
                frame: { x: 20, y: 110, width: 180, height: 44 },
              }),
              node({
                type: "button",
                identifier: "continue.cta",
                label: "Continue",
                interactive: true,
                frame: null,
              }),
            ],
          }),
        ),
      })
      const snapshotPath = join(root, "snapshot.json")
      const screenshotPath = join(root, "screenshot.png")
      await writeFile(snapshotPath, `${JSON.stringify(built.artifact, null, 2)}\n`, "utf8")
      await writeFile(screenshotPath, "png", "utf8")

      const snapshotArtifactRecord = {
        key: "snapshot-s1",
        label: "snapshot-@s1",
        kind: "json" as const,
        summary: "snapshot artifact",
        absolutePath: snapshotPath,
        relativePath: "snapshots/snapshot.json",
        external: false,
        createdAt: "2026-04-14T12:00:00.000Z",
      }
      const snapshotResult = buildSessionSnapshotResult({
        artifact: built.artifact,
        artifactRecord: snapshotArtifactRecord,
        outputMode: "artifact",
      })

      const baseLayer = Layer.mergeAll(
        Layer.succeed(ArtifactStore, buildArtifactStoreStub(capture)),
        Layer.succeed(DaemonClient, buildDaemonClientStub({ snapshotResult, screenshotArtifactPath: screenshotPath })),
      )
      const runtime = ManagedRuntime.make(Layer.mergeAll(baseLayer, AccessibilityServiceLive.pipe(Layer.provide(baseLayer))))

      try {
        const service = await runtime.runPromise(Effect.gen(function* () {
          return yield* AccessibilityService
        }))
        const report = await runtime.runPromise(service.validate({ sessionId: "session-1" }))

        expect(report.scope).toBe("current-screen")
        expect(report.verdict).toBe("blocked")
        expect(report.issueCount).toBe(4)
        expect(report.issues.map((issue) => issue.category)).toContain("missing-label")
        expect(report.issues.map((issue) => issue.category)).toContain("missing-identifier")
        expect(report.issues.map((issue) => issue.category)).toContain("missing-traits")
        expect(report.issues.map((issue) => issue.category)).toContain("not-hittable")
        expect(report.evidence.snapshotArtifact.absolutePath).toBe(snapshotPath)
        expect(report.evidence.screenshotArtifact.absolutePath).toBe(screenshotPath)
        expect(report.evidence.reportArtifact?.label).toBe("accessibility-report")
        expect(capture.derivedOutputs).toHaveLength(1)
        expect(capture.derivedOutputs[0]?.content).toContain("probe.accessibility-validation/report-v1")
      } finally {
        await runtime.dispose()
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("doctor reports accessibility readiness checks for a live session", async () => {
    const root = await mkdtemp(join(tmpdir(), "probe-accessibility-doctor-"))

    try {
      const built = buildSnapshotArtifact({
        previous: null,
        nextSnapshotIndex: 1,
        nextElementRefIndex: 1,
        raw: rawSnapshot(
          node({
            type: "application",
            frame: { x: 0, y: 0, width: 390, height: 844 },
            children: [
              node({
                type: "button",
                identifier: "primary.cta",
                label: "Continue",
                interactive: true,
                frame: { x: 20, y: 40, width: 120, height: 44 },
              }),
              node({
                type: "button",
                label: "Secondary",
                interactive: true,
                frame: { x: 20, y: 96, width: 120, height: 44 },
              }),
            ],
          }),
        ),
      })
      const snapshotPath = join(root, "snapshot.json")
      const screenshotPath = join(root, "screenshot.png")
      await writeFile(snapshotPath, `${JSON.stringify(built.artifact, null, 2)}\n`, "utf8")
      await writeFile(screenshotPath, "png", "utf8")

      const snapshotArtifactRecord = {
        key: "snapshot-s1",
        label: "snapshot-@s1",
        kind: "json" as const,
        summary: "snapshot artifact",
        absolutePath: snapshotPath,
        relativePath: "snapshots/snapshot.json",
        external: false,
        createdAt: "2026-04-14T12:00:00.000Z",
      }
      const snapshotResult = buildSessionSnapshotResult({
        artifact: built.artifact,
        artifactRecord: snapshotArtifactRecord,
        outputMode: "artifact",
      })

      const baseLayer = Layer.mergeAll(
        Layer.succeed(ArtifactStore, buildArtifactStoreStub()),
        Layer.succeed(DaemonClient, buildDaemonClientStub({ snapshotResult, screenshotArtifactPath: screenshotPath })),
      )
      const runtime = ManagedRuntime.make(Layer.mergeAll(baseLayer, AccessibilityServiceLive.pipe(Layer.provide(baseLayer))))

      try {
        const service = await runtime.runPromise(Effect.gen(function* () {
          return yield* AccessibilityService
        }))
        const report = await runtime.runPromise(service.doctor({ sessionId: "session-1" }))

        expect(report.verdict).toBe("configured")
        expect(report.snapshotArtifact?.absolutePath).toBe(snapshotPath)
        expect(report.screenshotArtifact?.absolutePath).toBe(screenshotPath)
        expect(report.checks.find((check) => check.key === "session.live-runner")?.verdict).toBe("verified")
        expect(report.checks.find((check) => check.key === "session.snapshot-capture")?.verdict).toBe("verified")
        expect(report.checks.find((check) => check.key === "session.screenshot-capture")?.verdict).toBe("verified")
        expect(report.checks.find((check) => check.key === "snapshot.identity-stability")?.verdict).toBe("configured")
      } finally {
        await runtime.dispose()
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
