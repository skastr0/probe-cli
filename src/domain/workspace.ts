import { Schema } from "effect"
import { CapabilityReport } from "./capabilities"
import { DiagnosticReport, KnownWall } from "./diagnostics"
import { OutputThreshold } from "./output"

export const DaemonStatusSummary = Schema.Struct({
  running: Schema.Boolean,
  socketPath: Schema.String,
  metadataPath: Schema.String,
  protocolVersion: Schema.String,
  sessionTtlMs: Schema.Number,
  artifactRetentionMs: Schema.Number,
})
export type DaemonStatusSummary = typeof DaemonStatusSummary.Type

export const WorkspaceStatus = Schema.Struct({
  workspaceRoot: Schema.String,
  artifactRoot: Schema.String,
  outputThreshold: OutputThreshold,
  commands: Schema.Array(Schema.String),
  daemon: DaemonStatusSummary,
  capabilities: Schema.Array(CapabilityReport),
  diagnostics: Schema.Array(DiagnosticReport),
  knownWalls: Schema.Array(KnownWall),
  notes: Schema.Array(Schema.String),
})
export type WorkspaceStatus = typeof WorkspaceStatus.Type
