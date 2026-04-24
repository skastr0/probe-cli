import { Schema } from "effect"

export const CapabilityArea = Schema.Literal(
  "daemon",
  "simulator",
  "real-device",
  "runner",
  "artifact",
  "accessibility",
  "commerce",
  "perf",
  "logs",
  "debug",
  "optional-dependencies",
)
export type CapabilityArea = typeof CapabilityArea.Type

export const CapabilityStatus = Schema.Literal("supported", "degraded", "unsupported")
export type CapabilityStatus = typeof CapabilityStatus.Type

export const CapabilityReport = Schema.Struct({
  area: CapabilityArea,
  status: CapabilityStatus,
  summary: Schema.String,
  details: Schema.Array(Schema.String),
})
export type CapabilityReport = typeof CapabilityReport.Type
