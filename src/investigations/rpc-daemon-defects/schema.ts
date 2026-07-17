import { Schema } from "effect"

export const INVESTIGATION_SCHEMA_VERSION = 1

export const DefectCategory = Schema.Literal(
  "detached-rpc-work",
  "ambiguous-mutation-delivery",
  "artifact-race",
  "eager-export",
)
export type DefectCategory = typeof DefectCategory.Type

export const DefectVerdict = Schema.Literal("red", "green", "not-run")
export type DefectVerdict = typeof DefectVerdict.Type

export const DefectFinding = Schema.Struct({
  id: Schema.String,
  category: DefectCategory,
  verdict: DefectVerdict,
  summary: Schema.String,
  evidence: Schema.Array(Schema.String),
  metrics: Schema.Record({ key: Schema.String, value: Schema.Number }),
})
export type DefectFinding = typeof DefectFinding.Type

export const LaneStatus = Schema.Literal("ran", "attempted-failed", "not-applicable")
export type LaneStatus = typeof LaneStatus.Type

export const LaneResult = Schema.Struct({
  lane: Schema.Literal("simulator", "device"),
  status: LaneStatus,
  summary: Schema.String,
  details: Schema.Array(Schema.String),
  receipts: Schema.Array(Schema.String),
})
export type LaneResult = typeof LaneResult.Type

export const HostProvenance = Schema.Struct({
  platform: Schema.String,
  arch: Schema.String,
  bunVersion: Schema.String,
  xcodeVersion: Schema.Union(Schema.String, Schema.Null),
})
export type HostProvenance = typeof HostProvenance.Type

export const Provenance = Schema.Struct({
  generatedAt: Schema.String,
  gitSha: Schema.String,
  gitBranch: Schema.String,
  gitDirty: Schema.Boolean,
  host: HostProvenance,
})
export type Provenance = typeof Provenance.Type

export const InvestigationReport = Schema.Struct({
  schemaVersion: Schema.Literal(INVESTIGATION_SCHEMA_VERSION),
  glyphId: Schema.Literal("PRB-087"),
  provenance: Provenance,
  lanes: Schema.Struct({
    simulator: LaneResult,
    device: LaneResult,
  }),
  findings: Schema.Array(DefectFinding),
  overallVerdict: Schema.Literal("red", "green"),
  notes: Schema.Array(Schema.String),
})
export type InvestigationReport = typeof InvestigationReport.Type

export const decodeInvestigationReport = Schema.decodeUnknownSync(InvestigationReport)
export const encodeInvestigationReport = Schema.encodeSync(InvestigationReport)

export const deriveOverallVerdict = (findings: ReadonlyArray<DefectFinding>): "red" | "green" =>
  findings.some((finding) => finding.verdict === "red") ? "red" : "green"
