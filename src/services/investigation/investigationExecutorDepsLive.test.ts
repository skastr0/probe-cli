import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Context, Effect, ManagedRuntime } from "effect"
import { EnvironmentError } from "../../domain/errors"
import { decodeInvestigationRecipe, planInvestigation } from "../../domain/investigation"
import { DaemonClient } from "../DaemonClient"
import { InvestigationStore, InvestigationStoreLive } from "../InvestigationStore"
import { makeInvestigationExecutorDepsLive } from "./investigationExecutorDepsLive"

// PRB-099 review fixes:
//   - AC#10: "Reference custom-template run performs zero eager schema
//     exports." (captureRepetition's channel-export gate)
//   - AC#3 (first clause): "At most one recorder exists per session."
//     (reserveRecorder's cross-investigation conflict check)
// Neither had any coverage before this file -- every InvestigationController
// test injects a fake `reserveRecorder`/`captureRepetition`, so the *real*
// production logic in this module was never exercised. These tests drive
// `makeInvestigationExecutorDepsLive` directly against a fake `DaemonClient`
// (no daemon, no simulator, no device) plus a real `InvestigationStoreLive`
// pointed at a scratch `PROBE_ARTIFACT_ROOT` (reserveRecorder reads
// persisted investigation state via `listInvestigationIds`, so a fake store
// alone cannot exercise it -- the same reason `InvestigationController.test.ts`'s
// crash/resume test reads real on-disk state).

type DaemonClientService = Context.Tag.Service<typeof DaemonClient>
type InvestigationStoreService = Context.Tag.Service<typeof InvestigationStore>

const neverReachedDaemonClient: DaemonClientService = DaemonClient.of({
  ping: () => Effect.die("unexpected daemon client call"),
  listSessions: () => Effect.die("unexpected daemon client call"),
  openSession: () => Effect.die("unexpected daemon client call"),
  showSession: () => Effect.die("unexpected daemon client call"),
  getSessionHealth: () => Effect.die("unexpected daemon client call"),
  closeSession: () => Effect.die("unexpected daemon client call"),
  getSessionLogs: () => Effect.die("unexpected daemon client call"),
  markSessionLog: () => Effect.die("unexpected daemon client call"),
  captureLogWindow: () => Effect.die("unexpected daemon client call"),
  getLogDoctorReport: () => Effect.die("unexpected daemon client call"),
  captureDiagnosticBundle: () => Effect.die("unexpected daemon client call"),
  runSessionDebugCommand: () => Effect.die("unexpected daemon client call"),
  captureScreenshot: () => Effect.die("unexpected daemon client call"),
  recordVideo: () => Effect.die("unexpected daemon client call"),
  captureSnapshot: () => Effect.die("unexpected daemon client call"),
  performSessionAction: () => Effect.die("unexpected daemon client call"),
  runSessionFlow: () => Effect.die("unexpected daemon client call"),
  exportSessionRecording: () => Effect.die("unexpected daemon client call"),
  replaySessionRecording: () => Effect.die("unexpected daemon client call"),
  getSessionResultSummary: () => Effect.die("unexpected daemon client call"),
  getSessionResultAttachments: () => Effect.die("unexpected daemon client call"),
  recordPerf: () => Effect.die("unexpected daemon client call"),
  recordPerfAroundFlow: () => Effect.die("unexpected daemon client call"),
  summarizePerfBySignpost: () => Effect.die("unexpected daemon client call"),
  exportPerfSchema: () => Effect.die("unexpected daemon client call"),
  analyzePerfTrace: () => Effect.die("unexpected daemon client call"),
  drillArtifact: () => Effect.die("unexpected daemon client call"),
})

const neverReachedInvestigationStore: InvestigationStoreService = InvestigationStore.of({
  create: () => Effect.die("unexpected investigation store call"),
  read: () => Effect.die("unexpected investigation store call"),
  update: () => Effect.die("unexpected investigation store call"),
  appendEvent: () => Effect.die("unexpected investigation store call"),
  readEvents: () => Effect.die("unexpected investigation store call"),
  requestCancel: () => Effect.die("unexpected investigation store call"),
})

const artifactRecordFixture = (key: string) => ({
  key,
  label: key,
  kind: "xml" as const,
  summary: `test artifact ${key}`,
  absolutePath: `/tmp/${key}`,
  relativePath: null,
  external: false,
  createdAt: "2026-01-01T00:00:00.000Z",
})

const sessionHealthFixture = () => ({
  target: {
    platform: "simulator" as const,
    bundleId: "dev.probe.fixture",
    deviceId: "sim-1",
    deviceName: "iPhone 15",
    runtime: "iOS 18.0",
  },
}) as any

const tapStep = { kind: "tap" as const, target: { kind: "point" as const, x: 1, y: 2 } }
const measuredFlow = { contract: "probe.session-flow/v2" as const, steps: [tapStep] }

describe("makeInvestigationExecutorDepsLive -- captureRepetition eager export gate (AC#10 review fix)", () => {
  test("a custom-template capture performs zero eager perfChannelSchemas exports", async () => {
    let exportCalls = 0

    const daemonClient: DaemonClientService = {
      ...neverReachedDaemonClient,
      getSessionHealth: () => Effect.succeed(sessionHealthFixture()),
      recordPerf: () =>
        Effect.succeed({
          sessionId: "session-1",
          template: "custom",
          templateName: "my-template",
          customTemplatePath: "/tmp/my.tracetemplate",
          timeLimit: "30s",
          recordedAt: "2026-01-01T00:00:00.000Z",
          xctraceVersion: "16.0",
          session: { state: "ready", healthCheck: {} },
          summary: { headline: "Custom template recording completed.", metrics: [] },
          diagnoses: [],
          schemas: [],
          artifacts: { trace: artifactRecordFixture("trace-custom"), toc: artifactRecordFixture("toc-custom") },
        }) as any,
      runSessionFlow: () => Effect.succeed({ verdict: "passed", summary: "ok" }) as any,
      exportPerfSchema: () => {
        exportCalls += 1
        return Effect.fail(new EnvironmentError({
          code: "test-export-unavailable",
          reason: "test fixture never exports",
          nextStep: "n/a",
          details: [],
        }))
      },
    }

    const deps = makeInvestigationExecutorDepsLive(daemonClient, neverReachedInvestigationStore)

    const result = await Effect.runPromise(deps.captureRepetition({
      sessionId: "session-1",
      investigationId: "inv-1",
      repetitionIndex: 0,
      capture: { kind: "custom", customTemplatePath: "/tmp/my.tracetemplate" },
      measuredFlow,
      recipeHash: "hash-1",
    }))

    expect(exportCalls).toBe(0)
    expect(result.traceArtifactKey).toBe("trace-custom")
    // No table was ever exported, so every one of PRB-098's six known
    // channels reports "unavailable" -- the honest `buildEvidenceReport`
    // fallback, never a fabricated reading.
    expect(result.evidenceReport.channels.every((channel) => channel.status === "unavailable")).toBe(true)
  })

  test("a preset-template capture still performs all six known-channel exports", async () => {
    let exportCalls = 0

    const daemonClient: DaemonClientService = {
      ...neverReachedDaemonClient,
      getSessionHealth: () => Effect.succeed(sessionHealthFixture()),
      recordPerfAroundFlow: () =>
        Effect.succeed({
          sessionId: "session-1",
          template: "time-profiler",
          templateName: "Time Profiler",
          recordedAt: "2026-01-01T00:00:00.000Z",
          xctraceVersion: "16.0",
          session: { state: "ready", healthCheck: {} },
          flow: { verdict: "passed", summary: "ok" },
          diagnoses: [],
          artifacts: { trace: artifactRecordFixture("trace-preset"), toc: artifactRecordFixture("toc-preset") },
        }) as any,
      exportPerfSchema: () => {
        exportCalls += 1
        return Effect.fail(new EnvironmentError({
          code: "test-export-unavailable",
          reason: "test fixture never exports",
          nextStep: "n/a",
          details: [],
        }))
      },
    }

    const deps = makeInvestigationExecutorDepsLive(daemonClient, neverReachedInvestigationStore)

    const result = await Effect.runPromise(deps.captureRepetition({
      sessionId: "session-1",
      investigationId: "inv-1",
      repetitionIndex: 0,
      capture: { kind: "preset", template: "time-profiler" },
      measuredFlow,
      recipeHash: "hash-1",
    }))

    expect(exportCalls).toBe(6)
    expect(result.traceArtifactKey).toBe("trace-preset")
  })
})

describe("makeInvestigationExecutorDepsLive -- reserveRecorder at most one recorder per session (AC#3 review fix)", () => {
  const baseRecipeInput = (sessionId: string) => ({
    target: { sessionId },
    measuredFlow,
    capture: { kind: "preset" as const, template: "time-profiler" as const },
    repetitions: 3,
    cooldown: { minIntervalMs: 0 },
  })

  const withRealStore = async <T>(
    run: (context: { readonly store: InvestigationStoreService }) => Promise<T>,
  ): Promise<T> => {
    const root = await mkdtemp(join(tmpdir(), "probe-investigation-executor-deps-test-"))
    const previous = process.env.PROBE_ARTIFACT_ROOT
    process.env.PROBE_ARTIFACT_ROOT = root
    const runtime = ManagedRuntime.make(InvestigationStoreLive)

    try {
      const store = await runtime.runPromise(InvestigationStore)
      return await run({ store })
    } finally {
      await runtime.dispose()

      if (previous === undefined) {
        delete process.env.PROBE_ARTIFACT_ROOT
      } else {
        process.env.PROBE_ARTIFACT_ROOT = previous
      }

      await rm(root, { recursive: true, force: true })
    }
  }

  const createInvestigationAt = (
    store: InvestigationStoreService,
    args: { readonly investigationId: string; readonly sessionId: string; readonly status: "running" | "completed"; readonly currentStageIndex: number },
  ) =>
    Effect.gen(function* () {
      const recipe = decodeInvestigationRecipe(baseRecipeInput(args.sessionId))
      const plan = planInvestigation(recipe)
      yield* store.create({
        investigationId: args.investigationId,
        sessionId: args.sessionId,
        recipe,
        recipeHash: plan.recipeHash,
        plan,
        createdAt: "2026-01-01T00:00:00.000Z",
      })
      yield* store.update(args.investigationId, (current) => ({
        ...current,
        status: args.status,
        currentStageIndex: args.currentStageIndex,
      }))
    })

  test("conflicts once another running investigation in the same session has passed preflight", async () => {
    await withRealStore(async ({ store }) => {
      await Effect.runPromise(createInvestigationAt(store, {
        investigationId: "other-past-preflight",
        sessionId: "session-shared-a",
        status: "running",
        currentStageIndex: 0, // "preflight" (index 0) already completed
      }))

      const deps = makeInvestigationExecutorDepsLive(neverReachedDaemonClient, store)
      const outcome = await Effect.runPromise(Effect.either(deps.reserveRecorder({
        sessionId: "session-shared-a",
        investigationId: "new-investigation",
      })))

      expect(outcome._tag).toBe("Left")
      if (outcome._tag === "Left") {
        expect(outcome.left._tag).toBe("SessionConflictError")
      }
    })
  })

  test("does not conflict while the other running investigation has not yet completed preflight", async () => {
    await withRealStore(async ({ store }) => {
      await Effect.runPromise(createInvestigationAt(store, {
        investigationId: "other-still-preflight",
        sessionId: "session-shared-b",
        status: "running",
        currentStageIndex: -1, // no stage completed yet
      }))

      const deps = makeInvestigationExecutorDepsLive(neverReachedDaemonClient, store)
      const outcome = await Effect.runPromise(Effect.either(deps.reserveRecorder({
        sessionId: "session-shared-b",
        investigationId: "new-investigation",
      })))

      expect(outcome._tag).toBe("Right")
    })
  })

  test("does not conflict across different sessions", async () => {
    await withRealStore(async ({ store }) => {
      await Effect.runPromise(createInvestigationAt(store, {
        investigationId: "other-different-session",
        sessionId: "session-a",
        status: "running",
        currentStageIndex: 2,
      }))

      const deps = makeInvestigationExecutorDepsLive(neverReachedDaemonClient, store)
      const outcome = await Effect.runPromise(Effect.either(deps.reserveRecorder({
        sessionId: "session-b",
        investigationId: "new-investigation",
      })))

      expect(outcome._tag).toBe("Right")
    })
  })

  test("does not conflict with a terminal (non-running) investigation in the same session", async () => {
    await withRealStore(async ({ store }) => {
      await Effect.runPromise(createInvestigationAt(store, {
        investigationId: "other-terminal",
        sessionId: "session-shared-c",
        status: "completed",
        currentStageIndex: 3,
      }))

      const deps = makeInvestigationExecutorDepsLive(neverReachedDaemonClient, store)
      const outcome = await Effect.runPromise(Effect.either(deps.reserveRecorder({
        sessionId: "session-shared-c",
        investigationId: "new-investigation",
      })))

      expect(outcome._tag).toBe("Right")
    })
  })

  test("never conflicts with itself", async () => {
    await withRealStore(async ({ store }) => {
      await Effect.runPromise(createInvestigationAt(store, {
        investigationId: "self-investigation",
        sessionId: "session-shared-d",
        status: "running",
        currentStageIndex: 1,
      }))

      const deps = makeInvestigationExecutorDepsLive(neverReachedDaemonClient, store)
      const outcome = await Effect.runPromise(Effect.either(deps.reserveRecorder({
        sessionId: "session-shared-d",
        investigationId: "self-investigation",
      })))

      expect(outcome._tag).toBe("Right")
    })
  })
})
