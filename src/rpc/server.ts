import { createServer, type Server, type Socket } from "node:net"
import { unlink } from "node:fs/promises"
import { Cause, Effect, Either, Fiber, Runtime } from "effect"
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
import type { RpcMethod, RpcProgressEvent, RpcRequest, RpcResponse } from "./protocol"

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

/**
 * Bounds how many bytes of a single request frame the server will buffer while waiting for the
 * terminating newline. A client that never sends one (accidental or hostile) fails fast with a typed
 * protocol failure instead of growing the daemon's memory without limit.
 */
export const MAX_REQUEST_LINE_BYTES = 1024 * 1024

/**
 * Bounds how long daemon shutdown waits on connection fibers to unwind after they are interrupted.
 * Interruption itself destroys every accepted socket via each fiber's finalizer, so this is a safety
 * cap against a stuck finalizer, not the expected common-case duration.
 */
const SHUTDOWN_DRAIN_TIMEOUT_MS = 5_000

type OutboundFrame = RpcProgressEvent | RpcResponse | ReturnType<typeof createFailureFrame>

/**
 * Every write on the request path goes through this guard. Writing to a socket that already ended or
 * was destroyed throws in Node, so a lost peer becomes a structured no-op here instead of an uncaught
 * write-after-end error.
 */
const makeFrameWriter = (socket: Socket) => (frame: OutboundFrame): void => {
  if (socket.destroyed || socket.writableEnded) {
    return
  }

  try {
    socket.write(encodeRpcLine(frame))
  } catch {
    // The socket died between the guard above and the write call; a structured no-op beats a crash.
  }
}

const fallbackRequest = (requestId: string, method: RpcMethod = "daemon.ping"): RpcRequest =>
  ({
    kind: "request",
    protocolVersion: PROBE_PROTOCOL_VERSION,
    requestId,
    method,
    params: {},
  }) as RpcRequest

const protocolFailure = (
  request: RpcRequest,
  code: string,
  reason: string,
  nextStep: string,
  versions?: { readonly expectedVersion: string; readonly receivedVersion: string },
) =>
  createFailureFrame(request, {
    code,
    category: "protocol",
    reason,
    nextStep,
    details: [],
    capability: null,
    expectedVersion: versions?.expectedVersion ?? null,
    receivedVersion: versions?.receivedVersion ?? null,
    command: null,
    exitCode: null,
    sessionId: null,
    artifactKey: null,
    wall: false,
  })

const environmentFailure = (request: RpcRequest, reason: string) =>
  createFailureFrame(request, {
    code: "unhandled-server-error",
    category: "environment",
    reason,
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
  })

class RequestLineTooLargeError {
  readonly _tag = "RequestLineTooLargeError"
}

class RequestLineEmptyError {
  readonly _tag = "RequestLineEmptyError"
}

class RequestLineClosedError {
  readonly _tag = "RequestLineClosedError"
}

type RequestLineError = RequestLineTooLargeError | RequestLineEmptyError | RequestLineClosedError

/**
 * Reads exactly the first newline-delimited frame off the socket, however many chunks it arrives in.
 * Bytes buffered after that first newline are never inspected -- the one-request-per-connection
 * contract means a second frame arriving in the same chunk, or a later one, is deterministically
 * ignored rather than decoded and dispatched.
 */
const readRequestLine = (socket: Socket): Effect.Effect<string, RequestLineError> =>
  Effect.async<string, RequestLineError>((resume) => {
    let buffer = ""
    let settled = false

    const cleanup = () => {
      socket.removeListener("data", onData)
      socket.removeListener("end", onEnd)
    }

    const settle = (effect: Effect.Effect<string, RequestLineError>) => {
      if (settled) {
        return
      }

      settled = true
      cleanup()
      resume(effect)
    }

    const onData = (chunk: string) => {
      if (settled) {
        return
      }

      buffer += chunk
      const newlineIndex = buffer.indexOf("\n")

      if (newlineIndex === -1) {
        if (buffer.length > MAX_REQUEST_LINE_BYTES) {
          settle(Effect.fail(new RequestLineTooLargeError()))
        }
        return
      }

      const line = buffer.slice(0, newlineIndex).trim()

      if (line.length === 0) {
        settle(Effect.fail(new RequestLineEmptyError()))
        return
      }

      settle(Effect.succeed(line))
    }

    const onEnd = () => {
      settle(Effect.fail(new RequestLineClosedError()))
    }

    socket.on("data", onData)
    socket.on("end", onEnd)

    return Effect.sync(cleanup)
  })

/**
 * Handles exactly one request for one accepted connection. This is the effect the daemon tracks as
 * "the request fiber" for the connection: the caller forks it once per accepted socket and interrupts
 * it when the socket closes or errors. `Effect.ensuring` guarantees the socket is destroyed on every
 * exit path -- success, a typed protocol failure, an unexpected defect, or interruption mid-flight.
 */
const handleConnection = (socket: Socket, config: RpcServerConfig): Effect.Effect<void> => {
  const writeFrame = makeFrameWriter(socket)

  return Effect.gen(function* () {
    socket.setEncoding("utf8")

    const line = yield* Effect.either(readRequestLine(socket))

    if (Either.isLeft(line)) {
      const error = line.left

      if (error._tag === "RequestLineClosedError") {
        // The peer disconnected before a full frame arrived; there is no one left to answer.
        return
      }

      const failure = error._tag === "RequestLineTooLargeError"
        ? protocolFailure(
            fallbackRequest("invalid-request"),
            "request-too-large",
            `Request line exceeded the ${MAX_REQUEST_LINE_BYTES}-byte bound before a newline was found.`,
            "Send a single newline-delimited Probe RPC request frame within the size bound.",
          )
        : protocolFailure(
            fallbackRequest("invalid-request"),
            "empty-request",
            "Received an empty request line.",
            "Send a valid JSON request that matches the Probe RPC schema.",
          )

      writeFrame(failure)
      socket.end()
      return
    }

    let decoded: ReturnType<typeof decodeRpcRequestLine>

    try {
      decoded = decodeRpcRequestLine(line.right)
    } catch (error) {
      writeFrame(
        protocolFailure(
          fallbackRequest("invalid-request"),
          "invalid-request",
          error instanceof Error ? error.message : String(error),
          "Send a valid JSON request that matches the Probe RPC schema.",
        ),
      )
      socket.end()
      return
    }

    if (decoded.kind === "protocol-mismatch") {
      writeFrame(
        protocolFailure(
          fallbackRequest(decoded.requestId, decoded.method),
          "protocol-mismatch",
          `Expected protocol ${PROBE_PROTOCOL_VERSION} but received ${decoded.receivedVersion}.`,
          "Restart or upgrade the Probe daemon and client so both sides speak the same RPC protocol version.",
          { expectedVersion: PROBE_PROTOCOL_VERSION, receivedVersion: decoded.receivedVersion },
        ),
      )
      socket.end()
      return
    }

    const request = decoded.request
    const emit = (event: RpcProgressEvent) => writeFrame(event)

    const result = yield* Effect.either(config.onRequest(request, emit))

    if (Either.isLeft(result)) {
      const error = result.left

      writeFrame(
        isProbeError(error)
          ? createFailureFrame(request, toFailurePayload(error))
          : environmentFailure(request, String(error)),
      )
      socket.end()
      return
    }

    writeFrame(result.right)
    socket.end()
  }).pipe(
    Effect.catchAllCause((cause) =>
      Cause.isInterruptedOnly(cause)
        ? Effect.void
        : Effect.sync(() => {
            writeFrame(environmentFailure(fallbackRequest("invalid-request"), Cause.pretty(cause)))
            socket.end()
          }),
    ),
    Effect.ensuring(
      Effect.sync(() => {
        if (!socket.destroyed) {
          socket.destroy()
        }
      }),
    ),
  )
}

export const serveRpc = (config: RpcServerConfig): Effect.Effect<void, EnvironmentError> =>
  Effect.scoped(
    Effect.gen(function* () {
      // Captures the ambient runtime (the same ManagedRuntime the daemon graph already runs under) so
      // that forking per-connection request fibers from raw `node:net` callbacks never spins up a
      // second runtime.
      const runtime = yield* Effect.runtime<never>()
      const runFork = Runtime.runFork(runtime)
      const connections = new Map<Socket, Fiber.RuntimeFiber<void, never>>()

      yield* Effect.acquireRelease(
        Effect.gen(function* () {
          const nodeServer = yield* Effect.async<Server, EnvironmentError>((resume) => {
            const nodeServer = createServer((socket) => {
              const fiber = runFork(handleConnection(socket, config))
              connections.set(socket, fiber)
              fiber.addObserver(() => connections.delete(socket))

              const interruptOnTeardown = () => {
                runFork(Fiber.interrupt(fiber))
              }

              socket.once("close", interruptOnTeardown)
              socket.once("error", interruptOnTeardown)
            })

            nodeServer.once("error", (error) => {
              resume(
                Effect.fail(
                  new EnvironmentError({
                    code: "rpc-server-start",
                    reason: error instanceof Error ? error.message : String(error),
                    nextStep: "Check daemon socket permissions and retry `probe serve`.",
                    details: [],
                  }),
                ),
              )
            })

            nodeServer.listen(config.socketPath, () => resume(Effect.succeed(nodeServer)))
          })

          yield* Effect.tryPromise({
            try: () => config.onMetadataWrite(),
            catch: (error) =>
              new EnvironmentError({
                code: "rpc-server-start",
                reason: error instanceof Error ? error.message : String(error),
                nextStep: "Check daemon socket permissions and retry `probe serve`.",
                details: [],
              }),
          })

          return nodeServer
        }),
        (nodeServer) =>
          Effect.gen(function* () {
            yield* Effect.tryPromise({
              try: () => config.onMetadataRemove(),
              catch: () => undefined,
            }).pipe(Effect.catchAll(() => Effect.void))

            // Stop accepting new connections immediately; do not block shutdown on existing ones
            // draining on their own.
            yield* Effect.sync(() => {
              nodeServer.close(() => undefined)
            })

            // Interrupting each tracked fiber runs its `Effect.ensuring` finalizer, which destroys the
            // socket. That is what unblocks Node's `server.close` when an idle accepted connection
            // would otherwise keep it waiting forever. Bounded so a stuck finalizer can never hang
            // daemon shutdown.
            //
            // This release effect runs in Effect's uninterruptible finalizer region, and `Effect.race`
            // only cancels its loser promptly when the race itself is interruptible -- otherwise the
            // loser (the sleep) is left to run to completion, defeating the bound. `Effect.interruptible`
            // opts the race back in without weakening the "release never fails" guarantee below.
            const interruptAll = Effect.forEach(
              Array.from(connections.values()),
              (fiber) => Fiber.interrupt(fiber),
              { concurrency: "unbounded", discard: true },
            )

            yield* Effect.interruptible(Effect.race(interruptAll, Effect.sleep(SHUTDOWN_DRAIN_TIMEOUT_MS)))

            yield* Effect.tryPromise({
              try: () => unlink(config.socketPath),
              catch: () => undefined,
            }).pipe(Effect.catchAll(() => Effect.void))
          }).pipe(Effect.catchAllCause(() => Effect.void)),
      )

      yield* waitForSignal
    }),
  )
