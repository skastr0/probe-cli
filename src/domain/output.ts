import { Schema } from "effect"

export const NullableString = Schema.Union(Schema.String, Schema.Null)
export type NullableString = typeof NullableString.Type

export const OutputMode = Schema.Literal("auto", "inline", "artifact")
export type OutputMode = typeof OutputMode.Type

export const OutputFormat = Schema.Literal("json", "text")
export type OutputFormat = typeof OutputFormat.Type

export const ArtifactKind = Schema.Literal("json", "text", "ndjson", "xml", "directory", "png")
export type ArtifactKind = typeof ArtifactKind.Type

export const SessionLogSource = Schema.Literal("runner", "build", "wrapper", "stdout", "simulator")
export type SessionLogSource = typeof SessionLogSource.Type

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

export const DrillQuery = Schema.Union(TextDrillQuery, JsonDrillQuery, XmlDrillQuery)
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

export const SummaryArtifactResult = Schema.Struct({
  kind: Schema.Literal("summary+artifact"),
  summary: Schema.String,
  artifact: ArtifactRecord,
})
export type SummaryArtifactResult = typeof SummaryArtifactResult.Type

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
