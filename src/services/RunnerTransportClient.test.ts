import { describe, expect, test } from "bun:test"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { Effect, Fiber } from "effect"
import { decodeRunnerCommandFrame } from "./runnerProtocol"
import {
  resolveRunnerCommandTimeoutMs,
  RunnerTransportClientLive,
  RunnerTransportError,
  runRunnerTransportSend,
  sendRunnerCommand,
} from "./RunnerTransportClient"

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

const okResponseBody = (sequence: number): string =>
  JSON.stringify({
    kind: "response",
    sequence,
    ok: true,
    action: "ping",
    error: null,
    payload: "pong",
    snapshotPayloadPath: null,
    inlinePayload: null,
    inlinePayloadEncoding: null,
    handledMs: 1,
    statusLabel: "ok",
    snapshotNodeCount: null,
    recordedAt: new Date().toISOString(),
  })

const withServer = async (
  handler: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<{ readonly url: string; readonly close: () => Promise<void>; readonly wasAborted: () => boolean }> => {
  let aborted = false
  const server = createServer((request, response) => {
    request.on("aborted", () => {
      aborted = true
    })
    handler(request, response)
  })

  const address = await new Promise<string>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const info = server.address()

      if (typeof info !== "object" || info === null) {
        reject(new Error("Expected the fake runner server to bind to a TCP address."))
        return
      }

      resolve(`http://127.0.0.1:${info.port}/command`)
    })
  })

  return {
    url: address,
    wasAborted: () => aborted,
    // A deliberately-hung handler may leave a connection dangling after the
    // client aborts it, so force every connection closed instead of
    // Server#close, whose callback only resolves once all connections have
    // ended on their own. (On this runtime, closeAllConnections() already
    // fully stops the server; a follow-up close() throws "not running".)
    close: () => Promise.resolve(server.closeAllConnections()),
  }
}

// Reliably-refused endpoint: bind a TCP listener, capture its port, then
// close it before returning. Nothing is listening on the port afterward, so
// a connection attempt fails fast and unambiguously (ECONNREFUSED-shaped).
const unreachableEndpoint = async (): Promise<string> => {
  const server = createServer()

  const port = await new Promise<number>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const info = server.address()
      resolve(typeof info === "object" && info !== null ? info.port : 0)
    })
  })

  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()))
  })

  return `http://127.0.0.1:${port}/command`
}

const readCommandFrame = (request: IncomingMessage): Promise<ReturnType<typeof decodeRunnerCommandFrame>> =>
  new Promise((resolve, reject) => {
    const chunks: Array<Buffer> = []
    request.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))
    request.on("end", () => {
      try {
        resolve(decodeRunnerCommandFrame(JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown))
      } catch (error) {
        reject(error)
      }
    })
    request.on("error", reject)
  })

describe("resolveRunnerCommandTimeoutMs", () => {
  test("uses the shared 20s command budget for every action except recordVideo", () => {
    expect(resolveRunnerCommandTimeoutMs("ping")).toBe(20_000)
    expect(resolveRunnerCommandTimeoutMs("uiAction", '{"kind":"tap"}')).toBe(20_000)
  })

  test("extends the budget for recordVideo by the requested duration plus buffer", () => {
    expect(resolveRunnerCommandTimeoutMs("recordVideo", "5000")).toBe(35_000)
  })

  test("falls back to the default record duration for an unparseable payload", () => {
    expect(resolveRunnerCommandTimeoutMs("recordVideo", "not-a-number")).toBe(40_000)
  })
})

describe("RunnerTransportClient", () => {
  test("decodes a runner-response outcome identically for a single-endpoint (simulator-shaped) call", async () => {
    const server = await withServer((request, response) => {
      void readCommandFrame(request).then((frame) => {
        response.writeHead(200, { "Content-Type": "application/json" })
        response.end(okResponseBody(frame.sequence))
      })
    })

    try {
      const outcome = await runRunnerTransportSend({
        endpoints: [server.url],
        action: "ping",
        sequence: 1,
        deadlineMs: 2_000,
      })

      expect(outcome.kind).toBe("runner-response")
      expect(outcome.frame.ok).toBe(true)
      expect(outcome.frame.payload).toBe("pong")
      expect(outcome.endpoint).toBe(server.url)
      expect(outcome.attemptedEndpoints).toEqual([server.url])
    } finally {
      await server.close()
    }
  })

  test("decodes the same runner-response outcome for a two-endpoint (device-shaped) call", async () => {
    const unreachable = await unreachableEndpoint()
    const server = await withServer((request, response) => {
      void readCommandFrame(request).then((frame) => {
        response.writeHead(200, { "Content-Type": "application/json" })
        response.end(okResponseBody(frame.sequence))
      })
    })

    try {
      const outcome = await runRunnerTransportSend({
        endpoints: [unreachable, server.url],
        action: "ping",
        sequence: 1,
        deadlineMs: 2_000,
      })

      expect(outcome.kind).toBe("runner-response")
      expect(outcome.frame.ok).toBe(true)
      expect(outcome.frame.payload).toBe("pong")
      expect(outcome.endpoint).toBe(server.url)
      expect(outcome.attemptedEndpoints).toEqual([unreachable, server.url])
    } finally {
      await server.close()
    }
  })

  test(
    "a fake 10.86s action succeeds inside one 20s absolute budget with two candidate endpoints",
    async () => {
      // This is the PRB-081 incident shape: the tunnel-ip candidate is
      // unreachable, localhost is reachable, and the actual action takes
      // longer than a naive 20000/2 = 10000ms per-candidate split would
      // allow. A divided budget would abort candidate 1 at ~10s (unreachable
      // fails instantly, so that's wasted slack) then abort candidate 2 at
      // ~10s too - short of the 10.86s the runner needs - manufacturing a
      // timeout. One absolute deadline does not.
      const unreachable = await unreachableEndpoint()
      const server = await withServer((request, response) => {
        void readCommandFrame(request).then(async (frame) => {
          await sleep(10_860)
          response.writeHead(200, { "Content-Type": "application/json" })
          response.end(okResponseBody(frame.sequence))
        })
      })

      try {
        const startedAt = Date.now()
        const outcome = await runRunnerTransportSend({
          endpoints: [unreachable, server.url],
          action: "uiAction",
          sequence: 1,
          payload: '{"kind":"tap"}',
          deadlineMs: 20_000,
        })
        const elapsedMs = Date.now() - startedAt

        expect(outcome.kind).toBe("runner-response")
        expect(outcome.frame.ok).toBe(true)
        expect(outcome.attemptedEndpoints).toEqual([unreachable, server.url])
        expect(elapsedMs).toBeLessThan(20_000)
        expect(elapsedMs).toBeGreaterThanOrEqual(10_860)
      } finally {
        await server.close()
      }
    },
    { timeout: 20_000 },
  )

  test("classifies a refused connection as not-sent and advances to the next candidate", async () => {
    const unreachable = await unreachableEndpoint()

    await expect(
      runRunnerTransportSend({
        endpoints: [unreachable],
        action: "ping",
        sequence: 1,
        deadlineMs: 2_000,
      }),
    ).rejects.toMatchObject({
      _tag: "RunnerTransportError",
      code: "not-sent",
      ambiguous: false,
      endpoint: unreachable,
      attemptedEndpoints: [unreachable],
    })
  })

  test("classifies an unparseable body as invalid-response and never retries a different candidate", async () => {
    const bad = await withServer((request, response) => {
      void readCommandFrame(request).then(() => {
        response.writeHead(200, { "Content-Type": "application/json" })
        response.end("not json")
      })
    })
    const healthy = await withServer((request, response) => {
      void readCommandFrame(request).then((frame) => {
        response.writeHead(200, { "Content-Type": "application/json" })
        response.end(okResponseBody(frame.sequence))
      })
    })

    try {
      const error = await runRunnerTransportSend({
        endpoints: [bad.url, healthy.url],
        action: "ping",
        sequence: 1,
        deadlineMs: 2_000,
      }).catch((caught: unknown) => caught)

      expect(error).toBeInstanceOf(RunnerTransportError)
      expect((error as RunnerTransportError).code).toBe("invalid-response")
      expect((error as RunnerTransportError).ambiguous).toBe(true)
      // Never fell through to the healthy candidate: an invalid response
      // means the runner already ran the command, so retrying elsewhere
      // could double-execute it.
      expect((error as RunnerTransportError).attemptedEndpoints).toEqual([bad.url])
    } finally {
      await bad.close()
      await healthy.close()
    }
  })

  test("a mutation never falls through to another candidate after an ambiguous timeout", async () => {
    const hangs = await withServer(() => {
      // Never respond; the deadline elapses while awaiting a response.
    })
    const healthy = await withServer((request, response) => {
      void readCommandFrame(request).then((frame) => {
        response.writeHead(200, { "Content-Type": "application/json" })
        response.end(okResponseBody(frame.sequence))
      })
    })

    try {
      const error = await runRunnerTransportSend({
        endpoints: [hangs.url, healthy.url],
        action: "uiAction",
        sequence: 1,
        payload: '{"kind":"tap"}',
        deadlineMs: 300,
        idempotent: false,
      }).catch((caught: unknown) => caught)

      expect(error).toBeInstanceOf(RunnerTransportError)
      const transportError = error as RunnerTransportError
      expect(transportError.code).toBe("sent-no-response")
      expect(transportError.ambiguous).toBe(true)
      expect(transportError.attemptedEndpoints).toEqual([hangs.url])
      expect(healthy.wasAborted()).toBe(false)
    } finally {
      await hangs.close()
      await healthy.close()
    }
  })

  test("an idempotent (ping) caller may retry across candidates after an ambiguous timeout", async () => {
    const hangs = await withServer(() => {
      // Never respond.
    })
    const healthy = await withServer((request, response) => {
      void readCommandFrame(request).then((frame) => {
        response.writeHead(200, { "Content-Type": "application/json" })
        response.end(okResponseBody(frame.sequence))
      })
    })

    try {
      const outcome = await runRunnerTransportSend({
        endpoints: [hangs.url, healthy.url],
        action: "ping",
        sequence: 1,
        deadlineMs: 5_000,
        idempotent: true,
      })

      expect(outcome.kind).toBe("runner-response")
      expect(outcome.endpoint).toBe(healthy.url)
      expect(outcome.attemptedEndpoints.length).toBeGreaterThan(1)
      expect(outcome.attemptedEndpoints.every((endpoint) => endpoint === hangs.url || endpoint === healthy.url))
        .toBe(true)
    } finally {
      await hangs.close()
      await healthy.close()
    }
  })

  test("fails with not-sent when no candidate endpoints are configured", async () => {
    const error = await runRunnerTransportSend({
      endpoints: [],
      action: "ping",
      sequence: 1,
      deadlineMs: 1_000,
    }).catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(RunnerTransportError)
    expect((error as RunnerTransportError).code).toBe("not-sent")
    expect((error as RunnerTransportError).ambiguous).toBe(false)
  })

  test("RunnerTransportError.message is a readable sentence, not a JSON dump", async () => {
    const unreachable = await unreachableEndpoint()

    const error = await runRunnerTransportSend({
      endpoints: [unreachable],
      action: "ping",
      sequence: 1,
      deadlineMs: 1_000,
    }).catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(RunnerTransportError)
    const message = (error as RunnerTransportError).message
    expect(message.startsWith("{")).toBe(false)
    expect(message).toContain("not-sent")
    expect(message).toContain(unreachable)
  })

  test("Effect interruption unblocks the caller promptly and does not wedge later commands", async () => {
    // Bun's fetch does not reliably surface an aborted POST-with-body to the
    // remote peer (verified against a raw fetch + AbortController with no
    // Effect involved at all: the client-side promise rejects with
    // AbortError, but the server never observes an aborted/closed
    // connection). That is a runtime characteristic of the HTTP client, not
    // something this client's Effect wiring controls, so this test proves
    // what Effect *does* own: the fiber is released promptly on
    // interruption (not stuck waiting on the dangling promise forever), and
    // the process is left healthy enough to serve the next command.
    const hangs = await withServer(() => {
      // Never respond; only interruption should end this request.
    })
    const healthy = await withServer((request, response) => {
      void readCommandFrame(request).then((frame) => {
        response.writeHead(200, { "Content-Type": "application/json" })
        response.end(okResponseBody(frame.sequence))
      })
    })

    try {
      const fiber = Effect.runFork(
        sendRunnerCommand({
          endpoints: [hangs.url],
          action: "ping",
          sequence: 1,
          deadlineMs: 30_000,
        }).pipe(Effect.provide(RunnerTransportClientLive)),
      )

      await sleep(100)
      const interruptedAt = Date.now()
      const exit = await Effect.runPromise(Fiber.interrupt(fiber))
      const interruptElapsedMs = Date.now() - interruptedAt

      expect(exit._tag).toBe("Failure")
      // Interruption itself must be prompt, not hostage to the dangling
      // fetch promise (which, per the note above, may never settle here).
      expect(interruptElapsedMs).toBeLessThan(2_000)

      const followUp = await runRunnerTransportSend({
        endpoints: [healthy.url],
        action: "ping",
        sequence: 2,
        deadlineMs: 2_000,
      })

      expect(followUp.kind).toBe("runner-response")
      expect(followUp.frame.ok).toBe(true)
    } finally {
      await hangs.close()
      await healthy.close()
    }
  })
})
