import { Schema } from "effect"
import { CapabilityReport } from "./capabilities"
import { SessionCoordination, SessionDebuggerDetails } from "./debug"
import { ArtifactRecord, NullableString } from "./output"

export const SessionPhase = Schema.Literal(
  "opening",
  "ready",
  "degraded",
  "closing",
  "closed",
  "failed",
)
export type SessionPhase = typeof SessionPhase.Type

export const SimulatorSessionMode = Schema.Literal("build-and-install", "attach-to-running")
export type SimulatorSessionMode = typeof SimulatorSessionMode.Type

export const SessionLifecycleState = SessionPhase
export type SessionLifecycleState = typeof SessionLifecycleState.Type

export const SessionResourceState = Schema.Literal(
  "not-requested",
  "starting",
  "ready",
  "degraded",
  "stopping",
  "stopped",
  "failed",
)
export type SessionResourceState = typeof SessionResourceState.Type

export const SessionResourceStates = Schema.Struct({
  runner: SessionResourceState,
  debugger: SessionResourceState,
  logs: SessionResourceState,
  trace: SessionResourceState,
})
export type SessionResourceStates = typeof SessionResourceStates.Type

export const SessionTarget = Schema.Struct({
  platform: Schema.Literal("simulator", "device"),
  bundleId: Schema.String,
  deviceId: Schema.String,
  deviceName: Schema.String,
  runtime: NullableString,
})
export type SessionTarget = typeof SessionTarget.Type

export const SessionConnectionStatus = Schema.Literal("connected", "disconnected")
export type SessionConnectionStatus = typeof SessionConnectionStatus.Type

export const SessionConnectionDetails = Schema.Struct({
  status: SessionConnectionStatus,
  checkedAt: Schema.String,
  summary: Schema.String,
  details: Schema.Array(Schema.String),
})
export type SessionConnectionDetails = typeof SessionConnectionDetails.Type

export const LiveRunnerTransportContract = Schema.Struct({
  kind: Schema.Literal("simulator-runner"),
  contract: Schema.Literal("probe.runner.transport/hybrid-v1"),
  bootstrapSource: Schema.Literal("simulator-bootstrap-manifest"),
  bootstrapPath: Schema.String,
  sessionIdentifier: Schema.String,
  commandIngress: Schema.Literal("file-mailbox"),
  eventEgress: Schema.Literal("stdout-jsonl-mixed-log"),
  stdinProbeStatus: Schema.String,
  note: Schema.String,
})
export type LiveRunnerTransportContract = typeof LiveRunnerTransportContract.Type

export const RealDeviceLiveTransportContract = Schema.Struct({
  kind: Schema.Literal("real-device-live"),
  contract: Schema.Literal("probe.runner.transport/hybrid-v1"),
  bootstrapSource: Schema.Literal("device-bootstrap-manifest"),
  bootstrapPath: Schema.String,
  sessionIdentifier: Schema.String,
  commandIngress: Schema.Literal("file-mailbox", "http-post"),
  eventEgress: Schema.Literal("stdout-jsonl-mixed-log"),
  stdinProbeStatus: Schema.String,
  note: Schema.String,
})
export type RealDeviceLiveTransportContract = typeof RealDeviceLiveTransportContract.Type

export const RealDevicePreflightTransportContract = Schema.Struct({
  kind: Schema.Literal("real-device-preflight"),
  contract: Schema.Literal("probe.runner.transport/unvalidated-device-v1"),
  bootstrapSource: Schema.Literal("not-established"),
  bootstrapPath: Schema.Null,
  sessionIdentifier: Schema.String,
  commandIngress: Schema.Literal("not-established"),
  eventEgress: Schema.Literal("not-established"),
  stdinProbeStatus: Schema.Literal("not-run"),
  note: Schema.String,
  integrationPoints: Schema.Array(Schema.String),
})
export type RealDevicePreflightTransportContract = typeof RealDevicePreflightTransportContract.Type

export const SessionTransportDetails = Schema.Union(
  LiveRunnerTransportContract,
  RealDeviceLiveTransportContract,
  RealDevicePreflightTransportContract,
)
export type SessionTransportDetails = typeof SessionTransportDetails.Type

export const LiveRunnerSessionDetails = Schema.Struct({
  kind: Schema.Literal("simulator-runner"),
  wrapperProcessId: Schema.Number,
  testProcessId: Schema.Number,
  targetProcessId: Schema.Number,
  attachLatencyMs: Schema.Number,
  runtimeControlDirectory: Schema.String,
  observerControlDirectory: Schema.String,
  logPath: Schema.String,
  buildLogPath: Schema.String,
  stdoutEventsPath: Schema.String,
  resultBundlePath: Schema.String,
  wrapperStderrPath: Schema.String,
  stdinProbeStatus: Schema.String,
})
export type LiveRunnerSessionDetails = typeof LiveRunnerSessionDetails.Type

export const RealDeviceLiveRunnerDetails = Schema.Struct({
  kind: Schema.Literal("real-device-live"),
  wrapperProcessId: Schema.Number,
  testProcessId: Schema.Number,
  targetProcessId: Schema.Number,
  attachLatencyMs: Schema.Number,
  runtimeControlDirectory: Schema.String,
  observerControlDirectory: Schema.String,
  logPath: Schema.String,
  buildLogPath: Schema.String,
  stdoutEventsPath: Schema.String,
  resultBundlePath: Schema.String,
  wrapperStderrPath: Schema.String,
  stdinProbeStatus: Schema.String,
  connectionStatus: SessionConnectionStatus,
  lastCheckedAt: Schema.String,
  note: Schema.String,
})
export type RealDeviceLiveRunnerDetails = typeof RealDeviceLiveRunnerDetails.Type

export const RealDevicePreflightRunnerDetails = Schema.Struct({
  kind: Schema.Literal("real-device-preflight"),
  wrapperProcessId: Schema.Null,
  testProcessId: Schema.Null,
  targetProcessId: Schema.Null,
  attachLatencyMs: Schema.Null,
  runtimeControlDirectory: Schema.Null,
  observerControlDirectory: Schema.Null,
  logPath: NullableString,
  buildLogPath: NullableString,
  stdoutEventsPath: NullableString,
  resultBundlePath: NullableString,
  wrapperStderrPath: NullableString,
  stdinProbeStatus: Schema.Literal("not-run"),
  connectionStatus: SessionConnectionStatus,
  lastCheckedAt: Schema.String,
  note: Schema.String,
})
export type RealDevicePreflightRunnerDetails = typeof RealDevicePreflightRunnerDetails.Type

export const SessionRunnerDetails = Schema.Union(
  LiveRunnerSessionDetails,
  RealDeviceLiveRunnerDetails,
  RealDevicePreflightRunnerDetails,
)
export type SessionRunnerDetails = typeof SessionRunnerDetails.Type

export const SessionHealthCheck = Schema.Struct({
  checkedAt: Schema.String,
  wrapperRunning: Schema.Boolean,
  pingRttMs: Schema.Union(Schema.Number, Schema.Null),
  lastCommand: NullableString,
  lastOk: Schema.Union(Schema.Boolean, Schema.Null),
})
export type SessionHealthCheck = typeof SessionHealthCheck.Type

export const ProbeSessionState = Schema.Struct({
  sessionId: Schema.String,
  state: SessionPhase,
  openedAt: Schema.String,
  updatedAt: Schema.String,
  expiresAt: Schema.String,
  artifactRoot: Schema.String,
  target: SessionTarget,
  connection: SessionConnectionDetails,
  resources: SessionResourceStates,
  capabilities: Schema.Array(CapabilityReport),
  warnings: Schema.Array(Schema.String),
  artifacts: Schema.Array(ArtifactRecord),
})
export type ProbeSessionState = typeof ProbeSessionState.Type

// The architecture freeze covers the generic session lifecycle/state surface above.
// The RPC/session health contract extends the generic session state with the
// current transport/runtime detail unions that back the simulator runner slice and
// the real-device preflight slice.
export const ProbeSessionHealth = Schema.Struct({
  ...ProbeSessionState.fields,
  transport: SessionTransportDetails,
  runner: SessionRunnerDetails,
  healthCheck: SessionHealthCheck,
  debugger: SessionDebuggerDetails,
  coordination: SessionCoordination,
})
export type ProbeSessionHealth = typeof ProbeSessionHealth.Type

export const SessionHealth = ProbeSessionHealth
export type SessionHealth = typeof ProbeSessionHealth.Type

export const isLiveRunnerTransport = (
  transport: SessionTransportDetails,
): transport is LiveRunnerTransportContract | RealDeviceLiveTransportContract =>
  transport.kind === "simulator-runner" || transport.kind === "real-device-live"

export const isRealDevicePreflightTransport = (
  transport: SessionTransportDetails,
): transport is RealDevicePreflightTransportContract => transport.kind === "real-device-preflight"

export const isLiveRunnerDetails = (
  runner: SessionRunnerDetails,
): runner is LiveRunnerSessionDetails | RealDeviceLiveRunnerDetails =>
  runner.kind === "simulator-runner" || runner.kind === "real-device-live"

export const isRealDevicePreflightRunnerDetails = (
  runner: SessionRunnerDetails,
): runner is RealDevicePreflightRunnerDetails => runner.kind === "real-device-preflight"

const allowedTransitions: Record<SessionPhase, ReadonlyArray<SessionPhase>> = {
  opening: ["ready", "degraded", "failed", "closing"],
  ready: ["degraded", "closing", "failed"],
  degraded: ["ready", "closing", "failed"],
  closing: ["closed", "failed"],
  closed: [],
  failed: ["closing", "closed"],
}

export const canTransitionSessionPhase = (
  from: SessionPhase,
  to: SessionPhase,
): boolean => from === to || allowedTransitions[from].includes(to)

export const canTransitionSessionState = canTransitionSessionPhase

export const assertSessionPhaseTransition = (
  from: SessionPhase,
  to: SessionPhase,
): void => {
  if (!canTransitionSessionPhase(from, to)) {
    throw new Error(`Invalid session state transition: ${from} -> ${to}`)
  }
}

export const assertSessionTransition = assertSessionPhaseTransition
