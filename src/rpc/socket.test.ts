import { describe, expect, test } from "bun:test"
import { access, mkdtemp, rm } from "node:fs/promises"
import { createConnection, createServer, type Server, type Socket } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Either, Fiber } from "effect"
import { EnvironmentError, ProtocolMismatchError } from "../domain/errors"
import { sendDaemonPing } from "./client"
import { PROBE_PROTOCOL_VERSION } from "./protocol"
import { serveRpc } from "./server"

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

const withTempSocketRoot = async <T>(run: (paths: { socketPath: string; metadataPath: string }) => Promise<T>) => {
  const root = await mkdtemp(join(tmpdir(), "probe-cli-rpc-"))

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
})
