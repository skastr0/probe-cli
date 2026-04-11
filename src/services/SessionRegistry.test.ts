import { describe, expect, test } from "bun:test"
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Either, Layer, ManagedRuntime } from "effect"
import type { ActionRecordingScript, ReplayReport } from "../domain/action"
import type { SessionDebuggerDetails } from "../domain/debug"
import { EnvironmentError, SessionConflictError, SessionNotFoundError, UserInputError } from "../domain/errors"
import { PROBE_PROTOCOL_VERSION } from "../rpc/protocol"
import { ArtifactStore } from "./ArtifactStore"
import { OutputPolicy } from "./OutputPolicy"
import { RealDeviceHarness } from "./RealDeviceHarness"
import { buildSessionCoordination, SessionRegistry, SessionRegistryLive } from "./SessionRegistry"
import { SimulatorHarness } from "./SimulatorHarness"
import { type LldbBridgeHandle, LldbBridgeFactory, type LldbBridgeResponseFrame } from "./LldbBridge"

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

const openParams = {
  bundleId: "dev.probe.fixture",
  simulatorUdid: null,
  rootDir: "/tmp/probe-cli-test",
  emitProgress: () => undefined,
} as const

const deviceOpenParams = {
  bundleId: "dev.probe.fixture",
  deviceId: null,
  rootDir: "/tmp/probe-cli-test",
  emitProgress: () => undefined,
} as const

const withTempRoot = async <T>(run: (root: string) => Promise<T>) => {
  const root = await mkdtemp(join(tmpdir(), "probe-cli-session-registry-"))

  try {
    return await run(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

const withProbeFfmpegPath = async <T>(ffmpegPath: string | undefined, run: () => Promise<T>): Promise<T> => {
  const previous = process.env.PROBE_FFMPEG_PATH

  if (ffmpegPath === undefined) {
    delete process.env.PROBE_FFMPEG_PATH
  } else {
    process.env.PROBE_FFMPEG_PATH = ffmpegPath
  }

  try {
    return await run()
  } finally {
    if (previous === undefined) {
      delete process.env.PROBE_FFMPEG_PATH
    } else {
      process.env.PROBE_FFMPEG_PATH = previous
    }
  }
}

const createFakeFfmpegExecutable = async (root: string): Promise<string> => {
  const executablePath = join(root, "fake-ffmpeg")

  await writeFile(
    executablePath,
    [
      "#!/bin/sh",
      'if [ "$1" = "-version" ]; then',
      '  echo "ffmpeg version fake-test"',
      "  exit 0",
      "fi",
      'output=""',
      'for arg in "$@"; do',
      '  output="$arg"',
      "done",
      'printf "fake mp4 data" > "$output"',
      "exit 0",
      "",
    ].join("\n"),
    "utf8",
  )
  await chmod(executablePath, 0o755)
  return executablePath
}

const waitFor = async <T>(
  read: () => Promise<T>,
  predicate: (value: T) => boolean,
  timeoutMs = 1_000,
): Promise<T> => {
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    const value = await read()

    if (predicate(value)) {
      return value
    }

    await sleep(10)
  }

  const value = await read()

  if (predicate(value)) {
    return value
  }

  throw new Error("Timed out waiting for test condition.")
}

const createTestArtifactStore = (
  root: string,
  options?: {
    readonly failManifestWritesForState?: string
    readonly failManifestWritesCount?: number
  },
) => {
  const sessionsRoot = join(root, "sessions")
  const daemonRoot = join(root, "daemon", "v1")
  const daemonMetadataPath = join(daemonRoot, "daemon.json")
  const daemonSocketPath = join(daemonRoot, "probe.sock")
  let remainingManifestWriteFailures = options?.failManifestWritesCount ?? 0

  const ensureProbeRoots = async () => {
    await mkdir(sessionsRoot, { recursive: true })
    await mkdir(daemonRoot, { recursive: true })
  }

  const readJson = async <T>(path: string, fallback: T): Promise<T> => {
    try {
      return JSON.parse(await readFile(path, "utf8")) as T
    } catch {
      return fallback
    }
  }

  const writeJson = async (path: string, value: unknown) => {
    await mkdir(join(path, ".."), { recursive: true }).catch(() => undefined)
    await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8")
  }

  return ArtifactStore.of({
    getRootDirectory: () => Effect.succeed(sessionsRoot),
    getArtifactRetentionMs: () => 0,
    getDaemonSocketPath: () => Effect.succeed(daemonSocketPath),
    getDaemonMetadataPath: () => Effect.succeed(daemonMetadataPath),
    ensureDaemonDirectories: () =>
      Effect.tryPromise({
        try: ensureProbeRoots,
        catch: (error) =>
          new EnvironmentError({
            code: "test-daemon-directories",
            reason: error instanceof Error ? error.message : String(error),
            nextStep: "Inspect the test artifact store root.",
            details: [],
          }),
      }),
    isDaemonRunning: () => Effect.succeed(false),
    readDaemonMetadata: () => Effect.succeed(null),
    createSessionLayout: (sessionId: string) =>
      Effect.tryPromise({
        try: async () => {
          await ensureProbeRoots()

          const rootDirectory = join(sessionsRoot, sessionId)
          const metaDirectory = join(rootDirectory, "meta")
          const logsDirectory = join(rootDirectory, "logs")
          const logStreamsDirectory = join(logsDirectory, "streams")
          const logTailsDirectory = join(logsDirectory, "tails")
          const runnerDirectory = join(rootDirectory, "runner")
          const outputsDirectory = join(rootDirectory, "outputs")
          const snapshotsDirectory = join(rootDirectory, "snapshots")
          const tracesDirectory = join(rootDirectory, "traces")
          const screenshotsDirectory = join(rootDirectory, "screenshots")
          const debugDirectory = join(rootDirectory, "debug")
          const manifestPath = join(metaDirectory, "session-manifest.json")
          const artifactIndexPath = join(metaDirectory, "artifact-index.json")

          await Promise.all([
            metaDirectory,
            logsDirectory,
            logStreamsDirectory,
            logTailsDirectory,
            runnerDirectory,
            outputsDirectory,
            snapshotsDirectory,
            tracesDirectory,
            screenshotsDirectory,
            debugDirectory,
          ].map((path) => mkdir(path, { recursive: true })))

          await writeJson(artifactIndexPath, [])

          return {
            sessionId,
            root: rootDirectory,
            metaDirectory,
            logsDirectory,
            logStreamsDirectory,
            logTailsDirectory,
            runnerDirectory,
            outputsDirectory,
            snapshotsDirectory,
            tracesDirectory,
            screenshotsDirectory,
            debugDirectory,
            manifestPath,
            artifactIndexPath,
          }
        },
        catch: (error) =>
          new EnvironmentError({
            code: "test-session-layout-create",
            reason: error instanceof Error ? error.message : String(error),
            nextStep: "Inspect the test artifact store root.",
            details: [],
          }),
      }),
    removeSessionLayout: (sessionId: string) =>
      Effect.tryPromise({
        try: () => rm(join(sessionsRoot, sessionId), { recursive: true, force: true }),
        catch: (error) =>
          new EnvironmentError({
            code: "test-session-layout-remove",
            reason: error instanceof Error ? error.message : String(error),
            nextStep: "Inspect the test artifact store root.",
            details: [],
          }),
        }).pipe(Effect.catchAll(() => Effect.void), Effect.asVoid),
    readSessionManifest: (sessionId: string) =>
      Effect.tryPromise({
        try: async () => {
          try {
            return JSON.parse(await readFile(join(sessionsRoot, sessionId, "meta", "session-manifest.json"), "utf8")) as Record<string, unknown>
          } catch {
            return null
          }
        },
        catch: (error) =>
          new EnvironmentError({
            code: "test-session-manifest-read",
            reason: error instanceof Error ? error.message : String(error),
            nextStep: "Inspect the test artifact store root.",
            details: [],
          }),
      }),
    listPersistedSessions: () => Effect.succeed([]),
    writeSessionManifest: (sessionId: string, value: Record<string, unknown>) =>
      Effect.tryPromise({
        try: async () => {
          if (
            remainingManifestWriteFailures > 0
            && value.state === options?.failManifestWritesForState
          ) {
            remainingManifestWriteFailures -= 1
            throw new Error(`forced manifest write failure for state ${String(value.state)}`)
          }

          await ensureProbeRoots()
          const manifestPath = join(sessionsRoot, sessionId, "meta", "session-manifest.json")
          await mkdir(join(sessionsRoot, sessionId, "meta"), { recursive: true })
          await writeJson(manifestPath, value)
        },
        catch: (error) =>
          new EnvironmentError({
            code: "test-session-manifest-write",
            reason: error instanceof Error ? error.message : String(error),
            nextStep: "Inspect the test artifact store root.",
            details: [],
          }),
      }),
    registerArtifact: (sessionId: string, record: any) =>
      Effect.tryPromise({
        try: async () => {
          const indexPath = join(sessionsRoot, sessionId, "meta", "artifact-index.json")
          const existing = await readJson<Array<typeof record>>(indexPath, [])
          await writeJson(
            indexPath,
            [...existing.filter((entry) => entry.key !== record.key), record],
          )
          return record
        },
        catch: (error) =>
          new EnvironmentError({
            code: "test-artifact-register",
            reason: error instanceof Error ? error.message : String(error),
            nextStep: "Inspect the test artifact store root.",
            details: [],
          }),
      }),
    listArtifacts: (sessionId: string) =>
      Effect.tryPromise({
        try: () => readJson(join(sessionsRoot, sessionId, "meta", "artifact-index.json"), []),
        catch: (error) =>
          new EnvironmentError({
            code: "test-artifact-list",
            reason: error instanceof Error ? error.message : String(error),
            nextStep: "Inspect the test artifact store root.",
            details: [],
          }),
      }),
    getArtifact: () => Effect.die("unused in SessionRegistry tests") as never,
    writeDerivedOutput: () => Effect.die("unused in SessionRegistry tests") as never,
    removeDaemonMetadata: () =>
      Effect.tryPromise({
        try: () => rm(daemonMetadataPath, { force: true }),
        catch: (error) =>
          new EnvironmentError({
            code: "test-daemon-metadata-remove",
            reason: error instanceof Error ? error.message : String(error),
            nextStep: "Inspect the test artifact store root.",
            details: [],
          }),
      }).pipe(Effect.catchAll(() => Effect.void), Effect.asVoid),
    writeDaemonMetadata: (value: Record<string, unknown>) =>
      Effect.tryPromise({
        try: async () => {
          await ensureProbeRoots()
          await writeJson(daemonMetadataPath, value)
        },
        catch: (error) =>
          new EnvironmentError({
            code: "test-daemon-metadata-write",
            reason: error instanceof Error ? error.message : String(error),
            nextStep: "Inspect the test artifact store root.",
            details: [],
          }),
      }),
    syncDaemonSessionMetadata: (sessions: ReadonlyArray<unknown>) =>
      Effect.tryPromise({
        try: async () => {
          const current = await readJson<Record<string, unknown>>(daemonMetadataPath, {})

          if (Object.keys(current).length === 0) {
            return
          }

          await writeJson(daemonMetadataPath, {
            ...current,
            activeSessions: sessions.length,
            sessions,
            updatedAt: new Date().toISOString(),
          })
        },
        catch: (error) =>
          new EnvironmentError({
            code: "test-daemon-session-metadata-sync",
            reason: error instanceof Error ? error.message : String(error),
            nextStep: "Inspect the test artifact store root.",
            details: [],
          }),
      }).pipe(Effect.catchAll(() => Effect.void), Effect.asVoid),
    pruneExpiredSessions: () => Effect.void,
  } as any)
}

interface FakeHarnessSessionControl {
  readonly triggerExit: (value?: { readonly code: number | null; readonly signal: string | null }) => void
  readonly getCloseCalls: () => number
}

interface FakeHarnessUiActionIntercept {
  readonly callIndex: number
  readonly kind: string | null
  readonly identifier: string | null
  readonly label: string | null
  readonly text: string | null
  readonly replace: boolean | null
}

interface FakeHarnessUiActionInterceptResult {
  readonly ok: boolean
  readonly payload?: string | null
  readonly error?: string | null
}

interface FakeHarnessRunnerCommand {
  readonly sequence: number
  readonly action: string
  readonly payload: string | null
}

interface FakeHarnessOpenArgs {
  readonly bundleId: string
  readonly simulatorUdid: string | null
  readonly sessionMode: "build-and-install" | "attach-to-running" | undefined
}

const createFakeHarness = (options?: {
  readonly onOpenStart?: () => void
  readonly releaseOpen?: Promise<void>
  readonly failWith?: Error
  readonly captureOpenArgs?: (args: FakeHarnessOpenArgs) => void
  readonly captureSessionControl?: (control: FakeHarnessSessionControl) => void
  readonly captureRunnerCommand?: (command: FakeHarnessRunnerCommand) => void
  readonly interceptUiAction?: (
    action: FakeHarnessUiActionIntercept,
  ) => FakeHarnessUiActionInterceptResult | null | undefined
}) => {
  return SimulatorHarness.of({
    openSession: (args) =>
      Effect.tryPromise({
        try: async () => {
          options?.onOpenStart?.()
          options?.captureOpenArgs?.({
            bundleId: args.bundleId,
            simulatorUdid: args.simulatorUdid,
            sessionMode: args.sessionMode,
          })

          if (options?.releaseOpen) {
            await options.releaseOpen
          }

          if (options?.failWith) {
            throw options.failWith
          }

          const runtimeControlDirectory = join(args.runnerDirectory, "runtime-control")
          const observerControlDirectory = join(args.runnerDirectory, "observer-control")
          const buildLogPath = join(args.logsDirectory, "build-for-testing.log")
          const logPath = join(args.logsDirectory, "xcodebuild-session.log")
          const stdoutEventsPath = join(args.runnerDirectory, "stdout-events.ndjson")
          const resultBundlePath = join(args.runnerDirectory, "ProbeRunnerTransportBoundary.xcresult")
          const wrapperStderrPath = join(args.logsDirectory, "runner-wrapper.stderr.log")

          await Promise.all([
            mkdir(runtimeControlDirectory, { recursive: true }),
            mkdir(observerControlDirectory, { recursive: true }),
            mkdir(resultBundlePath, { recursive: true }),
            writeFile(buildLogPath, "build ok\n", "utf8"),
            writeFile(logPath, "session ok\n", "utf8"),
            writeFile(stdoutEventsPath, "{}\n", "utf8"),
            writeFile(wrapperStderrPath, "", "utf8"),
          ])

          let running = true
          let didExit = false
          let closeCalls = 0
          let resolveExit!: (value: { readonly code: number | null; readonly signal: string | null }) => void
          const waitForExit = new Promise<{ readonly code: number | null; readonly signal: string | null }>(
            (resolve) => {
              resolveExit = resolve
            },
          )

          const finishExit = (value: { readonly code: number | null; readonly signal: string | null }) => {
            if (didExit) {
              return
            }

            didExit = true
            running = false
            resolveExit(value)
          }

          options?.captureSessionControl?.({
            triggerExit: (value = { code: 1, signal: null }) => {
              finishExit(value)
            },
            getCloseCalls: () => closeCalls,
          })

          const close = async () => {
            if (!running) {
              return
            }

            closeCalls += 1
            finishExit({ code: 0, signal: null })
          }

          const pngFixtureBytes = Buffer.from(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4////fwAJ+wP9KobjigAAAABJRU5ErkJggg==",
            "base64",
          )

          let statusLabel = "Ready for attach/control validation"
          let inputValue = ""
          let uiActionCallCount = 0

          const buildSnapshotPayload = () => ({
            capturedAt: "2026-04-10T00:00:00.000Z",
            statusLabel,
            metrics: {
              rawNodeCount: 7,
              prunedNodeCount: 7,
              interactiveNodeCount: 4,
            },
            root: {
              type: "application",
              identifier: null,
              label: null,
              value: null,
              placeholder: null,
              frame: null,
              state: null,
              interactive: false,
              children: [
                {
                  type: "other",
                  identifier: "fixture.root.view",
                  label: null,
                  value: null,
                  placeholder: null,
                  frame: { x: 0, y: 0, width: 320, height: 640 },
                  state: null,
                  interactive: false,
                  children: [
                    {
                      type: "scrollView",
                      identifier: null,
                      label: null,
                      value: null,
                      placeholder: null,
                      frame: { x: 0, y: 0, width: 320, height: 640 },
                      state: null,
                      interactive: false,
                      children: [
                        {
                          type: "staticText",
                          identifier: "fixture.status.label",
                          label: statusLabel,
                          value: null,
                          placeholder: null,
                          frame: { x: 0, y: 0, width: 220, height: 20 },
                          state: null,
                          interactive: false,
                          children: [],
                        },
                        {
                          type: "textField",
                          identifier: "fixture.form.input",
                          label: null,
                          value: inputValue.length > 0 ? inputValue : null,
                          placeholder: "Type fixture input",
                          frame: { x: 0, y: 30, width: 220, height: 44 },
                          state: null,
                          interactive: true,
                          children: [],
                        },
                        {
                          type: "button",
                          identifier: "fixture.form.applyButton",
                          label: "Apply Input",
                          value: null,
                          placeholder: null,
                          frame: { x: 0, y: 84, width: 120, height: 44 },
                          state: null,
                          interactive: true,
                          children: [],
                        },
                        {
                          type: "button",
                          identifier: "fixture.navigation.detailButton",
                          label: "Open Detail",
                          value: null,
                          placeholder: null,
                          frame: { x: 0, y: 138, width: 120, height: 44 },
                          state: null,
                          interactive: true,
                          children: [],
                        },
                        {
                          type: "button",
                          identifier: "fixture.problem.offscreenButton",
                          label: "Tap Offscreen Action",
                          value: null,
                          placeholder: null,
                          frame: { x: 0, y: 500, width: 180, height: 44 },
                          state: null,
                          interactive: true,
                          children: [],
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          })

          const handleUiAction = (payload: string | undefined | null): FakeHarnessUiActionInterceptResult => {
            const command = JSON.parse(payload ?? "{}") as {
              readonly kind?: string
              readonly locator?: {
                readonly identifier?: string | null
                readonly label?: string | null
              }
              readonly text?: string | null
              readonly replace?: boolean | null
            }
            const identifier = command.locator?.identifier ?? null
            const label = command.locator?.label ?? null
            uiActionCallCount += 1

            const intercepted = options?.interceptUiAction?.({
              callIndex: uiActionCallCount,
              kind: command.kind ?? null,
              identifier,
              label,
              text: command.text ?? null,
              replace: command.replace ?? null,
            })

            if (intercepted) {
              return {
                ok: intercepted.ok,
                payload: intercepted.payload ?? null,
                error: intercepted.error ?? null,
              }
            }

            switch (command.kind) {
              case "type": {
                const nextText = command.text ?? ""
                inputValue = command.replace === false ? `${inputValue}${nextText}` : nextText
                return {
                  ok: true,
                  payload: `typed into ${identifier ?? label ?? "field"}`,
                  error: null,
                }
              }
              case "tap":
              case "press": {
                if (identifier === "fixture.form.applyButton") {
                  const rendered = inputValue.trim().length > 0 ? inputValue.trim() : "<empty>"
                  statusLabel = `Input applied: ${rendered}`
                } else if (identifier === "fixture.navigation.detailButton") {
                  statusLabel = "Detail view active"
                } else if (identifier === "fixture.problem.offscreenButton") {
                  statusLabel = "Offscreen action reached"
                }

                return {
                  ok: true,
                  payload: `${command.kind} on ${identifier ?? label ?? "target"}`,
                  error: null,
                }
              }
              case "swipe":
              case "scroll":
                return {
                  ok: true,
                  payload: `${command.kind} on ${identifier ?? label ?? "target"}`,
                  error: null,
                }
              default:
                throw new Error(`Unsupported fake uiAction kind: ${command.kind ?? "<missing>"}`)
            }
          }

          return {
            simulator: {
              udid: args.simulatorUdid ?? "sim-001",
              name: "iPhone 16",
              runtime: "iOS 18.0",
            },
            bundleId: args.bundleId,
            targetProcessId: 101,
            wrapperProcessId: 202,
            testProcessId: 303,
            attachLatencyMs: 12,
            bootstrapPath: `/tmp/probe-runner-bootstrap/${args.simulatorUdid ?? "sim-001"}.json`,
            bootstrapSource: "simulator-bootstrap-manifest",
            runnerTransportContract: "probe.runner.transport/hybrid-v1",
            sessionIdentifier: args.sessionId,
            commandIngress: "file-mailbox",
            eventEgress: "stdout-jsonl-mixed-log",
            runtimeControlDirectory,
            observerControlDirectory,
            logPath,
            buildLogPath,
            stdoutEventsPath,
            resultBundlePath,
            wrapperStderrPath,
            stdinProbeStatus: "timeout",
            initialPingRttMs: 5,
            nextSequence: 2,
            sendCommand: async (_sequence, action, payload) => {
              options?.captureRunnerCommand?.({
                sequence: _sequence,
                action,
                payload: payload ?? null,
              })

              if (action === "snapshot") {
                const snapshotPayloadPath = join(runtimeControlDirectory, `snapshot-${String(_sequence).padStart(3, "0")}.json`)
                await writeFile(
                  snapshotPayloadPath,
                  `${JSON.stringify(buildSnapshotPayload(), null, 2)}\n`,
                  "utf8",
                )

                return {
                  ok: true,
                  action,
                  error: null,
                  payload: "snapshot-captured",
                  snapshotPayloadPath,
                  handledMs: 1,
                  statusLabel,
                  snapshotNodeCount: 7,
                  hostRttMs: 1,
                }
              }

              if (action === "uiAction") {
                const handled = handleUiAction(payload)
                return {
                  ok: handled.ok,
                  action,
                  error: handled.error ?? null,
                  payload: handled.payload ?? null,
                  snapshotPayloadPath: null,
                  handledMs: 1,
                  statusLabel,
                  snapshotNodeCount: null,
                  hostRttMs: 1,
                }
              }

              if (action === "screenshot") {
                const snapshotPayloadPath = join(runtimeControlDirectory, `screenshot-${String(_sequence).padStart(3, "0")}.png`)
                await writeFile(snapshotPayloadPath, pngFixtureBytes)

                return {
                  ok: true,
                  action,
                  error: null,
                  payload: "screenshot-captured",
                  snapshotPayloadPath,
                  handledMs: 1,
                  statusLabel,
                  snapshotNodeCount: null,
                  hostRttMs: 1,
                }
              }

              if (action === "recordVideo") {
                const durationMs = Math.min(Math.max(Number(payload ?? "10000") || 10_000, 1), 120_000)
                const framesDirectoryPath = join(runtimeControlDirectory, `video-frames-${String(_sequence).padStart(3, "0")}`)
                const framePath = join(framesDirectoryPath, "frame-00000.png")
                const manifestPath = join(framesDirectoryPath, "manifest.json")

                await mkdir(framesDirectoryPath, { recursive: true })
                await Promise.all([
                  writeFile(framePath, pngFixtureBytes),
                  writeFile(
                    manifestPath,
                    `${JSON.stringify({
                      durationMs,
                      fps: 10,
                      frameCount: 1,
                      framesDirectoryPath,
                    }, null, 2)}\n`,
                    "utf8",
                  ),
                ])

                return {
                  ok: true,
                  action,
                  error: null,
                  payload: "video-captured",
                  snapshotPayloadPath: framesDirectoryPath,
                  handledMs: 1,
                  statusLabel,
                  snapshotNodeCount: null,
                  hostRttMs: 1,
                }
              }

              return {
                ok: true,
                action,
                error: null,
                payload: payload ?? null,
                snapshotPayloadPath: null,
                handledMs: 1,
                statusLabel,
                snapshotNodeCount: null,
                hostRttMs: 1,
              }
            },
            isWrapperRunning: () => running,
            waitForExit,
            close,
          }
        },
        catch: (error) =>
          error instanceof EnvironmentError
            ? error
            : new EnvironmentError({
                code: "fake-harness-open",
                reason: error instanceof Error ? error.message : String(error),
                nextStep: "Inspect the test harness and retry.",
                details: [],
              }),
      }),
    captureSimulatorLogStream: (args) =>
      Effect.tryPromise({
        try: async () => {
          const absolutePath = join(args.logsDirectory, "streams", "simulator.log")
          await mkdir(join(args.logsDirectory, "streams"), { recursive: true })
          await writeFile(
            absolutePath,
            '{"message":"fixture log alpha"}\n{"message":"fixture log beta"}\n',
            "utf8",
          )
          return { absolutePath }
        },
        catch: (error) =>
          new EnvironmentError({
            code: "fake-harness-log-capture",
            reason: error instanceof Error ? error.message : String(error),
            nextStep: "Inspect the fake harness log capture path.",
            details: [],
          }),
      }),
    reapStaleRunnerSession: (args) =>
      Effect.succeed({
        summary: `No stale runner cleanup was needed for session ${args.sessionId}.`,
        details: [],
      }),
  })
}

const createFakeRealDeviceHarness = (options?: {
  readonly failWith?: Error
  readonly connectionStates?: ReadonlyArray<"connected" | "disconnected">
}) => {
  let connectionIndex = 0
  let running = true
  let resolveExit!: (value: { readonly code: number | null; readonly signal: string | null }) => void
  const waitForExit = new Promise<{ readonly code: number | null; readonly signal: string | null }>((resolve) => {
    resolveExit = resolve
  })

  const finishExit = (value: { readonly code: number | null; readonly signal: string | null }) => {
    if (!running) {
      return
    }

    running = false
    resolveExit(value)
  }

  return RealDeviceHarness.of({
    openPreflightSession: (args) =>
      Effect.tryPromise({
        try: async () => {
          if (options?.failWith) {
            throw options.failWith
          }

          const nextStatus = options?.connectionStates?.[0] ?? "connected"
          const metaDirectory = join(args.artifactRoot, "meta")
          const logsDirectory = join(args.logsDirectory, "device-preflight")
          await mkdir(metaDirectory, { recursive: true })
          await mkdir(logsDirectory, { recursive: true })

          const preferredDdiJsonPath = join(metaDirectory, "preferred-ddi.json")
          const devicesJsonPath = join(metaDirectory, "devices.json")
          const ddiServicesJsonPath = join(metaDirectory, "ddi-services.json")
          const preflightReportPath = join(metaDirectory, "real-device-preflight.json")
          const buildLogPath = join(logsDirectory, "xcodebuild-build-for-testing-device.log")
          const xctestrunPath = join(args.runnerDirectory, "fake.xctestrun")
          const targetAppPath = join(args.runnerDirectory, "ProbeFixture.app")
          const runnerAppPath = join(args.runnerDirectory, "ProbeRunnerUITests-Runner.app")
          const runnerXctestPath = join(args.runnerDirectory, "ProbeRunnerUITests.xctest")

          await mkdir(metaDirectory, { recursive: true })
          await mkdir(logsDirectory, { recursive: true })

          await Promise.all([
            writeFile(preferredDdiJsonPath, "{}\n", "utf8"),
            writeFile(devicesJsonPath, "{}\n", "utf8"),
            writeFile(ddiServicesJsonPath, "{}\n", "utf8"),
            writeFile(preflightReportPath, "{}\n", "utf8"),
            writeFile(buildLogPath, "build ok\n", "utf8"),
            writeFile(xctestrunPath, "<plist/>\n", "utf8"),
            mkdir(targetAppPath, { recursive: true }),
            mkdir(runnerAppPath, { recursive: true }),
            mkdir(runnerXctestPath, { recursive: true }),
          ])

          return {
            mode: "preflight",
            device: {
              identifier: "device-1",
              name: "Test iPhone",
              runtime: "iOS 18.0",
            },
            bundleId: "dev.probe.fixture",
            hostCoreDeviceVersion: "506.7",
            preferredDdiPath: "file:///Library/Developer/DeveloperDiskImages/iOS_DDI/",
            preferredDdiJsonPath,
            devicesJsonPath,
            ddiServicesJsonPath,
            preflightReportPath,
            buildLogPath,
            xctestrunPath,
            targetAppPath,
            runnerAppPath,
            runnerXctestPath,
            integrationPoints: [
              "xcrun devicectl list preferredDDI --json-output <path>",
              "xcrun devicectl list devices --json-output <path>",
            ],
            warnings: ["Fake real-device preflight warning."],
            connection: {
              status: nextStatus,
              checkedAt: "2026-04-10T00:00:00.000Z",
              summary: nextStatus === "connected" ? "Device connected." : "Device disconnected.",
              details: [],
            },
            refreshConnection: async () => {
              const states = options?.connectionStates ?? ["connected"]
              const status = states[Math.min(connectionIndex, states.length - 1)]!
              connectionIndex += 1
              return {
                status,
                checkedAt: new Date().toISOString(),
                summary: status === "connected" ? "Device connected." : "Device disconnected.",
                details: [],
              }
            },
            close: async () => undefined,
          }
        },
        catch: (error) => error as EnvironmentError,
      }),
    openLiveSession: (args) =>
      Effect.tryPromise({
        try: async () => {
          if (options?.failWith) {
            throw options.failWith
          }

          const nextStatus = options?.connectionStates?.[0] ?? "connected"
          const metaDirectory = join(args.artifactRoot, "meta")
          const logsDirectory = join(args.logsDirectory, "device-live")
          const buildLogsDirectory = join(args.logsDirectory, "device-preflight")
          const observerControlDirectory = join(args.runnerDirectory, "observer-control")
          const runtimeControlDirectory = join(args.runnerDirectory, "runtime-control")
          const preferredDdiJsonPath = join(metaDirectory, "preferred-ddi.json")
          const devicesJsonPath = join(metaDirectory, "devices.json")
          const ddiServicesJsonPath = join(metaDirectory, "ddi-services.json")
          const preflightReportPath = join(metaDirectory, "real-device-preflight.json")
          const installedAppsJsonPath = join(metaDirectory, "installed-apps.json")
          const launchJsonPath = join(metaDirectory, "target-app-launch.json")
          const buildLogPath = join(buildLogsDirectory, "xcodebuild-build-for-testing-device.log")
          const logPath = join(logsDirectory, "xcodebuild-session.log")
          const stdoutEventsPath = join(args.runnerDirectory, "stdout-events.ndjson")
          const resultBundlePath = join(args.runnerDirectory, "ProbeRunnerTransportBoundary.xcresult")
          const wrapperStderrPath = join(logsDirectory, "runner-wrapper.stderr.log")
          const xctestrunPath = join(args.runnerDirectory, "fake.xctestrun")
          const targetAppPath = join(args.runnerDirectory, "ProbeFixture.app")
          const runnerAppPath = join(args.runnerDirectory, "ProbeRunnerUITests-Runner.app")
          const runnerXctestPath = join(args.runnerDirectory, "ProbeRunnerUITests.xctest")

          await mkdir(metaDirectory, { recursive: true })
          await mkdir(logsDirectory, { recursive: true })
          await mkdir(buildLogsDirectory, { recursive: true })
          await mkdir(observerControlDirectory, { recursive: true })
          await mkdir(runtimeControlDirectory, { recursive: true })
          await mkdir(resultBundlePath, { recursive: true })

          await Promise.all([
            writeFile(preferredDdiJsonPath, "{}\n", "utf8"),
            writeFile(devicesJsonPath, "{}\n", "utf8"),
            writeFile(ddiServicesJsonPath, "{}\n", "utf8"),
            writeFile(preflightReportPath, "{}\n", "utf8"),
            writeFile(installedAppsJsonPath, "{}\n", "utf8"),
            writeFile(launchJsonPath, "{}\n", "utf8"),
            writeFile(buildLogPath, "build ok\n", "utf8"),
            writeFile(logPath, "runner ok\n", "utf8"),
            writeFile(stdoutEventsPath, "{}\n", "utf8"),
            writeFile(wrapperStderrPath, "", "utf8"),
            writeFile(xctestrunPath, "<plist/>\n", "utf8"),
            mkdir(targetAppPath, { recursive: true }),
            mkdir(runnerAppPath, { recursive: true }),
            mkdir(runnerXctestPath, { recursive: true }),
          ])

          running = true

          return {
            mode: "live",
            device: {
              identifier: "device-1",
              name: "Test iPhone",
              runtime: "iOS 18.0",
            },
            bundleId: args.bundleId,
            hostCoreDeviceVersion: "506.7",
            preferredDdiPath: "file:///Library/Developer/DeveloperDiskImages/iOS_DDI/",
            preferredDdiJsonPath,
            devicesJsonPath,
            ddiServicesJsonPath,
            preflightReportPath,
            buildLogPath,
            xctestrunPath,
            targetAppPath,
            runnerAppPath,
            runnerXctestPath,
            integrationPoints: [
              "xcrun devicectl list preferredDDI --json-output <path>",
              "xcrun devicectl list devices --json-output <path>",
              "xcrun devicectl device info apps --device device-1 --bundle-id <bundle-id> --json-output <path>",
              "xcrun devicectl device process launch --device device-1 --terminate-existing <bundle-id> --json-output <path>",
            ],
            warnings: ["Fake real-device live runner warning."],
            connection: {
              status: nextStatus,
              checkedAt: "2026-04-10T00:00:00.000Z",
              summary: nextStatus === "connected" ? "Device connected." : "Device disconnected.",
              details: [],
            },
            refreshConnection: async () => {
              const states = options?.connectionStates ?? ["connected"]
              const status = states[Math.min(connectionIndex, states.length - 1)]!
              connectionIndex += 1
              return {
                status,
                checkedAt: new Date().toISOString(),
                summary: status === "connected" ? "Device connected." : "Device disconnected.",
                details: [],
              }
            },
            close: async () => {
              finishExit({ code: 0, signal: null })
            },
            bootstrapPath: "/tmp/probe-runner-bootstrap/device-device-1.json",
            bootstrapSource: "device-bootstrap-manifest",
            runnerTransportContract: "probe.runner.transport/hybrid-v1",
            sessionIdentifier: args.sessionId,
            commandIngress: "file-mailbox",
            eventEgress: "stdout-jsonl-mixed-log",
            wrapperProcessId: 4401,
            testProcessId: 4402,
            targetProcessId: 4403,
            attachLatencyMs: 321,
            runtimeControlDirectory,
            observerControlDirectory,
            logPath,
            stdoutEventsPath,
            resultBundlePath,
            wrapperStderrPath,
            stdinProbeStatus: "timeout",
            installedAppsJsonPath,
            launchJsonPath,
            nextSequence: 2,
            initialPingRttMs: 18,
            sendCommand: async (sequence, action) => ({
              ok: true,
              action,
              error: null,
              payload: action === "ping" ? "pong" : null,
              snapshotPayloadPath: null,
              handledMs: 5,
              statusLabel: `ok-${sequence}`,
              snapshotNodeCount: null,
              hostRttMs: 7,
            }),
            isWrapperRunning: () => running,
            waitForExit,
          }
        },
        catch: (error) => error as EnvironmentError,
      }),
  })
}

const createFakeLldbBridgeFactory = (options?: {
  readonly send?: (request: Record<string, unknown>) => Promise<unknown> | unknown
}) => {
  const startCalls: Array<{ readonly sessionId: string; readonly debugDirectory: string }> = []
  const sentRequests: Array<Record<string, unknown>> = []
  let closeCalls = 0

  return {
    startCalls,
    sentRequests,
    get closeCalls() {
      return closeCalls
    },
    factory: LldbBridgeFactory.of({
      start: ({ sessionId, debugDirectory }) =>
        Effect.sync(() => {
          startCalls.push({ sessionId, debugDirectory })

          let running = true
          let didExit = false
          let resolveExit!: (value: { readonly code: number | null; readonly signal: string | null }) => void
          const waitForExit = new Promise<{ readonly code: number | null; readonly signal: string | null }>((resolve) => {
            resolveExit = resolve
          })

          const finishExit = (value: { readonly code: number | null; readonly signal: string | null }) => {
            if (didExit) {
              return
            }

            didExit = true
            running = false
            resolveExit(value)
          }

          return {
            ready: {
              kind: "ready",
              bridgePid: 4040,
              pythonExecutable: "/usr/bin/python3",
              lldbPythonPath: "/Applications/Xcode.app/Contents/SharedFrameworks/LLDB.framework/Resources/Python",
              lldbVersion: "lldb-1900.0.0",
              initFilesSkipped: true,
              asyncMode: false,
            },
            frameLogPath: join(debugDirectory, `${sessionId}-fake-lldb.frames.ndjson`),
            stderrLogPath: join(debugDirectory, `${sessionId}-fake-lldb.stderr.log`),
            send: async (request) => {
              sentRequests.push(request)

              return (await options?.send?.(request) ?? {
                kind: "response",
                id: null,
                command: String(request.command ?? "unknown"),
                ok: true,
                state: "shutting-down",
              }) as LldbBridgeResponseFrame
            },
            close: async () => {
              closeCalls += 1
              finishExit({ code: 0, signal: null })
            },
            isRunning: () => running,
            waitForExit,
          } satisfies LldbBridgeHandle
        }),
    }),
  }
}

const makeRuntime = (
  root: string,
  harness: ReturnType<typeof createFakeHarness>,
  options?: {
    readonly artifactStore?: {
      readonly failManifestWritesForState?: string
      readonly failManifestWritesCount?: number
    }
    readonly lldbBridgeFactory?: ReturnType<typeof createFakeLldbBridgeFactory>["factory"]
    readonly realDeviceHarness?: ReturnType<typeof createFakeRealDeviceHarness>
  },
) => {
  const fakeLldbBridgeFactory = LldbBridgeFactory.of({
    start: () =>
      Effect.fail(
        new EnvironmentError({
          code: "fake-lldb-bridge",
          reason: "LLDB bridge not available in test runtime.",
          nextStep: "Use integration tests for LLDB bridge validation.",
          details: [],
        }),
      ),
  })

  const baseLayer = Layer.mergeAll(
    Layer.succeed(ArtifactStore, createTestArtifactStore(root, options?.artifactStore)),
    Layer.succeed(SimulatorHarness, harness),
    Layer.succeed(RealDeviceHarness, options?.realDeviceHarness ?? createFakeRealDeviceHarness()),
    Layer.succeed(LldbBridgeFactory, options?.lldbBridgeFactory ?? fakeLldbBridgeFactory),
    Layer.succeed(
      OutputPolicy,
      OutputPolicy.of({
        getDefaultInlineThreshold: () => ({ maxInlineBytes: 4 * 1024, maxInlineLines: 100 }),
        shouldInline: (mode, content) =>
          mode !== "artifact"
          && Buffer.byteLength(content, "utf8") <= 4 * 1024
          && content.split(/\r?\n/).length <= 100,
        shouldInlineBinary: () => false,
      }),
    ),
  )
  const registryLayer = SessionRegistryLive.pipe(Layer.provide(baseLayer))

  return ManagedRuntime.make(Layer.mergeAll(baseLayer, registryLayer))
}

describe("SessionRegistry", () => {
  test("returns session-conflict while another open is still in flight", async () => {
    await withTempRoot(async (root) => {
      let releaseOpen!: () => void
      let signalOpenStarted!: () => void

      const releaseOpenPromise = new Promise<void>((resolve) => {
        releaseOpen = resolve
      })
      const openStartedPromise = new Promise<void>((resolve) => {
        signalOpenStarted = resolve
      })

      const runtime = makeRuntime(
        root,
        createFakeHarness({
          onOpenStart: signalOpenStarted,
          releaseOpen: releaseOpenPromise,
        }),
      )

      try {
        const artifactStore = await runtime.runPromise(Effect.gen(function* () {
          return yield* ArtifactStore
        }))
        const registry = await runtime.runPromise(Effect.gen(function* () {
          return yield* SessionRegistry
        }))

        const firstOpen = runtime.runPromise(registry.openSimulatorSession(openParams))

        await openStartedPromise

        const secondOpen = await runtime.runPromise(Effect.either(registry.openSimulatorSession(openParams)))
        expect(Either.isLeft(secondOpen)).toBe(true)

        if (Either.isLeft(secondOpen)) {
          expect(secondOpen.left).toBeInstanceOf(SessionConflictError)
        }

        const sessionsRoot = await runtime.runPromise(artifactStore.getRootDirectory())
        expect((await readdir(sessionsRoot)).length).toBe(1)

        releaseOpen()

        const firstSession = await firstOpen
        expect(firstSession.state).toBe("ready")

        await runtime.runPromise(registry.closeSession(firstSession.sessionId))
      } finally {
        await runtime.dispose()
      }
    })
  })

  test("removes failed opening session layouts from disk", async () => {
    await withTempRoot(async (root) => {
      const runtime = makeRuntime(
        root,
        createFakeHarness({
          failWith: new EnvironmentError({
            code: "simulator-open-failed",
            reason: "simulator open failed for test",
            nextStep: "retry",
            details: [],
          }),
        }),
      )

      try {
        const artifactStore = await runtime.runPromise(Effect.gen(function* () {
          return yield* ArtifactStore
        }))
        const registry = await runtime.runPromise(Effect.gen(function* () {
          return yield* SessionRegistry
        }))

        const result = await runtime.runPromise(Effect.either(registry.openSimulatorSession(openParams)))
        expect(Either.isLeft(result)).toBe(true)

        if (Either.isLeft(result)) {
          expect(result.left).toBeInstanceOf(EnvironmentError)
        }

        const sessionsRoot = await runtime.runPromise(artifactStore.getRootDirectory())
        expect(await readdir(sessionsRoot)).toEqual([])
      } finally {
        await runtime.dispose()
      }
    })
  })

  test("fails closed when the ready manifest cannot be persisted", async () => {
    await withTempRoot(async (root) => {
      let harnessControl: FakeHarnessSessionControl | null = null

      const runtime = makeRuntime(
        root,
        createFakeHarness({
          captureSessionControl: (control) => {
            harnessControl = control
          },
        }),
        {
          artifactStore: {
            failManifestWritesForState: "ready",
            failManifestWritesCount: 1,
          },
        },
      )

      try {
        const artifactStore = await runtime.runPromise(Effect.gen(function* () {
          return yield* ArtifactStore
        }))
        const registry = await runtime.runPromise(Effect.gen(function* () {
          return yield* SessionRegistry
        }))

        const failedOpen = await runtime.runPromise(Effect.either(registry.openSimulatorSession(openParams)))
        expect(Either.isLeft(failedOpen)).toBe(true)

        if (Either.isLeft(failedOpen)) {
          expect(failedOpen.left).toBeInstanceOf(EnvironmentError)
        }

        const closedHarness = await waitFor(
          async () => harnessControl?.getCloseCalls() ?? 0,
          (closeCalls) => closeCalls === 1,
        )
        expect(closedHarness).toBe(1)
        expect(await runtime.runPromise(registry.getActiveSessionCount())).toBe(0)

        const sessionsRoot = await runtime.runPromise(artifactStore.getRootDirectory())
        expect(await readdir(sessionsRoot)).toEqual([])

        const reopened = await runtime.runPromise(registry.openSimulatorSession(openParams))
        expect(reopened.state).toBe("ready")

        await runtime.runPromise(registry.closeSession(reopened.sessionId))
      } finally {
        await runtime.dispose()
      }
    })
  })

  test("publishes opening session metadata while open is in flight", async () => {
    await withTempRoot(async (root) => {
      let releaseOpen!: () => void
      let signalOpenStarted!: () => void

      const releaseOpenPromise = new Promise<void>((resolve) => {
        releaseOpen = resolve
      })
      const openStartedPromise = new Promise<void>((resolve) => {
        signalOpenStarted = resolve
      })

      const runtime = makeRuntime(
        root,
        createFakeHarness({
          onOpenStart: signalOpenStarted,
          releaseOpen: releaseOpenPromise,
        }),
      )

      try {
        const artifactStore = await runtime.runPromise(Effect.gen(function* () {
          return yield* ArtifactStore
        }))
        const registry = await runtime.runPromise(Effect.gen(function* () {
          return yield* SessionRegistry
        }))

        await runtime.runPromise(
          artifactStore.writeDaemonMetadata({
            protocolVersion: PROBE_PROTOCOL_VERSION,
            startedAt: "2026-04-10T00:00:00.000Z",
            processId: 4242,
            socketPath: "/tmp/probe.sock",
            activeSessions: 0,
            sessions: [],
          }),
        )

        const openEffect = runtime.runPromise(registry.openSimulatorSession(openParams))
        await openStartedPromise

        const daemonMetadataPath = await runtime.runPromise(artifactStore.getDaemonMetadataPath())
        const openingMetadata = await waitFor(
          async () => JSON.parse(await readFile(daemonMetadataPath, "utf8")) as {
            readonly activeSessions: number
            readonly sessions: Array<{
              readonly bundleId: string
              readonly artifactRoot: string | null
              readonly state: string
            }>
          },
          (metadata) => metadata.sessions[0]?.state === "opening",
        )

        expect(openingMetadata.activeSessions).toBe(1)
        expect(openingMetadata.sessions[0]?.state).toBe("opening")
        expect(openingMetadata.sessions[0]?.bundleId).toBe("dev.probe.fixture")
        expect(typeof openingMetadata.sessions[0]?.artifactRoot).toBe("string")

        releaseOpen()

        const session = await openEffect
        await runtime.runPromise(registry.closeSession(session.sessionId))
      } finally {
        await runtime.dispose()
      }
    })
  })

  test("publishes failed session metadata when the runner exits", async () => {
    await withTempRoot(async (root) => {
      let harnessControl: FakeHarnessSessionControl | null = null

      const runtime = makeRuntime(
        root,
        createFakeHarness({
          captureSessionControl: (control) => {
            harnessControl = control
          },
        }),
      )

      try {
        const artifactStore = await runtime.runPromise(Effect.gen(function* () {
          return yield* ArtifactStore
        }))
        const registry = await runtime.runPromise(Effect.gen(function* () {
          return yield* SessionRegistry
        }))

        await runtime.runPromise(
          artifactStore.writeDaemonMetadata({
            protocolVersion: PROBE_PROTOCOL_VERSION,
            startedAt: "2026-04-10T00:00:00.000Z",
            processId: 4242,
            socketPath: "/tmp/probe.sock",
            activeSessions: 0,
            sessions: [],
          }),
        )

        const session = await runtime.runPromise(registry.openSimulatorSession(openParams))
        expect(harnessControl).not.toBeNull()
        harnessControl!.triggerExit({ code: 1, signal: null })

        const daemonMetadataPath = await runtime.runPromise(artifactStore.getDaemonMetadataPath())
        const failedMetadata = await waitFor(
          async () => JSON.parse(await readFile(daemonMetadataPath, "utf8")) as {
            readonly activeSessions: number
            readonly sessions: Array<{ readonly sessionId: string; readonly state: string; readonly warnings: ReadonlyArray<string> }>
          },
          (metadata) => metadata.sessions[0]?.state === "failed",
        )

        expect(failedMetadata.activeSessions).toBe(1)
        expect(failedMetadata.sessions[0]?.sessionId).toBe(session.sessionId)
        expect(failedMetadata.sessions[0]?.state).toBe("failed")

        const failedHealth = await runtime.runPromise(registry.getSessionHealth(session.sessionId))
        expect(failedHealth.warnings.some((warning) => warning.includes("Close and reopen the session"))).toBe(true)

        await runtime.runPromise(registry.closeSession(session.sessionId))
      } finally {
        await runtime.dispose()
      }
    })
  })

  test("passes attach-to-running mode through and reports arbitrary simulator bundle ids", async () => {
    await withTempRoot(async (root) => {
      let capturedOpenArgs: FakeHarnessOpenArgs | null = null

      const runtime = makeRuntime(
        root,
        createFakeHarness({
          captureOpenArgs: (args) => {
            capturedOpenArgs = args
          },
        }),
      )

      try {
        const registry = await runtime.runPromise(Effect.gen(function* () {
          return yield* SessionRegistry
        }))

        const session = await runtime.runPromise(registry.openSimulatorSession({
          ...openParams,
          bundleId: "com.example.notes",
          sessionMode: "attach-to-running",
        }))

        expect(capturedOpenArgs).not.toBeNull()

        if (capturedOpenArgs === null) {
          throw new Error("Expected attach-to-running open args to be captured")
        }

        const openArgs = capturedOpenArgs as FakeHarnessOpenArgs

        expect(openArgs.bundleId).toBe("com.example.notes")
        expect(openArgs.simulatorUdid).toBeNull()
        expect(openArgs.sessionMode).toBe("attach-to-running")
        expect(session.target.bundleId).toBe("com.example.notes")
        expect(
          session.capabilities.some((capability) =>
            capability.summary.includes("default test bundle")
            || capability.details.some((detail) => detail.includes("default test bundle")),
          ),
        ).toBe(false)
        expect(session.warnings.some((warning) => warning.includes("arbitrary target bundle ids"))).toBe(false)

        await runtime.runPromise(registry.closeSession(session.sessionId))
      } finally {
        await runtime.dispose()
      }
    })
  })

  test("runs attach through the LLDB bridge and persists external target state", async () => {
    await withTempRoot(async (root) => {
      const fakeBridge = createFakeLldbBridgeFactory({
        send: (request) => ({
          kind: "response",
          id: "lldb-1",
          command: String(request.command),
          ok: true,
          process: {
            pid: 4321,
            state: "stopped",
            stopId: 17,
            selectedThread: {
              threadId: 99,
              indexId: 7,
              stopReason: "signal",
              stopDescription: "signal SIGSTOP",
            },
          },
        }),
      })
      const runtime = makeRuntime(root, createFakeHarness(), {
        lldbBridgeFactory: fakeBridge.factory,
      })

      try {
        const registry = await runtime.runPromise(Effect.gen(function* () {
          return yield* SessionRegistry
        }))

        const session = await runtime.runPromise(registry.openSimulatorSession(openParams))
        const result = await runtime.runPromise(
          registry.runDebugCommand({
            sessionId: session.sessionId,
            outputMode: "auto",
            command: {
              command: "attach",
              targetScope: "external-host-process",
              pid: 4321,
            },
          }),
        )

        expect(fakeBridge.startCalls.length).toBe(1)
        expect(fakeBridge.sentRequests[0]).toMatchObject({ command: "attach", pid: 4321 })
        expect(result.summary).toBe("Attached to external host process 4321")
        expect(result.output.kind).toBe("inline")
        expect(result.debugger.attachState).toBe("attached")
        expect(result.debugger.targetScope).toBe("external-host-process")
        expect(result.debugger.attachedPid).toBe(4321)
        expect(result.debugger.processState).toBe("stopped")

        const health = await runtime.runPromise(registry.getSessionHealth(session.sessionId))
        expect(health.debugger.attachState).toBe("attached")
        expect(health.debugger.targetScope).toBe("external-host-process")
        expect(health.debugger.attachedPid).toBe(4321)

        await runtime.runPromise(registry.closeSession(session.sessionId))
      } finally {
        await runtime.dispose()
      }
    })
  })

  test("rejects non-attach debug commands before starting a bridge", async () => {
    await withTempRoot(async (root) => {
      const fakeBridge = createFakeLldbBridgeFactory()
      const runtime = makeRuntime(root, createFakeHarness(), {
        lldbBridgeFactory: fakeBridge.factory,
      })

      try {
        const registry = await runtime.runPromise(Effect.gen(function* () {
          return yield* SessionRegistry
        }))

        const session = await runtime.runPromise(registry.openSimulatorSession(openParams))
        const result = await runtime.runPromise(Effect.either(
          registry.runDebugCommand({
            sessionId: session.sessionId,
            outputMode: "auto",
            command: {
              command: "eval",
              expression: "counter + derived",
              threadIndexId: null,
              frameIndex: null,
              timeoutMs: 500,
            },
          }),
        ))

        expect(Either.isLeft(result)).toBe(true)
        expect(fakeBridge.startCalls.length).toBe(0)

        if (Either.isLeft(result)) {
          expect(result.left).toBeInstanceOf(UserInputError)
          expect((result.left as { readonly code?: string }).code).toBe("session-debug-not-attached")
        }

        await runtime.runPromise(registry.closeSession(session.sessionId))
      } finally {
        await runtime.dispose()
      }
    })
  })

  test("closes the debugger bridge when the session closes", async () => {
    await withTempRoot(async (root) => {
      const fakeBridge = createFakeLldbBridgeFactory({
        send: (request) => ({
          kind: "response",
          id: "lldb-1",
          command: String(request.command),
          ok: true,
          process: {
            pid: 4321,
            state: "stopped",
            stopId: 17,
            selectedThread: {
              threadId: 99,
              indexId: 7,
              stopReason: "signal",
              stopDescription: "signal SIGSTOP",
            },
          },
        }),
      })
      const runtime = makeRuntime(root, createFakeHarness(), {
        lldbBridgeFactory: fakeBridge.factory,
      })

      try {
        const registry = await runtime.runPromise(Effect.gen(function* () {
          return yield* SessionRegistry
        }))

        const session = await runtime.runPromise(registry.openSimulatorSession(openParams))
        const attach = await runtime.runPromise(
          registry.runDebugCommand({
            sessionId: session.sessionId,
            outputMode: "auto",
            command: {
              command: "attach",
              targetScope: "external-host-process",
              pid: 4321,
            } as any,
          }),
        )

        expect(attach.debugger.attachState).toBe("attached")
        expect(fakeBridge.closeCalls).toBe(0)

        await runtime.runPromise(registry.closeSession(session.sessionId))

        expect(fakeBridge.closeCalls).toBe(1)
      } finally {
        await runtime.dispose()
      }
    })
  })

  test("offloads debug payloads into debug/commands when artifact output is requested", async () => {
    await withTempRoot(async (root) => {
      const fakeBridge = createFakeLldbBridgeFactory({
        send: (request) => ({
          kind: "response",
          id: "lldb-1",
          command: String(request.command),
          ok: true,
          process: {
            pid: 4321,
            state: "stopped",
            stopId: 17,
            selectedThread: {
              threadId: 99,
              indexId: 7,
              stopReason: "signal",
              stopDescription: "signal SIGSTOP",
            },
          },
          metadata: {
            note: "artifact-test",
          },
        }),
      })
      const runtime = makeRuntime(root, createFakeHarness(), {
        lldbBridgeFactory: fakeBridge.factory,
      })

      try {
        const registry = await runtime.runPromise(Effect.gen(function* () {
          return yield* SessionRegistry
        }))

        const session = await runtime.runPromise(registry.openSimulatorSession(openParams))
        const result = await runtime.runPromise(
          registry.runDebugCommand({
            sessionId: session.sessionId,
            outputMode: "artifact",
            command: {
              command: "attach",
              targetScope: "external-host-process",
              pid: 4321,
            },
          }),
        )

        expect(result.output.kind).toBe("summary+artifact")

        if (result.output.kind === "summary+artifact") {
          expect(result.output.summary).toContain("artifact output was requested")
          expect(result.output.artifact.absolutePath).toContain("/debug/commands/")

          const persisted = JSON.parse(await readFile(result.output.artifact.absolutePath, "utf8")) as {
            readonly process: { readonly pid: number }
            readonly metadata: { readonly note: string }
          }
          expect(persisted.process.pid).toBe(4321)
          expect(persisted.metadata.note).toBe("artifact-test")
        }

        await runtime.runPromise(registry.closeSession(session.sessionId))
      } finally {
        await runtime.dispose()
      }
    })
  })

  test("summarizes failed bridge responses without reporting success", async () => {
    await withTempRoot(async (root) => {
      const fakeBridge = createFakeLldbBridgeFactory({
        send: (request) => {
          if (request.command === "attach") {
            return {
              kind: "response",
              id: "lldb-1",
              command: "attach",
              ok: true,
              process: {
                pid: 4321,
                state: "stopped",
                stopId: 17,
                selectedThread: {
                  threadId: 99,
                  indexId: 7,
                  stopReason: "signal",
                  stopDescription: "signal SIGSTOP",
                },
              },
            }
          }

          return {
            kind: "response",
            id: "lldb-2",
            command: String(request.command),
            ok: false,
            error: "Expression failed: boom",
          }
        },
      })
      const runtime = makeRuntime(root, createFakeHarness(), {
        lldbBridgeFactory: fakeBridge.factory,
      })

      try {
        const registry = await runtime.runPromise(Effect.gen(function* () {
          return yield* SessionRegistry
        }))

        const session = await runtime.runPromise(registry.openSimulatorSession(openParams))
        await runtime.runPromise(
          registry.runDebugCommand({
            sessionId: session.sessionId,
            outputMode: "auto",
            command: {
              command: "attach",
              targetScope: "external-host-process",
              pid: 4321,
            },
          }),
        )

        const result = await runtime.runPromise(
          registry.runDebugCommand({
            sessionId: session.sessionId,
            outputMode: "auto",
            command: {
              command: "eval",
              expression: "counter + derived",
              threadIndexId: null,
              frameIndex: null,
              timeoutMs: 500,
            },
          }),
        )

        expect(result.summary).toBe("Debug command eval failed: Expression failed: boom")
        expect(result.debugger.lastCommandOk).toBe(false)

        const health = await runtime.runPromise(registry.getSessionHealth(session.sessionId))
        expect(health.state).toBe("degraded")
        expect(health.debugger.lastCommandOk).toBe(false)

        await runtime.runPromise(registry.closeSession(session.sessionId))
      } finally {
        await runtime.dispose()
      }
    })
  })

  test("blocks runner coordination only for paused session-app targets", () => {
    const baseDebuggerState: SessionDebuggerDetails = {
      attachState: "attached",
      targetScope: "session-app",
      bridgePid: 4040,
      bridgeStartedAt: "2026-04-10T00:00:00.000Z",
      bridgeExitedAt: null,
      pythonExecutable: "/usr/bin/python3",
      lldbPythonPath: "/Applications/Xcode.app/Contents/SharedFrameworks/LLDB.framework/Resources/Python",
      lldbVersion: "lldb-1900.0.0",
      attachedPid: 101,
      processState: "stopped",
      stopId: 17,
      stopReason: "signal",
      stopDescription: "signal SIGSTOP",
      lastCommand: "attach",
      lastCommandOk: true,
      lastUpdatedAt: "2026-04-10T00:00:00.000Z",
      frameLogArtifactKey: null,
      stderrArtifactKey: null,
    }

    const pausedSessionApp = buildSessionCoordination(baseDebuggerState)
    const pausedExternalTarget = buildSessionCoordination({
      ...baseDebuggerState,
      targetScope: "external-host-process",
    })

    expect(pausedSessionApp.runnerActionsBlocked).toBe(true)
    expect(pausedSessionApp.runnerActionPolicy).toBe("blocked-by-debugger-stop")
    expect(pausedSessionApp.reason).toContain("session app paused")
    expect(pausedExternalTarget.runnerActionsBlocked).toBe(false)
    expect(pausedExternalTarget.runnerActionPolicy).toBe("normal")
    expect(pausedExternalTarget.reason).toBeNull()
  })

  test("fails closed for session health when session-app debugger stop blocks runner coordination", async () => {
    await withTempRoot(async (root) => {
      const runnerCommands: Array<FakeHarnessRunnerCommand> = []
      const fakeBridge = createFakeLldbBridgeFactory({
        send: (request) => ({
          kind: "response",
          id: "lldb-1",
          command: String(request.command),
          ok: true,
          process: {
            pid: 101,
            state: "stopped",
            stopId: 17,
            selectedThread: {
              threadId: 99,
              indexId: 7,
              stopReason: "signal",
              stopDescription: "signal SIGSTOP",
            },
          },
        }),
      })
      const runtime = makeRuntime(root, createFakeHarness({
        captureRunnerCommand: (command) => {
          runnerCommands.push(command)
        },
      }), {
        lldbBridgeFactory: fakeBridge.factory,
      })

      try {
        const registry = await runtime.runPromise(Effect.gen(function* () {
          return yield* SessionRegistry
        }))

        const session = await runtime.runPromise(registry.openSimulatorSession(openParams))
        const attach = await runtime.runPromise(
          registry.runDebugCommand({
            sessionId: session.sessionId,
            outputMode: "auto",
            command: {
              command: "attach",
              targetScope: "session-app",
              pid: 101,
            } as any,
          }),
        )

        expect(attach.coordination.runnerActionsBlocked).toBe(true)
        expect(attach.coordination.reason).toContain("session app paused")

        const pingCountBefore = runnerCommands.filter((command) => command.action === "ping").length
        const blockedHealth = await runtime.runPromise(Effect.either(registry.getSessionHealth(session.sessionId)))
        expect(Either.isLeft(blockedHealth)).toBe(true)

        if (Either.isLeft(blockedHealth)) {
          expect(blockedHealth.left).toBeInstanceOf(EnvironmentError)

          if (!(blockedHealth.left instanceof EnvironmentError)) {
            throw new Error(`Expected EnvironmentError, received ${blockedHealth.left._tag}`)
          }

          expect(blockedHealth.left.code).toBe("session-runner-actions-blocked")
          expect(blockedHealth.left.reason).toContain("session app paused")
        }

        expect(runnerCommands.filter((command) => command.action === "ping")).toHaveLength(pingCountBefore)

        await runtime.runPromise(registry.closeSession(session.sessionId))
      } finally {
        await runtime.dispose()
      }
    })
  })

  test("captures simulator log streams into logs/streams and returns buffered inline output", async () => {
    await withTempRoot(async (root) => {
      const runtime = makeRuntime(root, createFakeHarness())

      try {
        const registry = await runtime.runPromise(Effect.gen(function* () {
          return yield* SessionRegistry
        }))

        const session = await runtime.runPromise(registry.openSimulatorSession(openParams))
        const result = await runtime.runPromise(
          registry.getSessionLogs({
            sessionId: session.sessionId,
            source: "simulator",
            lineCount: 1,
            match: "beta",
            outputMode: "auto",
            captureSeconds: 2,
            predicate: null,
            process: null,
            subsystem: null,
            category: null,
          }),
        )

        expect(result.sourceArtifact.absolutePath).toContain("/logs/streams/")
        expect(result.result.kind).toBe("inline")

        if (result.result.kind === "inline") {
          expect(result.result.content).toContain("beta")
        }

        const health = await runtime.runPromise(registry.getSessionHealth(session.sessionId))
        expect(health.artifacts.some((artifact) => artifact.absolutePath.includes("/logs/streams/"))).toBe(true)

        await runtime.runPromise(registry.closeSession(session.sessionId))
      } finally {
        await runtime.dispose()
      }
    })
  })

  test("captures screenshots as png artifacts even when inline output is requested", async () => {
    await withTempRoot(async (root) => {
      const runtime = makeRuntime(root, createFakeHarness())

      try {
        const registry = await runtime.runPromise(Effect.gen(function* () {
          return yield* SessionRegistry
        }))

        const session = await runtime.runPromise(registry.openSimulatorSession(openParams))
        const result = await runtime.runPromise(
          registry.captureScreenshot({
            sessionId: session.sessionId,
            label: "hero-shot",
            outputMode: "inline",
          }),
        )

        expect(result.artifact.kind).toBe("png")
        expect(result.artifact.absolutePath).toContain("/screenshots/")
        expect(result.summary).toContain("binary image payloads")

        const screenshotBytes = await readFile(result.artifact.absolutePath)
        expect(screenshotBytes.byteLength).toBeGreaterThan(0)

        const health = await runtime.runPromise(registry.getSessionHealth(session.sessionId))
        expect(health.artifacts.some((artifact) => artifact.kind === "png")).toBe(true)

        await runtime.runPromise(registry.closeSession(session.sessionId))
      } finally {
        await runtime.dispose()
      }
    })
  })

  test("records runner video as an mp4 artifact and parses duration strings", async () => {
    await withTempRoot(async (root) => {
      const fakeFfmpegPath = await createFakeFfmpegExecutable(root)

      await withProbeFfmpegPath(fakeFfmpegPath, async () => {
        const runnerCommands: Array<FakeHarnessRunnerCommand> = []
        const runtime = makeRuntime(root, createFakeHarness({
          captureRunnerCommand: (command) => {
            runnerCommands.push(command)
          },
        }))

        try {
          const registry = await runtime.runPromise(Effect.gen(function* () {
            return yield* SessionRegistry
          }))

          const session = await runtime.runPromise(registry.openSimulatorSession(openParams))
          const result = await runtime.runPromise(registry.recordVideo({
            sessionId: session.sessionId,
            duration: "1m",
          }))

          expect(result.artifact.kind).toBe("mp4")
          expect(result.artifact.absolutePath).toContain("/video/")
          expect(result.summary).toContain("MP4 video artifact")
          expect(await readFile(result.artifact.absolutePath, "utf8")).toBe("fake mp4 data")

          const recordVideoCommand = runnerCommands.find((command) => command.action === "recordVideo")
          expect(recordVideoCommand?.payload).toBe("60000")

          await runtime.runPromise(registry.closeSession(session.sessionId))
        } finally {
          await runtime.dispose()
        }
      })
    })
  })

  test("falls back to a frame-sequence bundle when ffmpeg is unavailable", async () => {
    await withTempRoot(async (root) => {
      await withProbeFfmpegPath(join(root, "missing-ffmpeg"), async () => {
        const runtime = makeRuntime(root, createFakeHarness())

        try {
          const registry = await runtime.runPromise(Effect.gen(function* () {
            return yield* SessionRegistry
          }))

          const session = await runtime.runPromise(registry.openSimulatorSession(openParams))
          const result = await runtime.runPromise(registry.recordVideo({
            sessionId: session.sessionId,
            duration: "5s",
          }))

          expect(result.artifact.kind).toBe("directory")
          expect(result.artifact.absolutePath).toContain("/video/")
          expect(result.summary).toContain("frame-sequence video artifact")

          const bundleEntries = await readdir(result.artifact.absolutePath)
          expect(bundleEntries).toEqual(expect.arrayContaining(["frames.json", "frames.tar.gz"]))

          const manifest = JSON.parse(await readFile(join(result.artifact.absolutePath, "frames.json"), "utf8")) as {
            readonly frameCount: number
            readonly durationMs: number
            readonly archiveFile: string
          }
          expect(manifest.frameCount).toBe(1)
          expect(manifest.durationMs).toBe(5_000)
          expect(manifest.archiveFile).toBe("frames.tar.gz")

          await runtime.runPromise(registry.closeSession(session.sessionId))
        } finally {
          await runtime.dispose()
        }
      })
    })
  })

  test("captures stable snapshot artifacts and inline previews", async () => {
    await withTempRoot(async (root) => {
      const runtime = makeRuntime(root, createFakeHarness())

      try {
        const registry = await runtime.runPromise(Effect.gen(function* () {
          return yield* SessionRegistry
        }))

        const session = await runtime.runPromise(registry.openSimulatorSession(openParams))
        const first = await runtime.runPromise(
          registry.captureSnapshot({
            sessionId: session.sessionId,
            outputMode: "auto",
          }),
        )
        const second = await runtime.runPromise(
          registry.captureSnapshot({
            sessionId: session.sessionId,
            outputMode: "auto",
          }),
        )

        expect(first.artifact.kind).toBe("json")
        expect(first.artifact.absolutePath).toContain("/snapshots/")
        expect(first.preview?.kind).toBe("interactive")
        expect(second.previousSnapshotId).toBe(first.snapshotId)
        expect(second.diff.kind).toBe("unchanged")

        const persisted = JSON.parse(await readFile(first.artifact.absolutePath, "utf8")) as {
          readonly snapshotId: string
          readonly root: {
            readonly identifier: string | null
            readonly children: Array<{
              readonly identifier: string | null
              readonly children: Array<unknown>
            }>
          }
        }
        const containsIdentifier = (node: { readonly identifier: string | null; readonly children: Array<any> }, identifier: string): boolean => {
          if (node.identifier === identifier) {
            return true
          }

          return node.children.some((child) => containsIdentifier(child, identifier))
        }

        expect(persisted.snapshotId).toBe(first.snapshotId)
        expect(containsIdentifier(persisted.root, "fixture.form.applyButton")).toBe(true)

        await runtime.runPromise(registry.closeSession(session.sessionId))
      } finally {
        await runtime.dispose()
      }
    })
  })

  test("records actions, exports replayable JSON, and replays with semantic fallback", async () => {
    await withTempRoot(async (root) => {
      const runtime = makeRuntime(root, createFakeHarness())

      try {
        const registry = await runtime.runPromise(Effect.gen(function* () {
          return yield* SessionRegistry
        }))

        const firstSession = await runtime.runPromise(registry.openSimulatorSession(openParams))
        const baseline = await runtime.runPromise(
          registry.captureSnapshot({
            sessionId: firstSession.sessionId,
            outputMode: "inline",
          }),
        )
        const applyButtonRef = baseline.preview?.nodes.find((node) => node.identifier === "fixture.form.applyButton")?.ref

        if (!applyButtonRef) {
          throw new Error("Expected baseline snapshot to expose fixture.form.applyButton.")
        }

        await runtime.runPromise(
          registry.performAction({
            sessionId: firstSession.sessionId,
            action: {
              kind: "type",
              target: {
                kind: "semantic",
                identifier: "fixture.form.input",
                label: null,
                value: null,
                placeholder: null,
                type: "textField",
                section: null,
                interactive: true,
              },
              text: "delta",
              replace: true,
            },
          }),
        )

        await runtime.runPromise(
          registry.performAction({
            sessionId: firstSession.sessionId,
            action: {
              kind: "tap",
              target: {
                kind: "ref",
                ref: applyButtonRef,
                fallback: null,
              },
            },
          }),
        )

        await runtime.runPromise(
          registry.performAction({
            sessionId: firstSession.sessionId,
            action: {
              kind: "assert",
              target: {
                kind: "semantic",
                identifier: "fixture.status.label",
                label: null,
                value: null,
                placeholder: null,
                type: "staticText",
                section: null,
                interactive: false,
              },
              expectation: {
                exists: true,
                label: "Input applied: delta",
                value: null,
                type: "staticText",
                enabled: null,
                selected: null,
                focused: null,
                interactive: false,
              },
            },
          }),
        )

        const exported = await runtime.runPromise(
          registry.exportRecording({
            sessionId: firstSession.sessionId,
            label: "fixture-flow",
          }),
        )
        expect(exported.stepCount).toBe(3)

        const script = JSON.parse(await readFile(exported.artifact.absolutePath, "utf8")) as {
          readonly contract: string
          readonly steps: Array<{
            readonly kind: string
            readonly target: {
              readonly preferredRef: string | null
              readonly fallback: { readonly identifier: string | null } | null
            }
          }>
        }
        expect(script.contract).toBe("probe.action-recording/script-v1")
        expect(script.steps[1]?.target.fallback?.identifier).toBe("fixture.form.applyButton")

        const exportedScript = JSON.parse(await readFile(exported.artifact.absolutePath, "utf8")) as ActionRecordingScript
        const replayScript: ActionRecordingScript = {
          ...exportedScript,
          steps: exportedScript.steps.map((step, stepIndex) =>
            stepIndex === 1 && "target" in step
              ? {
                  ...step,
                  target: {
                    ...step.target,
                    preferredRef: "@e2",
                  },
                }
              : step,
          ),
        }

        await runtime.runPromise(registry.closeSession(firstSession.sessionId))

        const secondSession = await runtime.runPromise(registry.openSimulatorSession(openParams))
        const replayed = await runtime.runPromise(
          registry.replayRecording({
            sessionId: secondSession.sessionId,
            script: replayScript,
          }),
        )

        expect(replayed.stepCount).toBe(3)
        expect(replayed.semanticFallbackCount).toBeGreaterThanOrEqual(1)

        const afterReplay = await runtime.runPromise(
          registry.captureSnapshot({
            sessionId: secondSession.sessionId,
            outputMode: "inline",
          }),
        )
        expect(afterReplay.statusLabel).toBe("Input applied: delta")

        await runtime.runPromise(registry.closeSession(secondSession.sessionId))
      } finally {
        await runtime.dispose()
      }
    })
  })

  test("retries replay steps when the runner succeeds before exhaustion", async () => {
    await withTempRoot(async (root) => {
      let applyTapFailures = 0

      const runtime = makeRuntime(root, createFakeHarness({
        interceptUiAction: ({ kind, identifier }) => {
          if (kind === "tap" && identifier === "fixture.form.applyButton") {
            applyTapFailures += 1

            if (applyTapFailures <= 2) {
              return {
                ok: false,
                error: `fixture.form.applyButton forced retry ${applyTapFailures}`,
              }
            }
          }

          return null
        },
      }))

      try {
        const registry = await runtime.runPromise(Effect.gen(function* () {
          return yield* SessionRegistry
        }))

        const session = await runtime.runPromise(registry.openSimulatorSession(openParams))
        const replayScript: ActionRecordingScript = {
          contract: "probe.action-recording/script-v1",
          recordedAt: "2026-04-10T00:00:00.000Z",
          sessionId: null,
          bundleId: "dev.probe.fixture",
          steps: [
            {
              kind: "type",
              target: {
                preferredRef: null,
                fallback: {
                  kind: "semantic",
                  identifier: "fixture.form.input",
                  label: null,
                  value: null,
                  placeholder: null,
                  type: "textField",
                  section: null,
                  interactive: true,
                },
                description: "fixture.form.input (textField)",
              },
              text: "delta",
              replace: true,
            },
            {
              kind: "tap",
              target: {
                preferredRef: null,
                fallback: {
                  kind: "semantic",
                  identifier: "fixture.form.applyButton",
                  label: null,
                  value: null,
                  placeholder: null,
                  type: "button",
                  section: null,
                  interactive: true,
                },
                description: "fixture.form.applyButton (button)",
              },
            },
            {
              kind: "assert",
              target: {
                preferredRef: null,
                fallback: {
                  kind: "semantic",
                  identifier: "fixture.status.label",
                  label: null,
                  value: null,
                  placeholder: null,
                  type: "staticText",
                  section: null,
                  interactive: false,
                },
                description: "fixture.status.label (staticText)",
              },
              expectation: {
                exists: true,
                label: "Input applied: delta",
                value: null,
                type: "staticText",
                enabled: null,
                selected: null,
                focused: null,
                interactive: false,
              },
            },
          ],
        }

        const replayed = await runtime.runPromise(registry.replayRecording({
          sessionId: session.sessionId,
          script: replayScript,
        }))

        expect(replayed.stepCount).toBe(3)
        expect(replayed.retriedStepCount).toBe(1)

        const report = JSON.parse(await readFile(replayed.artifact.absolutePath, "utf8")) as ReplayReport
        expect(report.status).toBe("succeeded")
        expect(report.failure).toBeNull()
        expect(report.steps[1]?.attempts).toBe(3)
        expect(report.warnings.some((warning) => warning.includes("Offscreen targets must already be hittable"))).toBe(true)

        const afterReplay = await runtime.runPromise(
          registry.captureSnapshot({
            sessionId: session.sessionId,
            outputMode: "inline",
          }),
        )
        expect(afterReplay.statusLabel).toBe("Input applied: delta")

        await runtime.runPromise(registry.closeSession(session.sessionId))
      } finally {
        await runtime.dispose()
      }
    })
  })

  test("records screenshot and video artifact refs in replay reports", async () => {
    await withTempRoot(async (root) => {
      const fakeFfmpegPath = await createFakeFfmpegExecutable(root)

      await withProbeFfmpegPath(fakeFfmpegPath, async () => {
        const runtime = makeRuntime(root, createFakeHarness())

        try {
          const registry = await runtime.runPromise(Effect.gen(function* () {
            return yield* SessionRegistry
          }))

          const session = await runtime.runPromise(registry.openSimulatorSession(openParams))
          const replayScript: ActionRecordingScript = {
            contract: "probe.action-recording/script-v1",
            recordedAt: "2026-04-10T00:00:00.000Z",
            sessionId: null,
            bundleId: "dev.probe.fixture",
            steps: [
              { kind: "screenshot" },
              { kind: "video", durationMs: 5_000 },
            ],
          }

          const replayed = await runtime.runPromise(registry.replayRecording({
            sessionId: session.sessionId,
            script: replayScript,
          }))

          expect(replayed.stepCount).toBe(2)

          const report = JSON.parse(await readFile(replayed.artifact.absolutePath, "utf8")) as ReplayReport
          expect(report.status).toBe("succeeded")
          expect(report.steps[0]?.artifact?.kind).toBe("png")
          expect(report.steps[0]?.artifact?.absolutePath).toContain("/screenshots/step-001-screenshot.png")
          expect(report.steps[1]?.artifact?.kind).toBe("mp4")
          expect(report.steps[1]?.artifact?.absolutePath).toContain("/video/step-002-video.mp4")
        } finally {
          await runtime.dispose()
        }
      })
    })
  })

  test("writes replay failure artifacts when retries are exhausted", async () => {
    await withTempRoot(async (root) => {
      const runtime = makeRuntime(root, createFakeHarness({
        interceptUiAction: ({ kind, identifier }) => {
          if (kind === "tap" && identifier === "fixture.problem.offscreenButton") {
            return {
              ok: false,
              error: "Expected fixture.problem.offscreenButton to be hittable before tap. Replay does not auto-scroll target into view.",
            }
          }

          return null
        },
      }))

      try {
        const registry = await runtime.runPromise(Effect.gen(function* () {
          return yield* SessionRegistry
        }))

        const session = await runtime.runPromise(registry.openSimulatorSession(openParams))
        const replayScript: ActionRecordingScript = {
          contract: "probe.action-recording/script-v1",
          recordedAt: "2026-04-10T00:00:00.000Z",
          sessionId: null,
          bundleId: "dev.probe.fixture",
          steps: [
            {
              kind: "tap",
              target: {
                preferredRef: null,
                fallback: {
                  kind: "semantic",
                  identifier: "fixture.problem.offscreenButton",
                  label: null,
                  value: null,
                  placeholder: null,
                  type: "button",
                  section: null,
                  interactive: true,
                },
                description: "fixture.problem.offscreenButton (button)",
              },
            },
          ],
        }

        const replayResult = await runtime.runPromise(Effect.either(registry.replayRecording({
          sessionId: session.sessionId,
          script: replayScript,
        })))

        expect(Either.isLeft(replayResult)).toBe(true)

        if (!Either.isLeft(replayResult)) {
          throw new Error("Expected replay to fail after exhausting retries.")
        }

        expect(replayResult.left).toBeInstanceOf(EnvironmentError)

        if (!(replayResult.left instanceof EnvironmentError)) {
          throw new Error(`Expected EnvironmentError, received ${String(replayResult.left)}`)
        }

        expect(replayResult.left.code).toBe("session-replay-step-failed")
        expect(replayResult.left.reason).toContain("after 3 attempts")
        expect(replayResult.left.nextStep).toContain("auto-scroll")

        const reportDetail = replayResult.left.details.find((detail) => detail.startsWith("replay report artifact: "))

        if (!reportDetail) {
          throw new Error("Expected replay failure to include a replay report artifact path.")
        }

        const reportPath = reportDetail.replace("replay report artifact: ", "")
        const report = JSON.parse(await readFile(reportPath, "utf8")) as ReplayReport
        expect(report.status).toBe("failed")
        expect(report.failure?.index).toBe(1)
        expect(report.failure?.attempts).toBe(3)
        expect(report.failure?.reason).toContain("hittable")
        expect(report.warnings.some((warning) => warning.includes("Offscreen targets must already be hittable"))).toBe(true)

        await runtime.runPromise(registry.closeSession(session.sessionId))
      } finally {
        await runtime.dispose()
      }
    })
  })

  test("keeps daemon.json active session metadata in sync", async () => {
    await withTempRoot(async (root) => {
      const runtime = makeRuntime(root, createFakeHarness())

      try {
        const artifactStore = await runtime.runPromise(Effect.gen(function* () {
          return yield* ArtifactStore
        }))
        const registry = await runtime.runPromise(Effect.gen(function* () {
          return yield* SessionRegistry
        }))

        await runtime.runPromise(
          artifactStore.writeDaemonMetadata({
            protocolVersion: PROBE_PROTOCOL_VERSION,
            startedAt: "2026-04-10T00:00:00.000Z",
            processId: 4242,
            socketPath: "/tmp/probe.sock",
            activeSessions: 0,
            sessions: [],
          }),
        )

        const session = await runtime.runPromise(registry.openSimulatorSession(openParams))
        const daemonMetadataPath = await runtime.runPromise(artifactStore.getDaemonMetadataPath())
        const openedMetadata = JSON.parse(await readFile(daemonMetadataPath, "utf8")) as {
          readonly activeSessions: number
          readonly sessions: Array<{ readonly sessionId: string; readonly state: string; readonly bundleId: string }>
        }

        expect(openedMetadata.activeSessions).toBe(1)
        expect(openedMetadata.sessions.length).toBe(1)
        expect(openedMetadata.sessions[0]?.sessionId).toBe(session.sessionId)
        expect(openedMetadata.sessions[0]?.state).toBe("ready")
        expect(openedMetadata.sessions[0]?.bundleId).toBe("dev.probe.fixture")

        await runtime.runPromise(registry.closeSession(session.sessionId))

        const closedMetadata = JSON.parse(await readFile(daemonMetadataPath, "utf8")) as {
          readonly activeSessions: number
          readonly sessions: Array<unknown>
        }

        expect(closedMetadata.activeSessions).toBe(0)
        expect(closedMetadata.sessions).toEqual([])
      } finally {
        await runtime.dispose()
      }
    })
  })

  test("opens a ready real-device live session with runner and perf support", async () => {
    await withTempRoot(async (root) => {
      const runtime = makeRuntime(root, createFakeHarness(), {
        realDeviceHarness: createFakeRealDeviceHarness(),
      })

      try {
        const registry = await runtime.runPromise(Effect.gen(function* () {
          return yield* SessionRegistry
        }))

        const session = await runtime.runPromise(registry.openDeviceSession(deviceOpenParams))

        expect(session.state).toBe("ready")
        expect(session.target.platform).toBe("device")
        expect(session.connection.status).toBe("connected")
        expect(session.resources.runner).toBe("ready")
        expect(session.transport.kind).toBe("real-device-live")
        expect(session.runner.kind).toBe("real-device-live")

        const realDeviceCapability = session.capabilities.find((capability) => capability.area === "real-device")
        const simulatorCapability = session.capabilities.find((capability) => capability.area === "simulator")
        const runnerCapability = session.capabilities.find((capability) => capability.area === "runner")
        const perfCapability = session.capabilities.find((capability) => capability.area === "perf")

        expect(realDeviceCapability?.status).toBe("supported")
        expect(simulatorCapability?.status).toBe("unsupported")
        expect(runnerCapability?.status).toBe("supported")
        expect(perfCapability?.status).toBe("supported")

        await runtime.runPromise(registry.closeSession(session.sessionId))
      } finally {
        await runtime.dispose()
      }
    })
  })

  test("tracks real-device disconnects and reconnects in session health", async () => {
    await withTempRoot(async (root) => {
      const runtime = makeRuntime(root, createFakeHarness(), {
        realDeviceHarness: createFakeRealDeviceHarness({
          connectionStates: ["connected", "disconnected", "connected"],
        }),
      })

      try {
        const registry = await runtime.runPromise(Effect.gen(function* () {
          return yield* SessionRegistry
        }))

        const session = await runtime.runPromise(registry.openDeviceSession(deviceOpenParams))
        const firstHealth = await runtime.runPromise(registry.getSessionHealth(session.sessionId))
        const secondHealth = await runtime.runPromise(registry.getSessionHealth(session.sessionId))
        const thirdHealth = await runtime.runPromise(registry.getSessionHealth(session.sessionId))

        expect(firstHealth.connection.status).toBe("connected")
        expect(secondHealth.connection.status).toBe("disconnected")
        expect(secondHealth.state).toBe("degraded")
        expect(secondHealth.warnings.some((warning) => warning.includes("currently disconnected"))).toBe(true)
        expect(thirdHealth.connection.status).toBe("connected")
        expect(thirdHealth.warnings.some((warning) => warning.includes("currently disconnected"))).toBe(false)

        await runtime.runPromise(registry.closeSession(session.sessionId))
      } finally {
        await runtime.dispose()
      }
    })
  })

  test("fails fast when real-device preflight reports a missing prerequisite", async () => {
    await withTempRoot(async (root) => {
      const runtime = makeRuntime(root, createFakeHarness(), {
        realDeviceHarness: createFakeRealDeviceHarness({
          failWith: new EnvironmentError({
            code: "device-not-found",
            reason: "No connected real device was found on this host.",
            nextStep: "Connect a paired device and retry.",
            details: [],
          }),
        }),
      })

      try {
        const registry = await runtime.runPromise(Effect.gen(function* () {
          return yield* SessionRegistry
        }))

        const result = await runtime.runPromise(Effect.either(registry.openDeviceSession(deviceOpenParams)))
        expect(Either.isLeft(result)).toBe(true)

        if (Either.isLeft(result)) {
          expect(result.left).toBeInstanceOf(EnvironmentError)

          if (!(result.left instanceof EnvironmentError)) {
            throw new Error(`Expected EnvironmentError, received ${String(result.left)}`)
          }

          expect(result.left.code).toBe("device-not-found")
        }
      } finally {
        await runtime.dispose()
      }
    })
  })

  test("fails closed with stale-session guidance when a persisted session is no longer live", async () => {
    await withTempRoot(async (root) => {
      const runtime = makeRuntime(root, createFakeHarness())

      try {
        const artifactStore = await runtime.runPromise(Effect.gen(function* () {
          return yield* ArtifactStore
        }))
        const registry = await runtime.runPromise(Effect.gen(function* () {
          return yield* SessionRegistry
        }))

        await runtime.runPromise(
          artifactStore.writeSessionManifest("stale-session", {
            sessionId: "stale-session",
            state: "ready",
            artifactRoot: join(root, "sessions", "stale-session"),
          }),
        )

        const result = await runtime.runPromise(Effect.either(registry.getSessionHealth("stale-session")))
        expect(Either.isLeft(result)).toBe(true)

        if (Either.isLeft(result)) {
          expect(result.left).toBeInstanceOf(SessionNotFoundError)
          expect(result.left.nextStep).toContain("does not recover live sessions across daemon restarts or transport loss")
        }
      } finally {
        await runtime.dispose()
      }
    })
  })
})
