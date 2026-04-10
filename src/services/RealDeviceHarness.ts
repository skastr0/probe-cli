import { spawn } from "node:child_process"
import { access, mkdir, readdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { Context, Effect, Layer } from "effect"
import {
  EnvironmentError,
  UnsupportedCapabilityError,
  UserInputError,
} from "../domain/errors"
import type { SessionConnectionDetails } from "../domain/session"

const fixtureBundleId = "dev.probe.fixture"
const runnerScheme = "ProbeRunner"

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

export interface OpenedRealDeviceSession {
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
  readonly buildLogPath: string | null
  readonly xctestrunPath: string | null
  readonly fixtureAppPath: string | null
  readonly runnerAppPath: string | null
  readonly runnerXctestPath: string | null
  readonly integrationPoints: ReadonlyArray<string>
  readonly warnings: ReadonlyArray<string>
  readonly connection: SessionConnectionDetails
  readonly refreshConnection: () => Promise<SessionConnectionDetails>
  readonly close: () => Promise<void>
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

const extractConfiguredDevelopmentTeams = (content: string): ReadonlyArray<string> =>
  dedupeStrings(
    [...content.matchAll(/DEVELOPMENT_TEAM = "([^"]*)";/g)]
      .map((match) => match[1]?.trim() ?? "")
      .filter((value) => value.length > 0),
  )

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
    }) => Effect.Effect<OpenedRealDeviceSession, EnvironmentError | UserInputError | UnsupportedCapabilityError>
  }
>() {}

export const RealDeviceHarnessLive = Layer.succeed(
  RealDeviceHarness,
  RealDeviceHarness.of({
    openPreflightSession: (args) =>
      Effect.tryPromise({
        try: async () => {
          if (args.bundleId !== fixtureBundleId) {
            throw new UnsupportedCapabilityError({
              code: "fixture-only-bundle-id",
              capability: "session.open.bundle-id",
              reason: `The current real-device preflight slice only supports the fixture bundle id ${fixtureBundleId}.`,
              nextStep: "Retry with the default fixture bundle id, or extend the runner target before requesting arbitrary real-device sessions.",
              details: [],
              wall: false,
            })
          }

          const projectPath = join(args.rootDir, "ios", "ProbeFixture", "ProbeFixture.xcodeproj")
          const projectFilePath = join(projectPath, "project.pbxproj")
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

          const projectFile = await readFile(projectFilePath, "utf8")
          const configuredTeams = extractConfiguredDevelopmentTeams(projectFile)
          let xctestrunPath: string | null = null
          let fixtureAppPath: string | null = null
          let runnerAppPath: string | null = null
          let runnerXctestPath: string | null = null
          let buildCompleted = false

          if (configuredTeams.length === 0) {
            issues.push({
              summary: "The current Probe fixture project does not have a configured development team for iPhoneOS signing.",
              nextStep: "Configure DEVELOPMENT_TEAM (or equivalent signing settings) for both ProbeFixture and ProbeRunnerUITests, then retry the real-device session open.",
              details: [
                "Probe currently depends on development signing for the fixture app and UI-test runner path on device.",
                `project file: ${projectFilePath}`,
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
                "build-for-testing",
              ],
            })
            await writeCommandLog(buildLogPath, buildResult)

            if (buildResult.exitCode !== 0) {
              issues.push({
                summary: "The current Probe fixture runner could not complete a signed iPhoneOS build-for-testing preflight.",
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
              fixtureAppPath = join(buildProductsPath, "Debug-iphoneos", "ProbeFixture.app")
              runnerAppPath = join(buildProductsPath, "Debug-iphoneos", "ProbeRunnerUITests-Runner.app")
              runnerXctestPath = join(runnerAppPath, "PlugIns", "ProbeRunnerUITests.xctest")

              if (!xctestrunPath || !(await fileExists(fixtureAppPath)) || !(await fileExists(runnerAppPath)) || !(await fileExists(runnerXctestPath))) {
                issues.push({
                  summary: "The signed build-for-testing preflight did not emit the expected Probe runner artifacts.",
                  nextStep: "Inspect the build products under the session artifact root and align the runner artifact contract before retrying.",
                  details: [
                    `xctestrun: ${xctestrunPath ?? "missing"}`,
                    `fixture app: ${await fileExists(fixtureAppPath) ? fixtureAppPath : "missing"}`,
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
                summary: `The selected device ${selectedDevice.name} did not pass the CoreDevice DDI-services preflight.`,
                nextStep: "Confirm the device is paired, trusted, in Developer Mode, and compatible with the selected Xcode/DDI, then retry the session open.",
                details: [
                  formatCommandFailure("xcrun devicectl device info ddiServices", ddiServicesResult),
                  `device: ${selectedDevice.name} (${selectedDevice.identifier})`,
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
            ...(buildCompleted ? ["xcodebuild build-for-testing -destination generic/platform=iOS"] : []),
            "xcrun devicectl device install app --device <id> <signed.app>",
            "xcrun devicectl device process launch --device <id> <bundle-id-or-path>",
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
              configuredTeams: [...configuredTeams],
              buildLogPath: buildCompleted ? buildLogPath : null,
              xctestrunPath,
              fixtureAppPath,
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

          if (issues.length > 0 || !selectedDevice) {
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
            buildLogPath: buildCompleted ? buildLogPath : null,
            xctestrunPath,
            fixtureAppPath,
            runnerAppPath,
            runnerXctestPath,
            integrationPoints: [...integrationPoints],
            warnings: [
              "Real-device session open currently stops at explicit host/device preflight; Probe does not claim a validated on-device runner transport yet.",
              "Missing device connectivity, DDI drift, and signing regressions stay visible in session health instead of being hidden behind simulator-style recovery assumptions.",
            ],
            connection: createConnectionDetails({
              status: "connected",
              device: selectedDevice,
              details: [`device runtime: ${selectedDevice.runtime ?? "unknown"}`],
            }),
            refreshConnection,
            close: async () => undefined,
          } satisfies OpenedRealDeviceSession
        },
        catch: (error) =>
          error instanceof UnsupportedCapabilityError
          || error instanceof UserInputError
          || error instanceof EnvironmentError
            ? error
            : new EnvironmentError({
                code: "real-device-preflight",
                reason: error instanceof Error ? error.message : String(error),
                nextStep: "Inspect the real-device preflight artifacts and retry once the missing prerequisites are satisfied.",
                details: [],
              }),
      }),
  }),
)
