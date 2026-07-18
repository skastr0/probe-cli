import type { Either } from "effect"
import type { SessionActionResult } from "../../domain/action"
import type {
  FlowSequenceChildFailure,
  FlowV2FailedStep,
  FlowV2Result,
  FlowV2Step,
  FlowV2StepResult,
  SessionFlowResult,
} from "../../domain/flow-v2"
import type { PlannedStep } from "../../domain/flow-planner"
import type { ArtifactRecord } from "../../domain/output"
import { emptyEvidenceReport, resolveEvidencePolicy, type EvidenceReport } from "../../domain/evidence"
import { EnvironmentError, SessionNotFoundError } from "../../domain/errors"
import { dedupeStrings, selectorDriftContractWarning, type ActionExecutionOutcome, type SessionActionError } from "../SessionRegistry"

/**
 * PRB-073: pure step-result assembly, extracted from `runFlow`'s body. No
 * Effect, no session state — every function here is a plain data transform,
 * so it needs no deps bag and no SessionRegistry layer to test.
 */

export const failureVerdict = (error: SessionActionError): SessionFlowResult["verdict"] =>
  error instanceof EnvironmentError && error.code === "session-wait-timeout" ? "timed-out" : "failed"

export const failureWarnings = (args: {
  readonly error: SessionActionError
  readonly continued: boolean
}): Array<string> => {
  const warnings: Array<string> = []

  if ("nextStep" in args.error && typeof args.error.nextStep === "string") {
    warnings.push(args.error.nextStep)
  }

  if ("details" in args.error && Array.isArray(args.error.details)) {
    warnings.push(...args.error.details)
  }

  if (args.continued) {
    warnings.push("Step failed but flow continued because continueOnError was enabled.")
  }

  return dedupeStrings(warnings)
}

export const errorSummary = (error: SessionActionError): string =>
  error instanceof SessionNotFoundError
    ? `Session ${error.sessionId} was not found.`
    : error.reason

export const successWarnings = (args: {
  readonly step: FlowV2Step
  readonly baseWarnings: ReadonlyArray<string>
  readonly resolvedBy?: SessionActionResult["resolvedBy"]
}): Array<string> => {
  const warnings = [...args.baseWarnings]
  const target = "target" in args.step ? args.step.target : null

  if (
    args.resolvedBy === "semantic"
    && target !== null
    && target.kind === "ref"
    && target.fallback !== null
  ) {
    warnings.push(selectorDriftContractWarning)
  }

  return dedupeStrings(warnings)
}

export const plannedExecutionProfile = (plannedStep: PlannedStep): FlowV2StepResult["executionProfile"] =>
  plannedStep.kind === "fast-single" || plannedStep.kind === "batch-sequence"
    ? "fast"
    : "verified"

export const plannedTransportLane = (plannedStep: PlannedStep): FlowV2StepResult["transportLane"] => {
  if (plannedStep.kind === "batch-sequence") {
    return "runner-batch"
  }

  if (plannedStep.kind !== "fast-single") {
    return "host-single"
  }

  return plannedStep.step.kind === "wait" ? "host-single" : "runner-single"
}

export const classifyFastFailureCode = (reason: string): "session-action-target-not-found" | "session-action-failed" =>
  /\bnot found\b|\bno element\b|\bmissing\b|\bcould not resolve\b/i.test(reason)
    ? "session-action-target-not-found"
    : "session-action-failed"

export const buildFlowStepResult = (args: {
  readonly plannedStep: PlannedStep
  readonly kind: FlowV2StepResult["kind"]
  readonly summary: string
  readonly verdict: SessionFlowResult["verdict"]
  readonly matchedRef: string | null
  readonly latestSnapshotId: string | null
  readonly retryCount: number
  readonly retryReasons: ReadonlyArray<string>
  readonly warnings: Array<string>
  readonly handledMs: number | null
  // PRB-093: every step reports its evidence -- requested policy, actual
  // captures, and their cost. Defaults to an empty report under the
  // canonical default policy for steps that never touch a snapshot
  // (sleep, logMark) or that fail before any capture happens.
  readonly evidence?: EvidenceReport
  readonly sequenceChildFailure?: FlowSequenceChildFailure | null
}): FlowV2StepResult =>
  ({
    index: args.plannedStep.index,
    kind: args.kind,
    summary: args.summary,
    verdict: args.verdict,
    matchedRef: args.matchedRef,
    latestSnapshotId: args.latestSnapshotId,
    retryCount: args.retryCount,
    retryReasons: args.retryReasons,
    artifacts: [] as Array<ArtifactRecord>,
    executionProfile: plannedExecutionProfile(args.plannedStep),
    transportLane: plannedTransportLane(args.plannedStep),
    handledMs: args.handledMs,
    warnings: args.warnings,
    evidence: args.evidence ?? emptyEvidenceReport(resolveEvidencePolicy()),
    sequenceChildFailure: args.sequenceChildFailure ?? null,
  }) satisfies FlowV2StepResult

/**
 * Shared by the direct-runner-action and verified-action lanes: both return
 * an `Effect<ActionExecutionOutcome, SessionActionError>`, and both were
 * folded into `FlowV2StepResult` through this exact three-way branch
 * (dispatch failed / action executor reported failure / action executor
 * succeeded) in the original `runFlow` else-branch.
 */
export const buildActionOutcomeStepResult = (args: {
  readonly plannedStep: PlannedStep
  readonly step: FlowV2Step
  readonly continueOnError: boolean
  readonly latestSnapshotIdBefore: string | null
  readonly outcome: Either.Either<ActionExecutionOutcome, SessionActionError>
}): FlowV2StepResult => {
  const { plannedStep, step, continueOnError, latestSnapshotIdBefore, outcome } = args

  if (outcome._tag === "Left") {
    return buildFlowStepResult({
      plannedStep,
      kind: step.kind,
      summary: errorSummary(outcome.left),
      verdict: failureVerdict(outcome.left),
      matchedRef: null,
      latestSnapshotId: latestSnapshotIdBefore,
      retryCount: 0,
      retryReasons: [],
      handledMs: null,
      warnings: failureWarnings({
        error: outcome.left,
        continued: continueOnError,
      }),
    })
  }

  if (!outcome.right.ok) {
    return buildFlowStepResult({
      plannedStep,
      kind: step.kind,
      summary: errorSummary(outcome.right.error),
      verdict: failureVerdict(outcome.right.error),
      matchedRef: null,
      latestSnapshotId: latestSnapshotIdBefore,
      retryCount: outcome.right.retry.retryCount,
      retryReasons: outcome.right.retry.retryReasons,
      handledMs: null,
      warnings: failureWarnings({
        error: outcome.right.error,
        continued: continueOnError,
      }),
    })
  }

  const actionResult = outcome.right.result

  return buildFlowStepResult({
    plannedStep,
    kind: step.kind,
    summary: actionResult.summary,
    verdict: actionResult.verdict ?? "passed",
    matchedRef: actionResult.matchedRef,
    latestSnapshotId: actionResult.latestSnapshotId,
    retryCount: actionResult.retryCount,
    retryReasons: actionResult.retryReasons,
    handledMs: actionResult.handledMs ?? null,
    evidence: actionResult.evidence,
    warnings: successWarnings({
      step,
      baseWarnings: [],
      resolvedBy: actionResult.resolvedBy,
    }),
  })
}

export const toFailedStep = (step: FlowV2StepResult): FlowV2FailedStep => ({
  index: step.index,
  kind: step.kind,
  summary: step.summary,
  verdict: step.verdict,
  executionProfile: step.executionProfile,
  transportLane: step.transportLane,
  handledMs: step.handledMs,
  evidence: step.evidence,
  sequenceChildFailure: step.sequenceChildFailure,
})

export const mergeVerdict = (
  current: SessionFlowResult["verdict"],
  next: SessionFlowResult["verdict"],
): SessionFlowResult["verdict"] => {
  if (current === "timed-out" || next === "timed-out") {
    return "timed-out"
  }

  if (current === "failed" || next === "failed") {
    return "failed"
  }

  return "passed"
}

export const diffArtifacts = (
  before: ReadonlyArray<ArtifactRecord>,
  after: ReadonlyArray<ArtifactRecord>,
): Array<ArtifactRecord> => {
  const knownKeys = new Set(before.map((artifact) => artifact.key))
  return after.filter((artifact) => !knownKeys.has(artifact.key))
}

/**
 * Folds one more executed step into the running orchestration tally. Mirrors
 * the loop body's bookkeeping that used to sit inline in `runFlow` after
 * each step kind's branch: verdict merge, failed-step capture, and the
 * continue-on-error early-stop decision are the only stateful part of the
 * orchestration loop left after extracting the executors themselves.
 */
export const foldFlowStepOutcome = (args: {
  readonly executedSteps: ReadonlyArray<FlowV2StepResult>
  readonly createdArtifacts: ReadonlyArray<ArtifactRecord>
  readonly overallVerdict: SessionFlowResult["verdict"]
  readonly totalRetries: number
  readonly failedStep: FlowV2FailedStep | null
  readonly stepResult: FlowV2StepResult
  readonly stepArtifacts: ReadonlyArray<ArtifactRecord>
  readonly continueOnError: boolean
}): {
  readonly executedSteps: ReadonlyArray<FlowV2StepResult>
  readonly createdArtifacts: ReadonlyArray<ArtifactRecord>
  readonly overallVerdict: SessionFlowResult["verdict"]
  readonly totalRetries: number
  readonly failedStep: FlowV2FailedStep | null
  readonly stoppedEarly: boolean
} => {
  const stepResult = { ...args.stepResult, artifacts: args.stepArtifacts }
  const executedSteps = [...args.executedSteps, stepResult]
  const createdArtifacts = [...args.createdArtifacts, ...args.stepArtifacts]
  const totalRetries = args.totalRetries + stepResult.retryCount

  if (stepResult.verdict === "passed") {
    return {
      executedSteps,
      createdArtifacts,
      overallVerdict: args.overallVerdict,
      totalRetries,
      failedStep: args.failedStep,
      stoppedEarly: false,
    }
  }

  return {
    executedSteps,
    createdArtifacts,
    overallVerdict: mergeVerdict(args.overallVerdict, stepResult.verdict),
    totalRetries,
    failedStep: toFailedStep(stepResult),
    stoppedEarly: !args.continueOnError,
  }
}

export const assembleFlowResult = (args: {
  readonly sessionId: string
  readonly executedAt: string
  readonly executedSteps: ReadonlyArray<FlowV2StepResult>
  readonly createdArtifacts: ReadonlyArray<ArtifactRecord>
  readonly overallVerdict: SessionFlowResult["verdict"]
  readonly totalRetries: number
  readonly failedStep: FlowV2FailedStep | null
  readonly stoppedEarly: boolean
  readonly finalSnapshotId: string | null
}): FlowV2Result => {
  const dedupedArtifacts = args.createdArtifacts.filter((artifact, index, all) =>
    all.findIndex((candidate) => candidate.key === artifact.key) === index,
  )
  const overallWarnings = dedupeStrings(args.executedSteps.flatMap((step) => step.warnings))
  const failedStepCount = args.executedSteps.filter((step) => step.verdict !== "passed").length
  const summary = args.failedStep === null
    ? `Executed ${args.executedSteps.length} flow step(s) successfully with ${args.totalRetries} retr${args.totalRetries === 1 ? "y" : "ies"}.`
    : args.stoppedEarly
      ? `Flow ${args.overallVerdict === "timed-out" ? "timed out" : "failed"} at step ${args.failedStep.index} after ${args.executedSteps.length} executed step(s) and ${args.totalRetries} retr${args.totalRetries === 1 ? "y" : "ies"}.`
      : `Executed ${args.executedSteps.length} flow step(s) with ${failedStepCount} failed step(s), continuing past failures where continueOnError was enabled.`

  return {
    contract: "probe.session-flow/report-v2",
    executedAt: args.executedAt,
    sessionId: args.sessionId,
    summary,
    verdict: args.overallVerdict,
    executedSteps: [...args.executedSteps],
    failedStep: args.failedStep,
    retries: args.totalRetries,
    artifacts: dedupedArtifacts,
    finalSnapshotId: args.finalSnapshotId,
    warnings: overallWarnings,
  } satisfies FlowV2Result
}
