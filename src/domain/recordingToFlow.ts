/**
 * Convert a recorded action script (`probe.action-recording/script-v1`) into a
 * durable `probe.session-flow/v2` contract for CI re-run via `session run`.
 *
 * Prefer semantic/point fallbacks over ephemeral preferredRef ids when both
 * exist — refs die when the next snapshot renumbers the tree.
 */
import type {
  ActionRecordingScript,
  ActionSelector,
  FlowStep,
  RecordedActionTarget,
  RecordedSessionAction,
} from "./action"
import type { SessionFlowContract } from "./flow-v2"

export class RecordingToFlowError extends Error {
  readonly _tag = "RecordingToFlowError" as const

  constructor(
    readonly reason: string,
    readonly nextStep: string,
    readonly stepIndex?: number,
  ) {
    super(reason)
    this.name = "RecordingToFlowError"
  }
}

const selectorFromRecordedTarget = (
  target: RecordedActionTarget,
  stepIndex: number,
): ActionSelector => {
  // Stable selectors first: semantic / point / ref fallback shapes survive
  // snapshot renumbering better than a bare preferredRef alone.
  if (target.fallback !== null) {
    return target.fallback
  }

  if (target.preferredRef !== null && target.preferredRef.length > 0) {
    return {
      kind: "ref",
      ref: target.preferredRef,
      fallback: null,
    }
  }

  throw new RecordingToFlowError(
    `Recorded step ${stepIndex + 1} has no preferredRef or fallback selector.`,
    "Re-record with a semantic identifier or point target before exporting as a flow.",
    stepIndex,
  )
}

const recordedStepToFlowStep = (
  step: RecordedSessionAction,
  stepIndex: number,
): FlowStep => {
  switch (step.kind) {
    case "tap":
      return {
        kind: "tap",
        target: selectorFromRecordedTarget(step.target, stepIndex),
      }
    case "multiTap":
      return {
        kind: "multiTap",
        target: selectorFromRecordedTarget(step.target, stepIndex),
        tapCount: step.tapCount,
        interTapDelayMs: step.interTapDelayMs,
      }
    case "press":
      return {
        kind: "press",
        target: selectorFromRecordedTarget(step.target, stepIndex),
        durationMs: step.durationMs,
      }
    case "swipe":
      return {
        kind: "swipe",
        target: selectorFromRecordedTarget(step.target, stepIndex),
        direction: step.direction,
      }
    case "type":
      return {
        kind: "type",
        target: selectorFromRecordedTarget(step.target, stepIndex),
        text: step.text,
        replace: step.replace,
      }
    case "scroll":
      return {
        kind: "scroll",
        target: selectorFromRecordedTarget(step.target, stepIndex),
        direction: step.direction,
        steps: step.steps,
      }
    case "assert":
      return {
        kind: "assert",
        target: selectorFromRecordedTarget(step.target, stepIndex),
        expectation: step.expectation,
      }
    case "wait": {
      if (step.condition === "duration") {
        return {
          kind: "wait",
          target: null,
          timeoutMs: step.timeoutMs,
          condition: "duration",
          text: null,
        }
      }

      if (step.target === null) {
        throw new RecordingToFlowError(
          `Recorded wait step ${stepIndex + 1} (${step.condition}) has no target.`,
          "Re-record the wait with a semantic selector, or use condition duration.",
          stepIndex,
        )
      }

      return {
        kind: "wait",
        target: selectorFromRecordedTarget(step.target, stepIndex),
        timeoutMs: step.timeoutMs,
        condition: step.condition,
        text: step.text,
      }
    }
    case "screenshot":
      return {
        kind: "screenshot",
      }
    case "video":
      return {
        kind: "video",
        durationMs: step.durationMs,
      }
    default: {
      const _exhaustive: never = step
      throw new RecordingToFlowError(
        `Unsupported recorded step kind at index ${stepIndex + 1}.`,
        "Export as script-v1 and replay via session replay, or edit the recording.",
        stepIndex,
      )
    }
  }
}

/**
 * Pure conversion. Throws `RecordingToFlowError` on steps that cannot become
 * a flow (empty script, missing selectors). Does not mutate the script.
 */
export const recordingScriptToFlowV2 = (
  script: ActionRecordingScript,
): SessionFlowContract => {
  if (script.steps.length === 0) {
    throw new RecordingToFlowError(
      "Recording script has no steps to convert.",
      "Execute session actions before exporting as a flow.",
    )
  }

  const steps = script.steps.map((step, index) => recordedStepToFlowStep(step, index))

  // Agent-friendly default: fast mutations with sparse evidence; callers who
  // need post-step proof should insert an assert or set evidencePolicy end.
  return {
    contract: "probe.session-flow/v2",
    steps: steps.map((step) => {
      if (
        step.kind === "tap"
        || step.kind === "multiTap"
        || step.kind === "press"
        || step.kind === "swipe"
        || step.kind === "type"
        || step.kind === "scroll"
      ) {
        return {
          ...step,
          execution: "fast" as const,
          evidencePolicy: { success: "none" as const, failure: "snapshot" as const },
        }
      }
      return step
    }),
  }
}
