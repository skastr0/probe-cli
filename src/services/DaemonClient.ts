import { randomUUID } from "node:crypto"
import { Context, Effect, Layer } from "effect"
import type {
  ActionRecordingScript,
  SessionAction,
  SessionActionResult,
  SessionRecordingExportResult,
  SessionReplayResult,
} from "../domain/action"
import type { DebugCommandInput, DebugCommandResult } from "../domain/debug"
import {
  ArtifactNotFoundError,
  ChildProcessError,
  DaemonNotRunningError,
  EnvironmentError,
  ProtocolMismatchError,
  SessionConflictError,
  SessionNotFoundError,
  UnsupportedCapabilityError,
  UserInputError,
} from "../domain/errors"
import type { DrillQuery, DrillResult, OutputMode, SessionLogSource, SessionLogsResult, SummaryArtifactResult } from "../domain/output"
import type { PerfRecordResult, PerfTemplate } from "../domain/perf"
import type { SessionHealth } from "../domain/session"
import { ArtifactStore } from "./ArtifactStore"
import {
  sendArtifactDrill,
  sendDaemonPing,
  sendPerfRecord,
  sendSessionAction,
  sendSessionClose,
  sendSessionDebug,
  sendSessionHealth,
  sendSessionLogs,
  sendSessionOpen,
  sendSessionRecordingExport,
  sendSessionReplay,
  sendSessionSnapshot,
  sendSessionScreenshot,
} from "../rpc/client"
import { PROBE_PROTOCOL_VERSION } from "../rpc/protocol"
import type { SessionSnapshotResult } from "../domain/snapshot"

const defaultRpcTimeoutMs = Number(process.env.PROBE_RPC_TIMEOUT_MS ?? 10 * 60 * 1000)

export class DaemonClient extends Context.Tag("@probe/DaemonClient")<
  DaemonClient,
  {
    readonly ping: () => Effect.Effect<
      { readonly protocolVersion: string; readonly startedAt: string; readonly processId: number; readonly socketPath: string; readonly activeSessions: number },
      | DaemonNotRunningError
      | EnvironmentError
      | ProtocolMismatchError
      | UserInputError
      | UnsupportedCapabilityError
      | ChildProcessError
      | SessionConflictError
      | SessionNotFoundError
      | ArtifactNotFoundError
    >
    readonly openSession: (params: {
      readonly target: "simulator" | "device"
      readonly bundleId: string
      readonly simulatorUdid: string | null
      readonly deviceId: string | null
      readonly onEvent?: (stage: string, message: string) => void
    }) => Effect.Effect<
      SessionHealth,
      | DaemonNotRunningError
      | EnvironmentError
      | ProtocolMismatchError
      | UserInputError
      | UnsupportedCapabilityError
      | ChildProcessError
      | SessionConflictError
      | SessionNotFoundError
      | ArtifactNotFoundError
    >
    readonly getSessionHealth: (params: {
      readonly sessionId: string
      readonly onEvent?: (stage: string, message: string) => void
    }) => Effect.Effect<
      SessionHealth,
      | DaemonNotRunningError
      | EnvironmentError
      | ProtocolMismatchError
      | UserInputError
      | UnsupportedCapabilityError
      | ChildProcessError
      | SessionConflictError
      | SessionNotFoundError
      | ArtifactNotFoundError
    >
    readonly closeSession: (params: {
      readonly sessionId: string
      readonly onEvent?: (stage: string, message: string) => void
    }) => Effect.Effect<
      { readonly sessionId: string; readonly state: string; readonly closedAt: string },
      | DaemonNotRunningError
      | EnvironmentError
      | ProtocolMismatchError
      | UserInputError
      | UnsupportedCapabilityError
      | ChildProcessError
      | SessionConflictError
      | SessionNotFoundError
      | ArtifactNotFoundError
    >
    readonly getSessionLogs: (params: {
      readonly sessionId: string
      readonly source: SessionLogSource
      readonly lineCount: number
      readonly match: string | null
      readonly outputMode: OutputMode
      readonly captureSeconds: number
      readonly predicate: string | null
      readonly process: string | null
      readonly subsystem: string | null
      readonly category: string | null
      readonly onEvent?: (stage: string, message: string) => void
    }) => Effect.Effect<
      SessionLogsResult,
      | DaemonNotRunningError
      | EnvironmentError
      | ProtocolMismatchError
      | UserInputError
      | UnsupportedCapabilityError
      | ChildProcessError
      | SessionConflictError
      | SessionNotFoundError
      | ArtifactNotFoundError
    >
    readonly runSessionDebugCommand: (params: {
      readonly sessionId: string
      readonly outputMode: OutputMode
      readonly command: DebugCommandInput
      readonly onEvent?: (stage: string, message: string) => void
    }) => Effect.Effect<
      DebugCommandResult,
      | DaemonNotRunningError
      | EnvironmentError
      | ProtocolMismatchError
      | UserInputError
      | UnsupportedCapabilityError
      | ChildProcessError
      | SessionConflictError
      | SessionNotFoundError
      | ArtifactNotFoundError
    >
    readonly captureScreenshot: (params: {
      readonly sessionId: string
      readonly label: string | null
      readonly outputMode: OutputMode
      readonly onEvent?: (stage: string, message: string) => void
    }) => Effect.Effect<
      SummaryArtifactResult,
      | DaemonNotRunningError
      | EnvironmentError
      | ProtocolMismatchError
      | UserInputError
      | UnsupportedCapabilityError
      | ChildProcessError
      | SessionConflictError
      | SessionNotFoundError
      | ArtifactNotFoundError
    >
    readonly captureSnapshot: (params: {
      readonly sessionId: string
      readonly outputMode: OutputMode
      readonly onEvent?: (stage: string, message: string) => void
    }) => Effect.Effect<
      SessionSnapshotResult,
      | DaemonNotRunningError
      | EnvironmentError
      | ProtocolMismatchError
      | UserInputError
      | UnsupportedCapabilityError
      | ChildProcessError
      | SessionConflictError
      | SessionNotFoundError
      | ArtifactNotFoundError
    >
    readonly performSessionAction: (params: {
      readonly sessionId: string
      readonly action: SessionAction
      readonly onEvent?: (stage: string, message: string) => void
    }) => Effect.Effect<
      SessionActionResult,
      | DaemonNotRunningError
      | EnvironmentError
      | ProtocolMismatchError
      | UserInputError
      | UnsupportedCapabilityError
      | ChildProcessError
      | SessionConflictError
      | SessionNotFoundError
      | ArtifactNotFoundError
    >
    readonly exportSessionRecording: (params: {
      readonly sessionId: string
      readonly label: string | null
      readonly onEvent?: (stage: string, message: string) => void
    }) => Effect.Effect<
      SessionRecordingExportResult,
      | DaemonNotRunningError
      | EnvironmentError
      | ProtocolMismatchError
      | UserInputError
      | UnsupportedCapabilityError
      | ChildProcessError
      | SessionConflictError
      | SessionNotFoundError
      | ArtifactNotFoundError
    >
    readonly replaySessionRecording: (params: {
      readonly sessionId: string
      readonly script: ActionRecordingScript
      readonly onEvent?: (stage: string, message: string) => void
    }) => Effect.Effect<
      SessionReplayResult,
      | DaemonNotRunningError
      | EnvironmentError
      | ProtocolMismatchError
      | UserInputError
      | UnsupportedCapabilityError
      | ChildProcessError
      | SessionConflictError
      | SessionNotFoundError
      | ArtifactNotFoundError
    >
    readonly recordPerf: (params: {
      readonly sessionId: string
      readonly template: PerfTemplate
      readonly timeLimit: string
      readonly onEvent?: (stage: string, message: string) => void
    }) => Effect.Effect<
      PerfRecordResult,
      | DaemonNotRunningError
      | EnvironmentError
      | ProtocolMismatchError
      | UserInputError
      | UnsupportedCapabilityError
      | ChildProcessError
      | SessionConflictError
      | SessionNotFoundError
      | ArtifactNotFoundError
    >
    readonly drillArtifact: (params: {
      readonly sessionId: string
      readonly artifactKey: string
      readonly query: DrillQuery
      readonly outputMode: OutputMode
      readonly onEvent?: (stage: string, message: string) => void
    }) => Effect.Effect<
      DrillResult,
      | DaemonNotRunningError
      | EnvironmentError
      | ProtocolMismatchError
      | UserInputError
      | UnsupportedCapabilityError
      | ChildProcessError
      | SessionConflictError
      | SessionNotFoundError
      | ArtifactNotFoundError
    >
  }
>() {}

export const DaemonClientLive = Layer.effect(
  DaemonClient,
  Effect.gen(function* () {
    const artifactStore = yield* ArtifactStore

    const buildOptions = (onEvent?: (stage: string, message: string) => void) =>
      Effect.gen(function* () {
        const socketPath = yield* artifactStore.getDaemonSocketPath()
        return {
          socketPath,
          timeoutMs: defaultRpcTimeoutMs,
          onEvent: onEvent
            ? (event: { readonly stage: string; readonly message: string }) => onEvent(event.stage, event.message)
            : undefined,
        }
      })

    return DaemonClient.of({
      ping: () =>
        Effect.gen(function* () {
          const options = yield* buildOptions()
          const response = yield* sendDaemonPing(options, {
            kind: "request",
            protocolVersion: PROBE_PROTOCOL_VERSION,
            requestId: randomUUID(),
            method: "daemon.ping",
            params: {},
          })

          return response.result
        }),
      openSession: ({ target, bundleId, simulatorUdid, deviceId, onEvent }) =>
        Effect.gen(function* () {
          const options = yield* buildOptions(onEvent)
          const response = yield* sendSessionOpen(options, {
            kind: "request",
            protocolVersion: PROBE_PROTOCOL_VERSION,
            requestId: randomUUID(),
            method: "session.open",
            params: {
              target,
              bundleId,
              simulatorUdid,
              deviceId,
            },
          })

          return response.result
        }),
      getSessionHealth: ({ sessionId, onEvent }) =>
        Effect.gen(function* () {
          const options = yield* buildOptions(onEvent)
          const response = yield* sendSessionHealth(options, {
            kind: "request",
            protocolVersion: PROBE_PROTOCOL_VERSION,
            requestId: randomUUID(),
            method: "session.health",
            params: { sessionId },
          })

          return response.result
        }),
      closeSession: ({ sessionId, onEvent }) =>
        Effect.gen(function* () {
          const options = yield* buildOptions(onEvent)
          const response = yield* sendSessionClose(options, {
            kind: "request",
            protocolVersion: PROBE_PROTOCOL_VERSION,
            requestId: randomUUID(),
            method: "session.close",
            params: { sessionId },
          })

          return response.result
        }),
      getSessionLogs: ({ sessionId, source, lineCount, match, outputMode, captureSeconds, predicate, process, subsystem, category, onEvent }) =>
        Effect.gen(function* () {
          const options = yield* buildOptions(onEvent)
          const response = yield* sendSessionLogs(options, {
            kind: "request",
            protocolVersion: PROBE_PROTOCOL_VERSION,
            requestId: randomUUID(),
            method: "session.logs",
            params: {
              sessionId,
              source,
              lineCount,
              match,
              outputMode,
              captureSeconds,
              predicate,
              process,
              subsystem,
              category,
            },
          })

          return response.result
        }),
      runSessionDebugCommand: ({ sessionId, outputMode, command, onEvent }) =>
        Effect.gen(function* () {
          const options = yield* buildOptions(onEvent)
          const response = yield* sendSessionDebug(options, {
            kind: "request",
            protocolVersion: PROBE_PROTOCOL_VERSION,
            requestId: randomUUID(),
            method: "session.debug",
            params: {
              sessionId,
              outputMode,
              command,
            },
          })

          return response.result
        }),
      captureScreenshot: ({ sessionId, label, outputMode, onEvent }) =>
        Effect.gen(function* () {
          const options = yield* buildOptions(onEvent)
          const response = yield* sendSessionScreenshot(options, {
            kind: "request",
            protocolVersion: PROBE_PROTOCOL_VERSION,
            requestId: randomUUID(),
            method: "session.screenshot",
            params: {
              sessionId,
              label,
              outputMode,
            },
          })

          return response.result
        }),
      captureSnapshot: ({ sessionId, outputMode, onEvent }) =>
        Effect.gen(function* () {
          const options = yield* buildOptions(onEvent)
          const response = yield* sendSessionSnapshot(options, {
            kind: "request",
            protocolVersion: PROBE_PROTOCOL_VERSION,
            requestId: randomUUID(),
            method: "session.snapshot",
            params: {
              sessionId,
              outputMode,
            },
          })

          return response.result
        }),
      performSessionAction: ({ sessionId, action, onEvent }) =>
        Effect.gen(function* () {
          const options = yield* buildOptions(onEvent)
          const response = yield* sendSessionAction(options, {
            kind: "request",
            protocolVersion: PROBE_PROTOCOL_VERSION,
            requestId: randomUUID(),
            method: "session.action",
            params: {
              sessionId,
              action,
            },
          })

          return response.result
        }),
      exportSessionRecording: ({ sessionId, label, onEvent }) =>
        Effect.gen(function* () {
          const options = yield* buildOptions(onEvent)
          const response = yield* sendSessionRecordingExport(options, {
            kind: "request",
            protocolVersion: PROBE_PROTOCOL_VERSION,
            requestId: randomUUID(),
            method: "session.recording.export",
            params: {
              sessionId,
              label,
            },
          })

          return response.result
        }),
      replaySessionRecording: ({ sessionId, script, onEvent }) =>
        Effect.gen(function* () {
          const options = yield* buildOptions(onEvent)
          const response = yield* sendSessionReplay(options, {
            kind: "request",
            protocolVersion: PROBE_PROTOCOL_VERSION,
            requestId: randomUUID(),
            method: "session.replay",
            params: {
              sessionId,
              script,
            },
          })

          return response.result
        }),
      recordPerf: ({ sessionId, template, timeLimit, onEvent }) =>
        Effect.gen(function* () {
          const options = yield* buildOptions(onEvent)
          const response = yield* sendPerfRecord(options, {
            kind: "request",
            protocolVersion: PROBE_PROTOCOL_VERSION,
            requestId: randomUUID(),
            method: "perf.record",
            params: {
              sessionId,
              template,
              timeLimit,
            },
          })

          return response.result
        }),
      drillArtifact: ({ sessionId, artifactKey, query, outputMode, onEvent }) =>
        Effect.gen(function* () {
          const options = yield* buildOptions(onEvent)
          const response = yield* sendArtifactDrill(options, {
            kind: "request",
            protocolVersion: PROBE_PROTOCOL_VERSION,
            requestId: randomUUID(),
            method: "artifact.drill",
            params: {
              sessionId,
              artifactKey,
              outputMode,
              query,
            },
          })

          return response.result
        }),
    })
  }),
)
