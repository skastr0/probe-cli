import { Schema } from "effect"
import { ArtifactRecord, NullableString, OutputMode } from "./output"
import type { SnapshotFrame, SnapshotNodeState, StoredSnapshotArtifact, StoredSnapshotNode } from "./snapshot"

const NullableBoolean = Schema.Union(Schema.Boolean, Schema.Null)
const NullableNumber = Schema.Union(Schema.Number, Schema.Null)
const OptionalNullableBoolean = Schema.optional(NullableBoolean)
const OptionalNullableString = Schema.optional(NullableString)
const NullableFlowExecutionProfile = Schema.Union(Schema.Literal("verified", "fast"), Schema.Null)
const NullableFlowTransportLane = Schema.Union(Schema.Literal("host-single", "runner-single"), Schema.Null)

const PositiveIntegerSchema = Schema.Number.pipe(Schema.int())

export const RetryReasonCode = Schema.Literal(
  "not-found",
  "not-hittable",
  "runner-timeout",
  "transient-transport",
  "assertion-failed",
)
export type RetryReasonCode = typeof RetryReasonCode.Type

export const RetryPolicySchema = Schema.Struct({
  maxAttempts: PositiveIntegerSchema,
  backoffMs: PositiveIntegerSchema,
  refreshSnapshotBetweenAttempts: Schema.Boolean,
  retryOn: Schema.Array(RetryReasonCode),
})
export type RetryPolicy = typeof RetryPolicySchema.Type

const OptionalRetryPolicy = Schema.optional(RetryPolicySchema)
const OptionalContinueOnError = Schema.optional(Schema.Boolean)

export const WaitCondition = Schema.Literal("match", "text", "absence", "duration")
export type WaitCondition = typeof WaitCondition.Type

export const ActionVerdict = Schema.Literal("passed", "failed", "timed-out")
export type ActionVerdict = typeof ActionVerdict.Type

export const ActionDirection = Schema.Literal("up", "down", "left", "right")
export type ActionDirection = typeof ActionDirection.Type

export const ActionKind = Schema.Literal("tap", "press", "swipe", "type", "scroll", "wait", "assert", "screenshot", "video")
export type ActionKind = typeof ActionKind.Type

export const FlowStepKind = Schema.Literal(
  "snapshot",
  "tap",
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
)
export type FlowStepKind = typeof FlowStepKind.Type

export const ActionResolutionSource = Schema.Literal("ref", "semantic", "point", "absence", "none")
export type ActionResolutionSource = typeof ActionResolutionSource.Type

const SemanticSelectorCanonicalFields = {
  kind: Schema.Literal("semantic"),
  identifier: NullableString,
  label: NullableString,
  value: NullableString,
  placeholder: NullableString,
  type: NullableString,
  section: NullableString,
  interactive: NullableBoolean,
}

const SemanticSelectorCanonicalSchema = Schema.Struct(SemanticSelectorCanonicalFields)

// XCUI exposes element roles as XCUIElementType, so `type` remains the canonical
// internal field. `role` is accepted as a JSON input alias to align with the work
// item contract without changing the existing snapshot vocabulary.
export const SemanticSelectorSchema = Schema.transform(
  Schema.Struct({
    ...SemanticSelectorCanonicalFields,
    type: OptionalNullableString,
    role: OptionalNullableString,
  }),
  SemanticSelectorCanonicalSchema,
  {
    decode: ({ role, type, ...selector }) => ({
      ...selector,
      type: type ?? role ?? null,
    }),
    encode: (selector) => selector,
  },
)
export type SemanticSelector = typeof SemanticSelectorSchema.Type

export const RefSelectorSchema = Schema.Struct({
  kind: Schema.Literal("ref"),
  ref: Schema.String,
  fallback: Schema.Union(SemanticSelectorSchema, Schema.Null),
})
export type RefSelector = typeof RefSelectorSchema.Type

export const PointSelectorSchema = Schema.Struct({
  kind: Schema.Literal("point"),
  x: Schema.Number,
  y: Schema.Number,
})
export type PointSelector = typeof PointSelectorSchema.Type

const PresenceSelectorSchema = Schema.Union(RefSelectorSchema, SemanticSelectorSchema)
type PresenceSelector = typeof PresenceSelectorSchema.Type

export const AbsenceSelectorSchema = Schema.Struct({
  kind: Schema.Literal("absence"),
  negate: PresenceSelectorSchema,
})
export type AbsenceSelector = typeof AbsenceSelectorSchema.Type

export const ActionSelectorSchema = Schema.Union(
  RefSelectorSchema,
  SemanticSelectorSchema,
  PointSelectorSchema,
  AbsenceSelectorSchema,
)
export type ActionSelector = typeof ActionSelectorSchema.Type

const AssertionExpectationCanonicalFields = {
  exists: NullableBoolean,
  visible: NullableBoolean,
  hidden: NullableBoolean,
  text: NullableString,
  label: NullableString,
  value: NullableString,
  type: NullableString,
  enabled: NullableBoolean,
  selected: NullableBoolean,
  focused: NullableBoolean,
  interactive: NullableBoolean,
}

const AssertionExpectationCanonicalSchema = Schema.Struct(AssertionExpectationCanonicalFields)

export const AssertionExpectationSchema = Schema.transform(
  Schema.Struct({
    exists: OptionalNullableBoolean,
    visible: OptionalNullableBoolean,
    hidden: OptionalNullableBoolean,
    text: OptionalNullableString,
    label: OptionalNullableString,
    value: OptionalNullableString,
    type: OptionalNullableString,
    enabled: OptionalNullableBoolean,
    selected: OptionalNullableBoolean,
    focused: OptionalNullableBoolean,
    interactive: OptionalNullableBoolean,
  }),
  AssertionExpectationCanonicalSchema,
  {
    decode: (expectation) => ({
      exists: expectation.exists ?? null,
      visible: expectation.visible ?? null,
      hidden: expectation.hidden ?? null,
      text: expectation.text ?? null,
      label: expectation.label ?? null,
      value: expectation.value ?? null,
      type: expectation.type ?? null,
      enabled: expectation.enabled ?? null,
      selected: expectation.selected ?? null,
      focused: expectation.focused ?? null,
      interactive: expectation.interactive ?? null,
    }),
    encode: (expectation) => expectation,
  },
)
export type AssertionExpectation = typeof AssertionExpectationSchema.Type

export const TapActionSchema = Schema.Struct({
  kind: Schema.Literal("tap"),
  target: ActionSelectorSchema,
  retryPolicy: OptionalRetryPolicy,
})
export type TapAction = typeof TapActionSchema.Type

export const PressActionSchema = Schema.Struct({
  kind: Schema.Literal("press"),
  target: ActionSelectorSchema,
  durationMs: Schema.Number,
  retryPolicy: OptionalRetryPolicy,
})
export type PressAction = typeof PressActionSchema.Type

export const SwipeActionSchema = Schema.Struct({
  kind: Schema.Literal("swipe"),
  target: ActionSelectorSchema,
  direction: ActionDirection,
  retryPolicy: OptionalRetryPolicy,
})
export type SwipeAction = typeof SwipeActionSchema.Type

export const TypeActionSchema = Schema.Struct({
  kind: Schema.Literal("type"),
  target: ActionSelectorSchema,
  text: Schema.String,
  replace: Schema.Boolean,
  retryPolicy: OptionalRetryPolicy,
})
export type TypeAction = typeof TypeActionSchema.Type

export const ScrollActionSchema = Schema.Struct({
  kind: Schema.Literal("scroll"),
  target: ActionSelectorSchema,
  direction: ActionDirection,
  steps: Schema.Number,
  retryPolicy: OptionalRetryPolicy,
})
export type ScrollAction = typeof ScrollActionSchema.Type

export const AssertActionSchema = Schema.Struct({
  kind: Schema.Literal("assert"),
  target: ActionSelectorSchema,
  expectation: AssertionExpectationSchema,
  retryPolicy: OptionalRetryPolicy,
})
export type AssertAction = typeof AssertActionSchema.Type

export const WaitActionSchema = Schema.Struct({
  kind: Schema.Literal("wait"),
  target: Schema.Union(ActionSelectorSchema, Schema.Null),
  timeoutMs: Schema.Number,
  condition: WaitCondition,
  text: NullableString,
  retryPolicy: OptionalRetryPolicy,
})
export type WaitAction = typeof WaitActionSchema.Type

export const ScreenshotActionSchema = Schema.Struct({
  kind: Schema.Literal("screenshot"),
  retryPolicy: OptionalRetryPolicy,
})
export type ScreenshotAction = typeof ScreenshotActionSchema.Type

const VideoDurationMsSchema = Schema.Number.pipe(
  Schema.int(),
  Schema.greaterThan(0),
  Schema.lessThanOrEqualTo(120_000),
)

export const VideoActionSchema = Schema.Struct({
  kind: Schema.Literal("video"),
  durationMs: VideoDurationMsSchema,
})
export type VideoAction = typeof VideoActionSchema.Type

export const FlowSnapshotStepSchema = Schema.Struct({
  kind: Schema.Literal("snapshot"),
  output: Schema.optional(OutputMode),
  continueOnError: OptionalContinueOnError,
})
export type FlowSnapshotStep = typeof FlowSnapshotStepSchema.Type

export const FlowTapStepSchema = Schema.Struct({
  ...TapActionSchema.fields,
  continueOnError: OptionalContinueOnError,
})
export type FlowTapStep = typeof FlowTapStepSchema.Type

export const FlowPressStepSchema = Schema.Struct({
  ...PressActionSchema.fields,
  continueOnError: OptionalContinueOnError,
})
export type FlowPressStep = typeof FlowPressStepSchema.Type

export const FlowSwipeStepSchema = Schema.Struct({
  ...SwipeActionSchema.fields,
  continueOnError: OptionalContinueOnError,
})
export type FlowSwipeStep = typeof FlowSwipeStepSchema.Type

export const FlowTypeStepSchema = Schema.Struct({
  ...TypeActionSchema.fields,
  continueOnError: OptionalContinueOnError,
})
export type FlowTypeStep = typeof FlowTypeStepSchema.Type

export const FlowScrollStepSchema = Schema.Struct({
  ...ScrollActionSchema.fields,
  continueOnError: OptionalContinueOnError,
})
export type FlowScrollStep = typeof FlowScrollStepSchema.Type

export const FlowWaitStepSchema = Schema.Struct({
  ...WaitActionSchema.fields,
  continueOnError: OptionalContinueOnError,
})
export type FlowWaitStep = typeof FlowWaitStepSchema.Type

export const FlowAssertStepSchema = Schema.Struct({
  ...AssertActionSchema.fields,
  continueOnError: OptionalContinueOnError,
})
export type FlowAssertStep = typeof FlowAssertStepSchema.Type

export const FlowScreenshotStepSchema = Schema.Struct({
  kind: Schema.Literal("screenshot"),
  label: Schema.optional(NullableString),
  retryPolicy: OptionalRetryPolicy,
  continueOnError: OptionalContinueOnError,
})
export type FlowScreenshotStep = typeof FlowScreenshotStepSchema.Type

export const FlowVideoStepSchema = Schema.Struct({
  ...VideoActionSchema.fields,
  continueOnError: OptionalContinueOnError,
})
export type FlowVideoStep = typeof FlowVideoStepSchema.Type

export const FlowLogMarkStepSchema = Schema.Struct({
  kind: Schema.Literal("logMark"),
  label: Schema.String,
  continueOnError: OptionalContinueOnError,
})
export type FlowLogMarkStep = typeof FlowLogMarkStepSchema.Type

export const FlowSleepStepSchema = Schema.Struct({
  kind: Schema.Literal("sleep"),
  durationMs: PositiveIntegerSchema,
  continueOnError: OptionalContinueOnError,
})
export type FlowSleepStep = typeof FlowSleepStepSchema.Type

export const FlowSessionActionStepSchema = Schema.Union(
  FlowTapStepSchema,
  FlowPressStepSchema,
  FlowSwipeStepSchema,
  FlowTypeStepSchema,
  FlowScrollStepSchema,
  FlowWaitStepSchema,
  FlowAssertStepSchema,
  FlowScreenshotStepSchema,
  FlowVideoStepSchema,
)
export type FlowSessionActionStep = typeof FlowSessionActionStepSchema.Type

export const FlowStepSchema = Schema.Union(
  FlowSnapshotStepSchema,
  FlowSessionActionStepSchema,
  FlowLogMarkStepSchema,
  FlowSleepStepSchema,
)
export type FlowStep = typeof FlowStepSchema.Type

export const FlowContractSchema = Schema.Struct({
  contract: Schema.Literal("probe.session-flow/v1"),
  steps: Schema.Array(FlowStepSchema),
})
export type FlowContract = typeof FlowContractSchema.Type

export const SessionActionSchema = Schema.Union(
  TapActionSchema,
  PressActionSchema,
  SwipeActionSchema,
  TypeActionSchema,
  ScrollActionSchema,
  WaitActionSchema,
  AssertActionSchema,
  ScreenshotActionSchema,
  VideoActionSchema,
)
export type SessionAction = typeof SessionActionSchema.Type

export type RunnerUiSessionAction = TapAction | PressAction | SwipeAction | TypeAction | ScrollAction
export type RunnerUiRecordedSessionAction = RecordedTapAction | RecordedPressAction | RecordedSwipeAction | RecordedTypeAction | RecordedScrollAction
type RunnerUiActionSource = RunnerUiSessionAction | RunnerUiRecordedSessionAction

export const RecordedActionTargetSchema = Schema.Struct({
  preferredRef: NullableString,
  fallback: Schema.Union(ActionSelectorSchema, Schema.Null),
  description: Schema.String,
})
export type RecordedActionTarget = typeof RecordedActionTargetSchema.Type

export const RecordedTapActionSchema = Schema.Struct({
  kind: Schema.Literal("tap"),
  target: RecordedActionTargetSchema,
})
export type RecordedTapAction = typeof RecordedTapActionSchema.Type

export const RecordedPressActionSchema = Schema.Struct({
  kind: Schema.Literal("press"),
  target: RecordedActionTargetSchema,
  durationMs: Schema.Number,
})
export type RecordedPressAction = typeof RecordedPressActionSchema.Type

export const RecordedSwipeActionSchema = Schema.Struct({
  kind: Schema.Literal("swipe"),
  target: RecordedActionTargetSchema,
  direction: ActionDirection,
})
export type RecordedSwipeAction = typeof RecordedSwipeActionSchema.Type

export const RecordedTypeActionSchema = Schema.Struct({
  kind: Schema.Literal("type"),
  target: RecordedActionTargetSchema,
  text: Schema.String,
  replace: Schema.Boolean,
})
export type RecordedTypeAction = typeof RecordedTypeActionSchema.Type

export const RecordedScrollActionSchema = Schema.Struct({
  kind: Schema.Literal("scroll"),
  target: RecordedActionTargetSchema,
  direction: ActionDirection,
  steps: Schema.Number,
})
export type RecordedScrollAction = typeof RecordedScrollActionSchema.Type

export const RecordedAssertActionSchema = Schema.Struct({
  kind: Schema.Literal("assert"),
  target: RecordedActionTargetSchema,
  expectation: AssertionExpectationSchema,
})
export type RecordedAssertAction = typeof RecordedAssertActionSchema.Type

export const RecordedWaitActionSchema = Schema.Struct({
  kind: Schema.Literal("wait"),
  target: Schema.Union(RecordedActionTargetSchema, Schema.Null),
  timeoutMs: Schema.Number,
  condition: WaitCondition,
  text: NullableString,
})
export type RecordedWaitAction = typeof RecordedWaitActionSchema.Type

export const RecordedScreenshotActionSchema = Schema.Struct({
  kind: Schema.Literal("screenshot"),
})
export type RecordedScreenshotAction = typeof RecordedScreenshotActionSchema.Type

export const RecordedVideoActionSchema = Schema.Struct({
  kind: Schema.Literal("video"),
  durationMs: VideoDurationMsSchema,
})
export type RecordedVideoAction = typeof RecordedVideoActionSchema.Type

export const RecordedSessionActionSchema = Schema.Union(
  RecordedTapActionSchema,
  RecordedPressActionSchema,
  RecordedSwipeActionSchema,
  RecordedTypeActionSchema,
  RecordedScrollActionSchema,
  RecordedWaitActionSchema,
  RecordedAssertActionSchema,
  RecordedScreenshotActionSchema,
  RecordedVideoActionSchema,
)
export type RecordedSessionAction = typeof RecordedSessionActionSchema.Type

export const ActionRecordingScriptSchema = Schema.Struct({
  contract: Schema.Literal("probe.action-recording/script-v1"),
  recordedAt: Schema.String,
  sessionId: NullableString,
  bundleId: NullableString,
  steps: Schema.Array(RecordedSessionActionSchema),
})
export type ActionRecordingScript = typeof ActionRecordingScriptSchema.Type

export const ReplayStepOutcomeSchema = Schema.Literal(
  "no-retry",
  "retry-succeeded",
  "semantic-fallback",
  "retry-exhausted",
)
export type ReplayStepOutcome = typeof ReplayStepOutcomeSchema.Type

export const ReplayStepReportSchema = Schema.Struct({
  index: Schema.Number,
  kind: ActionKind,
  attempts: Schema.Number,
  outcome: ReplayStepOutcomeSchema,
  resolvedBy: ActionResolutionSource,
  matchedRef: NullableString,
  artifact: Schema.Union(ArtifactRecord, Schema.Null),
  summary: Schema.String,
})
export type ReplayStepReport = typeof ReplayStepReportSchema.Type

export const ReplayFailureSchema = Schema.Struct({
  index: Schema.Number,
  kind: ActionKind,
  attempts: Schema.Number,
  reason: Schema.String,
})
export type ReplayFailure = typeof ReplayFailureSchema.Type

export const ReplayReportSchema = Schema.Struct({
  contract: Schema.Literal("probe.action-replay/report-v1"),
  executedAt: Schema.String,
  sessionId: Schema.String,
  status: Schema.Literal("succeeded", "failed"),
  finalSnapshotId: NullableString,
  retriedStepCount: Schema.Number,
  semanticFallbackCount: Schema.Number,
  sourceContract: Schema.String,
  warnings: Schema.Array(Schema.String),
  failure: Schema.Union(ReplayFailureSchema, Schema.Null),
  steps: Schema.Array(ReplayStepReportSchema),
})
export type ReplayReport = typeof ReplayReportSchema.Type

export const SessionActionResultSchema = Schema.Struct({
  summary: Schema.String,
  action: ActionKind,
  matchedRef: NullableString,
  resolvedBy: ActionResolutionSource,
  statusLabel: NullableString,
  latestSnapshotId: NullableString,
  artifact: Schema.Union(ArtifactRecord, Schema.Null),
  recordingLength: Schema.Number,
  retryCount: Schema.Number,
  retryReasons: Schema.Array(Schema.String),
  verdict: Schema.Union(ActionVerdict, Schema.Null),
  waitedMs: NullableNumber,
  polledCount: NullableNumber,
})
export type SessionActionResult = typeof SessionActionResultSchema.Type

export const SessionRecordingExportResultSchema = Schema.Struct({
  summary: Schema.String,
  artifact: ArtifactRecord,
  stepCount: Schema.Number,
})
export type SessionRecordingExportResult = typeof SessionRecordingExportResultSchema.Type

export const SessionReplayResultSchema = Schema.Struct({
  summary: Schema.String,
  artifact: ArtifactRecord,
  stepCount: Schema.Number,
  retriedStepCount: Schema.Number,
  semanticFallbackCount: Schema.Number,
  finalSnapshotId: NullableString,
})
export type SessionReplayResult = typeof SessionReplayResultSchema.Type

export const FlowStepResultSchema = Schema.Struct({
  index: PositiveIntegerSchema,
  kind: FlowStepKind,
  summary: Schema.String,
  verdict: ActionVerdict,
  matchedRef: NullableString,
  latestSnapshotId: NullableString,
  retryCount: Schema.Number,
  retryReasons: Schema.Array(Schema.String),
  artifacts: Schema.Array(ArtifactRecord),
  executionProfile: NullableFlowExecutionProfile,
  transportLane: NullableFlowTransportLane,
  handledMs: NullableNumber,
  warnings: Schema.Array(Schema.String),
})
export type FlowStepResult = typeof FlowStepResultSchema.Type

export const FlowFailedStepSchema = Schema.Struct({
  index: PositiveIntegerSchema,
  kind: FlowStepKind,
  summary: Schema.String,
  verdict: ActionVerdict,
})
export type FlowFailedStep = typeof FlowFailedStepSchema.Type

export const FlowResultSchema = Schema.Struct({
  contract: Schema.Literal("probe.session-flow/report-v1"),
  executedAt: Schema.String,
  sessionId: Schema.String,
  summary: Schema.String,
  verdict: ActionVerdict,
  executedSteps: Schema.Array(FlowStepResultSchema),
  failedStep: Schema.Union(FlowFailedStepSchema, Schema.Null),
  retries: Schema.Number,
  artifacts: Schema.Array(ArtifactRecord),
  finalSnapshotId: NullableString,
  warnings: Schema.Array(Schema.String),
})
export type FlowResult = typeof FlowResultSchema.Type

export interface FlattenedStoredSnapshotNode {
  readonly ref: string
  readonly node: StoredSnapshotNode
  readonly section: string | null
}

export interface ResolvedSnapshotTarget extends FlattenedStoredSnapshotNode {
  readonly kind: "snapshot"
  readonly resolvedBy: Extract<ActionResolutionSource, "ref" | "semantic">
}

export interface ResolvedPointTarget {
  readonly kind: "point"
  readonly x: number
  readonly y: number
  readonly resolvedBy: "point"
}

export interface ResolvedAbsenceTarget {
  readonly kind: "absence"
  readonly selector: PresenceSelector
  readonly resolvedBy: "absence"
}

export type ResolvedActionTarget = ResolvedSnapshotTarget | ResolvedPointTarget | ResolvedAbsenceTarget

export interface TargetResolution {
  readonly outcome: "matched" | "not-found" | "ambiguous"
  readonly reason: string
  readonly target: ResolvedActionTarget | null
}

export interface AssertionEvaluation {
  readonly ok: boolean
  readonly resolvedBy: ActionResolutionSource
  readonly matchedRef: string | null
  readonly summary: string
}

export interface RunnerActionLocator {
  readonly kind: "semantic" | "point"
  readonly identifier: string | null
  readonly label: string | null
  readonly value: string | null
  readonly placeholder: string | null
  readonly type: string | null
  readonly section: string | null
  readonly interactive: boolean | null
  readonly ordinal: number | null
  readonly x: number | null
  readonly y: number | null
}

export interface RunnerUiActionPayload {
  readonly kind: RunnerUiSessionAction["kind"]
  readonly locator: RunnerActionLocator
  readonly direction: ActionDirection | null
  readonly text: string | null
  readonly replace: boolean | null
  readonly steps: number | null
  readonly durationMs: number | null
}

interface FlattenArgs {
  readonly node: StoredSnapshotNode
  readonly section: string | null
  readonly into: Array<FlattenedStoredSnapshotNode>
}

const sectionToken = (node: Pick<StoredSnapshotNode, "identifier" | "label">): string | null => node.identifier ?? node.label

const nodeStateBoolean = (state: SnapshotNodeState | null, key: keyof SnapshotNodeState): boolean => state?.[key] === true

const frameLooksHiddenOrOffscreen = (frame: SnapshotFrame | null): boolean =>
  frame !== null && (frame.width <= 0 || frame.height <= 0 || frame.x + frame.width <= 0 || frame.y + frame.height <= 0)

const describeFrame = (frame: SnapshotFrame): string =>
  `x=${frame.x}, y=${frame.y}, width=${frame.width}, height=${frame.height}`

const inferSnapshotNodeVisibility = (node: StoredSnapshotNode): { readonly visible: boolean; readonly reason: string } => {
  if (node.frame !== null) {
    return frameLooksHiddenOrOffscreen(node.frame)
      ? {
          visible: false,
          reason: `frame heuristics treated ${describeFrame(node.frame)} as hidden/offscreen`,
        }
      : {
          visible: true,
          reason: `frame heuristics treated ${describeFrame(node.frame)} as visible`,
        }
  }

  return node.interactive
    ? {
        visible: true,
        reason: "no frame data was available, so Probe treated interactive=true as visible",
      }
    : {
        visible: false,
        reason: "no frame data was available, so Probe treated interactive=false as hidden",
      }
}

export const describeSemanticSelector = (selector: SemanticSelector): string => {
  const parts: Array<string> = []

  if (selector.identifier) {
    parts.push(`identifier=${selector.identifier}`)
  }

  if (selector.label) {
    parts.push(`label=${JSON.stringify(selector.label)}`)
  }

  if (selector.value) {
    parts.push(`value=${JSON.stringify(selector.value)}`)
  }

  if (selector.placeholder) {
    parts.push(`placeholder=${JSON.stringify(selector.placeholder)}`)
  }

  if (selector.type) {
    parts.push(`type=${selector.type}`)
  }

  if (selector.section) {
    parts.push(`section=${selector.section}`)
  }

  return parts.length > 0 ? parts.join(", ") : "semantic selector"
}

export const describeActionSelector = (selector: ActionSelector): string =>
  selector.kind === "ref"
    ? selector.fallback
      ? `${selector.ref} (${describeSemanticSelector(selector.fallback)})`
      : selector.ref
    : selector.kind === "semantic"
      ? describeSemanticSelector(selector)
      : selector.kind === "point"
        ? `point(${selector.x}, ${selector.y})`
        : `absence(${describeActionSelector(selector.negate)})`

export const describeRecordedActionTarget = (target: RecordedActionTarget): string => {
  if (target.description.length > 0) {
    return target.description
  }

  if (target.preferredRef) {
    return target.preferredRef
  }

  if (target.fallback) {
    return describeActionSelector(target.fallback)
  }

  return "recorded target"
}

export const describeSnapshotNode = (node: Pick<StoredSnapshotNode, "type" | "identifier" | "label" | "value" | "placeholder">): string => {
  if (node.identifier) {
    return `${node.identifier} (${node.type})`
  }

  if (node.label) {
    return `${JSON.stringify(node.label)} (${node.type})`
  }

  if (node.value) {
    return `${JSON.stringify(node.value)} (${node.type})`
  }

  if (node.placeholder) {
    return `${JSON.stringify(node.placeholder)} (${node.type})`
  }

  return `unnamed ${node.type}`
}

const flattenStoredNode = (args: FlattenArgs): void => {
  args.into.push({
    ref: args.node.ref,
    node: args.node,
    section: args.section,
  })

  const nextSection = sectionToken(args.node) ?? args.section

  for (const child of args.node.children) {
    flattenStoredNode({
      node: child,
      section: nextSection,
      into: args.into,
    })
  }
}

export const flattenStoredSnapshot = (snapshot: StoredSnapshotArtifact): Array<FlattenedStoredSnapshotNode> => {
  const entries: Array<FlattenedStoredSnapshotNode> = []
  flattenStoredNode({
    node: snapshot.root,
    section: null,
    into: entries,
  })
  return entries
}

const semanticSelectorMatchesNode = (selector: SemanticSelector, entry: FlattenedStoredSnapshotNode): boolean => {
  // Probe semantic selectors use conjunctive matching — all provided fields must
  // match. This is more precise than a cascading fallback chain and avoids false
  // positives from partial matches.
  if (selector.identifier !== null && entry.node.identifier !== selector.identifier) {
    return false
  }

  if (selector.label !== null && entry.node.label !== selector.label) {
    return false
  }

  if (selector.value !== null && entry.node.value !== selector.value) {
    return false
  }

  if (selector.placeholder !== null && entry.node.placeholder !== selector.placeholder) {
    return false
  }

  if (selector.type !== null && entry.node.type !== selector.type) {
    return false
  }

  if (selector.section !== null && entry.section !== selector.section) {
    return false
  }

  if (selector.interactive !== null && entry.node.interactive !== selector.interactive) {
    return false
  }

  return true
}

const semanticMatches = (snapshot: StoredSnapshotArtifact, selector: SemanticSelector): Array<FlattenedStoredSnapshotNode> =>
  flattenStoredSnapshot(snapshot).filter((entry) => semanticSelectorMatchesNode(selector, entry))

const requiresSnapshot = (selector: ActionSelector): boolean => selector.kind !== "point"

const missingSnapshotResolution = (selector: ActionSelector): TargetResolution => ({
  outcome: "not-found",
  reason: `Selector ${describeActionSelector(selector)} requires a current snapshot, but none is available.`,
  target: null,
})

const isResolvedSnapshotTarget = (target: ResolvedActionTarget | null): target is ResolvedSnapshotTarget =>
  target?.kind === "snapshot"

const resolveSemanticSelector = (snapshot: StoredSnapshotArtifact, selector: SemanticSelector): TargetResolution => {
  const matches = semanticMatches(snapshot, selector)

  if (matches.length === 0) {
    return {
      outcome: "not-found",
      reason: `No element matched ${describeSemanticSelector(selector)} in ${snapshot.snapshotId}.`,
      target: null,
    }
  }

  if (matches.length > 1) {
    return {
      outcome: "ambiguous",
      reason: `Semantic selector ${describeSemanticSelector(selector)} matched ${matches.length} elements in ${snapshot.snapshotId}.`,
      target: null,
    }
  }

  const match = matches[0]!
  return {
    outcome: "matched",
    reason: `Resolved ${describeSemanticSelector(selector)} to ${describeSnapshotNode(match.node)}.`,
    target: {
      kind: "snapshot",
      ...match,
      resolvedBy: "semantic",
    },
  }
}

export const resolveActionSelectorInSnapshot = (snapshot: StoredSnapshotArtifact | null, selector: ActionSelector): TargetResolution => {
  if (selector.kind === "point") {
    return {
      outcome: "matched",
      reason: `Resolved ${describeActionSelector(selector)} in the interaction-root coordinate space.`,
      target: {
        kind: "point",
        x: selector.x,
        y: selector.y,
        resolvedBy: "point",
      },
    }
  }

  if (snapshot === null && requiresSnapshot(selector)) {
    return missingSnapshotResolution(selector)
  }

  const currentSnapshot = snapshot!

  if (selector.kind === "absence") {
    const negated = resolveActionSelectorInSnapshot(currentSnapshot, selector.negate)

    if (negated.outcome === "ambiguous") {
      return {
        outcome: "ambiguous",
        reason: `Could not confirm ${describeActionSelector(selector)}: ${negated.reason}`,
        target: null,
      }
    }

    if (negated.outcome === "not-found") {
      return {
        outcome: "matched",
        reason: `Confirmed absence of ${describeActionSelector(selector.negate)} in ${currentSnapshot.snapshotId}.`,
        target: {
          kind: "absence",
          selector: selector.negate,
          resolvedBy: "absence",
        },
      }
    }

    const matchedTarget = negated.target
    const matchedDescription = isResolvedSnapshotTarget(matchedTarget)
      ? `${describeSnapshotNode(matchedTarget.node)} (${matchedTarget.ref})`
      : describeActionSelector(selector.negate)

    return {
      outcome: "not-found",
      reason: `Expected absence of ${describeActionSelector(selector.negate)}, but it resolved to ${matchedDescription}.`,
      target: null,
    }
  }

  if (selector.kind === "semantic") {
    return resolveSemanticSelector(currentSnapshot, selector)
  }

  const entries = flattenStoredSnapshot(currentSnapshot)
  const refMatch = entries.find((entry) => entry.ref === selector.ref)

  if (refMatch) {
    if (selector.fallback === null || semanticSelectorMatchesNode(selector.fallback, refMatch)) {
      return {
        outcome: "matched",
        reason: `Resolved ${selector.ref} to ${describeSnapshotNode(refMatch.node)}.`,
        target: {
          kind: "snapshot",
          ...refMatch,
          resolvedBy: "ref",
        },
      }
    }
  }

  if (selector.fallback !== null) {
    const fallbackResult = resolveSemanticSelector(currentSnapshot, selector.fallback)

    if (fallbackResult.outcome === "matched") {
      return {
        ...fallbackResult,
        reason: refMatch
          ? `${selector.ref} drifted away from ${describeSemanticSelector(selector.fallback)}; recovered with semantic fallback.`
          : `${selector.ref} was missing; recovered with semantic fallback ${describeSemanticSelector(selector.fallback)}.`,
      }
    }

    return fallbackResult
  }

  return {
    outcome: "not-found",
    reason: `Ref ${selector.ref} was not present in ${currentSnapshot.snapshotId}.`,
    target: null,
  }
}

export const resolveRecordedActionTargetInSnapshot = (
  snapshot: StoredSnapshotArtifact | null,
  target: RecordedActionTarget,
): TargetResolution => {
  if (target.preferredRef !== null) {
    const refResult = resolveActionSelectorInSnapshot(snapshot, {
      kind: "ref",
      ref: target.preferredRef,
      fallback: target.fallback?.kind === "semantic" ? target.fallback : null,
    })

    if (refResult.outcome === "matched" || target.fallback === null || target.fallback.kind === "semantic") {
      return refResult
    }

    return refResult.outcome === "not-found"
      ? resolveActionSelectorInSnapshot(snapshot, target.fallback)
      : refResult
  }

  if (target.fallback !== null) {
    return resolveActionSelectorInSnapshot(snapshot, target.fallback)
  }

  return {
    outcome: "not-found",
    reason: `Recorded target ${target.description} does not have a ref or semantic fallback.`,
    target: null,
  }
}

const buildStableSemanticSelector = (entry: FlattenedStoredSnapshotNode): SemanticSelector => {
  const hasIdentifier = entry.node.identifier !== null

  return {
    kind: "semantic",
    identifier: entry.node.identifier,
    label: hasIdentifier ? null : entry.node.label,
    value: hasIdentifier || entry.node.label !== null ? null : entry.node.value,
    placeholder: hasIdentifier || entry.node.label !== null || entry.node.value !== null ? null : entry.node.placeholder,
    type: entry.node.type,
    section: hasIdentifier ? null : entry.section,
    interactive: entry.node.interactive,
  }
}

export const buildRecordedActionTarget = (selector: ActionSelector, resolved: ResolvedActionTarget | null): RecordedActionTarget => {
  if (resolved?.kind === "snapshot") {
    return {
      preferredRef: resolved.ref,
      fallback: buildStableSemanticSelector(resolved),
      description: describeSnapshotNode(resolved.node),
    }
  }

  if (selector.kind === "ref") {
    return {
      preferredRef: selector.ref,
      fallback: selector.fallback,
      description: describeActionSelector(selector),
    }
  }

  return {
    preferredRef: null,
    fallback: selector,
    description: describeActionSelector(selector),
  }
}

export const buildRecordedSessionAction = (
  action: SessionAction,
  resolved: ResolvedActionTarget | null,
): RecordedSessionAction => {
  if (action.kind === "screenshot") {
    return { kind: action.kind }
  }

  if (action.kind === "video") {
    return { kind: action.kind, durationMs: action.durationMs }
  }

  if (action.kind === "wait") {
    return {
      kind: action.kind,
      target: action.target === null ? null : buildRecordedActionTarget(action.target, resolved),
      timeoutMs: action.timeoutMs,
      condition: action.condition,
      text: action.text,
    }
  }

  const target = buildRecordedActionTarget(action.target, resolved)

  switch (action.kind) {
    case "tap":
      return { kind: action.kind, target }
    case "press":
      return { kind: action.kind, target, durationMs: action.durationMs }
    case "swipe":
      return { kind: action.kind, target, direction: action.direction }
    case "type":
      return { kind: action.kind, target, text: action.text, replace: action.replace }
    case "scroll":
      return { kind: action.kind, target, direction: action.direction, steps: action.steps }
    case "assert":
      return { kind: action.kind, target, expectation: action.expectation }
    default:
      return action satisfies never
  }
}

const assertionMismatch = (
  description: string,
  context?: Partial<Pick<AssertionEvaluation, "resolvedBy" | "matchedRef">>,
): AssertionEvaluation => ({
  ok: false,
  resolvedBy: context?.resolvedBy ?? "none",
  matchedRef: context?.matchedRef ?? null,
  summary: description,
})

export const evaluateAssertion = (
  resolution: TargetResolution,
  expectation: AssertionExpectation,
): AssertionEvaluation => {
  const absenceSatisfied = expectation.exists === false

  if (resolution.outcome === "ambiguous") {
    return assertionMismatch(resolution.reason)
  }

  if (resolution.outcome === "not-found") {
    return absenceSatisfied
      ? {
          ok: true,
          resolvedBy: "absence",
          matchedRef: null,
          summary: `Confirmed absence: ${resolution.reason}`,
        }
      : assertionMismatch(resolution.reason)
  }

  const target = resolution.target!

  if (target.kind === "point") {
    return assertionMismatch(
      `Point selector point(${target.x}, ${target.y}) cannot be used for assertions. Use ref, semantic, or absence selectors instead.`,
      { resolvedBy: "point" },
    )
  }

  if (target.kind === "absence") {
    return expectation.exists === true || absenceSatisfied
      ? {
          ok: true,
          resolvedBy: "absence",
          matchedRef: null,
          summary: resolution.reason,
        }
      : assertionMismatch(`Expected ${describeActionSelector({ kind: "absence", negate: target.selector })} not to match, but absence was already confirmed.`, {
          resolvedBy: "absence",
        })
  }

  if (absenceSatisfied) {
    return assertionMismatch(
      `Expected ${describeSnapshotNode(target.node)} to be absent, but it exists as ${target.ref}.`,
      { resolvedBy: target.resolvedBy, matchedRef: target.ref },
    )
  }

  const visibility = inferSnapshotNodeVisibility(target.node)

  if (expectation.visible !== null && visibility.visible !== expectation.visible) {
    return assertionMismatch(
      expectation.visible
        ? `Expected ${describeSnapshotNode(target.node)} to be visible, but ${visibility.reason}.`
        : `Expected ${describeSnapshotNode(target.node)} to be hidden/offscreen, but ${visibility.reason}.`,
      { resolvedBy: target.resolvedBy, matchedRef: target.ref },
    )
  }

  if (expectation.hidden !== null && visibility.visible === expectation.hidden) {
    return assertionMismatch(
      expectation.hidden
        ? `Expected ${describeSnapshotNode(target.node)} to be hidden/offscreen, but ${visibility.reason}.`
        : `Expected ${describeSnapshotNode(target.node)} to be visible, but ${visibility.reason}.`,
      { resolvedBy: target.resolvedBy, matchedRef: target.ref },
    )
  }

  if (expectation.text !== null && target.node.label !== expectation.text && target.node.value !== expectation.text) {
    return assertionMismatch(
      `Expected ${describeSnapshotNode(target.node)} text ${JSON.stringify(expectation.text)}, received label ${JSON.stringify(target.node.label)} and value ${JSON.stringify(target.node.value)}.`,
      { resolvedBy: target.resolvedBy, matchedRef: target.ref },
    )
  }

  if (expectation.label !== null && target.node.label !== expectation.label) {
    return assertionMismatch(
      `Expected ${describeSnapshotNode(target.node)} label ${JSON.stringify(expectation.label)}, received ${JSON.stringify(target.node.label)}.`,
      { resolvedBy: target.resolvedBy, matchedRef: target.ref },
    )
  }

  if (expectation.value !== null && target.node.value !== expectation.value) {
    return assertionMismatch(
      `Expected ${describeSnapshotNode(target.node)} value ${JSON.stringify(expectation.value)}, received ${JSON.stringify(target.node.value)}.`,
      { resolvedBy: target.resolvedBy, matchedRef: target.ref },
    )
  }

  if (expectation.type !== null && target.node.type !== expectation.type) {
    return assertionMismatch(`Expected type ${expectation.type}, received ${target.node.type}.`, {
      resolvedBy: target.resolvedBy,
      matchedRef: target.ref,
    })
  }

  if (expectation.enabled !== null && (target.node.state?.disabled === true) === expectation.enabled) {
    return assertionMismatch(
      expectation.enabled
        ? `Expected ${describeSnapshotNode(target.node)} to be enabled.`
        : `Expected ${describeSnapshotNode(target.node)} to be disabled.`,
      { resolvedBy: target.resolvedBy, matchedRef: target.ref },
    )
  }

  if (expectation.selected !== null && nodeStateBoolean(target.node.state, "selected") !== expectation.selected) {
    return assertionMismatch(
      expectation.selected
        ? `Expected ${describeSnapshotNode(target.node)} to be selected.`
        : `Expected ${describeSnapshotNode(target.node)} to be unselected.`,
      { resolvedBy: target.resolvedBy, matchedRef: target.ref },
    )
  }

  if (expectation.focused !== null && nodeStateBoolean(target.node.state, "focused") !== expectation.focused) {
    return assertionMismatch(
      expectation.focused
        ? `Expected ${describeSnapshotNode(target.node)} to be focused.`
        : `Expected ${describeSnapshotNode(target.node)} to be unfocused.`,
      { resolvedBy: target.resolvedBy, matchedRef: target.ref },
    )
  }

  if (expectation.interactive !== null && target.node.interactive !== expectation.interactive) {
    return assertionMismatch(
      expectation.interactive
        ? `Expected ${describeSnapshotNode(target.node)} to be interactive.`
        : `Expected ${describeSnapshotNode(target.node)} to be non-interactive.`,
      { resolvedBy: target.resolvedBy, matchedRef: target.ref },
    )
  }

  return {
    ok: true,
    resolvedBy: target.resolvedBy,
    matchedRef: target.ref,
    summary: `Assertion passed for ${describeSnapshotNode(target.node)} (${target.ref}).`,
  }
}

export const validateSessionAction = (action: SessionAction): string | null => {
  const retryPolicy = "retryPolicy" in action ? action.retryPolicy : undefined

  if (retryPolicy !== undefined) {
    if (!Number.isInteger(retryPolicy.maxAttempts) || retryPolicy.maxAttempts <= 0) {
      return "Retry policy maxAttempts must be a positive integer."
    }

    if (!Number.isInteger(retryPolicy.backoffMs) || retryPolicy.backoffMs < 0) {
      return "Retry policy backoffMs must be a non-negative integer."
    }
  }

  switch (action.kind) {
    case "tap":
    case "swipe":
    case "type":
      return action.target.kind === "absence" ? "Absence selectors can only be used with assert actions." : null
    case "press":
      if (action.target.kind === "absence") {
        return "Absence selectors can only be used with assert actions."
      }
      return action.durationMs > 0 ? null : "Press duration must be a positive number of milliseconds."
    case "assert":
      if (action.target.kind === "point") {
        return "Point selectors cannot be used with assert actions. Use ref, semantic, or absence selectors instead."
      }

      if (action.expectation.visible === true && action.expectation.hidden === true) {
        return "Assert expectations cannot require both visible and hidden at the same time."
      }

      return [
        action.expectation.exists,
        action.expectation.visible,
        action.expectation.hidden,
        action.expectation.text,
        action.expectation.label,
        action.expectation.value,
        action.expectation.type,
        action.expectation.enabled,
        action.expectation.selected,
        action.expectation.focused,
        action.expectation.interactive,
      ].every((value) => value === null)
        ? "Assert actions require at least one expectation field."
        : null
    case "wait": {
      if (!Number.isInteger(action.timeoutMs) || action.timeoutMs <= 0) {
        return "Wait timeoutMs must be a positive integer."
      }

      if (action.condition === "duration") {
        return action.target === null ? null : "Duration waits cannot include a selector or target."
      }

      if (action.target === null) {
        return "Wait actions require a selector or target unless condition is duration."
      }

      if (action.target.kind === "point") {
        return "Point selectors cannot be used with wait actions. Use ref, semantic, or absence selectors instead."
      }

      if (action.condition === "text" && (action.text === null || action.text.length === 0)) {
        return "Wait text conditions require a non-empty text field."
      }

      if (action.condition === "text" && action.target.kind === "absence") {
        return "Wait text conditions require a ref or semantic selector, not an absence selector."
      }

      return null
    }
    case "video":
      return Number.isFinite(action.durationMs) && action.durationMs > 0
        ? null
        : "Video duration must be a positive number of milliseconds."
    case "scroll":
      if (action.target.kind === "absence") {
        return "Absence selectors can only be used with assert actions."
      }
      return Number.isInteger(action.steps) && action.steps > 0 ? null : "Scroll steps must be a positive integer."
    default:
      return null
  }
}

export const isRunnerUiSessionAction = (action: SessionAction): action is RunnerUiSessionAction =>
  action.kind === "tap"
  || action.kind === "press"
  || action.kind === "swipe"
  || action.kind === "type"
  || action.kind === "scroll"

export const isFlowSessionActionStep = (step: FlowStep): step is FlowSessionActionStep =>
  step.kind === "tap"
  || step.kind === "press"
  || step.kind === "swipe"
  || step.kind === "type"
  || step.kind === "scroll"
  || step.kind === "wait"
  || step.kind === "assert"
  || step.kind === "screenshot"
  || step.kind === "video"

export const isRunnerUiRecordedSessionAction = (
  action: RecordedSessionAction,
): action is RunnerUiRecordedSessionAction =>
  action.kind === "tap"
  || action.kind === "press"
  || action.kind === "swipe"
  || action.kind === "type"
  || action.kind === "scroll"

const buildSemanticRunnerLocator = (
  selector: SemanticSelector,
  ordinal: number | null,
): RunnerActionLocator => ({
  kind: "semantic",
  identifier: selector.identifier,
  label: selector.label,
  value: selector.value,
  placeholder: selector.placeholder,
  type: selector.type,
  section: selector.section,
  interactive: selector.interactive,
  ordinal,
  x: null,
  y: null,
})

const buildRunnerLocator = (
  snapshot: StoredSnapshotArtifact,
  resolved: ResolvedSnapshotTarget,
): RunnerActionLocator => {
  const semantic = buildStableSemanticSelector(resolved)
  const matches = semanticMatches(snapshot, semantic)
  const matchIndex = matches.findIndex((entry) => entry.ref === resolved.ref)

  return buildSemanticRunnerLocator(
    semantic,
    matches.length > 1 && matchIndex >= 0 ? matchIndex + 1 : null,
  )
}

const buildPointRunnerLocator = (resolved: ResolvedPointTarget): RunnerActionLocator => ({
  kind: "point",
  identifier: null,
  label: null,
  value: null,
  placeholder: null,
  type: null,
  section: null,
  interactive: null,
  ordinal: null,
  x: resolved.x,
  y: resolved.y,
})

export const buildDirectRunnerLocator = (selector: ActionSelector): RunnerActionLocator => {
  switch (selector.kind) {
    case "semantic":
      return buildSemanticRunnerLocator(selector, null)
    case "point":
      return {
        kind: "point",
        identifier: null,
        label: null,
        value: null,
        placeholder: null,
        type: null,
        section: null,
        interactive: null,
        ordinal: null,
        x: selector.x,
        y: selector.y,
      }
    case "ref":
      if (selector.fallback === null) {
        throw new Error("Ref selectors require a semantic fallback before they can drive direct runner UI actions.")
      }

      return buildSemanticRunnerLocator(selector.fallback, null)
    case "absence":
      throw new Error("Absence selectors cannot drive runner UI actions.")
  }
}

const buildRunnerUiActionPayloadWithLocator = (
  action: RunnerUiActionSource,
  locator: RunnerActionLocator,
): RunnerUiActionPayload => {
  switch (action.kind) {
    case "tap":
      return {
        kind: action.kind,
        locator,
        direction: null,
        text: null,
        replace: null,
        steps: null,
        durationMs: null,
      }
    case "press":
      return {
        kind: action.kind,
        locator,
        direction: null,
        text: null,
        replace: null,
        steps: null,
        durationMs: action.durationMs,
      }
    case "swipe":
      return {
        kind: action.kind,
        locator,
        direction: action.direction,
        text: null,
        replace: null,
        steps: null,
        durationMs: null,
      }
    case "type":
      return {
        kind: action.kind,
        locator,
        direction: null,
        text: action.text,
        replace: action.replace,
        steps: null,
        durationMs: null,
      }
    case "scroll":
      return {
        kind: action.kind,
        locator,
        direction: action.direction,
        text: null,
        replace: null,
        steps: action.steps,
        durationMs: null,
      }
  }
}

export const buildRunnerUiActionPayload = (
  action: RunnerUiActionSource,
  resolved: ResolvedActionTarget,
  snapshot: StoredSnapshotArtifact | null,
): RunnerUiActionPayload => {
  const locator = resolved.kind === "point"
    ? buildPointRunnerLocator(resolved)
    : resolved.kind === "snapshot"
      ? snapshot === null
        ? (() => {
            throw new Error("Snapshot-backed selectors require a current snapshot to build a runner locator.")
          })()
        : buildRunnerLocator(snapshot, resolved)
      : (() => {
          throw new Error("Absence selectors cannot drive runner UI actions.")
        })()

  return buildRunnerUiActionPayloadWithLocator(action, locator)
}

export const buildDirectRunnerUiActionPayload = (
  action: RunnerUiActionSource,
  selector: ActionSelector,
): RunnerUiActionPayload => buildRunnerUiActionPayloadWithLocator(action, buildDirectRunnerLocator(selector))

export const flowStepToSessionAction = (step: FlowSessionActionStep): SessionAction => {
  switch (step.kind) {
    case "tap":
    case "press":
    case "swipe":
    case "type":
    case "scroll":
    case "wait":
    case "assert":
    case "video":
      return step
    case "screenshot":
      return {
        kind: "screenshot",
        retryPolicy: step.retryPolicy,
      }
  }
}

export const validateFlowStep = (step: FlowStep): string | null => {
  switch (step.kind) {
    case "snapshot":
      return null
    case "logMark":
      return step.label.trim().length > 0 ? null : "Log mark steps require a non-empty label."
    case "sleep":
      return Number.isInteger(step.durationMs) && step.durationMs > 0
        ? null
        : "Sleep durationMs must be a positive integer."
    default:
      return validateSessionAction(flowStepToSessionAction(step))
  }
}

export const validateFlowContract = (flow: FlowContract): string | null => {
  if (flow.steps.length === 0) {
    return "Flow contracts require at least one step."
  }

  for (const [index, step] of flow.steps.entries()) {
    const validationError = validateFlowStep(step)

    if (validationError !== null) {
      return `Step ${index + 1}: ${validationError}`
    }
  }

  return null
}

const normalizeActionSelectorInput = (value: unknown): unknown => {
  if (typeof value !== "object" || value === null) {
    return value
  }

  const record = value as Record<string, unknown>

  if (record.kind === "absence") {
    return {
      ...record,
      negate: normalizeActionSelectorInput(record.negate ?? record.selector),
    }
  }

  if (record.kind === "ref") {
    return {
      ...record,
      fallback: normalizeActionSelectorInput(record.fallback ?? null),
    }
  }

  return record
}

const normalizeSessionActionInput = (value: unknown): unknown => {
  if (typeof value !== "object" || value === null) {
    return value
  }

  const record = value as Record<string, unknown>

  if (
    record.kind === "tap"
    || record.kind === "press"
    || record.kind === "swipe"
    || record.kind === "type"
    || record.kind === "scroll"
  ) {
    return {
      ...record,
      target: normalizeActionSelectorInput(record.target ?? record.selector),
    }
  }

  if (record.kind === "assert") {
    const expectation = typeof record.expectation === "object" && record.expectation !== null
      ? record.expectation as Record<string, unknown>
      : {}

    return {
      ...record,
      target: normalizeActionSelectorInput(record.target ?? record.selector),
      expectation,
    }
  }

  if (record.kind === "wait") {
    const hasTarget = record.target !== undefined || record.selector !== undefined

    return {
      ...record,
      target: normalizeActionSelectorInput(record.target ?? record.selector ?? null),
      condition: record.condition ?? (hasTarget ? "match" : "duration"),
      text: record.text ?? null,
    }
  }

  return value
}

const normalizeFlowStepInput = (value: unknown): unknown => {
  if (typeof value !== "object" || value === null) {
    return value
  }

  const record = value as Record<string, unknown>

  if (
    record.kind === "tap"
    || record.kind === "press"
    || record.kind === "swipe"
    || record.kind === "type"
    || record.kind === "scroll"
  ) {
    return {
      ...record,
      target: normalizeActionSelectorInput(record.target ?? record.selector),
    }
  }

  if (record.kind === "assert") {
    const expectation = typeof record.expectation === "object" && record.expectation !== null
      ? record.expectation as Record<string, unknown>
      : {}

    return {
      ...record,
      target: normalizeActionSelectorInput(record.target ?? record.selector),
      expectation,
    }
  }

  if (record.kind === "wait") {
    const hasTarget = record.target !== undefined || record.selector !== undefined

    return {
      ...record,
      target: normalizeActionSelectorInput(record.target ?? record.selector ?? null),
      condition: record.condition ?? (hasTarget ? "match" : "duration"),
      text: record.text ?? null,
    }
  }

  if (record.kind === "screenshot") {
    return {
      ...record,
      label: record.label ?? null,
    }
  }

  return value
}

const normalizeFlowContractInput = (value: unknown): unknown => {
  if (typeof value !== "object" || value === null) {
    return value
  }

  const record = value as Record<string, unknown>

  return {
    ...record,
    steps: Array.isArray(record.steps)
      ? record.steps.map((step) => normalizeFlowStepInput(step))
      : record.steps,
  }
}

export const decodeSessionAction = (value: unknown): SessionAction =>
  Schema.decodeUnknownSync(SessionActionSchema)(normalizeSessionActionInput(value))
export const decodeFlowContract = (value: unknown): FlowContract =>
  Schema.decodeUnknownSync(FlowContractSchema)(normalizeFlowContractInput(value))
export const decodeActionRecordingScript = Schema.decodeUnknownSync(ActionRecordingScriptSchema)
