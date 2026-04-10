import { spawn, type ChildProcess } from "node:child_process"
import { access, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { Context, Effect, Layer } from "effect"
import {
  ChildProcessError,
  EnvironmentError,
  UnsupportedCapabilityError,
  UserInputError,
} from "../domain/errors"
import {
  decodeRunnerReadyFrame,
  decodeRunnerResponseFrame,
  decodeRunnerStdinProbeResultFrame,
  encodeRunnerCommandFrame,
  RUNNER_COMMAND_INGRESS,
  RUNNER_EVENT_EGRESS,
  RUNNER_TRANSPORT_CONTRACT,
  type RunnerReadyFrame,
  type RunnerResponseFrame,
  type RunnerStdinProbeResultFrame,
} from "./runnerProtocol"

const fixtureBundleId = "dev.probe.fixture"
const commandPollIntervalMs = 50
const commandTimeoutMs = 20_000
const runnerReadyTimeoutMs = 120_000
const runnerBootstrapRootPath = "/tmp/probe-runner-bootstrap"
const runnerTransportContract = RUNNER_TRANSPORT_CONTRACT
const runnerCommandIngress = RUNNER_COMMAND_INGRESS
const runnerEventEgress = RUNNER_EVENT_EGRESS

const timestampForFile = (): string => new Date().toISOString().replace(/[:.]/g, "-")

const sanitizeFileComponent = (value: string | null | undefined, fallback: string): string => {
  const sanitized = (value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")

  return sanitized.length > 0 ? sanitized : fallback
}

interface SimctlListDevice {
  readonly udid: string
  readonly name: string
  readonly isAvailable?: boolean
}

interface SimctlListPayload {
  readonly devices?: Record<string, ReadonlyArray<SimctlListDevice>>
}

type ReadyFrame = RunnerReadyFrame
type ResponseFrame = RunnerResponseFrame
type StdinProbeResultFrame = RunnerStdinProbeResultFrame

export interface RunnerCommandResult {
  readonly ok: boolean
  readonly action: string
  readonly error: string | null
  readonly payload: string | null
  readonly snapshotPayloadPath: string | null
  readonly handledMs: number
  readonly statusLabel: string
  readonly snapshotNodeCount: number | null
  readonly hostRttMs: number
}

export interface OpenedFixtureSession {
  readonly simulator: {
    readonly udid: string
    readonly name: string
    readonly runtime: string
  }
  readonly bundleId: string
  readonly fixtureProcessId: number
  readonly wrapperProcessId: number
  readonly testProcessId: number
  readonly attachLatencyMs: number
  readonly bootstrapPath: string
  readonly bootstrapSource: "simulator-bootstrap-manifest"
  readonly runnerTransportContract: typeof runnerTransportContract
  readonly sessionIdentifier: string
  readonly commandIngress: typeof runnerCommandIngress
  readonly eventEgress: typeof runnerEventEgress
  readonly runtimeControlDirectory: string
  readonly observerControlDirectory: string
  readonly logPath: string
  readonly buildLogPath: string
  readonly stdoutEventsPath: string
  readonly resultBundlePath: string
  readonly wrapperStderrPath: string
  readonly stdinProbeStatus: string
  readonly initialPingRttMs: number
  readonly nextSequence: number
  readonly sendCommand: (
    sequence: number,
    action: "ping" | "applyInput" | "snapshot" | "shutdown" | "uiAction",
    payload?: string,
  ) => Promise<RunnerCommandResult>
  readonly isWrapperRunning: () => boolean
  readonly waitForExit: Promise<{ readonly code: number | null; readonly signal: string | null }>
  readonly close: () => Promise<void>
}

interface RunnerBootstrapManifest {
  readonly contractVersion: typeof runnerTransportContract
  readonly controlDirectoryPath: string
  readonly egressTransport: typeof runnerEventEgress
  readonly generatedAt: string
  readonly ingressTransport: typeof runnerCommandIngress
  readonly sessionIdentifier: string
  readonly simulatorUdid: string
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

const fileExists = async (path: string): Promise<boolean> => {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

const readLastLines = async (path: string, maxLines: number): Promise<string> => {
  if (!(await fileExists(path))) {
    return ""
  }

  const content = await readFile(path, "utf8")
  return content.split(/\r?\n/).slice(-maxLines).join("\n")
}

const ensureDirectory = async (path: string): Promise<void> => {
  await mkdir(path, { recursive: true })
}

const writeBootstrapManifest = async (args: {
  readonly bootstrapPath: string
  readonly controlDirectoryPath: string
  readonly sessionIdentifier: string
  readonly simulatorUdid: string
}): Promise<void> => {
  const manifest: RunnerBootstrapManifest = {
    contractVersion: runnerTransportContract,
    controlDirectoryPath: args.controlDirectoryPath,
    egressTransport: runnerEventEgress,
    generatedAt: new Date().toISOString(),
    ingressTransport: runnerCommandIngress,
    sessionIdentifier: args.sessionIdentifier,
    simulatorUdid: args.simulatorUdid,
  }

  await ensureDirectory(dirname(args.bootstrapPath))
  await writeFile(args.bootstrapPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8")
}

const removeFileIfExists = async (path: string): Promise<void> => {
  await rm(path, { force: true }).catch(() => undefined)
}

const processExists = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return !(error instanceof Error && "code" in error && error.code === "ESRCH")
  }
}

const runCommandWithExit = async (args: {
  readonly command: string
  readonly commandArgs: ReadonlyArray<string>
}): Promise<{ readonly stdout: string; readonly stderr: string; readonly exitCode: number | null }> =>
  await new Promise((resolve, reject) => {
    const child = spawn(args.command, [...args.commandArgs], {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    })

    let stdout = ""
    let stderr = ""

    child.stdout?.setEncoding("utf8")
    child.stderr?.setEncoding("utf8")
    child.stdout?.on("data", (chunk) => {
      stdout += chunk
    })
    child.stderr?.on("data", (chunk) => {
      stderr += chunk
    })

    child.once("error", reject)
    child.once("close", (exitCode) => {
      resolve({ stdout, stderr, exitCode })
    })
  })

const inspectProcess = async (pid: number): Promise<{
  readonly exists: boolean
  readonly command: string | null
  readonly processGroupId: number | null
}> => {
  const result = await runCommandWithExit({
    command: "/bin/ps",
    commandArgs: ["-o", "pgid=", "-o", "command=", "-p", String(pid)],
  })

  if (result.exitCode !== 0) {
    return {
      exists: false,
      command: null,
      processGroupId: null,
    }
  }

  const output = result.stdout.trim()
  const match = output.match(/^(\d+)\s+(.*)$/s)

  if (!match) {
    return {
      exists: true,
      command: output.length > 0 ? output : null,
      processGroupId: null,
    }
  }

  return {
    exists: true,
    processGroupId: Number(match[1]),
    command: match[2].trim(),
  }
}

const isRunnerWrapperCommand = (command: string | null): boolean =>
  command?.includes("run-transport-boundary-session.py") ?? false

const killRunnerTarget = (pid: number, processGroupId: number | null, signal: NodeJS.Signals): void => {
  if (processGroupId !== null && processGroupId === pid) {
    process.kill(-processGroupId, signal)
    return
  }

  process.kill(pid, signal)
}

const waitForProcessExit = async (pid: number, timeoutMs: number): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    if (!processExists(pid)) {
      return true
    }

    await sleep(100)
  }

  return !processExists(pid)
}

const terminateRunnerProcess = async (pid: number): Promise<{
  readonly summary: string
  readonly details: ReadonlyArray<string>
}> => {
  const inspection = await inspectProcess(pid)

  if (!inspection.exists) {
    return {
      summary: `No live runner wrapper process was found for pid ${pid}.`,
      details: [`pid ${pid} was already gone before cleanup started.`],
    }
  }

  if (!isRunnerWrapperCommand(inspection.command)) {
    return {
      summary: `Skipped pid ${pid} because it no longer looks like a Probe runner wrapper.`,
      details: [inspection.command ? `unexpected command: ${inspection.command}` : "command line was unavailable during inspection."],
    }
  }

  const targetDescription = inspection.processGroupId === pid
    ? `process group ${inspection.processGroupId}`
    : `pid ${pid}`

  try {
    killRunnerTarget(pid, inspection.processGroupId, "SIGTERM")
  } catch {
    return {
      summary: `Failed to signal stale runner wrapper ${targetDescription}.`,
      details: [inspection.command ?? "command line unavailable"],
    }
  }

  if (await waitForProcessExit(pid, 2_000)) {
    return {
      summary: `Reaped stale runner wrapper via ${targetDescription}.`,
      details: [inspection.command ?? "command line unavailable"],
    }
  }

  try {
    killRunnerTarget(pid, inspection.processGroupId, "SIGKILL")
  } catch {
    return {
      summary: `Timed out stopping stale runner wrapper ${targetDescription}.`,
      details: [inspection.command ?? "command line unavailable"],
    }
  }

  await waitForProcessExit(pid, 1_000)

  return {
    summary: processExists(pid)
      ? `Probe escalated to SIGKILL for stale runner wrapper ${targetDescription}, but the process still appears live.`
      : `Reaped stale runner wrapper ${targetDescription} after SIGKILL escalation.`,
    details: [inspection.command ?? "command line unavailable"],
  }
}

const waitForFreshJson = async <T>(args: {
  readonly path: string
  readonly timeoutMs: number
  readonly minMtimeMs: number
  readonly isRunning: () => boolean
  readonly decode: (value: unknown) => T
  readonly invalidCode: string
  readonly invalidReason: string
  readonly invalidNextStep: string
  readonly commandDescription: string
  readonly logPath: string
}): Promise<T> => {
  const deadline = Date.now() + args.timeoutMs

  while (Date.now() < deadline) {
    if (await fileExists(args.path)) {
      const info = await stat(args.path)

      if (info.mtimeMs >= args.minMtimeMs) {
        try {
          return args.decode(JSON.parse(await readFile(args.path, "utf8")) as unknown)
        } catch (error) {
          throw new EnvironmentError({
            code: args.invalidCode,
            reason: `${args.invalidReason}: ${error instanceof Error ? error.message : String(error)}`,
            nextStep: args.invalidNextStep,
            details: [args.path],
          })
        }
      }
    }

    if (!args.isRunning()) {
      throw new ChildProcessError({
        code: "runner-exited-early",
        command: args.commandDescription,
        reason: `The runner process exited before ${args.path} became available.`,
        nextStep: "Inspect the xcodebuild session log artifact for the failing runner step.",
        exitCode: null,
        stderrExcerpt: await readLastLines(args.logPath, 80),
      })
    }

    await sleep(commandPollIntervalMs)
  }

  throw new ChildProcessError({
    code: "runner-timeout",
    command: args.commandDescription,
    reason: `Timed out waiting for ${args.path}.`,
    nextStep: "Inspect the xcodebuild session log artifact and retry the session open.",
    exitCode: null,
    stderrExcerpt: await readLastLines(args.logPath, 80),
  })
}

const runCommand = async (args: {
  readonly command: string
  readonly commandArgs: ReadonlyArray<string>
  readonly logPath?: string
}): Promise<{ readonly stdout: string; readonly stderr: string }> =>
  await new Promise<{ readonly stdout: string; readonly stderr: string }>((resolve, reject) => {
    const child = spawn(args.command, [...args.commandArgs], {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    })

    let stdout = ""
    let stderr = ""

    child.stdout?.setEncoding("utf8")
    child.stderr?.setEncoding("utf8")
    child.stdout?.on("data", (chunk) => {
      stdout += chunk
    })
    child.stderr?.on("data", (chunk) => {
      stderr += chunk
    })

    child.once("error", (error) => reject(error))
    child.once("close", async (code) => {
      if (args.logPath) {
        await ensureDirectory(dirname(args.logPath))
      }

      if (args.logPath) {
        await writeFile(args.logPath, `${stdout}${stderr}`, "utf8")
      }

      if (code === 0) {
        resolve({ stdout, stderr })
        return
      }

      reject(
        new ChildProcessError({
          code: "command-failed",
          command: `${args.command} ${args.commandArgs.join(" ")}`,
          reason: `${args.command} exited with code ${code ?? "unknown"}.`,
          nextStep: args.logPath
            ? `Inspect the log at ${args.logPath} and retry.`
            : `Inspect stderr output and retry ${args.command}.`,
          exitCode: code,
          stderrExcerpt: `${stdout}${stderr}`.split(/\r?\n/).slice(-80).join("\n"),
        }),
      )
    })
  })

const runCommandWithCapturedStdout = async (args: {
  readonly command: string
  readonly commandArgs: ReadonlyArray<string>
  readonly stdoutPath: string
}): Promise<{ readonly stdout: string; readonly stderr: string }> => {
  await ensureDirectory(dirname(args.stdoutPath))

  return await new Promise<{ readonly stdout: string; readonly stderr: string }>((resolve, reject) => {
    const child = spawn(args.command, [...args.commandArgs], {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    })

    let stdout = ""
    let stderr = ""

    child.stdout?.setEncoding("utf8")
    child.stderr?.setEncoding("utf8")
    child.stdout?.on("data", (chunk) => {
      stdout += chunk
    })
    child.stderr?.on("data", (chunk) => {
      stderr += chunk
    })

    child.once("error", reject)
    child.once("close", async (code) => {
      await writeFile(args.stdoutPath, stdout, "utf8")

      if (code === 0) {
        resolve({ stdout, stderr })
        return
      }

      reject(
        new ChildProcessError({
          code: "command-failed",
          command: `${args.command} ${args.commandArgs.join(" ")}`,
          reason: `${args.command} exited with code ${code ?? "unknown"}.`,
          nextStep: `Inspect the log capture at ${args.stdoutPath} and retry.`,
          exitCode: code,
          stderrExcerpt: stderr.split(/\r?\n/).slice(-80).join("\n"),
        }),
      )
    })
  })
}

const parseFixtureProcessId = (stdout: string): number => {
  const match = stdout.match(/:\s*(\d+)\s*$/)

  if (!match) {
    throw new EnvironmentError({
      code: "fixture-launch-pid-parse",
      reason: `Could not parse a fixture process id from simctl output: ${stdout}`,
      nextStep: "Inspect the simctl launch output and retry the session open.",
      details: [],
    })
  }

  return Number(match[1])
}

const assertReadyTransportContract = (args: {
  readonly ready: ReadyFrame
  readonly expectedControlDirectoryPath: string
  readonly expectedSessionIdentifier: string
  readonly simulatorUdid: string
}): void => {
  const expectedBootstrapPath = join(runnerBootstrapRootPath, `${args.simulatorUdid}.json`)

  if (args.ready.runnerTransportContract !== runnerTransportContract) {
    throw new EnvironmentError({
      code: "runner-transport-contract-mismatch",
      reason:
        `Expected runner transport contract ${runnerTransportContract}, received ${args.ready.runnerTransportContract}.`,
      nextStep: "Inspect the runner ready frame and align the host/runtime transport contract before retrying.",
      details: [],
    })
  }

  if (args.ready.bootstrapSource !== "simulator-bootstrap-manifest") {
    throw new EnvironmentError({
      code: "runner-bootstrap-source-mismatch",
      reason:
        `Expected bootstrap source simulator-bootstrap-manifest, received ${args.ready.bootstrapSource}.`,
      nextStep: "Inspect the runner bootstrap resolution path and remove stale fallback behavior before retrying.",
      details: [],
    })
  }

  if (args.ready.bootstrapPath !== expectedBootstrapPath) {
    throw new EnvironmentError({
      code: "runner-bootstrap-path-mismatch",
      reason: `Expected bootstrap path ${expectedBootstrapPath}, received ${args.ready.bootstrapPath}.`,
      nextStep: "Inspect the host bootstrap manifest path and runner bootstrap resolution logic before retrying.",
      details: [],
    })
  }

  if (args.ready.ingressTransport !== runnerCommandIngress || args.ready.egressTransport !== runnerEventEgress) {
    throw new EnvironmentError({
      code: "runner-transport-shape-mismatch",
      reason:
        `Expected ingress ${runnerCommandIngress} and egress ${runnerEventEgress}, received ${args.ready.ingressTransport} / ${args.ready.egressTransport}.`,
      nextStep: "Inspect the runner ready frame and align the host/runtime transport seam before retrying.",
      details: [],
    })
  }

  if (args.ready.simulatorUdid !== args.simulatorUdid) {
    throw new EnvironmentError({
      code: "runner-simulator-mismatch",
      reason: `Expected runner simulator UDID ${args.simulatorUdid}, received ${args.ready.simulatorUdid}.`,
      nextStep: "Inspect the simulator bootstrap manifest contents and retry the session open.",
      details: [],
    })
  }

  if (!args.ready.sessionIdentifier) {
    throw new EnvironmentError({
      code: "runner-session-identifier-missing",
      reason: "The runner ready frame did not report a session identifier for the active bootstrap manifest.",
      nextStep: "Inspect the bootstrap manifest and runner ready frame serialization before retrying.",
      details: [],
    })
  }

  if (args.ready.sessionIdentifier !== args.expectedSessionIdentifier) {
    throw new EnvironmentError({
      code: "runner-session-identifier-mismatch",
      reason:
        `Expected runner session identifier ${args.expectedSessionIdentifier}, received ${args.ready.sessionIdentifier}.`,
      nextStep: "Inspect the bootstrap manifest session identifier and retry the session open.",
      details: [],
    })
  }

  if (args.ready.controlDirectoryPath !== args.expectedControlDirectoryPath) {
    throw new EnvironmentError({
      code: "runner-control-directory-mismatch",
      reason:
        `Expected runner control directory ${args.expectedControlDirectoryPath}, received ${args.ready.controlDirectoryPath}.`,
      nextStep: "Inspect the bootstrap manifest control directory and retry the session open.",
      details: [],
    })
  }
}

const startWrapperProcess = async (args: {
  readonly rootDir: string
  readonly projectPath: string
  readonly observerControlDirectory: string
  readonly wrapperStderrPath: string
  readonly logPath: string
  readonly stdoutEventsPath: string
  readonly derivedDataPath: string
  readonly simulatorUdid: string
  readonly resultBundlePath: string
}): Promise<{
  readonly process: ChildProcess
  readonly exit: Promise<{ readonly code: number | null; readonly signal: string | null }>
}> => {
  await ensureDirectory(args.observerControlDirectory)
  await ensureDirectory(dirname(args.wrapperStderrPath))

  const wrapperScript = join(
    args.rootDir,
    "ios",
    "ProbeRunner",
    "scripts",
    "run-transport-boundary-session.py",
  )

  const child = spawn(
    "/usr/bin/python3",
    [
      wrapperScript,
      "--control-dir",
      args.observerControlDirectory,
      "--log-path",
      args.logPath,
      "--stdout-events-path",
      args.stdoutEventsPath,
      "--stdin-probe-payload",
      "probe-daemon-session",
      "--",
      "xcodebuild",
      "-project",
      args.projectPath,
      "-scheme",
      "ProbeRunner",
      "-destination",
      `platform=iOS Simulator,id=${args.simulatorUdid}`,
      "-derivedDataPath",
      args.derivedDataPath,
      "-resultBundlePath",
      args.resultBundlePath,
      "CODE_SIGNING_ALLOWED=NO",
      "test-without-building",
      "-only-testing:ProbeRunnerUITests/AttachControlSpikeUITests/testCommandLoopTransportBoundary",
    ],
    {
      cwd: args.rootDir,
      detached: true,
      stdio: ["ignore", "ignore", "pipe"],
    },
  )

  child.stderr?.setEncoding("utf8")

  const stderrChunks: Array<string> = []
  child.stderr?.on("data", (chunk) => {
    stderrChunks.push(String(chunk))
    void writeFile(args.wrapperStderrPath, stderrChunks.join(""), "utf8")
  })

  const exit = new Promise<{ readonly code: number | null; readonly signal: string | null }>(
    (resolve, reject) => {
      child.once("error", reject)
      child.once("exit", (code, signal) => resolve({ code, signal }))
    },
  )

  return {
    process: child,
    exit,
  }
}

const stopWrapperProcess = async (wrapper: {
  readonly process: ChildProcess
  readonly exit: Promise<{ readonly code: number | null; readonly signal: string | null }>
}): Promise<void> => {
  const pid = wrapper.process.pid

  if (pid === undefined || wrapper.process.exitCode !== null || wrapper.process.killed) {
    return
  }

  await terminateRunnerProcess(pid)
  await Promise.race([wrapper.exit, sleep(1_000)])
}

export class SimulatorHarness extends Context.Tag("@probe/SimulatorHarness")<
  SimulatorHarness,
  {
    readonly openFixtureSession: (args: {
      readonly rootDir: string
      readonly sessionId: string
      readonly artifactRoot: string
      readonly runnerDirectory: string
      readonly logsDirectory: string
      readonly bundleId: string
      readonly simulatorUdid: string | null
    }) => Effect.Effect<OpenedFixtureSession, EnvironmentError | UserInputError | UnsupportedCapabilityError | ChildProcessError>
    readonly captureSimulatorLogStream: (args: {
      readonly simulatorUdid: string
      readonly logsDirectory: string
      readonly captureSeconds: number
      readonly predicate: string | null
    }) => Effect.Effect<{ readonly absolutePath: string }, EnvironmentError | ChildProcessError>
    readonly reapStaleRunnerSession: (args: {
      readonly sessionId: string
      readonly wrapperProcessId: number | null
      readonly bootstrapPath: string | null
    }) => Effect.Effect<{
      readonly summary: string
      readonly details: ReadonlyArray<string>
    }, EnvironmentError>
    readonly captureScreenshot: (args: {
      readonly simulatorUdid: string
      readonly screenshotsDirectory: string
      readonly label: string | null
    }) => Effect.Effect<{ readonly absolutePath: string }, EnvironmentError | ChildProcessError>
  }
>() {}

export const SimulatorHarnessLive = Layer.succeed(
  SimulatorHarness,
  SimulatorHarness.of({
    openFixtureSession: (args) => {
      let wrapper: Awaited<ReturnType<typeof startWrapperProcess>> | null = null
      let bootstrapPath: string | null = null

      return Effect.tryPromise({
        try: async () => {
          try {
            if (args.bundleId !== fixtureBundleId) {
              throw new UnsupportedCapabilityError({
                code: "fixture-only-bundle-id",
                capability: "session.open.bundle-id",
                reason: `The current vertical slice only supports the fixture bundle id ${fixtureBundleId}.`,
                nextStep:
                  "Open the fixture-backed session with the default bundle id, or extend the runner target before requesting arbitrary app sessions.",
                details: [],
                wall: false,
              })
            }

            const projectPath = join(args.rootDir, "ios", "ProbeFixture", "ProbeFixture.xcodeproj")
            const buildLogPath = join(args.logsDirectory, "build-for-testing.log")
            const sessionLogPath = join(args.logsDirectory, "xcodebuild-session.log")
            const wrapperStderrPath = join(args.logsDirectory, "runner-wrapper.stderr.log")
            const observerControlDirectory = join(args.runnerDirectory, "observer-control")
            const runtimeControlDirectory = join(args.runnerDirectory, "runtime-control")
            const stdoutEventsPath = join(args.runnerDirectory, "stdout-events.ndjson")
            const derivedDataPath = join(args.runnerDirectory, "derived-data")
            const resultBundlePath = join(args.runnerDirectory, "ProbeRunnerTransportBoundary.xcresult")

            await Promise.all([
              ensureDirectory(args.runnerDirectory),
              ensureDirectory(args.logsDirectory),
              ensureDirectory(observerControlDirectory),
              ensureDirectory(runtimeControlDirectory),
            ])

            const listResult = await runCommand({
              command: "xcrun",
              commandArgs: ["simctl", "list", "devices", "available", "-j"],
            })
            const listPayload = JSON.parse(listResult.stdout) as SimctlListPayload

            const availableSimulatorEntries = Object.entries(listPayload.devices ?? {})
              .filter(([runtime]) => runtime.includes("iOS"))
              .flatMap(([runtime, devices]) =>
                devices
                  .filter((device) => device.isAvailable !== false)
                  .map((device) => ({ runtime, device })),
              )

            const selected = args.simulatorUdid
              ? availableSimulatorEntries.find(({ device }) => device.udid === args.simulatorUdid)
              : availableSimulatorEntries.find(({ device }) => device.name.startsWith("iPhone"))

            if (!selected) {
              throw new UserInputError({
                code: "simulator-not-found",
                reason: args.simulatorUdid
                  ? `No available simulator matched UDID ${args.simulatorUdid}.`
                  : "No available iPhone simulator was found.",
                nextStep: "Boot or create an available iPhone simulator and retry the session open.",
                details: [],
              })
            }

            await runCommand({
              command: "xcrun",
              commandArgs: ["simctl", "bootstatus", selected.device.udid, "-b"],
            })

            await runCommand({
              command: "xcodebuild",
              commandArgs: [
                "-project",
                projectPath,
                "-scheme",
                "ProbeRunner",
                "-destination",
                `platform=iOS Simulator,id=${selected.device.udid}`,
                "-derivedDataPath",
                derivedDataPath,
                "CODE_SIGNING_ALLOWED=NO",
                "build-for-testing",
              ],
              logPath: buildLogPath,
            })

            const appPath = join(derivedDataPath, "Build", "Products", "Debug-iphonesimulator", "ProbeFixture.app")

            if (!(await fileExists(appPath))) {
              throw new EnvironmentError({
                code: "fixture-app-missing",
                reason: `Expected ProbeFixture.app at ${appPath} after build-for-testing.`,
                nextStep: "Inspect the build log artifact and verify the Xcode build products layout.",
                details: [],
              })
            }

            await runCommand({
              command: "xcrun",
              commandArgs: ["simctl", "install", selected.device.udid, appPath],
            })

            const launchResult = await runCommand({
              command: "xcrun",
              commandArgs: [
                "simctl",
                "launch",
                "--terminate-running-process",
                selected.device.udid,
                fixtureBundleId,
              ],
            })
            const fixtureProcessId = parseFixtureProcessId(launchResult.stdout.trim())

            bootstrapPath = join(runnerBootstrapRootPath, `${selected.device.udid}.json`)
            await writeBootstrapManifest({
              bootstrapPath,
              controlDirectoryPath: runtimeControlDirectory,
              sessionIdentifier: args.sessionId,
              simulatorUdid: selected.device.udid,
            })

            const startedAt = Date.now()
            wrapper = await startWrapperProcess({
              rootDir: args.rootDir,
              projectPath,
              observerControlDirectory,
              wrapperStderrPath,
              logPath: sessionLogPath,
              stdoutEventsPath,
              derivedDataPath,
              simulatorUdid: selected.device.udid,
              resultBundlePath,
            })
            void wrapper.exit.finally(async () => {
              if (bootstrapPath === null) {
                return
              }

              const completedBootstrapPath = bootstrapPath
              bootstrapPath = null
              await removeFileIfExists(completedBootstrapPath)
            })

            const isWrapperRunning = () => wrapper !== null && wrapper.process.exitCode === null && !wrapper.process.killed

            const ready = await waitForFreshJson<ReadyFrame>({
              path: join(observerControlDirectory, "stdout-ready.json"),
              timeoutMs: runnerReadyTimeoutMs,
              minMtimeMs: startedAt,
              isRunning: isWrapperRunning,
              decode: decodeRunnerReadyFrame,
              invalidCode: "runner-ready-frame-invalid",
              invalidReason: "The runner ready frame drifted from the validated host↔runner contract",
              invalidNextStep: "Inspect the saved ready frame JSON and align the host/runtime transport contract before retrying.",
              commandDescription: "runner ready wait",
              logPath: sessionLogPath,
            })

            assertReadyTransportContract({
              ready,
              expectedControlDirectoryPath: runtimeControlDirectory,
              expectedSessionIdentifier: args.sessionId,
              simulatorUdid: selected.device.udid,
            })

            const stdinProbe = await waitForFreshJson<StdinProbeResultFrame>({
              path: join(observerControlDirectory, "stdout-stdin-probe-result.json"),
              timeoutMs: runnerReadyTimeoutMs,
              minMtimeMs: startedAt,
              isRunning: isWrapperRunning,
              decode: decodeRunnerStdinProbeResultFrame,
              invalidCode: "runner-stdin-probe-frame-invalid",
              invalidReason: "The runner stdin probe frame drifted from the validated host↔runner contract",
              invalidNextStep: "Inspect the saved stdin probe JSON and align the host/runtime transport contract before retrying.",
              commandDescription: "runner stdin probe wait",
              logPath: sessionLogPath,
            })

            const sendCommand = async (
              sequence: number,
              action: "ping" | "applyInput" | "snapshot" | "shutdown" | "uiAction",
              payload?: string,
            ): Promise<RunnerCommandResult> => {
              const startedAt = Date.now()
              const commandPath = join(ready.controlDirectoryPath, `command-${String(sequence).padStart(3, "0")}.json`)
              const stdoutResponsePath = join(
                observerControlDirectory,
                `stdout-response-${String(sequence).padStart(3, "0")}.json`,
              )

              await writeFile(
                commandPath,
                encodeRunnerCommandFrame({ sequence, action, payload: payload ?? null }),
                "utf8",
              )

              const stdoutResponse = await waitForFreshJson<ResponseFrame>({
                path: stdoutResponsePath,
                timeoutMs: commandTimeoutMs,
                minMtimeMs: startedAt,
                isRunning: isWrapperRunning,
                decode: decodeRunnerResponseFrame,
                invalidCode: "runner-response-frame-invalid",
                invalidReason: `The runner ${action} response drifted from the validated host↔runner contract`,
                invalidNextStep: "Inspect the saved runner response JSON and align the host/runtime transport contract before retrying.",
                commandDescription: `runner stdout ${action}`,
                logPath: sessionLogPath,
              })

              return {
                ok: stdoutResponse.ok,
                action: stdoutResponse.action,
                error: stdoutResponse.error ?? null,
                payload: stdoutResponse.payload ?? null,
                snapshotPayloadPath: stdoutResponse.snapshotPayloadPath ?? null,
                handledMs: stdoutResponse.handledMs,
                statusLabel: stdoutResponse.statusLabel,
                snapshotNodeCount: stdoutResponse.snapshotNodeCount ?? null,
                hostRttMs: Date.now() - startedAt,
              }
            }

            const initialPing = await sendCommand(1, "ping", "session-open")

            if (!initialPing.ok) {
              throw new EnvironmentError({
                code: "runner-open-ping-failed",
                reason: "The runner did not acknowledge the initial ping command after session open.",
                nextStep: "Inspect the xcodebuild session log artifact and retry the daemon session open.",
                details: [],
              })
            }

            const close = async (): Promise<void> => {
              const activeWrapper = wrapper
              wrapper = null

              if (activeWrapper) {
                await stopWrapperProcess(activeWrapper)
              }

              if (bootstrapPath !== null) {
                await removeFileIfExists(bootstrapPath)
                bootstrapPath = null
              }
            }

            return {
              simulator: {
                udid: selected.device.udid,
                name: selected.device.name,
                runtime: selected.runtime,
              },
              bundleId: fixtureBundleId,
              fixtureProcessId,
              wrapperProcessId: wrapper.process.pid ?? -1,
              testProcessId: ready.processIdentifier,
              attachLatencyMs: ready.attachLatencyMs,
              bootstrapPath: ready.bootstrapPath,
              bootstrapSource: ready.bootstrapSource,
              runnerTransportContract: ready.runnerTransportContract,
              sessionIdentifier: ready.sessionIdentifier,
              commandIngress: ready.ingressTransport,
              eventEgress: ready.egressTransport,
              runtimeControlDirectory: ready.controlDirectoryPath,
              observerControlDirectory,
              logPath: sessionLogPath,
              buildLogPath,
              stdoutEventsPath,
              resultBundlePath,
              wrapperStderrPath,
              stdinProbeStatus: stdinProbe.status,
              initialPingRttMs: initialPing.hostRttMs,
              nextSequence: 2,
              sendCommand,
              isWrapperRunning,
              waitForExit: wrapper.exit,
              close,
            }
          } catch (error) {
            if (wrapper !== null) {
              await stopWrapperProcess(wrapper).catch(() => undefined)
            }

            if (bootstrapPath !== null) {
              await removeFileIfExists(bootstrapPath)
              bootstrapPath = null
            }

            throw error
          }
        },
        catch: (error) => {
          if (
            error instanceof UserInputError
            || error instanceof UnsupportedCapabilityError
            || error instanceof EnvironmentError
            || error instanceof ChildProcessError
          ) {
            return error
          }

          return new EnvironmentError({
            code: "simulator-harness-open",
            reason: error instanceof Error ? error.message : String(error),
            nextStep: "Inspect the Probe runner artifacts and retry the session open.",
            details: [],
          })
        },
        })
    },
    reapStaleRunnerSession: (args) =>
      Effect.tryPromise({
        try: async () => {
          const details: Array<string> = []
          let summary = `No stale runner cleanup was needed for session ${args.sessionId}.`

          if (args.wrapperProcessId !== null && args.wrapperProcessId > 0) {
            const outcome = await terminateRunnerProcess(args.wrapperProcessId)
            summary = outcome.summary
            details.push(...outcome.details)
          } else {
            details.push("No persisted runner wrapper pid was available for orphan reaping.")
          }

          if (args.bootstrapPath) {
            const existed = await fileExists(args.bootstrapPath)
            await removeFileIfExists(args.bootstrapPath)
            details.push(
              existed
                ? `Removed stale bootstrap manifest ${args.bootstrapPath}.`
                : `Bootstrap manifest ${args.bootstrapPath} was already absent.`,
            )
          } else {
            details.push("No persisted bootstrap manifest path was available for cleanup.")
          }

          return {
            summary,
            details,
          }
        },
        catch: (error) =>
          new EnvironmentError({
            code: "stale-runner-reap",
            reason: error instanceof Error ? error.message : String(error),
            nextStep: "Inspect the persisted session artifacts, then retry daemon startup cleanup.",
            details: [],
          }),
      }),
    captureSimulatorLogStream: (args) =>
      Effect.tryPromise({
        try: async () => {
          const fileName = `${timestampForFile()}-${sanitizeFileComponent(args.predicate, "simulator-log-stream")}.ndjson`
          const absolutePath = join(args.logsDirectory, "streams", fileName)

          const commandArgs = [
            "simctl",
            "spawn",
            args.simulatorUdid,
            "log",
            "stream",
            "--style",
            "ndjson",
            "--level",
            "info",
            "--timeout",
            `${args.captureSeconds}s`,
          ]

          if (args.predicate) {
            commandArgs.push("--predicate", args.predicate)
          }

          await runCommandWithCapturedStdout({
            command: "xcrun",
            commandArgs,
            stdoutPath: absolutePath,
          })

          return { absolutePath }
        },
        catch: (error) =>
          error instanceof EnvironmentError || error instanceof ChildProcessError
            ? error
            : new EnvironmentError({
                code: "simulator-log-capture",
                reason: error instanceof Error ? error.message : String(error),
                nextStep: "Inspect the simulator log capture command and retry the session logs request.",
                details: [],
              }),
      }),
    captureScreenshot: (args) =>
      Effect.tryPromise({
        try: async () => {
          const fileName = `${timestampForFile()}-${sanitizeFileComponent(args.label, "screenshot")}.png`
          const absolutePath = join(args.screenshotsDirectory, fileName)
          await ensureDirectory(args.screenshotsDirectory)

          await runCommand({
            command: "xcrun",
            commandArgs: ["simctl", "io", args.simulatorUdid, "screenshot", "--type=png", absolutePath],
          })

          return { absolutePath }
        },
        catch: (error) =>
          error instanceof EnvironmentError || error instanceof ChildProcessError
            ? error
            : new EnvironmentError({
                code: "simulator-screenshot-capture",
                reason: error instanceof Error ? error.message : String(error),
                nextStep: "Inspect the simctl screenshot command and retry the session screenshot request.",
                details: [],
              }),
      }),
  }),
)
