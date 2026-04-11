import { spawn, type ChildProcess } from "node:child_process"
import { access, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { Context, Effect, Layer } from "effect"
import {
  ChildProcessError,
  EnvironmentError,
  UserInputError,
} from "../domain/errors"
import type { SessionConnectionDetails } from "../domain/session"
import type { RunnerCommandResult } from "./SimulatorHarness"
import {
  decodeRunnerReadyFrame,
  decodeRunnerResponseFrame,
  decodeRunnerStdinProbeResultFrame,
  encodeRunnerCommandFrame,
  RUNNER_COMMAND_INGRESS,
  RUNNER_EVENT_EGRESS,
  RUNNER_TRANSPORT_CONTRACT,
  type RunnerAction,
  type RunnerBootstrapManifest,
  type RunnerReadyFrame,
  type RunnerResponseFrame,
  type RunnerStdinProbeResultFrame,
} from "./runnerProtocol"

const runnerScheme = "ProbeRunner"
const commandPollIntervalMs = 50
const runnerReadyTimeoutMs = 120_000
const commandTimeoutMs = 20_000
const recordVideoTimeoutBufferMs = 30_000
const maxRecordVideoDurationMs = 120_000
const defaultRecordVideoDurationMs = 10_000
const runnerBootstrapRootPath = "/tmp/probe-runner-bootstrap"
const runnerTransportContract = RUNNER_TRANSPORT_CONTRACT
const runnerCommandIngress = RUNNER_COMMAND_INGRESS
const runnerEventEgress = RUNNER_EVENT_EGRESS

interface CommandResult {
  readonly stdout: string
  readonly stderr: string
  readonly exitCode: number | null
}

interface DevicectlPreferredDdiPayload {
  readonly info?: {
    readonly version?: string
  }
  readonly result?: {
    readonly hostCoreDeviceVersion?: string
    readonly platforms?: {
      readonly iOS?: ReadonlyArray<{
        readonly hostDDI?: string
        readonly ddiMetadata?: {
          readonly isUsable?: boolean
          readonly contentIsCompatible?: boolean
        }
      }>
    }
  }
}

interface DevicectlDevicesPayload {
  readonly result?: {
    readonly devices?: ReadonlyArray<unknown>
  }
}

interface RealDeviceCandidate {
  readonly identifier: string
  readonly name: string
  readonly runtime: string | null
  readonly matchKeys: ReadonlyArray<string>
}

interface PreflightIssue {
  readonly summary: string
  readonly nextStep: string
  readonly details: ReadonlyArray<string>
}

interface PreflightContext {
  readonly mode: "preflight"
  readonly device: {
    readonly identifier: string
    readonly name: string
    readonly runtime: string | null
  }
  readonly bundleId: string
  readonly hostCoreDeviceVersion: string
  readonly preferredDdiPath: string | null
  readonly preferredDdiJsonPath: string
  readonly devicesJsonPath: string
  readonly ddiServicesJsonPath: string | null
  readonly preflightReportPath: string
  readonly buildLogPath: string
  readonly xctestrunPath: string
  readonly targetAppPath: string
  readonly runnerAppPath: string
  readonly runnerXctestPath: string
  readonly integrationPoints: ReadonlyArray<string>
  readonly warnings: ReadonlyArray<string>
  readonly connection: SessionConnectionDetails
  readonly refreshConnection: () => Promise<SessionConnectionDetails>
  readonly close: () => Promise<void>
  readonly projectPath: string
  readonly derivedDataPath: string
  readonly developmentTeam: string
  readonly selectedDevice: RealDeviceCandidate
  readonly metaDirectory: string
}

export interface OpenedRealDevicePreflightSession {
  readonly mode: "preflight"
  readonly device: {
    readonly identifier: string
    readonly name: string
    readonly runtime: string | null
  }
  readonly bundleId: string
  readonly hostCoreDeviceVersion: string
  readonly preferredDdiPath: string | null
  readonly preferredDdiJsonPath: string
  readonly devicesJsonPath: string
  readonly ddiServicesJsonPath: string | null
  readonly preflightReportPath: string
  readonly buildLogPath: string
  readonly xctestrunPath: string
  readonly targetAppPath: string
  readonly runnerAppPath: string
  readonly runnerXctestPath: string
  readonly integrationPoints: ReadonlyArray<string>
  readonly warnings: ReadonlyArray<string>
  readonly connection: SessionConnectionDetails
  readonly refreshConnection: () => Promise<SessionConnectionDetails>
  readonly close: () => Promise<void>
}

export interface OpenedRealDeviceLiveSession extends Omit<OpenedRealDevicePreflightSession, "mode"> {
  readonly mode: "live"
  readonly bootstrapPath: string
  readonly bootstrapSource: "device-bootstrap-manifest"
  readonly runnerTransportContract: typeof runnerTransportContract
  readonly sessionIdentifier: string
  readonly commandIngress: typeof runnerCommandIngress
  readonly eventEgress: typeof runnerEventEgress
  readonly wrapperProcessId: number
  readonly testProcessId: number
  readonly targetProcessId: number
  readonly attachLatencyMs: number
  readonly runtimeControlDirectory: string
  readonly observerControlDirectory: string
  readonly logPath: string
  readonly stdoutEventsPath: string
  readonly resultBundlePath: string
  readonly wrapperStderrPath: string
  readonly stdinProbeStatus: string
  readonly installedAppsJsonPath: string
  readonly launchJsonPath: string
  readonly nextSequence: number
  readonly initialPingRttMs: number
  readonly sendCommand: (
    sequence: number,
    action: "ping" | "applyInput" | "snapshot" | "screenshot" | "recordVideo" | "shutdown" | "uiAction",
    payload?: string,
  ) => Promise<RunnerCommandResult>
  readonly isWrapperRunning: () => boolean
  readonly waitForExit: Promise<{ readonly code: number | null; readonly signal: string | null }>
}

export type OpenedRealDeviceSession = OpenedRealDevicePreflightSession | OpenedRealDeviceLiveSession

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

const nowIso = (): string => new Date().toISOString()

const ensureDirectory = async (path: string): Promise<void> => {
  await mkdir(path, { recursive: true })
}

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

const removeFileIfExists = async (path: string): Promise<void> => {
  await rm(path, { force: true }).catch(() => undefined)
}

const runCommand = async (args: {
  readonly command: string
  readonly commandArgs: ReadonlyArray<string>
}): Promise<CommandResult> =>
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

const writeCommandLog = async (path: string, result: CommandResult): Promise<void> => {
  const content = [
    `exitCode: ${result.exitCode ?? "unknown"}`,
    "",
    "stdout:",
    result.stdout,
    "",
    "stderr:",
    result.stderr,
  ].join("\n")

  await ensureDirectory(dirname(path))
  await writeFile(path, content, "utf8")
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null

const readPathValue = (root: Record<string, unknown>, path: ReadonlyArray<string>): unknown => {
  let current: unknown = root

  for (const key of path) {
    if (!isRecord(current) || !(key in current)) {
      return null
    }

    current = current[key]
  }

  return current
}

const toText = (value: unknown): string | null => {
  if (typeof value === "string") {
    return value
  }

  if (typeof value === "number" || typeof value === "bigint") {
    return String(value)
  }

  return null
}

const readFirstText = (
  root: Record<string, unknown>,
  paths: ReadonlyArray<ReadonlyArray<string>>,
): string | null => {
  for (const path of paths) {
    const value = toText(readPathValue(root, path))

    if (value && value.trim().length > 0) {
      return value.trim()
    }
  }

  return null
}

const dedupeStrings = (values: ReadonlyArray<string>): Array<string> => [...new Set(values)]

const formatCommandFailure = (command: string, result: CommandResult): string => {
  const tail = `${result.stdout}${result.stderr}`.trim().split(/\r?\n/).slice(-3).join(" | ")
  return tail.length > 0
    ? `${command} exited with ${result.exitCode ?? "unknown"}: ${tail}`
    : `${command} exited with ${result.exitCode ?? "unknown"}.`
}

const extractDeviceCandidate = (value: unknown): RealDeviceCandidate | null => {
  if (!isRecord(value)) {
    return null
  }

  const identifier = readFirstText(value, [
    ["identifier"],
    ["deviceIdentifier"],
    ["deviceId"],
    ["udid"],
    ["uuid"],
    ["serialNumber"],
    ["ecid"],
    ["hardwareProperties", "udid"],
    ["hardwareProperties", "serialNumber"],
    ["hardwareProperties", "ecid"],
    ["connectionProperties", "udid"],
    ["deviceProperties", "identifier"],
  ])

  const name = readFirstText(value, [
    ["name"],
    ["deviceName"],
    ["deviceProperties", "name"],
    ["hardwareProperties", "name"],
    ["connectionProperties", "name"],
  ])

  if (!identifier || !name) {
    return null
  }

  const runtime = readFirstText(value, [
    ["operatingSystemVersion"],
    ["operatingSystemVersionNumber"],
    ["osVersion"],
    ["deviceProperties", "osVersion"],
    ["deviceProperties", "productVersion"],
    ["hardwareProperties", "productVersion"],
  ])

  return {
    identifier,
    name,
    runtime,
    matchKeys: dedupeStrings([
      identifier,
      name,
      ...(runtime ? [`${name} (${runtime})`] : []),
      ...(readFirstText(value, [["serialNumber"], ["hardwareProperties", "serialNumber"]])
        ? [readFirstText(value, [["serialNumber"], ["hardwareProperties", "serialNumber"]])!]
        : []),
      ...(readFirstText(value, [["ecid"], ["hardwareProperties", "ecid"]])
        ? [readFirstText(value, [["ecid"], ["hardwareProperties", "ecid"]])!]
        : []),
    ]),
  }
}

const extractDeviceCandidates = (payload: DevicectlDevicesPayload): Array<RealDeviceCandidate> =>
  (payload.result?.devices ?? [])
    .map(extractDeviceCandidate)
    .filter((candidate): candidate is RealDeviceCandidate => candidate !== null)

const summarizeVisibleDevices = (devices: ReadonlyArray<RealDeviceCandidate>): ReadonlyArray<string> =>
  devices.map((device) => device.runtime
    ? `${device.name} (${device.identifier}) on ${device.runtime}`
    : `${device.name} (${device.identifier})`)

const resolveSelectedDevice = (args: {
  readonly devices: ReadonlyArray<RealDeviceCandidate>
  readonly requestedDeviceId: string | null
}): RealDeviceCandidate => {
  if (args.devices.length === 0) {
    throw new EnvironmentError({
      code: "device-not-found",
      reason: args.requestedDeviceId
        ? `No connected real device matched ${args.requestedDeviceId}.`
        : "No connected real device was found on this host.",
      nextStep: args.requestedDeviceId
        ? "Reconnect the requested device, confirm it is paired/trusted, then retry the session open."
        : "Connect a paired iOS 17+ device, enable Developer Mode, and retry the session open.",
      details: args.devices.length === 0 ? [] : summarizeVisibleDevices(args.devices),
    })
  }

  if (args.requestedDeviceId) {
    const requested = args.requestedDeviceId.trim()
    const matched = args.devices.find((device) => device.matchKeys.includes(requested))

    if (!matched) {
      throw new UserInputError({
        code: "device-selection-not-found",
        reason: `No connected real device matched ${requested}.`,
        nextStep: "Run `probe doctor`, choose one of the discovered device identifiers, and retry with --device-id.",
        details: summarizeVisibleDevices(args.devices),
      })
    }

    return matched
  }

  if (args.devices.length > 1) {
    throw new UserInputError({
      code: "device-selection-ambiguous",
      reason: `Found ${args.devices.length} connected real devices and no --device-id was provided.`,
      nextStep: "Retry with --target device --device-id <identifier> so Probe can pick a concrete device.",
      details: summarizeVisibleDevices(args.devices),
    })
  }

  return args.devices[0]!
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

const createConnectionDetails = (args: {
  readonly status: "connected" | "disconnected"
  readonly device: RealDeviceCandidate
  readonly details?: ReadonlyArray<string>
}): SessionConnectionDetails => ({
  status: args.status,
  checkedAt: nowIso(),
  summary: args.status === "connected"
    ? `CoreDevice can currently see ${args.device.name} (${args.device.identifier}).`
    : `CoreDevice can no longer see ${args.device.name} (${args.device.identifier}).`,
  details: [...(args.details ?? [])],
})

const stringKeyMatches = (key: string, pattern: RegExp): boolean => pattern.test(key)

const findRecordWithMatchingKeyValue = (
  value: unknown,
  keyPattern: RegExp,
  expected: string,
): Record<string, unknown> | null => {
  if (Array.isArray(value)) {
    for (const entry of value) {
      const matched = findRecordWithMatchingKeyValue(entry, keyPattern, expected)

      if (matched) {
        return matched
      }
    }

    return null
  }

  if (!isRecord(value)) {
    return null
  }

  for (const [key, entry] of Object.entries(value)) {
    if (stringKeyMatches(key, keyPattern) && toText(entry) === expected) {
      return value
    }
  }

  for (const entry of Object.values(value)) {
    const matched = findRecordWithMatchingKeyValue(entry, keyPattern, expected)

    if (matched) {
      return matched
    }
  }

  return null
}

const findFirstNumberByKey = (value: unknown, keyPattern: RegExp): number | null => {
  if (Array.isArray(value)) {
    for (const entry of value) {
      const matched = findFirstNumberByKey(entry, keyPattern)

      if (matched !== null) {
        return matched
      }
    }

    return null
  }

  if (!isRecord(value)) {
    return null
  }

  for (const [key, entry] of Object.entries(value)) {
    if (stringKeyMatches(key, keyPattern) && typeof entry === "number" && Number.isFinite(entry)) {
      return entry
    }
  }

  for (const entry of Object.values(value)) {
    const matched = findFirstNumberByKey(entry, keyPattern)

    if (matched !== null) {
      return matched
    }
  }

  return null
}

const bundleIdentifierKeyPattern = /^(bundleidentifier|bundleid|bundle_id|identifier)$/i
const processIdentifierKeyPattern = /^(processidentifier|processid|process_id|pid)$/i

const appListContainsBundleIdentifier = (payload: unknown, bundleId: string): boolean =>
  findRecordWithMatchingKeyValue(payload, bundleIdentifierKeyPattern, bundleId) !== null

const parseLaunchedTargetProcessId = (payload: unknown, bundleId: string): number | null => {
  const matchingRecord = findRecordWithMatchingKeyValue(payload, bundleIdentifierKeyPattern, bundleId)

  if (matchingRecord) {
    return findFirstNumberByKey(matchingRecord, processIdentifierKeyPattern)
      ?? findFirstNumberByKey(payload, processIdentifierKeyPattern)
  }

  return findFirstNumberByKey(payload, processIdentifierKeyPattern)
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

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
    generatedAt: nowIso(),
    ingressTransport: runnerCommandIngress,
    sessionIdentifier: args.sessionIdentifier,
    simulatorUdid: args.simulatorUdid,
    targetBundleId: args.targetBundleId,
  }

  await ensureDirectory(dirname(args.bootstrapPath))
  await writeFile(args.bootstrapPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8")
}

const processExists = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return !(error instanceof Error && "code" in error && error.code === "ESRCH")
  }
}

const inspectProcess = async (pid: number): Promise<{
  readonly exists: boolean
  readonly processGroupId: number | null
  readonly command: string | null
}> => {
  const result = await runCommand({
    command: "/bin/ps",
    commandArgs: ["-o", "pgid=", "-o", "command=", "-p", String(pid)],
  })

  if (result.exitCode !== 0) {
    return {
      exists: false,
      processGroupId: null,
      command: null,
    }
  }

  const output = result.stdout.trim()
  const match = output.match(/^(\d+)\s+(.*)$/s)

  if (!match) {
    return {
      exists: true,
      processGroupId: null,
      command: output.length > 0 ? output : null,
    }
  }

  return {
    exists: true,
    processGroupId: Number(match[1]),
    command: match[2]?.trim() || null,
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
      summary: `Stopped stale runner wrapper ${targetDescription} with SIGTERM.`,
      details: [inspection.command ?? "command line unavailable"],
    }
  }

  try {
    killRunnerTarget(pid, inspection.processGroupId, "SIGKILL")
  } catch {
    return {
      summary: `Runner wrapper ${targetDescription} ignored SIGTERM and Probe could not escalate to SIGKILL.`,
      details: [inspection.command ?? "command line unavailable"],
    }
  }

  await waitForProcessExit(pid, 1_000)

  return {
    summary: processExists(pid)
      ? `Probe escalated to SIGKILL for stale runner wrapper ${targetDescription}, but the process still appears live.`
      : `Probe escalated to SIGKILL for stale runner wrapper ${targetDescription}.`,
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
        nextStep: "Inspect the xcodebuild session log artifact and retry the session open.",
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

const assertReadyTransportContract = (args: {
  readonly ready: RunnerReadyFrame
  readonly expectedBootstrapPath: string
  readonly expectedControlDirectoryPath: string
  readonly expectedSessionIdentifier: string
  readonly expectedDeviceUdid: string
}): void => {
  if (args.ready.runnerTransportContract !== runnerTransportContract) {
    throw new EnvironmentError({
      code: "runner-transport-contract-mismatch",
      reason:
        `Expected runner transport contract ${runnerTransportContract}, received ${args.ready.runnerTransportContract}.`,
      nextStep: "Align the host and runner transport contract versions before retrying the session open.",
      details: [],
    })
  }

  if (args.ready.bootstrapSource !== "device-bootstrap-manifest") {
    throw new EnvironmentError({
      code: "runner-bootstrap-source-mismatch",
      reason:
        `Expected bootstrap source device-bootstrap-manifest, received ${args.ready.bootstrapSource}.`,
      nextStep: "Align the host bootstrap handoff and the runner bootstrap discovery path before retrying.",
      details: [],
    })
  }

  if (args.ready.bootstrapPath !== args.expectedBootstrapPath) {
    throw new EnvironmentError({
      code: "runner-bootstrap-path-mismatch",
      reason: `Expected runner bootstrap path ${args.expectedBootstrapPath}, received ${args.ready.bootstrapPath}.`,
      nextStep: "Inspect the device bootstrap manifest path and retry the session open.",
      details: [],
    })
  }

  if (args.ready.ingressTransport !== runnerCommandIngress || args.ready.egressTransport !== runnerEventEgress) {
    throw new EnvironmentError({
      code: "runner-transport-shape-mismatch",
      reason:
        `Expected ${runnerCommandIngress}/${runnerEventEgress}, received ${args.ready.ingressTransport}/${args.ready.egressTransport}.`,
      nextStep: "Align the host and runner transport settings before retrying the session open.",
      details: [],
    })
  }

  if (args.ready.simulatorUdid !== args.expectedDeviceUdid) {
    throw new EnvironmentError({
      code: "runner-device-identifier-mismatch",
      reason:
        `Expected the bootstrap manifest to carry device identifier ${args.expectedDeviceUdid} in simulatorUdid, received ${args.ready.simulatorUdid}.`,
      nextStep: "Rewrite the device bootstrap manifest with the selected device identifier and retry.",
      details: [],
    })
  }

  if (!args.ready.sessionIdentifier) {
    throw new EnvironmentError({
      code: "runner-session-identifier-missing",
      reason: "The runner ready frame did not report a session identifier for the active bootstrap manifest.",
      nextStep: "Inspect the runner bootstrap loading path and retry the session open.",
      details: [],
    })
  }

  if (args.ready.sessionIdentifier !== args.expectedSessionIdentifier) {
    throw new EnvironmentError({
      code: "runner-session-identifier-mismatch",
      reason:
        `Expected runner session identifier ${args.expectedSessionIdentifier}, received ${args.ready.sessionIdentifier}.`,
      nextStep: "Ensure the host wrote the correct device bootstrap manifest before retrying the session open.",
      details: [],
    })
  }

  if (args.ready.controlDirectoryPath !== args.expectedControlDirectoryPath) {
    throw new EnvironmentError({
      code: "runner-control-directory-mismatch",
      reason:
        `Expected control directory ${args.expectedControlDirectoryPath}, received ${args.ready.controlDirectoryPath}.`,
      nextStep: "Inspect the device bootstrap manifest control directory path and retry the session open.",
      details: [],
    })
  }
}

const startWrapperProcess = async (args: {
  readonly rootDir: string
  readonly projectPath: string
  readonly destination: string
  readonly observerControlDirectory: string
  readonly wrapperStderrPath: string
  readonly logPath: string
  readonly stdoutEventsPath: string
  readonly derivedDataPath: string
  readonly resultBundlePath: string
  readonly developmentTeam: string
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
      "--destination",
      args.destination,
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
      runnerScheme,
      "-derivedDataPath",
      args.derivedDataPath,
      "-resultBundlePath",
      args.resultBundlePath,
      `DEVELOPMENT_TEAM=${args.developmentTeam}`,
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

  const exit = new Promise<{ readonly code: number | null; readonly signal: string | null }>((resolve, reject) => {
    child.once("error", reject)
    child.once("exit", (code, signal) => resolve({ code, signal }))
  })

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

const buildPreflightWarnings = (): ReadonlyArray<string> => [
  "Real-device preflight validates DDI/device/signing prerequisites without claiming a live runner transport.",
  "Missing device connectivity, DDI drift, and signing regressions stay visible instead of being hidden behind simulator-style recovery assumptions.",
]

const buildLiveWarnings = (): ReadonlyArray<string> => [
  "Real-device runner control uses the same honest XCUITest boundary seam as simulator: bootstrap manifest plus file-mailbox ingress plus stdout-framed mixed-log egress.",
  "Device reconnects are surfaced explicitly in session health; Probe does not claim transparent recovery of real-device runner state.",
]

const performPreflight = async (args: {
  readonly rootDir: string
  readonly sessionId: string
  readonly artifactRoot: string
  readonly runnerDirectory: string
  readonly logsDirectory: string
  readonly bundleId: string
  readonly requestedDeviceId: string | null
}): Promise<PreflightContext> => {
  const projectPath = join(args.rootDir, "ios", "ProbeFixture", "ProbeFixture.xcodeproj")
  const metaDirectory = join(args.artifactRoot, "meta")
  const deviceLogsDirectory = join(args.logsDirectory, "device-preflight")
  const deviceRunnerDirectory = join(args.runnerDirectory, "device-preflight")
  const preferredDdiJsonPath = join(metaDirectory, "preferred-ddi.json")
  const devicesJsonPath = join(metaDirectory, "devices.json")
  const ddiServicesJsonPath = join(metaDirectory, "ddi-services.json")
  const preflightReportPath = join(metaDirectory, "real-device-preflight.json")
  const preferredDdiLogPath = join(deviceLogsDirectory, "devicectl-list-preferred-ddi.log")
  const devicesLogPath = join(deviceLogsDirectory, "devicectl-list-devices.log")
  const ddiServicesLogPath = join(deviceLogsDirectory, "devicectl-device-info-ddi-services.log")
  const buildLogPath = join(deviceLogsDirectory, "xcodebuild-build-for-testing-device.log")
  const derivedDataPath = join(deviceRunnerDirectory, "derived-data")

  await Promise.all([
    ensureDirectory(metaDirectory),
    ensureDirectory(deviceLogsDirectory),
    ensureDirectory(deviceRunnerDirectory),
  ])

  const preferredDdiResult = await runCommand({
    command: "/usr/bin/xcrun",
    commandArgs: ["devicectl", "list", "preferredDDI", "--json-output", preferredDdiJsonPath],
  })
  await writeCommandLog(preferredDdiLogPath, preferredDdiResult)

  const devicesResult = await runCommand({
    command: "/usr/bin/xcrun",
    commandArgs: ["devicectl", "list", "devices", "--json-output", devicesJsonPath],
  })
  await writeCommandLog(devicesLogPath, devicesResult)

  const issues: Array<PreflightIssue> = []

  if (preferredDdiResult.exitCode !== 0) {
    issues.push({
      summary: "CoreDevice preferred DDI discovery is not ready on this host.",
      nextStep: "Run `xcodebuild -runFirstLaunch -checkForNewerComponents` and `xcrun devicectl manage ddis update`, then retry the session open.",
      details: [formatCommandFailure("xcrun devicectl list preferredDDI", preferredDdiResult)],
    })
  }

  if (devicesResult.exitCode !== 0) {
    issues.push({
      summary: "CoreDevice device discovery is not ready on this host.",
      nextStep: "Inspect `xcrun devicectl list devices` and retry the session open after fixing the host toolchain state.",
      details: [formatCommandFailure("xcrun devicectl list devices", devicesResult)],
    })
  }

  const preferredDdiPayload = preferredDdiResult.exitCode === 0
    ? JSON.parse(await readFile(preferredDdiJsonPath, "utf8")) as DevicectlPreferredDdiPayload
    : null
  const devicesPayload = devicesResult.exitCode === 0
    ? JSON.parse(await readFile(devicesJsonPath, "utf8")) as DevicectlDevicesPayload
    : null
  const preferred = preferredDdiPayload?.result?.platforms?.iOS?.[0]
  const ddiUsable = preferred?.ddiMetadata?.isUsable === true
  const ddiCompatible = preferred?.ddiMetadata?.contentIsCompatible === true
  const hostCoreDeviceVersion = preferredDdiPayload?.result?.hostCoreDeviceVersion
    ?? preferredDdiPayload?.info?.version
    ?? "unknown"

  if (preferredDdiPayload && (!ddiUsable || !ddiCompatible)) {
    issues.push({
      summary: "The current host does not report a usable iOS DDI for CoreDevice.",
      nextStep: "Refresh Xcode components/DDIs, then retry once `devicectl list preferredDDI` reports a usable iOS DDI.",
      details: [
        `host CoreDevice version: ${hostCoreDeviceVersion}`,
        `usable: ${String(ddiUsable)}`,
        `content compatible: ${String(ddiCompatible)}`,
      ],
    })
  }

  const devices = devicesPayload ? extractDeviceCandidates(devicesPayload) : []
  let selectedDevice: RealDeviceCandidate | null = null
  let selectionError: UserInputError | EnvironmentError | null = null

  try {
    if (devicesPayload) {
      selectedDevice = resolveSelectedDevice({
        devices,
        requestedDeviceId: args.requestedDeviceId,
      })
    }
  } catch (error) {
    if (error instanceof UserInputError || error instanceof EnvironmentError) {
      selectionError = error
      issues.push({
        summary: error.reason,
        nextStep: error.nextStep,
        details: [...error.details],
      })
    } else {
      throw error
    }
  }

  const developmentTeam = process.env.PROBE_DEVELOPMENT_TEAM?.trim() ?? ""
  let xctestrunPath: string | null = null
  let targetAppPath: string | null = null
  let runnerAppPath: string | null = null
  let runnerXctestPath: string | null = null
  let buildCompleted = false

  if (developmentTeam.length === 0) {
    issues.push({
      summary: "PROBE_DEVELOPMENT_TEAM is required for real-device runner signing but is not set.",
      nextStep: "Export PROBE_DEVELOPMENT_TEAM=<your-team-id> (or add it to your local .env), then retry the real-device session open.",
      details: [
        "Probe passes DEVELOPMENT_TEAM from the host environment instead of committing a team identifier to source control.",
      ],
    })
  } else {
    const buildResult = await runCommand({
      command: "/usr/bin/xcodebuild",
      commandArgs: [
        "-project",
        projectPath,
        "-scheme",
        runnerScheme,
        "-destination",
        "generic/platform=iOS",
        "-derivedDataPath",
        derivedDataPath,
        `DEVELOPMENT_TEAM=${developmentTeam}`,
        "build-for-testing",
      ],
    })
    await writeCommandLog(buildLogPath, buildResult)

    if (buildResult.exitCode !== 0) {
      issues.push({
        summary: "The Probe runner could not complete a signed iPhoneOS build-for-testing preflight.",
        nextStep: "Fix the reported signing/provisioning issue, ensure the device is registered for development signing if needed, then retry the session open.",
        details: [
          formatCommandFailure("xcodebuild build-for-testing -destination generic/platform=iOS", buildResult),
          `build log: ${buildLogPath}`,
        ],
      })
    } else {
      buildCompleted = true
      const buildProductsPath = join(derivedDataPath, "Build", "Products")
      xctestrunPath = await findFirstMatchingPath(buildProductsPath, (name) => name.endsWith(".xctestrun"))
      targetAppPath = join(buildProductsPath, "Debug-iphoneos", "ProbeFixture.app")
      runnerAppPath = join(buildProductsPath, "Debug-iphoneos", "ProbeRunnerUITests-Runner.app")
      runnerXctestPath = join(runnerAppPath, "PlugIns", "ProbeRunnerUITests.xctest")

      if (!xctestrunPath || !(await fileExists(targetAppPath)) || !(await fileExists(runnerAppPath)) || !(await fileExists(runnerXctestPath))) {
        issues.push({
          summary: "The signed build-for-testing preflight did not emit the expected Probe runner artifacts.",
          nextStep: "Inspect the build products under the session artifact root and align the runner artifact contract before retrying.",
          details: [
            `xctestrun: ${xctestrunPath ?? "missing"}`,
            `target app: ${await fileExists(targetAppPath) ? targetAppPath : "missing"}`,
            `runner app: ${await fileExists(runnerAppPath) ? runnerAppPath : "missing"}`,
            `runner xctest: ${await fileExists(runnerXctestPath) ? runnerXctestPath : "missing"}`,
          ],
        })
      }
    }
  }

  let ddiServicesReady = false

  if (selectedDevice && preferredDdiPayload && ddiUsable && ddiCompatible) {
    const ddiServicesResult = await runCommand({
      command: "/usr/bin/xcrun",
      commandArgs: [
        "devicectl",
        "device",
        "info",
        "ddiServices",
        "--device",
        selectedDevice.identifier,
        "--json-output",
        ddiServicesJsonPath,
      ],
    })
    await writeCommandLog(ddiServicesLogPath, ddiServicesResult)

    if (ddiServicesResult.exitCode !== 0) {
      issues.push({
        summary: `The selected device ${selectedDevice.name} (${selectedDevice.identifier}) did not pass the CoreDevice DDI-services preflight.`,
        nextStep: "Confirm the device is paired, trusted, in Developer Mode, and compatible with the selected Xcode/DDI, then retry the session open.",
        details: [
          formatCommandFailure("xcrun devicectl device info ddiServices", ddiServicesResult),
        ],
      })
    } else {
      ddiServicesReady = true
    }
  }

  const integrationPoints = [
    "xcrun devicectl list preferredDDI --json-output <path>",
    "xcrun devicectl list devices --json-output <path>",
    ...(selectedDevice ? [`xcrun devicectl device info ddiServices --device ${selectedDevice.identifier} --json-output <path>`] : []),
    ...(selectedDevice ? [`xcrun devicectl device info apps --device ${selectedDevice.identifier} --bundle-id ${args.bundleId} --json-output <path>`] : []),
    ...(selectedDevice ? [`xcrun devicectl device process launch --device ${selectedDevice.identifier} --terminate-existing ${args.bundleId} --json-output <path>`] : []),
    ...(buildCompleted ? [
      `xcodebuild build-for-testing -destination generic/platform=iOS DEVELOPMENT_TEAM=${developmentTeam}`,
      `xcodebuild test-without-building -destination platform=iOS,id=<udid> DEVELOPMENT_TEAM=${developmentTeam}`,
    ] : []),
  ] as const

  const report = {
    generatedAt: nowIso(),
    bundleId: args.bundleId,
    requestedDeviceId: args.requestedDeviceId,
    selectedDevice: selectedDevice
      ? {
          identifier: selectedDevice.identifier,
          name: selectedDevice.name,
          runtime: selectedDevice.runtime,
        }
      : null,
    hostCoreDeviceVersion,
    preferredDdi: {
      path: preferred?.hostDDI ?? null,
      usable: ddiUsable,
      contentCompatible: ddiCompatible,
    },
    signing: {
      developmentTeam: developmentTeam || null,
      buildLogPath: buildCompleted ? buildLogPath : null,
      xctestrunPath,
      targetAppPath,
      runnerAppPath,
      runnerXctestPath,
    },
    ddiServices: {
      checked: selectedDevice !== null && preferredDdiPayload !== null && ddiUsable && ddiCompatible,
      ready: ddiServicesReady,
      jsonPath: ddiServicesReady ? ddiServicesJsonPath : null,
    },
    integrationPoints: [...integrationPoints],
    issues: issues.map((issue) => ({
      summary: issue.summary,
      nextStep: issue.nextStep,
      details: [...issue.details],
    })),
  }
  await writeFile(preflightReportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8")

  if (selectionError instanceof UserInputError && issues.every((issue) => issue.summary === selectionError.reason)) {
    throw selectionError
  }

  if (issues.length > 0 || !selectedDevice || !xctestrunPath || !targetAppPath || !runnerAppPath || !runnerXctestPath) {
    throw new EnvironmentError({
      code: "real-device-preflight-blocked",
      reason: "Real-device session preflight failed before Probe could establish a truthful device session.",
      nextStep: issues[0]?.nextStep
        ?? "Inspect the real-device preflight details and retry after satisfying the missing prerequisites.",
      details: issues.flatMap((issue) => [issue.summary, ...issue.details]),
    })
  }

  const refreshConnection = async (): Promise<SessionConnectionDetails> => {
    const refreshedResult = await runCommand({
      command: "/usr/bin/xcrun",
      commandArgs: ["devicectl", "list", "devices", "--json-output", devicesJsonPath],
    })
    await writeCommandLog(devicesLogPath, refreshedResult)

    if (refreshedResult.exitCode !== 0) {
      return createConnectionDetails({
        status: "disconnected",
        device: selectedDevice,
        details: [formatCommandFailure("xcrun devicectl list devices", refreshedResult)],
      })
    }

    const refreshedPayload = JSON.parse(await readFile(devicesJsonPath, "utf8")) as DevicectlDevicesPayload
    const refreshedDevices = extractDeviceCandidates(refreshedPayload)
    const stillConnected = refreshedDevices.some((device) => device.identifier === selectedDevice.identifier)

    return createConnectionDetails({
      status: stillConnected ? "connected" : "disconnected",
      device: selectedDevice,
      details: stillConnected
        ? [`device runtime: ${selectedDevice.runtime ?? "unknown"}`]
        : [
            "CoreDevice no longer reports the selected device in `devicectl list devices`.",
            "Reconnect the device, confirm trust/Developer Mode, then poll session health again.",
          ],
    })
  }

  return {
    mode: "preflight",
    device: {
      identifier: selectedDevice.identifier,
      name: selectedDevice.name,
      runtime: selectedDevice.runtime,
    },
    bundleId: args.bundleId,
    hostCoreDeviceVersion,
    preferredDdiPath: preferred?.hostDDI ?? null,
    preferredDdiJsonPath,
    devicesJsonPath,
    ddiServicesJsonPath: ddiServicesReady ? ddiServicesJsonPath : null,
    preflightReportPath,
    buildLogPath,
    xctestrunPath,
    targetAppPath,
    runnerAppPath,
    runnerXctestPath,
    integrationPoints: [...integrationPoints],
    warnings: buildPreflightWarnings(),
    connection: createConnectionDetails({
      status: "connected",
      device: selectedDevice,
      details: [`device runtime: ${selectedDevice.runtime ?? "unknown"}`],
    }),
    refreshConnection,
    close: async () => undefined,
    projectPath,
    derivedDataPath,
    developmentTeam,
    selectedDevice,
    metaDirectory,
  }
}

export class RealDeviceHarness extends Context.Tag("@probe/RealDeviceHarness")<
  RealDeviceHarness,
  {
    readonly openPreflightSession: (args: {
      readonly rootDir: string
      readonly sessionId: string
      readonly artifactRoot: string
      readonly runnerDirectory: string
      readonly logsDirectory: string
      readonly bundleId: string
      readonly requestedDeviceId: string | null
    }) => Effect.Effect<OpenedRealDevicePreflightSession, EnvironmentError | UserInputError>
    readonly openLiveSession: (args: {
      readonly rootDir: string
      readonly sessionId: string
      readonly artifactRoot: string
      readonly runnerDirectory: string
      readonly logsDirectory: string
      readonly bundleId: string
      readonly requestedDeviceId: string | null
    }) => Effect.Effect<OpenedRealDeviceLiveSession, EnvironmentError | UserInputError | ChildProcessError>
  }
>() {}

export const RealDeviceHarnessLive = Layer.succeed(
  RealDeviceHarness,
  RealDeviceHarness.of({
    openPreflightSession: (args) =>
      Effect.tryPromise({
        try: async () => {
          const preflight = await performPreflight(args)

          return {
            mode: "preflight",
            device: preflight.device,
            bundleId: preflight.bundleId,
            hostCoreDeviceVersion: preflight.hostCoreDeviceVersion,
            preferredDdiPath: preflight.preferredDdiPath,
            preferredDdiJsonPath: preflight.preferredDdiJsonPath,
            devicesJsonPath: preflight.devicesJsonPath,
            ddiServicesJsonPath: preflight.ddiServicesJsonPath,
            preflightReportPath: preflight.preflightReportPath,
            buildLogPath: preflight.buildLogPath,
            xctestrunPath: preflight.xctestrunPath,
            targetAppPath: preflight.targetAppPath,
            runnerAppPath: preflight.runnerAppPath,
            runnerXctestPath: preflight.runnerXctestPath,
            integrationPoints: preflight.integrationPoints,
            warnings: preflight.warnings,
            connection: preflight.connection,
            refreshConnection: preflight.refreshConnection,
            close: preflight.close,
          } satisfies OpenedRealDevicePreflightSession
        },
        catch: (error) =>
          error instanceof UserInputError || error instanceof EnvironmentError
            ? error
            : new EnvironmentError({
                code: "real-device-preflight",
                reason: error instanceof Error ? error.message : String(error),
                nextStep: "Inspect the real-device preflight artifacts and retry once the missing prerequisites are satisfied.",
                details: [],
              }),
      }),
    openLiveSession: (args) => {
      let wrapper: Awaited<ReturnType<typeof startWrapperProcess>> | null = null
      let bootstrapPath: string | null = null

      return Effect.tryPromise({
        try: async () => {
          try {
            const preflight = await performPreflight(args)
            const liveLogsDirectory = join(args.logsDirectory, "device-live")
            const installedAppsJsonPath = join(preflight.metaDirectory, "installed-apps.json")
            const launchJsonPath = join(preflight.metaDirectory, "target-app-launch.json")
            const installedAppsLogPath = join(liveLogsDirectory, "devicectl-device-info-apps.log")
            const launchLogPath = join(liveLogsDirectory, "devicectl-device-process-launch.log")
            const sessionLogPath = join(liveLogsDirectory, "xcodebuild-session.log")
            const wrapperStderrPath = join(liveLogsDirectory, "runner-wrapper.stderr.log")
            const observerControlDirectory = join(args.runnerDirectory, "observer-control")
            const runtimeControlDirectory = join(args.runnerDirectory, "runtime-control")
            const stdoutEventsPath = join(args.runnerDirectory, "stdout-events.ndjson")
            const resultBundlePath = join(args.runnerDirectory, "ProbeRunnerTransportBoundary.xcresult")
            const destination = `platform=iOS,id=${preflight.device.identifier}`

            await Promise.all([
              ensureDirectory(liveLogsDirectory),
              ensureDirectory(args.runnerDirectory),
              ensureDirectory(observerControlDirectory),
              ensureDirectory(runtimeControlDirectory),
            ])

            const installedAppsResult = await runCommand({
              command: "/usr/bin/xcrun",
              commandArgs: [
                "devicectl",
                "device",
                "info",
                "apps",
                "--device",
                preflight.device.identifier,
                "--bundle-id",
                args.bundleId,
                "--json-output",
                installedAppsJsonPath,
              ],
            })
            await writeCommandLog(installedAppsLogPath, installedAppsResult)

            if (installedAppsResult.exitCode !== 0) {
              throw new EnvironmentError({
                code: "target-app-install-check-failed",
                reason:
                  `Probe could not verify that ${args.bundleId} is installed on ${preflight.device.name} (${preflight.device.identifier}).`,
                nextStep:
                  "Confirm the device is paired, trusted, in Developer Mode, and reachable to devicectl, then retry the session open.",
                details: [
                  formatCommandFailure("xcrun devicectl device info apps", installedAppsResult),
                  `device: ${preflight.device.name} (${preflight.device.identifier})`,
                ],
              })
            }

            const installedAppsPayload = JSON.parse(await readFile(installedAppsJsonPath, "utf8")) as unknown

            if (!appListContainsBundleIdentifier(installedAppsPayload, args.bundleId)) {
              throw new EnvironmentError({
                code: "target-app-not-installed",
                reason:
                  `Target app ${args.bundleId} is not installed on ${preflight.device.name} (${preflight.device.identifier}).`,
                nextStep:
                  "Install the target app on the device (via Xcode, `devicectl device install app`, or your existing build pipeline), then retry the session open.",
                details: [
                  `bundle id: ${args.bundleId}`,
                  `device: ${preflight.device.name} (${preflight.device.identifier})`,
                  `apps json: ${installedAppsJsonPath}`,
                ],
              })
            }

            const launchResult = await runCommand({
              command: "/usr/bin/xcrun",
              commandArgs: [
                "devicectl",
                "device",
                "process",
                "launch",
                "--device",
                preflight.device.identifier,
                "--terminate-existing",
                args.bundleId,
                "--json-output",
                launchJsonPath,
              ],
            })
            await writeCommandLog(launchLogPath, launchResult)

            if (launchResult.exitCode !== 0) {
              throw new EnvironmentError({
                code: "target-app-launch-failed",
                reason: `Probe could not launch ${args.bundleId} on ${preflight.device.name} (${preflight.device.identifier}).`,
                nextStep: "Confirm the app is installed, launchable, and trusted on the device, then retry the session open.",
                details: [
                  formatCommandFailure("xcrun devicectl device process launch", launchResult),
                  `launch json: ${launchJsonPath}`,
                ],
              })
            }

            const launchPayload = JSON.parse(await readFile(launchJsonPath, "utf8")) as unknown
            const targetProcessId = parseLaunchedTargetProcessId(launchPayload, args.bundleId)

            if (targetProcessId === null) {
              throw new EnvironmentError({
                code: "target-app-launch-pid-parse",
                reason:
                  `Probe could not extract a target process id from devicectl launch output for ${args.bundleId}.`,
                nextStep: "Inspect the saved process-launch JSON and align the device pid parsing contract before retrying.",
                details: [launchJsonPath],
              })
            }

            bootstrapPath = join(runnerBootstrapRootPath, `device-${preflight.device.identifier}.json`)
            await writeBootstrapManifest({
              bootstrapPath,
              controlDirectoryPath: runtimeControlDirectory,
              sessionIdentifier: args.sessionId,
              simulatorUdid: preflight.device.identifier,
              targetBundleId: args.bundleId,
            })

            const startedAt = Date.now()
            wrapper = await startWrapperProcess({
              rootDir: args.rootDir,
              projectPath: preflight.projectPath,
              destination,
              observerControlDirectory,
              wrapperStderrPath,
              logPath: sessionLogPath,
              stdoutEventsPath,
              derivedDataPath: preflight.derivedDataPath,
              resultBundlePath,
              developmentTeam: preflight.developmentTeam,
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

            const ready = await waitForFreshJson<RunnerReadyFrame>({
              path: join(observerControlDirectory, "stdout-ready.json"),
              timeoutMs: runnerReadyTimeoutMs,
              minMtimeMs: startedAt,
              isRunning: isWrapperRunning,
              decode: decodeRunnerReadyFrame,
              invalidCode: "runner-ready-frame-invalid",
              invalidReason: "The runner ready frame drifted from the validated host↔runner contract",
              invalidNextStep: "Align the host and runner transport schemas before retrying the session open.",
              commandDescription: "runner stdout ready",
              logPath: sessionLogPath,
            })

            assertReadyTransportContract({
              ready,
              expectedBootstrapPath: bootstrapPath,
              expectedControlDirectoryPath: runtimeControlDirectory,
              expectedSessionIdentifier: args.sessionId,
              expectedDeviceUdid: preflight.device.identifier,
            })

            const stdinProbe = await waitForFreshJson<RunnerStdinProbeResultFrame>({
              path: join(observerControlDirectory, "stdout-stdin-probe-result.json"),
              timeoutMs: runnerReadyTimeoutMs,
              minMtimeMs: startedAt,
              isRunning: isWrapperRunning,
              decode: decodeRunnerStdinProbeResultFrame,
              invalidCode: "runner-stdin-probe-frame-invalid",
              invalidReason: "The runner stdin-probe frame drifted from the validated host↔runner contract",
              invalidNextStep: "Align the host and runner stdin-probe schemas before retrying the session open.",
              commandDescription: "runner stdout stdin-probe-result",
              logPath: sessionLogPath,
            })

            const sendCommand = async (
              sequence: number,
              action: "ping" | "applyInput" | "snapshot" | "screenshot" | "recordVideo" | "shutdown" | "uiAction",
              payload?: string,
            ): Promise<RunnerCommandResult> => {
              const commandStartedAt = Date.now()
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

              const stdoutResponse = await waitForFreshJson<RunnerResponseFrame>({
                path: stdoutResponsePath,
                timeoutMs: resolveCommandTimeoutMs(action, payload),
                minMtimeMs: commandStartedAt,
                isRunning: isWrapperRunning,
                decode: decodeRunnerResponseFrame,
                invalidCode: "runner-response-frame-invalid",
                invalidReason: "The runner response frame drifted from the validated host↔runner contract",
                invalidNextStep: "Align the host and runner response schemas before retrying the command.",
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
                hostRttMs: Date.now() - commandStartedAt,
              }
            }

            const initialPing = await sendCommand(1, "ping", "session-open")

            if (!initialPing.ok) {
              throw new EnvironmentError({
                code: "runner-open-ping-failed",
                reason: "The runner did not acknowledge the initial ping command after session open.",
                nextStep: "Inspect the session runner log artifact and retry the session open.",
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
              mode: "live",
              device: preflight.device,
              bundleId: preflight.bundleId,
              hostCoreDeviceVersion: preflight.hostCoreDeviceVersion,
              preferredDdiPath: preflight.preferredDdiPath,
              preferredDdiJsonPath: preflight.preferredDdiJsonPath,
              devicesJsonPath: preflight.devicesJsonPath,
              ddiServicesJsonPath: preflight.ddiServicesJsonPath,
              preflightReportPath: preflight.preflightReportPath,
              buildLogPath: preflight.buildLogPath,
              xctestrunPath: preflight.xctestrunPath,
              targetAppPath: preflight.targetAppPath,
              runnerAppPath: preflight.runnerAppPath,
              runnerXctestPath: preflight.runnerXctestPath,
              integrationPoints: preflight.integrationPoints,
              warnings: buildLiveWarnings(),
              connection: preflight.connection,
              refreshConnection: preflight.refreshConnection,
              close,
              bootstrapPath: ready.bootstrapPath,
              bootstrapSource: "device-bootstrap-manifest",
              runnerTransportContract: ready.runnerTransportContract,
              sessionIdentifier: ready.sessionIdentifier,
              commandIngress: ready.ingressTransport,
              eventEgress: ready.egressTransport,
              wrapperProcessId: wrapper.process.pid ?? -1,
              testProcessId: ready.processIdentifier,
              targetProcessId,
              attachLatencyMs: ready.attachLatencyMs,
              runtimeControlDirectory: ready.controlDirectoryPath,
              observerControlDirectory,
              logPath: sessionLogPath,
              stdoutEventsPath,
              resultBundlePath,
              wrapperStderrPath,
              stdinProbeStatus: stdinProbe.status,
              installedAppsJsonPath,
              launchJsonPath,
              nextSequence: 2,
              initialPingRttMs: initialPing.hostRttMs,
              sendCommand,
              isWrapperRunning,
              waitForExit: wrapper.exit,
            } satisfies OpenedRealDeviceLiveSession
          } catch (error) {
            if (wrapper !== null) {
              await stopWrapperProcess(wrapper).catch(() => undefined)
              wrapper = null
            }

            if (bootstrapPath !== null) {
              await removeFileIfExists(bootstrapPath)
              bootstrapPath = null
            }

            throw error
          }
        },
        catch: (error) =>
          error instanceof UserInputError
          || error instanceof EnvironmentError
          || error instanceof ChildProcessError
            ? error
            : new EnvironmentError({
                code: "real-device-live-session",
                reason: error instanceof Error ? error.message : String(error),
                nextStep: "Inspect the real-device session artifacts and retry once the missing prerequisites are satisfied.",
                details: [],
              }),
      })
    },
  }),
)
