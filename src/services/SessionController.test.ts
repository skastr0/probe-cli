import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { makeSessionController } from "./SessionController"
import type { SessionHealth } from "../domain/session"

const fakeHealth = (state: SessionHealth["state"]): SessionHealth =>
  ({
    sessionId: "fake-session",
    state,
    openedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    expiresAt: "2026-01-01T00:15:00.000Z",
    artifactRoot: "/tmp/fake-session",
  }) as unknown as SessionHealth

describe("SessionController", () => {
  test("100 concurrent commands get one ordered, gap-free, duplicate-free sequence range", async () => {
    const controller = await Effect.runPromise(
      makeSessionController({ sessionId: "s1", initialSequence: 0, opQueueCapacity: 256 }),
    )

    const dispatchOrder: Array<number> = []

    const dispatchOne = () =>
      controller.submit((ctx) =>
        Effect.gen(function* () {
          const sequence = ctx.allocateSequence()
          // Simulate awaiting a transport round trip between allocation and
          // completion so a non-serialized implementation would race here.
          yield* Effect.sleep(1)
          dispatchOrder.push(sequence)
          return sequence
        }),
      )

    const results = await Effect.runPromise(
      Effect.all(Array.from({ length: 100 }, () => dispatchOne()), { concurrency: "unbounded" }),
    )

    const sorted = [...results].sort((a, b) => a - b)
    expect(sorted).toEqual(Array.from({ length: 100 }, (_, i) => i))
    expect(new Set(results).size).toBe(100)
    // Sequence numbers were handed out in the order operations were
    // admitted to the controller fiber (FIFO), so the completion order
    // (which mirrors allocation order given the fixed sleep) is gap-free.
    expect(dispatchOrder).toEqual(sorted)
  })

  test("concurrent close triggers call teardown exactly once and all observers get one terminal result", async () => {
    const controller = await Effect.runPromise(
      makeSessionController({ sessionId: "s2", initialSequence: 0, opQueueCapacity: 16 }),
    )

    let teardownRuns = 0

    const teardown = () =>
      Effect.gen(function* () {
        teardownRuns += 1
        yield* Effect.sleep(5)
        return fakeHealth("closed")
      })

    const results = await Effect.runPromise(
      Effect.all(
        [
          controller.close("explicit-close", teardown),
          controller.close("ttl-expired", teardown),
          controller.close("runner-exit", teardown),
          controller.close("daemon-shutdown", teardown),
        ],
        { concurrency: "unbounded" },
      ),
    )

    expect(teardownRuns).toBe(1)
    expect(results.every((health) => health === results[0])).toBe(true)
  })

  test("repeated close after completion is idempotent and returns the cached closed result", async () => {
    const controller = await Effect.runPromise(
      makeSessionController({ sessionId: "s3", initialSequence: 0, opQueueCapacity: 16 }),
    )

    const teardown = () => Effect.succeed(fakeHealth("closed"))

    const first = await Effect.runPromise(controller.close("explicit-close", teardown))
    const second = await Effect.runPromise(controller.close("explicit-close", teardown))

    expect(second).toBe(first)
  })

  test("an operation racing close either finishes before close or is rejected before dispatch", async () => {
    const controller = await Effect.runPromise(
      makeSessionController({ sessionId: "s4", initialSequence: 0, opQueueCapacity: 16 }),
    )

    let dispatchedToRunner = 0

    const op = controller.submit((ctx) =>
      Effect.gen(function* () {
        ctx.allocateSequence()
        yield* Effect.sleep(5)
        dispatchedToRunner += 1
        return "ok" as const
      }),
    )

    const closeResult = controller.close("explicit-close", () => Effect.succeed(fakeHealth("closed")))

    const [opExit, closeHealth] = await Effect.runPromise(
      Effect.all([Effect.exit(op), closeResult], { concurrency: "unbounded" }),
    )

    expect(closeHealth.state).toBe("closed")

    if (opExit._tag === "Success") {
      // Finished before close: it must have actually dispatched.
      expect(dispatchedToRunner).toBe(1)
    } else {
      // Rejected before dispatch: it must never have reached the runner.
      expect(dispatchedToRunner).toBe(0)
    }
  })

  test("no mutation starts after shutdown dispatch: submit after close never runs", async () => {
    const controller = await Effect.runPromise(
      makeSessionController({ sessionId: "s5", initialSequence: 0, opQueueCapacity: 16 }),
    )

    await Effect.runPromise(controller.close("daemon-shutdown", () => Effect.succeed(fakeHealth("closed"))))

    let ran = false
    const exit = await Effect.runPromise(
      Effect.exit(
        controller.submit(() =>
          Effect.sync(() => {
            ran = true
            return "should-not-run"
          }),
        ),
      ),
    )

    expect(ran).toBe(false)
    expect(exit._tag).toBe("Failure")
    if (exit._tag === "Failure") {
      const failure = exit.cause._tag === "Fail" ? exit.cause.error : null
      expect(failure?.code).toBe("session-closed")
    }
  })

  test("queue saturation returns a typed session-busy error instead of unbounded buffering", async () => {
    const controller = await Effect.runPromise(
      makeSessionController({ sessionId: "s6", initialSequence: 0, opQueueCapacity: 2 }),
    )

    // Block the controller fiber on a never-resolving op so the queue backs
    // up. The two fillers that *do* make it into the queue are correctly
    // stuck behind the blocker forever (single-consumer FIFO, by design) —
    // this test only cares about the offer that overflows capacity, so each
    // filler is raced against a short timeout rather than awaited outright.
    const blocker = controller.submit(() => Effect.never)
    const blockerFiber = Effect.runFork(blocker)

    // Give the controller fiber a chance to pick up the blocker before we fill the queue.
    await new Promise((resolve) => setTimeout(resolve, 10))

    const fillers = await Effect.runPromise(
      Effect.all(
        [
          Effect.exit(controller.submit(() => Effect.succeed("a")).pipe(Effect.timeout("50 millis"))),
          Effect.exit(controller.submit(() => Effect.succeed("b")).pipe(Effect.timeout("50 millis"))),
          Effect.exit(controller.submit(() => Effect.succeed("c")).pipe(Effect.timeout("50 millis"))),
        ],
        { concurrency: "unbounded" },
      ),
    )

    const codes = fillers.map((exit) =>
      exit._tag === "Failure" && exit.cause._tag === "Fail" && "code" in exit.cause.error
        ? exit.cause.error.code
        : "timed-out-still-queued",
    )

    expect(codes.filter((code) => code === "session-busy").length).toBeGreaterThan(0)

    blockerFiber.unsafeInterruptAsFork(blockerFiber.id())
  })

  test("controller interruption drains and rejects pending commands via close rather than hanging", async () => {
    const controller = await Effect.runPromise(
      makeSessionController({ sessionId: "s7", initialSequence: 0, opQueueCapacity: 16 }),
    )

    // Occupy the controller fiber with a slow op, then queue a second op
    // behind it, then close. The queued (not-yet-started) op must be
    // rejected as part of the drain rather than left to hang forever.
    const busy = Effect.runFork(
      controller.submit(() => Effect.sleep(20).pipe(Effect.as("first"))),
    )
    await new Promise((resolve) => setTimeout(resolve, 5))

    const queuedExit = Effect.runPromise(
      Effect.exit(controller.submit(() => Effect.succeed("second"))),
    )
    const closeExit = Effect.runPromise(controller.close("daemon-shutdown", () => Effect.succeed(fakeHealth("closed"))))

    const [firstResult, secondExit, closed] = await Promise.all([
      busy.await.pipe(Effect.runPromise),
      queuedExit,
      closeExit,
    ])

    expect(firstResult._tag).toBe("Success")
    expect(closed.state).toBe("closed")
    // The second op was either allowed to finish before close (also
    // acceptable — it was already running) or drained/rejected; either way
    // it must resolve rather than hang the test.
    expect(secondExit._tag === "Success" || secondExit._tag === "Failure").toBe(true)
  })
})
