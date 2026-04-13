import { spawn } from "node:child_process"
import { mkdtemp, readFile, rm, unlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename } from "node:path"
import { Context, Effect, Either, Layer } from "effect"
import { CapabilityReport } from "../domain/capabilities"
import { DiagnosticReport, KnownWall } from "../domain/diagnostics"
import {
  ArtifactNotFoundError,
  ChildProcessError,
  EnvironmentError,
  SessionConflictError,
  SessionNotFoundError,
  UnsupportedCapabilityError,
  UserInputError,
} from "../domain/errors"
import { perfTemplateChoiceText } from "../domain/perf"
import type { DrillQuery } from "../domain/output"
import { isTextArtifactKind, summarizeContent } from "../domain/output"
import type { WorkspaceStatus } from "../domain/workspace"
import { ArtifactStore } from "./ArtifactStore"
import { OutputPolicy } from "./OutputPolicy"
import { PerfService } from "./PerfService"
import { SessionRegistry } from "./SessionRegistry"
import { SimulatorHarness } from "./SimulatorHarness"
import { serveRpc } from "../rpc/server"
import {
  SessionActionResponse,
  ArtifactDrillResponse,
  DaemonPingResponse,
  PerfRecordResponse,
  PROBE_PROTOCOL_VERSION,
  type RpcProgressEvent,
  type RpcRequest,
  type RpcResponse,
  SessionCloseResponse,
  SessionDebugResponse,
  SessionHealthResponse,
  SessionLogsResponse,
  SessionOpenResponse,
  SessionRecordingExportResponse,
  SessionReplayResponse,
  SessionSnapshotResponse,
  SessionScreenshotResponse,
  SessionVideoResponse,
} from "../rpc/protocol"

const nowIso = (): string => new Date().toISOString()

interface HostCommandResult {
  readonly stdout: string
  readonly stderr: string
  readonly exitCode: number | null
}

interface SimctlDeviceEntry {
  readonly udid: string
  readonly name: string
  readonly isAvailable?: boolean
}

interface SimctlListDevicesPayload {
  readonly devices?: Record<string, ReadonlyArray<SimctlDeviceEntry>>
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

interface StartupRecoveryReport {
  readonly checkedAt: string
  readonly status: DiagnosticReport["status"]
  readonly staleSessionCount: number
  readonly summary: string
  readonly details: ReadonlyArray<string>
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null

const readOptionalString = (record: Record<string, unknown>, key: string): string | null => {
  const value = record[key]
  return typeof value === "string" ? value : null
}

const readStringArray = (value: unknown): ReadonlyArray<string> =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : []

const workspaceCapabilities: ReadonlyArray<CapabilityReport> = [
  {
    area: "simulator",
    status: "supported",
    summary:
      "The daemon-backed vertical slice can resolve a simulator, boot it, either build/install Probe's fixture app or attach to a running installed app, tail logs, and capture runner-backed screenshots and videos into session artifacts.",
    details: [
      "On Simulator, omit --bundle-id to use Probe's built-in fixture app, or pass --bundle-id <bundle-id> to attach to an already-running installed app.",
    ],
  },
  {
    area: "real-device",
    status: "degraded",
    summary: "Probe can now open a live real-device runner session through explicit CoreDevice/DDI/signing checks plus a bootstrap-manifest + HTTP POST + stdout-ready transport.",
    details: [
      "session open supports --target device with optional --device-id selection.",
      "Real-device opens still fail closed when pairing, Developer Mode, signing, or target-app install prerequisites are missing.",
    ],
  },
  {
    area: "runner",
    status: "degraded",
    summary:
      "Runner control is real and uses an honest XCUITest transport seam: simulator sessions stay on file-mailbox + stdout mixed-log egress, while real-device sessions use HTTP POST + stdout-ready observation.",
    details: [],
  },
  {
    area: "perf",
    status: "degraded",
    summary:
      "Time Profiler, System Trace, Metal System Trace, Hangs, and Swift Concurrency can record/export through the daemon, but Probe still keeps unsupported metric families as explicit walls.",
    details: [
      "Current summaries stay inside row-proven exports: time-sample, thread-state, cpu-state, metal-gpu-intervals, potential-hangs, and swift-task-state/task-lifetime.",
      "System Trace uses bounded recording/export budgets and will fail honest when XML size or row volume outruns the current supported summary.",
      "Network-on-Simulator, full reconstructed call stacks, and per-shader GPU attribution remain explicit walls.",
    ],
  },
  {
    area: "logs",
    status: "degraded",
    summary: "Logs are artifact-backed, tail-able, and support bounded simulator captures, but there is no long-lived daemon-owned collector yet.",
    details: [],
  },
  {
    area: "debug",
    status: "degraded",
    summary:
      "The daemon now exposes a persistent LLDB debug surface only for the proven external host-process path; simulator-session attach and real-device/iOS attach remain explicit later seams.",
    details: [
      "Attach/eval/vars/backtrace/breakpoint/continue/detach flow through the long-lived LLDB Python bridge with JSON payloads and artifact offload.",
      "Non-attach commands fail closed unless the session already has an attached LLDB target.",
      "The verified path today is a signed local macOS process; session-app attach on Simulator and device attach are still follow-up validation seams.",
    ],
  },
]

const workspaceKnownWalls: ReadonlyArray<KnownWall> = [
  {
    key: "real-device-sessions",
    summary: "Real-device sessions are live now, but they still fail closed on missing pairing, Developer Mode, signing, target-app install, or transport loss instead of pretending recovery happened.",
    details: [
      "Probe does not currently paper over signing, provisioning, or CoreDevice setup as if recovery were automatic.",
      "Daemon restarts and runner transport loss still require reopening the session rather than expecting transparent recovery.",
    ],
  },
  {
    key: "runner-transport",
    summary: "The runner still relies on validated bootstrap-manifest seams: simulator sessions use file-mailbox ingress plus stdout mixed-log egress, while real-device sessions use HTTP POST ingress plus stdout mixed-log readiness.",
    details: [
      "xcodebuild stdin is not treated as a supported host-to-runner transport in this slice.",
      "Daemon restarts and runner transport loss fail closed instead of pretending the live bridge was recovered.",
    ],
  },
  {
    key: "connected-device-logs-media",
    summary: "Connected-device log capture still does not have the same public CLI parity that Probe has on Simulator, even though runner-backed screenshot/video capture now works on both.",
    details: [
      "Runner-backed screenshots and videos now share the same XCUITest transport seam on simulator and device.",
      "Console.app, Xcode Devices and Simulators, and sysdiagnose remain the honest fallback surfaces from the current research packs for connected-device logs.",
    ],
  },
  {
    key: "real-device-default-test-bundle",
    summary: "Simulator and real-device sessions can target arbitrary bundle ids, but the app must already be installed and Probe still depends on the XCUITest host app + runner project for its control surface.",
    details: [
      "Simulator session open supports Probe's fixture build/install flow or attach-to-running for an installed app that is already running.",
      "Real-device session open verifies the requested bundle id is installed, launches it with devicectl, then attaches the XCUITest runner over the validated HTTP transport seam.",
    ],
  },
]

const runHostCommand = (command: string, commandArgs: ReadonlyArray<string>): Promise<HostCommandResult> =>
  new Promise((resolve, reject) => {
    const child = spawn(command, [...commandArgs], {
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

const resolveFfmpegExecutable = (): string => process.env.PROBE_FFMPEG_PATH ?? "ffmpeg"

const formatCommandFailure = (command: string, result: HostCommandResult): string => {
  const tail = `${result.stdout}${result.stderr}`.trim().split(/\r?\n/).slice(-3).join(" | ")
  return tail.length > 0
    ? `${command} exited with ${result.exitCode ?? "unknown"}: ${tail}`
    : `${command} exited with ${result.exitCode ?? "unknown"}.`
}

const parseJsonPointer = (content: unknown, pointer: string): unknown => {
  if (pointer === "") {
    return content
  }

  const parts = pointer
    .split("/")
    .slice(1)
    .map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~"))

  let current: unknown = content

  for (const part of parts) {
    if (Array.isArray(current)) {
      current = current[Number(part)]
      continue
    }

    if (typeof current === "object" && current !== null && part in current) {
      current = (current as Record<string, unknown>)[part]
      continue
    }

    throw new UserInputError({
      code: "json-pointer-miss",
      reason: `JSON pointer ${pointer} did not match the artifact content.`,
      nextStep: "Inspect the JSON artifact and choose a valid RFC 6901 pointer.",
      details: [],
    })
  }

  return current
}

const runXmllint = (absolutePath: string, xpath: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const child = spawn("/usr/bin/xmllint", ["--xpath", xpath, absolutePath], {
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
    child.once("close", (code) => {
      if (code === 0) {
        resolve(stdout)
        return
      }

      reject(
        new EnvironmentError({
          code: "xmllint-failed",
          reason: stderr.trim() || `xmllint exited with code ${code ?? "unknown"}.`,
          nextStep: "Verify the XPath expression and ensure xmllint is available on this host.",
          details: [],
        }),
      )
    })
  })

export class ProbeKernel extends Context.Tag("@probe/ProbeKernel")<
  ProbeKernel,
  {
    readonly getWorkspaceStatus: () => Effect.Effect<WorkspaceStatus, EnvironmentError>
    readonly serve: () => Effect.Effect<void, EnvironmentError>
    readonly handleRpcRequest: (
      request: RpcRequest,
      emit: (event: RpcProgressEvent) => void,
    ) => Effect.Effect<
      RpcResponse,
      | EnvironmentError
      | UserInputError
      | UnsupportedCapabilityError
      | ArtifactNotFoundError
      | SessionConflictError
      | SessionNotFoundError
      | ChildProcessError
    >
  }
>() {}

export const ProbeKernelLive = Layer.effect(
  ProbeKernel,
  Effect.gen(function* () {
    const artifactStore = yield* ArtifactStore
    const outputPolicy = yield* OutputPolicy
    const perfService = yield* PerfService
    const sessionRegistry = yield* SessionRegistry
    const simulatorHarness = yield* SimulatorHarness
    const daemonStartedAt = nowIso()

    const renderDrill = (artifactAbsolutePath: string, query: DrillQuery) =>
      Effect.tryPromise({
        try: async () => {
          const raw = await readFile(artifactAbsolutePath, "utf8")

          switch (query.kind) {
            case "text": {
              const allLines = raw.split(/\r?\n/)
              const startIndex = Math.max(query.startLine - 1, 0)
              const endIndex = Math.min(query.endLine, allLines.length)
              const selected = allLines.slice(startIndex, endIndex)
              const filtered = query.match
                ? selected.filter((line) => line.includes(query.match ?? ""))
                : selected
              const content = filtered.join("\n")
              return {
                format: "text" as const,
                content,
                summary: `${filtered.length} text lines from ${basename(artifactAbsolutePath)}`,
              }
            }

            case "json": {
              const parsed = JSON.parse(raw) as unknown
              const value = parseJsonPointer(parsed, query.pointer)
              const content = JSON.stringify(value, null, 2)
              return {
                format: "json" as const,
                content,
                summary: `JSON pointer ${query.pointer} from ${basename(artifactAbsolutePath)}`,
              }
            }

            case "xml": {
              const content = await runXmllint(artifactAbsolutePath, query.xpath)
              return {
                format: "text" as const,
                content,
                summary: `XPath ${query.xpath} from ${basename(artifactAbsolutePath)}`,
              }
            }
          }
        },
        catch: (error) =>
          error instanceof UserInputError || error instanceof EnvironmentError
            ? error
            : new EnvironmentError({
                code: "artifact-drill-render",
                reason: error instanceof Error ? error.message : String(error),
                nextStep: "Verify the artifact type and drill query, then retry.",
                details: [],
              }),
      })

    const makeDaemonStatus: Effect.Effect<DaemonPingResponse["result"]> = Effect.gen(function* () {
      const socketPath = yield* artifactStore.getDaemonSocketPath()
      const activeSessions = yield* sessionRegistry.getActiveSessionCount()

      return {
        protocolVersion: PROBE_PROTOCOL_VERSION,
        startedAt: daemonStartedAt,
        processId: process.pid,
        socketPath,
        activeSessions,
      }
    })

    const collectXcodeDiagnostic = Effect.tryPromise({
      try: async (): Promise<DiagnosticReport> => {
        const selected = await runHostCommand("/usr/bin/xcode-select", ["-p"])
        const version = await runHostCommand("/usr/bin/xcodebuild", ["-version"])

        if (selected.exitCode !== 0 || version.exitCode !== 0) {
          return {
            key: "host.xcode",
            status: "blocked",
            summary: "Xcode command-line tooling is not ready for Probe diagnostics.",
            details: [
              selected.exitCode === 0 ? selected.stdout.trim() : formatCommandFailure("xcode-select -p", selected),
              version.exitCode === 0 ? version.stdout.trim() : formatCommandFailure("xcodebuild -version", version),
            ],
          }
        }

        const developerDir = selected.stdout.trim()
        const versionLines = version.stdout.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0)
        return {
          key: "host.xcode",
          status: "ready",
          summary: `${versionLines[0] ?? "Xcode"} is selected at ${developerDir}.`,
          details: versionLines.length > 1 ? versionLines : [`developer dir: ${developerDir}`],
        }
      },
      catch: (error) =>
        new EnvironmentError({
          code: "doctor-xcode-diagnostic",
          reason: error instanceof Error ? error.message : String(error),
          nextStep: "Inspect the local Xcode command-line tools and retry `probe doctor`.",
          details: [],
        }),
    }).pipe(
      Effect.catchAll((error) => Effect.succeed({
        key: "host.xcode",
        status: "blocked",
        summary: "Xcode command-line tooling could not be inspected.",
        details: [error.reason],
      } satisfies DiagnosticReport)),
    )

    const collectSimulatorDiagnostic = Effect.tryPromise({
      try: async (): Promise<DiagnosticReport> => {
        const result = await runHostCommand("/usr/bin/xcrun", ["simctl", "list", "devices", "available", "-j"])

        if (result.exitCode !== 0) {
          return {
            key: "host.simulator",
            status: "blocked",
            summary: "simctl is not ready for deterministic simulator selection.",
            details: [formatCommandFailure("xcrun simctl list devices available -j", result)],
          }
        }

        const payload = JSON.parse(result.stdout) as SimctlListDevicesPayload
        const available = Object.entries(payload.devices ?? {})
          .filter(([runtime]) => runtime.includes("iOS"))
          .flatMap(([runtime, devices]) =>
            devices
              .filter((device) => device.isAvailable !== false)
              .map((device) => ({ runtime, device })),
          )

        if (available.length === 0) {
          return {
            key: "host.simulator",
            status: "blocked",
            summary: "Probe could not find an available iOS Simulator target on this host.",
            details: ["Boot or create an available iPhone simulator before opening a Probe session."],
          }
        }

        const first = available[0]
        return {
          key: "host.simulator",
          status: "ready",
          summary: `simctl can see ${available.length} available iOS simulator target(s).`,
          details: first
            ? [`default candidate: ${first.device.name} (${first.device.udid}) on ${first.runtime}`]
            : [],
        }
      },
      catch: (error) =>
        new EnvironmentError({
          code: "doctor-simulator-diagnostic",
          reason: error instanceof Error ? error.message : String(error),
          nextStep: "Inspect simctl availability and retry `probe doctor`.",
          details: [],
        }),
    }).pipe(
      Effect.catchAll((error) => Effect.succeed({
        key: "host.simulator",
        status: "blocked",
        summary: "simctl diagnostics could not be collected.",
        details: [error.reason],
      } satisfies DiagnosticReport)),
    )

    const collectRealDeviceDiagnostic = Effect.tryPromise({
      try: async (): Promise<DiagnosticReport> => {
        const root = await mkdtemp(`${tmpdir()}/probe-doctor-`)
        const preferredDdiPath = `${root}/preferred-ddi.json`
        const devicesPath = `${root}/devices.json`

        try {
          const ddi = await runHostCommand("/usr/bin/xcrun", ["devicectl", "list", "preferredDDI", "--json-output", preferredDdiPath])
          const devices = await runHostCommand("/usr/bin/xcrun", ["devicectl", "list", "devices", "--json-output", devicesPath])

          if (ddi.exitCode !== 0 || devices.exitCode !== 0) {
            return {
              key: "host.real-device",
              status: "blocked",
              summary: "devicectl host diagnostics are not ready on this machine.",
              details: [
                ddi.exitCode === 0 ? "preferred DDI check succeeded." : formatCommandFailure("xcrun devicectl list preferredDDI", ddi),
                devices.exitCode === 0 ? "device discovery check succeeded." : formatCommandFailure("xcrun devicectl list devices", devices),
              ],
            }
          }

          const ddiPayload = JSON.parse(await readFile(preferredDdiPath, "utf8")) as DevicectlPreferredDdiPayload
          const devicesPayload = JSON.parse(await readFile(devicesPath, "utf8")) as DevicectlDevicesPayload
          const preferred = ddiPayload.result?.platforms?.iOS?.[0]
          const isUsable = preferred?.ddiMetadata?.isUsable === true
          const contentIsCompatible = preferred?.ddiMetadata?.contentIsCompatible === true
          const deviceCount = devicesPayload.result?.devices?.length ?? 0
          const coreDeviceVersion = ddiPayload.result?.hostCoreDeviceVersion ?? ddiPayload.info?.version ?? "unknown"

          if (!isUsable || !contentIsCompatible) {
            return {
              key: "host.real-device",
              status: "blocked",
              summary: "The current host does not report a usable iOS Developer Disk Image for CoreDevice.",
              details: [
                `host CoreDevice version: ${coreDeviceVersion}`,
                `usable: ${String(isUsable)}`,
                `content compatible: ${String(contentIsCompatible)}`,
              ],
            }
          }

          return {
            key: "host.real-device",
            status: "degraded",
            summary: deviceCount > 0
              ? `CoreDevice can see ${deviceCount} connected real device(s), and Probe can now attempt live real-device runner sessions when signing and target-app prerequisites are satisfied.`
              : "CoreDevice host prerequisites are partially ready (usable iOS DDI), but there is no connected real device available for a live device session.",
            details: [
              `host CoreDevice version: ${coreDeviceVersion}`,
              `preferred iOS DDI: ${preferred?.hostDDI ?? "unknown"}`,
              `connected devices: ${deviceCount}`,
            ],
          }
        } finally {
          await rm(root, { recursive: true, force: true })
        }
      },
      catch: (error) =>
        new EnvironmentError({
          code: "doctor-real-device-diagnostic",
          reason: error instanceof Error ? error.message : String(error),
          nextStep: "Inspect devicectl availability and retry `probe doctor`.",
          details: [],
        }),
    }).pipe(
      Effect.catchAll((error) => Effect.succeed({
        key: "host.real-device",
        status: "blocked",
        summary: "Real-device host diagnostics could not be collected.",
        details: [error.reason],
      } satisfies DiagnosticReport)),
    )

    const collectFfmpegDiagnostic = Effect.tryPromise({
      try: async (): Promise<DiagnosticReport> => {
        const ffmpegExecutable = resolveFfmpegExecutable()

        try {
          const result = await runHostCommand(ffmpegExecutable, ["-version"])

          if (result.exitCode !== 0) {
            return {
              key: "host.ffmpeg",
              status: "degraded",
              summary: "ffmpeg is not currently available for MP4 stitching, so Probe will retain runner frame-sequence bundles instead.",
              details: [formatCommandFailure(`${ffmpegExecutable} -version`, result)],
            }
          }

          const versionLine = result.stdout.split(/\r?\n/).map((line) => line.trim()).find((line) => line.length > 0)
          return {
            key: "host.ffmpeg",
            status: "ready",
            summary: versionLine
              ? `ffmpeg is available for MP4 stitching of runner-captured video (${versionLine}).`
              : "ffmpeg is available for MP4 stitching of runner-captured video.",
            details: [`executable: ${ffmpegExecutable}`],
          }
        } catch (error) {
          if (error instanceof Error && "code" in error && error.code === "ENOENT") {
            return {
              key: "host.ffmpeg",
              status: "degraded",
              summary: "ffmpeg is not installed, so Probe will retain runner frame-sequence bundles instead of MP4 video artifacts.",
              details: [`missing executable: ${ffmpegExecutable}`],
            }
          }

          throw error
        }
      },
      catch: (error) =>
        new EnvironmentError({
          code: "doctor-ffmpeg-diagnostic",
          reason: error instanceof Error ? error.message : String(error),
          nextStep: "Inspect ffmpeg availability and retry `probe doctor`.",
          details: [],
        }),
    }).pipe(
      Effect.catchAll((error) => Effect.succeed({
        key: "host.ffmpeg",
        status: "degraded",
        summary: "ffmpeg availability could not be inspected, so Probe cannot promise MP4 stitching right now.",
        details: [error.reason],
      } satisfies DiagnosticReport)),
    )

    const buildStartupRecoveryReport = Effect.gen(function* () {
      const persistedSessions = yield* artifactStore.listPersistedSessions()
      const staleSessions = persistedSessions.filter((session) => session.state !== "closed")

      if (staleSessions.length === 0) {
        return {
          checkedAt: nowIso(),
          status: "ready",
          staleSessionCount: 0,
          summary: "No stale persisted sessions were found before daemon startup.",
          details: [],
        } satisfies StartupRecoveryReport
      }

      const details: Array<string> = []
      let hadFailure = false

      for (const staleSession of staleSessions) {
        const reaped = yield* simulatorHarness.reapStaleRunnerSession({
          sessionId: staleSession.sessionId,
          wrapperProcessId: staleSession.runner.wrapperProcessId,
          bootstrapPath: staleSession.transport.bootstrapPath,
        }).pipe(Effect.either)
        const persistedManifest = yield* artifactStore.readSessionManifest(staleSession.sessionId).pipe(Effect.either)

        if (Either.isLeft(reaped)) {
          hadFailure = true
          details.push(
            `${staleSession.sessionId} (${staleSession.state ?? "unknown"}): startup recovery could not fully inspect or reap the stale session; inspect ${staleSession.artifactRoot} before reusing the environment.`,
          )
          continue
        }

        if (Either.isLeft(persistedManifest) || persistedManifest.right === null) {
          hadFailure = true
          details.push(
            `${staleSession.sessionId} (${staleSession.state ?? "unknown"}): startup recovery could not fully inspect or persist the stale session manifest; inspect ${staleSession.artifactRoot} before reusing the environment.`,
          )
          continue
        }

        const manifest = persistedManifest.right
        const reapedResult = reaped.right

        const existingWarnings = readStringArray(manifest.warnings)
        const existingResources = isRecord(manifest.resources) ? manifest.resources : {}
        const existingHealthCheck = isRecord(manifest.healthCheck) ? manifest.healthCheck : {}
        const nextManifest: Record<string, unknown> = {
          ...manifest,
          state: "closed",
          updatedAt: nowIso(),
          expiresAt: nowIso(),
          warnings: [...new Set([
            ...existingWarnings,
            "Recovered stale session during daemon startup. Probe does not recover live runner state across daemon lifecycles; inspect the saved artifacts and open a new session.",
          ])],
          resources: {
            ...existingResources,
            runner: "stopped",
            debugger: existingResources.debugger === "not-requested" ? "not-requested" : "stopped",
          },
          healthCheck: {
            ...existingHealthCheck,
            checkedAt: nowIso(),
            wrapperRunning: false,
            pingRttMs: null,
            lastCommand: "startup-recovery",
            lastOk: false,
          },
        }

        const persistedClosedManifest = yield* artifactStore.writeSessionManifest(staleSession.sessionId, nextManifest).pipe(Effect.either)

        if (Either.isLeft(persistedClosedManifest)) {
          hadFailure = true
          details.push(`${staleSession.sessionId} (${staleSession.state ?? "unknown"}): reaped stale resources, but could not persist the recovered closed manifest.`)
          continue
        }

        details.push(`${staleSession.sessionId} (${staleSession.state ?? "unknown"}): ${reapedResult.summary}`)
        for (const detail of reapedResult.details) {
          details.push(`  - ${detail}`)
        }
      }

      return {
        checkedAt: nowIso(),
        status: hadFailure ? "degraded" : "degraded",
        staleSessionCount: staleSessions.length,
        summary: `Recovered ${staleSessions.length} stale session artifact(s) from previous daemon lifecycles before starting the daemon.`,
        details,
      } satisfies StartupRecoveryReport
    })

    const collectWorkspaceDiagnostics = Effect.gen(function* () {
      const daemonRunning = yield* artifactStore.isDaemonRunning()
      const daemonMetadata = yield* artifactStore.readDaemonMetadata()
      const persistedSessions = yield* artifactStore.listPersistedSessions()
      const staleSessions = persistedSessions.filter((session) => session.state !== "closed")
      const xcode = yield* collectXcodeDiagnostic
      const simulator = yield* collectSimulatorDiagnostic
      const realDevice = yield* collectRealDeviceDiagnostic
      const ffmpeg = yield* collectFfmpegDiagnostic

      const startupRecovery = isRecord(daemonMetadata?.startupRecovery)
        ? {
            status: readOptionalString(daemonMetadata.startupRecovery, "status") as DiagnosticReport["status"] | null,
            summary: readOptionalString(daemonMetadata.startupRecovery, "summary"),
            staleSessionCount: typeof daemonMetadata.startupRecovery.staleSessionCount === "number"
              ? daemonMetadata.startupRecovery.staleSessionCount
              : null,
            details: readStringArray(daemonMetadata.startupRecovery.details),
          }
        : null

      const daemonDiagnostic: DiagnosticReport = {
        key: "daemon.transport",
        status: daemonRunning ? "ready" : "blocked",
        summary: daemonRunning
          ? `The Probe daemon is reachable over the local socket.${Array.isArray(daemonMetadata?.sessions) ? ` ${daemonMetadata.sessions.length} session metadata entr${daemonMetadata.sessions.length === 1 ? "y" : "ies"} currently persisted.` : ""}`
          : "The Probe daemon is not currently running, so thin-client session commands will fail fast until `probe serve` is started.",
        details: daemonRunning
          ? [
              daemonMetadata && readOptionalString(daemonMetadata, "socketPath")
                ? `socket: ${readOptionalString(daemonMetadata, "socketPath")}`
                : "socket metadata unavailable",
            ]
          : [
              "Start `probe serve` to restore the long-lived control plane.",
              "If a previous daemon crashed, the next daemon start will reap stale session ownership instead of pretending recovery happened.",
            ],
      }

      const staleSessionDiagnostic: DiagnosticReport = staleSessions.length === 0
        ? {
            key: "session.recovery",
            status: "ready",
            summary: startupRecovery?.staleSessionCount && startupRecovery.staleSessionCount > 0
              ? `No stale persisted sessions remain. The last daemon startup recovered ${startupRecovery.staleSessionCount} stale session artifact(s).`
              : "No stale persisted sessions are waiting for recovery.",
            details: startupRecovery?.details ?? [],
          }
        : {
            key: "session.recovery",
            status: "degraded",
            summary: `Found ${staleSessions.length} stale persisted session artifact(s) from previous daemon lifecycles. They are not live sessions and will not be transparently reused.`,
            details: staleSessions.slice(0, 5).map((session) => `${session.sessionId} (${session.state ?? "unknown"}) at ${session.artifactRoot}`),
          }

      return {
        diagnostics: [daemonDiagnostic, staleSessionDiagnostic, xcode, simulator, realDevice, ffmpeg],
        startupRecovery,
      }
    })

    const handleRpcRequest = (request: RpcRequest, emit: (event: RpcProgressEvent) => void) =>
      Effect.gen(function* () {
        const progress = (stage: string, message: string) => {
          emit({
            kind: "event",
            protocolVersion: PROBE_PROTOCOL_VERSION,
            requestId: request.requestId,
            stage,
            message,
          })
        }

        switch (request.method) {
          case "daemon.ping": {
            const result = yield* makeDaemonStatus
            return {
              kind: "response",
              protocolVersion: PROBE_PROTOCOL_VERSION,
              requestId: request.requestId,
              method: request.method,
              result,
            } satisfies DaemonPingResponse
          }

          case "session.open": {
            progress(
              "session.open",
              request.params.target === "device"
                ? "Opening the real-device runner session."
                : "Opening the simulator-backed runner session.",
            )
            const result = yield* (request.params.target === "device"
              ? sessionRegistry.openDeviceSession({
                  bundleId: request.params.bundleId,
                  deviceId: request.params.deviceId,
                  rootDir: process.cwd(),
                  emitProgress: progress,
                })
              : sessionRegistry.openSimulatorSession({
                  bundleId: request.params.bundleId,
                  sessionMode: request.params.sessionMode ?? undefined,
                  simulatorUdid: request.params.simulatorUdid,
                  rootDir: process.cwd(),
                  emitProgress: progress,
                }))
            return {
              kind: "response",
              protocolVersion: PROBE_PROTOCOL_VERSION,
              requestId: request.requestId,
              method: request.method,
              result,
            } satisfies SessionOpenResponse
          }

          case "session.health": {
            progress("session.health", `Checking runner health for session ${request.params.sessionId}.`)
            const result = yield* sessionRegistry.getSessionHealth(request.params.sessionId)
            return {
              kind: "response",
              protocolVersion: PROBE_PROTOCOL_VERSION,
              requestId: request.requestId,
              method: request.method,
              result,
            } satisfies SessionHealthResponse
          }

          case "session.logs": {
            progress("session.logs", `Collecting ${request.params.source} logs for session ${request.params.sessionId}.`)
            const result = yield* sessionRegistry.getSessionLogs({
              sessionId: request.params.sessionId,
              source: request.params.source,
              lineCount: request.params.lineCount,
              match: request.params.match,
              outputMode: request.params.outputMode,
              captureSeconds: request.params.captureSeconds,
              predicate: request.params.predicate,
              process: request.params.process,
              subsystem: request.params.subsystem,
              category: request.params.category,
            })
            return {
              kind: "response",
              protocolVersion: PROBE_PROTOCOL_VERSION,
              requestId: request.requestId,
              method: request.method,
              result,
            } satisfies SessionLogsResponse
          }

          case "session.debug": {
            progress(
              "session.debug",
              `Running ${request.params.command.command} for session ${request.params.sessionId}.`,
            )
            const result = yield* sessionRegistry.runDebugCommand({
              sessionId: request.params.sessionId,
              outputMode: request.params.outputMode,
              command: request.params.command,
            })
            return {
              kind: "response",
              protocolVersion: PROBE_PROTOCOL_VERSION,
              requestId: request.requestId,
              method: request.method,
              result,
            } satisfies SessionDebugResponse
          }

          case "session.snapshot": {
            progress("session.snapshot", `Capturing a snapshot for session ${request.params.sessionId}.`)
            const result = yield* sessionRegistry.captureSnapshot({
              sessionId: request.params.sessionId,
              outputMode: request.params.outputMode,
            })
            return {
              kind: "response",
              protocolVersion: PROBE_PROTOCOL_VERSION,
              requestId: request.requestId,
              method: request.method,
              result,
            } satisfies SessionSnapshotResponse
          }

          case "session.action": {
            progress("session.action", `Executing ${request.params.action.kind} for session ${request.params.sessionId}.`)
            const result = yield* sessionRegistry.performAction({
              sessionId: request.params.sessionId,
              action: request.params.action,
            })
            return {
              kind: "response",
              protocolVersion: PROBE_PROTOCOL_VERSION,
              requestId: request.requestId,
              method: request.method,
              result,
            } satisfies SessionActionResponse
          }

          case "session.recording.export": {
            progress("session.recording.export", `Exporting the recorded action script for session ${request.params.sessionId}.`)
            const result = yield* sessionRegistry.exportRecording({
              sessionId: request.params.sessionId,
              label: request.params.label,
            })
            return {
              kind: "response",
              protocolVersion: PROBE_PROTOCOL_VERSION,
              requestId: request.requestId,
              method: request.method,
              result,
            } satisfies SessionRecordingExportResponse
          }

          case "session.replay": {
            progress("session.replay", `Replaying ${request.params.script.steps.length} recorded steps for session ${request.params.sessionId}.`)
            const result = yield* sessionRegistry.replayRecording({
              sessionId: request.params.sessionId,
              script: request.params.script,
            })
            return {
              kind: "response",
              protocolVersion: PROBE_PROTOCOL_VERSION,
              requestId: request.requestId,
              method: request.method,
              result,
            } satisfies SessionReplayResponse
          }

          case "session.screenshot": {
            progress("session.screenshot", `Capturing a screenshot for session ${request.params.sessionId}.`)
            const result = yield* sessionRegistry.captureScreenshot({
              sessionId: request.params.sessionId,
              label: request.params.label,
              outputMode: request.params.outputMode,
            })
            return {
              kind: "response",
              protocolVersion: PROBE_PROTOCOL_VERSION,
              requestId: request.requestId,
              method: request.method,
              result,
            } satisfies SessionScreenshotResponse
          }

          case "session.video": {
            progress("session.video", `Capturing video for session ${request.params.sessionId} over ${request.params.duration}.`)
            const result = yield* sessionRegistry.recordVideo({
              sessionId: request.params.sessionId,
              duration: request.params.duration,
            })
            return {
              kind: "response",
              protocolVersion: PROBE_PROTOCOL_VERSION,
              requestId: request.requestId,
              method: request.method,
              result,
            } satisfies SessionVideoResponse
          }

          case "session.close": {
            progress("session.close", `Closing session ${request.params.sessionId}.`)
            const result = yield* sessionRegistry.closeSession(request.params.sessionId)
            return {
              kind: "response",
              protocolVersion: PROBE_PROTOCOL_VERSION,
              requestId: request.requestId,
              method: request.method,
              result,
            } satisfies SessionCloseResponse
          }

          case "perf.record": {
            progress(
              "perf.record",
              `Recording ${request.params.template} for session ${request.params.sessionId}.`,
            )
            const result = yield* perfService.record({
              sessionId: request.params.sessionId,
              template: request.params.template,
              timeLimit: request.params.timeLimit,
              emitProgress: progress,
            })
            return {
              kind: "response",
              protocolVersion: PROBE_PROTOCOL_VERSION,
              requestId: request.requestId,
              method: request.method,
              result,
            } satisfies PerfRecordResponse
          }

          case "artifact.drill": {
            progress("artifact.drill", `Drilling artifact ${request.params.artifactKey}.`)
            const artifact = yield* artifactStore.getArtifact(
              request.params.sessionId,
              request.params.artifactKey,
            )

            if (artifact.kind === "directory") {
              return yield* new UnsupportedCapabilityError({
                code: "directory-drill-unsupported",
                capability: "artifact.drill.directory",
                reason: `Artifact ${artifact.key} is a directory bundle and cannot be drilled directly.`,
                nextStep:
                  "Choose a concrete file artifact, or extend the control plane with bundle-aware drill support.",
                details: [],
                wall: false,
              })
            }

            if (!isTextArtifactKind(artifact.kind)) {
              return yield* new UnsupportedCapabilityError({
                code: "artifact-drill-binary",
                capability: "artifact.drill.binary",
                reason: `Artifact ${artifact.key} has kind ${artifact.kind} and cannot be drilled as text, JSON, or XML.`,
                nextStep: "Use the artifact path directly, or add a binary-aware drill surface for this artifact kind.",
                details: [],
                wall: false,
              })
            }

            const rendered = yield* renderDrill(artifact.absolutePath, request.params.query)

            if (outputPolicy.shouldInline(request.params.outputMode, rendered.content)) {
              return {
                kind: "response",
                protocolVersion: PROBE_PROTOCOL_VERSION,
                requestId: request.requestId,
                method: request.method,
                result: {
                  kind: "inline",
                  format: rendered.format,
                  summary: rendered.summary,
                  content: rendered.content,
                },
              } satisfies ArtifactDrillResponse
            }

            const derived = yield* artifactStore.writeDerivedOutput({
              sessionId: request.params.sessionId,
              label: `drill-${artifact.key}`,
              format: rendered.format,
              content: rendered.content,
              summary: `${rendered.summary} (${summarizeContent(rendered.content)})`,
            })

            return {
              kind: "response",
              protocolVersion: PROBE_PROTOCOL_VERSION,
              requestId: request.requestId,
              method: request.method,
              result: {
                kind: "summary+artifact",
                format: rendered.format,
                summary: `${rendered.summary}; offloaded because ${summarizeContent(rendered.content)} exceeds inline policy.`,
                artifact: derived,
              },
            } satisfies ArtifactDrillResponse
          }

          default:
            return yield* new EnvironmentError({
              code: "rpc-method-unhandled",
              reason: `Unhandled RPC method ${(request as { method: string }).method}.`,
              nextStep: "Update the daemon request handler so the method is explicitly supported.",
              details: [],
            })
        }
      })

    return ProbeKernel.of({
      getWorkspaceStatus: () =>
        Effect.gen(function* () {
          const artifactRoot = yield* artifactStore.getRootDirectory()
          const socketPath = yield* artifactStore.getDaemonSocketPath()
          const metadataPath = yield* artifactStore.getDaemonMetadataPath()
          const daemonRunning = yield* artifactStore.isDaemonRunning()
          const workspaceDiagnostics = yield* collectWorkspaceDiagnostics

          return {
            workspaceRoot: process.cwd(),
            artifactRoot,
            outputThreshold: outputPolicy.getDefaultInlineThreshold(),
            commands: [
              "doctor",
              "serve",
              "session open [--target simulator|device] [--bundle-id <bundle-id>] [--simulator-udid <udid>] [--device-id <id>] [--json]",
              "session health --session-id <id> [--json]",
              "session logs --session-id <id> [--source runner|build|wrapper|stdout|simulator] [--lines 80] [--match <text>] [--seconds 2] [--output auto|inline|artifact] [--json]",
              "session snapshot --session-id <id> [--output auto|inline|artifact] [--json]",
              "session screenshot --session-id <id> [--label <name>] [--output auto|inline|artifact] [--json]",
              "session video --session-id <id> --duration <duration> [--json]",
              "session close --session-id <id> [--json]",
              `perf record --session-id <id> --template ${perfTemplateChoiceText} [--time-limit <duration>] [--json]`,
              "drill --session-id <id> --artifact <key> <query> [--json]",
            ],
            daemon: {
              running: daemonRunning,
              socketPath,
              metadataPath,
              protocolVersion: PROBE_PROTOCOL_VERSION,
              sessionTtlMs: sessionRegistry.getSessionTtlMs(),
              artifactRetentionMs: artifactStore.getArtifactRetentionMs(),
            },
            capabilities: [...workspaceCapabilities],
            diagnostics: workspaceDiagnostics.diagnostics,
            knownWalls: [...workspaceKnownWalls],
            notes: [
              "The current control plane is daemon-backed and real for simulator sessions via either Probe's fixture build/install flow or attach-to-running against an installed app.",
              "Runner command ingress still uses the validated file-backed mailbox because xcodebuild stdin is not proven at this boundary.",
              "Session snapshots keep the full stable-ref tree artifact-backed and only inline interactive/collapsed previews that stay inside the compact snapshot budget.",
              "Session logs support bounded simulator capture plus tails from existing artifact-backed runner/build/wrapper outputs.",
              "Real-device sessions now open a live runner when CoreDevice/DDI/signing checks pass, but they still fail closed on missing setup or transport loss.",
              "Session screenshots now use native simctl capture on Simulator and runner capture on device; simulator video uses native simctl capture while device video still uses the runner frame loop, with ffmpeg remux/stitching improving the emitted artifact format when available.",
              "On Simulator, omit --bundle-id to use Probe's fixture app, or pass --bundle-id <bundle-id> to attach to an already-running installed app; on device, the app must already be installed so Probe can launch and attach to it.",
              "Perf recording defaults to 60s for metal-system-trace and 3s for the other supported perf templates.",
              ...(workspaceDiagnostics.startupRecovery?.summary ? [workspaceDiagnostics.startupRecovery.summary] : []),
            ],
          }
        }),
      serve: () =>
        Effect.gen(function* () {
          const socketPath = yield* artifactStore.getDaemonSocketPath()
          const metadataPath = yield* artifactStore.getDaemonMetadataPath()
          const alreadyRunning = yield* artifactStore.isDaemonRunning()

          if (alreadyRunning) {
            return yield* new EnvironmentError({
              code: "daemon-already-running",
              reason: `A Probe daemon is already listening at ${socketPath}.`,
              nextStep: "Reuse the existing daemon or stop it before starting a new one.",
              details: [],
            })
          }

          yield* artifactStore.ensureDaemonDirectories()
          yield* Effect.tryPromise({
            try: async () => {
              await unlink(socketPath).catch(() => undefined)
            },
            catch: (error) =>
              new EnvironmentError({
                code: "daemon-socket-cleanup",
                reason: error instanceof Error ? error.message : String(error),
                nextStep: "Remove the stale daemon socket and retry `probe serve`.",
                details: [],
              }),
          })

          const startupRecovery = yield* buildStartupRecoveryReport

          yield* serveRpc({
            socketPath,
            metadataPath,
            onMetadataWrite: async () => {
              const activeSessions = await Effect.runPromise(sessionRegistry.getActiveSessionCount())
              await Effect.runPromise(
                artifactStore.writeDaemonMetadata({
                  protocolVersion: PROBE_PROTOCOL_VERSION,
                  startedAt: daemonStartedAt,
                  processId: process.pid,
                  socketPath,
                  activeSessions,
                  sessions: [],
                  startupRecovery,
                }),
              )
            },
            onMetadataRemove: async () => {
              await Effect.runPromise(artifactStore.removeDaemonMetadata())
            },
            onRequest: handleRpcRequest,
          })
        }),
      handleRpcRequest,
    })
  }),
)
