import { describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Either } from "effect"
import { UserInputError } from "../../domain/errors"
import type { DrillQuery, OutputMode } from "../../domain/output"
import { AccessibilityService } from "../../services/AccessibilityService"
import { CommerceService } from "../../services/CommerceService"
import { DaemonClient } from "../../services/DaemonClient"
import { ProbeKernel } from "../../services/ProbeKernel"
import { runDoctorCommand } from "./doctor"
import { runDrillCommand } from "./drill"
import { runPerfCommand } from "./perf"
import { runSessionCommand } from "./session"

const unexpectedClientCall = () => {
  throw new Error("CLI parsing test unexpectedly reached the daemon client")
}

const neverUsedProbeKernel = ProbeKernel.of({} as any)
const neverUsedAccessibilityService = AccessibilityService.of({} as any)
const neverUsedCommerceService = CommerceService.of({} as any)

type CapturedOpenParams = {
  readonly target: "simulator" | "device"
  readonly bundleId: string
  readonly sessionMode?: "build-and-install" | "attach-to-running" | null
  readonly simulatorUdid: string | null
  readonly deviceId: string | null
}

type CapturedActionParams = {
  readonly sessionId: string
  readonly action: {
    readonly kind: string
    readonly target?: { readonly kind: string } | null
    readonly expectation?: { readonly exists: boolean | null; readonly interactive: boolean | null }
  }
}

type CapturedFlowParams = {
  readonly sessionId: string
  readonly flow: {
    readonly contract: string
    readonly steps: Array<{
      readonly kind: string
      readonly continueOnError?: boolean
    }>
  }
}

type CapturedPerfAroundParams = {
  readonly sessionId: string
  readonly template: string
  readonly flow: {
    readonly contract: string
    readonly steps: Array<{
      readonly kind: string
    }>
  }
}

type CapturedPerfSummaryParams = {
  readonly sessionId: string
  readonly artifactKey: string
}

type CapturedLogMarkParams = {
  readonly sessionId: string
  readonly label: string
}

type CapturedLogCaptureParams = {
  readonly sessionId: string
  readonly captureSeconds: number
}

type CapturedLogDoctorParams = {
  readonly sessionId: string
}

type CapturedDiagnosticCaptureParams = {
  readonly sessionId: string
  readonly target: "simulator" | "device"
  readonly kind: "sysdiagnose" | null
}

type CapturedDrillParams = {
  readonly sessionId: string
  readonly artifactKey: string
  readonly query: DrillQuery
  readonly outputMode: OutputMode
}

type CapturedSessionResultParams = {
  readonly sessionId: string
}

const buildCapturedOpenClient = (capture: (params: CapturedOpenParams) => void) =>
  DaemonClient.of({
    ping: unexpectedClientCall,
    listSessions: unexpectedClientCall,
    openSession: (params) => {
      capture(params)
      return Effect.fail(new UserInputError({
        code: "captured-open-session",
        reason: "captured",
        nextStep: "none",
        details: [],
      }))
    },
    showSession: unexpectedClientCall,
    getSessionHealth: unexpectedClientCall,
    closeSession: unexpectedClientCall,
    getSessionLogs: unexpectedClientCall,
    markSessionLog: unexpectedClientCall,
    captureLogWindow: unexpectedClientCall,
    getLogDoctorReport: unexpectedClientCall,
    runSessionDebugCommand: unexpectedClientCall,
    captureSnapshot: unexpectedClientCall,
    captureScreenshot: unexpectedClientCall,
    recordVideo: unexpectedClientCall,
    performSessionAction: unexpectedClientCall,
    runSessionFlow: unexpectedClientCall,
    exportSessionRecording: unexpectedClientCall,
    replaySessionRecording: unexpectedClientCall,
    getSessionResultSummary: unexpectedClientCall,
    getSessionResultAttachments: unexpectedClientCall,
    recordPerf: unexpectedClientCall,
    recordPerfAroundFlow: unexpectedClientCall,
    summarizePerfBySignpost: unexpectedClientCall,
    drillArtifact: unexpectedClientCall,
    captureDiagnosticBundle: unexpectedClientCall,
  })

const buildCapturedActionClient = (capture: (params: CapturedActionParams) => void) =>
  DaemonClient.of({
    ping: unexpectedClientCall,
    openSession: unexpectedClientCall,
    getSessionHealth: unexpectedClientCall,
    closeSession: unexpectedClientCall,
    listSessions: unexpectedClientCall,
    showSession: unexpectedClientCall,
    getSessionLogs: unexpectedClientCall,
    markSessionLog: unexpectedClientCall,
    captureLogWindow: unexpectedClientCall,
    getLogDoctorReport: unexpectedClientCall,
    runSessionDebugCommand: unexpectedClientCall,
    captureSnapshot: unexpectedClientCall,
    captureScreenshot: unexpectedClientCall,
    recordVideo: unexpectedClientCall,
    performSessionAction: (params) => {
      capture(params as CapturedActionParams)
      return Effect.fail(new UserInputError({
        code: "captured-session-action",
        reason: "captured",
        nextStep: "none",
        details: [],
      }))
    },
    runSessionFlow: unexpectedClientCall,
    exportSessionRecording: unexpectedClientCall,
    replaySessionRecording: unexpectedClientCall,
    getSessionResultSummary: unexpectedClientCall,
    getSessionResultAttachments: unexpectedClientCall,
    recordPerf: unexpectedClientCall,
    recordPerfAroundFlow: unexpectedClientCall,
    summarizePerfBySignpost: unexpectedClientCall,
    drillArtifact: unexpectedClientCall,
    captureDiagnosticBundle: unexpectedClientCall,
  })

const buildCapturedFlowClient = (capture: (params: CapturedFlowParams) => void) =>
  DaemonClient.of({
    ping: unexpectedClientCall,
    openSession: unexpectedClientCall,
    getSessionHealth: unexpectedClientCall,
    closeSession: unexpectedClientCall,
    listSessions: unexpectedClientCall,
    showSession: unexpectedClientCall,
    getSessionLogs: unexpectedClientCall,
    markSessionLog: unexpectedClientCall,
    captureLogWindow: unexpectedClientCall,
    getLogDoctorReport: unexpectedClientCall,
    runSessionDebugCommand: unexpectedClientCall,
    captureSnapshot: unexpectedClientCall,
    captureScreenshot: unexpectedClientCall,
    recordVideo: unexpectedClientCall,
    performSessionAction: unexpectedClientCall,
    runSessionFlow: (params) => {
      capture(params as CapturedFlowParams)
      return Effect.fail(new UserInputError({
        code: "captured-session-flow",
        reason: "captured",
        nextStep: "none",
        details: [],
      }))
    },
    exportSessionRecording: unexpectedClientCall,
    replaySessionRecording: unexpectedClientCall,
    getSessionResultSummary: unexpectedClientCall,
    getSessionResultAttachments: unexpectedClientCall,
    recordPerf: unexpectedClientCall,
    recordPerfAroundFlow: unexpectedClientCall,
    summarizePerfBySignpost: unexpectedClientCall,
    drillArtifact: unexpectedClientCall,
    captureDiagnosticBundle: unexpectedClientCall,
  })

const buildCapturedPerfAroundClient = (capture: (params: CapturedPerfAroundParams) => void) =>
  DaemonClient.of({
    ping: unexpectedClientCall,
    openSession: unexpectedClientCall,
    getSessionHealth: unexpectedClientCall,
    closeSession: unexpectedClientCall,
    listSessions: unexpectedClientCall,
    showSession: unexpectedClientCall,
    getSessionLogs: unexpectedClientCall,
    markSessionLog: unexpectedClientCall,
    captureLogWindow: unexpectedClientCall,
    getLogDoctorReport: unexpectedClientCall,
    runSessionDebugCommand: unexpectedClientCall,
    captureSnapshot: unexpectedClientCall,
    captureScreenshot: unexpectedClientCall,
    recordVideo: unexpectedClientCall,
    performSessionAction: unexpectedClientCall,
    runSessionFlow: unexpectedClientCall,
    exportSessionRecording: unexpectedClientCall,
    replaySessionRecording: unexpectedClientCall,
    getSessionResultSummary: unexpectedClientCall,
    getSessionResultAttachments: unexpectedClientCall,
    recordPerf: unexpectedClientCall,
    recordPerfAroundFlow: (params) => {
      capture(params as CapturedPerfAroundParams)
      return Effect.fail(new UserInputError({
        code: "captured-perf-around",
        reason: "captured",
        nextStep: "none",
        details: [],
      }))
    },
    summarizePerfBySignpost: unexpectedClientCall,
    drillArtifact: unexpectedClientCall,
    captureDiagnosticBundle: unexpectedClientCall,
  })

const buildCapturedPerfSummaryClient = (capture: (params: CapturedPerfSummaryParams) => void) =>
  DaemonClient.of({
    ping: unexpectedClientCall,
    openSession: unexpectedClientCall,
    getSessionHealth: unexpectedClientCall,
    closeSession: unexpectedClientCall,
    listSessions: unexpectedClientCall,
    showSession: unexpectedClientCall,
    getSessionLogs: unexpectedClientCall,
    markSessionLog: unexpectedClientCall,
    captureLogWindow: unexpectedClientCall,
    getLogDoctorReport: unexpectedClientCall,
    runSessionDebugCommand: unexpectedClientCall,
    captureSnapshot: unexpectedClientCall,
    captureScreenshot: unexpectedClientCall,
    recordVideo: unexpectedClientCall,
    performSessionAction: unexpectedClientCall,
    runSessionFlow: unexpectedClientCall,
    exportSessionRecording: unexpectedClientCall,
    replaySessionRecording: unexpectedClientCall,
    getSessionResultSummary: unexpectedClientCall,
    getSessionResultAttachments: unexpectedClientCall,
    recordPerf: unexpectedClientCall,
    recordPerfAroundFlow: unexpectedClientCall,
    summarizePerfBySignpost: (params) => {
      capture(params as CapturedPerfSummaryParams)
      return Effect.fail(new UserInputError({
        code: "captured-perf-summary",
        reason: "captured",
        nextStep: "none",
        details: [],
      }))
    },
    drillArtifact: unexpectedClientCall,
    captureDiagnosticBundle: unexpectedClientCall,
  })

const buildCapturedLogMarkClient = (capture: (params: CapturedLogMarkParams) => void) =>
  DaemonClient.of({
    ping: unexpectedClientCall,
    listSessions: unexpectedClientCall,
    openSession: unexpectedClientCall,
    showSession: unexpectedClientCall,
    getSessionHealth: unexpectedClientCall,
    closeSession: unexpectedClientCall,
    getSessionLogs: unexpectedClientCall,
    markSessionLog: (params) => {
      capture(params as CapturedLogMarkParams)
      return Effect.fail(new UserInputError({
        code: "captured-log-mark",
        reason: "captured",
        nextStep: "none",
        details: [],
      }))
    },
    captureLogWindow: unexpectedClientCall,
    getLogDoctorReport: unexpectedClientCall,
    runSessionDebugCommand: unexpectedClientCall,
    captureSnapshot: unexpectedClientCall,
    captureScreenshot: unexpectedClientCall,
    recordVideo: unexpectedClientCall,
    performSessionAction: unexpectedClientCall,
    runSessionFlow: unexpectedClientCall,
    exportSessionRecording: unexpectedClientCall,
    replaySessionRecording: unexpectedClientCall,
    getSessionResultSummary: unexpectedClientCall,
    getSessionResultAttachments: unexpectedClientCall,
    recordPerf: unexpectedClientCall,
    recordPerfAroundFlow: unexpectedClientCall,
    summarizePerfBySignpost: unexpectedClientCall,
    drillArtifact: unexpectedClientCall,
    captureDiagnosticBundle: unexpectedClientCall,
  })

const buildCapturedLogCaptureClient = (capture: (params: CapturedLogCaptureParams) => void) =>
  DaemonClient.of({
    ping: unexpectedClientCall,
    listSessions: unexpectedClientCall,
    openSession: unexpectedClientCall,
    showSession: unexpectedClientCall,
    getSessionHealth: unexpectedClientCall,
    closeSession: unexpectedClientCall,
    getSessionLogs: unexpectedClientCall,
    markSessionLog: unexpectedClientCall,
    captureLogWindow: (params) => {
      capture(params as CapturedLogCaptureParams)
      return Effect.fail(new UserInputError({
        code: "captured-log-capture",
        reason: "captured",
        nextStep: "none",
        details: [],
      }))
    },
    getLogDoctorReport: unexpectedClientCall,
    runSessionDebugCommand: unexpectedClientCall,
    captureSnapshot: unexpectedClientCall,
    captureScreenshot: unexpectedClientCall,
    recordVideo: unexpectedClientCall,
    performSessionAction: unexpectedClientCall,
    runSessionFlow: unexpectedClientCall,
    exportSessionRecording: unexpectedClientCall,
    replaySessionRecording: unexpectedClientCall,
    getSessionResultSummary: unexpectedClientCall,
    getSessionResultAttachments: unexpectedClientCall,
    recordPerf: unexpectedClientCall,
    recordPerfAroundFlow: unexpectedClientCall,
    summarizePerfBySignpost: unexpectedClientCall,
    drillArtifact: unexpectedClientCall,
    captureDiagnosticBundle: unexpectedClientCall,
  })

const buildCapturedLogDoctorClient = (capture: (params: CapturedLogDoctorParams) => void) =>
  DaemonClient.of({
    ping: unexpectedClientCall,
    listSessions: unexpectedClientCall,
    openSession: unexpectedClientCall,
    showSession: unexpectedClientCall,
    getSessionHealth: unexpectedClientCall,
    closeSession: unexpectedClientCall,
    getSessionLogs: unexpectedClientCall,
    markSessionLog: unexpectedClientCall,
    captureLogWindow: unexpectedClientCall,
    getLogDoctorReport: (params) => {
      capture(params as CapturedLogDoctorParams)
      return Effect.fail(new UserInputError({
        code: "captured-log-doctor",
        reason: "captured",
        nextStep: "none",
        details: [],
      }))
    },
    runSessionDebugCommand: unexpectedClientCall,
    captureSnapshot: unexpectedClientCall,
    captureScreenshot: unexpectedClientCall,
    recordVideo: unexpectedClientCall,
    performSessionAction: unexpectedClientCall,
    runSessionFlow: unexpectedClientCall,
    exportSessionRecording: unexpectedClientCall,
    replaySessionRecording: unexpectedClientCall,
    getSessionResultSummary: unexpectedClientCall,
    getSessionResultAttachments: unexpectedClientCall,
    recordPerf: unexpectedClientCall,
    recordPerfAroundFlow: unexpectedClientCall,
    summarizePerfBySignpost: unexpectedClientCall,
    drillArtifact: unexpectedClientCall,
    captureDiagnosticBundle: unexpectedClientCall,
  })

const buildCapturedDiagnosticCaptureClient = (capture: (params: CapturedDiagnosticCaptureParams) => void) =>
  DaemonClient.of({
    ping: unexpectedClientCall,
    listSessions: unexpectedClientCall,
    openSession: unexpectedClientCall,
    showSession: unexpectedClientCall,
    getSessionHealth: unexpectedClientCall,
    closeSession: unexpectedClientCall,
    getSessionLogs: unexpectedClientCall,
    markSessionLog: unexpectedClientCall,
    captureLogWindow: unexpectedClientCall,
    getLogDoctorReport: unexpectedClientCall,
    runSessionDebugCommand: unexpectedClientCall,
    captureSnapshot: unexpectedClientCall,
    captureScreenshot: unexpectedClientCall,
    recordVideo: unexpectedClientCall,
    performSessionAction: unexpectedClientCall,
    runSessionFlow: unexpectedClientCall,
    exportSessionRecording: unexpectedClientCall,
    replaySessionRecording: unexpectedClientCall,
    getSessionResultSummary: unexpectedClientCall,
    getSessionResultAttachments: unexpectedClientCall,
    recordPerf: unexpectedClientCall,
    recordPerfAroundFlow: unexpectedClientCall,
    summarizePerfBySignpost: unexpectedClientCall,
    drillArtifact: unexpectedClientCall,
    captureDiagnosticBundle: (params) => {
      capture(params as CapturedDiagnosticCaptureParams)
      return Effect.fail(new UserInputError({
        code: "captured-diagnostic-capture",
        reason: "captured",
        nextStep: "none",
        details: [],
      }))
    },
  })

const buildCapturedDrillClient = (capture: (params: CapturedDrillParams) => void) =>
  DaemonClient.of({
    ping: unexpectedClientCall,
    listSessions: unexpectedClientCall,
    openSession: unexpectedClientCall,
    showSession: unexpectedClientCall,
    getSessionHealth: unexpectedClientCall,
    closeSession: unexpectedClientCall,
    getSessionLogs: unexpectedClientCall,
    markSessionLog: unexpectedClientCall,
    captureLogWindow: unexpectedClientCall,
    getLogDoctorReport: unexpectedClientCall,
    runSessionDebugCommand: unexpectedClientCall,
    captureSnapshot: unexpectedClientCall,
    captureScreenshot: unexpectedClientCall,
    recordVideo: unexpectedClientCall,
    performSessionAction: unexpectedClientCall,
    runSessionFlow: unexpectedClientCall,
    exportSessionRecording: unexpectedClientCall,
    replaySessionRecording: unexpectedClientCall,
    getSessionResultSummary: unexpectedClientCall,
    getSessionResultAttachments: unexpectedClientCall,
    recordPerf: unexpectedClientCall,
    recordPerfAroundFlow: unexpectedClientCall,
    summarizePerfBySignpost: unexpectedClientCall,
    drillArtifact: (params) => {
      capture(params as CapturedDrillParams)
      return Effect.fail(new UserInputError({
        code: "captured-drill",
        reason: "captured",
        nextStep: "none",
        details: [],
      }))
    },
    captureDiagnosticBundle: unexpectedClientCall,
  })

const buildCapturedSessionResultClient = (args: {
  readonly capture: (params: CapturedSessionResultParams) => void
}) =>
  DaemonClient.of({
    ping: unexpectedClientCall,
    listSessions: unexpectedClientCall,
    openSession: unexpectedClientCall,
    showSession: unexpectedClientCall,
    getSessionHealth: unexpectedClientCall,
    closeSession: unexpectedClientCall,
    getSessionLogs: unexpectedClientCall,
    markSessionLog: unexpectedClientCall,
    captureLogWindow: unexpectedClientCall,
    getLogDoctorReport: unexpectedClientCall,
    runSessionDebugCommand: unexpectedClientCall,
    captureSnapshot: unexpectedClientCall,
    captureScreenshot: unexpectedClientCall,
    recordVideo: unexpectedClientCall,
    performSessionAction: unexpectedClientCall,
    runSessionFlow: unexpectedClientCall,
    exportSessionRecording: unexpectedClientCall,
    replaySessionRecording: unexpectedClientCall,
    getSessionResultSummary: (params) => {
      args.capture(params as CapturedSessionResultParams)
      return Effect.fail(new UserInputError({
        code: "captured-session-result",
        reason: "captured",
        nextStep: "none",
        details: [],
      }))
    },
    getSessionResultAttachments: (params) => {
      args.capture(params as CapturedSessionResultParams)
      return Effect.fail(new UserInputError({
        code: "captured-session-result",
        reason: "captured",
        nextStep: "none",
        details: [],
      }))
    },
    recordPerf: unexpectedClientCall,
    recordPerfAroundFlow: unexpectedClientCall,
    summarizePerfBySignpost: unexpectedClientCall,
    drillArtifact: unexpectedClientCall,
    captureDiagnosticBundle: unexpectedClientCall,
  })

const neverUsedClient = DaemonClient.of({
  ping: unexpectedClientCall,
  listSessions: unexpectedClientCall,
  openSession: unexpectedClientCall,
  showSession: unexpectedClientCall,
  getSessionHealth: unexpectedClientCall,
  closeSession: unexpectedClientCall,
  getSessionLogs: unexpectedClientCall,
  markSessionLog: unexpectedClientCall,
  captureLogWindow: unexpectedClientCall,
  getLogDoctorReport: unexpectedClientCall,
  runSessionDebugCommand: unexpectedClientCall,
  captureSnapshot: unexpectedClientCall,
  captureScreenshot: unexpectedClientCall,
  recordVideo: unexpectedClientCall,
  performSessionAction: unexpectedClientCall,
  runSessionFlow: unexpectedClientCall,
  exportSessionRecording: unexpectedClientCall,
  replaySessionRecording: unexpectedClientCall,
  getSessionResultSummary: unexpectedClientCall,
  getSessionResultAttachments: unexpectedClientCall,
  recordPerf: unexpectedClientCall,
  recordPerfAroundFlow: unexpectedClientCall,
  summarizePerfBySignpost: unexpectedClientCall,
  drillArtifact: unexpectedClientCall,
  captureDiagnosticBundle: unexpectedClientCall,
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
  test("session show missing session id fails as typed user input", async () => {
    const error = await expectUserInputFailure(runSessionCommand(["show"]))

    expect(error.code).toBe("missing-option")
    expect(error.reason).toContain("--session-id")
  })

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

  test("drill attachment id requires xcresult attachments", async () => {
    const error = await expectUserInputFailure(
      runDrillCommand([
        "--session-id",
        "session-1",
        "--artifact",
        "result-bundle",
        "--attachment-id",
        "att-123",
      ]),
    )

    expect(error.code).toBe("invalid-option")
    expect(error.reason).toContain("--attachment-id")
  })

  test("drill xcresult summary defaults to inline output for json mode", async () => {
    const captured = { current: null as CapturedDrillParams | null }

    await Effect.runPromise(
      Effect.either(
        runDrillCommand([
          "--session-id",
          "session-1",
          "--artifact",
          "result-bundle",
          "--xcresult",
          "summary",
          "--json",
        ]).pipe(
          Effect.provideService(DaemonClient, buildCapturedDrillClient((params) => {
            captured.current = params
          })),
        ),
      ),
    )

    expect(captured.current).toMatchObject({
      sessionId: "session-1",
      artifactKey: "result-bundle",
      outputMode: "inline",
      query: {
        kind: "xcresult",
        view: "summary",
        attachmentId: null,
      },
    })
  })

  test("drill xcresult attachments dispatches attachment id", async () => {
    const captured = { current: null as CapturedDrillParams | null }

    await Effect.runPromise(
      Effect.either(
        runDrillCommand([
          "--session-id",
          "session-1",
          "--artifact",
          "result-bundle",
          "--xcresult",
          "attachments",
          "--attachment-id",
          "att-123",
        ]).pipe(
          Effect.provideService(DaemonClient, buildCapturedDrillClient((params) => {
            captured.current = params
          })),
        ),
      ),
    )

    expect(captured.current).toMatchObject({
      sessionId: "session-1",
      artifactKey: "result-bundle",
      outputMode: "auto",
      query: {
        kind: "xcresult",
        view: "attachments",
        attachmentId: "att-123",
      },
    })
  })

  test("session result summary dispatches the summary RPC", async () => {
    const captured = { current: null as CapturedSessionResultParams | null }

    await Effect.runPromise(
      Effect.either(
        runSessionCommand(["result", "summary", "--session-id", "session-1", "--json"]).pipe(
          Effect.provideService(DaemonClient, buildCapturedSessionResultClient({
            capture: (params) => {
              captured.current = params
            },
          })),
        ),
      ),
    )

    expect(captured.current).toMatchObject({
      sessionId: "session-1",
    })
  })

  test("session result attachments dispatches the attachments RPC", async () => {
    const captured = { current: null as CapturedSessionResultParams | null }

    await Effect.runPromise(
      Effect.either(
        runSessionCommand(["result", "attachments", "--session-id", "session-1", "--json"]).pipe(
          Effect.provideService(DaemonClient, buildCapturedSessionResultClient({
            capture: (params) => {
              captured.current = params
            },
          })),
        ),
      ),
    )

    expect(captured.current).toMatchObject({
      sessionId: "session-1",
    })
  })

  test("session logs mark dispatches label and session id", async () => {
    const captured = { current: null as CapturedLogMarkParams | null }

    await Effect.runPromise(
      Effect.either(
        runSessionCommand(["logs", "mark", "--session-id", "session-1", "--label", "before-submit"]).pipe(
          Effect.provideService(DaemonClient, buildCapturedLogMarkClient((params) => {
            captured.current = params
          })),
        ),
      ),
    )

    expect(captured.current).toMatchObject({
      sessionId: "session-1",
      label: "before-submit",
    })
  })

  test("session logs capture dispatches capture seconds", async () => {
    const captured = { current: null as CapturedLogCaptureParams | null }

    await Effect.runPromise(
      Effect.either(
        runSessionCommand(["logs", "capture", "--session-id", "session-1", "--seconds", "3"]).pipe(
          Effect.provideService(DaemonClient, buildCapturedLogCaptureClient((params) => {
            captured.current = params
          })),
        ),
      ),
    )

    expect(captured.current).toMatchObject({
      sessionId: "session-1",
      captureSeconds: 3,
    })
  })

  test("session logs doctor dispatches session id", async () => {
    const captured = { current: null as CapturedLogDoctorParams | null }

    await Effect.runPromise(
      Effect.either(
        runSessionCommand(["logs", "doctor", "--session-id", "session-1"]).pipe(
          Effect.provideService(DaemonClient, buildCapturedLogDoctorClient((params) => {
            captured.current = params
          })),
        ),
      ),
    )

    expect(captured.current).toMatchObject({
      sessionId: "session-1",
    })
  })

  test("doctor capture dispatches simulator target and session id", async () => {
    const captured = { current: null as CapturedDiagnosticCaptureParams | null }

    await Effect.runPromise(
      Effect.either(
        runDoctorCommand(["capture", "--target", "simulator", "--session-id", "session-1"]).pipe(
          Effect.provideService(DaemonClient, buildCapturedDiagnosticCaptureClient((params) => {
            captured.current = params
          })),
          Effect.provideService(ProbeKernel, neverUsedProbeKernel),
          Effect.provideService(AccessibilityService, neverUsedAccessibilityService),
          Effect.provideService(CommerceService, neverUsedCommerceService),
        ),
      ),
    )

    expect(captured.current).toMatchObject({
      sessionId: "session-1",
      target: "simulator",
      kind: null,
    })
  })

  test("doctor capture dispatches device sysdiagnose kind", async () => {
    const captured = { current: null as CapturedDiagnosticCaptureParams | null }

    await Effect.runPromise(
      Effect.either(
        runDoctorCommand(["capture", "--target", "device", "--session-id", "session-1", "--kind", "sysdiagnose"]).pipe(
          Effect.provideService(DaemonClient, buildCapturedDiagnosticCaptureClient((params) => {
            captured.current = params
          })),
          Effect.provideService(ProbeKernel, neverUsedProbeKernel),
          Effect.provideService(AccessibilityService, neverUsedAccessibilityService),
          Effect.provideService(CommerceService, neverUsedCommerceService),
        ),
      ),
    )

    expect(captured.current).toMatchObject({
      sessionId: "session-1",
      target: "device",
      kind: "sysdiagnose",
    })
  })

  test("session action accepts inline json payloads and selector aliases", async () => {
    const captured = { current: null as CapturedActionParams | null }

    await Effect.runPromise(
      Effect.either(
        runSessionCommand([
          "action",
          "--session-id",
          "session-1",
          "--json",
          '{"kind":"assert","selector":{"kind":"semantic","identifier":"fixture.status.label","label":null,"value":null,"placeholder":null,"type":"staticText","section":null,"interactive":false},"expectation":{"exists":true,"interactive":false}}',
        ]).pipe(
          Effect.provideService(DaemonClient, buildCapturedActionClient((params) => {
            captured.current = params
          })),
        ),
      ),
    )

    expect(captured.current).not.toBeNull()

    if (captured.current === null) {
      throw new Error("Expected action params to be captured")
    }

    expect(captured.current.sessionId).toBe("session-1")
    expect(captured.current.action.kind).toBe("assert")
    expect(captured.current.action.target?.kind).toBe("semantic")
    expect(captured.current.action.expectation?.exists).toBe(true)
    expect(captured.current.action.expectation?.interactive).toBe(false)
  })

  test("session run dispatches flow contracts from files", async () => {
    const captured = { current: null as CapturedFlowParams | null }
    const root = await mkdtemp(join(tmpdir(), "probe-cli-flow-"))
    const flowPath = join(root, "flow.json")

    try {
      await writeFile(
        flowPath,
        `${JSON.stringify({
          contract: "probe.session-flow/v1",
          steps: [
            {
              kind: "sleep",
              durationMs: 250,
            },
          ],
        }, null, 2)}\n`,
        "utf8",
      )

      await Effect.runPromise(
        Effect.either(
          runSessionCommand(["run", "--session-id", "session-1", "--file", flowPath, "--json"]).pipe(
            Effect.provideService(DaemonClient, buildCapturedFlowClient((params) => {
              captured.current = params
            })),
          ),
        ),
      )

      expect(captured.current).not.toBeNull()

      if (captured.current === null) {
        throw new Error("Expected flow params to be captured")
      }

      expect(captured.current.sessionId).toBe("session-1")
      expect(captured.current.flow.contract).toBe("probe.session-flow/v1")
      expect(captured.current.flow.steps[0]?.kind).toBe("sleep")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("session run accepts flow contracts from stdin", async () => {
    const captured = { current: null as CapturedFlowParams | null }

    await Effect.runPromise(
      Effect.either(
        runSessionCommand(
          ["run", "--session-id", "session-1", "--stdin", "--json"],
          {
            readStdinText: () => Effect.succeed(JSON.stringify({
              contract: "probe.session-flow/v1",
              steps: [
                {
                  kind: "sleep",
                  durationMs: 500,
                  continueOnError: true,
                },
              ],
            })),
          },
        ).pipe(
          Effect.provideService(DaemonClient, buildCapturedFlowClient((params) => {
            captured.current = params
          })),
        ),
      ),
    )

    expect(captured.current).not.toBeNull()

    if (captured.current === null) {
      throw new Error("Expected stdin flow params to be captured")
    }

    expect(captured.current.sessionId).toBe("session-1")
    expect(captured.current.flow.steps[0]?.kind).toBe("sleep")
    expect(captured.current.flow.steps[0]?.continueOnError).toBe(true)
  })

  test("perf around dispatches bounded flow profiling requests from files", async () => {
    const captured = { current: null as CapturedPerfAroundParams | null }
    const root = await mkdtemp(join(tmpdir(), "probe-cli-perf-around-"))
    const flowPath = join(root, "flow.json")

    try {
      await writeFile(
        flowPath,
        `${JSON.stringify({
          contract: "probe.session-flow/v1",
          steps: [
            {
              kind: "sleep",
              durationMs: 250,
            },
          ],
        }, null, 2)}\n`,
        "utf8",
      )

      await Effect.runPromise(
        Effect.either(
          runPerfCommand(["around", "--session-id", "session-1", "--file", flowPath, "--template", "logging", "--json"]).pipe(
            Effect.provideService(DaemonClient, buildCapturedPerfAroundClient((params) => {
              captured.current = params
            })),
          ),
        ),
      )

      expect(captured.current).not.toBeNull()

      if (captured.current === null) {
        throw new Error("Expected perf around params to be captured")
      }

      expect(captured.current.sessionId).toBe("session-1")
      expect(captured.current.template).toBe("logging")
      expect(captured.current.flow.contract).toBe("probe.session-flow/v1")
      expect(captured.current.flow.steps[0]?.kind).toBe("sleep")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("perf summarize dispatches signpost summary requests", async () => {
    const captured = { current: null as CapturedPerfSummaryParams | null }

    await Effect.runPromise(
      Effect.either(
        runPerfCommand(["summarize", "--session-id", "session-1", "--artifact", "logging-trace", "--group-by", "signpost", "--json"]).pipe(
          Effect.provideService(DaemonClient, buildCapturedPerfSummaryClient((params) => {
            captured.current = params
          })),
        ),
      ),
    )

    expect(captured.current).not.toBeNull()

    if (captured.current === null) {
      throw new Error("Expected perf summary params to be captured")
    }

    expect(captured.current.sessionId).toBe("session-1")
    expect(captured.current.artifactKey).toBe("logging-trace")
  })
})
