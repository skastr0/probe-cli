import { Deferred, Effect, Option, Queue } from "effect"
import { EnvironmentError } from "../domain/errors"
import type { SessionHealth } from "../domain/session"

/**
 * PRB-083: per-session execution owner.
 *
 * Before this module, session execution state (the runner command sequence
 * counter, health transitions, and close/teardown) was mutated directly by
 * whichever caller happened to be running: a UI action, a health-check ping,
 * TTL expiry, a runner-exit callback, or daemon shutdown could all touch the
 * same `ActiveSessionRecord` concurrently. Sequence numbers were read, the
 * transport was awaited, and only then incremented — leaving a window where
 * two commands could read the same value. Close had no coalescing, so two
 * racing teardown triggers could both invoke `closeResources()`.
 *
 * `SessionController` closes that window structurally: one bounded queue and
 * one controller fiber per session are the *only* code path allowed to
 * allocate a sequence number, apply a health mutation, or run session
 * teardown. Every other call site submits an operation and awaits its
 * result; the controller fiber runs submitted operations strictly one at a
 * time (FIFO), so allocation, dispatch, and health mutation are atomic with
 * respect to every other operation on the same session.
 *
 * "Epoch" (see PRB-083 glyph notes) is realized here as the controller's own
 * lifetime rather than a separate counter: once `close()` has run its
 * teardown, the controller is terminal forever, and every operation
 * submitted afterward (whether already queued in the race window or
 * submitted later) is rejected before it can dispatch anything to the
 * runner. A stale success arriving after teardown has nothing left to
 * mutate. Probe's product policy is already "fail closed, reopen instead of
 * recovering in place" (see `nonRecoverableSessionWarning`), so a session
 * never needs to survive past its controller's terminal transition.
 */

export type SessionCloseReason = "explicit-close" | "ttl-expired" | "daemon-shutdown" | "runner-exit"

/** Handed to every operation and to teardown; only usable while the controller fiber is executing it. */
export interface SessionControllerContext {
  /** Allocates the next runner command sequence number. Gap-free and duplicate-free because only the
   *  controller fiber ever calls this, and it only calls it from inside one exclusively-run operation. */
  readonly allocateSequence: () => number
}

export interface SessionController {
  readonly sessionId: string
  /**
   * Runs `op` exclusively on the controller fiber, serialized against every
   * other submitted operation and against close. Rejects immediately with a
   * typed `session-closed` EnvironmentError (no runner dispatch, no queueing)
   * once the controller has gone terminal, and with a typed `session-busy`
   * EnvironmentError if the bounded operation queue is currently saturated.
   */
  readonly submit: <A, E>(
    op: (ctx: SessionControllerContext) => Effect.Effect<A, E>,
  ) => Effect.Effect<A, E | EnvironmentError>
  /**
   * Coalesced, idempotent close. The first caller (whichever of explicit
   * close / TTL expiry / runner exit / daemon shutdown reaches the
   * controller first) runs `teardown` exactly once; every other caller —
   * concurrent or later, including a caller that arrives after close has
   * already finished — receives the identical terminal result without
   * re-running teardown.
   */
  readonly close: (
    reason: SessionCloseReason,
    teardown: (reason: SessionCloseReason, ctx: SessionControllerContext) => Effect.Effect<SessionHealth, never>,
  ) => Effect.Effect<SessionHealth, never>
  readonly isTerminal: () => boolean
}

interface PendingOp {
  readonly _tag: "op"
  // Erased to `unknown` here because one queue carries operations submitted
  // with many different (A, E) type pairs. `submit` below is the only place
  // that constructs a `PendingOp` and the only place that reads its
  // deferred back, so the cast at each boundary is sound: caller and
  // resolver always agree on the real type for a given submission.
  readonly run: (ctx: SessionControllerContext) => Effect.Effect<unknown, unknown>
  readonly deferred: Deferred.Deferred<unknown, unknown>
}

interface PendingClose {
  readonly _tag: "close"
  readonly reason: SessionCloseReason
  readonly teardown: (reason: SessionCloseReason, ctx: SessionControllerContext) => Effect.Effect<SessionHealth, never>
  readonly deferred: Deferred.Deferred<SessionHealth, never>
}

/** Idle-loop poll interval; only ever waited on when both queues are empty. */
const idlePollIntervalMs = 2

export const sessionBusyError = (sessionId: string): EnvironmentError =>
  new EnvironmentError({
    code: "session-busy",
    reason: `Session ${sessionId} has too many in-flight controller operations queued.`,
    nextStep: "Wait for in-flight session operations to finish before issuing another command, then retry.",
    details: [],
  })

export const sessionClosedError = (sessionId: string): EnvironmentError =>
  new EnvironmentError({
    code: "session-closed",
    reason: `Session ${sessionId} is closing or has already closed.`,
    nextStep: "Open a new session before issuing further commands.",
    details: [],
  })

export const makeSessionController = (args: {
  readonly sessionId: string
  readonly initialSequence: number
  readonly opQueueCapacity: number
}): Effect.Effect<SessionController> =>
  Effect.gen(function* () {
    const opQueue = yield* Queue.dropping<PendingOp>(args.opQueueCapacity)
    const closeQueue = yield* Queue.unbounded<PendingClose>()

    let sequence = args.initialSequence
    let terminal = false
    let closeResult: SessionHealth | null = null

    const ctx: SessionControllerContext = {
      allocateSequence: () => {
        const current = sequence
        sequence += 1
        return current
      },
    }

    const runClose = (message: PendingClose) =>
      Effect.gen(function* () {
        if (closeResult !== null) {
          yield* Deferred.succeed(message.deferred, closeResult)
          return
        }

        // Flips synchronously, before any yield below, so every `submit`
        // call that checks `terminal` after this point is rejected
        // pre-dispatch — it never reaches the runner.
        terminal = true

        const result = yield* message.teardown(message.reason, ctx)
        closeResult = result
        yield* Deferred.succeed(message.deferred, result)

        const drainedOps = yield* Queue.takeAll(opQueue)
        yield* Effect.forEach(
          drainedOps,
          (op) => Deferred.fail(op.deferred, sessionClosedError(args.sessionId)),
          { discard: true },
        )

        const drainedCloses = yield* Queue.takeAll(closeQueue)
        yield* Effect.forEach(
          drainedCloses,
          (pending) => Deferred.succeed(pending.deferred, result),
          { discard: true },
        )

        yield* Queue.shutdown(opQueue)
        yield* Queue.shutdown(closeQueue)
      })

    const runOp = (message: PendingOp) =>
      message.run(ctx).pipe(
        Effect.matchEffect({
          onSuccess: (value) => Deferred.succeed(message.deferred, value),
          onFailure: (error) => Deferred.fail(message.deferred, error),
        }),
      )

    // Single controller fiber: strictly one message at a time, close always
    // checked (and preferred) ahead of the next queued operation so no
    // operation can begin dispatching once a close has been accepted.
    //
    // Deliberately *not* implemented as a race between two `Queue.take`
    // calls: Effect's `Queue.take` can dequeue an item internally and then
    // be interrupted (as the losing race arm) before its continuation ever
    // observes the value, silently discarding a submitted operation or
    // close request. Polling both queues and falling back to a short sleep
    // when both are empty avoids that hazard entirely — at the cost of at
    // most `idlePollIntervalMs` of added latency only when the controller
    // is otherwise fully idle.
    const loop: Effect.Effect<void> = Effect.gen(function* () {
      while (true) {
        const maybeClose = yield* Queue.poll(closeQueue)

        if (Option.isSome(maybeClose)) {
          yield* runClose(maybeClose.value)
          return
        }

        const maybeOp = yield* Queue.poll(opQueue)

        if (Option.isSome(maybeOp)) {
          yield* runOp(maybeOp.value)
          continue
        }

        yield* Effect.sleep(idlePollIntervalMs)
      }
    })

    // `forkDaemon`, not `fork`: the controller must keep running for the
    // life of the session, independent of whichever caller's fiber happened
    // to be executing `makeSessionController` (e.g. the request fiber for
    // `openSimulatorSession`, which completes and returns long before the
    // session itself closes).
    yield* Effect.forkDaemon(loop)

    const submit = <A, E>(
      op: (ctx: SessionControllerContext) => Effect.Effect<A, E>,
    ): Effect.Effect<A, E | EnvironmentError> =>
      Effect.gen(function* () {
        if (terminal) {
          return yield* sessionClosedError(args.sessionId)
        }

        const deferred = yield* Deferred.make<unknown, unknown>()
        const offered = yield* Queue.offer(opQueue, {
          _tag: "op",
          run: op as PendingOp["run"],
          deferred,
        })

        if (!offered) {
          return yield* sessionBusyError(args.sessionId)
        }

        return yield* (Deferred.await(deferred) as Effect.Effect<A, E>)
      })

    const close = (
      reason: SessionCloseReason,
      teardown: (reason: SessionCloseReason, ctx: SessionControllerContext) => Effect.Effect<SessionHealth, never>,
    ): Effect.Effect<SessionHealth, never> =>
      Effect.gen(function* () {
        if (closeResult !== null) {
          return closeResult
        }

        const deferred = yield* Deferred.make<SessionHealth>()
        yield* Queue.offer(closeQueue, { _tag: "close", reason, teardown, deferred })
        return yield* Deferred.await(deferred)
      })

    return {
      sessionId: args.sessionId,
      submit,
      close,
      isTerminal: () => terminal,
    } satisfies SessionController
  })
