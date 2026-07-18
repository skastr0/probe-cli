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
    PerfAnalyzeRequest,
    PerfAnalyzeResponse,
    PerfAroundRequest,
    PerfAroundResponse,
    PerfExportRequest,
    PerfExportResponse,
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
    // `signal` is wired to fiber interruption: if the Effect running this request is interrupted
    // (caller cancellation, command timeout upstream, process shutdown), Node fires "abort" on it
    // before the promise has settled, giving us a hook to tear the socket down instead of leaking it.
    try: (signal) =>
      new Promise<TResponse>((resolve, reject) => {
        const socket = net.createConnection(options.socketPath)
        socket.setEncoding("utf8")
        socket.setTimeout(options.timeoutMs)

        let buffer = ""
        let settled = false
        // PRB-089: the "ambiguous mutation delivery" investigation scenario
        // (src/investigations/rpc-daemon-defects/scenarios/ambiguousMutationDelivery.ts)
        // proved a caller could not tell a dropped/reordered progress event
        // from a complete stream, because `RpcProgressEvent.sequence` was
        // declared but never validated. This client is the only consumer of
        // that field, so it is the only place a gap can be detected: track
        // the last-seen sequence and fail the whole request the moment a
        // later event skips one, instead of letting it resolve as if
        // nothing were missing.
        let lastEventSequence: number | null = null

        const detach = () => {
          socket.removeListener("connect", onConnect)
          socket.removeListener("data", onData)
          socket.removeListener("timeout", onTimeout)
          socket.removeListener("end", onEnd)
          socket.removeListener("close", onClose)
          socket.removeListener("error", onError)
          signal.removeEventListener("abort", onAbort)
        }

        const finalizeError = (error: unknown) => {
          if (settled) {
            return
          }

          settled = true
          detach()
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
          detach()
          resolve(response)
        }

        const finalizeFailureFrame = (failure: RpcFailure) => {
          if (settled) {
            return
          }

          settled = true
          detach()
          reject(mapFailureToError(failure))
        }

        const onAbort = () => {
          if (settled) {
            return
          }

          settled = true
          detach()
          socket.destroy()
          reject(
            new EnvironmentError({
              code: "rpc-client-interrupted",
              reason: "The Probe RPC request was interrupted before the daemon responded.",
              nextStep: "Retry the command.",
              details: [],
            }),
          )
        }

        const onConnect = () => {
          socket.write(encodeRpcLine(request))
        }

        const onData = (chunk: string) => {
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
              if (lastEventSequence !== null && frame.sequence > lastEventSequence + 1) {
                finalizeError(
                  new EnvironmentError({
                    code: "rpc-progress-sequence-gap",
                    reason: `The daemon's progress stream for ${request.method} skipped from sequence `
                      + `${lastEventSequence} to ${frame.sequence}; at least one progress event was lost `
                      + "or reordered in transit.",
                    nextStep: "Retry the command. If this recurs, file a bug with the request id and both sequence numbers.",
                    details: [],
                  }),
                )
                return
              }

              lastEventSequence = frame.sequence
              options.onEvent?.(frame)
              continue
            }

            socket.end()

            if (frame.kind === "failure") {
              finalizeFailureFrame(frame)
              return
            }

            finalizeSuccess(frame as TResponse)
            return
          }
        }

        const onTimeout = () => {
          finalizeError(
            new Error(`Timed out waiting for daemon response after ${options.timeoutMs} ms.`),
          )
        }

        const onTransportClosed = () => {
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
        }

        // "end" (readable side closed) and "close" (socket fully torn down, sometimes without a
        // preceding "end" -- e.g. an RST) are both terminal-without-a-response signals; either can
        // arrive first, so both route through the same guarded finalizer.
        const onEnd = onTransportClosed
        const onClose = onTransportClosed

        const onError = (error: unknown) => finalizeError(error)

        socket.on("connect", onConnect)
        socket.on("data", onData)
        socket.on("timeout", onTimeout)
        socket.on("end", onEnd)
        socket.on("close", onClose)
        socket.on("error", onError)

        if (signal.aborted) {
          onAbort()
        } else {
          signal.addEventListener("abort", onAbort, { once: true })
        }
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

export const sendPerfExport = (options: RpcClientOptions, request: PerfExportRequest) =>
  sendRequest<PerfExportResponse>(options, request)

export const sendPerfAnalyze = (options: RpcClientOptions, request: PerfAnalyzeRequest) =>
  sendRequest<PerfAnalyzeResponse>(options, request)

export const sendArtifactDrill = (
  options: RpcClientOptions,
  request: ArtifactDrillRequest,
) => sendRequest<ArtifactDrillResponse>(options, request)
