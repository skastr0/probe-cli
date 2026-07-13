import { Effect, Fiber } from "effect"
import { PROBE_PROTOCOL_VERSION } from "../../../rpc/protocol"
import type { DaemonPingRequest, DaemonPingResponse } from "../../../rpc/protocol"
import { serveRpc } from "../../../rpc/server"
import { connectRawSocket, sleep, waitForSocket, withTempSocketRoot, writeRawLine } from "../rpcSocketFixtures"
import type { DefectFinding } from "../schema"

const handlerSleepMs = 150
const interruptAfterMs = 40
const observeAfterMs = 300

// src/rpc/server.ts:148 dispatches each accepted connection's request as
// `Effect.runPromise(Effect.either(config.onRequest(request, emit))).then(...)`,
// which is a top-level Effect run rather than a fiber forked into serveRpc's own
// Effect.scoped/Effect.acquireRelease lifecycle (src/rpc/server.ts:49-241). This
// scenario proves that interrupting the daemon's own fiber does not interrupt an
// in-flight request handler, so the handler settles after the daemon has already
// released its socket and metadata.
export const runDetachedRpcWorkScenario = async (): Promise<DefectFinding> => {
  const state = {
    requestStartedAt: 0,
    handlerSettledAt: 0,
  }

  try {
    return await withTempSocketRoot(async ({ socketPath, metadataPath }) => {
      const onRequest = (request: DaemonPingRequest): Effect.Effect<DaemonPingResponse, never> =>
        Effect.gen(function* () {
          state.requestStartedAt = Date.now()
          yield* Effect.sleep(`${handlerSleepMs} millis`)
          state.handlerSettledAt = Date.now()

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
          } satisfies DaemonPingResponse
        })

      const timeline = await Effect.runPromise(
        Effect.gen(function* () {
          const fiber = yield* Effect.fork(
            serveRpc({
              socketPath,
              metadataPath,
              onRequest: (request, _emit) => onRequest(request as DaemonPingRequest),
              onMetadataWrite: async () => undefined,
              onMetadataRemove: async () => undefined,
            }),
          )

          yield* Effect.promise(() => waitForSocket(socketPath))

          const client = yield* Effect.promise(() => connectRawSocket(socketPath))
          yield* Effect.promise(() =>
            writeRawLine(
              client,
              `${JSON.stringify({
                kind: "request",
                protocolVersion: PROBE_PROTOCOL_VERSION,
                requestId: "detached-rpc-work-probe",
                method: "daemon.ping",
                params: {},
              })}\n`,
            ),
          )

          yield* Effect.promise(() => sleep(interruptAfterMs))

          // Destroy the still-open client connection first: net.Server#close()
          // (called from serveRpc's release effect) does not resolve until all
          // accepted connections end, so leaving this socket open would hang the
          // interrupt itself rather than exercise the detachment defect.
          yield* Effect.sync(() => client.destroy())

          const interruptedAt = Date.now()
          yield* Fiber.interrupt(fiber).pipe(Effect.timeout("2 seconds"))
          const settledImmediatelyAfterInterrupt = state.handlerSettledAt !== 0

          yield* Effect.promise(() => sleep(observeAfterMs))
          const settledAfterWait = state.handlerSettledAt !== 0

          return { interruptedAt, settledImmediatelyAfterInterrupt, settledAfterWait }
        }),
      )

      const reproduced = !timeline.settledImmediatelyAfterInterrupt && timeline.settledAfterWait

      return {
        id: "detached-rpc-work-01",
        category: "detached-rpc-work",
        verdict: reproduced ? "red" : "green",
        summary: reproduced
          ? "The in-flight request handler kept running and settled after the daemon fiber was interrupted (socket closed, metadata removed), confirming request work is detached from serveRpc's own Effect scope."
          : "The in-flight request handler did not settle after the daemon fiber was interrupted; no detachment was observed in this run.",
        evidence: [
          "src/rpc/server.ts:148 — Effect.runPromise(Effect.either(config.onRequest(request, emit))).then(...) is invoked outside the Effect.acquireRelease/Effect.scoped block that owns serveRpc's own lifecycle (src/rpc/server.ts:49-241), so it is never a child fiber of the daemon and Fiber.interrupt on the daemon cannot reach it.",
          `daemon fiber interrupted ${timeline.interruptedAt - state.requestStartedAt}ms after the handler started (handler configured to sleep ${handlerSleepMs}ms); handler settled ${
            state.handlerSettledAt === 0 ? "never (within observation window)" : `${state.handlerSettledAt - state.requestStartedAt}ms after start`
          }.`,
        ],
        metrics: {
          handlerSleepMs,
          interruptAfterMs,
          observeAfterMs,
          settledImmediatelyAfterInterrupt: timeline.settledImmediatelyAfterInterrupt ? 1 : 0,
          settledAfterWait: timeline.settledAfterWait ? 1 : 0,
        },
      } satisfies DefectFinding
    })
  } catch (error) {
    return {
      id: "detached-rpc-work-01",
      category: "detached-rpc-work",
      verdict: "not-run",
      summary: `Scenario harness failed before it could observe detachment behavior: ${error instanceof Error ? error.message : String(error)}`,
      evidence: [error instanceof Error ? (error.stack ?? error.message) : String(error)],
      metrics: {},
    } satisfies DefectFinding
  }
}
