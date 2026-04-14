import { Schema } from "effect"

export const DiagnosticStatus = Schema.Literal("ready", "degraded", "blocked")
export type DiagnosticStatus = typeof DiagnosticStatus.Type

export const DiagnosticReport = Schema.Struct({
  key: Schema.String,
  status: DiagnosticStatus,
  summary: Schema.String,
  details: Schema.Array(Schema.String),
})
export type DiagnosticReport = typeof DiagnosticReport.Type

export const KnownWall = Schema.Struct({
  key: Schema.String,
  summary: Schema.String,
  details: Schema.Array(Schema.String),
})
export type KnownWall = typeof KnownWall.Type

export const DiagnosticCaptureTarget = Schema.Literal("simulator", "device")
export type DiagnosticCaptureTarget = typeof DiagnosticCaptureTarget.Type

export const DiagnosticCaptureKind = Schema.Literal("sysdiagnose")
export type DiagnosticCaptureKind = typeof DiagnosticCaptureKind.Type
