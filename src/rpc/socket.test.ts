import { describe, expect, test } from "bun:test"
import { access, mkdtemp, rm } from "node:fs/promises"
import { createConnection, createServer, type Server, type Socket } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Either, Fiber } from "effect"
import { EnvironmentError, ProtocolMismatchError, type ProbeError } from "../domain/errors"
import { runAppleProcess } from "../services/AppleProcessSupervisor"
import { sendDaemonPing } from "./client"
import { PROBE_PROTOCOL_VERSION } from "./protocol"
import type { RpcResponse } from "./protocol"
import { serveRpc } from "./server"

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

  test("client disconnect interrupts the in-flight request fiber and runs its finalizer (gate 10)", async () => {
    await withTempSocketRoot(async ({ socketPath, metadataPath }) => {
      let started = false
      let interrupted = false
      let resolveStarted: (() => void) | undefined
      const startedPromise = new Promise<void>((resolve) => {
        resolveStarted = resolve
      })
      let resolveInterrupted: (() => void) | undefined
      const interruptedPromise = new Promise<void>((resolve) => {
        resolveInterrupted = resolve
      })

      const serverFiber = Effect.runFork(
        serveRpc({
          socketPath,
          metadataPath,
          onRequest: () =>
            Effect.gen(function* () {
              started = true
              resolveStarted?.()
              // Mirrors AppleProcessSupervisor.run()'s acquireRelease shape:
              // a long-lived resource whose release must run on interruption,
              // not just on normal completion.
              return yield* Effect.never
            }).pipe(
              Effect.onInterrupt(() =>
                Effect.sync(() => {
                  interrupted = true
                  resolveInterrupted?.()
                })),
            ),
          onMetadataWrite: async () => undefined,
          onMetadataRemove: async () => undefined,
        }),
      )

      try {
        await waitForSocket(socketPath)

        const client = createConnection(socketPath)
        await new Promise<void>((resolve, reject) => {
          client.once("connect", () => resolve())
          client.once("error", reject)
        })
        client.write(`${JSON.stringify(daemonPingRequest)}\n`)

        await Promise.race([
          startedPromise,
          sleep(2_000).then(() => {
            throw new Error("Timed out waiting for the request fiber to start.")
          }),
        ])
        expect(started).toBe(true)
        expect(interrupted).toBe(false)

        // Simulate a client disconnect mid-request.
        client.destroy()

        await Promise.race([
          interruptedPromise,
          sleep(2_000).then(() => {
            throw new Error("Timed out waiting for the request fiber to be interrupted.")
          }),
        ])
        expect(interrupted).toBe(true)
      } finally {
        await Effect.runPromise(Fiber.interrupt(serverFiber))
      }
    })
  })

  test(
    "client disconnect during a cancellable xctrace/export-shaped request kills the real owned child (gate 10, end-to-end)",
    async () => {
      await withTempSocketRoot(async ({ socketPath, metadataPath }) => {
        let observedPid = -1
        let resolveSpawned: (() => void) | undefined
        const spawnedPromise = new Promise<void>((resolve) => {
          resolveSpawned = resolve
        })

        // Shaped exactly like PerfService's own call sites after the gate 10
        // fix: Effect.tryPromise's own AbortSignal (derived from this fiber's
        // interruption) threaded straight into AppleProcessSupervisor's
        // `signal`, which is what actually kills the process group.
        const onRequest = (request: { readonly requestId: string }): Effect.Effect<RpcResponse, ProbeError> =>
          Effect.gen(function* () {
            yield* Effect.tryPromise({
              try: (signal) =>
                runAppleProcess({
                  command: "/bin/sh",
                  commandArgs: ["-c", "echo $$; sleep 30"],
                  signal,
                  gracePeriodMs: 200,
                  // run() only resolves once the process closes -- which
                  // never happens on its own here (the child sleeps 30s) --
                  // so the "child has started" signal for this test has to
                  // come from the streaming hook, not from awaiting the
                  // Effect.tryPromise result below.
                  onStdoutChunk: (chunk) => {
                    if (observedPid === -1) {
                      observedPid = Number(chunk.toString("utf8").trim())
                      resolveSpawned?.()
                    }
                  },
                }),
              catch: (error) =>
                new EnvironmentError({
                  code: "test-child-failed",
                  reason: error instanceof Error ? error.message : String(error),
                  nextStep: "n/a",
                  details: [],
                }),
            })

            return {
              kind: "response",
              protocolVersion: PROBE_PROTOCOL_VERSION,
              requestId: request.requestId,
              method: "daemon.ping",
              result: {
                protocolVersion: PROBE_PROTOCOL_VERSION,
                startedAt: new Date().toISOString(),
                processId: process.pid,
                socketPath,
                activeSessions: 0,
              },
            } satisfies RpcResponse
          })

        const serverFiber = Effect.runFork(
          serveRpc({ socketPath, metadataPath, onRequest, onMetadataWrite: async () => undefined, onMetadataRemove: async () => undefined }),
        )

        try {
          await waitForSocket(socketPath)

          const client = createConnection(socketPath)
          await new Promise<void>((resolve, reject) => {
            client.once("connect", () => resolve())
            client.once("error", reject)
          })
          client.write(`${JSON.stringify(daemonPingRequest)}\n`)

          // Poll for the child's pid instead of racing a fixed delay against
          // real process startup.
          await Promise.race([
            spawnedPromise,
            sleep(3_000).then(() => {
              throw new Error("Timed out waiting for the child process to report its pid.")
            }),
          ])

          expect(observedPid).toBeGreaterThan(0)
          expect(() => process.kill(observedPid, 0)).not.toThrow()

          client.destroy()

          // Bounded by AppleProcessSupervisor's own TERM -> grace -> KILL
          // ladder (gracePeriodMs above), not an arbitrary test sleep.
          const deadline = Date.now() + 3_000
          while (Date.now() < deadline) {
            try {
              process.kill(observedPid, 0)
            } catch {
              break
            }
            await sleep(50)
          }

          expect(() => process.kill(observedPid, 0)).toThrow()
        } finally {
          await Effect.runPromise(Fiber.interrupt(serverFiber))
        }
      })
    },
  )

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
