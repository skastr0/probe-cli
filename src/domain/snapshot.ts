import { Schema } from "effect"
import type {
  ArtifactRecord as ArtifactRecordModel,
  CommandRetryMetadata,
  OutputMode,
  OutputThreshold,
} from "./output"
import { ArtifactRecord, countLines } from "./output"
import { CommandRetryMetadataSchema } from "./output"

const NullableBoolean = Schema.Union(Schema.Boolean, Schema.Null)
const NullableNumber = Schema.Union(Schema.Number, Schema.Null)
const NullableString = Schema.Union(Schema.String, Schema.Null)
const OptionalNullableBoolean = Schema.Union(Schema.Boolean, Schema.Null, Schema.Undefined)
const OptionalNullableNumber = Schema.Union(Schema.Number, Schema.Null, Schema.Undefined)
const OptionalNullableString = Schema.Union(Schema.String, Schema.Null, Schema.Undefined)

export const SnapshotPreviewKind = Schema.Literal("interactive", "collapsed")
export type SnapshotPreviewKind = typeof SnapshotPreviewKind.Type

export const SnapshotDiffKind = Schema.Literal("initial", "unchanged", "changed")
export type SnapshotDiffKind = typeof SnapshotDiffKind.Type

export const SnapshotDiffHighlightKind = Schema.Literal("added", "removed", "updated", "remapped")
export type SnapshotDiffHighlightKind = typeof SnapshotDiffHighlightKind.Type

export const SnapshotFrameSchema = Schema.Struct({
  x: Schema.Number,
  y: Schema.Number,
  width: Schema.Number,
  height: Schema.Number,
})
export type SnapshotFrame = typeof SnapshotFrameSchema.Type

export const SnapshotNodeStateSchema = Schema.Struct({
  disabled: NullableBoolean,
  selected: NullableBoolean,
  focused: NullableBoolean,
})
export type SnapshotNodeState = typeof SnapshotNodeStateSchema.Type

export const SnapshotMetricsSchema = Schema.Struct({
  rawNodeCount: Schema.Number,
  nodeCount: Schema.Number,
  interactiveNodeCount: Schema.Number,
  maxDepth: Schema.Number,
  weakIdentityNodeCount: Schema.Number,
  preservedRefCount: Schema.Number,
  newRefCount: Schema.Number,
  remappedRefCount: Schema.Number,
  staleRefCount: Schema.Number,
})
export type SnapshotMetrics = typeof SnapshotMetricsSchema.Type

export const SnapshotDiffSummarySchema = Schema.Struct({
  added: Schema.Number,
  removed: Schema.Number,
  updated: Schema.Number,
  remapped: Schema.Number,
  stale: Schema.Number,
})
export type SnapshotDiffSummary = typeof SnapshotDiffSummarySchema.Type

export const SnapshotDiffHighlightSchema = Schema.Struct({
  kind: SnapshotDiffHighlightKind,
  ref: Schema.String,
  description: Schema.String,
})
export type SnapshotDiffHighlight = typeof SnapshotDiffHighlightSchema.Type

export const SnapshotRemappedRefSchema = Schema.Struct({
  ref: Schema.String,
  description: Schema.String,
})
export type SnapshotRemappedRef = typeof SnapshotRemappedRefSchema.Type

export const SnapshotDiffSchema = Schema.Struct({
  kind: SnapshotDiffKind,
  previousSnapshotId: NullableString,
  summary: SnapshotDiffSummarySchema,
  highlights: Schema.Array(SnapshotDiffHighlightSchema),
  staleRefs: Schema.Array(Schema.String),
  remappedRefs: Schema.Array(SnapshotRemappedRefSchema),
})
export type SnapshotDiff = typeof SnapshotDiffSchema.Type

export const SnapshotPreviewItemSchema = Schema.Struct({
  ref: Schema.String,
  depth: Schema.Number,
  type: Schema.String,
  identifier: NullableString,
  label: NullableString,
  value: NullableString,
  placeholder: NullableString,
  state: Schema.Union(SnapshotNodeStateSchema, Schema.Null),
  interactive: Schema.Boolean,
  section: NullableString,
  childCount: NullableNumber,
})
export type SnapshotPreviewItem = typeof SnapshotPreviewItemSchema.Type

export const SnapshotPreviewSchema = Schema.Struct({
  kind: SnapshotPreviewKind,
  totalNodes: Schema.Number,
  omittedNodes: Schema.Number,
  nodes: Schema.Array(SnapshotPreviewItemSchema),
})
export type SnapshotPreview = typeof SnapshotPreviewSchema.Type

export const SessionSnapshotResultSchema = Schema.Struct({
  snapshotId: Schema.String,
  capturedAt: Schema.String,
  previousSnapshotId: NullableString,
  statusLabel: NullableString,
  summary: Schema.String,
  artifact: ArtifactRecord,
  preview: Schema.Union(SnapshotPreviewSchema, Schema.Null),
  metrics: SnapshotMetricsSchema,
  diff: SnapshotDiffSchema,
  warnings: Schema.Array(Schema.String),
  ...CommandRetryMetadataSchema.fields,
})
export type SessionSnapshotResult = typeof SessionSnapshotResultSchema.Type

export interface RunnerSnapshotNode {
  readonly type: string
  readonly identifier: string | null
  readonly label: string | null
  readonly value: string | null
  readonly placeholder: string | null
  readonly frame: SnapshotFrame | null
  readonly state: SnapshotNodeState | null
  readonly interactive: boolean
  readonly children: ReadonlyArray<RunnerSnapshotNode>
}

export interface RunnerSnapshotPayload {
  readonly capturedAt: string
  readonly statusLabel: string | null
  readonly metrics: {
    readonly rawNodeCount: number
    readonly prunedNodeCount: number
    readonly interactiveNodeCount: number
  }
  readonly root: RunnerSnapshotNode
}

interface RunnerSnapshotNodeContract {
  readonly type: string
  readonly identifier: string | null | undefined
  readonly label: string | null | undefined
  readonly value: string | null | undefined
  readonly placeholder: string | null | undefined
  readonly frame: SnapshotFrame | null | undefined
  readonly state: {
    readonly disabled: boolean | null | undefined
    readonly selected: boolean | null | undefined
    readonly focused: boolean | null | undefined
  } | null | undefined
  readonly interactive: boolean
  readonly children: ReadonlyArray<RunnerSnapshotNodeContract>
}

interface RunnerSnapshotPayloadContract {
  readonly capturedAt: string
  readonly statusLabel: string | null | undefined
  readonly metrics: {
    readonly rawNodeCount: number
    readonly prunedNodeCount: number
    readonly interactiveNodeCount: number
  }
  readonly root: RunnerSnapshotNodeContract
}

export interface StoredSnapshotNode {
  readonly ref: string
  readonly type: string
  readonly identifier: string | null
  readonly label: string | null
  readonly value: string | null
  readonly placeholder: string | null
  readonly frame: SnapshotFrame | null
  readonly state: SnapshotNodeState | null
  readonly interactive: boolean
  readonly identity: "strong" | "weak"
  readonly children: ReadonlyArray<StoredSnapshotNode>
}

export interface StoredSnapshotRendering {
  readonly totalNodes: number
  readonly nodes: ReadonlyArray<SnapshotPreviewItem>
}

export interface StoredSnapshotArtifact {
  readonly contract: "probe.snapshot/artifact-v1"
  readonly snapshotId: string
  readonly capturedAt: string
  readonly previousSnapshotId: string | null
  readonly statusLabel: string | null
  readonly metrics: SnapshotMetrics
  readonly diff: SnapshotDiff
  readonly warnings: ReadonlyArray<string>
  readonly root: StoredSnapshotNode
  readonly renderings: {
    readonly interactive: StoredSnapshotRendering
    readonly collapsed: StoredSnapshotRendering
  }
}

export const StoredSnapshotNodeSchema: Schema.Schema<StoredSnapshotNode> = Schema.suspend(() =>
  Schema.Struct({
    ref: Schema.String,
    type: Schema.String,
    identifier: NullableString,
    label: NullableString,
    value: NullableString,
    placeholder: NullableString,
    frame: Schema.Union(SnapshotFrameSchema, Schema.Null),
    state: Schema.Union(SnapshotNodeStateSchema, Schema.Null),
    interactive: Schema.Boolean,
    identity: Schema.Literal("strong", "weak"),
    children: Schema.Array(StoredSnapshotNodeSchema),
  })
)

export const StoredSnapshotRenderingSchema = Schema.Struct({
  totalNodes: Schema.Number,
  nodes: Schema.Array(SnapshotPreviewItemSchema),
})

export const StoredSnapshotArtifactSchema: Schema.Schema<StoredSnapshotArtifact> = Schema.Struct({
  contract: Schema.Literal("probe.snapshot/artifact-v1"),
  snapshotId: Schema.String,
  capturedAt: Schema.String,
  previousSnapshotId: NullableString,
  statusLabel: NullableString,
  metrics: SnapshotMetricsSchema,
  diff: SnapshotDiffSchema,
  warnings: Schema.Array(Schema.String),
  root: StoredSnapshotNodeSchema,
  renderings: Schema.Struct({
    interactive: StoredSnapshotRenderingSchema,
    collapsed: StoredSnapshotRenderingSchema,
  }),
})

interface SnapshotLikeNode {
  readonly type: string
  readonly identifier: string | null
  readonly label: string | null
  readonly value: string | null
  readonly placeholder: string | null
  readonly frame: SnapshotFrame | null
  readonly state: SnapshotNodeState | null
  readonly interactive: boolean
  readonly children: ReadonlyArray<SnapshotLikeNode>
}

interface FlattenedSnapshotNode<TNode extends SnapshotLikeNode> {
  readonly node: TNode
  readonly sourcePath: string
  readonly depth: number
  readonly strongKey: string | null
  readonly weakKey: string
  readonly structuralKey: string
}

type RefAssignmentKind = "new" | "preserved-strong" | "preserved-weak" | "remapped-structural"

interface RefAssignment {
  readonly ref: string
  readonly kind: RefAssignmentKind
}

export interface BuildSnapshotArtifactResult {
  readonly artifact: StoredSnapshotArtifact
  readonly nextSnapshotIndex: number
  readonly nextElementRefIndex: number
}

export const snapshotPreviewThreshold: OutputThreshold = {
  maxInlineBytes: 24 * 1024,
  maxInlineLines: 700,
}

// Heuristic from the simulator-only large AX tree spike against generated ProbeFixture profiles.
export const snapshotInteractivePreviewLimit = 50
export const snapshotCollapsedPreviewLimit = 55

const staleRefListLimit = 20
const snapshotDiffHighlightLimit = 12

const frameKey = (frame: SnapshotFrame | null): string => {
  if (frame === null) {
    return ""
  }

  return `${frame.x},${frame.y},${frame.width},${frame.height}`
}

const stateKey = (state: SnapshotNodeState | null): string => {
  if (state === null) {
    return ""
  }

  return [
    state.disabled === true ? "disabled" : "enabled",
    state.selected === true ? "selected" : "unselected",
    state.focused === true ? "focused" : "unfocused",
  ].join("|")
}

const nodeDescriptor = (node: Pick<SnapshotLikeNode, "type" | "identifier" | "label" | "value" | "placeholder">): string => {
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

const namedContextToken = (node: Pick<SnapshotLikeNode, "identifier" | "label" | "value" | "placeholder">): string | null =>
  node.identifier ?? node.label ?? node.value ?? node.placeholder

const groupByKey = <T extends { readonly ref: string }>(entries: ReadonlyArray<T>, keyOf: (entry: T) => string | null): Map<string, Array<T>> => {
  const grouped = new Map<string, Array<T>>()

  for (const entry of entries) {
    const key = keyOf(entry)

    if (!key) {
      continue
    }

    const existing = grouped.get(key) ?? []
    existing.push(entry)
    grouped.set(key, existing)
  }

  return grouped
}

const claimUniqueCandidate = <T extends { readonly ref: string }>(
  grouped: ReadonlyMap<string, ReadonlyArray<T>>,
  key: string | null,
  usedRefs: ReadonlySet<string>,
): T | null => {
  if (!key) {
    return null
  }

  const available = (grouped.get(key) ?? []).filter((entry) => !usedRefs.has(entry.ref))
  return available.length === 1 ? available[0] : null
}

const flattenSnapshotNodes = <TNode extends SnapshotLikeNode>(root: TNode): Array<FlattenedSnapshotNode<TNode>> => {
  const entries: Array<FlattenedSnapshotNode<TNode>> = []

  const visit = (
    node: TNode,
    sourcePath: string,
    depth: number,
    namedAncestors: ReadonlyArray<string>,
    sameTypeIndex: number,
  ) => {
    const contextPath = namedAncestors.slice(-3).join(" > ")
    const childCount = node.children.length

    entries.push({
      node,
      sourcePath,
      depth,
      strongKey: node.identifier ? `${node.type}|${node.identifier}` : null,
      weakKey: [
        node.type,
        contextPath,
        String(sameTypeIndex),
        String(childCount),
        node.label ?? "",
        node.value ?? "",
        node.placeholder ?? "",
        frameKey(node.frame),
        stateKey(node.state),
        node.interactive ? "interactive" : "static",
      ].join("|"),
      structuralKey: [
        node.type,
        contextPath,
        String(sameTypeIndex),
        String(childCount),
        node.interactive ? "interactive" : "static",
      ].join("|"),
    })

    const nextNamedAncestors = (() => {
      const token = namedContextToken(node)
      return token ? [...namedAncestors, token] : [...namedAncestors]
    })()
    const siblingTypeCounts = new Map<string, number>()

    node.children.forEach((child, index) => {
      const childNode = child as TNode
      const siblingIndex = siblingTypeCounts.get(child.type) ?? 0
      siblingTypeCounts.set(child.type, siblingIndex + 1)
      visit(childNode, `${sourcePath}.${index}`, depth + 1, nextNamedAncestors, siblingIndex)
    })
  }

  visit(root, "0", 0, [], 0)
  return entries
}

const buildStoredNode = (
  node: RunnerSnapshotNode,
  sourcePath: string,
  assignments: ReadonlyMap<string, RefAssignment>,
): StoredSnapshotNode => {
  const assignment = assignments.get(sourcePath)

  if (!assignment) {
    throw new Error(`Missing stable ref assignment for snapshot path ${sourcePath}.`)
  }

  return {
    ref: assignment.ref,
    type: node.type,
    identifier: node.identifier,
    label: node.label,
    value: node.value,
    placeholder: node.placeholder,
    frame: node.frame,
    state: node.state,
    interactive: node.interactive,
    identity: node.identifier ? "strong" : "weak",
    children: node.children.map((child, index) =>
      buildStoredNode(child, `${sourcePath}.${index}`, assignments),
    ),
  }
}

const flattenStoredNodes = (root: StoredSnapshotNode) => {
  const flat = flattenSnapshotNodes(root)
  return flat.map((entry) => ({
    ...entry,
    ref: entry.node.ref,
  }))
}

const isMeaningfulNode = (node: SnapshotLikeNode): boolean =>
  node.interactive || node.identifier !== null || node.label !== null || node.value !== null

const changedFields = (previous: StoredSnapshotNode, current: StoredSnapshotNode): Array<string> => {
  const changed: Array<string> = []

  if (previous.type !== current.type) {
    changed.push("type")
  }

  if (previous.identifier !== current.identifier) {
    changed.push("identifier")
  }

  if (previous.label !== current.label) {
    changed.push("label")
  }

  if (previous.value !== current.value) {
    changed.push("value")
  }

  if (previous.placeholder !== current.placeholder) {
    changed.push("placeholder")
  }

  if (frameKey(previous.frame) !== frameKey(current.frame)) {
    changed.push("frame")
  }

  if (stateKey(previous.state) !== stateKey(current.state)) {
    changed.push("state")
  }

  if (previous.interactive !== current.interactive) {
    changed.push("interactive")
  }

  if (previous.children.length !== current.children.length) {
    changed.push("child-count")
  }

  return changed
}

const nodeImportance = (node: SnapshotLikeNode): number => (
  (node.interactive ? 8 : 0)
  + (node.identifier ? 4 : 0)
  + (node.label ? 2 : 0)
  + (node.value ? 1 : 0)
)

const shouldCollapseNode = (node: StoredSnapshotNode): boolean =>
  node.children.length === 1
  && node.identifier === null
  && node.label === null
  && node.value === null
  && node.placeholder === null
  && node.frame === null
  && node.state === null
  && !node.interactive

const collectInteractivePreviewItems = (
  node: StoredSnapshotNode,
  depth: number,
  section: string | null,
  items: Array<SnapshotPreviewItem>,
) => {
  const nextSection = namedContextToken(node) ?? section

  if (node.interactive) {
    items.push({
      ref: node.ref,
      depth,
      type: node.type,
      identifier: node.identifier,
      label: node.label,
      value: node.value,
      placeholder: node.placeholder,
      state: node.state,
      interactive: true,
      section,
      childCount: null,
    })
  }

  node.children.forEach((child) => {
    collectInteractivePreviewItems(child, depth + 1, nextSection, items)
  })
}

const collectCollapsedPreviewItems = (
  node: StoredSnapshotNode,
  depth: number,
  items: Array<SnapshotPreviewItem>,
) => {
  if (shouldCollapseNode(node)) {
    node.children.forEach((child) => {
      collectCollapsedPreviewItems(child, depth, items)
    })
    return
  }

  items.push({
    ref: node.ref,
    depth,
    type: node.type,
    identifier: node.identifier,
    label: node.label,
    value: node.value,
    placeholder: node.placeholder,
    state: node.state,
    interactive: node.interactive,
    section: null,
    childCount: node.children.length > 0 ? node.children.length : null,
  })

  node.children.forEach((child) => {
    collectCollapsedPreviewItems(child, depth + 1, items)
  })
}

const buildPreview = (
  kind: SnapshotPreviewKind,
  rendering: StoredSnapshotRendering,
  limit: number,
): SnapshotPreview => ({
  kind,
  totalNodes: rendering.totalNodes,
  omittedNodes: Math.max(rendering.totalNodes - limit, 0),
  nodes: rendering.nodes.slice(0, limit),
})

const previewFitsBudget = (preview: SnapshotPreview, threshold: OutputThreshold): boolean => {
  const content = JSON.stringify(preview, null, 2)
  return Buffer.byteLength(content, "utf8") <= threshold.maxInlineBytes && countLines(content) <= threshold.maxInlineLines
}

const buildWarnings = (args: {
  readonly weakIdentityNodeCount: number
  readonly remappedRefs: ReadonlyArray<SnapshotRemappedRef>
  readonly duplicateIdentifierWarnings: ReadonlyArray<string>
}): Array<string> => {
  const warnings: Array<string> = [...args.duplicateIdentifierWarnings]

  if (args.weakIdentityNodeCount > 0) {
    warnings.push(
      `${args.weakIdentityNodeCount} nodes lack accessibility identifiers and rely on weak identity matching (label/value/frame/structure); their refs may be less durable across dynamic updates.`,
    )
  }

  if (args.remappedRefs.length > 0) {
    warnings.push(
      `${args.remappedRefs.length} refs were remapped with weak structural matching; add stable accessibility identifiers to make these nodes durable.`,
    )
  }

  return warnings
}

const SnapshotNodeStateContractSchema = Schema.Struct({
  disabled: OptionalNullableBoolean,
  selected: OptionalNullableBoolean,
  focused: OptionalNullableBoolean,
})

const SnapshotFrameContractSchema = Schema.Struct({
  x: Schema.Number,
  y: Schema.Number,
  width: Schema.Number,
  height: Schema.Number,
})

const RunnerSnapshotNodeContractSchema: Schema.Schema<RunnerSnapshotNodeContract> = Schema.suspend(() =>
  Schema.Struct({
    type: Schema.String,
    identifier: OptionalNullableString,
    label: OptionalNullableString,
    value: OptionalNullableString,
    placeholder: OptionalNullableString,
    frame: Schema.Union(SnapshotFrameContractSchema, Schema.Null, Schema.Undefined),
    state: Schema.Union(SnapshotNodeStateContractSchema, Schema.Null, Schema.Undefined),
    interactive: Schema.Boolean,
    children: Schema.Array(RunnerSnapshotNodeContractSchema),
  }),
)

const RunnerSnapshotPayloadContractSchema = Schema.Struct({
  capturedAt: Schema.String,
  statusLabel: OptionalNullableString,
  metrics: Schema.Struct({
    rawNodeCount: Schema.Number,
    prunedNodeCount: Schema.Number,
    interactiveNodeCount: Schema.Number,
  }),
  root: RunnerSnapshotNodeContractSchema,
})

const decodeRunnerSnapshotPayloadContractSync = Schema.decodeUnknownSync(RunnerSnapshotPayloadContractSchema)
const decodeStoredSnapshotArtifactSync = Schema.decodeUnknownSync(StoredSnapshotArtifactSchema)

const normalizeNullableString = (value: unknown): string | null =>
  typeof value === "string" ? value : null

const normalizeNullableNumber = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null

const decodeWithLabel = <T>(label: string, decode: (value: unknown) => T, value: unknown): T => {
  try {
    return decode(value)
  } catch (error) {
    throw new Error(`Invalid ${label}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

const normalizeSnapshotState = (value: unknown): SnapshotNodeState | null => {
  if (typeof value !== "object" || value === null) {
    return null
  }

  const record = value as Record<string, unknown>
  const state: SnapshotNodeState = {
    disabled: typeof record.disabled === "boolean" ? record.disabled : null,
    selected: typeof record.selected === "boolean" ? record.selected : null,
    focused: typeof record.focused === "boolean" ? record.focused : null,
  }

  return state.disabled === null && state.selected === null && state.focused === null
    ? null
    : state
}

const normalizeSnapshotFrame = (value: unknown): SnapshotFrame | null => {
  if (typeof value !== "object" || value === null) {
    return null
  }

  const record = value as Record<string, unknown>
  const x = normalizeNullableNumber(record.x)
  const y = normalizeNullableNumber(record.y)
  const width = normalizeNullableNumber(record.width)
  const height = normalizeNullableNumber(record.height)

  return x === null || y === null || width === null || height === null
    ? null
    : { x, y, width, height }
}

const normalizeRunnerSnapshotNode = (value: unknown): RunnerSnapshotNode => {
  const record = typeof value === "object" && value !== null
    ? value as Record<string, unknown>
    : {}

  return {
    type: typeof record.type === "string" ? record.type : "unknown",
    identifier: normalizeNullableString(record.identifier),
    label: normalizeNullableString(record.label),
    value: normalizeNullableString(record.value),
    placeholder: normalizeNullableString(record.placeholder),
    frame: normalizeSnapshotFrame(record.frame),
    state: normalizeSnapshotState(record.state),
    interactive: record.interactive === true,
    children: Array.isArray(record.children) ? record.children.map(normalizeRunnerSnapshotNode) : [],
  }
}

export const decodeRunnerSnapshotPayload = (content: string): RunnerSnapshotPayload => {
  const raw = decodeWithLabel(
    "runner snapshot payload",
    decodeRunnerSnapshotPayloadContractSync,
    JSON.parse(content) as unknown,
  ) as RunnerSnapshotPayloadContract
  const metricsRecord = typeof raw.metrics === "object" && raw.metrics !== null
    ? raw.metrics as Record<string, unknown>
    : {}

  return {
    capturedAt: typeof raw.capturedAt === "string" ? raw.capturedAt : new Date().toISOString(),
    statusLabel: normalizeNullableString(raw.statusLabel),
    metrics: {
      rawNodeCount: normalizeNullableNumber(metricsRecord.rawNodeCount) ?? 0,
      prunedNodeCount: normalizeNullableNumber(metricsRecord.prunedNodeCount) ?? 0,
      interactiveNodeCount: normalizeNullableNumber(metricsRecord.interactiveNodeCount) ?? 0,
    },
    root: normalizeRunnerSnapshotNode(raw.root),
  }
}

export const decodeStoredSnapshotArtifact = (value: unknown): StoredSnapshotArtifact =>
  decodeWithLabel("stored snapshot artifact", decodeStoredSnapshotArtifactSync, value)

export const buildSnapshotArtifact = (args: {
  readonly previous: StoredSnapshotArtifact | null
  readonly nextSnapshotIndex: number
  readonly nextElementRefIndex: number
  readonly raw: RunnerSnapshotPayload
}): BuildSnapshotArtifactResult => {
  const snapshotId = `@s${args.nextSnapshotIndex}`
  const previousEntries = args.previous ? flattenStoredNodes(args.previous.root) : []
  const currentEntries = flattenSnapshotNodes(args.raw.root)
  const previousByRef = new Map(previousEntries.map((entry) => [entry.ref, entry.node]))
  const previousStrong = groupByKey(previousEntries, (entry) => entry.strongKey)
  const previousWeak = groupByKey(previousEntries, (entry) => entry.weakKey)
  const previousStructural = groupByKey(previousEntries, (entry) => entry.structuralKey)
  const duplicateIdentifierWarnings = (() => {
    const identifierCounts = new Map<string, number>()

    for (const entry of currentEntries) {
      if (!entry.node.identifier) {
        continue
      }

      const key = `${entry.node.type}|${entry.node.identifier}`
      identifierCounts.set(key, (identifierCounts.get(key) ?? 0) + 1)
    }

    return [...identifierCounts.entries()]
      .filter(([, count]) => count > 1)
      .map(([identifierKey, count]) =>
        `${count} nodes reported the duplicate accessibility identity ${identifierKey}; Probe falls back to weaker structural matching for that shape.`,
      )
  })()
  const usedRefs = new Set<string>()
  const assignments = new Map<string, RefAssignment>()
  const remappedRefs: Array<SnapshotRemappedRef> = []
  let nextElementRefIndex = args.nextElementRefIndex

  for (const entry of currentEntries) {
    const strongMatch = claimUniqueCandidate(previousStrong, entry.strongKey, usedRefs)

    if (strongMatch) {
      usedRefs.add(strongMatch.ref)
      assignments.set(entry.sourcePath, {
        ref: strongMatch.ref,
        kind: "preserved-strong",
      })
      continue
    }

    const weakMatch = claimUniqueCandidate(previousWeak, entry.weakKey, usedRefs)

    if (weakMatch) {
      usedRefs.add(weakMatch.ref)
      assignments.set(entry.sourcePath, {
        ref: weakMatch.ref,
        kind: "preserved-weak",
      })
      continue
    }

    const structuralMatch = claimUniqueCandidate(previousStructural, entry.structuralKey, usedRefs)

    if (structuralMatch) {
      usedRefs.add(structuralMatch.ref)
      assignments.set(entry.sourcePath, {
        ref: structuralMatch.ref,
        kind: "remapped-structural",
      })
      remappedRefs.push({
        ref: structuralMatch.ref,
        description: `${structuralMatch.ref} was remapped to ${nodeDescriptor(entry.node)} using weak structural matching.`,
      })
      continue
    }

    assignments.set(entry.sourcePath, {
      ref: `@e${nextElementRefIndex}`,
      kind: "new",
    })
    nextElementRefIndex += 1
  }

  const root = buildStoredNode(args.raw.root, "0", assignments)
  const currentStoredEntries = flattenStoredNodes(root)
  const currentByRef = new Map(currentStoredEntries.map((entry) => [entry.ref, entry.node]))
  const staleEntries = previousEntries.filter((entry) => !usedRefs.has(entry.ref))
  const diffHighlights: Array<SnapshotDiffHighlight & { readonly score: number }> = []

  for (const entry of currentStoredEntries) {
    const previous = previousByRef.get(entry.ref)

    if (!previous) {
      if (isMeaningfulNode(entry.node)) {
        diffHighlights.push({
          kind: "added",
          ref: entry.ref,
          description: `Added ${nodeDescriptor(entry.node)}.`,
          score: 40 + nodeImportance(entry.node),
        })
      }
      continue
    }

    const changed = changedFields(previous, entry.node)

    if (changed.length > 0 && isMeaningfulNode(entry.node)) {
      diffHighlights.push({
        kind: "updated",
        ref: entry.ref,
        description: `Updated ${nodeDescriptor(entry.node)}: ${changed.join(", ")}.`,
        score: 30 + nodeImportance(entry.node),
      })
    }
  }

  for (const entry of staleEntries) {
    if (!isMeaningfulNode(entry.node)) {
      continue
    }

    diffHighlights.push({
      kind: "removed",
      ref: entry.ref,
      description: `Removed ${nodeDescriptor(entry.node)}.`,
      score: 35 + nodeImportance(entry.node),
    })
  }

  for (const remapped of remappedRefs) {
    const current = currentByRef.get(remapped.ref)
    diffHighlights.push({
      kind: "remapped",
      ref: remapped.ref,
      description: remapped.description,
      score: 20 + (current ? nodeImportance(current) : 0),
    })
  }

  diffHighlights.sort((left, right) => right.score - left.score || left.ref.localeCompare(right.ref))

  const interactiveItems: Array<SnapshotPreviewItem> = []
  collectInteractivePreviewItems(root, 0, null, interactiveItems)
  const collapsedItems: Array<SnapshotPreviewItem> = []
  collectCollapsedPreviewItems(root, 0, collapsedItems)
  const metrics: SnapshotMetrics = {
    rawNodeCount: args.raw.metrics.rawNodeCount,
    nodeCount: currentStoredEntries.length,
    interactiveNodeCount: interactiveItems.length,
    maxDepth: currentEntries.reduce((max, entry) => Math.max(max, entry.depth), 0),
    weakIdentityNodeCount: currentStoredEntries.filter((entry) => entry.node.identity === "weak").length,
    preservedRefCount: [...assignments.values()].filter((assignment) => assignment.kind === "preserved-strong" || assignment.kind === "preserved-weak").length,
    newRefCount: [...assignments.values()].filter((assignment) => assignment.kind === "new").length,
    remappedRefCount: remappedRefs.length,
    staleRefCount: staleEntries.length,
  }
  const diffSummary: SnapshotDiffSummary = {
    added: currentStoredEntries.filter((entry) => {
      const previous = previousByRef.get(entry.ref)
      return !previous && !remappedRefs.some((r) => r.ref === entry.ref)
    }).length,
    removed: staleEntries.filter((entry) => !remappedRefs.some((r) => r.ref === entry.ref)).length,
    updated: currentStoredEntries.reduce((count, entry) => {
      const previous = previousByRef.get(entry.ref)
      return count + (previous && changedFields(previous, entry.node).length > 0 ? 1 : 0)
    }, 0),
    remapped: remappedRefs.length,
    stale: staleEntries.length,
  }
  const diff: SnapshotDiff = {
    kind: args.previous === null
      ? "initial"
      : diffSummary.added === 0
          && diffSummary.removed === 0
          && diffSummary.updated === 0
          && diffSummary.remapped === 0
          && diffSummary.stale === 0
        ? "unchanged"
        : "changed",
    previousSnapshotId: args.previous?.snapshotId ?? null,
    summary: diffSummary,
    highlights: diffHighlights.slice(0, snapshotDiffHighlightLimit).map(({ score: _score, ...highlight }) => highlight),
    staleRefs: staleEntries.slice(0, staleRefListLimit).map((entry) => entry.ref),
    remappedRefs,
  }
  const warnings = buildWarnings({
    weakIdentityNodeCount: metrics.weakIdentityNodeCount,
    remappedRefs,
    duplicateIdentifierWarnings,
  })

  return {
    artifact: {
      contract: "probe.snapshot/artifact-v1",
      snapshotId,
      capturedAt: args.raw.capturedAt,
      previousSnapshotId: args.previous?.snapshotId ?? null,
      statusLabel: args.raw.statusLabel,
      metrics,
      diff,
      warnings,
      root,
      renderings: {
        interactive: {
          totalNodes: interactiveItems.length,
          nodes: interactiveItems,
        },
        collapsed: {
          totalNodes: collapsedItems.length,
          nodes: collapsedItems,
        },
      },
    },
    nextSnapshotIndex: args.nextSnapshotIndex + 1,
    nextElementRefIndex,
  }
}

export const buildSessionSnapshotResult = (args: {
  readonly artifact: StoredSnapshotArtifact
  readonly artifactRecord: ArtifactRecordModel
  readonly outputMode: OutputMode
  readonly retry?: CommandRetryMetadata
}): SessionSnapshotResult => {
  const retry = args.retry ?? {
    retryCount: 0,
    retryReasons: [],
  }
  const interactivePreview = buildPreview(
    "interactive",
    args.artifact.renderings.interactive,
    snapshotInteractivePreviewLimit,
  )
  const collapsedPreview = buildPreview(
    "collapsed",
    args.artifact.renderings.collapsed,
    snapshotCollapsedPreviewLimit,
  )
  const preview = (() => {
    if (args.outputMode === "artifact") {
      return null
    }

    if (
      args.artifact.renderings.interactive.totalNodes <= snapshotInteractivePreviewLimit
      && (args.outputMode === "inline" || previewFitsBudget(interactivePreview, snapshotPreviewThreshold))
    ) {
      return interactivePreview
    }

    if (args.outputMode === "inline" || previewFitsBudget(collapsedPreview, snapshotPreviewThreshold)) {
      return collapsedPreview
    }

    return null
  })()
  const previewSummary = (() => {
    if (args.outputMode === "artifact") {
      return "inline preview omitted because artifact output was requested"
    }

    if (preview === null) {
      return `inline preview omitted because the compact preview still exceeds the ${snapshotPreviewThreshold.maxInlineBytes} byte / ${snapshotPreviewThreshold.maxInlineLines} line snapshot budget`
    }

    const shown = preview.nodes.length
    return preview.omittedNodes > 0
      ? `inline ${preview.kind} preview includes ${shown} of ${preview.totalNodes} nodes`
      : `inline ${preview.kind} preview includes ${shown} nodes`
  })()
  const diffSummary = args.artifact.diff.kind === "initial"
    ? "initial snapshot"
    : args.artifact.diff.summary.remapped > 0
      ? `${args.artifact.diff.summary.added} added, ${args.artifact.diff.summary.removed} removed, ${args.artifact.diff.summary.updated} updated (${args.artifact.diff.summary.remapped} refs weakly remapped)`
      : `${args.artifact.diff.summary.added} added, ${args.artifact.diff.summary.removed} removed, ${args.artifact.diff.summary.updated} updated (stable)`
  const refStabilitySummary = (() => {
    const { preservedRefCount, weakIdentityNodeCount, remappedRefCount } = args.artifact.metrics
    const total = args.artifact.metrics.nodeCount
    const strongRatio = preservedRefCount / total
    if (remappedRefCount > 0) {
      return `${remappedRefCount} weakly remapped; consider adding accessibility identifiers`
    }
    if (weakIdentityNodeCount > 0) {
      return `${weakIdentityNodeCount} nodes have weak identity; refs may drift`
    }
    if (strongRatio >= 0.9) {
      return "strong ref stability"
    }
    return "partial ref stability"
  })()

  return {
    snapshotId: args.artifact.snapshotId,
    capturedAt: args.artifact.capturedAt,
    previousSnapshotId: args.artifact.previousSnapshotId,
    statusLabel: args.artifact.statusLabel,
    summary:
      `Captured ${args.artifact.snapshotId} with ${args.artifact.metrics.nodeCount} nodes (${args.artifact.metrics.interactiveNodeCount} interactive); ${diffSummary}; ${refStabilitySummary}; ${previewSummary}.`,
    artifact: args.artifactRecord,
    preview,
    metrics: args.artifact.metrics,
    diff: args.artifact.diff,
    warnings: [...args.artifact.warnings],
    retryCount: retry.retryCount,
    retryReasons: [...retry.retryReasons],
  }
}
