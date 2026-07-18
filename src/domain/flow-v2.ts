import { Schema } from "effect"
import {
  ActionDirection,
  ActionSelectorSchema,
  ActionVerdict,
  FlowAssertStepSchema,
  FlowFailedStepSchema,
  FlowLogMarkStepSchema,
  FlowMultiTapStepSchema,
  FlowScreenshotStepSchema,
  FlowSleepStepSchema,
  FlowSnapshotStepSchema,
  FlowStepResultSchema,
  FlowTapStepSchema,
  FlowPressStepSchema,
  FlowScrollStepSchema,
  FlowSwipeStepSchema,
  FlowTypeStepSchema,
  FlowVideoStepSchema,
  FlowWaitStepSchema,
  flowStepToSessionAction,
  isFlowSessionActionStep,
  MultiTapCountSchema,
  MultiTapInterTapDelayMsSchema,
  type ActionSelector,
  type FlowSessionActionStep,
  type FlowStep,
  type SessionAction,
  validateFlowStep,
  validateSessionAction,
} from "./action"
import { EvidencePolicyInputSchema, EvidenceReportSchema } from "./evidence"
import { ArtifactRecord, NullableString } from "./output"
import { UnsupportedFlowContractError } from "./errors"

const NullableNumber = Schema.Union(Schema.Number, Schema.Null)
const PositiveIntegerSchema = Schema.Number.pipe(Schema.int(), Schema.greaterThan(0))
const OptionalExecutionProfile = Schema.optional(Schema.Literal("verified", "fast"))

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null

const normalizeActionSelectorInput = (value: unknown): unknown => {
  if (!isRecord(value)) {
    return value
  }

  if (value.kind === "absence") {
    return {
      ...value,
      negate: normalizeActionSelectorInput(value.negate ?? value.selector),
    }
  }

  if (value.kind === "ref") {
    return {
      ...value,
      fallback: normalizeActionSelectorInput(value.fallback ?? null),
    }
  }

  return value
}

const normalizeActionLikeInput = (value: unknown): unknown => {
  if (!isRecord(value)) {
    return value
  }

  if (
    value.kind === "tap"
    || value.kind === "multiTap"
    || value.kind === "press"
    || value.kind === "swipe"
    || value.kind === "type"
    || value.kind === "scroll"
  ) {
    return {
      ...value,
      target: normalizeActionSelectorInput(value.target ?? value.selector),
    }
  }

  if (value.kind === "assert") {
    const expectation = isRecord(value.expectation)
      ? value.expectation
      : {}

    return {
      ...value,
      target: normalizeActionSelectorInput(value.target ?? value.selector),
      expectation,
    }
  }

  if (value.kind === "wait") {
    const hasTarget = value.target !== undefined || value.selector !== undefined

    return {
      ...value,
      target: normalizeActionSelectorInput(value.target ?? value.selector ?? null),
      condition: value.condition ?? (hasTarget ? "match" : "duration"),
      text: value.text ?? null,
    }
  }

  if (value.kind === "screenshot") {
    return {
      ...value,
      label: value.label ?? null,
    }
  }

  return value
}

const normalizeFlowSequenceActionInput = (value: unknown): unknown => normalizeActionLikeInput(value)

const normalizeFlowV2StepInput = (value: unknown): unknown => {
  if (!isRecord(value)) {
    return value
  }

  if (value.kind === "sequence") {
    return {
      ...value,
      actions: Array.isArray(value.actions)
        ? value.actions.map((action) => normalizeFlowSequenceActionInput(action))
        : value.actions,
    }
  }

  return normalizeActionLikeInput(value)
}

const normalizeFlowV2ContractInput = (value: unknown): unknown => {
  if (!isRecord(value)) {
    return value
  }

  return {
    ...value,
    steps: Array.isArray(value.steps)
      ? value.steps.map((step) => normalizeFlowV2StepInput(step))
      : value.steps,
  }
}

export const FlowExecutionProfileSchema = Schema.Literal("verified", "fast")
export type FlowExecutionProfile = typeof FlowExecutionProfileSchema.Type

export const FlowTransportLaneSchema = Schema.Literal("host-single", "runner-single", "runner-batch")
export type FlowTransportLane = typeof FlowTransportLaneSchema.Type

export const FlowSequenceActionKindSchema = Schema.Literal("tap", "multiTap", "press", "swipe", "type", "scroll", "wait")
export type FlowSequenceActionKind = typeof FlowSequenceActionKindSchema.Type

export const FlowV2StepKindSchema = Schema.Literal(
  "snapshot",
  "tap",
  "multiTap",
  "press",
  "swipe",
  "type",
  "scroll",
  "wait",
  "assert",
  "screenshot",
  "video",
  "logMark",
  "sleep",
  "sequence",
)
export type FlowV2StepKind = typeof FlowV2StepKindSchema.Type

export const FlowSequenceTapActionSchema = Schema.Struct({
  kind: Schema.Literal("tap"),
  target: ActionSelectorSchema,
})
export type FlowSequenceTapAction = typeof FlowSequenceTapActionSchema.Type

// PRB-092: same tapCount/interTapDelayMs bounds as MultiTapActionSchema
// (action.ts) — the batch-child and direct-action shapes of multiTap share
// one declared bound so they can never drift apart.
export const FlowSequenceMultiTapActionSchema = Schema.Struct({
  kind: Schema.Literal("multiTap"),
  target: ActionSelectorSchema,
  tapCount: MultiTapCountSchema,
  interTapDelayMs: MultiTapInterTapDelayMsSchema,
})
export type FlowSequenceMultiTapAction = typeof FlowSequenceMultiTapActionSchema.Type

export const FlowSequencePressActionSchema = Schema.Struct({
  kind: Schema.Literal("press"),
  target: ActionSelectorSchema,
  durationMs: Schema.Number,
})
export type FlowSequencePressAction = typeof FlowSequencePressActionSchema.Type

export const FlowSequenceSwipeActionSchema = Schema.Struct({
  kind: Schema.Literal("swipe"),
  target: ActionSelectorSchema,
  direction: ActionDirection,
})
export type FlowSequenceSwipeAction = typeof FlowSequenceSwipeActionSchema.Type

export const FlowSequenceTypeActionSchema = Schema.Struct({
  kind: Schema.Literal("type"),
  target: ActionSelectorSchema,
  text: Schema.String,
  replace: Schema.Boolean,
})
export type FlowSequenceTypeAction = typeof FlowSequenceTypeActionSchema.Type

export const FlowSequenceScrollActionSchema = Schema.Struct({
  kind: Schema.Literal("scroll"),
  target: ActionSelectorSchema,
  direction: ActionDirection,
  steps: Schema.Number,
})
export type FlowSequenceScrollAction = typeof FlowSequenceScrollActionSchema.Type

export const FlowSequenceWaitActionSchema = Schema.Struct({
  kind: Schema.Literal("wait"),
  target: Schema.Null,
  timeoutMs: Schema.Number,
  condition: Schema.Literal("duration"),
  text: Schema.Null,
})
export type FlowSequenceWaitAction = typeof FlowSequenceWaitActionSchema.Type

export const FlowSequenceActionSchema = Schema.Union(
  FlowSequenceTapActionSchema,
  FlowSequenceMultiTapActionSchema,
  FlowSequencePressActionSchema,
  FlowSequenceSwipeActionSchema,
  FlowSequenceTypeActionSchema,
  FlowSequenceScrollActionSchema,
  FlowSequenceWaitActionSchema,
)
export type FlowSequenceAction = typeof FlowSequenceActionSchema.Type

export const FlowV2SnapshotStepSchema = Schema.Struct({
  ...FlowSnapshotStepSchema.fields,
  execution: OptionalExecutionProfile,
})
export type FlowV2SnapshotStep = typeof FlowV2SnapshotStepSchema.Type

export const FlowV2TapStepSchema = Schema.Struct({
  ...FlowTapStepSchema.fields,
  execution: OptionalExecutionProfile,
})
export type FlowV2TapStep = typeof FlowV2TapStepSchema.Type

export const FlowV2MultiTapStepSchema = Schema.Struct({
  ...FlowMultiTapStepSchema.fields,
  execution: OptionalExecutionProfile,
})
export type FlowV2MultiTapStep = typeof FlowV2MultiTapStepSchema.Type

export const FlowV2PressStepSchema = Schema.Struct({
  ...FlowPressStepSchema.fields,
  execution: OptionalExecutionProfile,
})
export type FlowV2PressStep = typeof FlowV2PressStepSchema.Type

export const FlowV2SwipeStepSchema = Schema.Struct({
  ...FlowSwipeStepSchema.fields,
  execution: OptionalExecutionProfile,
})
export type FlowV2SwipeStep = typeof FlowV2SwipeStepSchema.Type

export const FlowV2TypeStepSchema = Schema.Struct({
  ...FlowTypeStepSchema.fields,
  execution: OptionalExecutionProfile,
})
export type FlowV2TypeStep = typeof FlowV2TypeStepSchema.Type

export const FlowV2ScrollStepSchema = Schema.Struct({
  ...FlowScrollStepSchema.fields,
  execution: OptionalExecutionProfile,
})
export type FlowV2ScrollStep = typeof FlowV2ScrollStepSchema.Type

export const FlowV2WaitStepSchema = Schema.Struct({
  ...FlowWaitStepSchema.fields,
  execution: OptionalExecutionProfile,
})
export type FlowV2WaitStep = typeof FlowV2WaitStepSchema.Type

export const FlowV2AssertStepSchema = Schema.Struct({
  ...FlowAssertStepSchema.fields,
  execution: OptionalExecutionProfile,
})
export type FlowV2AssertStep = typeof FlowV2AssertStepSchema.Type

export const FlowV2ScreenshotStepSchema = Schema.Struct({
  ...FlowScreenshotStepSchema.fields,
  execution: OptionalExecutionProfile,
})
export type FlowV2ScreenshotStep = typeof FlowV2ScreenshotStepSchema.Type

export const FlowV2VideoStepSchema = Schema.Struct({
  ...FlowVideoStepSchema.fields,
  execution: OptionalExecutionProfile,
})
export type FlowV2VideoStep = typeof FlowV2VideoStepSchema.Type

export const FlowV2LogMarkStepSchema = Schema.Struct({
  ...FlowLogMarkStepSchema.fields,
  execution: OptionalExecutionProfile,
})
export type FlowV2LogMarkStep = typeof FlowV2LogMarkStepSchema.Type

export const FlowV2SleepStepSchema = Schema.Struct({
  ...FlowSleepStepSchema.fields,
  execution: OptionalExecutionProfile,
})
export type FlowV2SleepStep = typeof FlowV2SleepStepSchema.Type

export const FlowSequenceStepSchema = Schema.Struct({
  kind: Schema.Literal("sequence"),
  actions: Schema.Array(FlowSequenceActionSchema),
  execution: OptionalExecutionProfile,
  // PRB-093: replaces the sequence-only "none"/"end" checkpoint vocabulary
  // with the same canonical evidence policy every other mutation-capable
  // step carries (see evidence.ts). Omitted, it resolves to the same
  // default (success=end, failure=snapshot) -- one post-batch snapshot,
  // regardless of child count.
  evidencePolicy: Schema.optional(EvidencePolicyInputSchema),
  continueOnError: Schema.optional(Schema.Boolean),
}).annotations({
  // PRB-103: a stale caller still sending the pre-PRB-093 `checkpoint`
  // field (see above) would otherwise decode silently -- Schema.Struct's
  // default `onExcessProperty: "ignore"` drops unknown keys rather than
  // rejecting them, so `checkpoint: "none"` would vanish and the step would
  // silently fall back to the *default* evidence policy (success="end"),
  // which is not what a caller asking for "none" meant. Consistent with
  // PRB-082's rejection idiom (a superseded shape fails closed with a typed
  // decode error instead of silently adapting through), `onExcessProperty:
  // "error"` is scoped to just this one step kind -- the step shape that
  // actually changed vocabulary -- rather than a project-wide strict-decode
  // policy that would risk rejecting unrelated, still-tolerated extra
  // fields elsewhere in the flow contract.
  parseOptions: { onExcessProperty: "error" },
})
export type FlowSequenceStep = typeof FlowSequenceStepSchema.Type

export const FlowV2SessionActionStepSchema = Schema.Union(
  FlowV2TapStepSchema,
  FlowV2MultiTapStepSchema,
  FlowV2PressStepSchema,
  FlowV2SwipeStepSchema,
  FlowV2TypeStepSchema,
  FlowV2ScrollStepSchema,
  FlowV2WaitStepSchema,
  FlowV2AssertStepSchema,
  FlowV2ScreenshotStepSchema,
  FlowV2VideoStepSchema,
)
export type FlowV2SessionActionStep = typeof FlowV2SessionActionStepSchema.Type

export const FlowV2StepSchema = Schema.Union(
  FlowV2SnapshotStepSchema,
  FlowV2SessionActionStepSchema,
  FlowV2LogMarkStepSchema,
  FlowV2SleepStepSchema,
  FlowSequenceStepSchema,
)
export type FlowV2Step = typeof FlowV2StepSchema.Type

export type FlowV2NonSequenceStep = Exclude<FlowV2Step, FlowSequenceStep>
export type FlowV2FastSingleStep = FlowV2TapStep | FlowV2MultiTapStep | FlowV2PressStep | FlowV2SwipeStep | FlowV2TypeStep | FlowV2ScrollStep | FlowV2WaitStep

export const FlowV2ContractSchema = Schema.Struct({
  contract: Schema.Literal("probe.session-flow/v2"),
  execution: OptionalExecutionProfile,
  steps: Schema.Array(FlowV2StepSchema),
})
export type FlowV2Contract = typeof FlowV2ContractSchema.Type

export const FlowSequenceChildFailureSchema = Schema.Struct({
  index: PositiveIntegerSchema,
  kind: FlowSequenceActionKindSchema,
  summary: Schema.String,
})
export type FlowSequenceChildFailure = typeof FlowSequenceChildFailureSchema.Type

export const FlowV2StepResultSchema = Schema.Struct({
  ...FlowStepResultSchema.fields,
  kind: FlowV2StepKindSchema,
  executionProfile: FlowExecutionProfileSchema,
  transportLane: FlowTransportLaneSchema,
  handledMs: NullableNumber,
  // PRB-093: replaces the "none"/"end" checkpoint field -- every step now
  // reports the same canonical evidence report (requested policy, actual
  // captures with reasons/snapshot IDs, and total evidence milliseconds).
  evidence: EvidenceReportSchema,
  sequenceChildFailure: Schema.Union(FlowSequenceChildFailureSchema, Schema.Null),
})
export type FlowV2StepResult = typeof FlowV2StepResultSchema.Type

export const FlowV2FailedStepSchema = Schema.Struct({
  ...FlowFailedStepSchema.fields,
  kind: FlowV2StepKindSchema,
  executionProfile: FlowExecutionProfileSchema,
  transportLane: FlowTransportLaneSchema,
  handledMs: NullableNumber,
  evidence: EvidenceReportSchema,
  sequenceChildFailure: Schema.Union(FlowSequenceChildFailureSchema, Schema.Null),
})
export type FlowV2FailedStep = typeof FlowV2FailedStepSchema.Type

export const FlowV2ResultSchema = Schema.Struct({
  contract: Schema.Literal("probe.session-flow/report-v2"),
  executedAt: Schema.String,
  sessionId: Schema.String,
  summary: Schema.String,
  verdict: ActionVerdict,
  executedSteps: Schema.Array(FlowV2StepResultSchema),
  failedStep: Schema.Union(FlowV2FailedStepSchema, Schema.Null),
  retries: Schema.Number,
  artifacts: Schema.Array(ArtifactRecord),
  finalSnapshotId: NullableString,
  warnings: Schema.Array(Schema.String),
})
export type FlowV2Result = typeof FlowV2ResultSchema.Type

// The session-flow contract and its result carry a single canonical version.
// probe.session-flow/v1 and its report-v1 counterpart were removed in PRB-082;
// these names stay stable for callers while resolving to the v2 shape only.
export const SessionFlowContractSchema = FlowV2ContractSchema
export type SessionFlowContract = typeof SessionFlowContractSchema.Type

export const SessionFlowResultSchema = FlowV2ResultSchema
export type SessionFlowResult = typeof SessionFlowResultSchema.Type

export const resolveFlowExecutionProfile = (
  flowExecution?: FlowExecutionProfile,
  stepExecution?: FlowExecutionProfile,
): FlowExecutionProfile => stepExecution ?? flowExecution ?? "verified"

export const isFlowSequenceStep = (step: FlowV2Step): step is FlowSequenceStep =>
  step.kind === "sequence"

export const isFlowV2SessionActionStep = (step: FlowV2Step): step is FlowV2SessionActionStep =>
  step.kind === "tap"
  || step.kind === "multiTap"
  || step.kind === "press"
  || step.kind === "swipe"
  || step.kind === "type"
  || step.kind === "scroll"
  || step.kind === "wait"
  || step.kind === "assert"
  || step.kind === "screenshot"
  || step.kind === "video"

export const isRunnerResolvableActionSelector = (selector: ActionSelector): boolean =>
  selector.kind === "semantic"
  || selector.kind === "point"
  || (selector.kind === "ref" && selector.fallback !== null)

export const isDurationOnlyFlowWaitStep = (step: FlowV2WaitStep): boolean =>
  step.condition === "duration" && step.target === null

export const isDurationOnlySequenceWaitAction = (action: FlowSequenceAction): action is FlowSequenceWaitAction =>
  action.kind === "wait"
  && action.condition === "duration"
  && action.target === null

export const isFastSingleFlowV2Step = (step: FlowV2Step): step is FlowV2FastSingleStep => {
  switch (step.kind) {
    case "tap":
    case "multiTap":
    case "press":
    case "swipe":
    case "type":
    case "scroll":
      return true
    case "wait":
      return isDurationOnlyFlowWaitStep(step)
    default:
      return false
  }
}

export const flowV2StepToFlowStep = (step: FlowV2NonSequenceStep): FlowStep => {
  const { execution: _execution, ...flowStep } = step
  return flowStep as FlowStep
}

export const flowV2StepToSessionAction = (step: FlowV2SessionActionStep): SessionAction => {
  const flowStep = flowV2StepToFlowStep(step)

  if (!isFlowSessionActionStep(flowStep)) {
    throw new Error(`Expected a flow session-action step, received ${flowStep.kind}.`)
  }

  return flowStepToSessionAction(flowStep)
}

const validateSequenceAction = (action: FlowSequenceAction): string | null => {
  const validationError = validateSessionAction(action as SessionAction)

  if (validationError !== null) {
    return validationError
  }

  if (action.kind === "wait") {
    return isDurationOnlySequenceWaitAction(action)
      ? null
      : "Sequence wait actions must be duration-only waits with no target."
  }

  return isRunnerResolvableActionSelector(action.target)
    ? null
    : "Fast or batched actions require a runner-resolvable target: semantic, point, or ref with semantic fallback."
}

const validateFastExecutionStep = (step: FlowV2Step, effectiveExecution: FlowExecutionProfile): string | null => {
  if (step.kind === "sequence") {
    if (effectiveExecution !== "fast") {
      return "Sequence steps require fast execution because they target the runner batch lane."
    }

    if (step.actions.length === 0) {
      return "Sequence steps require at least one child action."
    }

    for (const [index, action] of step.actions.entries()) {
      const validationError = validateSequenceAction(action)

      if (validationError !== null) {
        return `Sequence child ${index + 1}: ${validationError}`
      }
    }

    return null
  }

  if (effectiveExecution !== "fast") {
    return null
  }

  if (isFastSingleFlowV2Step(step)) {
    if (step.kind === "wait") {
      return isDurationOnlyFlowWaitStep(step)
        ? null
        : "Fast wait steps must be duration-only waits with no target."
    }

    return isRunnerResolvableActionSelector(step.target)
      ? null
      : "Fast or batched actions require a runner-resolvable target: semantic, point, or ref with semantic fallback."
  }

  return `${step.kind} steps do not support fast execution. Use verified execution instead.`
}

export const validateFlowV2Step = (
  step: FlowV2Step,
  flowExecution?: FlowExecutionProfile,
): string | null => {
  if (step.kind === "sequence") {
    return validateFastExecutionStep(step, resolveFlowExecutionProfile(flowExecution, step.execution))
  }

  const baseValidationError = validateFlowStep(flowV2StepToFlowStep(step))

  if (baseValidationError !== null) {
    return baseValidationError
  }

  return validateFastExecutionStep(step, resolveFlowExecutionProfile(flowExecution, step.execution))
}

export const validateFlowV2Contract = (flow: FlowV2Contract): string | null => {
  if (flow.steps.length === 0) {
    return "Flow contracts require at least one step."
  }

  for (const [index, step] of flow.steps.entries()) {
    const validationError = validateFlowV2Step(step, flow.execution)

    if (validationError !== null) {
      return `Step ${index + 1}: ${validationError}`
    }
  }

  return null
}

export const validateSessionFlowContract = (flow: SessionFlowContract): string | null =>
  validateFlowV2Contract(flow)

export const decodeFlowV2Contract = (value: unknown): FlowV2Contract =>
  Schema.decodeUnknownSync(FlowV2ContractSchema)(normalizeFlowV2ContractInput(value))

// probe.session-flow/v1 was removed in PRB-082 (2026-07-11 architecture review:
// canonical flow consolidation). Old v1 input fails closed with a typed error
// instead of silently decoding through a compatibility adapter.
export const decodeSessionFlowContract = (value: unknown): SessionFlowContract => {
  if (isRecord(value) && value.contract === "probe.session-flow/v1") {
    throw new UnsupportedFlowContractError({
      code: "unsupported-flow-contract",
      contract: "probe.session-flow/v1",
      reason: "probe.session-flow/v1 was removed; the session-flow contract now has a single canonical version.",
      nextStep: "Re-tag the flow's \"contract\" field as \"probe.session-flow/v2\" — existing v1 step shapes decode unchanged under v2.",
      details: [],
    })
  }

  return decodeFlowV2Contract(value)
}
