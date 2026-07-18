import { Effect } from "effect"
import {
  buildDirectRunnerUiActionPayload,
  describeActionSelector,
  isRunnerUiSessionAction,
} from "../../domain/action"
import { EnvironmentError, type UnsupportedCapabilityError } from "../../domain/errors"
import {
  buildEvidenceReport,
  emptyEvidenceReport,
  planSuccessEvidence,
  resolveEvidencePolicy,
  shouldCaptureFailureEvidence,
  type EvidenceCapture,
} from "../../domain/evidence"
import { flowV2StepToSessionAction, type FlowV2FastSingleStep } from "../../domain/flow-v2"
import {
  advertisedRunnerCapabilities,
  requireRunnerCapability,
} from "../runnerCapabilities"
import {
  attemptWithRetry,
  buildActionResultMetadata,
  defaultMutationRetryPolicy,
  emptyRetryAttemptMetadata,
  isRunnerBackedRecord,
  withOffscreenNextStep,
  type ActionExecutionOutcome,
  type ActiveSessionRecord,
  type ExtendedSessionActionResult,
} from "../sessionShared"
import { classifyFastFailureCode } from "./flowStepResultAssembly"
import type { FlowExecutorDeps } from "./flowExecutorDeps"

/**
 * PRB-073: extracted from `runFlow`'s `executeFastSingleStep` closure. The
 * "direct runner action" lane — a fast single tap/press/swipe/type/scroll or
 * a duration wait, dispatched straight to the runner without a host
 * resolution snapshot (targets are point or on-device-resolvable; see
 * isRunnerResolvableActionSelector). Takes the flow step, the session id,
 * and the session record as explicit immutable-shaped inputs (no JS closure
 * over `runFlow`'s locals) plus a `FlowExecutorDeps` port bag for the
 * SessionRegistry-layer calls it still needs.
 *
 * PRB-093: this lane used to always capture zero snapshots on success and
 * one (unconditionally) on failure — one of the three inconsistent
 * behaviors this glyph replaces with the canonical evidence policy
 * (evidence.ts). It now asks the same success/failure policy every other
 * mutation-capable lane asks; a pre capture only ever happens for "around"
 * (pure evidence, never resolution, since this lane needs no host
 * resolution snapshot at all).
 */
export const executeDirectRunnerActionStep = (args: {
  readonly sessionId: string
  readonly record: ActiveSessionRecord
  readonly step: FlowV2FastSingleStep
  readonly deps: FlowExecutorDeps
}): Effect.Effect<ActionExecutionOutcome, EnvironmentError | UnsupportedCapabilityError> =>
  Effect.gen(function* () {
    const { sessionId, record, step, deps } = args

    const runnerRecord = yield* requireRunnerCapability({
      record,
      isRunnerBacked: isRunnerBackedRecord,
      advertised: (activeRecord) => advertisedRunnerCapabilities(activeRecord.health.runner),
      capability: "uiAction",
      capabilityTag: "session.run.fast",
      usageDescription: "fast single-step flow execution",
      notRunnerBacked: {
        code: "session-action-real-device-runner",
        reason: "This session does not currently expose a live runner transport for fast flow actions.",
        nextStep: "Inspect session health/artifacts, or reopen the session once the runner transport is live.",
      },
      missingCapabilityNextStep: "Open a session against a runner that reports uiAction capability, or switch the flow step back to verified execution.",
    })

    if (step.kind === "wait") {
      yield* Effect.sleep(step.timeoutMs)
      deps.updateHealthCheck(record, step.kind, true)
      yield* deps.persistHealth(sessionId, record.health)
      yield* deps.syncDaemonMetadata

      return {
        ok: true as const,
        result: {
          summary: `Waited ${step.timeoutMs}ms before continuing.`,
          action: step.kind,
          matchedRef: null,
          resolvedBy: "none",
          statusLabel: record.snapshotState.latest?.statusLabel ?? null,
          latestSnapshotId: record.snapshotState.latest?.snapshotId ?? null,
          artifact: null,
          recordingLength: record.recording.steps.length,
          handledMs: null,
          // Duration waits never touch a snapshot.
          evidence: emptyEvidenceReport(resolveEvidencePolicy()),
          ...buildActionResultMetadata(emptyRetryAttemptMetadata(), "passed", step.timeoutMs, 1),
        } satisfies ExtendedSessionActionResult,
      } satisfies ActionExecutionOutcome
    }

    const action = flowV2StepToSessionAction(step)

    if (!isRunnerUiSessionAction(action)) {
      return yield* new EnvironmentError({
        code: "session-action-invalid",
        reason: `Fast runner execution only supports tap, press, swipe, type, scroll, and duration waits; received ${step.kind}.`,
        nextStep: "Use verified execution for unsupported steps, or adjust the flow contract before retrying.",
        details: [],
      })
    }

    const policy = resolveEvidencePolicy(action.evidencePolicy)
    const successPlan = planSuccessEvidence(policy.success)
    const evidenceCaptures: Array<EvidenceCapture> = []

    // "around" is the only policy this lane ever pays a pre-dispatch
    // capture for -- captured once, before the retry loop, so retries never
    // multiply it.
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

    const resolvedBy: ExtendedSessionActionResult["resolvedBy"] = step.target.kind === "point" ? "point" : "semantic"
    const actionResult = yield* attemptWithRetry({
      policy: action.retryPolicy ?? defaultMutationRetryPolicy,
      run: () =>
        Effect.gen(function* () {
          const payload = yield* Effect.try({
            try: () => buildDirectRunnerUiActionPayload(action, step.target),
            catch: (error) =>
              new EnvironmentError({
                code: "session-action-target-not-found",
                reason: error instanceof Error ? error.message : String(error),
                nextStep: "Use a semantic selector, point selector, or ref selector with a semantic fallback for fast runner steps.",
                details: [],
              }),
          })

          const response = yield* deps.sendRunnerCommand(
            sessionId,
            runnerRecord,
            "uiAction",
            JSON.stringify(payload),
          )

          if (!response.ok) {
            const failureReason = response.error
              ?? response.payload
              ?? `Runner ${action.kind} failed with status ${response.statusLabel}.`

            return yield* new EnvironmentError({
              code: classifyFastFailureCode(failureReason),
              reason: failureReason,
              nextStep: withOffscreenNextStep(
                "Inspect the latest runner log artifacts, refine the direct selector, and retry the fast step.",
                failureReason,
              ),
              details: [],
            })
          }

          return { response }
        }),
    })

    if (!actionResult.ok) {
      // Best-effort, additive only -- never replaces the original mutation
      // failure below. A successful capture is still reported through
      // `evidence` rather than silently discarded (PRB-093 review finding).
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

      yield* deps.persistActionFailure(sessionId, record, step.kind)

      return {
        ok: false,
        error: actionResult.error,
        retry: actionResult.retry,
        evidence: buildEvidenceReport(policy, evidenceCaptures),
      } satisfies ActionExecutionOutcome
    }

    deps.updateHealthCheck(record, step.kind, true)
    yield* deps.persistHealth(sessionId, record.health)
    yield* deps.syncDaemonMetadata

    if (successPlan.needsPost) {
      const postCapture = yield* Effect.either(deps.captureSnapshotArtifactInternal(sessionId, record))

      if (postCapture._tag === "Right") {
        evidenceCaptures.push({
          reason: "policy-post",
          phase: "post",
          snapshotId: postCapture.right.artifact.snapshotId,
          ms: postCapture.right.handledMs,
        })
      }
    }

    const latestSnapshotId = evidenceCaptures.length > 0
      ? evidenceCaptures[evidenceCaptures.length - 1]!.snapshotId
      : record.snapshotState.latest?.snapshotId ?? null
    const captureNote = evidenceCaptures.length > 0
      ? `; captured ${latestSnapshotId}`
      : " without host snapshots"

    const summary = step.target.kind === "point"
      ? `Executed fast ${step.kind} at point(${step.target.x}, ${step.target.y})${captureNote}.`
      : `Executed fast ${step.kind} on ${describeActionSelector(step.target)}${captureNote}.`

    return {
      ok: true,
      result: {
        summary,
        action: step.kind,
        matchedRef: null,
        resolvedBy,
        statusLabel: actionResult.value.response.statusLabel,
        latestSnapshotId,
        artifact: null,
        recordingLength: record.recording.steps.length,
        handledMs: actionResult.value.response.handledMs,
        resolutionMs: actionResult.value.response.resolutionMs ?? null,
        waitMs: actionResult.value.response.waitMs ?? null,
        interactionMs: actionResult.value.response.interactionMs ?? null,
        finalizationMs: actionResult.value.response.finalizationMs ?? null,
        evidence: buildEvidenceReport(policy, evidenceCaptures),
        ...buildActionResultMetadata(actionResult.retry),
      } satisfies ExtendedSessionActionResult,
    } satisfies ActionExecutionOutcome
  })
