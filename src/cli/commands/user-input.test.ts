import { describe, expect, test } from "bun:test"
import { Effect, Either } from "effect"
import { UserInputError } from "../../domain/errors"
import { DaemonClient } from "../../services/DaemonClient"
import { runDrillCommand } from "./drill"
import { runSessionCommand } from "./session"

const unexpectedClientCall = () => {
  throw new Error("CLI parsing test unexpectedly reached the daemon client")
}

const neverUsedClient = DaemonClient.of({
  ping: unexpectedClientCall,
  openSession: unexpectedClientCall,
  getSessionHealth: unexpectedClientCall,
  closeSession: unexpectedClientCall,
  getSessionLogs: unexpectedClientCall,
  runSessionDebugCommand: unexpectedClientCall,
  captureSnapshot: unexpectedClientCall,
  captureScreenshot: unexpectedClientCall,
  performSessionAction: unexpectedClientCall,
  exportSessionRecording: unexpectedClientCall,
  replaySessionRecording: unexpectedClientCall,
  recordPerf: unexpectedClientCall,
  drillArtifact: unexpectedClientCall,
})

const expectUserInputFailure = async (effect: Effect.Effect<unknown, unknown, unknown>) => {
  const result = await Effect.runPromise(
    Effect.either(effect as Effect.Effect<unknown, unknown, DaemonClient>).pipe(
      Effect.provideService(DaemonClient, neverUsedClient),
    ),
  )
  expect(Either.isLeft(result)).toBe(true)

  if (Either.isLeft(result)) {
    expect(result.left).toBeInstanceOf(UserInputError)

    if (!(result.left instanceof UserInputError)) {
      throw new Error(`Expected UserInputError, received ${String(result.left)}`)
    }

    return result.left
  }

  throw new Error("Expected a UserInputError")
}

describe("cli user input handling", () => {
  test("session health missing session id fails as typed user input", async () => {
    const error = await expectUserInputFailure(runSessionCommand(["health"]))

    expect(error.code).toBe("missing-option")
    expect(error.reason).toContain("--session-id")
  })

  test("session open missing optional flag value fails as typed user input", async () => {
    const error = await expectUserInputFailure(runSessionCommand(["open", "--bundle-id"]))

    expect(error.code).toBe("missing-option-value")
    expect(error.reason).toContain("--bundle-id")
  })

  test("drill invalid --lines value fails as typed user input", async () => {
    const error = await expectUserInputFailure(
      runDrillCommand([
        "--session-id",
        "session-1",
        "--artifact",
        "build-log",
        "--lines",
        "10:2",
      ]),
    )

    expect(error.code).toBe("invalid-option")
    expect(error.reason).toContain("--lines")
  })
})
