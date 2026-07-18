import { Context, Effect, Layer } from "effect"
import { boundedCollectionAllShown, type BoundedCollection } from "../domain/bounded"
import {
  assembleInvestigationReport,
  buildInvestigationEvent,
  compareEvidenceReports,
  decodeInvestigationRecipe,
  deriveComparisonVerdict,
  identifyRegressedMetrics,
  mergeAndRankFindings,
  mergeInvestigationEvidenceReports,
  overallFindingsConfidence,
  planInvestigation,
  validateInvestigationRecipe,
  validateInvestigationRecipeDomain,
  type InvestigationEvent,
  type InvestigationExecutionPlan,
  type InvestigationRecipe,
  type InvestigationReport,
  type InvestigationStageName,
  type InvestigationValidation,
  type InvestigationWall,
  type PerfEvidenceComparisonType,
  type PerfEvidenceReportType,
} from "../domain/investigation"
import { EnvironmentError, SessionConflictError, UserInputError } from "../domain/errors"
import { ArtifactStore } from "./ArtifactStore"
import { bindBoundedCollection } from "./boundedCollections"
import type { InvestigationExecutorDeps } from "./investigation/investigationExecutorDeps"
import { InvestigationStore, type InvestigationState } from "./InvestigationStore"

// AC: "Terminal JSON contains bounded ranked findings ..." -- how many
// findings inline before the rest overflows to a persisted, drillable
// artifact (`bindBoundedCollection`, services/boundedCollections.ts).
const findingsInlineLimit = 20

// PRB-099: the durable orchestrator behind `probe investigate`. Composes the
// pure domain plan (domain/investigation.ts) with `InvestigationStore`
// (durable state/events) and an injected `InvestigationExecutorDeps` (the
// only impure/hardware-touching surface) to drive one investigation through
// its stable stage line: preflight -> [setup] -> [warmup] -> capture ->
// analyze -> [compare] -> report.
//
// Every stage transition is persisted before the next stage starts (AC:
// "durable investigation ID ... contract-tested"), so a process that dies
// mid-run leaves a state document a fresh `InvestigationController` instance
// can read (`inspect`) or continue (`run` with `resumeId`) -- see
// `InvestigationController.test.ts` for the crash-and-resume contract test
// that proves this without needing a real daemon/simulator.

export interface InvestigationInspection {
  readonly investigationId: string
  readonly status: InvestigationState["status"]
  readonly stages: ReadonlyArray<InvestigationStageName>
  readonly currentStage: InvestigationStageName | null
  readonly cancelRequested: boolean
  readonly report: InvestigationReport | null
  readonly failureReason: string | null
}

// `currentStageIndex` only ever advances when a stage *completes*
// successfully (see `executeStage`'s success branch in `driveStages`
// below), so "the stage after the last completed one" is, uniformly across
// every terminal status: the stage that failed (failed), the stage
// cancellation interrupted or prevented (cancelled), the stage about to run
// (pending/running), or nothing at all once every stage has completed
// (completed, where this index has run off the end of `stages`).
const currentStageOf = (state: InvestigationState): InvestigationStageName | null => {
  const stages = state.stages as ReadonlyArray<InvestigationStageName>
  const nextIndex = state.currentStageIndex + 1
  return nextIndex < stages.length ? stages[nextIndex]! : null
}

const toInspection = (state: InvestigationState): InvestigationInspection => ({
  investigationId: state.investigationId,
  status: state.status,
  stages: state.stages as ReadonlyArray<InvestigationStageName>,
  currentStage: currentStageOf(state),
  cancelRequested: state.cancelRequested,
  report: state.report,
  failureReason: state.failureReason,
})

const userInputError = (code: string, reason: string, nextStep: string) =>
  new UserInputError({ code, reason, nextStep, details: [] })

// Internal-only signal: a mid-stage cancellation check (currently only the
// "capture" stage's per-repetition loop) needs a way to unwind out of
// `stageEffect` carrying the partial progress made so far, distinct from a
// genuine stage failure -- cancelling mid-capture must persist as
// `status: "cancelled"` with every already-captured repetition preserved,
// never as `status: "failed"`. Modeled as a distinguishable failure value
// (not a second success shape) so the `capture` case's normal-completion
// return type stays a plain patch.
class StageCancelledSignal {
  readonly _tag = "StageCancelledSignal"
  constructor(readonly patch: Partial<InvestigationState>) {}
}

const isStageCancelledSignal = (value: unknown): value is StageCancelledSignal =>
  value instanceof StageCancelledSignal

export class InvestigationController extends Context.Tag("@probe/InvestigationController")<
  InvestigationController,
  {
    /** Pure schema + domain-constraint decode. Never touches the store, the deps, or a session. */
    readonly validate: (recipeInput: unknown) => Effect.Effect<InvestigationValidation>
    /** Pure decode + normalize; no durable ID is created. */
    readonly plan: (recipeInput: unknown) => Effect.Effect<InvestigationExecutionPlan, UserInputError>
    readonly run: (
      args: { readonly recipeInput: unknown } | { readonly resumeId: string },
    ) => Effect.Effect<InvestigationInspection, UserInputError | EnvironmentError | SessionConflictError>
    readonly inspect: (investigationId: string) => Effect.Effect<InvestigationInspection, UserInputError | EnvironmentError>
    readonly events: (
      investigationId: string,
    ) => Effect.Effect<BoundedCollection<InvestigationEvent>, UserInputError | EnvironmentError>
    readonly cancel: (investigationId: string) => Effect.Effect<InvestigationInspection, UserInputError | EnvironmentError>
    readonly waitFor: (
      investigationId: string,
      args: { readonly timeoutMs: number; readonly pollMs?: number },
    ) => Effect.Effect<InvestigationInspection, UserInputError | EnvironmentError>
    readonly compare: (
      args: { readonly baselineId: string; readonly candidateId: string },
    ) => Effect.Effect<PerfEvidenceComparisonType, UserInputError | EnvironmentError>
  }
>() {}

const decodeRecipeOrFail = (recipeInput: unknown) =>
  Effect.try({
    try: () => decodeInvestigationRecipe(recipeInput),
    catch: (error) =>
      userInputError(
        "investigation-recipe-decode",
        `Could not decode investigation recipe: ${error instanceof Error ? error.message : String(error)}.`,
        "Run `probe investigate validate` against this payload and fix the reported violations.",
      ),
  })

const requireNoDomainViolations = (recipe: InvestigationRecipe) =>
  Effect.gen(function* () {
    const violations = validateInvestigationRecipeDomain(recipe)

    if (violations.length > 0) {
      return yield* userInputError(
        "investigation-recipe-invalid",
        `Investigation recipe failed domain validation: ${violations.join(" ")}`,
        "Run `probe investigate validate` against this payload and fix the reported violations.",
      )
    }

    return recipe
  })

export const InvestigationControllerLayer = (deps: InvestigationExecutorDeps) =>
  Layer.effect(
    InvestigationController,
    Effect.gen(function* () {
      const store = yield* InvestigationStore
      const artifactStore = yield* ArtifactStore

      const requireState = (investigationId: string) =>
        Effect.gen(function* () {
          const state = yield* store.read(investigationId)

          if (!state) {
            return yield* userInputError(
              "investigation-not-found",
              `No investigation found with id ${investigationId}.`,
              "Run `probe investigate run` to start an investigation, then retry with its returned id.",
            )
          }

          return state
        })

      // Each stage's own work, one function per stage -- kept separate
      // (rather than inlined as `switch` case bodies in `executeStage`)
      // purely for size/readability; behavior and the "return a patch,
      // fail with the stage's error, or raise `StageCancelledSignal`"
      // contract are identical to what a single big function would do.

      const runPreflightStage = (state: InvestigationState) =>
        Effect.gen(function* () {
          yield* deps.checkSessionReady(state.sessionId)
          yield* deps.reserveRecorder({ sessionId: state.sessionId, investigationId: state.investigationId })
          return {} satisfies Partial<InvestigationState>
        })

      const runFlowStage = (state: InvestigationState, flow: InvestigationRecipe["setup"]) =>
        Effect.gen(function* () {
          yield* deps.runFlow({ sessionId: state.sessionId, flow: flow! })
          return {} satisfies Partial<InvestigationState>
        })

      // Loops from the last already-verified repetition (0 on a fresh run,
      // or wherever a crashed/interrupted prior attempt left off -- see
      // `InvestigationState.capturedRepetitions`'s header comment) through
      // the recipe's declared repetition count. Re-checks `cancelRequested`
      // before every repetition, not just once per stage, so a cancel
      // arriving mid-capture stops before the *next* repetition rather than
      // waiting for the whole stage to finish.
      const runCaptureStage = (state: InvestigationState, recipe: InvestigationRecipe) =>
        Effect.gen(function* () {
          const alreadyCaptured = [...state.capturedRepetitions]

          for (let index = alreadyCaptured.length; index < recipe.repetitions; index += 1) {
            const cancelled = yield* store.read(state.investigationId)

            if (cancelled?.cancelRequested) {
              return yield* Effect.fail(new StageCancelledSignal({ capturedRepetitions: alreadyCaptured }))
            }

            const { evidenceReport, traceArtifactKey } = yield* deps.captureRepetition({
              sessionId: state.sessionId,
              investigationId: state.investigationId,
              repetitionIndex: index,
              capture: recipe.capture,
              measuredFlow: recipe.measuredFlow,
              recipeHash: state.recipeHash,
            })

            alreadyCaptured.push({ index, traceArtifactKey, evidenceReport })
            yield* store.update(state.investigationId, (current) => ({
              ...current,
              capturedRepetitions: alreadyCaptured,
              updatedAt: deps.nowIso(),
            }))

            if (index < recipe.repetitions - 1 && recipe.cooldown.minIntervalMs > 0) {
              yield* deps.sleep(recipe.cooldown.minIntervalMs)
            }
          }

          return { capturedRepetitions: alreadyCaptured } satisfies Partial<InvestigationState>
        })

      const runAnalyzeStage = (state: InvestigationState) => {
        const merged = mergeInvestigationEvidenceReports(
          state.capturedRepetitions.map((repetition) => repetition.evidenceReport as PerfEvidenceReportType),
        )
        return Effect.succeed({ mergedEvidenceReport: merged } satisfies Partial<InvestigationState>)
      }

      const resolveBaselineReport = (baseline: NonNullable<InvestigationRecipe["baseline"]>) =>
        baseline.kind === "report"
          ? Effect.succeed(baseline.report)
          : Effect.gen(function* () {
              const baselineState = yield* requireState(baseline.investigationId)

              if (!baselineState.mergedEvidenceReport) {
                return yield* userInputError(
                  "investigation-baseline-not-ready",
                  `Baseline investigation ${baseline.investigationId} has no merged evidence report yet.`,
                  "Wait for the baseline investigation to reach or pass its \"analyze\" stage, then retry.",
                )
              }

              return baselineState.mergedEvidenceReport as PerfEvidenceReportType
            })

      const runCompareStage = (state: InvestigationState, recipe: InvestigationRecipe) =>
        Effect.gen(function* () {
          const baselineReport = yield* resolveBaselineReport(recipe.baseline!)
          const comparison = compareEvidenceReports(baselineReport, state.mergedEvidenceReport!)
          return { comparisonResult: comparison } satisfies Partial<InvestigationState>
        })

      // A regressed comparison names the channel(s) that regressed as an
      // explicit wall -- this is the "identifies the planted channel and
      // phase" half of the ProbeFixture planted-regression AC
      // (`identifyRegressedMetrics`, domain/investigation.ts): a metric key
      // is already channel-scoped, so no separate phase-attribution step
      // is needed.
      const buildComparisonWalls = (comparisonResult: PerfEvidenceComparisonType | null): ReadonlyArray<InvestigationWall> => {
        if (!comparisonResult || deriveComparisonVerdict(comparisonResult) !== "regressed") {
          return []
        }

        const regressed = identifyRegressedMetrics(comparisonResult)
        return [{
          code: "comparison-regressed",
          summary: `Comparison against the baseline regressed on ${regressed.length} metric(s).`,
          details: regressed.map((metric) => `${metric.key}: +${(metric.relativeDelta * 100).toFixed(1)}% relative to baseline.`),
        }]
      }

      const runReportStage = (state: InvestigationState) =>
        Effect.gen(function* () {
          const merged = mergeAndRankFindings(state.capturedRepetitions.map((repetition) => repetition.evidenceReport.findings))
          // Real persisted-on-overflow drill handle (services/
          // boundedCollections.ts's `bindBoundedCollection`, the same
          // atomic-persist-before-summary contract every other bounded
          // collection at the RPC/CLI boundary already uses) -- not a
          // hardcoded `drill: null`, which would violate `BoundedCollection`'s
          // own invariant the moment a run had more than
          // `findingsInlineLimit` findings.
          const findings = yield* bindBoundedCollection(artifactStore, {
            sessionId: state.sessionId,
            collectionLabel: `investigation-${state.investigationId}-findings`,
            items: merged,
            shownLimit: findingsInlineLimit,
          })

          const report = assembleInvestigationReport({
            investigationId: state.investigationId,
            recipeHash: state.recipeHash,
            status: "completed",
            findings,
            confidence: overallFindingsConfidence(merged),
            walls: buildComparisonWalls(state.comparisonResult),
            comparison: state.comparisonResult,
            repetitionReportKeys: state.capturedRepetitions.map((repetition) => repetition.traceArtifactKey),
            generatedAt: deps.nowIso(),
          })
          return { report } satisfies Partial<InvestigationState>
        })

      const runStageWork = (state: InvestigationState, stage: InvestigationStageName): Effect.Effect<Partial<InvestigationState>, unknown> => {
        const recipe = state.recipe as InvestigationRecipe

        switch (stage) {
          case "preflight": return runPreflightStage(state)
          case "setup": return runFlowStage(state, recipe.setup)
          case "warmup": return runFlowStage(state, recipe.warmup)
          case "capture": return runCaptureStage(state, recipe)
          case "analyze": return runAnalyzeStage(state)
          case "compare": return runCompareStage(state, recipe)
          case "report": return runReportStage(state)
          default: return Effect.succeed({})
        }
      }

      // One stage's worth of work. Returns the next persisted state; never
      // throws for an expected stage failure -- a failed capture/flow is
      // reported via `status: "failed"` + `failureReason`, not an Effect
      // failure, so the caller (CLI) always gets a terminal report to show
      // rather than a bare exception. Only genuine store I/O errors
      // (`EnvironmentError`) propagate.
      const executeStage = (args: {
        readonly state: InvestigationState
        readonly stage: InvestigationStageName
      }): Effect.Effect<InvestigationState, EnvironmentError> =>
        Effect.gen(function* () {
          const { state, stage } = args

          yield* store.appendEvent(state.investigationId, (sequence) =>
            buildInvestigationEvent({
              sequence,
              stage,
              type: "stage-started",
              message: `Starting stage "${stage}".`,
              timestamp: deps.nowIso(),
            }))

          const outcome = yield* runStageWork(state, stage).pipe(Effect.either)

          if (outcome._tag === "Left" && isStageCancelledSignal(outcome.left)) {
            // Mid-stage cancellation (currently only reachable from
            // "capture"'s per-repetition loop): persist whatever progress
            // was made, then let `driveStages`'s own top-of-loop cancel
            // check finalize `status: "cancelled"` + release the recorder --
            // this branch only needs to commit the partial patch, never a
            // stage-completed event (the stage did not complete).
            const cancellationPatch = outcome.left.patch
            return yield* store.update(state.investigationId, (current) => ({
              ...current,
              ...cancellationPatch,
              updatedAt: deps.nowIso(),
            }))
          }

          if (outcome._tag === "Left") {
            const failureReason = outcome.left instanceof Error ? outcome.left.message : String(outcome.left)

            yield* store.appendEvent(state.investigationId, (sequence) =>
              buildInvestigationEvent({
                sequence,
                stage,
                type: "stage-failed",
                message: `Stage "${stage}" failed: ${failureReason}`,
                timestamp: deps.nowIso(),
              }))

            yield* deps.releaseRecorder({ sessionId: state.sessionId, investigationId: state.investigationId })

            return yield* store.update(state.investigationId, (current) => ({
              ...current,
              status: "failed",
              failureReason,
              updatedAt: deps.nowIso(),
            }))
          }

          yield* store.appendEvent(state.investigationId, (sequence) =>
            buildInvestigationEvent({
              sequence,
              stage,
              type: "stage-completed",
              message: `Completed stage "${stage}".`,
              timestamp: deps.nowIso(),
            }))

          return yield* store.update(state.investigationId, (current) => ({
            ...current,
            ...outcome.right,
            currentStageIndex: current.currentStageIndex + 1,
            updatedAt: deps.nowIso(),
          }))
        })

      const driveStages = (initialState: InvestigationState): Effect.Effect<InvestigationState, EnvironmentError> =>
        Effect.gen(function* () {
          let state = initialState

          if (state.status === "pending") {
            state = yield* store.update(state.investigationId, (current) => ({ ...current, status: "running", updatedAt: deps.nowIso() }))
          }

          const stages = state.stages as ReadonlyArray<InvestigationStageName>

          while (state.currentStageIndex + 1 < stages.length) {
            const fresh = yield* store.read(state.investigationId)

            if (fresh?.cancelRequested) {
              yield* store.appendEvent(state.investigationId, (sequence) =>
                buildInvestigationEvent({
                  sequence,
                  stage: stages[Math.max(state.currentStageIndex, 0)] as InvestigationStageName,
                  type: "cancelled",
                  message: "Investigation cancelled before the next stage started; already-captured artifacts are preserved.",
                  timestamp: deps.nowIso(),
                }))

              yield* deps.releaseRecorder({ sessionId: state.sessionId, investigationId: state.investigationId })

              return yield* store.update(state.investigationId, (current) => ({
                ...current,
                status: "cancelled",
                updatedAt: deps.nowIso(),
              }))
            }

            const nextStage = stages[state.currentStageIndex + 1] as InvestigationStageName
            state = yield* executeStage({ state, stage: nextStage })

            if (state.status === "failed" || state.status === "cancelled") {
              return state
            }
          }

          yield* deps.releaseRecorder({ sessionId: state.sessionId, investigationId: state.investigationId })

          return yield* store.update(state.investigationId, (current) => ({
            ...current,
            status: "completed",
            updatedAt: deps.nowIso(),
          }))
        })

      return InvestigationController.of({
        validate: (recipeInput) => Effect.succeed(validateInvestigationRecipe(recipeInput)),

        plan: (recipeInput) =>
          Effect.gen(function* () {
            const recipe = yield* decodeRecipeOrFail(recipeInput)
            const validated = yield* requireNoDomainViolations(recipe)
            return planInvestigation(validated)
          }),

        run: (args) =>
          Effect.gen(function* () {
            if ("resumeId" in args) {
              const existing = yield* requireState(args.resumeId)

              if (existing.status === "completed" || existing.status === "failed" || existing.status === "cancelled") {
                return yield* userInputError(
                  "investigation-terminal",
                  `Investigation ${args.resumeId} is already terminal (${existing.status}) and cannot be resumed.`,
                  "Start a new investigation with `probe investigate run` instead of resuming a terminal one.",
                )
              }

              const finalState = yield* driveStages(existing)
              return toInspection(finalState)
            }

            const recipe = yield* decodeRecipeOrFail(args.recipeInput)
            const validated = yield* requireNoDomainViolations(recipe)
            const plan = planInvestigation(validated)
            const investigationId = deps.newInvestigationId()
            const createdAt = deps.nowIso()

            const created = yield* store.create({
              investigationId,
              sessionId: validated.target.sessionId,
              recipe: validated,
              recipeHash: plan.recipeHash,
              plan,
              createdAt,
            })

            const finalState = yield* driveStages(created)
            return toInspection(finalState)
          }),

        inspect: (investigationId) => Effect.map(requireState(investigationId), toInspection),

        events: (investigationId) =>
          Effect.gen(function* () {
            yield* requireState(investigationId)
            const events = yield* store.readEvents(investigationId)
            return boundedCollectionAllShown(events)
          }),

        cancel: (investigationId) =>
          Effect.gen(function* () {
            yield* requireState(investigationId)
            const next = yield* store.requestCancel(investigationId)
            return toInspection(next)
          }),

        waitFor: (investigationId, { timeoutMs, pollMs = 200 }) =>
          Effect.gen(function* () {
            const deadline = Date.now() + timeoutMs

            while (true) {
              const state = yield* requireState(investigationId)

              if (state.status === "completed" || state.status === "failed" || state.status === "cancelled") {
                return toInspection(state)
              }

              if (Date.now() >= deadline) {
                return toInspection(state)
              }

              yield* Effect.sleep(Math.min(pollMs, Math.max(deadline - Date.now(), 0)))
            }
          }),

        compare: ({ baselineId, candidateId }) =>
          Effect.gen(function* () {
            const baselineState = yield* requireState(baselineId)
            const candidateState = yield* requireState(candidateId)

            if (!baselineState.mergedEvidenceReport || !candidateState.mergedEvidenceReport) {
              return yield* userInputError(
                "investigation-not-comparable",
                "Both investigations must have reached (or passed) their \"analyze\" stage before comparison.",
                "Wait for both investigations to complete analysis, then retry `probe investigate compare`.",
              )
            }

            return compareEvidenceReports(baselineState.mergedEvidenceReport, candidateState.mergedEvidenceReport)
          }),
      })
    }),
  )
