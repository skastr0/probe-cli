import { Schema } from "effect"
import { ArtifactRecord, NullableString } from "./output"
import type { SnapshotFrame, StoredSnapshotArtifact, StoredSnapshotNode } from "./snapshot"

const nowIso = (): string => new Date().toISOString()

const hasText = (value: string | null): boolean => value !== null && value.trim().length > 0

const knownRoleTypes = new Set([
  "button",
  "switch",
  "textField",
  "secureTextField",
  "textView",
  "segmentedControl",
  "slider",
  "link",
  "tabBar",
  "tabBarItem",
  "menuItem",
  "picker",
  "pickerWheel",
])

const labelFallbackTypes = new Set(["textField", "secureTextField", "textView"])

const frameIntersects = (left: SnapshotFrame, right: SnapshotFrame): boolean =>
  left.x < right.x + right.width
  && left.x + left.width > right.x
  && left.y < right.y + right.height
  && left.y + left.height > right.y

const frameArea = (frame: SnapshotFrame): number => frame.width * frame.height

export const AccessibilityVerdict = Schema.Literal("verified", "configured", "blocked", "unknown")
export type AccessibilityVerdict = typeof AccessibilityVerdict.Type

export const AccessibilityScope = Schema.Literal("current-screen")
export type AccessibilityScope = typeof AccessibilityScope.Type

export const AccessibilityIssueSeverity = Schema.Literal("low", "medium", "high")
export type AccessibilityIssueSeverity = typeof AccessibilityIssueSeverity.Type

export const AccessibilityIssueCategory = Schema.Literal(
  "missing-label",
  "missing-identifier",
  "not-hittable",
  "missing-traits",
)
export type AccessibilityIssueCategory = typeof AccessibilityIssueCategory.Type

export const AccessibilityIssueSchema = Schema.Struct({
  category: AccessibilityIssueCategory,
  severity: AccessibilityIssueSeverity,
  elementRef: Schema.String,
  elementType: Schema.String,
  identifier: NullableString,
  label: NullableString,
  explanation: Schema.String,
})
export type AccessibilityIssue = typeof AccessibilityIssueSchema.Type

export const AccessibilityDoctorCheckSchema = Schema.Struct({
  key: Schema.String,
  verdict: AccessibilityVerdict,
  summary: Schema.String,
  details: Schema.Array(Schema.String),
})
export type AccessibilityDoctorCheck = typeof AccessibilityDoctorCheckSchema.Type

export const AccessibilityDoctorReportSchema = Schema.Struct({
  contract: Schema.Literal("probe.accessibility-doctor/report-v1"),
  generatedAt: Schema.String,
  sessionId: Schema.String,
  summary: Schema.String,
  verdict: AccessibilityVerdict,
  checks: Schema.Array(AccessibilityDoctorCheckSchema),
  warnings: Schema.Array(Schema.String),
  snapshotArtifact: Schema.Union(ArtifactRecord, Schema.Null),
  screenshotArtifact: Schema.Union(ArtifactRecord, Schema.Null),
})
export type AccessibilityDoctorReport = typeof AccessibilityDoctorReportSchema.Type

export const AccessibilityValidationEvidenceSchema = Schema.Struct({
  snapshotId: Schema.String,
  snapshotArtifact: ArtifactRecord,
  screenshotArtifact: ArtifactRecord,
  reportArtifact: Schema.Union(ArtifactRecord, Schema.Null),
})
export type AccessibilityValidationEvidence = typeof AccessibilityValidationEvidenceSchema.Type

export const AccessibilityValidationReportSchema = Schema.Struct({
  contract: Schema.Literal("probe.accessibility-validation/report-v1"),
  executedAt: Schema.String,
  sessionId: Schema.String,
  scope: AccessibilityScope,
  summary: Schema.String,
  verdict: AccessibilityVerdict,
  analyzedElementCount: Schema.Number,
  issueCount: Schema.Number,
  issues: Schema.Array(AccessibilityIssueSchema),
  warnings: Schema.Array(Schema.String),
  evidence: AccessibilityValidationEvidenceSchema,
})
export type AccessibilityValidationReport = typeof AccessibilityValidationReportSchema.Type

interface AccessibilityWalkEntry {
  readonly node: StoredSnapshotNode
  readonly inScope: boolean
}

interface AccessibilityAnalysisResult {
  readonly verdict: AccessibilityVerdict
  readonly analyzedElementCount: number
  readonly issues: ReadonlyArray<AccessibilityIssue>
  readonly warnings: ReadonlyArray<string>
}

const severityRank: Record<AccessibilityIssueSeverity, number> = {
  high: 0,
  medium: 1,
  low: 2,
}

const sortIssues = (issues: ReadonlyArray<AccessibilityIssue>): Array<AccessibilityIssue> =>
  [...issues].sort((left, right) =>
    severityRank[left.severity] - severityRank[right.severity]
    || left.elementRef.localeCompare(right.elementRef)
    || left.category.localeCompare(right.category))

const walkInteractiveNodes = (
  root: StoredSnapshotNode,
  scope: AccessibilityScope,
  viewport: SnapshotFrame | null,
): Array<AccessibilityWalkEntry> => {
  const entries: Array<AccessibilityWalkEntry> = []
  const visit = (node: StoredSnapshotNode) => {
    const inScope = scope !== "current-screen"
      || viewport === null
      || node.frame === null
      || frameIntersects(viewport, node.frame)

    if (node.interactive) {
      entries.push({ node, inScope })
    }

    node.children.forEach(visit)
  }

  visit(root)
  return entries
}

const deriveViewportFrame = (root: StoredSnapshotNode): SnapshotFrame | null => {
  const candidateFrames: Array<SnapshotFrame> = []
  const fallbackFrames: Array<SnapshotFrame> = []
  const visit = (node: StoredSnapshotNode) => {
    if (node.frame !== null) {
      fallbackFrames.push(node.frame)

      if (node.type === "application" || node.type === "window") {
        candidateFrames.push(node.frame)
      }
    }

    node.children.forEach(visit)
  }

  visit(root)

  const frames = candidateFrames.length > 0 ? candidateFrames : fallbackFrames

  if (frames.length === 0) {
    return null
  }

  return [...frames].sort((left, right) => frameArea(right) - frameArea(left))[0] ?? null
}

const nodeHasAccessibleLabel = (node: StoredSnapshotNode): boolean =>
  hasText(node.label)
  || (labelFallbackTypes.has(node.type) && (hasText(node.placeholder) || hasText(node.value)))

const nodeLacksTraits = (node: StoredSnapshotNode): boolean => !knownRoleTypes.has(node.type)

const nodeLikelyNotHittable = (node: StoredSnapshotNode): boolean =>
  node.state?.disabled !== true
  && (node.frame === null || node.frame.width <= 1 || node.frame.height <= 1)

const issueForNode = (args: {
  readonly category: AccessibilityIssueCategory
  readonly severity: AccessibilityIssueSeverity
  readonly node: StoredSnapshotNode
  readonly explanation: string
}): AccessibilityIssue => ({
  category: args.category,
  severity: args.severity,
  elementRef: args.node.ref,
  elementType: args.node.type,
  identifier: args.node.identifier,
  label: args.node.label,
  explanation: args.explanation,
})

export const rollupAccessibilityVerdict = (verdicts: ReadonlyArray<AccessibilityVerdict>): AccessibilityVerdict => {
  if (verdicts.some((verdict) => verdict === "blocked")) {
    return "blocked"
  }

  if (verdicts.length > 0 && verdicts.every((verdict) => verdict === "verified")) {
    return "verified"
  }

  if (verdicts.some((verdict) => verdict === "verified" || verdict === "configured")) {
    return "configured"
  }

  return "unknown"
}

const issueSeverityToVerdict = (severity: AccessibilityIssueSeverity): AccessibilityVerdict =>
  severity === "high" ? "blocked" : "configured"

export const evaluateAccessibilitySnapshot = (args: {
  readonly snapshot: StoredSnapshotArtifact
  readonly scope: AccessibilityScope
}): AccessibilityAnalysisResult => {
  const viewport = deriveViewportFrame(args.snapshot.root)
  const warnings: Array<string> = []

  if (viewport === null) {
    warnings.push("Probe could not derive a visible viewport from the snapshot, so current-screen scope fell back to the full captured tree.")
  }

  warnings.push(
    "Probe currently derives accessibility issues from the XCUI snapshot tree and stable-ref metadata; dedicated Apple accessibility audit APIs are not wired into this lane yet.",
  )

  const interactiveEntries = walkInteractiveNodes(args.snapshot.root, args.scope, viewport)
  const inScopeEntries = interactiveEntries.filter((entry) => entry.inScope)
  const issues: Array<AccessibilityIssue> = []

  for (const entry of inScopeEntries) {
    const { node } = entry

    if (!nodeHasAccessibleLabel(node)) {
      issues.push(issueForNode({
        category: "missing-label",
        severity: "high",
        node,
        explanation: `Interactive ${node.type} ${node.ref} is missing an accessibility label${labelFallbackTypes.has(node.type) ? " or placeholder/value fallback" : ""}.`,
      }))
    }

    if (!hasText(node.identifier)) {
      issues.push(issueForNode({
        category: "missing-identifier",
        severity: "medium",
        node,
        explanation: `Interactive ${node.type} ${node.ref} is missing a stable accessibility identifier, so Probe refs may drift across updates.`,
      }))
    }

    if (nodeLikelyNotHittable(node)) {
      issues.push(issueForNode({
        category: "not-hittable",
        severity: "high",
        node,
        explanation: `Interactive ${node.type} ${node.ref} does not expose a usable frame in the current snapshot, so it is unlikely to be hittable on the visible screen.`,
      }))
    }

    if (nodeLacksTraits(node)) {
      issues.push(issueForNode({
        category: "missing-traits",
        severity: "medium",
        node,
        explanation: `Interactive ${node.type} ${node.ref} is exposed as a generic role instead of a strong accessibility control type, which suggests missing accessibility traits.`,
      }))
    }
  }

  if (interactiveEntries.length === 0) {
    warnings.push("The captured snapshot did not expose any interactive elements on the analyzed screen.")
  }

  const sortedIssues = sortIssues(issues)
  const verdict = sortedIssues.length === 0
    ? "verified"
    : rollupAccessibilityVerdict(sortedIssues.map((issue) => issueSeverityToVerdict(issue.severity)))

  return {
    verdict,
    analyzedElementCount: inScopeEntries.length,
    issues: sortedIssues,
    warnings,
  }
}

export const buildAccessibilityDoctorReport = (args: {
  readonly sessionId: string
  readonly checks: ReadonlyArray<AccessibilityDoctorCheck>
  readonly warnings?: ReadonlyArray<string>
  readonly snapshotArtifact?: typeof ArtifactRecord.Type | null
  readonly screenshotArtifact?: typeof ArtifactRecord.Type | null
}): AccessibilityDoctorReport => ({
  contract: "probe.accessibility-doctor/report-v1",
  generatedAt: nowIso(),
  sessionId: args.sessionId,
  summary: `Accessibility doctor recorded ${args.checks.length} check${args.checks.length === 1 ? "" : "s"} for session ${args.sessionId}.`,
  verdict: rollupAccessibilityVerdict(args.checks.map((check) => check.verdict)),
  checks: [...args.checks],
  warnings: [...(args.warnings ?? [])],
  snapshotArtifact: args.snapshotArtifact ?? null,
  screenshotArtifact: args.screenshotArtifact ?? null,
})

export const buildAccessibilityValidationReport = (args: {
  readonly sessionId: string
  readonly scope: AccessibilityScope
  readonly analyzedElementCount: number
  readonly issues: ReadonlyArray<AccessibilityIssue>
  readonly warnings?: ReadonlyArray<string>
  readonly evidence: {
    readonly snapshotId: string
    readonly snapshotArtifact: typeof ArtifactRecord.Type
    readonly screenshotArtifact: typeof ArtifactRecord.Type
    readonly reportArtifact?: typeof ArtifactRecord.Type | null
  }
}): AccessibilityValidationReport => {
  const highSeverityCount = args.issues.filter((issue) => issue.severity === "high").length
  const verdict = args.issues.length === 0
    ? "verified"
    : rollupAccessibilityVerdict(args.issues.map((issue) => issueSeverityToVerdict(issue.severity)))

  return {
    contract: "probe.accessibility-validation/report-v1",
    executedAt: nowIso(),
    sessionId: args.sessionId,
    scope: args.scope,
    summary: args.issues.length === 0
      ? `Accessibility validation scanned ${args.analyzedElementCount} interactive element${args.analyzedElementCount === 1 ? "" : "s"} on the current screen and found no issues.`
      : `Accessibility validation scanned ${args.analyzedElementCount} interactive element${args.analyzedElementCount === 1 ? "" : "s"} on the current screen and found ${args.issues.length} issue${args.issues.length === 1 ? "" : "s"}${highSeverityCount > 0 ? ` (${highSeverityCount} blocking)` : ""}.`,
    verdict,
    analyzedElementCount: args.analyzedElementCount,
    issueCount: args.issues.length,
    issues: [...args.issues],
    warnings: [...(args.warnings ?? [])],
    evidence: {
      snapshotId: args.evidence.snapshotId,
      snapshotArtifact: args.evidence.snapshotArtifact,
      screenshotArtifact: args.evidence.screenshotArtifact,
      reportArtifact: args.evidence.reportArtifact ?? null,
    },
  }
}
