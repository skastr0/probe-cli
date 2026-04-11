import { Schema } from "effect"
import { ArtifactRecord, NullableString } from "./output"
import type { SnapshotNodeState, StoredSnapshotArtifact, StoredSnapshotNode } from "./snapshot"

const NullableBoolean = Schema.Union(Schema.Boolean, Schema.Null)
const NullableNumber = Schema.Union(Schema.Number, Schema.Null)

export const ActionDirection = Schema.Literal("up", "down", "left", "right")
export type ActionDirection = typeof ActionDirection.Type

export const ActionKind = Schema.Literal("tap", "press", "swipe", "type", "scroll", "assert", "screenshot", "video")
export type ActionKind = typeof ActionKind.Type

export const ActionResolutionSource = Schema.Literal("ref", "semantic", "absence", "none")
export type ActionResolutionSource = typeof ActionResolutionSource.Type

export const SemanticSelectorSchema = Schema.Struct({
  kind: Schema.Literal("semantic"),
  identifier: NullableString,
  label: NullableString,
  value: NullableString,
  placeholder: NullableString,
  type: NullableString,
  section: NullableString,
  interactive: NullableBoolean,
})
export type SemanticSelector = typeof SemanticSelectorSchema.Type

export const RefSelectorSchema = Schema.Struct({
  kind: Schema.Literal("ref"),
  ref: Schema.String,
  fallback: Schema.Union(SemanticSelectorSchema, Schema.Null),
})
export type RefSelector = typeof RefSelectorSchema.Type

export const ActionSelectorSchema = Schema.Union(RefSelectorSchema, SemanticSelectorSchema)
export type ActionSelector = typeof ActionSelectorSchema.Type

export const AssertionExpectationSchema = Schema.Struct({
  exists: Schema.Boolean,
  label: NullableString,
  value: NullableString,
  type: NullableString,
  enabled: NullableBoolean,
  selected: NullableBoolean,
  focused: NullableBoolean,
  interactive: NullableBoolean,
})
export type AssertionExpectation = typeof AssertionExpectationSchema.Type

export const TapActionSchema = Schema.Struct({
  kind: Schema.Literal("tap"),
  target: ActionSelectorSchema,
})
export type TapAction = typeof TapActionSchema.Type

export const PressActionSchema = Schema.Struct({
  kind: Schema.Literal("press"),
  target: ActionSelectorSchema,
  durationMs: Schema.Number,
})
export type PressAction = typeof PressActionSchema.Type

export const SwipeActionSchema = Schema.Struct({
  kind: Schema.Literal("swipe"),
  target: ActionSelectorSchema,
  direction: ActionDirection,
})
export type SwipeAction = typeof SwipeActionSchema.Type

export const TypeActionSchema = Schema.Struct({
  kind: Schema.Literal("type"),
  target: ActionSelectorSchema,
  text: Schema.String,
  replace: Schema.Boolean,
})
export type TypeAction = typeof TypeActionSchema.Type

export const ScrollActionSchema = Schema.Struct({
  kind: Schema.Literal("scroll"),
  target: ActionSelectorSchema,
  direction: ActionDirection,
  steps: Schema.Number,
})
export type ScrollAction = typeof ScrollActionSchema.Type

export const AssertActionSchema = Schema.Struct({
  kind: Schema.Literal("assert"),
  target: ActionSelectorSchema,
  expectation: AssertionExpectationSchema,
})
export type AssertAction = typeof AssertActionSchema.Type

export const ScreenshotActionSchema = Schema.Struct({
  kind: Schema.Literal("screenshot"),
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

export const SessionActionSchema = Schema.Union(
  TapActionSchema,
  PressActionSchema,
  SwipeActionSchema,
  TypeActionSchema,
  ScrollActionSchema,
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
  fallback: Schema.Union(SemanticSelectorSchema, Schema.Null),
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

export const ReplayStepReportSchema = Schema.Struct({
  index: Schema.Number,
  kind: ActionKind,
  attempts: Schema.Number,
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

export interface FlattenedStoredSnapshotNode {
  readonly ref: string
  readonly node: StoredSnapshotNode
  readonly section: string | null
}

export interface ResolvedSnapshotTarget extends FlattenedStoredSnapshotNode {
  readonly resolvedBy: Exclude<ActionResolutionSource, "absence" | "none">
}

export interface TargetResolution {
  readonly outcome: "matched" | "not-found" | "ambiguous"
  readonly reason: string
  readonly target: ResolvedSnapshotTarget | null
}

export interface AssertionEvaluation {
  readonly ok: boolean
  readonly resolvedBy: ActionResolutionSource
  readonly matchedRef: string | null
  readonly summary: string
}

export interface RunnerActionLocator {
  readonly identifier: string | null
  readonly label: string | null
  readonly value: string | null
  readonly placeholder: string | null
  readonly type: string | null
  readonly section: string | null
  readonly interactive: boolean | null
  readonly ordinal: number | null
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
    : describeSemanticSelector(selector)

export const describeRecordedActionTarget = (target: RecordedActionTarget): string => {
  if (target.description.length > 0) {
    return target.description
  }

  if (target.preferredRef) {
    return target.preferredRef
  }

  if (target.fallback) {
    return describeSemanticSelector(target.fallback)
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
      ...match,
      resolvedBy: "semantic",
    },
  }
}

export const resolveActionSelectorInSnapshot = (snapshot: StoredSnapshotArtifact, selector: ActionSelector): TargetResolution => {
  if (selector.kind === "semantic") {
    return resolveSemanticSelector(snapshot, selector)
  }

  const entries = flattenStoredSnapshot(snapshot)
  const refMatch = entries.find((entry) => entry.ref === selector.ref)

  if (refMatch) {
    if (selector.fallback === null || semanticSelectorMatchesNode(selector.fallback, refMatch)) {
      return {
        outcome: "matched",
        reason: `Resolved ${selector.ref} to ${describeSnapshotNode(refMatch.node)}.`,
        target: {
          ...refMatch,
          resolvedBy: "ref",
        },
      }
    }
  }

  if (selector.fallback !== null) {
    const fallbackResult = resolveSemanticSelector(snapshot, selector.fallback)

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
    reason: `Ref ${selector.ref} was not present in ${snapshot.snapshotId}.`,
    target: null,
  }
}

export const resolveRecordedActionTargetInSnapshot = (
  snapshot: StoredSnapshotArtifact,
  target: RecordedActionTarget,
): TargetResolution => {
  if (target.preferredRef !== null) {
    return resolveActionSelectorInSnapshot(snapshot, {
      kind: "ref",
      ref: target.preferredRef,
      fallback: target.fallback,
    })
  }

  if (target.fallback !== null) {
    return resolveSemanticSelector(snapshot, target.fallback)
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

export const buildRecordedActionTarget = (selector: ActionSelector, resolved: ResolvedSnapshotTarget | null): RecordedActionTarget => {
  if (resolved) {
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
  resolved: ResolvedSnapshotTarget | null,
): RecordedSessionAction => {
  if (action.kind === "screenshot") {
    return { kind: action.kind }
  }

  if (action.kind === "video") {
    return { kind: action.kind, durationMs: action.durationMs }
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
  }
}

const assertionMismatch = (description: string): AssertionEvaluation => ({
  ok: false,
  resolvedBy: "absence",
  matchedRef: null,
  summary: description,
})

export const evaluateAssertion = (
  resolution: TargetResolution,
  expectation: AssertionExpectation,
): AssertionEvaluation => {
  if (resolution.outcome === "ambiguous") {
    return assertionMismatch(resolution.reason)
  }

  if (resolution.outcome === "not-found") {
    return expectation.exists === false
      ? {
          ok: true,
          resolvedBy: "absence",
          matchedRef: null,
          summary: `Confirmed absence: ${resolution.reason}`,
        }
      : assertionMismatch(resolution.reason)
  }

  const target = resolution.target!

  if (expectation.exists === false) {
    return assertionMismatch(`Expected ${describeSnapshotNode(target.node)} to be absent, but it exists as ${target.ref}.`)
  }

  if (expectation.label !== null && target.node.label !== expectation.label) {
    return assertionMismatch(
      `Expected ${describeSnapshotNode(target.node)} label ${JSON.stringify(expectation.label)}, received ${JSON.stringify(target.node.label)}.`,
    )
  }

  if (expectation.value !== null && target.node.value !== expectation.value) {
    return assertionMismatch(
      `Expected ${describeSnapshotNode(target.node)} value ${JSON.stringify(expectation.value)}, received ${JSON.stringify(target.node.value)}.`,
    )
  }

  if (expectation.type !== null && target.node.type !== expectation.type) {
    return assertionMismatch(`Expected type ${expectation.type}, received ${target.node.type}.`)
  }

  if (expectation.enabled !== null && (target.node.state?.disabled === true) === expectation.enabled) {
    return assertionMismatch(
      expectation.enabled
        ? `Expected ${describeSnapshotNode(target.node)} to be enabled.`
        : `Expected ${describeSnapshotNode(target.node)} to be disabled.`,
    )
  }

  if (expectation.selected !== null && nodeStateBoolean(target.node.state, "selected") !== expectation.selected) {
    return assertionMismatch(
      expectation.selected
        ? `Expected ${describeSnapshotNode(target.node)} to be selected.`
        : `Expected ${describeSnapshotNode(target.node)} to be unselected.`,
    )
  }

  if (expectation.focused !== null && nodeStateBoolean(target.node.state, "focused") !== expectation.focused) {
    return assertionMismatch(
      expectation.focused
        ? `Expected ${describeSnapshotNode(target.node)} to be focused.`
        : `Expected ${describeSnapshotNode(target.node)} to be unfocused.`,
    )
  }

  if (expectation.interactive !== null && target.node.interactive !== expectation.interactive) {
    return assertionMismatch(
      expectation.interactive
        ? `Expected ${describeSnapshotNode(target.node)} to be interactive.`
        : `Expected ${describeSnapshotNode(target.node)} to be non-interactive.`,
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
  switch (action.kind) {
    case "press":
      return action.durationMs > 0 ? null : "Press duration must be a positive number of milliseconds."
    case "video":
      return Number.isFinite(action.durationMs) && action.durationMs > 0
        ? null
        : "Video duration must be a positive number of milliseconds."
    case "scroll":
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

export const isRunnerUiRecordedSessionAction = (
  action: RecordedSessionAction,
): action is RunnerUiRecordedSessionAction =>
  action.kind === "tap"
  || action.kind === "press"
  || action.kind === "swipe"
  || action.kind === "type"
  || action.kind === "scroll"

const buildRunnerLocator = (
  snapshot: StoredSnapshotArtifact,
  resolved: ResolvedSnapshotTarget,
): RunnerActionLocator => {
  const semantic = buildStableSemanticSelector(resolved)
  const matches = semanticMatches(snapshot, semantic)
  const matchIndex = matches.findIndex((entry) => entry.ref === resolved.ref)

  return {
    identifier: semantic.identifier,
    label: semantic.label,
    value: semantic.value,
    placeholder: semantic.placeholder,
    type: semantic.type,
    section: semantic.section,
    interactive: semantic.interactive,
    ordinal: matches.length > 1 && matchIndex >= 0 ? matchIndex + 1 : null,
  }
}

export const buildRunnerUiActionPayload = (
  action: RunnerUiActionSource,
  resolved: ResolvedSnapshotTarget,
  snapshot: StoredSnapshotArtifact,
): RunnerUiActionPayload => {
  switch (action.kind) {
    case "tap":
      return {
        kind: action.kind,
        locator: buildRunnerLocator(snapshot, resolved),
        direction: null,
        text: null,
        replace: null,
        steps: null,
        durationMs: null,
      }
    case "press":
      return {
        kind: action.kind,
        locator: buildRunnerLocator(snapshot, resolved),
        direction: null,
        text: null,
        replace: null,
        steps: null,
        durationMs: action.durationMs,
      }
    case "swipe":
      return {
        kind: action.kind,
        locator: buildRunnerLocator(snapshot, resolved),
        direction: action.direction,
        text: null,
        replace: null,
        steps: null,
        durationMs: null,
      }
    case "type":
      return {
        kind: action.kind,
        locator: buildRunnerLocator(snapshot, resolved),
        direction: null,
        text: action.text,
        replace: action.replace,
        steps: null,
        durationMs: null,
      }
    case "scroll":
      return {
        kind: action.kind,
        locator: buildRunnerLocator(snapshot, resolved),
        direction: action.direction,
        text: null,
        replace: null,
        steps: action.steps,
        durationMs: null,
      }
  }
}

export const decodeSessionAction = Schema.decodeUnknownSync(SessionActionSchema)
export const decodeActionRecordingScript = Schema.decodeUnknownSync(ActionRecordingScriptSchema)
