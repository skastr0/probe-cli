import { Cause, Context, Duration, Effect, Either, Exit, Layer, Option, Schema } from "effect"
import {
  decodeRunnerResponseFrame,
  encodeRunnerCommandFrame,
  RunnerActionSchema,
  type RunnerAction,
  type RunnerResponseFrame,
} from "./runnerProtocol"

// One shared command budget for every runner action, and a duration budget
// for `recordVideo` that always includes it. Both harnesses computed these
// identically before PRB-081; they now live in one place because they feed
// directly into RunnerTransportClient's single absolute deadline.
const commandTimeoutMs = 20_000
const recordVideoTimeoutBufferMs = 30_000
const maxRecordVideoDurationMs = 120_000
const defaultRecordVideoDurationMs = 10_000

export const resolveRunnerCommandTimeoutMs = (action: RunnerAction, payload?: string | null): number => {
  if (action !== "recordVideo") {
    return commandTimeoutMs
  }

  const parsedDurationMs = Number(payload ?? "")
  const durationMs = Number.isFinite(parsedDurationMs) && parsedDurationMs > 0
    ? Math.min(parsedDurationMs, maxRecordVideoDurationMs)
    : defaultRecordVideoDurationMs

  return Math.max(commandTimeoutMs, durationMs + recordVideoTimeoutBufferMs)
}

/**
 * Delivery phase a transport attempt failed at. This is what lets a caller
 * reason about whether the runner is likely to have received (and possibly
 * executed) a mutation:
 *  - "dispatch": the request never reached the runner (connection refused,
 *    DNS failure, or any other pre-response network error). Unambiguous —
 *    safe to retry against another candidate endpoint.
 *  - "await-response": the request was written to the wire but no response
 *    arrived before this attempt's share of the absolute deadline elapsed.
 *    Ambiguous — the runner may already have executed the command.
 *  - "decode": an HTTP response was received but could not be read as a
 *    valid RunnerResponseFrame. Ambiguous for the same reason as above: the
 *    runner replied, so it almost certainly ran the command.
 */
export const RunnerTransportPhaseSchema = Schema.Literal("dispatch", "await-response", "decode")
export type RunnerTransportPhase = typeof RunnerTransportPhaseSchema.Type

export const RunnerTransportErrorCodeSchema = Schema.Literal("not-sent", "sent-no-response", "invalid-response")
export type RunnerTransportErrorCode = typeof RunnerTransportErrorCodeSchema.Type

/**
 * Transport-fact-only error. It carries what happened at the wire — not
 * what a session should do about it. Retry/replay policy (e.g. "this is
 * safe to resend") is session policy and belongs to the harness that
 * catches this error, never to the transport itself.
 */
export class RunnerTransportError extends Schema.TaggedError<RunnerTransportError>()(
  "RunnerTransportError",
  {
    code: RunnerTransportErrorCodeSchema,
    action: RunnerActionSchema,
    endpoint: Schema.String,
    attemptedEndpoints: Schema.Array(Schema.String),
    phase: RunnerTransportPhaseSchema,
    elapsedMs: Schema.Number,
    remainingDeadlineMs: Schema.Number,
    ambiguous: Schema.Boolean,
    reason: Schema.String,
  },
) {
  // Callers throughout the codebase fall back to `error.message` for any
  // error that is not one of the specific ProbeError types (see e.g.
  // SessionRegistry's `sendRunnerCommand` and both harnesses' top-level
  // Effect.tryPromise catch clauses). Schema.TaggedError's default message
  // is a JSON dump of the struct fields; override it so that fallback stays
  // a readable diagnostic sentence instead of a blob.
  override get message(): string {
    return `Runner HTTP ${this.action} ${this.code} at ${this.endpoint} (${this.phase}, `
      + `${this.elapsedMs} ms elapsed, ${this.remainingDeadlineMs} ms remaining, `
      + `ambiguous=${this.ambiguous}): ${this.reason}`
  }
}

export interface RunnerDeliveryOutcome {
  readonly kind: "runner-response"
  readonly frame: RunnerResponseFrame
  readonly endpoint: string
  readonly elapsedMs: number
  readonly attemptedEndpoints: ReadonlyArray<string>
}

export interface RunnerTransportSendArgs {
  readonly endpoints: ReadonlyArray<string>
  readonly action: RunnerAction
  readonly sequence: number
  readonly payload?: string | null
  /** One absolute budget for the whole call. Never divided across candidate endpoints. */
  readonly deadlineMs: number
  /**
   * Opt-in only. When true, an ambiguous ("sent-no-response") attempt may be
   * retried against remaining candidates/time. Mutations must leave this
   * false (the default) so they never fall through after an ambiguous
   * timeout; only a read-only action like `ping` should set it.
   */
  readonly idempotent?: boolean
}

const idempotentAttemptTimeoutMs = 3_000
const idempotentRetryBackoffMs = 50

interface AttemptFailure {
  readonly code: RunnerTransportErrorCode
  readonly phase: RunnerTransportPhase
  readonly ambiguous: boolean
  readonly reason: string
}

const classifyDispatchError = (error: unknown): AttemptFailure => {
  if (error instanceof Error && error.name === "AbortError") {
    return {
      code: "sent-no-response",
      phase: "await-response",
      ambiguous: true,
      reason: "The runner did not respond before the transport deadline elapsed.",
    }
  }

  return {
    code: "not-sent",
    phase: "dispatch",
    ambiguous: false,
    reason: error instanceof Error ? error.message : String(error),
  }
}

const decodeAttemptResponse = (args: {
  readonly response: Response
  readonly action: RunnerAction
}): Effect.Effect<RunnerResponseFrame, AttemptFailure> =>
  Effect.tryPromise({
    try: () => args.response.text(),
    catch: (): AttemptFailure => ({
      code: "invalid-response",
      phase: "decode",
      ambiguous: true,
      reason: "Failed to read the runner HTTP response body.",
    }),
  }).pipe(
    Effect.flatMap((responseText) => {
      if (!args.response.ok) {
        return Effect.fail<AttemptFailure>({
          code: "invalid-response",
          phase: "decode",
          ambiguous: true,
          reason: `Runner HTTP ${args.action} returned ${args.response.status}: ${responseText.trim() || "<empty-body>"}`,
        })
      }

      try {
        return Effect.succeed(decodeRunnerResponseFrame(JSON.parse(responseText) as unknown))
      } catch (error) {
        return Effect.fail<AttemptFailure>({
          code: "invalid-response",
          phase: "decode",
          ambiguous: true,
          reason: `Runner HTTP ${args.action} returned an invalid response frame: ${
            error instanceof Error ? error.message : String(error)
          }`,
        })
      }
    }),
  )

// One HTTP attempt against one endpoint, bounded by `attemptTimeoutMs`. The
// fetch is issued with the AbortSignal Effect.tryPromise hands us, so both
// our own deadline (via Effect.timeoutFail) and any outer Effect
// interruption abort the in-flight request and let its timers/listeners go.
const attemptOnce = (args: {
  readonly endpoint: string
  readonly commandFrame: string
  readonly action: RunnerAction
  readonly attemptTimeoutMs: number
}): Effect.Effect<RunnerResponseFrame, AttemptFailure> =>
  Effect.tryPromise({
    try: (signal) =>
      fetch(args.endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: args.commandFrame,
        signal,
      }),
    catch: classifyDispatchError,
  }).pipe(
    Effect.timeoutFail({
      duration: Duration.millis(Math.max(0, args.attemptTimeoutMs)),
      onTimeout: (): AttemptFailure => ({
        code: "sent-no-response",
        phase: "await-response",
        ambiguous: true,
        reason: `The runner did not respond within ${args.attemptTimeoutMs} ms.`,
      }),
    }),
    Effect.flatMap((response) => decodeAttemptResponse({ response, action: args.action })),
  )

const sendWithClient = (args: RunnerTransportSendArgs): Effect.Effect<RunnerDeliveryOutcome, RunnerTransportError> =>
  Effect.gen(function* () {
    if (args.endpoints.length === 0) {
      return yield* Effect.fail(
        new RunnerTransportError({
          code: "not-sent",
          action: args.action,
          endpoint: "",
          attemptedEndpoints: [],
          phase: "dispatch",
          elapsedMs: 0,
          remainingDeadlineMs: Math.max(0, args.deadlineMs),
          ambiguous: false,
          reason: "No candidate runner endpoints were configured for this command.",
        }),
      )
    }

    const startedAt = Date.now()
    const deadlineAt = startedAt + Math.max(0, args.deadlineMs)
    const commandFrame = encodeRunnerCommandFrame({
      sequence: args.sequence,
      action: args.action,
      payload: args.payload ?? null,
    })
    const idempotent = args.idempotent ?? false
    const attemptedEndpoints: Array<string> = []
    let lastFailure: AttemptFailure | null = null
    let lastEndpoint = args.endpoints[0]!

    outer: while (Date.now() < deadlineAt) {
      for (const endpoint of args.endpoints) {
        const remainingMs = deadlineAt - Date.now()
        if (remainingMs <= 0) {
          break outer
        }

        // Never divide the absolute deadline across candidates. A mutation
        // attempt gets whatever remains of the one budget; only an
        // idempotent (read-only) caller trades that for several short,
        // safely-repeatable attempts.
        const attemptTimeoutMs = idempotent
          ? Math.min(remainingMs, idempotentAttemptTimeoutMs)
          : remainingMs

        attemptedEndpoints.push(endpoint)
        lastEndpoint = endpoint

        const outcome = yield* attemptOnce({
          endpoint,
          commandFrame,
          action: args.action,
          attemptTimeoutMs,
        }).pipe(Effect.either)

        if (Either.isRight(outcome)) {
          return {
            kind: "runner-response" as const,
            frame: outcome.right,
            endpoint,
            elapsedMs: Date.now() - startedAt,
            attemptedEndpoints,
          }
        }

        lastFailure = outcome.left

        if (outcome.left.code === "not-sent") {
          // Unambiguous: nothing reached the runner, so resolving the next
          // candidate is safe even for a mutation.
          continue
        }

        if (outcome.left.code === "sent-no-response" && idempotent) {
          yield* Effect.sleep(Duration.millis(idempotentRetryBackoffMs))
          continue
        }

        // sent-no-response (non-idempotent) or invalid-response: the runner
        // may already have executed this command. Never fall through to
        // another candidate here — that is exactly the divided-budget defect
        // this client replaces.
        break outer
      }

      if (!idempotent) {
        break
      }
    }

    const failure = lastFailure ?? {
      code: "not-sent" as const,
      phase: "dispatch" as const,
      ambiguous: false,
      reason: "The transport deadline elapsed before any candidate endpoint could be attempted.",
    }

    return yield* Effect.fail(
      new RunnerTransportError({
        code: failure.code,
        action: args.action,
        endpoint: lastEndpoint,
        attemptedEndpoints,
        phase: failure.phase,
        elapsedMs: Date.now() - startedAt,
        remainingDeadlineMs: Math.max(0, deadlineAt - Date.now()),
        ambiguous: failure.ambiguous,
        reason: failure.reason,
      }),
    )
  })

export class RunnerTransportClient extends Context.Tag("@probe/RunnerTransportClient")<
  RunnerTransportClient,
  {
    readonly send: (args: RunnerTransportSendArgs) => Effect.Effect<RunnerDeliveryOutcome, RunnerTransportError>
  }
>() {}

export const RunnerTransportClientLive = Layer.succeed(
  RunnerTransportClient,
  RunnerTransportClient.of({
    send: sendWithClient,
  }),
)

export const sendRunnerCommand = (
  args: RunnerTransportSendArgs,
): Effect.Effect<RunnerDeliveryOutcome, RunnerTransportError, RunnerTransportClient> =>
  Effect.flatMap(RunnerTransportClient, (client) => client.send(args))

/**
 * Promise-boundary adapter for the harnesses, which build sessions as plain
 * async functions wrapped by a single outer `Effect.tryPromise`. Runs the
 * Effect-native client to completion and rethrows the typed
 * RunnerTransportError itself (not an Effect FiberFailure wrapper) so
 * existing `instanceof`-based catch handling keeps working unchanged.
 */
export const runRunnerTransportSend = async (
  args: RunnerTransportSendArgs,
): Promise<RunnerDeliveryOutcome> => {
  const exit = await Effect.runPromiseExit(
    sendRunnerCommand(args).pipe(Effect.provide(RunnerTransportClientLive)),
  )

  if (Exit.isSuccess(exit)) {
    return exit.value
  }

  const failure = Cause.failureOption(exit.cause)

  if (Option.isSome(failure)) {
    throw failure.value
  }

  throw Cause.squash(exit.cause)
}
