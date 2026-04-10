import { Schema } from "effect"
import {
  ActionRecordingScriptSchema,
  SessionActionResultSchema,
  SessionActionSchema,
  SessionRecordingExportResultSchema,
  SessionReplayResultSchema,
} from "../domain/action"
import { DebugCommandInput, DebugCommandResult } from "../domain/debug"
import { ProbeFailurePayload, ProtocolMismatchError } from "../domain/errors"
import { DrillQuery, DrillResult, OutputMode, SessionLogSource, SessionLogsResult, SummaryArtifactResult } from "../domain/output"
import { PerfRecordResult, PerfTemplate } from "../domain/perf"
import { SessionHealth } from "../domain/session"
import { SessionSnapshotResultSchema } from "../domain/snapshot"

export const PROBE_PROTOCOL_VERSION = "probe-rpc/v1"

const NullableString = Schema.Union(Schema.String, Schema.Null)

export const RpcMethod = Schema.Literal(
  "daemon.ping",
  "session.open",
  "session.health",
  "session.logs",
  "session.debug",
  "session.snapshot",
  "session.screenshot",
  "session.action",
  "session.recording.export",
  "session.replay",
  "session.close",
  "perf.record",
  "artifact.drill",
)
export type RpcMethod = typeof RpcMethod.Type

export const DaemonPingRequest = Schema.Struct({
  kind: Schema.Literal("request"),
  protocolVersion: Schema.Literal(PROBE_PROTOCOL_VERSION),
  requestId: Schema.String,
  method: Schema.Literal("daemon.ping"),
  params: Schema.Struct({}),
})
export type DaemonPingRequest = typeof DaemonPingRequest.Type

export const SessionOpenRequest = Schema.Struct({
  kind: Schema.Literal("request"),
  protocolVersion: Schema.Literal(PROBE_PROTOCOL_VERSION),
  requestId: Schema.String,
  method: Schema.Literal("session.open"),
  params: Schema.Struct({
    target: Schema.Literal("simulator", "device"),
    bundleId: Schema.String,
    simulatorUdid: NullableString,
    deviceId: NullableString,
  }),
})
export type SessionOpenRequest = typeof SessionOpenRequest.Type

export const SessionHealthRequest = Schema.Struct({
  kind: Schema.Literal("request"),
  protocolVersion: Schema.Literal(PROBE_PROTOCOL_VERSION),
  requestId: Schema.String,
  method: Schema.Literal("session.health"),
  params: Schema.Struct({
    sessionId: Schema.String,
  }),
})
export type SessionHealthRequest = typeof SessionHealthRequest.Type

export const SessionCloseRequest = Schema.Struct({
  kind: Schema.Literal("request"),
  protocolVersion: Schema.Literal(PROBE_PROTOCOL_VERSION),
  requestId: Schema.String,
  method: Schema.Literal("session.close"),
  params: Schema.Struct({
    sessionId: Schema.String,
  }),
})
export type SessionCloseRequest = typeof SessionCloseRequest.Type

export const SessionLogsRequest = Schema.Struct({
  kind: Schema.Literal("request"),
  protocolVersion: Schema.Literal(PROBE_PROTOCOL_VERSION),
  requestId: Schema.String,
  method: Schema.Literal("session.logs"),
  params: Schema.Struct({
    sessionId: Schema.String,
    source: SessionLogSource,
    lineCount: Schema.Number,
    match: NullableString,
    outputMode: OutputMode,
    captureSeconds: Schema.Number,
    predicate: NullableString,
    process: NullableString,
    subsystem: NullableString,
    category: NullableString,
  }),
})
export type SessionLogsRequest = typeof SessionLogsRequest.Type

export const SessionDebugRequest = Schema.Struct({
  kind: Schema.Literal("request"),
  protocolVersion: Schema.Literal(PROBE_PROTOCOL_VERSION),
  requestId: Schema.String,
  method: Schema.Literal("session.debug"),
  params: Schema.Struct({
    sessionId: Schema.String,
    outputMode: OutputMode,
    command: DebugCommandInput,
  }),
})
export type SessionDebugRequest = typeof SessionDebugRequest.Type

export const SessionScreenshotRequest = Schema.Struct({
  kind: Schema.Literal("request"),
  protocolVersion: Schema.Literal(PROBE_PROTOCOL_VERSION),
  requestId: Schema.String,
  method: Schema.Literal("session.screenshot"),
  params: Schema.Struct({
    sessionId: Schema.String,
    label: NullableString,
    outputMode: OutputMode,
  }),
})
export type SessionScreenshotRequest = typeof SessionScreenshotRequest.Type

export const SessionActionRequest = Schema.Struct({
  kind: Schema.Literal("request"),
  protocolVersion: Schema.Literal(PROBE_PROTOCOL_VERSION),
  requestId: Schema.String,
  method: Schema.Literal("session.action"),
  params: Schema.Struct({
    sessionId: Schema.String,
    action: SessionActionSchema,
  }),
})
export type SessionActionRequest = typeof SessionActionRequest.Type

export const SessionRecordingExportRequest = Schema.Struct({
  kind: Schema.Literal("request"),
  protocolVersion: Schema.Literal(PROBE_PROTOCOL_VERSION),
  requestId: Schema.String,
  method: Schema.Literal("session.recording.export"),
  params: Schema.Struct({
    sessionId: Schema.String,
    label: NullableString,
  }),
})
export type SessionRecordingExportRequest = typeof SessionRecordingExportRequest.Type

export const SessionReplayRequest = Schema.Struct({
  kind: Schema.Literal("request"),
  protocolVersion: Schema.Literal(PROBE_PROTOCOL_VERSION),
  requestId: Schema.String,
  method: Schema.Literal("session.replay"),
  params: Schema.Struct({
    sessionId: Schema.String,
    script: ActionRecordingScriptSchema,
  }),
})
export type SessionReplayRequest = typeof SessionReplayRequest.Type

export const SessionSnapshotRequest = Schema.Struct({
  kind: Schema.Literal("request"),
  protocolVersion: Schema.Literal(PROBE_PROTOCOL_VERSION),
  requestId: Schema.String,
  method: Schema.Literal("session.snapshot"),
  params: Schema.Struct({
    sessionId: Schema.String,
    outputMode: OutputMode,
  }),
})
export type SessionSnapshotRequest = typeof SessionSnapshotRequest.Type

export const PerfRecordRequest = Schema.Struct({
  kind: Schema.Literal("request"),
  protocolVersion: Schema.Literal(PROBE_PROTOCOL_VERSION),
  requestId: Schema.String,
  method: Schema.Literal("perf.record"),
  params: Schema.Struct({
    sessionId: Schema.String,
    template: PerfTemplate,
    timeLimit: Schema.String,
  }),
})
export type PerfRecordRequest = typeof PerfRecordRequest.Type

export const ArtifactDrillRequest = Schema.Struct({
  kind: Schema.Literal("request"),
  protocolVersion: Schema.Literal(PROBE_PROTOCOL_VERSION),
  requestId: Schema.String,
  method: Schema.Literal("artifact.drill"),
  params: Schema.Struct({
    sessionId: Schema.String,
    artifactKey: Schema.String,
    outputMode: OutputMode,
    query: DrillQuery,
  }),
})
export type ArtifactDrillRequest = typeof ArtifactDrillRequest.Type

export const RpcRequest = Schema.Union(
  DaemonPingRequest,
  SessionOpenRequest,
  SessionHealthRequest,
  SessionCloseRequest,
  SessionLogsRequest,
  SessionDebugRequest,
  SessionSnapshotRequest,
  SessionScreenshotRequest,
  SessionActionRequest,
  SessionRecordingExportRequest,
  SessionReplayRequest,
  PerfRecordRequest,
  ArtifactDrillRequest,
)
export type RpcRequest = typeof RpcRequest.Type

export const DaemonStatus = Schema.Struct({
  protocolVersion: Schema.Literal(PROBE_PROTOCOL_VERSION),
  startedAt: Schema.String,
  processId: Schema.Number,
  socketPath: Schema.String,
  activeSessions: Schema.Number,
})
export type DaemonStatus = typeof DaemonStatus.Type

export const DaemonPingResponse = Schema.Struct({
  kind: Schema.Literal("response"),
  protocolVersion: Schema.Literal(PROBE_PROTOCOL_VERSION),
  requestId: Schema.String,
  method: Schema.Literal("daemon.ping"),
  result: DaemonStatus,
})
export type DaemonPingResponse = typeof DaemonPingResponse.Type

export const SessionOpenResponse = Schema.Struct({
  kind: Schema.Literal("response"),
  protocolVersion: Schema.Literal(PROBE_PROTOCOL_VERSION),
  requestId: Schema.String,
  method: Schema.Literal("session.open"),
  result: SessionHealth,
})
export type SessionOpenResponse = typeof SessionOpenResponse.Type

export const SessionHealthResponse = Schema.Struct({
  kind: Schema.Literal("response"),
  protocolVersion: Schema.Literal(PROBE_PROTOCOL_VERSION),
  requestId: Schema.String,
  method: Schema.Literal("session.health"),
  result: SessionHealth,
})
export type SessionHealthResponse = typeof SessionHealthResponse.Type

export const SessionCloseResponse = Schema.Struct({
  kind: Schema.Literal("response"),
  protocolVersion: Schema.Literal(PROBE_PROTOCOL_VERSION),
  requestId: Schema.String,
  method: Schema.Literal("session.close"),
  result: Schema.Struct({
    sessionId: Schema.String,
    state: Schema.String,
    closedAt: Schema.String,
  }),
})
export type SessionCloseResponse = typeof SessionCloseResponse.Type

export const SessionLogsResponse = Schema.Struct({
  kind: Schema.Literal("response"),
  protocolVersion: Schema.Literal(PROBE_PROTOCOL_VERSION),
  requestId: Schema.String,
  method: Schema.Literal("session.logs"),
  result: SessionLogsResult,
})
export type SessionLogsResponse = typeof SessionLogsResponse.Type

export const SessionDebugResponse = Schema.Struct({
  kind: Schema.Literal("response"),
  protocolVersion: Schema.Literal(PROBE_PROTOCOL_VERSION),
  requestId: Schema.String,
  method: Schema.Literal("session.debug"),
  result: DebugCommandResult,
})
export type SessionDebugResponse = typeof SessionDebugResponse.Type

export const SessionScreenshotResponse = Schema.Struct({
  kind: Schema.Literal("response"),
  protocolVersion: Schema.Literal(PROBE_PROTOCOL_VERSION),
  requestId: Schema.String,
  method: Schema.Literal("session.screenshot"),
  result: SummaryArtifactResult,
})
export type SessionScreenshotResponse = typeof SessionScreenshotResponse.Type

export const SessionActionResponse = Schema.Struct({
  kind: Schema.Literal("response"),
  protocolVersion: Schema.Literal(PROBE_PROTOCOL_VERSION),
  requestId: Schema.String,
  method: Schema.Literal("session.action"),
  result: SessionActionResultSchema,
})
export type SessionActionResponse = typeof SessionActionResponse.Type

export const SessionRecordingExportResponse = Schema.Struct({
  kind: Schema.Literal("response"),
  protocolVersion: Schema.Literal(PROBE_PROTOCOL_VERSION),
  requestId: Schema.String,
  method: Schema.Literal("session.recording.export"),
  result: SessionRecordingExportResultSchema,
})
export type SessionRecordingExportResponse = typeof SessionRecordingExportResponse.Type

export const SessionReplayResponse = Schema.Struct({
  kind: Schema.Literal("response"),
  protocolVersion: Schema.Literal(PROBE_PROTOCOL_VERSION),
  requestId: Schema.String,
  method: Schema.Literal("session.replay"),
  result: SessionReplayResultSchema,
})
export type SessionReplayResponse = typeof SessionReplayResponse.Type

export const SessionSnapshotResponse = Schema.Struct({
  kind: Schema.Literal("response"),
  protocolVersion: Schema.Literal(PROBE_PROTOCOL_VERSION),
  requestId: Schema.String,
  method: Schema.Literal("session.snapshot"),
  result: SessionSnapshotResultSchema,
})
export type SessionSnapshotResponse = typeof SessionSnapshotResponse.Type

export const PerfRecordResponse = Schema.Struct({
  kind: Schema.Literal("response"),
  protocolVersion: Schema.Literal(PROBE_PROTOCOL_VERSION),
  requestId: Schema.String,
  method: Schema.Literal("perf.record"),
  result: PerfRecordResult,
})
export type PerfRecordResponse = typeof PerfRecordResponse.Type

export const ArtifactDrillResponse = Schema.Struct({
  kind: Schema.Literal("response"),
  protocolVersion: Schema.Literal(PROBE_PROTOCOL_VERSION),
  requestId: Schema.String,
  method: Schema.Literal("artifact.drill"),
  result: DrillResult,
})
export type ArtifactDrillResponse = typeof ArtifactDrillResponse.Type

export const RpcResponse = Schema.Union(
  DaemonPingResponse,
  SessionOpenResponse,
  SessionHealthResponse,
  SessionCloseResponse,
  SessionLogsResponse,
  SessionDebugResponse,
  SessionSnapshotResponse,
  SessionScreenshotResponse,
  SessionActionResponse,
  SessionRecordingExportResponse,
  SessionReplayResponse,
  PerfRecordResponse,
  ArtifactDrillResponse,
)
export type RpcResponse = typeof RpcResponse.Type

export const RpcProgressEvent = Schema.Struct({
  kind: Schema.Literal("event"),
  protocolVersion: Schema.Literal(PROBE_PROTOCOL_VERSION),
  requestId: Schema.String,
  stage: Schema.String,
  message: Schema.String,
})
export type RpcProgressEvent = typeof RpcProgressEvent.Type

export const RpcFailure = Schema.Struct({
  kind: Schema.Literal("failure"),
  protocolVersion: Schema.Literal(PROBE_PROTOCOL_VERSION),
  requestId: Schema.String,
  method: RpcMethod,
  failure: Schema.Struct({
    code: Schema.String,
    category: Schema.String,
    reason: Schema.String,
    nextStep: Schema.String,
    details: Schema.Array(Schema.String),
    capability: NullableString,
    expectedVersion: NullableString,
    receivedVersion: NullableString,
    command: NullableString,
    exitCode: Schema.Union(Schema.Number, Schema.Null),
    sessionId: NullableString,
    artifactKey: NullableString,
    wall: Schema.Boolean,
  }),
})
export type RpcFailure = typeof RpcFailure.Type

export const RpcFrame = Schema.Union(RpcProgressEvent, RpcResponse, RpcFailure)
export type RpcFrame = typeof RpcFrame.Type

export const decodeRpcRequest = Schema.decodeUnknownSync(RpcRequest)
export const decodeRpcFrame = Schema.decodeUnknownSync(RpcFrame)

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null

const coerceRpcMethod = (value: unknown): RpcMethod => {
  switch (value) {
    case "daemon.ping":
    case "session.open":
    case "session.health":
    case "session.logs":
    case "session.debug":
    case "session.snapshot":
    case "session.screenshot":
    case "session.action":
    case "session.recording.export":
    case "session.replay":
    case "session.close":
    case "perf.record":
    case "artifact.drill":
      return value
    default:
      return "daemon.ping"
  }
}

const readStringField = (value: Record<string, unknown>, key: string): string | null => {
  const field = value[key]
  return typeof field === "string" ? field : null
}

export type DecodedRpcRequestLine =
  | { readonly kind: "request"; readonly request: RpcRequest }
  | {
      readonly kind: "protocol-mismatch"
      readonly requestId: string
      readonly method: RpcMethod
      readonly receivedVersion: string
    }

export const decodeRpcRequestLine = (line: string): DecodedRpcRequestLine => {
  const raw = JSON.parse(line) as unknown

  if (isRecord(raw) && typeof raw.protocolVersion === "string" && raw.protocolVersion !== PROBE_PROTOCOL_VERSION) {
    return {
      kind: "protocol-mismatch",
      requestId: readStringField(raw, "requestId") ?? "protocol-mismatch",
      method: coerceRpcMethod(raw.method),
      receivedVersion: raw.protocolVersion,
    }
  }

  return {
    kind: "request",
    request: decodeRpcRequest(raw),
  }
}

export const decodeRpcFrameLine = (line: string): RpcFrame => {
  const raw = JSON.parse(line) as unknown

  if (isRecord(raw) && typeof raw.protocolVersion === "string" && raw.protocolVersion !== PROBE_PROTOCOL_VERSION) {
    throw new ProtocolMismatchError({
      expectedVersion: PROBE_PROTOCOL_VERSION,
      receivedVersion: raw.protocolVersion,
      nextStep: "Restart or upgrade the Probe daemon and client so both sides speak the same RPC protocol version.",
    })
  }

  return decodeRpcFrame(raw)
}

export const encodeRpcLine = (frame: RpcFrame | RpcRequest): string => `${JSON.stringify(frame)}\n`

export const createFailureFrame = (
  request: RpcRequest,
  failure: ProbeFailurePayload,
): RpcFailure => ({
  kind: "failure",
  protocolVersion: PROBE_PROTOCOL_VERSION,
  requestId: request.requestId,
  method: request.method,
  failure,
})
