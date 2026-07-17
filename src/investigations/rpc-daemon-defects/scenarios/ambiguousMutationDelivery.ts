import { Effect, Either, Fiber } from "effect"
import { sendDaemonPing } from "../../../rpc/client"
import { PROBE_PROTOCOL_VERSION } from "../../../rpc/protocol"
import type { DaemonPingRequest, DaemonPingResponse, RpcProgressEvent } from "../../../rpc/protocol"
import { serveRpc } from "../../../rpc/server"
import { waitForSocket, withTempSocketRoot } from "../rpcSocketFixtures"
import type { DefectFinding } from "../schema"

const buildEvent = (requestId: string, sequence: number, stage: string): RpcProgressEvent => ({
  kind: "event",
  protocolVersion: PROBE_PROTOCOL_VERSION,
  requestId,
  method: "daemon.ping",
  type: "progress",
  sequence,
  timestamp: new Date().toISOString(),
  stage,
  message: `stage ${stage}`,
  data: { stage, message: `stage ${stage}` },
})

// The event frame schema carries a `sequence` field (src/rpc/protocol.ts:679)
// but neither the server (src/rpc/server.ts, emit = (event) => writeFrame(event))
// nor the client (src/rpc/client.ts:265-268, `if (frame.kind === "event") { options.onEvent?.(frame); continue }`)
// ever inspects it. This scenario emits a sequence gap (1, then 5 — modelling
// events 2-4 being dropped by a detached/late producer) and shows the request
// still resolves successfully with no signal that delivery was incomplete.
export const runAmbiguousMutationDeliveryScenario = async (): Promise<DefectFinding> => {
  try {
    return await withTempSocketRoot(async ({ socketPath, metadataPath }) => {
      const observedSequences: Array<number> = []

      const onRequest = (
        request: DaemonPingRequest,
        emit: (event: RpcProgressEvent) => void,
      ): Effect.Effect<DaemonPingResponse, never> =>
        Effect.gen(function* () {
          yield* Effect.sync(() => emit(buildEvent(request.requestId, 1, "started")))
          yield* Effect.sync(() => emit(buildEvent(request.requestId, 5, "almost-done")))

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

      const outcome = await Effect.runPromise(
        Effect.gen(function* () {
          const fiber = yield* Effect.fork(
            serveRpc({
              socketPath,
              metadataPath,
              onRequest: (request, emit) => onRequest(request as DaemonPingRequest, emit),
              onMetadataWrite: async () => undefined,
              onMetadataRemove: async () => undefined,
            }),
          )

          yield* Effect.promise(() => waitForSocket(socketPath))

          const result = yield* Effect.either(
            sendDaemonPing(
              {
                socketPath,
                timeoutMs: 1_000,
                onEvent: (event) => {
                  observedSequences.push(event.sequence)
                },
              },
              {
                kind: "request",
                protocolVersion: PROBE_PROTOCOL_VERSION,
                requestId: "ambiguous-mutation-delivery-probe",
                method: "daemon.ping",
                params: {},
              },
            ),
          )

          yield* Fiber.interrupt(fiber).pipe(Effect.timeout("2 seconds"))

          return result
        }),
      )

      const requestSucceeded = Either.isRight(outcome)
      const hasGap = observedSequences.length >= 2 && observedSequences[1]! - observedSequences[0]! > 1
      const reproduced = requestSucceeded && hasGap

      return {
        id: "ambiguous-mutation-delivery-01",
        category: "ambiguous-mutation-delivery",
        verdict: reproduced ? "red" : "green",
        summary: reproduced
          ? `The client accepted a sequence gap (${observedSequences.join(" -> ")}) in progress events and still resolved the request successfully, so a caller cannot tell dropped or reordered mutation events from a complete stream.`
          : "The client either rejected the sequence gap or failed to resolve the request; no ambiguity was observed in this run.",
        evidence: [
          "src/rpc/protocol.ts:679 — RpcProgressEvent declares `sequence: Schema.Number` but no producer or consumer in src/rpc/server.ts or src/rpc/client.ts validates monotonicity or contiguity.",
          "src/rpc/client.ts:265-268 — event frames are handed to `options.onEvent` and the loop just `continue`s; there is no tracking of the last-seen sequence number.",
          `observed sequence stream: [${observedSequences.join(", ")}]; request settled as ${requestSucceeded ? "success" : "failure"}.`,
        ],
        metrics: {
          observedEventCount: observedSequences.length,
          requestSucceeded: requestSucceeded ? 1 : 0,
          sequenceGapDetected: hasGap ? 1 : 0,
        },
      } satisfies DefectFinding
    })
  } catch (error) {
    return {
      id: "ambiguous-mutation-delivery-01",
      category: "ambiguous-mutation-delivery",
      verdict: "not-run",
      summary: `Scenario harness failed before it could observe mutation delivery behavior: ${error instanceof Error ? error.message : String(error)}`,
      evidence: [error instanceof Error ? (error.stack ?? error.message) : String(error)],
      metrics: {},
    } satisfies DefectFinding
  }
}
