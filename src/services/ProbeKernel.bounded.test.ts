import { describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Layer, ManagedRuntime } from "effect"
import { countLines, shouldInlineOutput } from "../domain/output"
import { PROBE_PROTOCOL_VERSION } from "../rpc/protocol"
import { ArtifactStore } from "./ArtifactStore"
import { OutputPolicy } from "./OutputPolicy"
import { PerfService } from "./PerfService"
import { ProbeKernel, ProbeKernelLive } from "./ProbeKernel"
import { SessionRegistry } from "./SessionRegistry"
import { SimulatorHarness } from "./SimulatorHarness"

// PRB-094: the generic RPC-boundary inline budget every normal result must
// respect (OutputPolicy's default threshold, see domain/output.ts /
// services/OutputPolicy.ts). These tests measure the *actual* serialized
// response against it -- not an assertion about the code, a measurement of
// the wire bytes.
const maxInlineBytes = 4 * 1024
const maxInlineLines = 100

const sessionTarget = {
  platform: "simulator" as const,
  bundleId: "com.example.app",
  deviceId: "sim-1",
  deviceName: "iPhone 16",
  runtime: "iOS 18.0",
}

const baseHealthFields = (sessionId: string, artifacts: ReadonlyArray<unknown>, warnings: ReadonlyArray<string>) => ({
  sessionId,
  state: "ready" as const,
  openedAt: "2026-04-14T12:00:00.000Z",
  updatedAt: "2026-04-14T12:00:00.000Z",
  expiresAt: "2026-04-14T12:15:00.000Z",
  artifactRoot: "/tmp/probe/session",
  target: sessionTarget,
  connection: { status: "connected" as const, checkedAt: "2026-04-14T12:00:00.000Z", summary: "ok", details: [] },
  resources: { runner: "ready" as const, debugger: "not-requested" as const, logs: "ready" as const, trace: "not-requested" as const },
  capabilities: [],
  warnings,
  artifacts,
  transport: {
    kind: "simulator-runner" as const,
    contract: "probe.runner.transport/hybrid-v1" as const,
    bootstrapSource: "simulator-bootstrap-manifest" as const,
    bootstrapPath: "/tmp/bootstrap.json",
    sessionIdentifier: sessionId,
    commandIngress: "http-post" as const,
    eventEgress: "stdout-jsonl-mixed-log" as const,
    stdinProbeStatus: "ok",
    note: "ok",
  },
  runner: {
    kind: "simulator-runner" as const,
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
  healthCheck: { checkedAt: "2026-04-14T12:00:00.000Z", wrapperRunning: true, pingRttMs: 10, lastCommand: null, lastOk: true },
  debugger: {
    attachState: "not-attached" as const,
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
  coordination: { runnerActionsBlocked: false, runnerActionPolicy: "normal" as const, reason: null },
})

/** A real (temp-directory-backed) ArtifactStore stand-in: `writeDerivedOutput`
 * actually persists to disk and registers into an in-memory catalog so
 * `getArtifact`/`artifact.drill` can resolve it right back -- unlike
 * ProbeKernel.test.ts's simpler stubs, this one needs to survive an actual
 * atomic-persist-then-drill round trip. */
const buildRealArtifactStore = (root: string) => {
  const catalog = new Map<string, { readonly key: string; readonly label: string; readonly kind: "json"; readonly summary: string; readonly absolutePath: string; readonly relativePath: null; readonly external: false; readonly createdAt: string }>()

  return ArtifactStore.of({
    getRootDirectory: () => Effect.succeed(root),
    getArtifactRetentionMs: () => 60_000,
    getDaemonSocketPath: () => Effect.succeed(join(root, "probe.sock")),
    getDaemonMetadataPath: () => Effect.succeed(join(root, "daemon.json")),
    ensureDaemonDirectories: () => Effect.void,
    isDaemonRunning: () => Effect.succeed(false),
    readDaemonMetadata: () => Effect.succeed(null),
    createSessionLayout: () => Effect.die("unused createSessionLayout"),
    removeSessionLayout: () => Effect.void,
    readSessionManifest: () => Effect.succeed(null),
    listPersistedSessions: () => Effect.succeed({ sessions: [], failures: [] }),
    writeSessionManifest: () => Effect.void,
    registerArtifact: (_sessionId: string, record: any) => Effect.succeed(record),
    listArtifacts: () => Effect.succeed([...catalog.values()]),
    getArtifact: (_sessionId: string, artifactKey: string) =>
      Effect.gen(function* () {
        const found = catalog.get(artifactKey)

        if (!found) {
          return yield* Effect.die(`artifact ${artifactKey} not registered in test catalog`)
        }

        return found
      }),
    writeDerivedOutput: ({ sessionId, label, content, summary }: {
      readonly sessionId: string
      readonly label: string
      readonly format: "json" | "text"
      readonly content: string
      readonly summary: string
    }) =>
      Effect.tryPromise({
        try: async () => {
          const key = `derived-${label}`
          const absolutePath = join(root, `${key}.json`)
          await writeFile(absolutePath, content, "utf8")
          const record = {
            key,
            label,
            kind: "json" as const,
            summary,
            absolutePath,
            relativePath: null,
            external: false as const,
            createdAt: "2026-04-14T12:00:00.000Z",
          }
          catalog.set(key, record)
          return record
        },
        catch: (error) => new Error(`writeDerivedOutput failed: ${String(error)}`),
      }).pipe(Effect.orDie),
    writeDerivedFile: () => Effect.die("unused writeDerivedFile"),
    removeDaemonMetadata: () => Effect.void,
    writeDaemonMetadata: () => Effect.void,
    syncDaemonSessionMetadata: () => Effect.void,
    pruneExpiredSessions: () => Effect.void,
  } as any)
}

const buildKernel = (root: string, sessionRegistryOverrides: Record<string, unknown>) => {
  const baseLayer = Layer.mergeAll(
    Layer.succeed(ArtifactStore, buildRealArtifactStore(root)),
    Layer.succeed(
      OutputPolicy,
      OutputPolicy.of({
        getDefaultInlineThreshold: () => ({ maxInlineBytes, maxInlineLines }),
        shouldInline: (mode, content) => shouldInlineOutput(mode, { maxInlineBytes, maxInlineLines }, content),
        shouldInlineBinary: () => false,
      }),
    ),
    Layer.succeed(PerfService, PerfService.of({ record: () => Effect.die("unused perf.record") } as any)),
    Layer.succeed(SessionRegistry, SessionRegistry.of(sessionRegistryOverrides as any)),
    Layer.succeed(SimulatorHarness, SimulatorHarness.of({} as any)),
  )

  return ManagedRuntime.make(Layer.mergeAll(baseLayer, ProbeKernelLive.pipe(Layer.provide(baseLayer))))
}

describe("ProbeKernel bounded-collection RPC boundary (PRB-094)", () => {
  test("session.health stays within the generic 4 KiB / 100 line budget with 10k artifacts and 10k warnings", async () => {
    const root = await mkdtemp(join(tmpdir(), "probe-kernel-bounded-"))

    try {
      const sessionId = "session-1"
      const artifacts = Array.from({ length: 10_000 }, (_, index) => ({
        key: `artifact-${index}`,
        label: `artifact-${index}`,
        kind: "text" as const,
        summary: "a fixture artifact",
        absolutePath: `/tmp/probe/${sessionId}/artifact-${index}.txt`,
        relativePath: `artifact-${index}.txt`,
        external: false,
        createdAt: "2026-04-14T12:00:00.000Z",
      }))
      const warnings = Array.from({ length: 10_000 }, (_, index) => `warning number ${index} about something the session noticed`)
      const health = baseHealthFields(sessionId, artifacts, warnings)

      const runtime = buildKernel(root, {
        getSessionHealth: () => Effect.succeed(health),
      })

      try {
        const kernel = await runtime.runPromise(Effect.gen(function* () {
          return yield* ProbeKernel
        }))
        const response: any = await runtime.runPromise(kernel.handleRpcRequest({
          kind: "request",
          protocolVersion: PROBE_PROTOCOL_VERSION,
          requestId: "req-1",
          method: "session.health",
          params: { sessionId },
        }, () => {}))

        // Measured the same way `shouldInlineOutput`/`countLines`
        // (domain/output.ts) measure any other budget-gated content: the
        // wire (compact) JSON string, not a pretty-printed rendering --
        // the RPC transport never emits indented JSON, so that is what
        // actually costs bytes/lines on the wire and in an agent's context.
        const serialized = JSON.stringify(response)
        const bytes = Buffer.byteLength(serialized, "utf8")
        const lines = countLines(serialized)

        // AC1: every normal result JSON stays within budget, even with
        // 10k artifacts and 10k warnings behind it.
        expect(bytes).toBeLessThanOrEqual(maxInlineBytes)
        expect(lines).toBeLessThanOrEqual(maxInlineLines)

        // AC3: total/shown/omitted/drill on both bounded collections.
        expect(response.result.artifacts.total).toBe(10_000)
        expect(response.result.artifacts.shown.length).toBeLessThan(10_000)
        expect(response.result.artifacts.omitted).toBe(10_000 - response.result.artifacts.shown.length)
        expect(response.result.artifacts.drill).not.toBeNull()

        expect(response.result.warnings.total).toBe(10_000)
        expect(response.result.warnings.omitted).toBe(10_000 - response.result.warnings.shown.length)
        expect(response.result.warnings.drill).not.toBeNull()

        // AC5: the handle carries session/artifact key/typed query/contract
        // version, and AC10: the same query is deterministic across reads.
        const handle = response.result.artifacts.drill
        expect(handle.sessionId).toBe(sessionId)
        expect(handle.contractVersion).toBe(1)
        expect(handle.query.kind).toBe("collection")

        const drillOnce: any = await runtime.runPromise(kernel.handleRpcRequest({
          kind: "request",
          protocolVersion: PROBE_PROTOCOL_VERSION,
          requestId: "req-2",
          method: "artifact.drill",
          params: {
            sessionId,
            artifactKey: handle.artifactKey,
            outputMode: "inline",
            query: handle.query,
          },
        }, () => {}))
        const drillAgain: any = await runtime.runPromise(kernel.handleRpcRequest({
          kind: "request",
          protocolVersion: PROBE_PROTOCOL_VERSION,
          requestId: "req-3",
          method: "artifact.drill",
          params: {
            sessionId,
            artifactKey: handle.artifactKey,
            outputMode: "inline",
            query: handle.query,
          },
        }, () => {}))

        expect(drillOnce.result).toEqual(drillAgain.result)
        expect(drillOnce.result.kind).toBe("inline")

        if (drillOnce.result.kind === "inline") {
          const page = JSON.parse(drillOnce.result.content) as Array<{ readonly key: string }>
          expect(page.length).toBe(handle.query.limit)
          expect(page[0]?.key).toBe("artifact-0")
        }
      } finally {
        await runtime.dispose()
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("session.run stays within the generic 4 KiB / 100 line budget with a 10k-step flow", async () => {
    const root = await mkdtemp(join(tmpdir(), "probe-kernel-bounded-"))

    try {
      const sessionId = "session-1"
      const executedSteps = Array.from({ length: 10_000 }, (_, index) => ({
        index: index + 1,
        kind: "tap" as const,
        summary: `Executed fast tap step ${index}.`,
        verdict: "passed" as const,
        matchedRef: null,
        latestSnapshotId: null,
        retryCount: 0,
        retryReasons: [],
        artifacts: [],
        executionProfile: "fast" as const,
        transportLane: "runner-single" as const,
        handledMs: 1,
        warnings: [],
        evidence: { requested: { success: "none" as const, failure: "snapshot" as const }, captures: [], evidenceMs: 0 },
        sequenceChildFailure: null,
      }))
      const flowResult = {
        contract: "probe.session-flow/report-v2" as const,
        executedAt: "2026-04-14T12:00:00.000Z",
        sessionId,
        summary: "Executed 10000 flow steps successfully.",
        verdict: "passed" as const,
        executedSteps,
        failedStep: null,
        retries: 0,
        artifacts: [],
        finalSnapshotId: null,
        warnings: [],
      }

      const runtime = buildKernel(root, {
        runFlow: () => Effect.succeed(flowResult),
      })

      try {
        const kernel = await runtime.runPromise(Effect.gen(function* () {
          return yield* ProbeKernel
        }))
        const response: any = await runtime.runPromise(kernel.handleRpcRequest({
          kind: "request",
          protocolVersion: PROBE_PROTOCOL_VERSION,
          requestId: "req-1",
          method: "session.run",
          params: {
            sessionId,
            flow: { contract: "probe.session-flow/v2", steps: [] },
          },
        }, () => {}))

        const serialized = JSON.stringify(response)
        const bytes = Buffer.byteLength(serialized, "utf8")
        const lines = countLines(serialized)

        expect(bytes).toBeLessThanOrEqual(maxInlineBytes)
        expect(lines).toBeLessThanOrEqual(maxInlineLines)

        expect(response.result.executedSteps.total).toBe(10_000)
        expect(response.result.executedSteps.omitted).toBe(10_000 - response.result.executedSteps.shown.length)
        expect(response.result.executedSteps.drill).not.toBeNull()

        const handle = response.result.executedSteps.drill
        const drilled: any = await runtime.runPromise(kernel.handleRpcRequest({
          kind: "request",
          protocolVersion: PROBE_PROTOCOL_VERSION,
          requestId: "req-2",
          method: "artifact.drill",
          params: {
            sessionId,
            artifactKey: handle.artifactKey,
            outputMode: "inline",
            query: { kind: "collection", offset: 9_999, limit: 10 },
          },
        }, () => {}))

        expect(drilled.result.kind).toBe("inline")

        if (drilled.result.kind === "inline") {
          const page = JSON.parse(drilled.result.content) as Array<{ readonly index: number }>
          expect(page).toHaveLength(1)
          expect(page[0]?.index).toBe(10_000)
        }
      } finally {
        await runtime.dispose()
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
