import { Effect } from "effect"
import type {
  FlowV2LogMarkStep,
  FlowV2ScreenshotStep,
  FlowV2SnapshotStep,
  FlowV2StepResult,
  FlowV2VideoStep,
} from "../../domain/flow-v2"
import type { PlannedStep } from "../../domain/flow-planner"
import type { EnvironmentError } from "../../domain/errors"
import { buildSessionSnapshotResult } from "../../domain/snapshot"
import { normalizeVideoDurationMs } from "../VideoCapturePolicy"
import {
  attemptWithRetry,
  defaultReadOnlyRetryPolicy,
  describeVideoArtifactLabel,
  sanitizeFileComponent,
  timestampForFile,
  type ActiveSessionRecord,
} from "../SessionRegistry"
import type { FlowExecutorDeps } from "./flowExecutorDeps"
import {
  buildFlowStepResult,
  errorSummary,
  failureVerdict,
  failureWarnings,
  successWarnings,
} from "./flowStepResultAssembly"

/**
 * PRB-073: extracted from `runFlow`'s snapshot/screenshot/video/logMark
 * branches. The "evidence capture" lane — the four step kinds that record
 * artifacts or log markers rather than driving the UI. Each function here
 * always resolves to a `FlowV2StepResult` (success or failure folded in),
 * exactly matching the original inline branches; nothing here changes
 * evidence-capture policy itself (that is PRB-093's scope).
 */

export const captureSnapshotEvidenceStep = (args: {
  readonly sessionId: string
  readonly record: ActiveSessionRecord
  readonly plannedStep: PlannedStep
  readonly step: FlowV2SnapshotStep
  readonly continueOnError: boolean
  readonly deps: FlowExecutorDeps
}): Effect.Effect<FlowV2StepResult> =>
  Effect.gen(function* () {
    const { sessionId, record, plannedStep, step, continueOnError, deps } = args
    const captured = yield* attemptWithRetry({
      policy: defaultReadOnlyRetryPolicy,
      run: () => deps.captureSnapshotArtifactInternal(sessionId, record),
    })

    if (captured.ok) {
      const snapshotResult = buildSessionSnapshotResult({
        artifact: captured.value.artifact,
        artifactRecord: captured.value.artifactRecord,
        outputMode: step.output ?? "artifact",
        retry: captured.retry,
      })

      return buildFlowStepResult({
        plannedStep,
        kind: step.kind,
        summary: snapshotResult.summary,
        verdict: "passed",
        matchedRef: null,
        latestSnapshotId: snapshotResult.snapshotId,
        retryCount: captured.retry.retryCount,
        retryReasons: captured.retry.retryReasons,
        handledMs: captured.value.handledMs,
        warnings: successWarnings({
          step,
          baseWarnings: snapshotResult.warnings,
        }),
      })
    }

    return buildFlowStepResult({
      plannedStep,
      kind: step.kind,
      summary: captured.error.reason,
      verdict: failureVerdict(captured.error),
      matchedRef: null,
      latestSnapshotId: record.snapshotState.latest?.snapshotId ?? null,
      retryCount: captured.retry.retryCount,
      retryReasons: captured.retry.retryReasons,
      handledMs: null,
      warnings: failureWarnings({
        error: captured.error,
        continued: continueOnError,
      }),
    })
  })

export const captureScreenshotEvidenceStep = (args: {
  readonly sessionId: string
  readonly record: ActiveSessionRecord
  readonly plannedStep: PlannedStep
  readonly step: FlowV2ScreenshotStep
  readonly continueOnError: boolean
  readonly deps: FlowExecutorDeps
}): Effect.Effect<FlowV2StepResult, EnvironmentError> =>
  Effect.gen(function* () {
    const { sessionId, record, plannedStep, step, continueOnError, deps } = args
    const labelStem = sanitizeFileComponent(step.label ?? null, "screenshot")
    const fileStem = `${timestampForFile()}-${labelStem}`
    const captured = yield* attemptWithRetry({
      policy: step.retryPolicy ?? defaultReadOnlyRetryPolicy,
      run: () => deps.captureScreenshotArtifact({
        sessionId,
        record,
        fileStem,
        artifactKey: `screenshot-${fileStem}`,
        artifactLabel: step.label ?? "screenshot",
        summary: `Screenshot captured for session ${sessionId}.`,
      }),
    })

    if (captured.ok) {
      deps.updateHealthCheck(record, step.kind, true)

      return buildFlowStepResult({
        plannedStep,
        kind: step.kind,
        summary: `Captured screenshot artifact ${captured.value.artifact.absolutePath}.`,
        verdict: "passed",
        matchedRef: null,
        latestSnapshotId: record.snapshotState.latest?.snapshotId ?? null,
        retryCount: captured.retry.retryCount,
        retryReasons: captured.retry.retryReasons,
        handledMs: captured.value.handledMs,
        warnings: successWarnings({
          step,
          baseWarnings: [],
        }),
      })
    }

    deps.updateHealthCheck(record, step.kind, false)
    yield* deps.persistRecordHealth(sessionId, record)

    return buildFlowStepResult({
      plannedStep,
      kind: step.kind,
      summary: captured.error.reason,
      verdict: failureVerdict(captured.error),
      matchedRef: null,
      latestSnapshotId: record.snapshotState.latest?.snapshotId ?? null,
      retryCount: captured.retry.retryCount,
      retryReasons: captured.retry.retryReasons,
      handledMs: null,
      warnings: failureWarnings({
        error: captured.error,
        continued: continueOnError,
      }),
    })
  })

export const captureVideoEvidenceStep = (args: {
  readonly sessionId: string
  readonly record: ActiveSessionRecord
  readonly plannedStep: PlannedStep
  readonly step: FlowV2VideoStep
  readonly continueOnError: boolean
  readonly deps: FlowExecutorDeps
}): Effect.Effect<FlowV2StepResult, EnvironmentError> =>
  Effect.gen(function* () {
    const { sessionId, record, plannedStep, step, continueOnError, deps } = args
    const durationMs = normalizeVideoDurationMs(step.durationMs)
    const fileStem = `${timestampForFile()}-video`
    const captured = yield* Effect.either(deps.captureVideoArtifact({
      sessionId,
      record,
      durationMs,
      fileStem,
      artifactKey: `video-${fileStem}`,
      artifactLabel: "video",
    }))

    if (captured._tag === "Right") {
      deps.updateHealthCheck(record, step.kind, true)
      const modeSummary = describeVideoArtifactLabel(captured.right.mode)
      const clampNote = durationMs !== step.durationMs
        ? ` Requested duration ${step.durationMs}ms was clamped to ${durationMs}ms.`
        : ""

      return buildFlowStepResult({
        plannedStep,
        kind: step.kind,
        summary: `Captured ${modeSummary} at ${captured.right.artifact.absolutePath}.${clampNote}`,
        verdict: "passed",
        matchedRef: null,
        latestSnapshotId: record.snapshotState.latest?.snapshotId ?? null,
        retryCount: 0,
        retryReasons: [],
        handledMs: captured.right.handledMs,
        warnings: successWarnings({
          step,
          baseWarnings: [],
        }),
      })
    }

    deps.updateHealthCheck(record, step.kind, false)
    yield* deps.persistRecordHealth(sessionId, record)

    return buildFlowStepResult({
      plannedStep,
      kind: step.kind,
      summary: captured.left.reason,
      verdict: failureVerdict(captured.left),
      matchedRef: null,
      latestSnapshotId: record.snapshotState.latest?.snapshotId ?? null,
      retryCount: 0,
      retryReasons: [],
      handledMs: null,
      warnings: failureWarnings({
        error: captured.left,
        continued: continueOnError,
      }),
    })
  })

export const markLogEvidenceStep = (args: {
  readonly sessionId: string
  readonly record: ActiveSessionRecord
  readonly plannedStep: PlannedStep
  readonly step: FlowV2LogMarkStep
  readonly continueOnError: boolean
  readonly deps: FlowExecutorDeps
}): Effect.Effect<FlowV2StepResult> =>
  Effect.gen(function* () {
    const { sessionId, record, plannedStep, step, continueOnError, deps } = args
    const marked = yield* Effect.either(deps.markLog({
      sessionId,
      label: step.label,
    }))

    if (marked._tag === "Right") {
      return buildFlowStepResult({
        plannedStep,
        kind: step.kind,
        summary: marked.right.summary,
        verdict: "passed",
        matchedRef: null,
        latestSnapshotId: record.snapshotState.latest?.snapshotId ?? null,
        retryCount: 0,
        retryReasons: [],
        handledMs: null,
        warnings: successWarnings({
          step,
          baseWarnings: [],
        }),
      })
    }

    return buildFlowStepResult({
      plannedStep,
      kind: step.kind,
      summary: errorSummary(marked.left),
      verdict: failureVerdict(marked.left),
      matchedRef: null,
      latestSnapshotId: record.snapshotState.latest?.snapshotId ?? null,
      retryCount: 0,
      retryReasons: [],
      handledMs: null,
      warnings: failureWarnings({
        error: marked.left,
        continued: continueOnError,
      }),
    })
  })
