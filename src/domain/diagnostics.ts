import { Schema } from "effect"
import { BoundedCollectionSchema } from "./bounded"

export const DiagnosticStatus = Schema.Literal("ready", "degraded", "blocked")
export type DiagnosticStatus = typeof DiagnosticStatus.Type

// PRB-094: `details` is the collector's internal, unbounded shape --
// `collectXcodeDiagnostic`/`collectSimulatorDiagnostic`/etc. (ProbeKernel.ts)
// and `buildStartupRecoveryReport`'s stale/corrupt-session lines still build
// and fold a plain `Array<string>` while assembling a diagnostic. Only
// `BoundedDiagnosticReport`/`BoundedKnownWall` below (the shape actually
// returned by `ProbeKernel.getWorkspaceStatus`) swap it for the canonical
// `BoundedCollection<string>` -- so a diagnostic backed by many stale
// sessions or a long-running host's accumulated detail lines stays within
// the generic 4 KiB / 100 line inline budget the same way session
// health/flow results do, instead of inlining every detail line.
export const DiagnosticReport = Schema.Struct({
  key: Schema.String,
  status: DiagnosticStatus,
  summary: Schema.String,
  details: Schema.Array(Schema.String),
})
export type DiagnosticReport = typeof DiagnosticReport.Type

export const BoundedDiagnosticReport = Schema.Struct({
  ...DiagnosticReport.fields,
  details: BoundedCollectionSchema(Schema.String),
})
export type BoundedDiagnosticReport = typeof BoundedDiagnosticReport.Type

export const KnownWall = Schema.Struct({
  key: Schema.String,
  summary: Schema.String,
  details: Schema.Array(Schema.String),
})
export type KnownWall = typeof KnownWall.Type

export const BoundedKnownWall = Schema.Struct({
  ...KnownWall.fields,
  details: BoundedCollectionSchema(Schema.String),
})
export type BoundedKnownWall = typeof BoundedKnownWall.Type

export const DiagnosticCaptureTarget = Schema.Literal("simulator", "device")
export type DiagnosticCaptureTarget = typeof DiagnosticCaptureTarget.Type

export const DiagnosticCaptureKind = Schema.Literal("sysdiagnose")
export type DiagnosticCaptureKind = typeof DiagnosticCaptureKind.Type
