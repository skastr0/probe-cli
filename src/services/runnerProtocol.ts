import { Schema } from "effect"

const OptionalNullableString = Schema.Union(Schema.String, Schema.Null, Schema.Undefined)
const OptionalNullableNumber = Schema.Union(Schema.Number, Schema.Null, Schema.Undefined)
const OptionalString = Schema.Union(Schema.String, Schema.Undefined)

export const RUNNER_TRANSPORT_CONTRACT = "probe.runner.transport/hybrid-v1"
export const RUNNER_COMMAND_INGRESS = "file-mailbox"
export const RUNNER_HTTP_COMMAND_INGRESS = "http-post"
export const RUNNER_EVENT_EGRESS = "stdout-jsonl-mixed-log"
const RunnerBootstrapSourceSchema = Schema.Literal("simulator-bootstrap-manifest", "device-bootstrap-manifest")
const RunnerReadyIngressTransportSchema = Schema.Literal(RUNNER_COMMAND_INGRESS, RUNNER_HTTP_COMMAND_INGRESS)

export const RunnerActionSchema = Schema.Literal("ping", "applyInput", "snapshot", "screenshot", "recordVideo", "shutdown", "uiAction")
export type RunnerAction = typeof RunnerActionSchema.Type

export const RunnerBootstrapManifestSchema = Schema.Struct({
  contractVersion: Schema.Literal(RUNNER_TRANSPORT_CONTRACT),
  controlDirectoryPath: Schema.String,
  egressTransport: Schema.Literal(RUNNER_EVENT_EGRESS),
  generatedAt: Schema.String,
  ingressTransport: Schema.Literal(RUNNER_COMMAND_INGRESS),
  sessionIdentifier: Schema.String,
  simulatorUdid: Schema.String,
  targetBundleId: Schema.String,
})
export type RunnerBootstrapManifest = typeof RunnerBootstrapManifestSchema.Type

export const RunnerCommandFrameSchema = Schema.Struct({
  sequence: Schema.Number,
  action: RunnerActionSchema,
  payload: OptionalNullableString,
})
export type RunnerCommandFrame = typeof RunnerCommandFrameSchema.Type

export const RunnerReadyFrameSchema = Schema.Struct({
  kind: Schema.Literal("ready"),
  attachLatencyMs: Schema.Number,
  bootstrapPath: Schema.String,
  bootstrapSource: RunnerBootstrapSourceSchema,
  controlDirectoryPath: Schema.String,
  currentDirectoryPath: Schema.String,
  egressTransport: Schema.Literal(RUNNER_EVENT_EGRESS),
  homeDirectoryPath: Schema.String,
  ingressTransport: RunnerReadyIngressTransportSchema,
  initialStatusLabel: Schema.String,
  processIdentifier: Schema.Number,
  recordedAt: Schema.String,
  runnerPort: Schema.optional(Schema.Number),
  runnerTransportContract: Schema.Literal(RUNNER_TRANSPORT_CONTRACT),
  sessionIdentifier: Schema.String,
  simulatorUdid: Schema.String,
  hostObservedAt: OptionalString,
})
export type RunnerReadyFrame = typeof RunnerReadyFrameSchema.Type

export const RunnerResponseFrameSchema = Schema.Struct({
  kind: Schema.Literal("response"),
  sequence: Schema.Number,
  ok: Schema.Boolean,
  action: RunnerActionSchema,
  error: OptionalNullableString,
  payload: OptionalNullableString,
  snapshotPayloadPath: OptionalNullableString,
  inlinePayload: OptionalNullableString,
  inlinePayloadEncoding: OptionalNullableString,
  handledMs: Schema.Number,
  statusLabel: Schema.String,
  snapshotNodeCount: OptionalNullableNumber,
  recordedAt: Schema.String,
  hostObservedAt: OptionalString,
})
export type RunnerResponseFrame = typeof RunnerResponseFrameSchema.Type

export const RunnerStdinProbeResultFrameSchema = Schema.Struct({
  kind: Schema.Literal("stdin-probe-result"),
  status: Schema.String,
  payload: OptionalNullableString,
  error: OptionalNullableString,
  recordedAt: Schema.String,
  hostObservedAt: OptionalString,
})
export type RunnerStdinProbeResultFrame = typeof RunnerStdinProbeResultFrameSchema.Type

const decodeRunnerBootstrapManifestSync = Schema.decodeUnknownSync(RunnerBootstrapManifestSchema)
const decodeRunnerCommandFrameSync = Schema.decodeUnknownSync(RunnerCommandFrameSchema)
const decodeRunnerReadyFrameSync = Schema.decodeUnknownSync(RunnerReadyFrameSchema)
const decodeRunnerResponseFrameSync = Schema.decodeUnknownSync(RunnerResponseFrameSchema)
const decodeRunnerStdinProbeResultFrameSync = Schema.decodeUnknownSync(RunnerStdinProbeResultFrameSchema)

const decodeWithLabel = <T>(label: string, decode: (value: unknown) => T, value: unknown): T => {
  try {
    return decode(value)
  } catch (error) {
    throw new Error(`Invalid ${label}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

export const decodeRunnerBootstrapManifest = (value: unknown): RunnerBootstrapManifest =>
  decodeWithLabel("runner bootstrap manifest", decodeRunnerBootstrapManifestSync, value)

export const decodeRunnerCommandFrame = (value: unknown): RunnerCommandFrame =>
  decodeWithLabel("runner command frame", decodeRunnerCommandFrameSync, value)

export const decodeRunnerReadyFrame = (value: unknown): RunnerReadyFrame =>
  decodeWithLabel("runner ready frame", decodeRunnerReadyFrameSync, value)

export const decodeRunnerResponseFrame = (value: unknown): RunnerResponseFrame =>
  decodeWithLabel("runner response frame", decodeRunnerResponseFrameSync, value)

export const decodeRunnerStdinProbeResultFrame = (value: unknown): RunnerStdinProbeResultFrame =>
  decodeWithLabel("runner stdin probe result frame", decodeRunnerStdinProbeResultFrameSync, value)

export const encodeRunnerCommandFrame = (value: {
  readonly sequence: number
  readonly action: RunnerAction
  readonly payload?: string | null
}): string => {
  const frame = decodeRunnerCommandFrame({
    sequence: value.sequence,
    action: value.action,
    payload: value.payload ?? null,
  })

  return JSON.stringify(frame)
}
