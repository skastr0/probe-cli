import { describe, expect, test } from "bun:test"
import { Effect, Either } from "effect"
import { UserInputError } from "../../domain/errors"
import { DaemonClient } from "../../services/DaemonClient"
import { runDrillCommand } from "./drill"
import { runSessionCommand } from "./session"

const unexpectedClientCall = () => {
  throw new Error("CLI parsing test unexpectedly reached the daemon client")
}

type CapturedOpenParams = {
  readonly target: "simulator" | "device"
  readonly bundleId: string
  readonly sessionMode?: "build-and-install" | "attach-to-running" | null
  readonly simulatorUdid: string | null
  readonly deviceId: string | null
}

const buildCapturedOpenClient = (capture: (params: CapturedOpenParams) => void) =>
  DaemonClient.of({
    ping: unexpectedClientCall,
    openSession: (params) => {
      capture(params)
      return Effect.fail(new UserInputError({
        code: "captured-open-session",
        reason: "captured",
        nextStep: "none",
        details: [],
      }))
    },
    getSessionHealth: unexpectedClientCall,
    closeSession: unexpectedClientCall,
    getSessionLogs: unexpectedClientCall,
    runSessionDebugCommand: unexpectedClientCall,
    captureSnapshot: unexpectedClientCall,
    captureScreenshot: unexpectedClientCall,
    recordVideo: unexpectedClientCall,
    performSessionAction: unexpectedClientCall,
    exportSessionRecording: unexpectedClientCall,
    replaySessionRecording: unexpectedClientCall,
    recordPerf: unexpectedClientCall,
    drillArtifact: unexpectedClientCall,
  })

const neverUsedClient = DaemonClient.of({
  ping: unexpectedClientCall,
  openSession: unexpectedClientCall,
  getSessionHealth: unexpectedClientCall,
  closeSession: unexpectedClientCall,
  getSessionLogs: unexpectedClientCall,
  runSessionDebugCommand: unexpectedClientCall,
  captureSnapshot: unexpectedClientCall,
  captureScreenshot: unexpectedClientCall,
  recordVideo: unexpectedClientCall,
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

  test("session open infers build-and-install mode when bundle id is omitted", async () => {
    const captured = { current: null as CapturedOpenParams | null }

    await Effect.runPromise(
      Effect.either(
        runSessionCommand(["open"]).pipe(
          Effect.provideService(DaemonClient, buildCapturedOpenClient((params) => {
            captured.current = params
          })),
        ),
      ),
    )

    expect(captured.current).not.toBeNull()

    if (captured.current === null) {
      throw new Error("Expected open-session params to be captured")
    }

    const params = captured.current

    expect(params.target).toBe("simulator")
    expect(params.bundleId).toBe("dev.probe.fixture")
    expect(params.sessionMode).toBe("build-and-install")
    expect(params.simulatorUdid).toBeNull()
    expect(params.deviceId).toBeNull()
  })

  test("session open infers build-and-install mode for the default fixture bundle id", async () => {
    const captured = { current: null as CapturedOpenParams | null }

    await Effect.runPromise(
      Effect.either(
        runSessionCommand(["open", "--bundle-id", "dev.probe.fixture"]).pipe(
          Effect.provideService(DaemonClient, buildCapturedOpenClient((params) => {
            captured.current = params
          })),
        ),
      ),
    )

    expect(captured.current).not.toBeNull()

    if (captured.current === null) {
      throw new Error("Expected open-session params to be captured")
    }

    expect(captured.current.sessionMode).toBe("build-and-install")
  })

  test("session open infers attach-to-running mode for arbitrary simulator bundle ids", async () => {
    const captured = { current: null as CapturedOpenParams | null }

    await Effect.runPromise(
      Effect.either(
        runSessionCommand(["open", "--bundle-id", "com.example.notes"]).pipe(
          Effect.provideService(DaemonClient, buildCapturedOpenClient((params) => {
            captured.current = params
          })),
        ),
      ),
    )

    expect(captured.current).not.toBeNull()

    if (captured.current === null) {
      throw new Error("Expected open-session params to be captured")
    }

    const params = captured.current

    expect(params.target).toBe("simulator")
    expect(params.bundleId).toBe("com.example.notes")
    expect(params.sessionMode).toBe("attach-to-running")
    expect(params.simulatorUdid).toBeNull()
    expect(params.deviceId).toBeNull()
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
