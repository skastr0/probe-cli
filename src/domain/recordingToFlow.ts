/**
 * Convert a recorded action script (`probe.action-recording/script-v1`) into a
 * durable `probe.session-flow/v2` contract for CI re-run via `session run`.
 *
 * Prefer semantic/point fallbacks over ephemeral preferredRef ids when both
 * exist — refs die when the next snapshot renumbers the tree.
 *
 * CI stability gate: mutation/assert targets must be runner-resolvable without
 * a host snapshot (semantic, point, or ref+semantic/point fallback). Bare
 * preferredRef-only steps fail closed at export rather than stamp
 * execution:fast and blow up later on session run.
 */
import type {
  ActionRecordingScript,
  ActionSelector,
  FlowStep,
  RecordedActionTarget,
  RecordedSessionAction,
} from "./action"
import { defaultAgentMutationEvidencePolicy } from "./evidence"
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

/** Selectors that fast/sequence lanes can resolve without a host AX tree. */
const isCiStableSelector = (selector: ActionSelector): boolean => {
  if (selector.kind === "semantic" || selector.kind === "point") {
    return true
  }
  if (selector.kind === "ref") {
    const fallback = selector.fallback
    return fallback !== null && (fallback.kind === "semantic" || fallback.kind === "point")
  }
  return false
}

const selectorFromRecordedTarget = (
  target: RecordedActionTarget,
  stepIndex: number,
): ActionSelector => {
  // Stable selectors first: semantic / point survive snapshot renumbering.
  if (target.fallback !== null) {
    if (!isCiStableSelector(target.fallback) && target.fallback.kind === "ref") {
      // Nested bare ref is as unstable as preferredRef-only.
      throw new RecordingToFlowError(
        `Recorded step ${stepIndex + 1} fallback is a bare ref without a semantic/point nested fallback.`,
        "Re-record with a semantic identifier (or point) before exporting as flow-v2 for CI.",
        stepIndex,
      )
    }
    if (isCiStableSelector(target.fallback)) {
      return target.fallback
    }
  }

  if (target.preferredRef !== null && target.preferredRef.length > 0) {
    throw new RecordingToFlowError(
      `Recorded step ${stepIndex + 1} only has preferredRef "${target.preferredRef}" — not CI-stable for fast session-flow export.`,
      "Re-record using semantic identifiers (snapshot → identifier), then export --format flow-v2. Or export --format script and session replay while the tree still matches.",
      stepIndex,
    )
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
 * a CI-stable flow (empty script, missing/unstable selectors). Does not mutate
 * the script.
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

  // Agent-friendly default: fast mutations with sparse evidence (same constant
  // as CLI fly paths). Callers who need post-step proof insert assert or set
  // evidencePolicy end on the flow.
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
          evidencePolicy: defaultAgentMutationEvidencePolicy,
        }
      }
      return step
    }),
  }
}
