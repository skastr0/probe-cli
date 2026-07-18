import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Context, Effect, Layer, ManagedRuntime } from "effect"
import type { PerfEvidenceReport } from "../domain/perf-evidence"
import { ArtifactStoreLive } from "./ArtifactStore"
import { InvestigationController, InvestigationControllerLayer } from "./InvestigationController"
import { InvestigationStore, InvestigationStoreLive } from "./InvestigationStore"
import type { InvestigationExecutorDeps } from "./investigation/investigationExecutorDeps"
import { makeUnusedInvestigationExecutorDeps } from "./investigation/investigationExecutorTestSupport"

// PRB-099 contract tests: "Run state, events, artifacts, cancellation, and
// read/resume semantics are contract-tested" (AC). Every test here uses a
// fake `InvestigationExecutorDeps` -- no daemon, no simulator, no device --
// exactly the "recorded/fake capture lanes" the glyph notes call for.
// `InvestigationStoreLive` resolves its root from `PROBE_ARTIFACT_ROOT`
// (same convention as `ArtifactStore.test.ts`), so every test runs against
// an isolated tmp directory and never touches the real `~/.probe`.

type InvestigationControllerService = Context.Tag.Service<typeof InvestigationController>
type InvestigationStoreService = Context.Tag.Service<typeof InvestigationStore>

const tapStep = { kind: "tap" as const, target: { kind: "point" as const, x: 1, y: 2 } }
const measuredFlow = { contract: "probe.session-flow/v2" as const, steps: [tapStep] }

const baseRecipe = {
  target: { sessionId: "session-1" },
  measuredFlow,
  capture: { kind: "preset" as const, template: "time-profiler" as const },
  repetitions: 3,
  cooldown: { minIntervalMs: 0 },
}

const makeFakeReport = (repetitionIndex: number, sampleNs: number): PerfEvidenceReport => ({
  provenance: {
    recipeHash: "fixture-hash",
    appBuild: "1",
    processIdentity: { name: "dev.probe.fixture", pid: 111 },
    device: { name: "iPhone 13 Pro Simulator", udid: "udid-1", osVersion: "18.0" },
    xcodeVersion: "Xcode 16.0",
    xctraceVersion: "16.0",
    templateDigest: "preset:time-profiler",
    generatedAt: `2026-01-01T00:00:0${repetitionIndex}.000Z`,
  },
  phases: [],
  channels: [{ channel: "cpu-samples", status: "available", rowCount: 1 }],
  metrics: [{ key: "cpu-sample-duration-ns", unit: "ns", samples: [sampleNs] }],
  findings: [{
    id: `finding-${repetitionIndex}`,
    kind: "observation",
    summary: `Repetition ${repetitionIndex} observation.`,
    windowLabel: "full-recording",
    source: { schema: "time-sample", rowSelector: "row[0]" },
    confidence: "high",
    basis: ["time-sample rows"],
  }],
})

interface FakeDepsOptions {
  readonly onReserveRecorder?: (investigationId: string) => void
  readonly onCaptureRepetition?: (repetitionIndex: number) => Effect.Effect<void>
  readonly failSetup?: boolean
  readonly failMeasuredFlowAt?: number
  readonly dieAt?: number
}

const makeFakeDeps = (options: FakeDepsOptions = {}) => {
  const capturedIndices: Array<number> = []

  const baseCaptureRepetition: InvestigationExecutorDeps["captureRepetition"] = ({ repetitionIndex }) =>
    Effect.gen(function* () {
      if (options.onCaptureRepetition) {
        yield* options.onCaptureRepetition(repetitionIndex)
      }

      if (options.dieAt === repetitionIndex) {
        return yield* Effect.die(new Error(`simulated crash at repetition ${repetitionIndex}`))
      }

      if (options.failMeasuredFlowAt === repetitionIndex) {
        return yield* Effect.fail(new Error(`measured flow failed at repetition ${repetitionIndex}`) as never)
      }

      capturedIndices.push(repetitionIndex)
      return {
        evidenceReport: makeFakeReport(repetitionIndex, 1_000_000 + repetitionIndex * 1_000),
        traceArtifactKey: `trace-${repetitionIndex}`,
      }
    })

  // A mutable ref rather than reassigning a field on `deps` directly --
  // `InvestigationExecutorDeps`'s members are `readonly` by design (the
  // production port contract), so tests that need to swap in a scenario
  // mid-flight (the cancellation tests below) mutate this ref's `.current`
  // instead of the interface itself.
  const captureRepetitionRef: { current: InvestigationExecutorDeps["captureRepetition"] } = { current: baseCaptureRepetition }

  const deps: InvestigationExecutorDeps = {
    ...makeUnusedInvestigationExecutorDeps(),
    checkSessionReady: () => Effect.succeed({ state: "ready" }),
    reserveRecorder: ({ investigationId }) =>
      Effect.sync(() => {
        options.onReserveRecorder?.(investigationId)
      }),
    releaseRecorder: () => Effect.void,
    runFlow: () =>
      options.failSetup
        ? Effect.fail(new Error("setup flow failed") as never)
        : Effect.succeed({ verdict: "passed", summary: "ok" }),
    captureRepetition: (args) => captureRepetitionRef.current(args),
    sleep: () => Effect.void,
  }

  return { deps, capturedIndices, captureRepetitionRef }
}

const withController = async <T>(
  deps: InvestigationExecutorDeps,
  run: (context: { readonly controller: InvestigationControllerService; readonly store: InvestigationStoreService; readonly root: string }) => Promise<T>,
): Promise<T> => {
  const root = await mkdtemp(join(tmpdir(), "probe-investigation-controller-test-"))
  const previous = process.env.PROBE_ARTIFACT_ROOT
  process.env.PROBE_ARTIFACT_ROOT = root

  const layer = Layer.mergeAll(
    InvestigationStoreLive,
    InvestigationControllerLayer(deps).pipe(Layer.provide(Layer.mergeAll(InvestigationStoreLive, ArtifactStoreLive))),
  )
  const runtime = ManagedRuntime.make(layer)

  try {
    const controller = await runtime.runPromise(InvestigationController)
    const store = await runtime.runPromise(InvestigationStore)
    return await run({ controller, store, root })
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

describe("InvestigationController -- state, events, artifacts", () => {
  test("a diagnosis run (no baseline) completes and reports every repetition's artifact key", async () => {
    const { deps } = makeFakeDeps()
    await withController(deps, async ({ controller }) => {
      const inspection = await Effect.runPromise(controller.run({ recipeInput: baseRecipe }))

      expect(inspection.status).toBe("completed")
      expect(inspection.report).not.toBeNull()
      expect(inspection.report?.overallVerdict).toBe("diagnosis")
      expect(inspection.report?.comparisonVerdict).toBe("not-requested")
      expect(inspection.report?.repetitionReportKeys).toEqual(["trace-0", "trace-1", "trace-2"])
      expect(inspection.report?.findings.total).toBe(3)
    })
  })

  test("overflowing findings (>20 inline) persist a real, non-null typed drill handle", async () => {
    const { deps, captureRepetitionRef } = makeFakeDeps()
    const manyFindingsReport: PerfEvidenceReport = {
      ...makeFakeReport(0, 1_000_000),
      findings: Array.from({ length: 25 }, (_, index) => ({
        id: `finding-${index}`,
        kind: "observation" as const,
        summary: `Observation ${index}.`,
        windowLabel: "full-recording",
        source: { schema: "time-sample", rowSelector: `row[${index}]` },
        confidence: "low" as const,
        basis: ["time-sample rows"],
      })),
    }
    captureRepetitionRef.current = () => Effect.succeed({ evidenceReport: manyFindingsReport, traceArtifactKey: "trace-0" })

    await withController(deps, async ({ controller }) => {
      const inspection = await Effect.runPromise(controller.run({ recipeInput: { ...baseRecipe, repetitions: 1 } }))

      expect(inspection.status).toBe("completed")
      expect(inspection.report?.findings.total).toBe(25)
      expect(inspection.report?.findings.shown.length).toBe(20)
      expect(inspection.report?.findings.omitted).toBe(5)
      // The whole point of this fix: overflow must be a real, resolvable
      // artifact handle, never a `null` that would contradict
      // `BoundedCollection`'s own "drill null means nothing was omitted"
      // invariant (domain/bounded.ts).
      expect(inspection.report?.findings.drill).not.toBeNull()
      expect(inspection.report?.findings.drill?.artifactKey).toContain("findings-overflow")
    })
  })

  test("a before/after run (inline baseline report) computes a comparison verdict", async () => {
    // Baseline is far enough below the run's ~1,001,000ns candidate median
    // to clear `DEFAULT_REGRESSION_THRESHOLD` (5%) and read as "regressed",
    // not just run-to-run noise.
    const baseline: PerfEvidenceReport = makeFakeReport(0, 500_000)
    const { deps } = makeFakeDeps()
    await withController(deps, async ({ controller }) => {
      const inspection = await Effect.runPromise(controller.run({
        recipeInput: { ...baseRecipe, baseline: { kind: "report", report: baseline } },
      }))

      expect(inspection.status).toBe("completed")
      expect(inspection.report?.overallVerdict).toBe("before-after-proof")
      expect(inspection.report?.comparison).not.toBeNull()
      expect(inspection.report?.comparisonVerdict).toBe("regressed")
    })
  })

  test("events accumulate in strictly increasing sequence order across the whole run", async () => {
    const { deps } = makeFakeDeps()
    await withController(deps, async ({ controller }) => {
      const inspection = await Effect.runPromise(controller.run({ recipeInput: baseRecipe }))
      const events = await Effect.runPromise(controller.events(inspection.investigationId))

      expect(events.shown.length).toBeGreaterThan(0)
      const sequences = events.shown.map((event) => event.sequence)
      expect(sequences).toEqual([...sequences].sort((a, b) => a - b))
      expect(new Set(sequences).size).toBe(sequences.length)
      expect(events.shown.some((event) => event.stage === "report" && event.type === "stage-completed")).toBe(true)
    })
  })

  test("inspect reads durable state without re-running anything", async () => {
    const { deps } = makeFakeDeps()
    await withController(deps, async ({ controller }) => {
      const inspection = await Effect.runPromise(controller.run({ recipeInput: baseRecipe }))
      const reread = await Effect.runPromise(controller.inspect(inspection.investigationId))
      expect(reread).toEqual(inspection)
    })
  })

  test("waitFor returns immediately once the investigation is already terminal", async () => {
    const { deps } = makeFakeDeps()
    await withController(deps, async ({ controller }) => {
      const inspection = await Effect.runPromise(controller.run({ recipeInput: baseRecipe }))
      const waited = await Effect.runPromise(controller.waitFor(inspection.investigationId, { timeoutMs: 5_000, pollMs: 10 }))
      expect(waited.status).toBe("completed")
    })
  })
})

describe("InvestigationController -- failure never silently reopens", () => {
  test("a failing setup flow stops the line and reports status failed with a reason", async () => {
    const { deps } = makeFakeDeps({ failSetup: true })
    await withController(deps, async ({ controller }) => {
      const inspection = await Effect.runPromise(controller.run({
        recipeInput: { ...baseRecipe, setup: measuredFlow },
      }))

      expect(inspection.status).toBe("failed")
      expect(inspection.failureReason).toContain("setup flow failed")
      expect(inspection.currentStage).toBe("setup")
    })
  })

  test("a failed investigation cannot be resumed", async () => {
    const { deps } = makeFakeDeps({ failSetup: true })
    await withController(deps, async ({ controller }) => {
      const inspection = await Effect.runPromise(controller.run({
        recipeInput: { ...baseRecipe, setup: measuredFlow },
      }))

      const resumeAttempt = await Effect.runPromise(Effect.either(controller.run({ resumeId: inspection.investigationId })))
      expect(resumeAttempt._tag).toBe("Left")
    })
  })

  test("a measured-flow failure mid-capture stops the line rather than skipping the repetition", async () => {
    const { deps, capturedIndices } = makeFakeDeps({ failMeasuredFlowAt: 1 })
    await withController(deps, async ({ controller }) => {
      const inspection = await Effect.runPromise(controller.run({ recipeInput: baseRecipe }))
      expect(inspection.status).toBe("failed")
      expect(capturedIndices).toEqual([0])
    })
  })
})

describe("InvestigationController -- cancellation preserves verified artifacts", () => {
  test("cancelling mid-capture stops before the next repetition and keeps already-captured artifacts", async () => {
    let investigationId = ""
    const { deps, capturedIndices, captureRepetitionRef } = makeFakeDeps({
      onReserveRecorder: (id) => {
        investigationId = id
      },
    })

    await withController(deps, async ({ controller, store }) => {
      // Wire cancellation now that `store` (from the same layer the
      // controller runs against) is available: repetition 0's capture
      // requests cancellation as its own side effect, simulating an
      // operator's `investigate cancel` arriving mid-recording.
      const originalCapture = captureRepetitionRef.current
      captureRepetitionRef.current = (args) =>
        Effect.gen(function* () {
          if (args.repetitionIndex === 0) {
            yield* store.requestCancel(investigationId)
          }

          return yield* originalCapture(args)
        })

      const inspection = await Effect.runPromise(controller.run({ recipeInput: baseRecipe }))

      expect(inspection.status).toBe("cancelled")
      expect(inspection.report).toBeNull()
      // Repetition 0's artifact was captured and persisted before
      // cancellation stopped the line -- verified evidence is preserved,
      // never discarded.
      expect(capturedIndices).toEqual([0])

      const reread = await Effect.runPromise(controller.inspect(inspection.investigationId))
      expect(reread.status).toBe("cancelled")
    })
  })

  test("cancelling during cooldown does not wait out the full interval (AC#5 review fix)", async () => {
    let investigationId = ""
    const { deps, capturedIndices, captureRepetitionRef } = makeFakeDeps({
      onReserveRecorder: (id) => {
        investigationId = id
      },
    })
    // `sleep` never resolves on its own -- if the cooldown were awaited to
    // completion instead of raced against a cancellation poll
    // (`interruptibleCooldown`, InvestigationController.ts), this test would
    // hang until bun's test timeout rather than observing "cancelled".
    const neverCooldownDeps: InvestigationExecutorDeps = { ...deps, sleep: () => Effect.never }

    await withController(neverCooldownDeps, async ({ controller, store }) => {
      const originalCapture = captureRepetitionRef.current
      captureRepetitionRef.current = (args) =>
        Effect.gen(function* () {
          if (args.repetitionIndex === 0) {
            yield* store.requestCancel(investigationId)
          }

          return yield* originalCapture(args)
        })

      const inspection = await Effect.runPromise(controller.run({
        recipeInput: { ...baseRecipe, cooldown: { minIntervalMs: 60_000 } },
      }))

      expect(inspection.status).toBe("cancelled")
      expect(capturedIndices).toEqual([0])
    })
  })

  test("a terminal (cancelled) investigation cannot be resumed", async () => {
    let investigationId = ""
    const { deps, captureRepetitionRef } = makeFakeDeps({ onReserveRecorder: (id) => { investigationId = id } })

    await withController(deps, async ({ controller, store }) => {
      const originalCapture = captureRepetitionRef.current
      captureRepetitionRef.current = (args) =>
        Effect.gen(function* () {
          if (args.repetitionIndex === 0) {
            yield* store.requestCancel(investigationId)
          }

          return yield* originalCapture(args)
        })

      const inspection = await Effect.runPromise(controller.run({ recipeInput: baseRecipe }))
      expect(inspection.status).toBe("cancelled")

      const resumeAttempt = await Effect.runPromise(Effect.either(controller.run({ resumeId: inspection.investigationId })))
      expect(resumeAttempt._tag).toBe("Left")
    })
  })
})

describe("InvestigationController -- read/resume across a simulated process crash", () => {
  test("a fresh controller instance resumes an interrupted run from its last verified repetition, never recapturing it", async () => {
    const crashing = makeFakeDeps({ dieAt: 1 })

    await withController(crashing.deps, async ({ controller, root }) => {
      const crashExit = await Effect.runPromiseExit(controller.run({ recipeInput: baseRecipe }))
      expect(crashExit._tag).toBe("Failure")
      expect(crashing.capturedIndices).toEqual([0])

      // Recover the investigation id the crashed run was assigned by reading
      // the durable state directly off disk -- the same thing a fresh CLI
      // invocation would do after a real process crash (it has no in-memory
      // handle to the id either, only what was persisted).
      const investigations = await import("./InvestigationStore").then((module) => module.listInvestigationIds())
      expect(investigations.length).toBe(1)
      const investigationId = investigations[0] as string

      // Fresh deps, fresh controller instance, same on-disk root -- this is
      // the "resume in a new process" contract, not just "call run twice in
      // the same object".
      const resumed = makeFakeDeps()
      const resumedRoot = root
      void resumedRoot

      const previous = process.env.PROBE_ARTIFACT_ROOT
      process.env.PROBE_ARTIFACT_ROOT = root
      const resumeLayer = Layer.mergeAll(
        InvestigationStoreLive,
        InvestigationControllerLayer(resumed.deps).pipe(Layer.provide(Layer.mergeAll(InvestigationStoreLive, ArtifactStoreLive))),
      )
      const resumeRuntime = ManagedRuntime.make(resumeLayer)

      try {
        const resumedController = await resumeRuntime.runPromise(InvestigationController)
        const inspection = await Effect.runPromise(resumedController.run({ resumeId: investigationId }))

        expect(inspection.status).toBe("completed")
        // Repetition 0 was never recaptured by the resumed run -- only 1
        // and 2, continuing exactly where the crash left off.
        expect(resumed.capturedIndices).toEqual([1, 2])
        expect(inspection.report?.repetitionReportKeys).toEqual(["trace-0", "trace-1", "trace-2"])
      } finally {
        await resumeRuntime.dispose()

        if (previous === undefined) {
          delete process.env.PROBE_ARTIFACT_ROOT
        } else {
          process.env.PROBE_ARTIFACT_ROOT = previous
        }
      }

      void controller
    })
  })
})
