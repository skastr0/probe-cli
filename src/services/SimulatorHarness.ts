import { spawn, type ChildProcess } from "node:child_process"
import { access, mkdir, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises"
import { createServer } from "node:net"
import { dirname, join } from "node:path"
import { Context, Effect, Layer } from "effect"
import {
  ChildProcessError,
  EnvironmentError,
  UnsupportedCapabilityError,
  UserInputError,
} from "../domain/errors"
import type { SimulatorSessionMode } from "../domain/session"
import {
  type RunnerCapability,
  decodeRunnerReadyFrame,
  decodeRunnerResponseFrame,
  encodeRunnerCommandFrame,
  RUNNER_EVENT_EGRESS,
  RUNNER_HTTP_COMMAND_INGRESS,
  RUNNER_TRANSPORT_CONTRACT,
  type RunnerAction,
  type RunnerReadyFrame,
  type RunnerResponseFrame,
} from "./runnerProtocol"
import { injectEnvironmentVariablesIntoXctestrunPlist } from "./RealDeviceHarness"
import {
  probeRunnerSimulatorDerivedRootPath,
  resolveProbeFixtureProjectPath,
  resolveProbeRunnerWrapperScriptPath,
} from "./ProjectRoot"

const defaultTestBundleId = "dev.probe.fixture"
const observerFramePollIntervalMs = 50
const commandTimeoutMs = 20_000
const runnerReadyTimeoutMs = 120_000
const recordVideoTimeoutBufferMs = 30_000
const maxRecordVideoDurationMs = 120_000
const defaultRecordVideoDurationMs = 10_000
const runnerBootstrapRootPath = "/tmp/probe-runner-bootstrap"
const runnerPortEnvKey = "PROBE_RUNNER_PORT"
const runnerTransportContract = RUNNER_TRANSPORT_CONTRACT
const runnerCommandIngress = RUNNER_HTTP_COMMAND_INGRESS
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

export interface RunnerCommandResult {
  readonly ok: boolean
  readonly action: RunnerAction
  readonly error: string | null
  readonly payload: string | null
  readonly snapshotPayloadPath: string | null
  readonly inlinePayload?: string | null
  readonly inlinePayloadEncoding?: string | null
  readonly handledMs: number
  readonly totalHandledMs?: number | null
  readonly childHandledMs?: ReadonlyArray<number | null> | null
  readonly failedActionIndex?: number | null
  readonly failedActionKind?: string | null
  readonly statusLabel: string
  readonly snapshotNodeCount: number | null
  readonly hostRttMs: number
}

export interface OpenedSimulatorSession {
  readonly simulator: {
    readonly udid: string
    readonly name: string
    readonly runtime: string
  }
  readonly bundleId: string
  readonly targetProcessId: number
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
  readonly capabilities: ReadonlyArray<RunnerCapability>
  readonly sendCommand: (
    sequence: number,
    action: RunnerAction,
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
  readonly targetBundleId: string
}

const resolveCommandTimeoutMs = (action: RunnerAction, payload?: string): number => {
  if (action !== "recordVideo") {
    return commandTimeoutMs
  }

  const parsedDurationMs = Number(payload ?? "")
  const durationMs = Number.isFinite(parsedDurationMs) && parsedDurationMs > 0
    ? Math.min(parsedDurationMs, maxRecordVideoDurationMs)
    : defaultRecordVideoDurationMs

  return Math.max(commandTimeoutMs, durationMs + recordVideoTimeoutBufferMs)
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

const assertPackagedProbePathExists = async (path: string, description: string): Promise<void> => {
  if (await fileExists(path)) {
    return
  }

  throw new EnvironmentError({
    code: "probe-package-artifact-missing",
    reason: `Probe could not find the packaged ${description} at ${path}.`,
    nextStep: "Reinstall probe-cli so the packaged ios/ runner sources are restored, then retry the session open.",
    details: [],
  })
}

const findFirstMatchingPath = async (directory: string, predicate: (name: string) => boolean): Promise<string | null> => {
  try {
    const entries = await readdir(directory)
    const match = entries.find(predicate)
    return match ? join(directory, match) : null
  } catch {
    return null
  }
}

const resolveSimulatorTargetAppPath = (derivedDataPath: string): string =>
  join(derivedDataPath, "Build", "Products", "Debug-iphonesimulator", "ProbeFixture.app")

const allocateFreeTcpPort = async (): Promise<number> =>
  await new Promise((resolve, reject) => {
    const server = createServer()

    server.once("error", reject)
    server.listen({ host: "127.0.0.1", port: 0 }, () => {
      const address = server.address()
      const port = typeof address === "object" && address !== null ? address.port : null

      if (!port || port <= 0) {
        server.close((error) => reject(error ?? new Error("The temporary TCP listener did not report a usable port.")))
        return
      }

      server.close((error) => {
        if (error) {
          reject(error)
          return
        }

        resolve(port)
      })
    })
  })

const resolveRunnerXctestrunPath = async (derivedDataPath: string): Promise<string> => {
  const buildProductsPath = join(derivedDataPath, "Build", "Products")
  const xctestrunPath = await findFirstMatchingPath(buildProductsPath, (name) => name.endsWith(".xctestrun"))

  if (!xctestrunPath) {
    throw new EnvironmentError({
      code: "runner-xctestrun-missing",
      reason: `Expected an .xctestrun file under ${buildProductsPath} after the simulator build-for-testing step.`,
      nextStep: "Inspect the build-for-testing log artifact and the derived-data products layout before retrying.",
      details: [],
    })
  }

  return xctestrunPath
}

const injectRunnerPortIntoXctestrun = async (args: {
  readonly sourcePath: string
  readonly destinationPath: string
  readonly runnerPort: number
}): Promise<string> => {
  const originalXctestrun = await readFile(args.sourcePath, "utf8")
  const injectedXctestrun = injectEnvironmentVariablesIntoXctestrunPlist(originalXctestrun, {
    [runnerPortEnvKey]: String(args.runnerPort),
  })

  await ensureDirectory(dirname(args.destinationPath))
  await writeFile(args.destinationPath, injectedXctestrun, "utf8")
  return args.destinationPath
}

const writeBootstrapManifest = async (args: {
  readonly bootstrapPath: string
  readonly controlDirectoryPath: string
  readonly sessionIdentifier: string
  readonly simulatorUdid: string
  readonly targetBundleId: string
}): Promise<void> => {
  const manifest: RunnerBootstrapManifest = {
    contractVersion: runnerTransportContract,
    controlDirectoryPath: args.controlDirectoryPath,
    egressTransport: runnerEventEgress,
    generatedAt: new Date().toISOString(),
    ingressTransport: runnerCommandIngress,
    sessionIdentifier: args.sessionIdentifier,
    simulatorUdid: args.simulatorUdid,
    targetBundleId: args.targetBundleId,
  }

  await ensureDirectory(dirname(args.bootstrapPath))
  await writeFile(args.bootstrapPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8")
}

const removeFileIfExists = async (path: string): Promise<void> => {
  await rm(path, { force: true }).catch(() => undefined)
}

const findNewestFileInDirectory = async (directory: string): Promise<string | null> => {
  let entries: ReadonlyArray<string>

  try {
    entries = await readdir(directory)
  } catch {
    return null
  }

  const files = (await Promise.all(entries.map(async (entry) => {
    const absolutePath = join(directory, entry)
    const entryStat = await stat(absolutePath)

    if (entryStat.isDirectory()) {
      const nested = await findNewestFileInDirectory(absolutePath)
      return nested ? [nested] : []
    }

    return [absolutePath]
  }))).flat()

  if (files.length === 0) {
    return null
  }

  const candidates = await Promise.all(files.map(async (absolutePath) => ({
    absolutePath,
    mtimeMs: (await stat(absolutePath)).mtimeMs,
  })))

  return candidates.sort((left, right) => right.mtimeMs - left.mtimeMs)[0]?.absolutePath ?? null
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

    await sleep(observerFramePollIntervalMs)
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

const sendRunnerHttpCommand = async (args: {
  readonly commandUrl: string
  readonly commandFrame: string
  readonly action: RunnerAction
  readonly payload?: string
}): Promise<ResponseFrame> => {
  const controller = new AbortController()
  const timeoutMs = resolveCommandTimeoutMs(args.action, args.payload)
  const timeout = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const response = await fetch(args.commandUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: args.commandFrame,
      signal: controller.signal,
    })
    const responseText = await response.text()

    if (!response.ok) {
      throw new Error(
        `Runner HTTP ${args.action} returned ${response.status}: ${responseText.trim() || "<empty-body>"}`,
      )
    }

    return decodeRunnerResponseFrame(JSON.parse(responseText) as unknown)
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`Runner HTTP ${args.action} timed out after ${timeoutMs} ms`)
    }

    throw error
  } finally {
    clearTimeout(timeout)
  }
}

export const createHttpRunnerCommandSender = (commandUrl: string) =>
  async (
    sequence: number,
    action: RunnerAction,
    payload?: string,
  ): Promise<RunnerCommandResult> => {
    const startedAt = Date.now()
    const response = await sendRunnerHttpCommand({
      commandUrl,
      commandFrame: encodeRunnerCommandFrame({ sequence, action, payload: payload ?? null }),
      action,
      payload,
    })

    return {
      ok: response.ok,
      action: response.action,
      error: response.error ?? null,
      payload: response.payload ?? null,
      snapshotPayloadPath: response.snapshotPayloadPath ?? null,
      inlinePayload: response.inlinePayload ?? null,
      inlinePayloadEncoding: response.inlinePayloadEncoding ?? null,
      handledMs: response.handledMs,
      totalHandledMs: response.totalHandledMs ?? null,
      childHandledMs: response.childHandledMs ?? null,
      failedActionIndex: response.failedActionIndex ?? null,
      failedActionKind: response.failedActionKind ?? null,
      statusLabel: response.statusLabel,
      snapshotNodeCount: response.snapshotNodeCount ?? null,
      hostRttMs: Date.now() - startedAt,
    }
  }

const runCommand = async (args: {
  readonly command: string
  readonly commandArgs: ReadonlyArray<string>
  readonly logPath?: string
  readonly timeoutMs?: number
}): Promise<{ readonly stdout: string; readonly stderr: string }> =>
  await new Promise<{ readonly stdout: string; readonly stderr: string }>((resolve, reject) => {
    const child = spawn(args.command, [...args.commandArgs], {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    })

    let stdout = ""
    let stderr = ""
    let timedOut = false

    const timeout = args.timeoutMs
      ? setTimeout(() => {
          timedOut = true
          child.kill("SIGTERM")
          setTimeout(() => {
            if (child.exitCode === null) {
              child.kill("SIGKILL")
            }
          }, 2_000)
        }, args.timeoutMs)
      : null

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
      if (timeout) {
        clearTimeout(timeout)
      }

      if (args.logPath) {
        await ensureDirectory(dirname(args.logPath))
      }

      if (args.logPath) {
        await writeFile(args.logPath, `${stdout}${stderr}`, "utf8")
      }

      if (timedOut) {
        reject(
          new ChildProcessError({
            code: "command-timeout",
            command: `${args.command} ${args.commandArgs.join(" ")}`,
            reason: `${args.command} timed out after ${args.timeoutMs ?? 0} ms.`,
            nextStep: args.logPath
              ? `Inspect the log at ${args.logPath} and retry.`
              : `Retry ${args.command} with a longer timeout or inspect the host state.`,
            exitCode: code,
            stderrExcerpt: `${stdout}${stderr}`.split(/\r?\n/).slice(-80).join("\n"),
          }),
        )
        return
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

const captureSimulatorScreenshotWithSimctl = async (args: {
  readonly simulatorUdid: string
  readonly absolutePath: string
}): Promise<void> => {
  await ensureDirectory(dirname(args.absolutePath))
  await removeFileIfExists(args.absolutePath)

  await runCommand({
    command: "xcrun",
    commandArgs: ["simctl", "io", args.simulatorUdid, "screenshot", args.absolutePath],
  })

  if (!(await fileExists(args.absolutePath))) {
    throw new Error(`simctl screenshot completed without creating ${args.absolutePath}.`)
  }
}

const captureSimulatorDiagnosticBundleWithSimctl = async (args: {
  readonly simulatorUdid: string
  readonly diagnosticsDirectory: string
  readonly fileStem: string
}): Promise<{ readonly absolutePath: string }> => {
  const outputDirectory = join(args.diagnosticsDirectory, `${args.fileStem}.simctl-diagnose`)

  await ensureDirectory(outputDirectory)
  await runCommand({
    command: "xcrun",
    commandArgs: ["simctl", "diagnose", "-b", "--output", outputDirectory, "--udid", args.simulatorUdid],
    timeoutMs: 10 * 60_000,
  })

  const absolutePath = await findNewestFileInDirectory(outputDirectory)

  if (absolutePath === null) {
    throw new Error(`simctl diagnose completed without producing an archive under ${outputDirectory}.`)
  }

  return { absolutePath }
}

const recordSimulatorVideoWithSimctl = async (args: {
  readonly simulatorUdid: string
  readonly absolutePath: string
  readonly durationMs: number
}): Promise<void> => {
  await ensureDirectory(dirname(args.absolutePath))
  await removeFileIfExists(args.absolutePath)

  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      "xcrun",
      ["simctl", "io", args.simulatorUdid, "recordVideo", "--force", args.absolutePath],
      {
        stdio: ["ignore", "pipe", "pipe"],
        env: process.env,
      },
    )

    let stdout = ""
    let stderr = ""
    let stopRequested = false
    let recordingStarted = false

    const requestStop = () => {
      if (stopRequested || child.killed || child.exitCode !== null) {
        return
      }

      stopRequested = true
      child.kill("SIGINT")
    }

    const startupTimeout = setTimeout(() => {
      if (!recordingStarted) {
        requestStop()
      }
    }, 15_000)

    let stopTimer = setTimeout(requestStop, args.durationMs)
    const hardTimeout = setTimeout(() => {
      requestStop()

      setTimeout(() => {
        if (child.exitCode === null) {
          child.kill("SIGKILL")
        }
      }, 2_000)
    }, args.durationMs + 30_000)

    child.stdout?.setEncoding("utf8")
    child.stderr?.setEncoding("utf8")
    child.stdout?.on("data", (chunk) => {
      stdout += chunk
    })
    child.stderr?.on("data", (chunk) => {
      stderr += chunk

      if (!recordingStarted && stderr.includes("Recording started")) {
        recordingStarted = true
        clearTimeout(stopTimer)
        stopTimer = setTimeout(requestStop, args.durationMs)
      }
    })

    child.once("error", (error) => {
      clearTimeout(startupTimeout)
      clearTimeout(stopTimer)
      clearTimeout(hardTimeout)
      reject(error)
    })
    child.once("close", (exitCode, signal) => {
      clearTimeout(startupTimeout)
      clearTimeout(stopTimer)
      clearTimeout(hardTimeout)

      const completedGracefully = exitCode === 0 || (stopRequested && signal === "SIGINT")

      if (completedGracefully) {
        resolve()
        return
      }

      reject(
        new ChildProcessError({
          code: "command-failed",
          command: `xcrun simctl io ${args.simulatorUdid} recordVideo ${args.absolutePath}`,
          reason: `xcrun simctl io recordVideo exited with ${exitCode ?? signal ?? "unknown"}.`,
          nextStep: "Inspect the simulator media capture command and retry the video request.",
          exitCode,
          stderrExcerpt: `${stdout}${stderr}`.split(/\r?\n/).slice(-80).join("\n"),
        }),
      )
    })
  })

  if (!(await fileExists(args.absolutePath))) {
    throw new Error(`simctl recordVideo completed without creating ${args.absolutePath}.`)
  }
}

const parseProcessId = (stdout: string): number => {
  const match = stdout.match(/:\s*(\d+)\s*$/)

  if (!match) {
    throw new EnvironmentError({
      code: "launch-pid-parse",
      reason: `Could not parse a target process id from simctl output: ${stdout}`,
      nextStep: "Inspect the simctl launch output and retry the session open.",
      details: [],
    })
  }

  return Number(match[1])
}

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

export const isInstalledAppListMatch = (stdout: string, bundleId: string): boolean => {
  const escapedBundleId = escapeRegExp(bundleId)
  const bundleIdPattern = new RegExp(`(^|[^A-Za-z0-9._-])${escapedBundleId}($|[^A-Za-z0-9._-])`, "m")
  return bundleIdPattern.test(stdout)
}

interface AttachTargetProcessResolverCommands {
  readonly runCommand: typeof runCommand
  readonly runCommandWithExit: typeof runCommandWithExit
}

const defaultAttachTargetProcessResolverCommands: AttachTargetProcessResolverCommands = {
  runCommand,
  runCommandWithExit,
}

interface SimulatorRunnerBuildCommands {
  readonly runCommand: typeof runCommand
}

const defaultSimulatorRunnerBuildCommands: SimulatorRunnerBuildCommands = {
  runCommand,
}

export const resolveAttachTargetProcessId = async (
  args: {
  readonly simulatorUdid: string
  readonly bundleId: string
  },
  commands: AttachTargetProcessResolverCommands = defaultAttachTargetProcessResolverCommands,
): Promise<number> => {
  // Step 1: Verify the app is installed
  const installedApps = await commands.runCommand({
    command: "xcrun",
    commandArgs: ["simctl", "listapps", args.simulatorUdid],
  })

  if (!isInstalledAppListMatch(installedApps.stdout, args.bundleId)) {
    throw new EnvironmentError({
      code: "target-app-not-installed",
      reason: `The target app ${args.bundleId} is not installed on simulator ${args.simulatorUdid}.`,
      nextStep:
        `Install ${args.bundleId} on simulator ${args.simulatorUdid} with your own app pipeline, then launch it and retry the attach-to-running session open.`,
      details: [],
    })
  }

  // Step 2: Check if the app is already running by querying launchctl inside the simulator.
  // simctl spawn <udid> launchctl list prints all running services with their PIDs.
  // We look for a line containing the bundle ID to extract the PID.
  const launchctlResult = await commands.runCommandWithExit({
    command: "xcrun",
    commandArgs: ["simctl", "spawn", args.simulatorUdid, "launchctl", "list"],
  })

  const runningPid = extractPidFromLaunchctlList(launchctlResult.stdout, args.bundleId)

  if (runningPid !== null) {
    return runningPid
  }

  throw new EnvironmentError({
    code: "target-app-not-running",
    reason: `The target app ${args.bundleId} is installed on simulator ${args.simulatorUdid} but is not currently running.`,
    nextStep: `Launch ${args.bundleId} on simulator ${args.simulatorUdid}, then retry the attach-to-running session open.`,
    details: [
      "Attach-to-running mode requires the app to be already running. Probe does not launch the target app in this mode.",
    ],
  })
}

export const extractPidFromLaunchctlList = (stdout: string, bundleId: string): number | null => {
  // launchctl list output lines look like:
  // <PID>  <exit-status>  <label>
  // The label for iOS apps contains the bundle identifier.
  // Example: "12345  -  dev.probe.fixture"
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed.includes(bundleId)) {
      continue
    }

    // Try to extract the leading PID (a positive integer)
    const pidMatch = trimmed.match(/^(\d+)\s/)
    if (pidMatch) {
      const pid = Number(pidMatch[1])
      if (pid > 0 && Number.isFinite(pid)) {
        return pid
      }
    }
  }

  return null
}

export const buildProbeRunnerForSimulator = async (
  args: {
    readonly projectPath: string
    readonly simulatorUdid: string
    readonly derivedDataPath: string
    readonly buildLogPath: string
  },
  commands: SimulatorRunnerBuildCommands = defaultSimulatorRunnerBuildCommands,
): Promise<void> => {
  await commands.runCommand({
    command: "xcodebuild",
    commandArgs: [
      "-project",
      args.projectPath,
      "-scheme",
      "ProbeRunner",
      "-destination",
      `platform=iOS Simulator,id=${args.simulatorUdid}`,
      "-derivedDataPath",
      args.derivedDataPath,
      "CODE_SIGNING_ALLOWED=NO",
      "build-for-testing",
    ],
    logPath: args.buildLogPath,
  })
}

const resolveSimulatorRunnerDerivedDataPath = (simulatorUdid: string): string =>
  join(
    probeRunnerSimulatorDerivedRootPath,
    sanitizeFileComponent(simulatorUdid, "simulator"),
  )

export const xctestrunReferencesProjectRoot = async (xctestrunPath: string, projectRoot: string): Promise<boolean> => {
  try {
    const contents = await readFile(xctestrunPath, "utf8")
    const candidateRoots = new Set<string>([projectRoot])

    try {
      candidateRoots.add(await realpath(projectRoot))
    } catch {
      // ignore
    }

    for (const root of candidateRoots) {
      if (contents.includes(root)) {
        return true
      }
    }

    return false
  } catch {
    return false
  }
}

const evaluateExistingSimulatorRunnerBuild = async (args: {
  readonly derivedDataPath: string
  readonly projectRoot: string
}): Promise<{
  readonly cacheHit: boolean
  readonly xctestrunPath: string | null
  readonly targetAppPath: string
}> => {
  const buildProductsPath = join(args.derivedDataPath, "Build", "Products")
  const xctestrunPath = await findFirstMatchingPath(buildProductsPath, (name) => name.endsWith(".xctestrun"))
  const targetAppPath = resolveSimulatorTargetAppPath(args.derivedDataPath)

  if (!xctestrunPath || !(await fileExists(targetAppPath))) {
    return {
      cacheHit: false,
      xctestrunPath,
      targetAppPath,
    }
  }

  return {
    cacheHit: await xctestrunReferencesProjectRoot(xctestrunPath, args.projectRoot),
    xctestrunPath,
    targetAppPath,
  }
}

export const ensureSimulatorRunnerPrepared = async (
  args: {
    readonly projectPath: string
    readonly projectRoot: string
    readonly simulatorUdid: string
    readonly derivedDataPath: string
    readonly buildLogPath: string
  },
  commands: {
    readonly buildRunner?: typeof buildProbeRunnerForSimulator
  } = {},
): Promise<{
  readonly cacheHit: boolean
  readonly xctestrunPath: string
  readonly targetAppPath: string
}> => {
  const existing = await evaluateExistingSimulatorRunnerBuild({
    derivedDataPath: args.derivedDataPath,
    projectRoot: args.projectRoot,
  })

  if (existing.cacheHit && existing.xctestrunPath) {
    await writeFile(
      args.buildLogPath,
      `Reused cached simulator runner build from ${args.derivedDataPath}.\n`,
      "utf8",
    )

    return {
      cacheHit: true,
      xctestrunPath: existing.xctestrunPath,
      targetAppPath: existing.targetAppPath,
    }
  }

  await (commands.buildRunner ?? buildProbeRunnerForSimulator)({
    projectPath: args.projectPath,
    simulatorUdid: args.simulatorUdid,
    derivedDataPath: args.derivedDataPath,
    buildLogPath: args.buildLogPath,
  })

  return {
    cacheHit: false,
    xctestrunPath: await resolveRunnerXctestrunPath(args.derivedDataPath),
    targetAppPath: resolveSimulatorTargetAppPath(args.derivedDataPath),
  }
}

const assertReadyTransportContract = (args: {
  readonly ready: ReadyFrame
  readonly expectedControlDirectoryPath: string
  readonly expectedSessionIdentifier: string
  readonly simulatorUdid: string
  readonly expectedRunnerPort: number
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

  if (args.ready.runnerPort !== args.expectedRunnerPort) {
    throw new EnvironmentError({
      code: "runner-port-mismatch",
      reason:
        `Expected runner HTTP port ${args.expectedRunnerPort}, received ${String(args.ready.runnerPort ?? null)}.`,
      nextStep: "Inspect the injected PROBE_RUNNER_PORT value and the simulator runner HTTP listener startup before retrying.",
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
  readonly projectRoot: string
  readonly xctestrunPath: string
  readonly destination: string
  readonly observerControlDirectory: string
  readonly wrapperStderrPath: string
  readonly logPath: string
  readonly stdoutEventsPath: string
  readonly resultBundlePath: string
}): Promise<{
  readonly process: ChildProcess
  readonly exit: Promise<{ readonly code: number | null; readonly signal: string | null }>
}> => {
  await ensureDirectory(args.observerControlDirectory)
  await ensureDirectory(dirname(args.wrapperStderrPath))
  await writeFile(args.wrapperStderrPath, "", "utf8")

  const wrapperScript = resolveProbeRunnerWrapperScriptPath(args.projectRoot)

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
      "--",
      "xcodebuild",
      "-xctestrun",
      args.xctestrunPath,
      "-destination",
      args.destination,
      "-resultBundlePath",
      args.resultBundlePath,
      "CODE_SIGNING_ALLOWED=NO",
      "test-without-building",
      "-only-testing:ProbeRunnerUITests/AttachControlSpikeUITests/testCommandLoopTransportBoundary",
    ],
    {
      cwd: args.projectRoot,
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
    readonly openSession: (args: {
      readonly projectRoot: string
      readonly sessionId: string
      readonly artifactRoot: string
      readonly runnerDirectory: string
      readonly logsDirectory: string
      readonly bundleId: string
      readonly sessionMode?: SimulatorSessionMode
      readonly simulatorUdid: string | null
    }) => Effect.Effect<OpenedSimulatorSession, EnvironmentError | UserInputError | UnsupportedCapabilityError | ChildProcessError>
    readonly captureSimulatorLogStream: (args: {
      readonly simulatorUdid: string
      readonly logsDirectory: string
      readonly captureSeconds: number
      readonly predicate: string | null
    }) => Effect.Effect<{ readonly absolutePath: string }, EnvironmentError | ChildProcessError>
    readonly captureSimulatorScreenshot: (args: {
      readonly simulatorUdid: string
      readonly absolutePath: string
    }) => Effect.Effect<{ readonly absolutePath: string }, EnvironmentError | ChildProcessError>
    readonly captureSimulatorDiagnosticBundle: (args: {
      readonly simulatorUdid: string
      readonly diagnosticsDirectory: string
      readonly fileStem: string
    }) => Effect.Effect<{ readonly absolutePath: string }, EnvironmentError | ChildProcessError>
    readonly recordSimulatorVideo: (args: {
      readonly simulatorUdid: string
      readonly absolutePath: string
      readonly durationMs: number
    }) => Effect.Effect<{ readonly absolutePath: string }, EnvironmentError | ChildProcessError>
    readonly reapStaleRunnerSession: (args: {
      readonly sessionId: string
      readonly wrapperProcessId: number | null
      readonly bootstrapPath: string | null
    }) => Effect.Effect<{
      readonly summary: string
      readonly details: ReadonlyArray<string>
    }, EnvironmentError>
  }
>() {}

export const SimulatorHarnessLive = Layer.succeed(
  SimulatorHarness,
  SimulatorHarness.of({
    openSession: (args) => {
      let wrapper: Awaited<ReturnType<typeof startWrapperProcess>> | null = null
      let bootstrapPath: string | null = null
      const sessionMode = args.sessionMode ?? "build-and-install"

      return Effect.tryPromise({
        try: async () => {
          try {
            if (sessionMode === "build-and-install" && args.bundleId !== defaultTestBundleId) {
              throw new UserInputError({
                code: "simulator-session-mode-bundle-mismatch",
                reason:
                  `Simulator build-and-install mode can only target ${defaultTestBundleId}; received ${args.bundleId}.`,
                nextStep:
                  `Retry in attach-to-running mode for ${args.bundleId}, or omit --bundle-id to use Probe's built-in fixture app.`,
                details: [],
              })
            }

            const projectPath = resolveProbeFixtureProjectPath(args.projectRoot)
            const wrapperScriptPath = resolveProbeRunnerWrapperScriptPath(args.projectRoot)
            const buildLogPath = join(args.logsDirectory, "build-for-testing.log")
            const sessionLogPath = join(args.logsDirectory, "xcodebuild-session.log")
            const wrapperStderrPath = join(args.logsDirectory, "runner-wrapper.stderr.log")
            const observerControlDirectory = join(args.runnerDirectory, "observer-control")
            const runtimeControlDirectory = join(args.runnerDirectory, "runtime-control")
            const stdoutEventsPath = join(args.runnerDirectory, "stdout-events.ndjson")
            const resultBundlePath = join(args.runnerDirectory, "ProbeRunnerTransportBoundary.xcresult")

            await Promise.all([
              ensureDirectory(args.runnerDirectory),
              ensureDirectory(args.logsDirectory),
              ensureDirectory(observerControlDirectory),
              ensureDirectory(runtimeControlDirectory),
              assertPackagedProbePathExists(projectPath, "ProbeFixture Xcode project"),
              assertPackagedProbePathExists(wrapperScriptPath, "ProbeRunner wrapper script"),
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

            const derivedDataPath = resolveSimulatorRunnerDerivedDataPath(selected.device.udid)

            const preparedRunner = await ensureSimulatorRunnerPrepared({
              projectPath,
              projectRoot: args.projectRoot,
              simulatorUdid: selected.device.udid,
              derivedDataPath,
              buildLogPath,
            })

            const targetProcessId = sessionMode === "attach-to-running"
              ? await resolveAttachTargetProcessId({
                  simulatorUdid: selected.device.udid,
                  bundleId: args.bundleId,
                })
              : await (async () => {
                  const targetAppPath = preparedRunner.targetAppPath

                  if (!(await fileExists(targetAppPath))) {
                    throw new EnvironmentError({
                      code: "target-app-missing",
                      reason: `Expected the default test app at ${targetAppPath} after build-for-testing.`,
                      nextStep: "Inspect the build log artifact and verify the Xcode build products layout.",
                      details: [],
                    })
                  }

                  await runCommand({
                    command: "xcrun",
                    commandArgs: ["simctl", "install", selected.device.udid, targetAppPath],
                  })

                  const launchResult = await runCommand({
                    command: "xcrun",
                    commandArgs: [
                      "simctl",
                      "launch",
                      "--terminate-running-process",
                      selected.device.udid,
                      defaultTestBundleId,
                    ],
                  })

                  return parseProcessId(launchResult.stdout.trim())
                })()

            bootstrapPath = join(runnerBootstrapRootPath, `${selected.device.udid}.json`)
            await writeBootstrapManifest({
              bootstrapPath,
              controlDirectoryPath: runtimeControlDirectory,
              sessionIdentifier: args.sessionId,
              simulatorUdid: selected.device.udid,
              targetBundleId: args.bundleId,
            })

            const runnerPort = await allocateFreeTcpPort()
            const injectedXctestrunPath = await injectRunnerPortIntoXctestrun({
              sourcePath: preparedRunner.xctestrunPath,
              destinationPath: join(dirname(preparedRunner.xctestrunPath), "simulator-injected.xctestrun"),
              runnerPort,
            })

            const startedAt = Date.now()
            wrapper = await startWrapperProcess({
              projectRoot: args.projectRoot,
              xctestrunPath: injectedXctestrunPath,
              destination: `platform=iOS Simulator,id=${selected.device.udid}`,
              observerControlDirectory,
              wrapperStderrPath,
              logPath: sessionLogPath,
              stdoutEventsPath,
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
              expectedRunnerPort: runnerPort,
            })

            const commandUrl = `http://127.0.0.1:${ready.runnerPort}/command`
            const sendCommand = createHttpRunnerCommandSender(commandUrl)

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
              bundleId: args.bundleId,
              targetProcessId,
              wrapperProcessId: wrapper.process.pid ?? -1,
              testProcessId: ready.processIdentifier,
              attachLatencyMs: ready.attachLatencyMs,
              bootstrapPath: ready.bootstrapPath,
              bootstrapSource: "simulator-bootstrap-manifest",
              runnerTransportContract,
              sessionIdentifier: ready.sessionIdentifier,
              commandIngress: runnerCommandIngress,
              eventEgress: runnerEventEgress,
              runtimeControlDirectory: ready.controlDirectoryPath,
              observerControlDirectory,
              logPath: sessionLogPath,
              buildLogPath,
              stdoutEventsPath,
              resultBundlePath,
              wrapperStderrPath,
              stdinProbeStatus: "not-required-http",
              initialPingRttMs: initialPing.hostRttMs,
              nextSequence: 2,
              capabilities: ready.capabilities ?? ["uiAction"],
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
    captureSimulatorScreenshot: (args) =>
      Effect.tryPromise({
        try: async () => {
          await captureSimulatorScreenshotWithSimctl(args)
          return { absolutePath: args.absolutePath }
        },
        catch: (error) =>
          error instanceof ChildProcessError
            ? error
            : new EnvironmentError({
                code: "simulator-screenshot-capture",
                reason: error instanceof Error ? error.message : String(error),
                nextStep: "Inspect the simctl screenshot command and retry the screenshot request.",
                details: [],
              }),
      }),
    captureSimulatorDiagnosticBundle: (args) =>
      Effect.tryPromise({
        try: () => captureSimulatorDiagnosticBundleWithSimctl(args),
        catch: (error) =>
          error instanceof ChildProcessError
            ? error
            : new EnvironmentError({
                code: "simulator-diagnostic-capture",
                reason: error instanceof Error ? error.message : String(error),
                nextStep: "Inspect the simctl diagnose command and retry the diagnostic capture.",
                details: [],
              }),
      }),
    recordSimulatorVideo: (args) =>
      Effect.tryPromise({
        try: async () => {
          await recordSimulatorVideoWithSimctl(args)
          return { absolutePath: args.absolutePath }
        },
        catch: (error) =>
          error instanceof ChildProcessError
            ? error
            : new EnvironmentError({
                code: "simulator-video-capture",
                reason: error instanceof Error ? error.message : String(error),
                nextStep: "Inspect the simctl recordVideo command and retry the video request.",
                details: [],
              }),
      }),
  }),
)
