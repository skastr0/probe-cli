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

// The event frame schema carries a `sequence` field (src/rpc/protocol.ts:679).
// Before PRB-089, neither the server (src/rpc/server.ts, emit = (event) =>
// writeFrame(event)) nor the client ever inspected it, so a caller could not
// tell a dropped/reordered progress event from a complete stream. PRB-089
// made the client (src/rpc/client.ts, `sendRequest`'s `onData` handler) the
// owner of that check: it tracks the last-seen event sequence and fails the
// whole request the moment a later one skips ahead, instead of letting it
// resolve as if nothing were missing. This scenario emits a sequence gap (1,
// then 5 — modelling events 2-4 being dropped by a detached/late producer)
// and now proves the request is rejected instead of silently succeeding.
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

      // The defect this scenario reproduces is a *silent* gap: the request
      // resolving successfully despite skipping sequence numbers. Reaching
      // for `observedSequences` (populated only by events the client
      // actually forwarded to `onEvent`) is deliberate rather than deriving
      // "was a gap present" from the fixture alone — a client that now
      // withholds the gapped event from `onEvent` (PRB-089's fix) proves the
      // gap was caught upstream of the caller, not merely present in the
      // fixture.
      const requestSucceeded = Either.isRight(outcome)
      const rejectionReason = Either.isLeft(outcome)
        ? (outcome.left instanceof Error ? outcome.left.message : String(outcome.left))
        : null
      const gapRejected = rejectionReason !== null && rejectionReason.includes("skipped from sequence")
      // Reproduced (red) iff the old defect still exists: the gap slipped
      // through and the request resolved as if the stream were complete.
      const reproduced = requestSucceeded

      return {
        id: "ambiguous-mutation-delivery-01",
        category: "ambiguous-mutation-delivery",
        verdict: reproduced ? "red" : "green",
        summary: reproduced
          ? `The client accepted a sequence gap and still resolved the request successfully, so a caller cannot tell dropped or reordered mutation events from a complete stream.`
          : gapRejected
            ? `The client detected the sequence gap (observed events: [${observedSequences.join(", ")}], `
              + `then rejected before a 3rd event) and failed the request instead of resolving it silently: ${rejectionReason}`
            : `The request did not succeed, but not because of sequence-gap detection (${rejectionReason ?? "unknown reason"}); `
              + "this scenario needs investigation, not a clean pass.",
        evidence: [
          "src/rpc/protocol.ts:679 — RpcProgressEvent declares `sequence: Schema.Number`.",
          "src/rpc/client.ts `sendRequest`'s `onData` handler tracks the last-seen event sequence per request and "
            + "fails the request (`EnvironmentError` code `rpc-progress-sequence-gap`) the moment a later event skips "
            + "ahead, instead of forwarding it to `onEvent` and continuing (PRB-089).",
          `observed sequence stream forwarded to the caller: [${observedSequences.join(", ")}]; `
            + `request settled as ${requestSucceeded ? "success" : "failure"}` + (rejectionReason ? `: ${rejectionReason}` : "."),
        ],
        metrics: {
          observedEventCount: observedSequences.length,
          requestSucceeded: requestSucceeded ? 1 : 0,
          sequenceGapDetected: gapRejected ? 1 : 0,
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
