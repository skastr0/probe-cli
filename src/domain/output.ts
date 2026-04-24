import { Schema } from "effect"

export const NullableString = Schema.Union(Schema.String, Schema.Null)
export type NullableString = typeof NullableString.Type

export const NullableNumber = Schema.Union(Schema.Number, Schema.Null)
export type NullableNumber = typeof NullableNumber.Type

export const OutputMode = Schema.Literal("auto", "inline", "artifact")
export type OutputMode = typeof OutputMode.Type

export const OutputFormat = Schema.Literal("json", "text")
export type OutputFormat = typeof OutputFormat.Type

export const ArtifactKind = Schema.Literal("json", "text", "ndjson", "xml", "directory", "png", "mp4", "mov", "binary")
export type ArtifactKind = typeof ArtifactKind.Type

export const SessionLogSource = Schema.Literal("runner", "build", "wrapper", "stdout", "simulator")
export type SessionLogSource = typeof SessionLogSource.Type

export const SessionLogMarker = Schema.Struct({
  timestamp: Schema.String,
  label: Schema.String,
  sessionId: Schema.String,
})
export type SessionLogMarker = typeof SessionLogMarker.Type

export const CommandRetryMetadataSchema = Schema.Struct({
  retryCount: Schema.Number,
  retryReasons: Schema.Array(Schema.String),
})
export type CommandRetryMetadata = typeof CommandRetryMetadataSchema.Type

export const SessionLogDoctorSource = Schema.Struct({
  source: SessionLogSource,
  available: Schema.Boolean,
  reason: Schema.String,
  artifactKey: NullableString,
  artifactPath: NullableString,
})
export type SessionLogDoctorSource = typeof SessionLogDoctorSource.Type

export const SessionLogDoctorReport = Schema.Struct({
  sessionId: Schema.String,
  targetPlatform: Schema.Literal("simulator", "device"),
  summary: Schema.String,
  sources: Schema.Array(SessionLogDoctorSource),
})
export type SessionLogDoctorReport = typeof SessionLogDoctorReport.Type

export const OutputThreshold = Schema.Struct({
  maxInlineBytes: Schema.Number,
  maxInlineLines: Schema.Number,
})
export type OutputThreshold = typeof OutputThreshold.Type

export const ArtifactRecord = Schema.Struct({
  key: Schema.String,
  label: Schema.String,
  kind: ArtifactKind,
  summary: Schema.String,
  absolutePath: Schema.String,
  relativePath: NullableString,
  sizeBytes: Schema.optional(Schema.Number),
  external: Schema.Boolean,
  createdAt: Schema.String,
})
export type ArtifactRecord = typeof ArtifactRecord.Type

export const TextDrillQuery = Schema.Struct({
  kind: Schema.Literal("text"),
  startLine: Schema.Number,
  endLine: Schema.Number,
  match: NullableString,
  contextLines: Schema.Number,
})
export type TextDrillQuery = typeof TextDrillQuery.Type

export const JsonDrillQuery = Schema.Struct({
  kind: Schema.Literal("json"),
  pointer: Schema.String,
})
export type JsonDrillQuery = typeof JsonDrillQuery.Type

export const XmlDrillQuery = Schema.Struct({
  kind: Schema.Literal("xml"),
  xpath: Schema.String,
})
export type XmlDrillQuery = typeof XmlDrillQuery.Type

export const XcresultDrillQuery = Schema.Struct({
  kind: Schema.Literal("xcresult"),
  view: Schema.Literal("summary", "attachments"),
  attachmentId: NullableString,
})
export type XcresultDrillQuery = typeof XcresultDrillQuery.Type

export const DrillQuery = Schema.Union(TextDrillQuery, JsonDrillQuery, XmlDrillQuery, XcresultDrillQuery)
export type DrillQuery = typeof DrillQuery.Type

export const DrillInlineResult = Schema.Struct({
  kind: Schema.Literal("inline"),
  format: OutputFormat,
  summary: Schema.String,
  content: Schema.String,
})
export type DrillInlineResult = typeof DrillInlineResult.Type

export const DrillArtifactResult = Schema.Struct({
  kind: Schema.Literal("summary+artifact"),
  format: OutputFormat,
  summary: Schema.String,
  artifact: ArtifactRecord,
})
export type DrillArtifactResult = typeof DrillArtifactResult.Type

export const DrillResult = Schema.Union(DrillInlineResult, DrillArtifactResult)
export type DrillResult = typeof DrillResult.Type

export const XcresultSummaryInsightSchema = Schema.Struct({
  impact: NullableString,
  category: NullableString,
  text: NullableString,
})
export type XcresultSummaryInsight = typeof XcresultSummaryInsightSchema.Type

export const XcresultSummaryStatisticSchema = Schema.Struct({
  title: NullableString,
  subtitle: NullableString,
})
export type XcresultSummaryStatistic = typeof XcresultSummaryStatisticSchema.Type

export const XcresultSummaryLogPathSchema = Schema.Struct({
  artifactKey: Schema.String,
  path: Schema.String,
  summary: Schema.String,
})
export type XcresultSummaryLogPath = typeof XcresultSummaryLogPathSchema.Type

export const XcresultCoverageTargetSchema = Schema.Struct({
  name: NullableString,
  coveredLines: NullableNumber,
  executableLines: NullableNumber,
  lineCoverage: NullableNumber,
  fileCount: NullableNumber,
})
export type XcresultCoverageTarget = typeof XcresultCoverageTargetSchema.Type

export const XcresultCoverageSchema = Schema.Struct({
  available: Schema.Boolean,
  reason: NullableString,
  coveredLines: NullableNumber,
  executableLines: NullableNumber,
  lineCoverage: NullableNumber,
  targets: Schema.Array(XcresultCoverageTargetSchema),
})
export type XcresultCoverage = typeof XcresultCoverageSchema.Type

export const XcresultFailureSchema = Schema.Struct({
  identifier: Schema.String,
  message: Schema.String,
})
export type XcresultFailure = typeof XcresultFailureSchema.Type

export const XcresultTestIssueSchema = Schema.Struct({
  kind: Schema.Literal("failure", "warning"),
  message: Schema.String,
})
export type XcresultTestIssue = typeof XcresultTestIssueSchema.Type

export const XcresultSummaryTestSchema = Schema.Struct({
  id: NullableString,
  name: Schema.String,
  result: Schema.String,
  duration: NullableString,
  durationInSeconds: NullableNumber,
  issues: Schema.Array(XcresultTestIssueSchema),
})
export type XcresultSummaryTest = typeof XcresultSummaryTestSchema.Type

export const XcresultSummaryTotalsSchema = Schema.Struct({
  totalTests: NullableNumber,
  passedTests: NullableNumber,
  failedTests: NullableNumber,
  skippedTests: NullableNumber,
  expectedFailures: NullableNumber,
})
export type XcresultSummaryTotals = typeof XcresultSummaryTotalsSchema.Type

export const XcresultSummaryTimingsSchema = Schema.Struct({
  startTime: NullableNumber,
  finishTime: NullableNumber,
})
export type XcresultSummaryTimings = typeof XcresultSummaryTimingsSchema.Type

export const XcresultSummaryReportSchema = Schema.Struct({
  kind: Schema.Literal("xcresult-summary"),
  bundlePath: Schema.String,
  bundleName: Schema.String,
  title: Schema.String,
  environmentDescription: NullableString,
  result: Schema.String,
  totals: XcresultSummaryTotalsSchema,
  timings: XcresultSummaryTimingsSchema,
  insights: Schema.Array(XcresultSummaryInsightSchema),
  statistics: Schema.Array(XcresultSummaryStatisticSchema),
  logPaths: Schema.Array(XcresultSummaryLogPathSchema),
  coverage: XcresultCoverageSchema,
  failures: Schema.Array(XcresultFailureSchema),
  tests: Schema.Array(XcresultSummaryTestSchema),
})
export type XcresultSummaryReport = typeof XcresultSummaryReportSchema.Type

export const XcresultAttachmentSchema = Schema.Struct({
  id: Schema.String,
  testIdentifier: Schema.String,
  testIdentifierURL: NullableString,
  exportedFileName: Schema.String,
  name: Schema.String,
  associatedWithFailure: Schema.Boolean,
  timestamp: NullableNumber,
  configurationName: NullableString,
  deviceName: NullableString,
  deviceId: NullableString,
  repetitionNumber: NullableNumber,
  arguments: Schema.Array(Schema.Number),
  mediaType: Schema.String,
  artifactKind: ArtifactKind,
  sizeBytes: Schema.Number,
})
export type XcresultAttachment = typeof XcresultAttachmentSchema.Type

export const XcresultAttachmentsReportSchema = Schema.Struct({
  kind: Schema.Literal("xcresult-attachments"),
  bundlePath: Schema.String,
  bundleName: Schema.String,
  count: Schema.Number,
  attachments: Schema.Array(XcresultAttachmentSchema),
})
export type XcresultAttachmentsReport = typeof XcresultAttachmentsReportSchema.Type

export const SessionResultSummaryResultSchema = Schema.Struct({
  summary: Schema.String,
  artifact: ArtifactRecord,
  report: XcresultSummaryReportSchema,
})
export type SessionResultSummaryResult = typeof SessionResultSummaryResultSchema.Type

export const SessionResultAttachmentsResultSchema = Schema.Struct({
  summary: Schema.String,
  artifact: ArtifactRecord,
  report: XcresultAttachmentsReportSchema,
})
export type SessionResultAttachmentsResult = typeof SessionResultAttachmentsResultSchema.Type

export const SummaryArtifactResult = Schema.Struct({
  kind: Schema.Literal("summary+artifact"),
  summary: Schema.String,
  artifact: ArtifactRecord,
})
export type SummaryArtifactResult = typeof SummaryArtifactResult.Type

export const SessionScreenshotResult = Schema.Struct({
  ...SummaryArtifactResult.fields,
  ...CommandRetryMetadataSchema.fields,
})
export type SessionScreenshotResult = typeof SessionScreenshotResult.Type

export const SessionLogsResult = Schema.Struct({
  sourceArtifact: ArtifactRecord,
  result: DrillResult,
})
export type SessionLogsResult = typeof SessionLogsResult.Type

export const countLines = (text: string): number => {
  if (text.length === 0) {
    return 0
  }

  return text.split(/\r?\n/).length
}

export const shouldInlineOutput = (
  mode: OutputMode,
  threshold: OutputThreshold,
  content: string,
): boolean => {
  if (mode === "inline") {
    return true
  }

  if (mode === "artifact") {
    return false
  }

  return (
    Buffer.byteLength(content, "utf8") <= threshold.maxInlineBytes
    && countLines(content) <= threshold.maxInlineLines
  )
}

export const summarizeContent = (content: string): string => {
  const bytes = Buffer.byteLength(content, "utf8")
  const lines = countLines(content)
  return `${bytes} bytes across ${lines} lines`
}

export const isTextArtifactKind = (kind: ArtifactKind): boolean =>
  kind === "json" || kind === "text" || kind === "ndjson" || kind === "xml"

export const appendSessionLogMarkers = (
  content: string,
  markers: ReadonlyArray<SessionLogMarker>,
): string => {
  if (markers.length === 0) {
    return content
  }

  const markerSection = [
    "probe log markers:",
    ...markers.map((marker) => `[${marker.timestamp}] ${marker.label}`),
  ].join("\n")

  return content.length > 0 ? `${content}\n\n${markerSection}` : markerSection
}
