import { createServer } from "node:net"
import { unlink } from "node:fs/promises"
import { Cause, Effect, Either, Exit, Fiber } from "effect"
import {
  EnvironmentError,
  isProbeError,
  toFailurePayload,
} from "../domain/errors"
import type { ProbeError } from "../domain/errors"
import {
  createFailureFrame,
  decodeRpcRequestLine,
  encodeRpcLine,
  PROBE_PROTOCOL_VERSION,
} from "./protocol"
import type { RpcProgressEvent, RpcRequest, RpcResponse } from "./protocol"

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
            // Defensive: a write racing an already-closing socket (e.g. the
            // client disconnected while a response frame was in flight) must
            // not crash the daemon -- an unhandled 'error' event does.
            socket.on("error", () => undefined)

            let buffer = ""
            let handled = false
            // The fiber running the in-flight `config.onRequest(...)` for
            // this connection, so a client disconnect (gate 10) can interrupt
            // it instead of leaving it to run to completion unobserved. Effect
            // propagates that interruption down through every `yield*` in the
            // request handler, including `Effect.tryPromise`'s AbortSignal --
            // which is what actually reaches the owned child process via
            // AppleProcessSupervisor's `signal` racing.
            let activeFiber: Fiber.RuntimeFiber<Either.Either<RpcResponse, ProbeError>, never> | null = null

            const writeFrame = (frame: RpcProgressEvent | RpcResponse | ReturnType<typeof createFailureFrame>) => {
              if (socket.destroyed) {
                return
              }
              socket.write(encodeRpcLine(frame))
            }

            socket.on("close", () => {
              const fiber = activeFiber
              if (fiber !== null) {
                activeFiber = null
                Effect.runFork(Fiber.interrupt(fiber))
              }
            })

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
                        contract: null,
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
                    contract: null,
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

                const writeUnhandledFailure = (error: unknown) =>
                  writeFrame(
                    createFailureFrame(request, {
                      code: "unhandled-server-error",
                      category: "environment",
                      reason: error instanceof Error ? error.message : String(error),
                      nextStep: "Inspect the daemon process output and retry the request.",
                      details: [],
                      capability: null,
                      contract: null,
                      expectedVersion: null,
                      receivedVersion: null,
                      command: null,
                      exitCode: null,
                      sessionId: null,
                      artifactKey: null,
                      wall: false,
                    }),
                  )

                // Tracked via runFork (not runPromise) so the socket's own
                // 'close' listener above can interrupt this fiber on a client
                // disconnect (gate 10) instead of only observing whatever
                // Promise it eventually settles to.
                const fiber = Effect.runFork(Effect.either(config.onRequest(request, emit)))
                activeFiber = fiber

                fiber.addObserver((exit) => {
                  activeFiber = null

                  if (Exit.isFailure(exit)) {
                    if (Cause.isInterruptedOnly(exit.cause)) {
                      // The socket already closed (that's what triggered the
                      // interrupt) -- nothing left to write to.
                      return
                    }

                    writeUnhandledFailure(Cause.pretty(exit.cause))
                    socket.end()
                    return
                  }

                  const result = exit.value

                  if (Either.isLeft(result)) {
                    const error = result.left

                    if (isProbeError(error)) {
                      writeFrame(createFailureFrame(request, toFailurePayload(error)))
                    } else {
                      writeUnhandledFailure(error)
                    }

                    socket.end()
                    return
                  }

                  writeFrame(result.right)
                  socket.end()
                })
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
