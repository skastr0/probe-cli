import { Schema } from "effect"
import { RunnerCapabilityFlag } from "../domain/session"

const OptionalNullableString = Schema.Union(Schema.String, Schema.Null, Schema.Undefined)
const OptionalNullableNumber = Schema.Union(Schema.Number, Schema.Null, Schema.Undefined)
const OptionalNullableNumberArray = Schema.Union(
  Schema.Array(Schema.Union(Schema.Number, Schema.Null)),
  Schema.Null,
  Schema.Undefined,
)
const OptionalString = Schema.Union(Schema.String, Schema.Undefined)

export const RUNNER_TRANSPORT_CONTRACT = "probe.runner.transport/hybrid-v1"
export const RUNNER_HTTP_COMMAND_INGRESS = "http-post"
export const RUNNER_EVENT_EGRESS = "stdout-jsonl-mixed-log"
const RunnerBootstrapSourceSchema = Schema.Literal("simulator-bootstrap-manifest", "device-bootstrap-manifest")
const RunnerReadyIngressTransportSchema = Schema.Literal(RUNNER_HTTP_COMMAND_INGRESS)

export const RunnerCapabilitySchema = RunnerCapabilityFlag
export type RunnerCapability = typeof RunnerCapabilitySchema.Type

/**
 * PRB-089: how a runner response frame was produced, relative to the
 * runner's bounded terminal-result cache and executed high-water mark for
 * the command's epoch. This is the field a caller reads to know whether a
 * mutation actually ran on *this* delivery, or whether it is looking at a
 * replay of a decision the runner already made:
 *  - "executed": the runner ran the action for the first time this epoch.
 *  - "cached-replay": `sequence` was already in the terminal cache; the
 *    runner returned the stored result verbatim and did not run the action
 *    again.
 *  - "result-expired": `sequence` is at or below the executed high-water
 *    mark (so it *was* executed), but its cache entry was evicted. The
 *    runner cannot say what the original result was, so it refuses to
 *    re-execute and reports this instead — the host must treat the command
 *    as indeterminate, never as a fresh success.
 *  - "epoch-mismatch": the command's `epoch` does not match the runner's
 *    current `runnerEpoch`. The command is rejected before it can execute;
 *    it almost certainly targeted a runner process that no longer exists.
 *  - "sequence-gap": the command's `sequence` is more than one past the
 *    executed high-water mark, meaning at least one earlier sequence number
 *    was never seen by this runner. Rejected before execution rather than
 *    risking out-of-order mutation.
 */
export const RunnerReplayStatusSchema = Schema.Literal(
  "executed",
  "cached-replay",
  "result-expired",
  "epoch-mismatch",
  "sequence-gap",
)
export type RunnerReplayStatus = typeof RunnerReplayStatusSchema.Type

export const RunnerActionSchema = Schema.Literal(
  "ping",
  "applyInput",
  "snapshot",
  "screenshot",
  "recordVideo",
  "shutdown",
  "uiAction",
  "uiActionBatch",
)
export type RunnerAction = typeof RunnerActionSchema.Type

export const RunnerBootstrapManifestSchema = Schema.Struct({
  contractVersion: Schema.Literal(RUNNER_TRANSPORT_CONTRACT),
  controlDirectoryPath: Schema.String,
  egressTransport: Schema.Literal(RUNNER_EVENT_EGRESS),
  generatedAt: Schema.String,
  ingressTransport: Schema.Literal(RUNNER_HTTP_COMMAND_INGRESS),
  sessionIdentifier: Schema.String,
  simulatorUdid: Schema.String,
  targetBundleId: Schema.String,
})
export type RunnerBootstrapManifest = typeof RunnerBootstrapManifestSchema.Type

export const RunnerCommandFrameSchema = Schema.Struct({
  sequence: Schema.Number,
  action: RunnerActionSchema,
  payload: OptionalNullableString,
  // PRB-089: the runner epoch this command targets. The host echoes back
  // whatever `runnerEpoch` the current session's ready frame advertised; the
  // runner rejects (never executes) a command whose epoch does not match its
  // own, since that means the command was addressed to a runner process
  // that is no longer live.
  epoch: Schema.String,
})
export type RunnerCommandFrame = typeof RunnerCommandFrameSchema.Type

export const RunnerReadyFrameSchema = Schema.Struct({
  kind: Schema.Literal("ready"),
  attachLatencyMs: Schema.Number,
  bootstrapPath: Schema.String,
  bootstrapSource: RunnerBootstrapSourceSchema,
  capabilities: Schema.optional(Schema.Array(RunnerCapabilitySchema)),
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
  // PRB-089: fresh random identity for this one live runner process/attach.
  // Every command and response this runner ever sends carries this value;
  // it is the boundary the at-most-once guarantee is scoped to ("within one
  // live runner epoch" — see the glyph's guarantee boundary). A new runner
  // process (fresh attach after a crash or restart) always mints a new one.
  runnerEpoch: Schema.String,
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
  // PRB-091: `handledMs` broken into the phases a `uiAction` command went
  // through — resolving the locator, waiting for existence/hittability, and
  // performing the gesture — plus the (always-populated) generic response
  // finalization cost. Nullable/optional because only `uiAction` responses
  // go through `performRunnerUIAction` on the runner side; every other
  // action (ping, snapshot, screenshot, recordVideo, shutdown) has no
  // resolution/wait/interaction phase to report. See
  // ios/ProbeRunner/AttachControlSpikeUITests.swift's `LifecycleResponseFrame`.
  resolutionMs: Schema.optional(OptionalNullableNumber),
  waitMs: Schema.optional(OptionalNullableNumber),
  interactionMs: Schema.optional(OptionalNullableNumber),
  finalizationMs: Schema.optional(OptionalNullableNumber),
  snapshotNodeCount: OptionalNullableNumber,
  failedActionIndex: OptionalNullableNumber,
  failedActionKind: OptionalNullableString,
  totalHandledMs: OptionalNullableNumber,
  childHandledMs: OptionalNullableNumberArray,
  recordedAt: Schema.String,
  hostObservedAt: OptionalString,
  // PRB-089: the runner's current epoch (always present, even on a
  // rejected/never-executed command — an epoch-mismatch response still
  // reports the epoch the runner actually has, so the host can tell it
  // apart from the epoch it thought it was talking to).
  epoch: Schema.String,
  replayStatus: RunnerReplayStatusSchema,
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
  readonly epoch: string
}): string => {
  const frame = decodeRunnerCommandFrame({
    sequence: value.sequence,
    action: value.action,
    payload: value.payload ?? null,
    epoch: value.epoch,
  })

  return JSON.stringify(frame)
}
