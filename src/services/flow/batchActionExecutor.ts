import { Effect } from "effect"
import { EnvironmentError } from "../../domain/errors"
import type {
  FlowSequenceAction,
  FlowSequenceChildFailure,
  FlowSequenceStep,
  FlowV2StepResult,
} from "../../domain/flow-v2"
import type { PlannedStep } from "../../domain/flow-planner"
import { buildDirectRunnerUiActionPayload } from "../../domain/action"
import {
  buildEvidenceReport,
  emptyEvidenceReport,
  planSuccessEvidence,
  resolveEvidencePolicy,
  shouldCaptureFailureEvidence,
  type EvidenceCapture,
} from "../../domain/evidence"
import {
  advertisedRunnerCapabilities,
  requireRunnerCapability,
} from "../runnerCapabilities"
import type { RunnerCommandResult } from "../SimulatorHarness"
import {
  isRunnerBackedRecord,
  withOffscreenNextStep,
  type ActiveSessionRecord,
  type SessionActionError,
} from "../sessionShared"
import type { FlowExecutorDeps } from "./flowExecutorDeps"
import {
  buildFlowStepResult,
  classifyFastFailureCode,
  errorSummary,
  failureVerdict,
  failureWarnings,
  successWarnings,
} from "./flowStepResultAssembly"

/**
 * PRB-073: extracted from `runFlow`'s inline `plannedStep.kind ===
 * "batch-sequence"` branch. The "batch action" lane — a `sequence` step's
 * child tap/press/swipe/type/scroll/wait actions dispatched as one runner
 * batch command.
 *
 * PRB-093: the sequence-only "none"/"end" checkpoint vocabulary is gone --
 * this lane now asks the same canonical evidence policy (evidence.ts) every
 * other mutation-capable step asks. "around" is new for this lane (a batch
 * previously had no pre-dispatch capture at all); "end" and "none" keep
 * their old capture counts (1 post-batch snapshot / zero), just reported
 * through the shared `EvidenceReport` shape instead of a bare literal.
 */

type RunnerBatchWaitActionPayload = {
  readonly kind: "wait"
  readonly timeoutMs: number
}

type RunnerBatchSequenceActionPayload = ReturnType<typeof buildDirectRunnerUiActionPayload> | RunnerBatchWaitActionPayload

interface RunnerBatchSequencePayload {
  readonly actions: ReadonlyArray<RunnerBatchSequenceActionPayload>
}

export const buildRunnerBatchSequencePayload = (actions: ReadonlyArray<FlowSequenceAction>): RunnerBatchSequencePayload => ({
  actions: actions.map((action) => {
    switch (action.kind) {
      case "wait":
        return {
          kind: "wait",
          timeoutMs: action.timeoutMs,
        }
      case "tap":
      case "multiTap":
      case "press":
      case "swipe":
      case "type":
      case "scroll":
        return buildDirectRunnerUiActionPayload(action, action.target)
    }
  }),
})

export const toFlowSequenceActionKind = (value: string | null | undefined): FlowSequenceAction["kind"] | null => {
  switch (value) {
    case "tap":
    case "multiTap":
    case "press":
    case "swipe":
    case "type":
    case "scroll":
    case "wait":
      return value
    default:
      return null
  }
}

export const buildBatchSequenceChildFailure = (args: {
  readonly step: FlowSequenceStep
  readonly response: RunnerCommandResult
  readonly failureReason: string
}): FlowSequenceChildFailure | null => {
  const rawIndex = args.response.failedActionIndex

  if (rawIndex === null || rawIndex === undefined || !Number.isInteger(rawIndex) || rawIndex < 0) {
    return null
  }

  const plannedChild = args.step.actions[rawIndex]
  const fallbackKind = toFlowSequenceActionKind(args.response.failedActionKind)

  return {
    index: rawIndex + 1,
    kind: plannedChild?.kind ?? fallbackKind ?? "tap",
    summary: args.failureReason,
  }
}

interface BatchDispatchResult {
  readonly response: RunnerCommandResult
  readonly evidenceCaptures: ReadonlyArray<EvidenceCapture>
  // Only the success-path post capture gets its own error slot: a batch
  // that ran but whose requested evidence failed to land is worth
  // surfacing distinctly (mirrors the old "end checkpoint failed" case).
  // Pre captures ("around") and failure captures are best-effort and
  // swallowed on error, exactly like the fast direct-runner lane.
  readonly postCaptureError: SessionActionError | null
}

export type BatchActionOutcome =
  | { readonly ok: true; readonly value: BatchDispatchResult }
  | { readonly ok: false; readonly error: SessionActionError }

/** Dispatches one batch-sequence step to the runner. Never fails itself (mirrors the original `Effect.either`-wrapped dispatch) — failure is reported through `BatchActionOutcome["ok"]`. */
export const executeBatchActionStep = (args: {
  readonly sessionId: string
  readonly record: ActiveSessionRecord
  readonly step: FlowSequenceStep
  readonly deps: FlowExecutorDeps
}): Effect.Effect<BatchActionOutcome> =>
  Effect.gen(function* () {
    const { sessionId, record, step, deps } = args
    const policy = resolveEvidencePolicy(step.evidencePolicy)
    const successPlan = planSuccessEvidence(policy.success)

    const dispatch = yield* Effect.either(
      Effect.gen(function* () {
        const runnerRecord = yield* requireRunnerCapability({
          record,
          isRunnerBacked: isRunnerBackedRecord,
          advertised: (activeRecord) => advertisedRunnerCapabilities(activeRecord.health.runner),
          capability: "uiActionBatch",
          capabilityTag: "session.run.sequence.batch",
          usageDescription: "fast sequence execution",
          notRunnerBacked: {
            code: "session-action-real-device-runner",
            reason: "This session does not currently expose a live runner transport for batch sequence flow steps.",
            nextStep: "Inspect session health/artifacts, or reopen the session once the runner transport is live.",
          },
          missingCapabilityNextStep: "Open a session against a runner that reports uiActionBatch capability, or rewrite the flow as verified single steps.",
        })

        const payload = yield* Effect.try({
          try: () => buildRunnerBatchSequencePayload(step.actions),
          catch: (error) =>
            new EnvironmentError({
              code: "session-action-target-not-found",
              reason: error instanceof Error ? error.message : String(error),
              nextStep: "Use semantic selectors, point selectors, or ref selectors with semantic fallbacks for batched sequence actions.",
              details: [],
            }),
        })

        const evidenceCaptures: Array<EvidenceCapture> = []

        // "around" is the only policy that ever pays for a pre-dispatch
        // capture in this lane — every batch child target is already
        // runner-resolvable (semantic/point/ref+fallback; see
        // isRunnerResolvableActionSelector), so a pre capture here is pure
        // evidence, never resolution.
        if (successPlan.forcedFreshPre) {
          const preCapture = yield* Effect.either(deps.captureSnapshotArtifactInternal(sessionId, record))

          if (preCapture._tag === "Right") {
            evidenceCaptures.push({
              reason: "policy-pre",
              phase: "pre",
              snapshotId: preCapture.right.artifact.snapshotId,
              ms: preCapture.right.handledMs,
            })
          }
        }

        const response = yield* deps.sendRunnerCommand(
          sessionId,
          runnerRecord,
          "uiActionBatch",
          JSON.stringify(payload),
        )
        deps.updateHealthCheck(record, response.action, response.ok)

        if (!response.ok) {
          if (shouldCaptureFailureEvidence(policy.failure)) {
            const failureCapture = yield* Effect.either(deps.captureSnapshotArtifactInternal(sessionId, record))

            if (failureCapture._tag === "Right") {
              evidenceCaptures.push({
                reason: "policy-failure",
                phase: "post",
                snapshotId: failureCapture.right.artifact.snapshotId,
                ms: failureCapture.right.handledMs,
              })
            }
          }

          yield* deps.persistRecordHealth(sessionId, record)
          return { response, evidenceCaptures, postCaptureError: null }
        }

        const postCapture = successPlan.needsPost
          ? yield* Effect.either(deps.captureSnapshotArtifactInternal(sessionId, record))
          : null

        if (postCapture === null) {
          yield* deps.persistRecordHealth(sessionId, record)
        }

        if (postCapture !== null && postCapture._tag === "Right") {
          evidenceCaptures.push({
            reason: "policy-post",
            phase: "post",
            snapshotId: postCapture.right.artifact.snapshotId,
            ms: postCapture.right.handledMs,
          })
        }

        return {
          response,
          evidenceCaptures,
          postCaptureError: postCapture !== null && postCapture._tag === "Left" ? postCapture.left : null,
        }
      }),
    )

    if (dispatch._tag === "Left") {
      return { ok: false, error: dispatch.left }
    }

    return {
      ok: true,
      value: dispatch.right satisfies BatchDispatchResult,
    }
  })

/** Turns a `BatchActionOutcome` into the step's `FlowV2StepResult` — the batch-specific slice of "step-result assembly", co-located with the outcome shape it consumes. */
export const buildBatchStepResult = (args: {
  readonly plannedStep: Extract<PlannedStep, { readonly kind: "batch-sequence" }>
  readonly step: FlowSequenceStep
  readonly continueOnError: boolean
  readonly outcome: BatchActionOutcome
  readonly latestSnapshotIdBefore: string | null
}): FlowV2StepResult => {
  const { plannedStep, step, continueOnError, outcome, latestSnapshotIdBefore } = args
  const policy = resolveEvidencePolicy(step.evidencePolicy)

  if (!outcome.ok) {
    return buildFlowStepResult({
      plannedStep,
      kind: plannedStep.step.kind,
      summary: errorSummary(outcome.error),
      verdict: failureVerdict(outcome.error),
      matchedRef: null,
      latestSnapshotId: latestSnapshotIdBefore,
      retryCount: 0,
      retryReasons: [],
      handledMs: null,
      warnings: failureWarnings({
        error: outcome.error,
        continued: continueOnError,
      }),
      evidence: emptyEvidenceReport(policy),
      sequenceChildFailure: null,
    })
  }

  const { response, evidenceCaptures, postCaptureError } = outcome.value
  const batchHandledMs = response.totalHandledMs ?? response.handledMs
  const lastCapture = evidenceCaptures[evidenceCaptures.length - 1] ?? null
  const latestSnapshotId = lastCapture?.snapshotId ?? latestSnapshotIdBefore
  const evidence = buildEvidenceReport(policy, evidenceCaptures)

  if (!response.ok) {
    const failureReason = response.error
      ?? response.payload
      ?? `Runner batch sequence failed with status ${response.statusLabel}.`
    const sequenceChildFailure = buildBatchSequenceChildFailure({
      step,
      response,
      failureReason,
    })
    const batchFailure = new EnvironmentError({
      code: classifyFastFailureCode(failureReason),
      reason: failureReason,
      nextStep: withOffscreenNextStep(
        "Inspect the latest runner log artifacts, refine the direct selectors, and retry the batch sequence step.",
        failureReason,
      ),
      details: [],
    })
    const warnings = failureWarnings({
      error: batchFailure,
      continued: continueOnError,
    })

    return buildFlowStepResult({
      plannedStep,
      kind: plannedStep.step.kind,
      summary: sequenceChildFailure
        ? `Sequence child ${sequenceChildFailure.index} (${sequenceChildFailure.kind}) failed in runner batch lane: ${sequenceChildFailure.summary}`
        : failureReason,
      verdict: failureVerdict(batchFailure),
      matchedRef: null,
      latestSnapshotId,
      retryCount: 0,
      retryReasons: [],
      handledMs: batchHandledMs,
      warnings,
      evidence,
      sequenceChildFailure,
    })
  }

  if (postCaptureError) {
    return buildFlowStepResult({
      plannedStep,
      kind: plannedStep.step.kind,
      summary: `Batch sequence executed, but the requested evidence capture failed: ${errorSummary(postCaptureError)}`,
      verdict: failureVerdict(postCaptureError),
      matchedRef: null,
      latestSnapshotId,
      retryCount: 0,
      retryReasons: [],
      handledMs: batchHandledMs,
      warnings: failureWarnings({
        error: postCaptureError,
        continued: continueOnError,
      }),
      evidence,
      sequenceChildFailure: null,
    })
  }

  return buildFlowStepResult({
    plannedStep,
    kind: plannedStep.step.kind,
    summary: evidenceCaptures.length > 0
      ? `Executed fast sequence step with ${step.actions.length} child action(s) through the runner batch lane; captured ${latestSnapshotId}.`
      : `Executed fast sequence step with ${step.actions.length} child action(s) through the runner batch lane without host evidence captures.`,
    verdict: "passed",
    matchedRef: null,
    latestSnapshotId,
    retryCount: 0,
    retryReasons: [],
    handledMs: batchHandledMs,
    warnings: successWarnings({
      step,
      baseWarnings: [],
    }),
    evidence,
    sequenceChildFailure: null,
  })
}
