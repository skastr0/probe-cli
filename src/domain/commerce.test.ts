import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import {
  CommerceDoctorReportSchema,
  CommerceValidationReportSchema,
  buildCommerceDoctorReport,
  buildCommerceEnvironmentReport,
  buildCommerceValidationReport,
  decodeCommerceValidationPlan,
  validateCommerceValidationPlan,
} from "./commerce"
import type { SessionHealth } from "./session"

const baseSession = (overrides?: Partial<SessionHealth>): SessionHealth => ({
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
    pingRttMs: 15,
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
  ...overrides,
})

describe("commerce domain", () => {
  test("decodes embedded flow arrays into a session flow contract", () => {
    const plan = decodeCommerceValidationPlan({
      contract: "probe.commerce-plan/v1",
      steps: [
        {
          kind: "commerce.loadProducts",
          flow: [
            {
              kind: "sleep",
              durationMs: 250,
            },
          ],
        },
      ],
    })

    expect(plan.steps[0]?.kind).toBe("commerce.loadProducts")

    if (plan.steps[0]?.kind !== "commerce.loadProducts") {
      throw new Error("Expected commerce.loadProducts step")
    }

    expect(plan.steps[0].flow.contract).toBe("probe.session-flow/v1")
    expect(plan.steps[0].flow.steps[0]?.kind).toBe("sleep")
  })

  test("rejects invalid commerce steps", () => {
    const plan = decodeCommerceValidationPlan({
      contract: "probe.commerce-plan/v1",
      steps: [
        {
          kind: "commerce.assertEntitlement",
          entitlement: "",
          state: "active",
          flow: {
            contract: "probe.session-flow/v1",
            steps: [
              {
                kind: "sleep",
                durationMs: 100,
              },
            ],
          },
        },
      ],
    })

    expect(validateCommerceValidationPlan(plan)).toBe(
      "Step 1: commerce.assertEntitlement requires a non-empty entitlement.",
    )
  })

  test("reports local StoreKit as non-authoritative", () => {
    const report = buildCommerceEnvironmentReport({
      mode: "local-storekit",
      session: baseSession(),
    })

    expect(report.authority).toBe("local-storekit-simulated")
    expect(report.authoritative).toBe(false)
    expect(report.warnings[0]).toContain("Local StoreKit")
  })

  test("reports sandbox real-device sessions as authoritative", () => {
    const report = buildCommerceEnvironmentReport({
      mode: "sandbox",
      session: baseSession({
        target: {
          platform: "device",
          bundleId: "com.example.app",
          deviceId: "device-1",
          deviceName: "iPhone",
          runtime: "18.0",
        },
        runner: {
          kind: "real-device-live",
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
          connectionStatus: "connected",
          lastCheckedAt: "2026-04-14T00:00:00.000Z",
          note: "ok",
        },
      }),
    })

    expect(report.authority).toBe("sandbox-authoritative")
    expect(report.authoritative).toBe(true)
    expect(report.warnings[0]).toContain("compressed")
  })

  test("doctor report schema includes verification metadata and timing facts", () => {
    const report = buildCommerceDoctorReport({
      workspaceRoot: "/tmp/app",
      bundleId: "com.example.app",
      mode: "sandbox",
      provider: "revenuecat",
      checks: [
        {
          key: "workspace.revenuecat-sdk-key",
          source: "workspace",
          boundary: "app-binary",
          verification: "structurally-verified",
          verdict: "configured",
          stub: false,
          summary: "Local RevenueCat key found.",
          details: [],
        },
      ],
    })

    const decoded = Schema.decodeUnknownSync(CommerceDoctorReportSchema)(report)

    expect(decoded.checks[0]?.verification).toBe("structurally-verified")
    expect(decoded.timingFacts.some((fact) => fact.includes("12 times"))).toBe(true)
    expect(decoded.timingFacts.some((fact) => fact.includes("CustomerInfo"))).toBe(true)
  })

  test("validation report schema preserves step boundaries and provider timing facts", () => {
    const environment = buildCommerceEnvironmentReport({
      mode: "testflight",
      session: baseSession({
        target: {
          platform: "device",
          bundleId: "com.example.app",
          deviceId: "device-1",
          deviceName: "iPhone",
          runtime: "18.0",
        },
      }),
    })

    const report = buildCommerceValidationReport({
      sessionId: "session-1",
      mode: "testflight",
      provider: "revenuecat",
      plan: null,
      environment,
      executedSteps: [
        {
          index: 1,
          kind: "commerce.assertOfferingsLoaded",
          boundary: "revenuecat-catalog",
          verdict: "verified",
          stub: false,
          summary: "Offerings loaded.",
          details: [],
          warnings: [],
          flowResult: null,
        },
      ],
      reportArtifact: null,
    })

    const decoded = Schema.decodeUnknownSync(CommerceValidationReportSchema)(report)

    expect(decoded.executedSteps[0]?.boundary).toBe("revenuecat-catalog")
    expect(decoded.timingFacts.some((fact) => fact.includes("6 renewals"))).toBe(true)
    expect(decoded.timingFacts.some((fact) => fact.includes("CustomerInfo"))).toBe(true)
  })
})
