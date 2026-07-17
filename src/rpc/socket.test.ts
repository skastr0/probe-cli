import { describe, expect, test } from "bun:test"
import { access, mkdtemp, rm } from "node:fs/promises"
import { createConnection, createServer, Socket, type Server } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Either, Fiber } from "effect"
import type { ProbeError } from "../domain/errors"
import { EnvironmentError, ProtocolMismatchError } from "../domain/errors"
import { sendDaemonPing } from "./client"
import { PROBE_PROTOCOL_VERSION } from "./protocol"
import type { RpcResponse } from "./protocol"
import { MAX_REQUEST_LINE_BYTES, serveRpc } from "./server"

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

const withTempSocketRoot = async <T>(run: (paths: { socketPath: string; metadataPath: string }) => Promise<T>) => {
  const root = await mkdtemp(join(tmpdir(), "probe-rpc-"))

  try {
    return await run({
      socketPath: join(root, "probe.sock"),
      metadataPath: join(root, "daemon.json"),
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

const waitForSocket = async (socketPath: string, timeoutMs = 1_000) => {
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    try {
      await access(socketPath)
      return
    } catch {
      await sleep(10)
    }
  }

  throw new Error(`Timed out waiting for socket ${socketPath}.`)
}

const startRawServer = async (
  socketPath: string,
  onConnection: (socket: Socket) => void,
): Promise<Server> =>
  await new Promise<Server>((resolve, reject) => {
    const server = createServer(onConnection)
    server.once("error", reject)
    server.listen(socketPath, () => resolve(server))
  })

const closeServer = async (server: Server) =>
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error)
        return
      }

      resolve()
    })
  })

const requestRawLine = async (socketPath: string, line: string): Promise<string> =>
  await new Promise<string>((resolve, reject) => {
    const socket = createConnection(socketPath)
    let buffer = ""

    socket.setEncoding("utf8")
    socket.once("connect", () => {
      socket.write(line)
    })
    socket.on("data", (chunk) => {
      buffer += chunk
    })
    socket.once("end", () => resolve(buffer.trim()))
    socket.once("error", reject)
  })

const daemonPingRequest = {
  kind: "request",
  protocolVersion: PROBE_PROTOCOL_VERSION,
  requestId: "req-1",
  method: "daemon.ping",
  params: {},
} as const

describe("rpc socket behavior", () => {
  test("surfaces ProtocolMismatchError for mismatched response frames", async () => {
    await withTempSocketRoot(async ({ socketPath }) => {
      const server = await startRawServer(socketPath, (socket) => {
        socket.setEncoding("utf8")
        socket.once("data", () => {
          socket.end(`${JSON.stringify({
            kind: "response",
            protocolVersion: "probe-rpc/v2",
            requestId: daemonPingRequest.requestId,
            method: "daemon.ping",
            result: {
              protocolVersion: "probe-rpc/v2",
              startedAt: "2026-04-10T00:00:00.000Z",
              processId: 4242,
              socketPath,
              activeSessions: 0,
            },
          })}\n`)
        })
      })

      try {
        const result = await Effect.runPromise(
          Effect.either(sendDaemonPing({ socketPath, timeoutMs: 1_000 }, daemonPingRequest)),
        )

        expect(Either.isLeft(result)).toBe(true)

        if (Either.isLeft(result)) {
          expect(result.left).toBeInstanceOf(ProtocolMismatchError)

          if (result.left instanceof ProtocolMismatchError) {
            expect(result.left.expectedVersion).toBe(PROBE_PROTOCOL_VERSION)
            expect(result.left.receivedVersion).toBe("probe-rpc/v2")
          }
        }
      } finally {
        await closeServer(server)
      }
    })
  })

  test("maps protocol failure payload versions instead of frame versions", async () => {
    await withTempSocketRoot(async ({ socketPath }) => {
      const server = await startRawServer(socketPath, (socket) => {
        socket.setEncoding("utf8")
        socket.once("data", () => {
          socket.end(`${JSON.stringify({
            kind: "failure",
            protocolVersion: PROBE_PROTOCOL_VERSION,
            requestId: daemonPingRequest.requestId,
            method: "daemon.ping",
            failure: {
              code: "protocol-mismatch",
              category: "protocol",
              reason: `Expected protocol ${PROBE_PROTOCOL_VERSION} but received probe-rpc/v0.`,
              nextStep: "upgrade",
              next_step: "upgrade",
              retryable: true,
              details: [],
              capability: null,
              expectedVersion: PROBE_PROTOCOL_VERSION,
              receivedVersion: "probe-rpc/v0",
              command: null,
              exitCode: null,
              sessionId: null,
              artifactKey: null,
              wall: false,
            },
          })}\n`)
        })
      })

      try {
        const result = await Effect.runPromise(
          Effect.either(sendDaemonPing({ socketPath, timeoutMs: 1_000 }, daemonPingRequest)),
        )

        expect(Either.isLeft(result)).toBe(true)

        if (Either.isLeft(result)) {
          expect(result.left).toBeInstanceOf(ProtocolMismatchError)

          if (result.left instanceof ProtocolMismatchError) {
            expect(result.left.expectedVersion).toBe(PROBE_PROTOCOL_VERSION)
            expect(result.left.receivedVersion).toBe("probe-rpc/v0")
          }
        }
      } finally {
        await closeServer(server)
      }
    })
  })

  test("returns the received request version in server protocol mismatch failures", async () => {
    await withTempSocketRoot(async ({ socketPath, metadataPath }) => {
      const fiber = Effect.runFork(
        serveRpc({
          socketPath,
          metadataPath,
          onRequest: () => Effect.die("unexpected request dispatch"),
          onMetadataWrite: async () => undefined,
          onMetadataRemove: async () => undefined,
        }),
      )

      try {
        await waitForSocket(socketPath)

        const responseLine = await requestRawLine(
          socketPath,
          `${JSON.stringify({
            kind: "request",
            protocolVersion: "probe-rpc/v0",
            requestId: "req-mismatch",
            method: "daemon.ping",
            params: {},
          })}\n`,
        )

        const response = JSON.parse(responseLine) as {
          readonly protocolVersion: string
          readonly failure: {
            readonly code: string
            readonly expectedVersion: string | null
            readonly receivedVersion: string | null
          }
        }

        expect(response.protocolVersion).toBe(PROBE_PROTOCOL_VERSION)
        expect(response.failure.code).toBe("protocol-mismatch")
        expect(response.failure.expectedVersion).toBe(PROBE_PROTOCOL_VERSION)
        expect(response.failure.receivedVersion).toBe("probe-rpc/v0")
      } finally {
        await Effect.runPromise(Fiber.interrupt(fiber))
      }
    })
  })

  test("fails fast when the daemon transport closes before a response frame arrives", async () => {
    await withTempSocketRoot(async ({ socketPath }) => {
      const server = await startRawServer(socketPath, (socket) => {
        socket.setEncoding("utf8")
        socket.once("data", () => {
          socket.end()
        })
      })

      try {
        const result = await Effect.runPromise(
          Effect.either(sendDaemonPing({ socketPath, timeoutMs: 1_000 }, daemonPingRequest)),
        )

        expect(Either.isLeft(result)).toBe(true)

        if (Either.isLeft(result)) {
          expect(result.left).toBeInstanceOf(EnvironmentError)

          if (result.left instanceof EnvironmentError) {
            expect(result.left.code).toBe("rpc-client-transport-closed")
          }
        }
      } finally {
        await closeServer(server)
      }
    })
  })

  const makeDaemonPingResponse = (request: { requestId: string }, socketPath: string): RpcResponse =>
    ({
      kind: "response",
      protocolVersion: PROBE_PROTOCOL_VERSION,
      requestId: request.requestId,
      method: "daemon.ping",
      result: {
        protocolVersion: PROBE_PROTOCOL_VERSION,
        startedAt: "2026-04-10T00:00:00.000Z",
        processId: 4242,
        socketPath,
        activeSessions: 0,
      },
    }) as RpcResponse

  test("invokes onRequest at most once when two valid frames arrive in a single chunk", async () => {
    await withTempSocketRoot(async ({ socketPath, metadataPath }) => {
      let requestCount = 0

      const fiber = Effect.runFork(
        serveRpc({
          socketPath,
          metadataPath,
          onRequest: (request) => {
            requestCount += 1
            return Effect.succeed(makeDaemonPingResponse(request, socketPath))
          },
          onMetadataWrite: async () => undefined,
          onMetadataRemove: async () => undefined,
        }),
      )

      try {
        await waitForSocket(socketPath)

        const first = { ...daemonPingRequest, requestId: "req-first" }
        const second = { ...daemonPingRequest, requestId: "req-second" }
        const chunk = `${JSON.stringify(first)}\n${JSON.stringify(second)}\n`

        const buffer = await requestRawLine(socketPath, chunk)
        const frames = buffer
          .split("\n")
          .filter((line) => line.length > 0)
          .map((line) => JSON.parse(line) as { requestId: string })

        expect(requestCount).toBe(1)
        expect(frames).toHaveLength(1)
        expect(frames[0]?.requestId).toBe("req-first")
      } finally {
        await Effect.runPromise(Fiber.interrupt(fiber))
      }
    })
  })

  test("decodes a request fragmented across arbitrary chunks exactly once, preserving progress-then-terminal ordering", async () => {
    await withTempSocketRoot(async ({ socketPath, metadataPath }) => {
      let requestCount = 0

      const fiber = Effect.runFork(
        serveRpc({
          socketPath,
          metadataPath,
          onRequest: (request, emit) => {
            requestCount += 1
            emit({
              kind: "event",
              protocolVersion: PROBE_PROTOCOL_VERSION,
              requestId: request.requestId,
              method: "daemon.ping",
              type: "daemon.ping.progress",
              sequence: 1,
              timestamp: "2026-04-24T12:00:00.000Z",
              stage: "daemon.ping",
              message: "working",
              data: { stage: "daemon.ping", message: "working" },
            })
            return Effect.succeed(makeDaemonPingResponse(request, socketPath))
          },
          onMetadataWrite: async () => undefined,
          onMetadataRemove: async () => undefined,
        }),
      )

      try {
        await waitForSocket(socketPath)

        const line = `${JSON.stringify({ ...daemonPingRequest, requestId: "req-fragmented" })}\n`
        const fragments: Array<string> = []

        for (let index = 0; index < line.length; index += 12) {
          fragments.push(line.slice(index, index + 12))
        }

        const buffer = await new Promise<string>((resolve, reject) => {
          const socket = createConnection(socketPath)
          let received = ""

          socket.setEncoding("utf8")
          socket.once("connect", async () => {
            for (const fragment of fragments) {
              socket.write(fragment)
              await sleep(1)
            }
          })
          socket.on("data", (chunk) => {
            received += chunk
          })
          socket.once("end", () => resolve(received))
          socket.once("error", reject)
        })

        const frames = buffer
          .split("\n")
          .filter((entry) => entry.length > 0)
          .map((entry) => JSON.parse(entry) as { kind: string; requestId: string })

        expect(requestCount).toBe(1)
        expect(frames).toHaveLength(2)
        expect(frames[0]?.kind).toBe("event")
        expect(frames[1]?.kind).toBe("response")
        expect(frames[1]?.requestId).toBe("req-fragmented")
      } finally {
        await Effect.runPromise(Fiber.interrupt(fiber))
      }
    })
  })

  test("interrupts the request fiber and skips writing a response when the client disconnects mid-request", async () => {
    await withTempSocketRoot(async ({ socketPath, metadataPath }) => {
      let started = false
      let interrupted = false

      const fiber = Effect.runFork(
        serveRpc({
          socketPath,
          metadataPath,
          onRequest: () =>
            Effect.gen(function* () {
              started = true
              yield* Effect.never
            }).pipe(
              Effect.onInterrupt(() => Effect.sync(() => {
                interrupted = true
              })),
            ) as unknown as Effect.Effect<RpcResponse, ProbeError>,
          onMetadataWrite: async () => undefined,
          onMetadataRemove: async () => undefined,
        }),
      )

      try {
        await waitForSocket(socketPath)

        const socket = createConnection(socketPath)
        await new Promise<void>((resolve, reject) => {
          socket.once("connect", () => {
            socket.write(`${JSON.stringify(daemonPingRequest)}\n`)
            resolve()
          })
          socket.once("error", reject)
        })

        const startedDeadline = Date.now() + 1_000
        while (!started && Date.now() < startedDeadline) {
          await sleep(5)
        }
        expect(started).toBe(true)

        socket.destroy()

        const interruptedDeadline = Date.now() + 1_000
        while (!interrupted && Date.now() < interruptedDeadline) {
          await sleep(5)
        }
        expect(interrupted).toBe(true)
      } finally {
        await Effect.runPromise(Fiber.interrupt(fiber))
      }
    })
  })

  test("client fiber interruption destroys the socket before the daemon responds", async () => {
    await withTempSocketRoot(async ({ socketPath }) => {
      let serverSawClose = false

      const server = await startRawServer(socketPath, (socket) => {
        socket.once("close", () => {
          serverSawClose = true
        })
        // Deliberately never responds; the client fiber is interrupted before any reply arrives.
      })

      try {
        const clientFiber = Effect.runFork(
          sendDaemonPing({ socketPath, timeoutMs: 10_000 }, daemonPingRequest),
        )

        await sleep(100)

        const start = Date.now()
        await Effect.runPromise(Fiber.interrupt(clientFiber))
        const elapsed = Date.now() - start

        expect(elapsed).toBeLessThan(1_000)

        const deadline = Date.now() + 1_000
        while (!serverSawClose && Date.now() < deadline) {
          await sleep(5)
        }
        expect(serverSawClose).toBe(true)
      } finally {
        await closeServer(server)
      }
    })
  })

  test("client fiber interruption removes every socket listener it registered", async () => {
    await withTempSocketRoot(async ({ socketPath }) => {
      const server = await startRawServer(socketPath, () => {
        // Deliberately never responds; the client fiber is interrupted before any reply arrives.
      })

      let capturedSocket: Socket | null = null
      const registered: Array<{ readonly event: string | symbol; readonly listener: (...args: Array<unknown>) => void }> = []
      const originalOn = Socket.prototype.on

      // Capture the internal socket `sendRequest` creates, and every (event, listener) pair it
      // registers on it, by hooking `.on`. The production code never exposes the socket, so this is
      // the only vantage point from the test for asserting listener cleanup actually happened. Node
      // attaches its own internal listeners to a socket too (e.g. half-close handling on "end"), so
      // this asserts our specific listeners are gone rather than asserting a raw count of zero.
      Socket.prototype.on = function (this: Socket, event: string | symbol, listener: (...args: Array<unknown>) => void) {
        if (event === "connect" && capturedSocket === null) {
          capturedSocket = this
        }
        if (this === capturedSocket) {
          registered.push({ event, listener })
        }
        return originalOn.call(this, event, listener)
      } as typeof Socket.prototype.on

      try {
        const clientFiber = Effect.runFork(
          sendDaemonPing({ socketPath, timeoutMs: 10_000 }, daemonPingRequest),
        )

        await sleep(100)
        await Effect.runPromise(Fiber.interrupt(clientFiber))

        // TypeScript's control-flow analysis only sees `null` as a reachable assignment to
        // `capturedSocket` on this synchronous path (the other assignment lives inside the
        // `Socket.prototype.on` override above), so it narrows the variable to `null` at this read
        // unless the cast below forces the declared union type back.
        const socket = capturedSocket as Socket | null
        expect(socket).not.toBeNull()
        expect(registered.length).toBeGreaterThan(0)

        if (socket !== null) {
          for (const { event, listener } of registered) {
            expect(socket.listeners(event)).not.toContain(listener)
          }
        }
      } finally {
        Socket.prototype.on = originalOn
        await closeServer(server)
      }
    })
  })

  test("daemon shutdown closes an idle accepted socket, removes metadata and the socket file, and completes within a bounded deadline", async () => {
    await withTempSocketRoot(async ({ socketPath, metadataPath }) => {
      let metadataRemoved = false

      const fiber = Effect.runFork(
        serveRpc({
          socketPath,
          metadataPath,
          onRequest: () => Effect.die("unexpected request dispatch"),
          onMetadataWrite: async () => undefined,
          onMetadataRemove: async () => {
            metadataRemoved = true
          },
        }),
      )

      await waitForSocket(socketPath)

      const idleSocket = createConnection(socketPath)
      await new Promise<void>((resolve, reject) => {
        idleSocket.once("connect", () => resolve())
        idleSocket.once("error", reject)
      })

      // The client's "connect" event and the server's "connection" event (which is what tracks the
      // socket for shutdown draining) are delivered independently; give the server a beat to register
      // the accepted socket before tearing the daemon down, so this exercises "drains an already
      // tracked idle connection" rather than a connect/shutdown footrace.
      await sleep(50)

      let idleSocketClosed = false
      idleSocket.once("close", () => {
        idleSocketClosed = true
      })

      const start = Date.now()
      await Effect.runPromise(Fiber.interrupt(fiber))
      const elapsed = Date.now() - start

      expect(elapsed).toBeLessThan(2_000)

      const deadline = Date.now() + 1_000
      while (!idleSocketClosed && Date.now() < deadline) {
        await sleep(5)
      }
      expect(idleSocketClosed).toBe(true)
      expect(metadataRemoved).toBe(true)

      const socketFileStillPresent = await access(socketPath).then(() => true, () => false)
      expect(socketFileStillPresent).toBe(false)
    })
  })

  test("rejects an oversized request line with a typed, bounded protocol failure", async () => {
    await withTempSocketRoot(async ({ socketPath, metadataPath }) => {
      const fiber = Effect.runFork(
        serveRpc({
          socketPath,
          metadataPath,
          onRequest: () => Effect.die("unexpected request dispatch"),
          onMetadataWrite: async () => undefined,
          onMetadataRemove: async () => undefined,
        }),
      )

      try {
        await waitForSocket(socketPath)

        const oversized = "a".repeat(MAX_REQUEST_LINE_BYTES + 1)
        const responseLine = await requestRawLine(socketPath, oversized)
        const response = JSON.parse(responseLine) as { failure: { code: string } }

        expect(response.failure.code).toBe("request-too-large")
      } finally {
        await Effect.runPromise(Fiber.interrupt(fiber))
      }
    })
  })

  test("rejects an empty request line with a typed protocol failure", async () => {
    await withTempSocketRoot(async ({ socketPath, metadataPath }) => {
      const fiber = Effect.runFork(
        serveRpc({
          socketPath,
          metadataPath,
          onRequest: () => Effect.die("unexpected request dispatch"),
          onMetadataWrite: async () => undefined,
          onMetadataRemove: async () => undefined,
        }),
      )

      try {
        await waitForSocket(socketPath)

        const responseLine = await requestRawLine(socketPath, "\n")
        const response = JSON.parse(responseLine) as { failure: { code: string } }

        expect(response.failure.code).toBe("empty-request")
      } finally {
        await Effect.runPromise(Fiber.interrupt(fiber))
      }
    })
  })

  test("rejects malformed JSON with a typed protocol failure", async () => {
    await withTempSocketRoot(async ({ socketPath, metadataPath }) => {
      const fiber = Effect.runFork(
        serveRpc({
          socketPath,
          metadataPath,
          onRequest: () => Effect.die("unexpected request dispatch"),
          onMetadataWrite: async () => undefined,
          onMetadataRemove: async () => undefined,
        }),
      )

      try {
        await waitForSocket(socketPath)

        const responseLine = await requestRawLine(socketPath, "{not json\n")
        const response = JSON.parse(responseLine) as { failure: { code: string } }

        expect(response.failure.code).toBe("invalid-request")
      } finally {
        await Effect.runPromise(Fiber.interrupt(fiber))
      }
    })
  })
})
