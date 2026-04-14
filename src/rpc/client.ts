import net from "node:net"
import { Effect } from "effect"
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
import {
  decodeRpcFrameLine,
  encodeRpcLine,
  PROBE_PROTOCOL_VERSION,
  RpcFailure,
  RpcFrame,
  RpcProgressEvent,
  RpcRequest,
} from "./protocol"
import type {
    ArtifactDrillRequest,
    ArtifactDrillResponse,
    PerfAroundRequest,
    PerfAroundResponse,
    DaemonPingRequest,
    DaemonPingResponse,
    PerfRecordRequest,
    PerfRecordResponse,
    PerfSummarizeRequest,
    PerfSummarizeResponse,
    SessionActionRequest,
    SessionActionResponse,
  SessionCloseRequest,
  SessionCloseResponse,
  SessionDebugRequest,
  SessionDebugResponse,
  SessionHealthRequest,
  SessionHealthResponse,
  SessionListRequest,
  SessionListResponse,
  SessionLogsRequest,
  SessionLogsMarkRequest,
  SessionLogsMarkResponse,
  SessionLogsCaptureRequest,
  SessionLogsCaptureResponse,
  SessionDiagnosticCaptureRequest,
  SessionDiagnosticCaptureResponse,
  SessionLogsDoctorRequest,
  SessionLogsDoctorResponse,
  SessionLogsResponse,
  SessionOpenRequest,
  SessionOpenResponse,
    SessionRecordingExportRequest,
    SessionRecordingExportResponse,
    SessionReplayRequest,
    SessionReplayResponse,
    SessionResultAttachmentsRequest,
    SessionResultAttachmentsResponse,
    SessionResultSummaryRequest,
    SessionResultSummaryResponse,
    SessionRunRequest,
    SessionRunResponse,
    SessionSnapshotRequest,
    SessionSnapshotResponse,
  SessionScreenshotRequest,
  SessionScreenshotResponse,
  SessionShowRequest,
  SessionShowResponse,
  SessionVideoRequest,
  SessionVideoResponse,
} from "./protocol"

export interface RpcClientOptions {
  readonly socketPath: string
  readonly timeoutMs: number
  readonly onEvent?: (event: RpcProgressEvent) => void
}

const mapFailureToError = (failure: RpcFailure) => {
  switch (failure.failure.category) {
    case "daemon":
      return new DaemonNotRunningError({
        socketPath: failure.failure.details[0]?.replace(/^socket: /, "") ?? "unknown",
        reason: failure.failure.reason,
        nextStep: failure.failure.nextStep,
      })

    case "protocol":
      return new ProtocolMismatchError({
        expectedVersion: failure.failure.expectedVersion ?? PROBE_PROTOCOL_VERSION,
        receivedVersion: failure.failure.receivedVersion ?? failure.protocolVersion,
        nextStep: failure.failure.nextStep,
      })

    case "user":
      return new UserInputError({
        code: failure.failure.code,
        reason: failure.failure.reason,
        nextStep: failure.failure.nextStep,
        details: [...failure.failure.details],
      })

    case "unsupported":
      return new UnsupportedCapabilityError({
        code: failure.failure.code,
        capability: failure.failure.capability ?? "unknown",
        reason: failure.failure.reason,
        nextStep: failure.failure.nextStep,
        details: [...failure.failure.details],
        wall: failure.failure.wall,
      })

    case "child-process":
      return new ChildProcessError({
        code: failure.failure.code,
        command: failure.failure.command ?? "unknown",
        reason: failure.failure.reason,
        nextStep: failure.failure.nextStep,
        exitCode: failure.failure.exitCode,
        stderrExcerpt: failure.failure.details.join("\n"),
      })

    case "conflict":
      return new SessionConflictError({
        reason: failure.failure.reason,
        nextStep: failure.failure.nextStep,
      })

    case "not-found":
      if (failure.failure.artifactKey && failure.failure.sessionId) {
        return new ArtifactNotFoundError({
          sessionId: failure.failure.sessionId,
          artifactKey: failure.failure.artifactKey,
          nextStep: failure.failure.nextStep,
        })
      }

      return new SessionNotFoundError({
        sessionId: failure.failure.sessionId ?? "unknown",
        nextStep: failure.failure.nextStep,
      })

    default:
      return new EnvironmentError({
        code: failure.failure.code,
        reason: failure.failure.reason,
        nextStep: failure.failure.nextStep,
        details: [...failure.failure.details],
      })
  }
}

const sendRequest = <TResponse extends RpcFrame>(
  options: RpcClientOptions,
  request: RpcRequest,
): Effect.Effect<
  TResponse,
  | DaemonNotRunningError
  | EnvironmentError
  | ProtocolMismatchError
  | UserInputError
  | UnsupportedCapabilityError
  | ChildProcessError
  | SessionConflictError
  | SessionNotFoundError
  | ArtifactNotFoundError
> =>
  Effect.tryPromise({
    try: () =>
      new Promise<TResponse>((resolve, reject) => {
        const socket = net.createConnection(options.socketPath)
        socket.setEncoding("utf8")
        socket.setTimeout(options.timeoutMs)

        let buffer = ""
        let settled = false

        const finalizeError = (error: unknown) => {
          if (settled) {
            return
          }

          settled = true
          socket.destroy()

          if (error instanceof ProtocolMismatchError) {
            reject(error)
            return
          }

          if (error instanceof EnvironmentError) {
            reject(error)
            return
          }

          if (error instanceof Error && "code" in error && error.code === "ENOENT") {
            reject(
              new DaemonNotRunningError({
                socketPath: options.socketPath,
                reason: `No daemon socket was found at ${options.socketPath}.`,
                nextStep: "Start the daemon with `bun run probe -- serve` and retry.",
              }),
            )
            return
          }

          if (error instanceof Error && "code" in error && error.code === "ECONNREFUSED") {
            reject(
              new DaemonNotRunningError({
                socketPath: options.socketPath,
                reason: `The daemon socket at ${options.socketPath} refused the connection.`,
                nextStep: "Restart `bun run probe -- serve` so the stale socket can be replaced.",
              }),
            )
            return
          }

          reject(
            new EnvironmentError({
              code: "rpc-client-io",
              reason: error instanceof Error ? error.message : String(error),
              nextStep: "Inspect the daemon log and retry the command.",
              details: [],
            }),
          )
        }

        const finalizeSuccess = (response: TResponse) => {
          if (settled) {
            return
          }

          settled = true
          resolve(response)
        }

        socket.on("connect", () => {
          socket.write(encodeRpcLine(request))
        })

        socket.on("data", (chunk) => {
          buffer += chunk

          while (buffer.includes("\n")) {
            const newlineIndex = buffer.indexOf("\n")
            const line = buffer.slice(0, newlineIndex).trim()
            buffer = buffer.slice(newlineIndex + 1)

            if (line.length === 0) {
              continue
            }

            let frame: RpcFrame

            try {
              frame = decodeRpcFrameLine(line)
            } catch (error) {
              finalizeError(error)
              return
            }

            if (frame.kind === "event") {
              options.onEvent?.(frame)
              continue
            }

            socket.end()

            if (frame.kind === "failure") {
              settled = true
              reject(mapFailureToError(frame))
              return
            }

            finalizeSuccess(frame as TResponse)
            return
          }
        })

        socket.on("timeout", () => {
          finalizeError(
            new Error(`Timed out waiting for daemon response after ${options.timeoutMs} ms.`),
          )
        })
        socket.on("end", () => {
          if (!settled) {
            finalizeError(
              new EnvironmentError({
                code: "rpc-client-transport-closed",
                reason: "The daemon connection closed before a complete response was received.",
                nextStep: "Retry the command. If it happens again, restart `bun run probe -- serve` because live session recovery is fail-fast rather than transparent.",
                details: [],
              }),
            )
          }
        })
        socket.on("error", finalizeError)
      }),
    catch: (error) =>
      error instanceof DaemonNotRunningError
        || error instanceof EnvironmentError
        || error instanceof ProtocolMismatchError
        || error instanceof UserInputError
        || error instanceof UnsupportedCapabilityError
        || error instanceof ChildProcessError
        || error instanceof SessionConflictError
        || error instanceof SessionNotFoundError
        || error instanceof ArtifactNotFoundError
        ? error
        : new EnvironmentError({
            code: "rpc-client-unexpected",
            reason: error instanceof Error ? error.message : String(error),
            nextStep: "Retry the command. If it keeps failing, restart the daemon.",
            details: [],
          }),
  })

export const sendDaemonPing = (options: RpcClientOptions, request: DaemonPingRequest) =>
  sendRequest<DaemonPingResponse>(options, request)

export const sendSessionList = (options: RpcClientOptions, request: SessionListRequest) =>
  sendRequest<SessionListResponse>(options, request)

export const sendSessionShow = (options: RpcClientOptions, request: SessionShowRequest) =>
  sendRequest<SessionShowResponse>(options, request)

export const sendSessionOpen = (options: RpcClientOptions, request: SessionOpenRequest) =>
  sendRequest<SessionOpenResponse>(options, request)

export const sendSessionHealth = (
  options: RpcClientOptions,
  request: SessionHealthRequest,
) => sendRequest<SessionHealthResponse>(options, request)

export const sendSessionClose = (options: RpcClientOptions, request: SessionCloseRequest) =>
  sendRequest<SessionCloseResponse>(options, request)

export const sendSessionLogs = (options: RpcClientOptions, request: SessionLogsRequest) =>
  sendRequest<SessionLogsResponse>(options, request)

export const sendSessionLogsMark = (options: RpcClientOptions, request: SessionLogsMarkRequest) =>
  sendRequest<SessionLogsMarkResponse>(options, request)

export const sendSessionLogsCapture = (options: RpcClientOptions, request: SessionLogsCaptureRequest) =>
  sendRequest<SessionLogsCaptureResponse>(options, request)

export const sendSessionLogsDoctor = (options: RpcClientOptions, request: SessionLogsDoctorRequest) =>
  sendRequest<SessionLogsDoctorResponse>(options, request)

export const sendSessionDiagnosticCapture = (options: RpcClientOptions, request: SessionDiagnosticCaptureRequest) =>
  sendRequest<SessionDiagnosticCaptureResponse>(options, request)

export const sendSessionDebug = (options: RpcClientOptions, request: SessionDebugRequest) =>
  sendRequest<SessionDebugResponse>(options, request)

export const sendSessionScreenshot = (options: RpcClientOptions, request: SessionScreenshotRequest) =>
  sendRequest<SessionScreenshotResponse>(options, request)

export const sendSessionVideo = (options: RpcClientOptions, request: SessionVideoRequest) =>
  sendRequest<SessionVideoResponse>(options, request)

export const sendSessionAction = (options: RpcClientOptions, request: SessionActionRequest) =>
  sendRequest<SessionActionResponse>(options, request)

export const sendSessionRun = (options: RpcClientOptions, request: SessionRunRequest) =>
  sendRequest<SessionRunResponse>(options, request)

export const sendSessionRecordingExport = (
  options: RpcClientOptions,
  request: SessionRecordingExportRequest,
) => sendRequest<SessionRecordingExportResponse>(options, request)

export const sendSessionReplay = (options: RpcClientOptions, request: SessionReplayRequest) =>
  sendRequest<SessionReplayResponse>(options, request)

export const sendSessionResultSummary = (options: RpcClientOptions, request: SessionResultSummaryRequest) =>
  sendRequest<SessionResultSummaryResponse>(options, request)

export const sendSessionResultAttachments = (options: RpcClientOptions, request: SessionResultAttachmentsRequest) =>
  sendRequest<SessionResultAttachmentsResponse>(options, request)

export const sendSessionSnapshot = (options: RpcClientOptions, request: SessionSnapshotRequest) =>
  sendRequest<SessionSnapshotResponse>(options, request)

export const sendPerfRecord = (options: RpcClientOptions, request: PerfRecordRequest) =>
  sendRequest<PerfRecordResponse>(options, request)

export const sendPerfAround = (options: RpcClientOptions, request: PerfAroundRequest) =>
  sendRequest<PerfAroundResponse>(options, request)

export const sendPerfSummarize = (options: RpcClientOptions, request: PerfSummarizeRequest) =>
  sendRequest<PerfSummarizeResponse>(options, request)

export const sendArtifactDrill = (
  options: RpcClientOptions,
  request: ArtifactDrillRequest,
) => sendRequest<ArtifactDrillResponse>(options, request)
