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
  advertisedRunnerCapabilities,
  requireRunnerCapability,
} from "../runnerCapabilities"
import type { RunnerCommandResult } from "../SimulatorHarness"
import {
  isRunnerBackedRecord,
  withOffscreenNextStep,
  type ActiveSessionRecord,
  type SessionActionError,
} from "../SessionRegistry"
import type { StoredSnapshotArtifact } from "../../domain/snapshot"
import type { ArtifactRecord } from "../../domain/output"
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
 * batch command, with an optional end-of-batch checkpoint snapshot.
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
  readonly checkpointCapture:
    | { readonly artifact: StoredSnapshotArtifact; readonly artifactRecord: ArtifactRecord; readonly handledMs: number }
    | null
  readonly checkpointError: SessionActionError | null
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
    const checkpoint = step.checkpoint ?? "none"

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

        const response = yield* deps.sendRunnerCommand(
          sessionId,
          runnerRecord,
          "uiActionBatch",
          JSON.stringify(payload),
        )
        deps.updateHealthCheck(record, response.action, response.ok)

        const checkpointCapture = checkpoint === "end"
          ? yield* Effect.either(deps.captureSnapshotArtifactInternal(sessionId, record))
          : null

        if (checkpoint === "none") {
          yield* deps.persistRecordHealth(sessionId, record)
        }

        return {
          response,
          checkpointCapture: checkpointCapture !== null && checkpointCapture._tag === "Right"
            ? checkpointCapture.right
            : null,
          checkpointError: checkpointCapture !== null && checkpointCapture._tag === "Left"
            ? checkpointCapture.left
            : null,
        }
      }),
    )

    if (dispatch._tag === "Left") {
      return { ok: false, error: dispatch.left }
    }

    return {
      ok: true,
      value: {
        response: dispatch.right.response,
        checkpointCapture: dispatch.right.checkpointCapture,
        checkpointError: dispatch.right.checkpointError,
      } satisfies BatchDispatchResult,
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
  const checkpoint = step.checkpoint ?? "none"

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
      checkpoint,
      sequenceChildFailure: null,
    })
  }

  const { response, checkpointCapture, checkpointError } = outcome.value
  const batchHandledMs = response.totalHandledMs ?? response.handledMs
  const latestSnapshotId = checkpointCapture?.artifact.snapshotId ?? latestSnapshotIdBefore

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

    if (checkpointError) {
      warnings.push(
        `Requested end checkpoint failed after the batch error: ${errorSummary(checkpointError)}`,
        ...("details" in checkpointError && Array.isArray(checkpointError.details) ? checkpointError.details : []),
      )
    }

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
      checkpoint,
      sequenceChildFailure,
    })
  }

  if (checkpointError) {
    return buildFlowStepResult({
      plannedStep,
      kind: plannedStep.step.kind,
      summary: `Batch sequence executed, but the requested end checkpoint failed: ${errorSummary(checkpointError)}`,
      verdict: failureVerdict(checkpointError),
      matchedRef: null,
      latestSnapshotId,
      retryCount: 0,
      retryReasons: [],
      handledMs: batchHandledMs,
      warnings: failureWarnings({
        error: checkpointError,
        continued: continueOnError,
      }),
      checkpoint,
      sequenceChildFailure: null,
    })
  }

  return buildFlowStepResult({
    plannedStep,
    kind: plannedStep.step.kind,
    summary: checkpoint === "end"
      ? `Executed fast sequence step with ${step.actions.length} child action(s) through the runner batch lane; captured ${latestSnapshotId}.`
      : `Executed fast sequence step with ${step.actions.length} child action(s) through the runner batch lane without host checkpoints.`,
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
    checkpoint,
    sequenceChildFailure: null,
  })
}
