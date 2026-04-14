import { randomUUID } from "node:crypto"
import { Context, Effect, Layer } from "effect"
import type {
  ActionRecordingScript,
  SessionAction,
  SessionActionResult,
  SessionRecordingExportResult,
  SessionReplayResult,
} from "../domain/action"
import type { SessionFlowContract, SessionFlowResult } from "../domain/flow-v2"
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
import type {
  DrillQuery,
  DrillResult,
  OutputMode,
  SessionResultAttachmentsResult,
  SessionLogDoctorReport,
  SessionLogSource,
  SessionLogsResult,
  SessionResultSummaryResult,
  SessionScreenshotResult,
  SummaryArtifactResult,
} from "../domain/output"
import type { DiagnosticCaptureKind, DiagnosticCaptureTarget } from "../domain/diagnostics"
import type {
  PerfAroundFlowResult,
  PerfRecordResult,
  PerfSignpostSummaryResult,
  PerfTemplate,
} from "../domain/perf"
import type { SessionHealth, SessionListEntry, SimulatorSessionMode } from "../domain/session"
import { ArtifactStore } from "./ArtifactStore"
import {
  sendArtifactDrill,
  sendPerfAround,
  sendDaemonPing,
  sendPerfRecord,
  sendPerfSummarize,
  sendSessionAction,
  sendSessionClose,
  sendSessionDebug,
  sendSessionHealth,
  sendSessionList,
  sendSessionLogs,
  sendSessionDiagnosticCapture,
  sendSessionLogsCapture,
  sendSessionLogsDoctor,
  sendSessionLogsMark,
  sendSessionOpen,
  sendSessionRecordingExport,
  sendSessionReplay,
  sendSessionResultAttachments,
  sendSessionResultSummary,
  sendSessionRun,
  sendSessionSnapshot,
  sendSessionScreenshot,
  sendSessionShow,
  sendSessionVideo,
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
    readonly listSessions: (params: {
      readonly onEvent?: (stage: string, message: string) => void
    }) => Effect.Effect<
      ReadonlyArray<SessionListEntry>,
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
      readonly sessionMode?: SimulatorSessionMode | null
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
    readonly showSession: (params: {
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
    readonly markSessionLog: (params: {
      readonly sessionId: string
      readonly label: string
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
    readonly captureLogWindow: (params: {
      readonly sessionId: string
      readonly captureSeconds: number
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
    readonly getLogDoctorReport: (params: {
      readonly sessionId: string
      readonly onEvent?: (stage: string, message: string) => void
    }) => Effect.Effect<
      SessionLogDoctorReport,
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
    readonly captureDiagnosticBundle: (params: {
      readonly sessionId: string
      readonly target: DiagnosticCaptureTarget
      readonly kind: DiagnosticCaptureKind | null
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
      SessionScreenshotResult,
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
    readonly recordVideo: (params: {
      readonly sessionId: string
      readonly duration: string
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
    readonly runSessionFlow: (params: {
      readonly sessionId: string
      readonly flow: SessionFlowContract
      readonly onEvent?: (stage: string, message: string) => void
    }) => Effect.Effect<
      SessionFlowResult,
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
    readonly getSessionResultSummary: (params: {
      readonly sessionId: string
      readonly onEvent?: (stage: string, message: string) => void
    }) => Effect.Effect<
      SessionResultSummaryResult,
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
    readonly getSessionResultAttachments: (params: {
      readonly sessionId: string
      readonly onEvent?: (stage: string, message: string) => void
    }) => Effect.Effect<
      SessionResultAttachmentsResult,
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
      readonly template?: PerfTemplate
      readonly customTemplatePath?: string
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
    readonly recordPerfAroundFlow: (params: {
      readonly sessionId: string
      readonly template: PerfTemplate
      readonly flow: SessionFlowContract
      readonly onEvent?: (stage: string, message: string) => void
    }) => Effect.Effect<
      PerfAroundFlowResult,
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
    readonly summarizePerfBySignpost: (params: {
      readonly sessionId: string
      readonly artifactKey: string
      readonly onEvent?: (stage: string, message: string) => void
    }) => Effect.Effect<
      PerfSignpostSummaryResult,
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

    const buildOptions = (onEvent?: (stage: string, message: string) => void, timeoutMs = defaultRpcTimeoutMs) =>
      Effect.gen(function* () {
        const socketPath = yield* artifactStore.getDaemonSocketPath()
        return {
          socketPath,
          timeoutMs,
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
      listSessions: ({ onEvent }) =>
        Effect.gen(function* () {
          const options = yield* buildOptions(onEvent)
          const response = yield* sendSessionList(options, {
            kind: "request",
            protocolVersion: PROBE_PROTOCOL_VERSION,
            requestId: randomUUID(),
            method: "session.list",
            params: {},
          })

          return response.result
        }),
      openSession: ({ target, bundleId, sessionMode, simulatorUdid, deviceId, onEvent }) =>
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
              sessionMode: sessionMode ?? null,
              simulatorUdid,
              deviceId,
            },
          })

          return response.result
        }),
      showSession: ({ sessionId, onEvent }) =>
        Effect.gen(function* () {
          const options = yield* buildOptions(onEvent)
          const response = yield* sendSessionShow(options, {
            kind: "request",
            protocolVersion: PROBE_PROTOCOL_VERSION,
            requestId: randomUUID(),
            method: "session.show",
            params: { sessionId },
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
      markSessionLog: ({ sessionId, label, onEvent }) =>
        Effect.gen(function* () {
          const options = yield* buildOptions(onEvent)
          const response = yield* sendSessionLogsMark(options, {
            kind: "request",
            protocolVersion: PROBE_PROTOCOL_VERSION,
            requestId: randomUUID(),
            method: "session.logs.mark",
            params: {
              sessionId,
              label,
            },
          })

          return response.result
        }),
      captureLogWindow: ({ sessionId, captureSeconds, onEvent }) =>
        Effect.gen(function* () {
          const options = yield* buildOptions(onEvent)
          const response = yield* sendSessionLogsCapture(options, {
            kind: "request",
            protocolVersion: PROBE_PROTOCOL_VERSION,
            requestId: randomUUID(),
            method: "session.logs.capture",
            params: {
              sessionId,
              captureSeconds,
            },
          })

          return response.result
        }),
      getLogDoctorReport: ({ sessionId, onEvent }) =>
        Effect.gen(function* () {
          const options = yield* buildOptions(onEvent)
          const response = yield* sendSessionLogsDoctor(options, {
            kind: "request",
            protocolVersion: PROBE_PROTOCOL_VERSION,
            requestId: randomUUID(),
            method: "session.logs.doctor",
            params: {
              sessionId,
            },
          })

          return response.result
        }),
      captureDiagnosticBundle: ({ sessionId, target, kind, onEvent }) =>
        Effect.gen(function* () {
          const options = yield* buildOptions(onEvent, 60 * 60_000)
          const response = yield* sendSessionDiagnosticCapture(options, {
            kind: "request",
            protocolVersion: PROBE_PROTOCOL_VERSION,
            requestId: randomUUID(),
            method: "session.diagnostic.capture",
            params: {
              sessionId,
              target,
              kind,
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
      recordVideo: ({ sessionId, duration, onEvent }) =>
        Effect.gen(function* () {
          const options = yield* buildOptions(onEvent)
          const response = yield* sendSessionVideo(options, {
            kind: "request",
            protocolVersion: PROBE_PROTOCOL_VERSION,
            requestId: randomUUID(),
            method: "session.video",
            params: {
              sessionId,
              duration,
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
      runSessionFlow: ({ sessionId, flow, onEvent }) =>
        Effect.gen(function* () {
          const options = yield* buildOptions(onEvent)
          const response = yield* sendSessionRun(options, {
            kind: "request",
            protocolVersion: PROBE_PROTOCOL_VERSION,
            requestId: randomUUID(),
            method: "session.run",
            params: {
              sessionId,
              flow,
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
      getSessionResultSummary: ({ sessionId, onEvent }) =>
        Effect.gen(function* () {
          const options = yield* buildOptions(onEvent)
          const response = yield* sendSessionResultSummary(options, {
            kind: "request",
            protocolVersion: PROBE_PROTOCOL_VERSION,
            requestId: randomUUID(),
            method: "session.result.summary",
            params: {
              sessionId,
            },
          })

          return response.result
        }),
      getSessionResultAttachments: ({ sessionId, onEvent }) =>
        Effect.gen(function* () {
          const options = yield* buildOptions(onEvent)
          const response = yield* sendSessionResultAttachments(options, {
            kind: "request",
            protocolVersion: PROBE_PROTOCOL_VERSION,
            requestId: randomUUID(),
            method: "session.result.attachments",
            params: {
              sessionId,
            },
          })

          return response.result
        }),
      recordPerf: ({ sessionId, template, customTemplatePath, timeLimit, onEvent }) =>
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
              customTemplatePath,
              timeLimit,
            },
          })

          return response.result
        }),
      recordPerfAroundFlow: ({ sessionId, template, flow, onEvent }) =>
        Effect.gen(function* () {
          const options = yield* buildOptions(onEvent)
          const response = yield* sendPerfAround(options, {
            kind: "request",
            protocolVersion: PROBE_PROTOCOL_VERSION,
            requestId: randomUUID(),
            method: "perf.around",
            params: {
              sessionId,
              template,
              flow,
            },
          })

          return response.result
        }),
      summarizePerfBySignpost: ({ sessionId, artifactKey, onEvent }) =>
        Effect.gen(function* () {
          const options = yield* buildOptions(onEvent)
          const response = yield* sendPerfSummarize(options, {
            kind: "request",
            protocolVersion: PROBE_PROTOCOL_VERSION,
            requestId: randomUUID(),
            method: "perf.summarize",
            params: {
              sessionId,
              artifactKey,
              groupBy: "signpost",
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
