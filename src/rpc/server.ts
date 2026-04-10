import { createServer } from "node:net"
import { unlink } from "node:fs/promises"
import { Effect, Either } from "effect"
import {
  EnvironmentError,
  isProbeError,
  ProbeError,
  toFailurePayload,
} from "../domain/errors"
import {
  createFailureFrame,
  decodeRpcRequestLine,
  encodeRpcLine,
  PROBE_PROTOCOL_VERSION,
  RpcProgressEvent,
  RpcRequest,
  RpcResponse,
} from "./protocol"

export interface RpcServerConfig {
  readonly socketPath: string
  readonly metadataPath: string
  readonly onRequest: (
    request: RpcRequest,
    emit: (event: RpcProgressEvent) => void,
  ) => Effect.Effect<RpcResponse, ProbeError>
  readonly onMetadataWrite: () => Promise<void>
  readonly onMetadataRemove: () => Promise<void>
}

const waitForSignal = Effect.async<void, never, never>((resume) => {
  let resolved = false

  const handler = () => {
    if (!resolved) {
      resolved = true
      resume(Effect.void)
    }
  }

  process.on("SIGINT", handler)
  process.on("SIGTERM", handler)

  return Effect.sync(() => {
    process.off("SIGINT", handler)
    process.off("SIGTERM", handler)
  })
})

export const serveRpc = (config: RpcServerConfig): Effect.Effect<void, EnvironmentError> =>
  Effect.scoped(
    Effect.acquireRelease(
      Effect.tryPromise({
        try: async () => {
          const server = createServer((socket) => {
            socket.setEncoding("utf8")

            let buffer = ""
            let handled = false

            const writeFrame = (frame: RpcProgressEvent | RpcResponse | ReturnType<typeof createFailureFrame>) => {
              socket.write(encodeRpcLine(frame))
            }

            socket.on("data", (chunk) => {
              if (handled) {
                return
              }

              buffer += chunk

              while (buffer.includes("\n")) {
                const newlineIndex = buffer.indexOf("\n")
                const line = buffer.slice(0, newlineIndex).trim()
                buffer = buffer.slice(newlineIndex + 1)

                if (line.length === 0) {
                  continue
                }

                handled = true

                let request: RpcRequest

                try {
                  const decoded = decodeRpcRequestLine(line)

                  if (decoded.kind === "protocol-mismatch") {
                    const failure = createFailureFrame(
                      {
                        kind: "request",
                        protocolVersion: PROBE_PROTOCOL_VERSION,
                        requestId: decoded.requestId,
                        method: decoded.method,
                        params: {},
                      } as RpcRequest,
                      {
                        code: "protocol-mismatch",
                        category: "protocol",
                        reason: `Expected protocol ${PROBE_PROTOCOL_VERSION} but received ${decoded.receivedVersion}.`,
                        nextStep:
                          "Restart or upgrade the Probe daemon and client so both sides speak the same RPC protocol version.",
                        details: [],
                        capability: null,
                        expectedVersion: PROBE_PROTOCOL_VERSION,
                        receivedVersion: decoded.receivedVersion,
                        command: null,
                        exitCode: null,
                        sessionId: null,
                        artifactKey: null,
                        wall: false,
                      },
                    )
                    writeFrame(failure)
                    socket.end()
                    return
                  }

                  request = decoded.request
                } catch (error) {
                  const fallbackRequest = {
                    kind: "request",
                    protocolVersion: PROBE_PROTOCOL_VERSION,
                    requestId: "invalid-request",
                    method: "daemon.ping",
                    params: {},
                  } as RpcRequest
                  const failure = createFailureFrame(fallbackRequest, {
                    code: "invalid-request",
                    category: "protocol",
                    reason: error instanceof Error ? error.message : String(error),
                    nextStep: "Send a valid JSON request that matches the Probe RPC schema.",
                    details: [],
                    capability: null,
                    expectedVersion: null,
                    receivedVersion: null,
                    command: null,
                    exitCode: null,
                    sessionId: null,
                    artifactKey: null,
                    wall: false,
                  })
                  writeFrame(failure)
                  socket.end()
                  return
                }

                const emit = (event: RpcProgressEvent) => writeFrame(event)

                Effect.runPromise(Effect.either(config.onRequest(request, emit))).then(
                  (result) => {
                    if (Either.isLeft(result)) {
                      const error = result.left

                      if (isProbeError(error)) {
                        writeFrame(createFailureFrame(request, toFailurePayload(error)))
                      } else {
                        writeFrame(
                        createFailureFrame(request, {
                          code: "unhandled-server-error",
                          category: "environment",
                          reason: String(error),
                          nextStep: "Inspect the daemon process output and retry the request.",
                            details: [],
                            capability: null,
                            expectedVersion: null,
                            receivedVersion: null,
                            command: null,
                            exitCode: null,
                            sessionId: null,
                            artifactKey: null,
                            wall: false,
                          }),
                        )
                      }

                      socket.end()
                      return
                    }

                    const response = result.right
                    writeFrame(response)
                    socket.end()
                  },
                  (error) => {
                    writeFrame(
                      createFailureFrame(request, {
                        code: "unhandled-server-error",
                        category: "environment",
                        reason: error instanceof Error ? error.message : String(error),
                        nextStep: "Inspect the daemon process output and retry the request.",
                        details: [],
                        capability: null,
                        expectedVersion: null,
                        receivedVersion: null,
                        command: null,
                        exitCode: null,
                        sessionId: null,
                        artifactKey: null,
                        wall: false,
                      }),
                    )

                    socket.end()
                  },
                )
              }
            })
          })

          await new Promise<void>((resolve, reject) => {
            server.once("error", reject)
            server.listen(config.socketPath, () => resolve())
          })

          await config.onMetadataWrite()
          return server
        },
        catch: (error) =>
          new EnvironmentError({
            code: "rpc-server-start",
            reason: error instanceof Error ? error.message : String(error),
            nextStep: "Check daemon socket permissions and retry `probe serve`.",
            details: [],
          }),
      }),
      (server) =>
        Effect.tryPromise({
          try: async () => {
            await config.onMetadataRemove()
            await new Promise<void>((resolve) => server.close(() => resolve()))
            await unlink(config.socketPath).catch(() => undefined)
          },
          catch: (error) =>
            new EnvironmentError({
              code: "rpc-server-stop",
              reason: error instanceof Error ? error.message : String(error),
              nextStep: "Inspect the daemon process output and retry `probe serve`.",
              details: [],
            }),
        }).pipe(Effect.catchAll(() => Effect.succeed(undefined))),
    ).pipe(Effect.flatMap(() => waitForSignal)),
  )
