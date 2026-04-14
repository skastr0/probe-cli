import { spawn, type ChildProcess } from "node:child_process"
import { access, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { Context, Effect, Layer } from "effect"
import {
  ChildProcessError,
  DeviceInterruptionError,
  type DeviceInterruptionSignal,
  EnvironmentError,
  UserInputError,
} from "../domain/errors"
import type { SessionConnectionDetails } from "../domain/session"
import type { RunnerCommandResult } from "./SimulatorHarness"
import {
  decodeRunnerReadyFrame,
  decodeRunnerResponseFrame,
  encodeRunnerCommandFrame,
  RUNNER_EVENT_EGRESS,
  RUNNER_HTTP_COMMAND_INGRESS,
  RUNNER_TRANSPORT_CONTRACT,
  type RunnerAction,
  type RunnerBootstrapManifest,
  type RunnerReadyFrame,
  type RunnerResponseFrame,
} from "./runnerProtocol"
import {
  probeRunnerDeviceDerivedRootPath,
  resolveProbeFixtureProjectPath,
  resolveProbeRunnerWrapperScriptPath,
} from "./ProjectRoot"

const runnerScheme = "ProbeRunner"
const commandPollIntervalMs = 50
const runnerReadyTimeoutMs = 120_000
const commandTimeoutMs = 20_000
const recordVideoTimeoutBufferMs = 30_000
const maxRecordVideoDurationMs = 120_000
const defaultRecordVideoDurationMs = 10_000
const runnerArtifactDownloadTimeoutMs = 15_000
const runnerBootstrapRootPath = "/tmp/probe-runner-bootstrap"
const runnerTransportContract = RUNNER_TRANSPORT_CONTRACT
const runnerCommandIngress = RUNNER_HTTP_COMMAND_INGRESS
const runnerEventEgress = RUNNER_EVENT_EGRESS
const runnerBootstrapEnvKey = "PROBE_BOOTSTRAP_JSON"
const runnerPortEnvKey = "PROBE_RUNNER_PORT"
const runnerInjectedBootstrapPath = `env:${runnerBootstrapEnvKey}`
const xctestrunMetadataKey = "__xctestrun_metadata__"
const deviceInterruptionAttachLatencyThresholdMs = 30_000
const maxInterruptionEvidenceLines = 3
const commonDeviceInterruptionNextStep =
  "Unlock the device, dismiss any passcode/trust/Developer Mode prompt, then retry. If the device disconnected while you fixed it, reconnect it first."

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

const resolveRealDeviceRunnerDerivedDataPath = (): string => probeRunnerDeviceDerivedRootPath

interface DeviceInterruptionPattern {
  readonly signal: DeviceInterruptionSignal
  readonly pattern: RegExp
  readonly reason: string
  readonly nextStep: string
}

export interface RealDeviceInterruptionObservation {
  readonly signal: DeviceInterruptionSignal
  readonly evidenceKind: "direct" | "inferred"
  readonly reason: string
  readonly nextStep: string
  readonly details: ReadonlyArray<string>
}

interface DeviceInterruptionEvidenceSource {
  readonly label: string
  readonly text: string
}

const deviceInterruptionPatterns: ReadonlyArray<DeviceInterruptionPattern> = [
  {
    signal: "passcode-required",
    pattern: /type device passcode|enter passcode|\bpasscode\b/i,
    reason: "The real device appears to be blocked by a passcode prompt.",
    nextStep: "Unlock the device, dismiss the passcode prompt, then retry the Probe session.",
  },
  {
    signal: "device-locked",
    pattern: /device locked|lock screen|locked device/i,
    reason: "The real device appears to be locked.",
    nextStep: "Unlock the device, bring the target app back to the foreground if needed, then retry the Probe session.",
  },
  {
    signal: "trust-required",
    pattern: /trust this (?:computer|device)|confirm trust|device is not trusted/i,
    reason: "The real device appears to be waiting for a trust confirmation.",
    nextStep: "Accept the trust prompt on the device, then retry the Probe session.",
  },
  {
    signal: "developer-mode-required",
    pattern: /developer mode/i,
    reason: "The real device appears to be waiting for a Developer Mode confirmation.",
    nextStep: "Confirm or enable Developer Mode on the device, then retry the Probe session.",
  },
]

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

interface DevicectlDeviceDetailsPayload {
  readonly info?: {
    readonly outcome?: string
  }
  readonly result?: {
    readonly connectionProperties?: {
      readonly tunnelIPAddress?: string
    }
    readonly device?: {
      readonly connectionProperties?: {
        readonly tunnelIPAddress?: string
      }
    }
  }
}

interface RealDeviceCandidate {
  readonly identifier: string
  readonly name: string
  readonly runtime: string | null
  readonly matchKeys: ReadonlyArray<string>
}

interface RunnerVideoArtifactManifest {
  readonly durationMs: number
  readonly fps: number
  readonly frameCount: number
}

type DeviceDiagnosticCaptureMode = "diagnose" | "sysdiagnose"

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

interface XmlElementRange {
  readonly start: number
  readonly end: number
  readonly tagName: string
  readonly raw: string
}

interface DictEntryRange {
  readonly key: string
  readonly keyRange: XmlElementRange
  readonly valueRange: XmlElementRange
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
  readonly commandIngress: RunnerReadyFrame["ingressTransport"]
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

const readTextIfExists = async (path: string | null | undefined): Promise<string> => {
  if (!path || !(await fileExists(path))) {
    return ""
  }

  try {
    return await readFile(path, "utf8")
  } catch {
    return ""
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

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

const collectMatchingEvidenceLines = (args: {
  readonly text: string
  readonly pattern: RegExp
  readonly limit?: number
}): ReadonlyArray<string> => {
  if (args.text.trim().length === 0) {
    return []
  }

  const lines = args.text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)

  const matches: Array<string> = []
  const limit = args.limit ?? maxInterruptionEvidenceLines

  for (const line of lines) {
    if (args.pattern.test(line)) {
      matches.push(line)

      if (matches.length >= limit) {
        break
      }
    }
  }

  return matches
}

const buildDeviceInterruptionCode = (signal: DeviceInterruptionSignal): string => `device-interruption-${signal}`

export const buildRealDeviceInterruptionWarning = (
  observation: RealDeviceInterruptionObservation,
): string => `${observation.reason} ${observation.nextStep}`

export const toDeviceInterruptionError = (
  observation: RealDeviceInterruptionObservation,
): DeviceInterruptionError =>
  new DeviceInterruptionError({
    code: buildDeviceInterruptionCode(observation.signal),
    signal: observation.signal,
    reason: observation.reason,
    nextStep: observation.nextStep,
    details: [...observation.details],
  })

export const detectRealDeviceInterruption = async (args: {
  readonly targetBundleId: string
  readonly device: {
    readonly identifier: string
    readonly name: string
  }
  readonly observedLatencyMs?: number | null
  readonly statusLabel?: string | null
  readonly logPath?: string | null
  readonly wrapperStderrPath?: string | null
  readonly evidenceSources?: ReadonlyArray<DeviceInterruptionEvidenceSource>
}): Promise<RealDeviceInterruptionObservation | null> => {
  const sessionLogText = await readTextIfExists(args.logPath)
  const wrapperStderrText = await readTextIfExists(args.wrapperStderrPath)
  const evidenceSources: Array<DeviceInterruptionEvidenceSource> = [
    ...(args.statusLabel && args.statusLabel.trim().length > 0
      ? [{ label: "runner status label", text: args.statusLabel }]
      : []),
    ...(args.evidenceSources ?? []),
    ...(sessionLogText.trim().length > 0
      ? [{ label: "xcodebuild session log", text: sessionLogText }]
      : []),
    ...(wrapperStderrText.trim().length > 0
      ? [{ label: "runner wrapper stderr", text: wrapperStderrText }]
      : []),
  ]
  const deviceDetail = `device: ${args.device.name} (${args.device.identifier})`

  for (const pattern of deviceInterruptionPatterns) {
    for (const source of evidenceSources) {
      const matches = collectMatchingEvidenceLines({
        text: source.text,
        pattern: pattern.pattern,
      })

      if (matches.length > 0) {
        return {
          signal: pattern.signal,
          evidenceKind: "direct",
          reason: pattern.reason,
          nextStep: pattern.nextStep,
          details: [
            deviceDetail,
            ...matches.map((match) => `${source.label}: ${match}`),
          ],
        }
      }
    }
  }

  const observedLatencyMs = args.observedLatencyMs ?? null
  if (observedLatencyMs === null || observedLatencyMs < deviceInterruptionAttachLatencyThresholdMs) {
    return null
  }

  const foregroundWaitPattern = new RegExp(
    `Wait for ${escapeRegExp(args.targetBundleId)} to become Running Foreground`,
    "g",
  )
  const foregroundWaitCount = sessionLogText.match(foregroundWaitPattern)?.length ?? 0

  if (foregroundWaitCount < 2) {
    return null
  }

  return {
    signal: "target-foreground-blocked",
    evidenceKind: "inferred",
    reason:
      `Real-device attach took ${observedLatencyMs} ms while XCTest kept waiting for ${args.targetBundleId} to reach foreground. The device was likely blocked by the lock screen, a passcode prompt, or a trust/Developer Mode interruption.`,
    nextStep: commonDeviceInterruptionNextStep,
    details: [
      deviceDetail,
      `attach latency ms: ${observedLatencyMs}`,
      `foreground waits: ${foregroundWaitCount}`,
      ...collectMatchingEvidenceLines({
        text: sessionLogText,
        pattern: new RegExp(`Wait for ${escapeRegExp(args.targetBundleId)} to become Running Foreground`),
      }).map((match) => `xcodebuild session log: ${match}`),
    ],
  }
}

const runCommand = async (args: {
  readonly command: string
  readonly commandArgs: ReadonlyArray<string>
  readonly timeoutMs?: number
}): Promise<CommandResult> =>
  await new Promise((resolve, reject) => {
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

    child.once("error", reject)
    child.once("close", (exitCode) => {
      if (timeout) {
        clearTimeout(timeout)
      }

      if (timedOut) {
        reject(new Error(`${args.command} timed out after ${args.timeoutMs ?? 0} ms.`))
        return
      }

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

const toNonEmptyText = (value: unknown): string | null => {
  const text = toText(value)
  return text && text.trim().length > 0 ? text.trim() : null
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

export const buildRealDeviceBuildForTestingCommandArgs = (args: {
  readonly projectPath: string
  readonly derivedDataPath: string
  readonly developmentTeam: string
}): ReadonlyArray<string> => [
  "-project",
  args.projectPath,
  "-scheme",
  runnerScheme,
  "-destination",
  "generic/platform=iOS",
  "-derivedDataPath",
  args.derivedDataPath,
  "-allowProvisioningUpdates",
  "-allowProvisioningDeviceRegistration",
  `DEVELOPMENT_TEAM=${args.developmentTeam}`,
  "build-for-testing",
]

const inferBuildForTestingNextStep = (result: CommandResult): string => {
  const combined = `${result.stdout}\n${result.stderr}`

  if (/No Accounts:/i.test(combined)) {
    return "Open Xcode > Settings > Accounts, sign in to an Apple Developer account for the configured team, then retry the real-device session open."
  }

  if (/No profiles for /i.test(combined)) {
    return "Ensure Xcode can create or download development provisioning profiles for the Probe runner bundle ids, then retry the real-device session open."
  }

  return "Fix the reported signing/provisioning issue, ensure the device is registered for development signing if needed, then retry the session open."
}

const captureDeviceDiagnosticBundle = async (args: {
  readonly deviceId: string
  readonly diagnosticsDirectory: string
  readonly fileStem: string
  readonly kind: DeviceDiagnosticCaptureMode
}): Promise<{ readonly absolutePath: string }> => {
  await ensureDirectory(args.diagnosticsDirectory)

  if (args.kind === "diagnose") {
    const absolutePath = join(args.diagnosticsDirectory, `${args.fileStem}.zip`)
    const jsonOutputPath = join(args.diagnosticsDirectory, `${args.fileStem}.diagnose.json`)
    const logOutputPath = join(args.diagnosticsDirectory, `${args.fileStem}.diagnose.log`)
    await removeFileIfExists(absolutePath)

    const result = await runCommand({
      command: "/usr/bin/xcrun",
      commandArgs: [
        "devicectl",
        "diagnose",
        "--devices",
        args.deviceId,
        "--archive-destination",
        absolutePath,
        "--no-finder",
        "--json-output",
        jsonOutputPath,
        "--log-output",
        logOutputPath,
      ],
      timeoutMs: 60 * 60_000,
    })

    if (result.exitCode !== 0) {
      throw new EnvironmentError({
        code: "device-diagnostic-capture",
        reason: formatCommandFailure("xcrun devicectl diagnose", result),
        nextStep: "Inspect devicectl diagnose output and retry the device diagnostic capture.",
        details: [logOutputPath],
      })
    }

    if (!(await fileExists(absolutePath))) {
      throw new EnvironmentError({
        code: "device-diagnostic-capture",
        reason: `devicectl diagnose completed without creating ${absolutePath}.`,
        nextStep: "Inspect the diagnostics directory and retry the device diagnostic capture.",
        details: [jsonOutputPath, logOutputPath],
      })
    }

    return { absolutePath }
  }

  const destinationDirectory = join(args.diagnosticsDirectory, `${args.fileStem}.sysdiagnose`)
  const jsonOutputPath = join(args.diagnosticsDirectory, `${args.fileStem}.sysdiagnose.json`)
  const logOutputPath = join(args.diagnosticsDirectory, `${args.fileStem}.sysdiagnose.log`)

  await ensureDirectory(destinationDirectory)

  const result = await runCommand({
    command: "/usr/bin/xcrun",
    commandArgs: [
      "devicectl",
      "device",
      "sysdiagnose",
      "--device",
      args.deviceId,
      "--destination",
      destinationDirectory,
      "--json-output",
      jsonOutputPath,
      "--log-output",
      logOutputPath,
    ],
    timeoutMs: 60 * 60_000,
  })

  if (result.exitCode !== 0) {
    throw new EnvironmentError({
      code: "device-sysdiagnose-capture",
      reason: formatCommandFailure("xcrun devicectl device sysdiagnose", result),
      nextStep: "Inspect devicectl sysdiagnose output and retry the device diagnostic capture.",
      details: [logOutputPath],
    })
  }

  const absolutePath = await findNewestFileInDirectory(destinationDirectory)

  if (absolutePath === null) {
    throw new EnvironmentError({
      code: "device-sysdiagnose-capture",
      reason: `devicectl device sysdiagnose completed without producing a bundle under ${destinationDirectory}.`,
      nextStep: "Inspect the destination directory and retry the device sysdiagnose capture.",
      details: [jsonOutputPath, logOutputPath],
    })
  }

  return { absolutePath }
}

export const extractDeviceCandidate = (value: unknown): RealDeviceCandidate | null => {
  if (!isRecord(value)) {
    return null
  }

  const coreDeviceIdentifier = readFirstText(value, [
    ["identifier"],
    ["deviceIdentifier"],
    ["deviceId"],
    ["deviceProperties", "identifier"],
  ])

  const hardwareUdid = readFirstText(value, [
    ["hardwareProperties", "udid"],
    ["connectionProperties", "udid"],
    ["udid"],
    ["uuid"],
  ])

  const identifier = hardwareUdid ?? coreDeviceIdentifier ?? readFirstText(value, [
    ["serialNumber"],
    ["ecid"],
    ["hardwareProperties", "udid"],
    ["hardwareProperties", "serialNumber"],
    ["hardwareProperties", "ecid"],
    ["connectionProperties", "udid"],
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
      ...(coreDeviceIdentifier && coreDeviceIdentifier !== identifier ? [coreDeviceIdentifier] : []),
      ...(hardwareUdid && hardwareUdid !== identifier ? [hardwareUdid] : []),
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

export const extractDeviceTunnelIp = (payload: DevicectlDeviceDetailsPayload): string | null => {
  if (payload.info?.outcome && payload.info.outcome !== "success") {
    return null
  }

  return toNonEmptyText(
    payload.result?.connectionProperties?.tunnelIPAddress
      ?? payload.result?.device?.connectionProperties?.tunnelIPAddress
      ?? null,
  )
}

export const buildRunnerHttpCommandUrls = (args: {
  readonly port: number
  readonly tunnelIp: string | null
}): ReadonlyArray<string> => {
  const urls = [`http://127.0.0.1:${args.port}/command`]

  if (args.tunnelIp) {
    urls.unshift(`http://[${args.tunnelIp}]:${args.port}/command`)
  }

  return urls
}

export const buildRunnerHttpArtifactUrls = (args: {
  readonly commandUrls: ReadonlyArray<string>
  readonly artifactPath: string
}): ReadonlyArray<string> =>
  args.commandUrls.map((commandUrl) => {
    const artifactUrl = new URL(commandUrl)
    artifactUrl.pathname = "/artifact"
    artifactUrl.search = ""
    artifactUrl.searchParams.set("path", args.artifactPath)
    return artifactUrl.toString()
  })

export const decodeRunnerVideoArtifactManifest = (value: unknown): RunnerVideoArtifactManifest => {
  if (!isRecord(value)) {
    throw new Error("runner video manifest must be an object")
  }

  const durationMs = value.durationMs
  const fps = value.fps
  const frameCount = value.frameCount

  if (
    typeof durationMs !== "number"
    || typeof fps !== "number"
    || typeof frameCount !== "number"
    || !Number.isFinite(durationMs)
    || !Number.isFinite(fps)
    || !Number.isFinite(frameCount)
    || durationMs <= 0
    || fps <= 0
    || frameCount <= 0
    || !Number.isInteger(frameCount)
  ) {
    throw new Error("runner video manifest is missing one or more required numeric fields")
  }

  return {
    durationMs,
    fps,
    frameCount,
  }
}

const buildRunnerVideoFrameFileName = (frameIndex: number): string =>
  `frame-${String(frameIndex).padStart(5, "0")}.png`

const downloadRunnerHttpArtifact = async (args: {
  readonly artifactUrls: ReadonlyArray<string>
  readonly description: string
}): Promise<Uint8Array> => {
  const perEndpointTimeoutMs = Math.max(
    1_000,
    Math.ceil(runnerArtifactDownloadTimeoutMs / Math.max(args.artifactUrls.length, 1)),
  )
  const failures: Array<string> = []

  for (const artifactUrl of args.artifactUrls) {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), perEndpointTimeoutMs)

    try {
      const response = await fetch(artifactUrl, {
        method: "GET",
        signal: controller.signal,
      })

      if (!response.ok) {
        const responseText = await response.text()
        failures.push(`${artifactUrl} returned ${response.status}: ${responseText.trim() || "<empty-body>"}`)
        continue
      }

      return new Uint8Array(await response.arrayBuffer())
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        failures.push(`${artifactUrl} timed out after ${perEndpointTimeoutMs} ms`)
      } else {
        failures.push(`${artifactUrl} failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    } finally {
      clearTimeout(timeout)
    }
  }

  throw new Error(
    `Runner HTTP artifact download failed for ${args.description}: ${failures.join(" | ") || "unknown failure"}`,
  )
}

export const materializeDeviceRunnerVideoArtifacts = async (args: {
  readonly commandUrls: ReadonlyArray<string>
  readonly deviceFramesDirectoryPath: string
  readonly observerControlDirectory: string
  readonly sequence: number
}): Promise<string> => {
  const hostFramesDirectory = join(args.observerControlDirectory, `video-frames-${String(args.sequence).padStart(3, "0")}`)
  const manifestFileName = "manifest.json"

  await rm(hostFramesDirectory, { recursive: true, force: true }).catch(() => undefined)
  await ensureDirectory(hostFramesDirectory)

  try {
    const manifestPath = join(args.deviceFramesDirectoryPath, manifestFileName)
    const manifestData = await downloadRunnerHttpArtifact({
      artifactUrls: buildRunnerHttpArtifactUrls({
        commandUrls: args.commandUrls,
        artifactPath: manifestPath,
      }),
      description: `video manifest ${manifestPath}`,
    })
    const manifestText = Buffer.from(manifestData).toString("utf8")
    const manifest = decodeRunnerVideoArtifactManifest(JSON.parse(manifestText) as unknown)

    await writeFile(
      join(hostFramesDirectory, manifestFileName),
      manifestText.endsWith("\n") ? manifestText : `${manifestText}\n`,
      "utf8",
    )

    for (let frameIndex = 0; frameIndex < manifest.frameCount; frameIndex += 1) {
      const frameFileName = buildRunnerVideoFrameFileName(frameIndex)
      const framePath = join(args.deviceFramesDirectoryPath, frameFileName)
      const frameData = await downloadRunnerHttpArtifact({
        artifactUrls: buildRunnerHttpArtifactUrls({
          commandUrls: args.commandUrls,
          artifactPath: framePath,
        }),
        description: `video frame ${frameFileName}`,
      })

      await writeFile(join(hostFramesDirectory, frameFileName), frameData)
    }

    return hostFramesDirectory
  } catch (error) {
    await rm(hostFramesDirectory, { recursive: true, force: true }).catch(() => undefined)
    throw error
  }
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

const resolveDeviceTunnelIp = async (args: {
  readonly deviceId: string
  readonly jsonPath: string
  readonly logPath: string
}): Promise<string | null> => {
  const result = await runCommand({
    command: "/usr/bin/xcrun",
    commandArgs: [
      "devicectl",
      "device",
      "info",
      "details",
      "--device",
      args.deviceId,
      "--json-output",
      args.jsonPath,
    ],
  })
  await writeCommandLog(args.logPath, result)

  if (result.exitCode !== 0 || !(await fileExists(args.jsonPath))) {
    return null
  }

  const payload = JSON.parse(await readFile(args.jsonPath, "utf8")) as DevicectlDeviceDetailsPayload
  return extractDeviceTunnelIp(payload)
}

const decodeXmlText = (value: string): string =>
  value
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&")

const escapePlistText = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;")

const skipXmlWhitespace = (xml: string, start: number): number => {
  let cursor = start

  while (cursor < xml.length && /\s/u.test(xml[cursor]!)) {
    cursor += 1
  }

  return cursor
}

const findMatchingXmlContainerEnd = (xml: string, start: number, tagName: "dict" | "array"): number => {
  const pattern = new RegExp(`<\\/?${tagName}\\b[^>]*>`, "gu")
  pattern.lastIndex = start

  let depth = 0

  while (true) {
    const match = pattern.exec(xml)

    if (!match) {
      throw new Error(`Could not find closing </${tagName}> tag.`)
    }

    const token = match[0]

    if (token.startsWith("</")) {
      depth -= 1
    } else if (!token.endsWith("/>")) {
      depth += 1
    }

    if (depth === 0) {
      return pattern.lastIndex
    }
  }
}

const readXmlElement = (xml: string, start: number): XmlElementRange | null => {
  const elementStart = skipXmlWhitespace(xml, start)

  if (elementStart >= xml.length || xml[elementStart] !== "<") {
    return null
  }

  const remainder = xml.slice(elementStart)
  const selfClosingMatch = remainder.match(/^<([A-Za-z][A-Za-z0-9_-]*)\b[^>]*\/>/u)

  if (selfClosingMatch) {
    const raw = selfClosingMatch[0]

    return {
      start: elementStart,
      end: elementStart + raw.length,
      tagName: selfClosingMatch[1]!,
      raw,
    }
  }

  const openTagMatch = remainder.match(/^<([A-Za-z][A-Za-z0-9_-]*)\b[^>]*>/u)

  if (!openTagMatch) {
    throw new Error(`Unsupported XML element near index ${elementStart}.`)
  }

  const rawOpenTag = openTagMatch[0]
  const tagName = openTagMatch[1]!

  if (tagName === "dict" || tagName === "array") {
    const end = findMatchingXmlContainerEnd(xml, elementStart, tagName)

    return {
      start: elementStart,
      end,
      tagName,
      raw: xml.slice(elementStart, end),
    }
  }

  const closeTag = `</${tagName}>`
  const closeTagStart = xml.indexOf(closeTag, elementStart + rawOpenTag.length)

  if (closeTagStart === -1) {
    throw new Error(`Could not find closing ${closeTag} tag.`)
  }

  const end = closeTagStart + closeTag.length

  return {
    start: elementStart,
    end,
    tagName,
    raw: xml.slice(elementStart, end),
  }
}

const readImmediateDictEntries = (dictXml: string): Array<DictEntryRange> => {
  const openingMatch = dictXml.match(/^<dict\b[^>]*>/u)

  if (!openingMatch) {
    throw new Error("Expected plist dict XML.")
  }

  const contentStart = openingMatch[0].length
  const closingStart = dictXml.lastIndexOf("</dict>")

  if (closingStart === -1) {
    throw new Error("Plist dict XML was missing a closing </dict> tag.")
  }

  const entries: Array<DictEntryRange> = []
  let cursor = contentStart

  while (true) {
    cursor = skipXmlWhitespace(dictXml, cursor)

    if (cursor >= closingStart) {
      return entries
    }

    const keyRange = readXmlElement(dictXml, cursor)

    if (!keyRange || keyRange.tagName !== "key") {
      throw new Error("Expected a <key> entry while parsing plist dict XML.")
    }

    const valueRange = readXmlElement(dictXml, keyRange.end)

    if (!valueRange) {
      throw new Error(`Expected a plist value for key ${keyRange.raw}.`)
    }

    entries.push({
      key: decodeXmlText(keyRange.raw.replace(/^<key\b[^>]*>/u, "").replace(/<\/key>$/u, "")),
      keyRange,
      valueRange,
    })
    cursor = valueRange.end
  }
}

const inspectDictFormatting = (dictXml: string): {
  readonly closingAnchor: number
  readonly entryIndent: string
  readonly indentUnit: string
  readonly newline: string
} => {
  const closingMatch = dictXml.match(/\n([ \t]*)<\/dict>\s*$/u)
  const closingAnchor = closingMatch
    ? dictXml.length - closingMatch[0].length
    : dictXml.lastIndexOf("</dict>")

  if (closingAnchor === -1) {
    throw new Error("Plist dict XML was missing a closing </dict> tag.")
  }

  const closingIndent = closingMatch?.[1] ?? ""
  const firstChildIndent = dictXml.match(/\n([ \t]*)<key>/u)?.[1] ?? null
  const indentUnit = firstChildIndent
    && firstChildIndent.startsWith(closingIndent)
    && firstChildIndent.length > closingIndent.length
    ? firstChildIndent.slice(closingIndent.length)
    : "  "

  return {
    closingAnchor,
    entryIndent: firstChildIndent ?? `${closingIndent}${indentUnit}`,
    indentUnit,
    newline: "\n",
  }
}

const upsertPlistStringEntry = (dictXml: string, key: string, value: string): string => {
  if (/^<dict\b[^>]*\/>$/u.test(dictXml)) {
    const encodedKey = escapePlistText(key)
    const encodedValue = escapePlistText(value)
    return [
      "<dict>",
      `  <key>${encodedKey}</key>`,
      `  <string>${encodedValue}</string>`,
      "</dict>",
    ].join("\n")
  }

  const entries = readImmediateDictEntries(dictXml)
  const existing = entries.find((entry) => entry.key === key)
  const encodedValue = escapePlistText(value)

  if (existing) {
    const replacement = `<string>${encodedValue}</string>`
    return `${dictXml.slice(0, existing.valueRange.start)}${replacement}${dictXml.slice(existing.valueRange.end)}`
  }

  const formatting = inspectDictFormatting(dictXml)
  const insertion = [
    "",
    `${formatting.entryIndent}<key>${escapePlistText(key)}</key>`,
    `${formatting.entryIndent}<string>${encodedValue}</string>`,
  ].join(formatting.newline)

  return `${dictXml.slice(0, formatting.closingAnchor)}${insertion}${dictXml.slice(formatting.closingAnchor)}`
}

const upsertEnvironmentVariables = (
  targetDictXml: string,
  environmentVariables: ReadonlyArray<readonly [key: string, value: string]>,
): string => {
  const entries = readImmediateDictEntries(targetDictXml)
  const environmentVariablesEntry = entries.find((entry) => entry.key === "EnvironmentVariables")

  if (environmentVariablesEntry) {
    const environmentVariablesDict = environmentVariablesEntry.valueRange.tagName === "dict"
      ? targetDictXml.slice(environmentVariablesEntry.valueRange.start, environmentVariablesEntry.valueRange.end)
      : "<dict></dict>"
    const updatedEnvironmentVariablesDict = environmentVariables.reduce(
      (dictXml, [key, value]) => upsertPlistStringEntry(dictXml, key, value),
      environmentVariablesDict,
    )

    return [
      targetDictXml.slice(0, environmentVariablesEntry.valueRange.start),
      updatedEnvironmentVariablesDict,
      targetDictXml.slice(environmentVariablesEntry.valueRange.end),
    ].join("")
  }

  const formatting = inspectDictFormatting(targetDictXml)
  const nestedEntryIndent = `${formatting.entryIndent}${formatting.indentUnit}`
  const environmentVariableEntries = environmentVariables.flatMap(([key, value]) => [
    `${nestedEntryIndent}<key>${escapePlistText(key)}</key>`,
    `${nestedEntryIndent}<string>${escapePlistText(value)}</string>`,
  ])
  const insertion = [
    "",
    `${formatting.entryIndent}<key>EnvironmentVariables</key>`,
    `${formatting.entryIndent}<dict>`,
    ...environmentVariableEntries,
    `${formatting.entryIndent}</dict>`,
  ].join(formatting.newline)

  return `${targetDictXml.slice(0, formatting.closingAnchor)}${insertion}${targetDictXml.slice(formatting.closingAnchor)}`
}

export const injectEnvironmentVariablesIntoXctestrunPlist = (
  plistXml: string,
  environmentVariables: Record<string, string>,
): string => {
  const plistStart = plistXml.indexOf("<plist")
  const searchStart = plistStart === -1
    ? 0
    : plistXml.indexOf(">", plistStart) + 1
  const rootDictStart = plistXml.indexOf("<dict", searchStart)

  if (rootDictStart === -1) {
    throw new Error("The xctestrun file did not contain a root plist dict.")
  }

  const rootDictRange = readXmlElement(plistXml, rootDictStart)

  if (!rootDictRange || rootDictRange.tagName !== "dict") {
    throw new Error("The xctestrun root element was not a plist dict.")
  }

  const replacements = readImmediateDictEntries(rootDictRange.raw)
    .flatMap((entry) => {
      if (entry.key === xctestrunMetadataKey || entry.valueRange.tagName !== "dict") {
        return []
      }

      const targetDictXml = rootDictRange.raw.slice(entry.valueRange.start, entry.valueRange.end)
      const environmentVariableEntries = Object.entries(environmentVariables)

      return [{
        start: rootDictRange.start + entry.valueRange.start,
        end: rootDictRange.start + entry.valueRange.end,
        replacement: upsertEnvironmentVariables(targetDictXml, environmentVariableEntries),
      }]
    })

  if (replacements.length === 0) {
    throw new Error("The xctestrun file did not contain any test target dictionaries.")
  }

  let updated = plistXml

  for (const replacement of replacements.sort((left, right) => right.start - left.start)) {
    updated = `${updated.slice(0, replacement.start)}${replacement.replacement}${updated.slice(replacement.end)}`
  }

  return updated
}

export const injectBootstrapJsonIntoXctestrunPlist = (plistXml: string, bootstrapJson: string): string =>
  injectEnvironmentVariablesIntoXctestrunPlist(plistXml, {
    [runnerBootstrapEnvKey]: bootstrapJson,
  })

const createBootstrapManifest = (args: {
  readonly controlDirectoryPath: string
  readonly sessionIdentifier: string
  readonly simulatorUdid: string
  readonly targetBundleId: string
}): RunnerBootstrapManifest => ({
  contractVersion: runnerTransportContract,
  controlDirectoryPath: args.controlDirectoryPath,
  egressTransport: runnerEventEgress,
  generatedAt: nowIso(),
  ingressTransport: runnerCommandIngress,
  sessionIdentifier: args.sessionIdentifier,
  simulatorUdid: args.simulatorUdid,
  targetBundleId: args.targetBundleId,
})

const writeBootstrapManifest = async (args: {
  readonly bootstrapPath: string
  readonly manifest: RunnerBootstrapManifest
}): Promise<void> => {
  await ensureDirectory(dirname(args.bootstrapPath))
  await writeFile(args.bootstrapPath, `${JSON.stringify(args.manifest, null, 2)}\n`, "utf8")
}

const injectEnvironmentIntoXctestrun = async (args: {
  readonly sourcePath: string
  readonly destinationPath: string
  readonly environmentVariables: Record<string, string>
}): Promise<string> => {
  const originalXctestrun = await readFile(args.sourcePath, "utf8")
  const injectedXctestrun = injectEnvironmentVariablesIntoXctestrunPlist(
    originalXctestrun,
    args.environmentVariables,
  )

  await ensureDirectory(dirname(args.destinationPath))
  await writeFile(args.destinationPath, injectedXctestrun, "utf8")
  return args.destinationPath
}

const injectBootstrapManifestIntoXctestrun = async (args: {
  readonly sourcePath: string
  readonly destinationPath: string
  readonly bootstrapManifest: RunnerBootstrapManifest
  readonly runnerPort: number
}): Promise<string> =>
  injectEnvironmentIntoXctestrun({
    sourcePath: args.sourcePath,
    destinationPath: args.destinationPath,
    environmentVariables: {
      [runnerBootstrapEnvKey]: JSON.stringify(args.bootstrapManifest),
      [runnerPortEnvKey]: String(args.runnerPort),
    },
  })

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

const sendRunnerHttpCommand = async (args: {
  readonly commandUrls: ReadonlyArray<string>
  readonly commandFrame: string
  readonly action: RunnerAction
  readonly payload?: string
}): Promise<RunnerResponseFrame> => {
  const totalTimeoutMs = resolveCommandTimeoutMs(args.action, args.payload)
  const perEndpointTimeoutMs = Math.max(1_000, Math.ceil(totalTimeoutMs / Math.max(args.commandUrls.length, 1)))
  const failures: Array<string> = []

  for (const commandUrl of args.commandUrls) {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), perEndpointTimeoutMs)

    try {
      const response = await fetch(commandUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: args.commandFrame,
        signal: controller.signal,
      })
      const responseText = await response.text()

      if (!response.ok) {
        failures.push(`${commandUrl} returned ${response.status}: ${responseText.trim() || "<empty-body>"}`)
        continue
      }

      try {
        return decodeRunnerResponseFrame(JSON.parse(responseText) as unknown)
      } catch (error) {
        failures.push(
          `${commandUrl} returned an invalid response frame: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        failures.push(`${commandUrl} timed out after ${perEndpointTimeoutMs} ms`)
      } else {
        failures.push(`${commandUrl} failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    } finally {
      clearTimeout(timeout)
    }
  }

  throw new Error(
    `Runner HTTP ${args.action} failed for ${args.commandUrls.join(", ")}: ${failures.join(" | ") || "unknown failure"}`,
  )
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
      nextStep: "Inspect the injected device bootstrap handoff and retry the session open.",
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

  if (!Number.isInteger(args.ready.runnerPort) || (args.ready.runnerPort ?? 0) <= 0) {
    throw new EnvironmentError({
      code: "runner-port-missing",
      reason: "The real-device runner ready frame did not report a usable HTTP runner port.",
      nextStep: "Inspect the injected runner-port environment variable and the on-device HTTP listener startup before retrying.",
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
    if (args.ready.bootstrapSource !== "device-bootstrap-manifest") {
      throw new EnvironmentError({
        code: "runner-control-directory-mismatch",
        reason:
          `Expected control directory ${args.expectedControlDirectoryPath}, received ${args.ready.controlDirectoryPath}.`,
        nextStep: "Inspect the device bootstrap manifest control directory path and retry the session open.",
        details: [],
      })
    }
    // On real device the XCUITest runner sandbox prevents writing to host-chosen paths,
    // so the runner redirects to its own temp directory for local artifacts.
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
  readonly developmentTeam: string
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
      `DEVELOPMENT_TEAM=${args.developmentTeam}`,
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
  "Real-device runner control uses the honest XCUITest boundary seam for device sessions: bootstrap manifest plus HTTP POST ingress plus stdout-framed mixed-log ready egress.",
  "Device reconnects are surfaced explicitly in session health; Probe does not claim transparent recovery of real-device runner state.",
]

const performPreflight = async (args: {
  readonly projectRoot: string
  readonly sessionId: string
  readonly artifactRoot: string
  readonly runnerDirectory: string
  readonly logsDirectory: string
  readonly bundleId: string
  readonly requestedDeviceId: string | null
}): Promise<PreflightContext> => {
  const projectPath = resolveProbeFixtureProjectPath(args.projectRoot)
  const metaDirectory = join(args.artifactRoot, "meta")
  const deviceLogsDirectory = join(args.logsDirectory, "device-preflight")
  const preferredDdiJsonPath = join(metaDirectory, "preferred-ddi.json")
  const devicesJsonPath = join(metaDirectory, "devices.json")
  const ddiServicesJsonPath = join(metaDirectory, "ddi-services.json")
  const preflightReportPath = join(metaDirectory, "real-device-preflight.json")
  const preferredDdiLogPath = join(deviceLogsDirectory, "devicectl-list-preferred-ddi.log")
  const devicesLogPath = join(deviceLogsDirectory, "devicectl-list-devices.log")
  const ddiServicesLogPath = join(deviceLogsDirectory, "devicectl-device-info-ddi-services.log")
  const buildLogPath = join(deviceLogsDirectory, "xcodebuild-build-for-testing-device.log")
  const derivedDataPath = resolveRealDeviceRunnerDerivedDataPath()

  await Promise.all([
    assertPackagedProbePathExists(projectPath, "ProbeFixture Xcode project"),
    ensureDirectory(metaDirectory),
    ensureDirectory(deviceLogsDirectory),
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
      commandArgs: buildRealDeviceBuildForTestingCommandArgs({
        projectPath,
        derivedDataPath,
        developmentTeam,
      }),
    })
    await writeCommandLog(buildLogPath, buildResult)

    if (buildResult.exitCode !== 0) {
      issues.push({
        summary: "The Probe runner could not complete a signed iPhoneOS build-for-testing preflight.",
        nextStep: inferBuildForTestingNextStep(buildResult),
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
      `xcodebuild build-for-testing -destination generic/platform=iOS -allowProvisioningUpdates -allowProvisioningDeviceRegistration DEVELOPMENT_TEAM=${developmentTeam}`,
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
      readonly projectRoot: string
      readonly sessionId: string
      readonly artifactRoot: string
      readonly runnerDirectory: string
      readonly logsDirectory: string
      readonly bundleId: string
      readonly requestedDeviceId: string | null
    }) => Effect.Effect<OpenedRealDevicePreflightSession, EnvironmentError | UserInputError>
    readonly openLiveSession: (args: {
      readonly projectRoot: string
      readonly sessionId: string
      readonly artifactRoot: string
      readonly runnerDirectory: string
      readonly logsDirectory: string
      readonly bundleId: string
      readonly requestedDeviceId: string | null
    }) => Effect.Effect<OpenedRealDeviceLiveSession, DeviceInterruptionError | EnvironmentError | UserInputError | ChildProcessError>
    readonly captureDeviceDiagnosticBundle: (args: {
      readonly deviceId: string
      readonly diagnosticsDirectory: string
      readonly fileStem: string
      readonly kind: DeviceDiagnosticCaptureMode
    }) => Effect.Effect<{ readonly absolutePath: string }, EnvironmentError>
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
            await assertPackagedProbePathExists(
              resolveProbeRunnerWrapperScriptPath(args.projectRoot),
              "ProbeRunner wrapper script",
            )
            const preflight = await performPreflight(args)
            const liveLogsDirectory = join(args.logsDirectory, "device-live")
            const installedAppsJsonPath = join(preflight.metaDirectory, "installed-apps.json")
            const launchJsonPath = join(preflight.metaDirectory, "target-app-launch.json")
            const installedAppsLogPath = join(liveLogsDirectory, "devicectl-device-info-apps.log")
            const launchLogPath = join(liveLogsDirectory, "devicectl-device-process-launch.log")
            const deviceDetailsJsonPath = join(preflight.metaDirectory, "device-details.json")
            const deviceDetailsLogPath = join(liveLogsDirectory, "devicectl-device-info-details.log")
            const sessionLogPath = join(liveLogsDirectory, "xcodebuild-session.log")
            const wrapperStderrPath = join(liveLogsDirectory, "runner-wrapper.stderr.log")
            const observerControlDirectory = join(args.runnerDirectory, "observer-control")
            const runtimeControlDirectory = join("/tmp", `probe-runtime-${args.sessionId}`)
            const stdoutEventsPath = join(args.runnerDirectory, "stdout-events.ndjson")
            const resultBundlePath = join(args.runnerDirectory, "ProbeRunnerTransportBoundary.xcresult")
            const destination = `platform=iOS,id=${preflight.device.identifier}`

            await Promise.all([
              ensureDirectory(liveLogsDirectory),
              ensureDirectory(args.runnerDirectory),
              ensureDirectory(observerControlDirectory),
              ensureDirectory(runtimeControlDirectory),
            ])
            // Use port 0 so the runner's NWListener auto-assigns an available port.
            // The actual port is reported back in the ready frame's runnerPort field.
            const runnerPort = 0
            const detectInterruption = (overrides?: {
              readonly observedLatencyMs?: number | null
              readonly statusLabel?: string | null
              readonly evidenceSources?: ReadonlyArray<DeviceInterruptionEvidenceSource>
            }) =>
              detectRealDeviceInterruption({
                targetBundleId: args.bundleId,
                device: preflight.device,
                observedLatencyMs: overrides?.observedLatencyMs,
                statusLabel: overrides?.statusLabel,
                logPath: sessionLogPath,
                wrapperStderrPath,
                evidenceSources: overrides?.evidenceSources,
              })

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
              const interruption = await detectInterruption({
                evidenceSources: [{
                  label: "devicectl device info apps",
                  text: `${installedAppsResult.stdout}\n${installedAppsResult.stderr}`,
                }],
              })

              if (interruption) {
                throw toDeviceInterruptionError(interruption)
              }

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
              const interruption = await detectInterruption({
                evidenceSources: [{
                  label: "devicectl device process launch",
                  text: `${launchResult.stdout}\n${launchResult.stderr}`,
                }],
              })

              if (interruption) {
                throw toDeviceInterruptionError(interruption)
              }

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

            const bootstrapManifest = createBootstrapManifest({
              controlDirectoryPath: runtimeControlDirectory,
              sessionIdentifier: args.sessionId,
              simulatorUdid: preflight.device.identifier,
              targetBundleId: args.bundleId,
            })
            bootstrapPath = join(runnerBootstrapRootPath, `device-${preflight.device.identifier}.json`)
            await writeBootstrapManifest({
              bootstrapPath,
              manifest: bootstrapManifest,
            })
            const injectedXctestrunPath = await injectBootstrapManifestIntoXctestrun({
              sourcePath: preflight.xctestrunPath,
              destinationPath: join(dirname(preflight.xctestrunPath), "device-injected.xctestrun"),
              bootstrapManifest,
              runnerPort,
            })

            const startedAt = Date.now()
            wrapper = await startWrapperProcess({
              projectRoot: args.projectRoot,
              xctestrunPath: injectedXctestrunPath,
              destination,
              observerControlDirectory,
              wrapperStderrPath,
              logPath: sessionLogPath,
              stdoutEventsPath,
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

            const ready = await (async () => {
              try {
                return await waitForFreshJson<RunnerReadyFrame>({
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
              } catch (error) {
                const interruption = await detectInterruption({
                  observedLatencyMs: Date.now() - startedAt,
                  evidenceSources: error instanceof ChildProcessError || error instanceof EnvironmentError
                    ? [{
                        label: "session-open failure",
                        text: error instanceof ChildProcessError
                          ? `${error.reason}\n${error.stderrExcerpt}`
                          : `${error.reason}\n${error.details.join("\n")}`,
                      }]
                    : [],
                })

                if (interruption) {
                  throw toDeviceInterruptionError(interruption)
                }

                throw error
              }
            })()

            assertReadyTransportContract({
              ready,
              expectedBootstrapPath: runnerInjectedBootstrapPath,
              expectedControlDirectoryPath: runtimeControlDirectory,
              expectedSessionIdentifier: args.sessionId,
              expectedDeviceUdid: preflight.device.identifier,
            })

            const isDeviceSession = ready.bootstrapSource === "device-bootstrap-manifest"
            const deviceRunnerPort = ready.runnerPort ?? runnerPort
            const deviceTunnelIp = isDeviceSession
              ? await resolveDeviceTunnelIp({
                  deviceId: preflight.device.identifier,
                  jsonPath: deviceDetailsJsonPath,
                  logPath: deviceDetailsLogPath,
                })
              : null
            const deviceCommandUrls = buildRunnerHttpCommandUrls({
              port: deviceRunnerPort,
              tunnelIp: deviceTunnelIp,
            })

            const sendCommand = async (
              sequence: number,
              action: "ping" | "applyInput" | "snapshot" | "screenshot" | "recordVideo" | "shutdown" | "uiAction",
              payload?: string,
            ): Promise<RunnerCommandResult> => {
              const commandStartedAt = Date.now()
              const commandFrame = encodeRunnerCommandFrame({ sequence, action, payload: payload ?? null })
              const responseFrame = isDeviceSession
                ? await sendRunnerHttpCommand({
                    commandUrls: deviceCommandUrls,
                    commandFrame,
                    action,
                    payload,
                  })
                : await (async () => {
                    const stdoutResponsePath = join(
                      observerControlDirectory,
                      `stdout-response-${String(sequence).padStart(3, "0")}.json`,
                    )
                    const commandPath = join(ready.controlDirectoryPath, `command-${String(sequence).padStart(3, "0")}.json`)
                    await writeFile(commandPath, commandFrame, "utf8")

                    return await waitForFreshJson<RunnerResponseFrame>({
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
                  })()
              const snapshotPayloadPath = isDeviceSession
                && action === "recordVideo"
                && responseFrame.ok
                && responseFrame.snapshotPayloadPath
                ? await materializeDeviceRunnerVideoArtifacts({
                    commandUrls: deviceCommandUrls,
                    deviceFramesDirectoryPath: responseFrame.snapshotPayloadPath,
                    observerControlDirectory,
                    sequence,
                  })
                : responseFrame.snapshotPayloadPath ?? null

              return {
                ok: responseFrame.ok,
                action: responseFrame.action,
                error: responseFrame.error ?? null,
                payload: responseFrame.payload ?? null,
                snapshotPayloadPath,
                inlinePayload: responseFrame.inlinePayload ?? null,
                inlinePayloadEncoding: responseFrame.inlinePayloadEncoding ?? null,
                handledMs: responseFrame.handledMs,
                statusLabel: responseFrame.statusLabel,
                snapshotNodeCount: responseFrame.snapshotNodeCount ?? null,
                hostRttMs: Date.now() - commandStartedAt,
              }
            }

            const initialPing = await sendCommand(1, "ping", "session-open")

            const openInterruption = await detectInterruption({
              observedLatencyMs: ready.attachLatencyMs,
              statusLabel: initialPing.statusLabel || ready.initialStatusLabel,
              evidenceSources: initialPing.error
                ? [{ label: "runner open ping", text: initialPing.error }]
                : [],
            })

            if (!initialPing.ok) {
              if (openInterruption) {
                throw toDeviceInterruptionError(openInterruption)
              }

              throw new EnvironmentError({
                code: "runner-open-ping-failed",
                reason: "The runner did not acknowledge the initial ping command after session open.",
                nextStep: "Inspect the session runner log artifact and retry the session open.",
                details: initialPing.statusLabel ? [`status label: ${initialPing.statusLabel}`] : [],
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
               xctestrunPath: injectedXctestrunPath,
               targetAppPath: preflight.targetAppPath,
               runnerAppPath: preflight.runnerAppPath,
               runnerXctestPath: preflight.runnerXctestPath,
               integrationPoints: preflight.integrationPoints,
               warnings: dedupeStrings([
                 ...buildLiveWarnings(),
                 ...(openInterruption ? [buildRealDeviceInterruptionWarning(openInterruption)] : []),
               ]),
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
              stdinProbeStatus: "not-required-http",
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
          || error instanceof DeviceInterruptionError
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
    captureDeviceDiagnosticBundle: (args) =>
      Effect.tryPromise({
        try: () => captureDeviceDiagnosticBundle(args),
        catch: (error) =>
          error instanceof EnvironmentError
            ? error
            : new EnvironmentError({
                code: args.kind === "sysdiagnose" ? "device-sysdiagnose-capture" : "device-diagnostic-capture",
                reason: error instanceof Error ? error.message : String(error),
                nextStep: args.kind === "sysdiagnose"
                  ? "Inspect the devicectl sysdiagnose output and retry the device capture."
                  : "Inspect the devicectl diagnose output and retry the device capture.",
                details: [],
              }),
      }),
  }),
)
