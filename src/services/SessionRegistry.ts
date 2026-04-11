import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { access, mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises"
import { join, relative } from "node:path"
import { Context, Effect, Layer, Ref } from "effect"
import {
  buildRecordedSessionAction,
  buildRunnerUiActionPayload,
  describeRecordedActionTarget,
  describeSnapshotNode,
  evaluateAssertion,
  resolveActionSelectorInSnapshot,
  resolveRecordedActionTargetInSnapshot,
  validateSessionAction,
  type ActionRecordingScript,
  type AssertAction,
  type RecordedSessionAction,
  type ReplayReport,
  type ReplayStepReport,
  type SessionAction,
  type SessionActionResult,
  type SessionRecordingExportResult,
  type SessionReplayResult,
} from "../domain/action"
import { CapabilityReport } from "../domain/capabilities"
import {
  type DebugBreakpointLocation,
  type DebugCommandInput,
  type DebugCommandResult,
  type SessionCoordination,
  type SessionDebuggerDetails,
} from "../domain/debug"
import {
  ArtifactNotFoundError,
  ChildProcessError,
  EnvironmentError,
  SessionConflictError,
  SessionNotFoundError,
  UnsupportedCapabilityError,
  UserInputError,
} from "../domain/errors"
import type { ArtifactRecord, DrillResult, OutputMode, SessionLogSource, SessionLogsResult, SummaryArtifactResult } from "../domain/output"
import { summarizeContent } from "../domain/output"
import {
  SessionHealth,
  type SessionConnectionDetails,
  type SessionHealthCheck,
  type SessionResourceState,
  type SessionResourceStates,
  type SimulatorSessionMode,
} from "../domain/session"
import { buildSessionSnapshotResult, buildSnapshotArtifact, decodeRunnerSnapshotPayload, type SessionSnapshotResult, type StoredSnapshotArtifact } from "../domain/snapshot"
import { ArtifactStore, type DaemonSessionMetadata } from "./ArtifactStore"
import { type LldbBridgeHandle, type LldbBridgeResponseFrame, LldbBridgeFactory } from "./LldbBridge"
import { OutputPolicy } from "./OutputPolicy"
import { type OpenedRealDeviceSession, RealDeviceHarness } from "./RealDeviceHarness"
import { SimulatorHarness, type OpenedSimulatorSession, type RunnerCommandResult } from "./SimulatorHarness"

const defaultSessionTtlMs = Number(process.env.PROBE_SESSION_TTL_MS ?? 15 * 60 * 1000)
const ttlSweepIntervalMs = Number(process.env.PROBE_SESSION_SWEEP_INTERVAL_MS ?? 10_000)
const maxSessionLogCaptureSeconds = 30
const defaultDebugCommandTimeoutMs = Number(process.env.PROBE_LLDB_COMMAND_TIMEOUT_MS ?? 60_000)
const maxDebugFrameLimit = 200
const maxDebugEvalTimeoutMs = 30_000
const defaultReplayAttemptLimit = Number(process.env.PROBE_REPLAY_ATTEMPTS ?? 3)
const maxVideoDurationMs = 120_000
const defaultVideoDurationMs = 10_000
const videoCaptureFps = 10
const tarExecutable = process.env.PROBE_TAR_PATH ?? "/usr/bin/tar"
const selectorDriftContractWarning = "Selector drift recovery only helps while the semantic fallback stays unique on the runner; duplicate weak targets still need stronger accessibility identifiers or labels."
const offscreenHittabilityWarning = "Offscreen targets must already be hittable for tap/press/type; Probe does not auto-scroll until an element becomes visible."
const nonRecoverableSessionWarning =
  "Probe fails closed when the runner exits, the daemon restarts, or runner transport is lost. Close and reopen the session instead of expecting transparent recovery."
const daemonOwnedCleanupWarning =
  "Session cleanup is daemon-owned; close/session shutdown tears down the runner wrapper process group and removes the bootstrap manifest."

interface HostCommandResult {
  readonly stdout: string
  readonly stderr: string
  readonly exitCode: number | null
  readonly signal: string | null
  readonly timedOut: boolean
}

interface RunnerVideoCaptureManifest {
  readonly durationMs: number
  readonly fps: number
  readonly frameCount: number
  readonly framesDirectoryPath: string
}

const parseDurationStringMs = (value: string): number | null => {
  const match = value.match(/^(\d+)(ms|s|m|h)$/)

  if (!match) {
    return null
  }

  const amount = Number(match[1])
  const unit = match[2]

  if (!Number.isFinite(amount) || amount <= 0) {
    return null
  }

  switch (unit) {
    case "ms":
      return amount
    case "s":
      return amount * 1_000
    case "m":
      return amount * 60_000
    case "h":
      return amount * 60 * 60_000
    default:
      return null
  }
}

const normalizeVideoDurationMs = (durationMs: number): number =>
  Math.min(Math.max(Math.round(durationMs), 1), maxVideoDurationMs)

const resolveFfmpegExecutable = (): string => process.env.PROBE_FFMPEG_PATH ?? "ffmpeg"

const runHostCommand = (args: {
  readonly command: string
  readonly commandArgs: ReadonlyArray<string>
  readonly cwd?: string
  readonly timeoutMs?: number
}): Promise<HostCommandResult> =>
  new Promise((resolve, reject) => {
    const child = spawn(args.command, [...args.commandArgs], {
      cwd: args.cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    })

    let stdout = ""
    let stderr = ""
    let timedOut = false
    const timeoutMs = args.timeoutMs ?? 30_000
    const timeout = setTimeout(() => {
      timedOut = true
      child.kill("SIGTERM")
      setTimeout(() => {
        if (child.exitCode === null) {
          child.kill("SIGKILL")
        }
      }, 2_000)
    }, timeoutMs)

    child.stdout?.setEncoding("utf8")
    child.stderr?.setEncoding("utf8")
    child.stdout?.on("data", (chunk) => {
      stdout += chunk
    })
    child.stderr?.on("data", (chunk) => {
      stderr += chunk
    })

    child.once("error", (error) => {
      clearTimeout(timeout)
      reject(error)
    })
    child.once("close", (exitCode, signal) => {
      clearTimeout(timeout)
      resolve({ stdout, stderr, exitCode, signal, timedOut })
    })
  })

const formatHostCommandFailure = (command: string, result: HostCommandResult): string => {
  if (result.timedOut) {
    return `${command} timed out.`
  }

  const excerpt = `${result.stdout}${result.stderr}`.trim().split(/\r?\n/).slice(-3).join(" | ")
  return excerpt.length > 0
    ? `${command} exited with ${result.exitCode ?? result.signal ?? "unknown"}: ${excerpt}`
    : `${command} exited with ${result.exitCode ?? result.signal ?? "unknown"}.`
}

const fileExists = async (path: string): Promise<boolean> => {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

const isFfmpegAvailable = async (): Promise<boolean> => {
  const ffmpegExecutable = resolveFfmpegExecutable()

  try {
    const result = await runHostCommand({
      command: ffmpegExecutable,
      commandArgs: ["-version"],
      timeoutMs: 5_000,
    })
    return result.exitCode === 0
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return false
    }

    throw error
  }
}

const decodeRunnerVideoCaptureManifest = (
  value: unknown,
  framesDirectoryPath: string,
): RunnerVideoCaptureManifest => {
  if (typeof value !== "object" || value === null) {
    throw new Error("runner video manifest must be an object")
  }

  const record = value as Record<string, unknown>
  const durationMs = typeof record.durationMs === "number" ? record.durationMs : null
  const fps = typeof record.fps === "number" ? record.fps : null
  const frameCount = typeof record.frameCount === "number" ? record.frameCount : null

  if (
    durationMs === null
    || fps === null
    || frameCount === null
    || !Number.isFinite(durationMs)
    || !Number.isFinite(fps)
    || !Number.isFinite(frameCount)
    || durationMs <= 0
    || fps <= 0
    || frameCount <= 0
  ) {
    throw new Error("runner video manifest is missing one or more required fields")
  }

  return {
    durationMs,
    fps,
    frameCount,
    framesDirectoryPath,
  }
}

const timestampForFile = (): string => new Date().toISOString().replace(/[:.]/g, "-")

const sanitizeFileComponent = (value: string | null | undefined, fallback: string): string => {
  const sanitized = (value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")

  return sanitized.length > 0 ? sanitized : fallback
}

const isHittabilityFailure = (reason: string): boolean => /\bhittable\b|\boffscreen\b/i.test(reason)

const withOffscreenNextStep = (base: string, reason: string): string =>
  isHittabilityFailure(reason)
    ? `${base} If the target is offscreen, add an explicit scroll step first; Probe does not auto-scroll until the element becomes hittable.`
    : base

const buildReplayWarnings = (semanticFallbackCount: number): ReadonlyArray<string> => [
  semanticFallbackCount > 0
    ? `${semanticFallbackCount} replay steps recovered selector drift via semantic fallback. ${selectorDriftContractWarning}`
    : selectorDriftContractWarning,
  offscreenHittabilityWarning,
]

const dedupeStrings = (values: ReadonlyArray<string>): Array<string> => [...new Set(values)]

const buildReplayResultSummary = (args: {
  readonly stepCount: number
  readonly retriedStepCount: number
  readonly semanticFallbackCount: number
}): string =>
  `Replayed ${args.stepCount} steps with ${args.retriedStepCount} retried steps and ${args.semanticFallbackCount} semantic fallback recoveries. ${selectorDriftContractWarning} ${offscreenHittabilityWarning}`

const buildReplayArtifactSummary = (args: {
  readonly status: "succeeded" | "failed"
  readonly stepCount: number
  readonly failureStepIndex: number | null
}): string =>
  args.status === "succeeded"
    ? `Replay report with ${args.stepCount} executed steps. ${selectorDriftContractWarning} ${offscreenHittabilityWarning}`
    : `Replay failure report for step ${args.failureStepIndex ?? "unknown"} after retry exhaustion. ${selectorDriftContractWarning} ${offscreenHittabilityWarning}`

interface BaseActiveSessionRecord {
  kind: "simulator" | "device"
  health: SessionHealth
  baseWarnings: ReadonlyArray<string>
  debuggerBridge: LldbBridgeHandle | null
  snapshotState: {
    latest: StoredSnapshotArtifact | null
    nextSnapshotIndex: number
    nextElementRefIndex: number
  }
  recording: {
    steps: Array<RecordedSessionAction>
  }
}

interface SimulatorActiveSessionRecord extends BaseActiveSessionRecord {
  kind: "simulator"
  nextSequence: number
  readonly sendRunnerCommand: (
    sequence: number,
    action: "ping" | "applyInput" | "snapshot" | "screenshot" | "recordVideo" | "shutdown" | "uiAction",
    payload?: string,
  ) => Promise<RunnerCommandResult>
  readonly closeResources: () => Promise<void>
  readonly isRunnerRunning: () => boolean
  readonly waitForExit: Promise<{ readonly code: number | null; readonly signal: string | null }>
}

interface RealDeviceActiveSessionRecord extends BaseActiveSessionRecord {
  kind: "device"
  integrationPoints: ReadonlyArray<string>
  nextSequence: number
  readonly sendRunnerCommand: ((
    sequence: number,
    action: "ping" | "applyInput" | "snapshot" | "screenshot" | "recordVideo" | "shutdown" | "uiAction",
    payload?: string,
  ) => Promise<RunnerCommandResult>) | null
  readonly refreshConnection: () => Promise<SessionConnectionDetails>
  readonly closeResources: () => Promise<void>
  readonly isRunnerRunning: () => boolean
  readonly waitForExit: Promise<{ readonly code: number | null; readonly signal: string | null }> | null
}

type ActiveSessionRecord = SimulatorActiveSessionRecord | RealDeviceActiveSessionRecord
type RunnerBackedActiveSessionRecord = SimulatorActiveSessionRecord | (RealDeviceActiveSessionRecord & {
  readonly sendRunnerCommand: NonNullable<RealDeviceActiveSessionRecord["sendRunnerCommand"]>
  readonly waitForExit: NonNullable<RealDeviceActiveSessionRecord["waitForExit"]>
})

interface OpeningSessionReservation {
  readonly sessionId: string
  readonly platform: "simulator" | "device"
  readonly bundleId: string
  readonly simulatorUdid: string | null
  readonly deviceId: string | null
  readonly artifactRoot: string | null
  readonly openedAt: string
  readonly updatedAt: string
  readonly expiresAt: string
}

interface DebugSelectedThreadSnapshot {
  readonly threadId: number
  readonly indexId: number
  readonly stopReason: string
  readonly stopDescription: string | null
}

interface DebugProcessSnapshot {
  readonly pid: number
  readonly state: string
  readonly stopId: number | null
  readonly selectedThread: DebugSelectedThreadSnapshot | null
}

const nowIso = (): string => new Date().toISOString()
const expiresAtIso = (): string => new Date(Date.now() + defaultSessionTtlMs).toISOString()

const makeSessionResources = (runner: SessionResourceState): SessionResourceStates => ({
  runner,
  debugger: "not-requested",
  logs: "not-requested",
  trace: "not-requested",
})

const setDebuggerResourceState = (
  resources: SessionResourceStates,
  debuggerState: SessionResourceState,
): SessionResourceStates => ({
  ...resources,
  debugger: debuggerState,
})

const setRunnerResourceState = (
  resources: SessionResourceStates,
  runner: SessionResourceState,
): SessionResourceStates => ({
  ...resources,
  runner,
})

const setSessionResourceStates = (
  resources: SessionResourceStates,
  next: Partial<SessionResourceStates>,
): SessionResourceStates => ({
  ...resources,
  ...next,
})

const makeArtifacts = async (
  artifactRoot: string,
  records: ReadonlyArray<{ readonly key: string; readonly label: string; readonly kind: ArtifactRecord["kind"]; readonly absolutePath: string; readonly summary: string }>,
): Promise<Array<ArtifactRecord>> => {
  const createdAt = nowIso()

  const existing: Array<ArtifactRecord> = []

  for (const record of records) {
    try {
      await access(record.absolutePath)
      existing.push({
        key: record.key,
        label: record.label,
        kind: record.kind,
        summary: record.summary,
        absolutePath: record.absolutePath,
        relativePath: relative(artifactRoot, record.absolutePath),
        external: false,
        createdAt,
      })
    } catch {
      // skip missing artifacts during partial failure or early bootstrap
    }
  }

  return existing
}

const createArtifactRecord = (args: {
  readonly artifactRoot: string
  readonly key: string
  readonly label: string
  readonly kind: ArtifactRecord["kind"]
  readonly absolutePath: string
  readonly summary: string
}): ArtifactRecord => ({
  key: args.key,
  label: args.label,
  kind: args.kind,
  summary: args.summary,
  absolutePath: args.absolutePath,
  relativePath: relative(args.artifactRoot, args.absolutePath),
  external: false,
  createdAt: nowIso(),
})

const splitLines = (content: string): Array<string> => {
  const lines = content.split(/\r?\n/)

  if (lines.at(-1) === "") {
    lines.pop()
  }

  return lines
}

const selectBufferedLogLines = (args: {
  readonly content: string
  readonly lineCount: number
  readonly match: string | null
  readonly sourceLabel: string
}): { readonly content: string; readonly summary: string } => {
  const allLines = splitLines(args.content)
  const buffered = allLines.slice(-args.lineCount)
  const filtered = args.match ? buffered.filter((line) => line.includes(args.match ?? "")) : buffered
  const matchSummary = args.match
    ? `${filtered.length} matching lines for ${JSON.stringify(args.match)} from ${args.sourceLabel}`
    : `${filtered.length} lines from ${args.sourceLabel}`

  return {
    content: filtered.join("\n"),
    summary: `${matchSummary} (buffered last ${buffered.length} of ${allLines.length})`,
  }
}

const resolveLogArtifactKey = (source: Exclude<SessionLogSource, "simulator">): string => {
  switch (source) {
    case "runner":
      return "xcodebuild-session-log"
    case "build":
      return "build-log"
    case "wrapper":
      return "wrapper-stderr"
    case "stdout":
      return "stdout-events"
  }
}

const escapePredicateString = (value: string): string =>
  value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')

const buildSimulatorLogPredicate = (args: {
  readonly predicate: string | null
  readonly process: string | null
  readonly subsystem: string | null
  readonly category: string | null
}): string | null => {
  const clauses: Array<string> = []

  if (args.predicate) {
    clauses.push(`(${args.predicate})`)
  }

  if (args.process) {
    clauses.push(`process == "${escapePredicateString(args.process)}"`)
  }

  if (args.subsystem) {
    clauses.push(`subsystem == "${escapePredicateString(args.subsystem)}"`)
  }

  if (args.category) {
    clauses.push(`category == "${escapePredicateString(args.category)}"`)
  }

  return clauses.length > 0 ? clauses.join(" && ") : null
}

const describeLogOffloadReason = (mode: OutputMode, content: string): string =>
  mode === "artifact"
    ? "artifact output was requested"
    : `${summarizeContent(content)} exceeds inline policy`

const describeScreenshotOffloadReason = (mode: OutputMode): string => {
  switch (mode) {
    case "artifact":
      return "artifact output was requested"
    case "inline":
      return "binary image payloads are never returned inline"
    case "auto":
      return "binary image payloads are always artifact-backed"
  }
}

const pausedProcessStates = new Set(["stopped", "crashed", "suspended"])

const makeDefaultDebuggerState = (): SessionDebuggerDetails => ({
  attachState: "not-attached",
  targetScope: null,
  bridgePid: null,
  bridgeStartedAt: null,
  bridgeExitedAt: null,
  pythonExecutable: null,
  lldbPythonPath: null,
  lldbVersion: null,
  attachedPid: null,
  processState: null,
  stopId: null,
  stopReason: null,
  stopDescription: null,
  lastCommand: null,
  lastCommandOk: null,
  lastUpdatedAt: null,
  frameLogArtifactKey: null,
  stderrArtifactKey: null,
})

export const buildSessionCoordination = (debuggerState: SessionDebuggerDetails): SessionCoordination => {
  const runnerActionsBlocked = debuggerState.targetScope === "session-app"
    && debuggerState.processState !== null
    && pausedProcessStates.has(debuggerState.processState)

  return {
    runnerActionsBlocked,
    runnerActionPolicy: runnerActionsBlocked ? "blocked-by-debugger-stop" : "normal",
    reason: runnerActionsBlocked
      ? `LLDB has the session app paused in state ${debuggerState.processState} at stop ${debuggerState.stopId ?? "unknown"}. Runner-backed actions stay blocked to avoid timeouts while the app is stopped under the debugger. Detach the debugger, or use continue only if you are prepared to wait for the next stop because the current bridge is synchronous.`
      : null,
  }
}

const deriveSessionPhase = (health: SessionHealth): SessionHealth["state"] => {
  if (health.state === "opening" || health.state === "closing" || health.state === "closed" || health.state === "failed") {
    return health.state
  }

  if (health.resources.runner === "failed") {
    return "failed"
  }

  if (
    health.connection.status === "disconnected"
    || health.resources.runner === "degraded"
    ||
    health.coordination.runnerActionsBlocked
    || health.resources.debugger === "failed"
    || health.resources.debugger === "degraded"
  ) {
    return "degraded"
  }

  return "ready"
}

const buildConnectedConnectionDetails = (args: {
  readonly summary: string
  readonly details: ReadonlyArray<string>
}): SessionConnectionDetails => ({
  status: "connected",
  checkedAt: nowIso(),
  summary: args.summary,
  details: [...args.details],
})

const buildSimulatorCapabilities = (): ReadonlyArray<CapabilityReport> => [
  {
    area: "simulator",
    status: "supported",
    summary:
      "The daemon can resolve a concrete simulator UDID, boot it, either build/install Probe's fixture app or attach to an already-running installed app, and capture runner-backed screenshots and videos into the session artifact root.",
    details: [
      "Uses simctl list --json plus bootstatus -b for deterministic simulator selection.",
      "Fixture sessions use simctl install and simctl launch --terminate-running-process before runner attach.",
      "Arbitrary-app sessions verify installation/running state with simctl launch plus simctl listapps before runner attach.",
      "Runner-backed screenshots land under screenshots/, and runner-backed video artifacts land under video/.",
    ],
  },
  {
    area: "real-device",
    status: "unsupported",
    summary: "This session is simulator-backed; real-device-specific setup and health seams do not apply here.",
    details: ["Open a --target device session to exercise the explicit CoreDevice/DDI/signing preflight path."],
  },
  {
    area: "runner",
    status: "degraded",
    summary:
      "Runner control works, but the contract is still the honest transport-boundary seam: simulator bootstrap manifest plus file-backed command ingress plus stdout-framed mixed-log egress.",
    details: [
      "xcodebuild stdin is not treated as a usable host-to-runner transport in this slice.",
      "The same runner transport is used for both Probe's built-in fixture app and attach-to-running simulator sessions.",
    ],
  },
  {
    area: "perf",
    status: "degraded",
    summary:
      "The daemon can record/export Time Profiler, System Trace, Metal System Trace, Hangs, and Swift Concurrency for simulator sessions anchored to the active target-app pid, but wider Instruments coverage still remains explicit follow-up work.",
    details: [
      "Current summaries intentionally stop at row-proven exports instead of implying support for every schema visible in a TOC.",
      "Metal driver/encoder exports plus hangs and swift-task summaries are available only when the bounded exports are populated for the current workload.",
      "System Trace stays on an explicitly bounded contract: smaller recording windows plus per-export size/row budgets that fail honest when XML cost outruns the supported summary.",
      "Network-on-Simulator, full reconstructed call stacks, and per-shader GPU attribution remain honest walls.",
    ],
  },
  {
    area: "logs",
    status: "degraded",
    summary: "Session logs can be tailed from persisted artifacts and bounded-captured from simulator unified logging, but there is not yet a daemon-owned persistent live collector.",
    details: [
      "Existing build, xcodebuild-session, wrapper stderr, and stdout-event logs stay artifact-backed under logs/.",
      "Simulator live capture uses bounded simctl spawn ... log stream requests rather than a long-lived session child resource.",
    ],
  },
  {
    area: "debug",
    status: "degraded",
    summary:
      "LLDB-backed debugging exposes only the proven external host-process path through the persistent Python bridge; simulator-session attach and real-device/iOS attach are still explicit follow-up seams.",
    details: [
      "Attach/eval/vars/backtrace/breakpoint/continue/detach requests use Probe-owned JSON responses instead of scraped LLDB CLI text.",
      "Non-attach debug commands now fail closed unless the session already has an attached LLDB target.",
      "The verified target today is a signed local macOS process; simulator-app attach and device attach are still explicit follow-up validation work.",
    ],
  },
]

const buildRealDeviceCapabilities = (args: {
  readonly connection: SessionConnectionDetails
  readonly integrationPoints: ReadonlyArray<string>
  readonly liveRunner: boolean
}): ReadonlyArray<CapabilityReport> => [
  {
    area: "simulator",
    status: "unsupported",
    summary: "This session targets a real device, so simulator-only boot/install helpers are not part of its contract.",
    details: ["Retry on a simulator target if you need simulator log capture or fixture build/install helpers."],
  },
  {
    area: "real-device",
    status: args.connection.status !== "connected"
      ? "unsupported"
      : args.liveRunner
        ? "supported"
        : "degraded",
    summary: args.connection.status === "connected"
      ? args.liveRunner
        ? "Probe opened a live real-device runner session through explicit devicectl, signing, and XCUITest transport validation."
        : "Probe opened a real-device session through explicit devicectl + signing preflight, but the on-device runner transport remains an honest follow-up seam."
      : "The selected real device is no longer reachable, so the device session stays open only as degraded metadata until the device reconnects.",
    details: [
      ...args.connection.details,
      ...args.integrationPoints,
    ],
  },
  {
    area: "runner",
    status: args.liveRunner ? "supported" : "degraded",
    summary: args.liveRunner
      ? "The real-device runner is live over the same bootstrap-manifest + file-mailbox + stdout-JSONL transport used on simulator."
      : "The real-device runner transport is not established in this slice; Probe only keeps preflight state and explicit integration points alive.",
    details: args.liveRunner
      ? [
          "Command ingress uses the host-side file mailbox shared with the XCUITest boundary.",
          "Runner events are parsed from stdout JSONL frames embedded in the mixed xcodebuild/XCTest log stream.",
        ]
      : [
          "The Simulator bootstrap-manifest transport is not claimed for real devices.",
          "Use session health plus the saved preflight artifacts to inspect device connectivity and prerequisites.",
        ],
  },
  {
    area: "perf",
    status: args.liveRunner ? "supported" : "unsupported",
    summary: args.liveRunner
      ? "Perf recording can attach xctrace to the live real-device target pid exposed by the runner session."
      : "Perf recording still depends on the simulator runner pid path in this slice.",
    details: args.liveRunner
      ? ["Real-device xctrace recording still depends on the live runner pid and connected-device availability."]
      : ["Real-device xctrace anchoring remains a follow-up seam after on-device runner/session validation."],
  },
  {
    area: "logs",
    status: "degraded",
    summary: args.liveRunner
      ? "Real-device sessions expose build + runner boundary artifacts, but there is no long-lived device unified-log collector yet."
      : "Real-device sessions currently expose only preflight/build artifacts; there is no long-lived device log collector yet.",
    details: args.liveRunner
      ? [
          "You can inspect the saved xcodebuild-session, wrapper stderr, stdout-event, and preflight artifacts through session logs or artifact drill.",
          "Real-device live unified logging remains an explicit later seam.",
        ]
      : [
          "You can inspect the saved build/preflight artifacts through session logs or artifact drill when present.",
          "Real-device live unified logging remains an explicit later seam.",
        ],
  },
  {
    area: "debug",
    status: "unsupported",
    summary: "Device-session LLDB attach is still outside the verified contract for this slice.",
    details: ["The only verified persistent debugger path today is the external host-process bridge."],
  },
]

const buildSimulatorWarnings = (opened: OpenedSimulatorSession): ReadonlyArray<string> => {
  const warnings = [
    "Runner command ingress currently uses the validated file-backed mailbox rather than xcodebuild stdin.",
    daemonOwnedCleanupWarning,
    nonRecoverableSessionWarning,
    selectorDriftContractWarning,
    offscreenHittabilityWarning,
  ]

  if (opened.stdinProbeStatus !== "received") {
    warnings.push(
      `Runner stdin probe reported ${opened.stdinProbeStatus}; the daemon continues on the proven file-mailbox contract instead of pretending stdin works.`,
    )
  }

  return warnings
}

const buildRealDeviceWarnings = (opened: OpenedRealDeviceSession): ReadonlyArray<string> => {
  const warnings = [
    ...opened.warnings,
    daemonOwnedCleanupWarning,
  ]

  if (opened.mode === "live" && opened.stdinProbeStatus !== "received") {
    warnings.push(
      `Runner stdin probe reported ${opened.stdinProbeStatus}; the daemon continues on the proven file-mailbox contract instead of pretending stdin works.`,
    )
  }

  return dedupeStrings(warnings)
}

const composeWarnings = (
  record: Pick<ActiveSessionRecord, "baseWarnings">,
  extras: ReadonlyArray<string>,
): ReadonlyArray<string> => dedupeStrings([...record.baseWarnings, ...extras])

const isSimulatorRecord = (record: ActiveSessionRecord): record is SimulatorActiveSessionRecord =>
  record.kind === "simulator"

const isRealDeviceRecord = (record: ActiveSessionRecord): record is RealDeviceActiveSessionRecord =>
  record.kind === "device"

const isRunnerBackedRecord = (record: ActiveSessionRecord): record is RunnerBackedActiveSessionRecord =>
  isSimulatorRecord(record) || record.sendRunnerCommand !== null

export class SessionRegistry extends Context.Tag("@probe/SessionRegistry")<
  SessionRegistry,
  {
    readonly getSessionTtlMs: () => number
    readonly getActiveSessionCount: () => Effect.Effect<number>
    readonly openDeviceSession: (params: {
      readonly bundleId: string
      readonly deviceId: string | null
      readonly rootDir: string
      readonly emitProgress: (stage: string, message: string) => void
    }) => Effect.Effect<
      SessionHealth,
      SessionConflictError | EnvironmentError | UserInputError | UnsupportedCapabilityError | ChildProcessError
    >
    readonly openSimulatorSession: (params: {
      readonly bundleId: string
      readonly sessionMode?: SimulatorSessionMode
      readonly simulatorUdid: string | null
      readonly rootDir: string
      readonly emitProgress: (stage: string, message: string) => void
    }) => Effect.Effect<
      SessionHealth,
      SessionConflictError | EnvironmentError | UserInputError | UnsupportedCapabilityError | ChildProcessError
    >
    readonly getSessionHealth: (sessionId: string) => Effect.Effect<SessionHealth, SessionNotFoundError | EnvironmentError>
    readonly sendRunnerKeepalive: (sessionId: string) => Effect.Effect<void, SessionNotFoundError | EnvironmentError>
    readonly getSessionLogs: (params: {
      readonly sessionId: string
      readonly source: SessionLogSource
      readonly lineCount: number
      readonly match: string | null
      readonly outputMode: OutputMode
      readonly captureSeconds: number
      readonly predicate: string | null
      readonly process: string | null
      readonly subsystem: string | null
      readonly category: string | null
    }) => Effect.Effect<
      SessionLogsResult,
      | SessionNotFoundError
      | ArtifactNotFoundError
      | UserInputError
      | UnsupportedCapabilityError
      | EnvironmentError
      | ChildProcessError
    >
    readonly captureScreenshot: (params: {
      readonly sessionId: string
      readonly label: string | null
      readonly outputMode: OutputMode
    }) => Effect.Effect<
      SummaryArtifactResult,
      SessionNotFoundError | UnsupportedCapabilityError | EnvironmentError | ChildProcessError
    >
    readonly recordVideo: (params: {
      readonly sessionId: string
      readonly duration: string
    }) => Effect.Effect<
      SummaryArtifactResult,
      SessionNotFoundError | UserInputError | UnsupportedCapabilityError | EnvironmentError | ChildProcessError
    >
    readonly captureSnapshot: (params: {
      readonly sessionId: string
      readonly outputMode: OutputMode
    }) => Effect.Effect<
      SessionSnapshotResult,
      SessionNotFoundError | UnsupportedCapabilityError | EnvironmentError | ChildProcessError
    >
    readonly performAction: (params: {
      readonly sessionId: string
      readonly action: SessionAction
    }) => Effect.Effect<
      SessionActionResult,
      SessionNotFoundError | UserInputError | UnsupportedCapabilityError | EnvironmentError | ChildProcessError
    >
    readonly exportRecording: (params: {
      readonly sessionId: string
      readonly label: string | null
    }) => Effect.Effect<
      SessionRecordingExportResult,
      SessionNotFoundError | UserInputError | UnsupportedCapabilityError | EnvironmentError
    >
    readonly replayRecording: (params: {
      readonly sessionId: string
      readonly script: ActionRecordingScript
    }) => Effect.Effect<
      SessionReplayResult,
      SessionNotFoundError | UserInputError | UnsupportedCapabilityError | EnvironmentError | ChildProcessError
    >
    readonly closeSession: (sessionId: string) => Effect.Effect<
      { readonly sessionId: string; readonly state: string; readonly closedAt: string },
      SessionNotFoundError | EnvironmentError
    >
    readonly runDebugCommand: (params: {
      readonly sessionId: string
      readonly outputMode: OutputMode
      readonly command: DebugCommandInput
    }) => Effect.Effect<
      DebugCommandResult,
      | SessionNotFoundError
      | UserInputError
      | UnsupportedCapabilityError
      | EnvironmentError
    >
  }
>() {}

export const SessionRegistryLive = Layer.scoped(
  SessionRegistry,
  Effect.gen(function* () {
    const artifactStore = yield* ArtifactStore
    const outputPolicy = yield* OutputPolicy
    const realDeviceHarness = yield* RealDeviceHarness
    const simulatorHarness = yield* SimulatorHarness
    const lldbBridgeFactory = yield* LldbBridgeFactory
    const sessionsRef = yield* Ref.make(new Map<string, ActiveSessionRecord>())
    const openingRef = yield* Ref.make<OpeningSessionReservation | null>(null)
    const openMutex = yield* Effect.makeSemaphore(1)

    const persistHealth = (sessionId: string, health: SessionHealth) =>
      Effect.gen(function* () {
        yield* artifactStore.writeSessionManifest(sessionId, health as unknown as Record<string, unknown>)
      })

    const isManifestRecord = (value: unknown): value is Record<string, unknown> =>
      typeof value === "object" && value !== null

    const readManifestString = (value: unknown): string | null =>
      typeof value === "string" ? value : null

    const buildMissingSessionNextStep = (sessionId: string) =>
      Effect.gen(function* () {
        const persisted = yield* artifactStore.readSessionManifest(sessionId)

        if (!persisted) {
          return "Open a new session or inspect the artifact root directly if the session has already closed."
        }

        const state = readManifestString(persisted.state) ?? "unknown"
        const artifactRoot = readManifestString(persisted.artifactRoot)

        return artifactRoot
          ? `Session ${sessionId} is not live in the current daemon, but a persisted ${state} manifest remains under ${artifactRoot}. Probe does not recover live sessions across daemon restarts or transport loss; inspect the saved artifacts and open a new session.`
          : `Session ${sessionId} is not live in the current daemon. A persisted ${state} manifest remains on disk, but Probe does not recover live sessions across daemon restarts or transport loss; inspect the saved artifacts and open a new session.`
      })

    const closeOpenedSessionOnFailure = (sessionId: string, opened: { readonly close: () => Promise<void> }) =>
      Effect.tryPromise({
        try: () => opened.close(),
        catch: (error) =>
          new EnvironmentError({
            code: "session-open-cleanup",
            reason: error instanceof Error ? error.message : String(error),
            nextStep: `Inspect the failed session artifacts under ${sessionId} if the runner wrapper does not exit cleanly.`,
            details: [],
          }),
      }).pipe(Effect.catchAll(() => Effect.void))

    const writeOpeningManifest = (sessionId: string, bundleId: string, root: string) =>
      artifactStore.writeSessionManifest(sessionId, {
        sessionId,
        state: "opening",
        openedAt: nowIso(),
        updatedAt: nowIso(),
        expiresAt: expiresAtIso(),
        artifactRoot: root,
        bundleId,
      })

    const refreshArtifacts = (sessionId: string) => artifactStore.listArtifacts(sessionId)

    const requireSessionRecord = (sessionId: string) =>
      Effect.gen(function* () {
        const sessions = yield* Ref.get(sessionsRef)
        const record = sessions.get(sessionId)

        if (!record) {
          const nextStep = yield* buildMissingSessionNextStep(sessionId)
          return yield* new SessionNotFoundError({
            sessionId,
            nextStep,
          })
        }

        return record
      })

    const markSessionRunnerFailed = (args: {
      readonly sessionId: string
      readonly record: ActiveSessionRecord
      readonly lastCommand: string
      readonly reason: string
      readonly wrapperRunning: boolean
      readonly pingRttMs?: number | null
    }) =>
      Effect.gen(function* () {
        if (args.record.health.state === "closing" || args.record.health.state === "closed") {
          return
        }

        const capabilities = isRealDeviceRecord(args.record)
          ? [...buildRealDeviceCapabilities({
              connection: args.record.health.connection,
              integrationPoints: args.record.integrationPoints,
              liveRunner: false,
            })]
          : args.record.health.capabilities

        args.record.health = {
          ...args.record.health,
          state: "failed",
          updatedAt: nowIso(),
          expiresAt: expiresAtIso(),
          resources: setRunnerResourceState(args.record.health.resources, "failed"),
          capabilities,
          healthCheck: {
            ...args.record.health.healthCheck,
            checkedAt: nowIso(),
            wrapperRunning: args.wrapperRunning,
            pingRttMs: args.pingRttMs ?? null,
            lastCommand: args.lastCommand,
            lastOk: false,
          },
          warnings: dedupeStrings([
            ...args.record.health.warnings,
            `${args.reason} ${nonRecoverableSessionWarning}`,
          ]),
          artifacts: [...(yield* refreshArtifacts(args.sessionId))],
        }

        yield* persistHealth(args.sessionId, args.record.health)
        yield* syncDaemonMetadata
      })

    const sendRunnerCommand = (
      sessionId: string,
      record: RunnerBackedActiveSessionRecord,
      action: "ping" | "snapshot" | "screenshot" | "recordVideo" | "shutdown" | "uiAction",
      payload?: string,
    ) =>
      Effect.tryPromise({
        try: () => record.sendRunnerCommand(record.nextSequence, action, payload),
        catch: (error) =>
          new EnvironmentError({
            code: `session-runner-${action}`,
            reason: error instanceof Error ? error.message : String(error),
            nextStep: "Inspect the runner artifacts, then close and reopen the session instead of expecting transparent recovery.",
            details: [],
          }),
      }).pipe(
        Effect.tapError((error) =>
          markSessionRunnerFailed({
            sessionId,
            record,
            lastCommand: action,
            reason: error.reason,
            wrapperRunning: record.isRunnerRunning(),
          }),
        ),
      )

    const refreshSessionArtifacts = (sessionId: string, record: ActiveSessionRecord) =>
      Effect.gen(function* () {
        record.health = {
          ...record.health,
          updatedAt: nowIso(),
          expiresAt: expiresAtIso(),
          artifacts: [...(yield* refreshArtifacts(sessionId))],
        }

        yield* persistHealth(sessionId, record.health)
        yield* syncDaemonMetadata
      })

    const validateLogRequest = (args: {
      readonly source: SessionLogSource
      readonly lineCount: number
      readonly captureSeconds: number
      readonly predicate: string | null
      readonly process: string | null
      readonly subsystem: string | null
      readonly category: string | null
    }) =>
      Effect.gen(function* () {
        if (!Number.isInteger(args.lineCount) || args.lineCount <= 0) {
          return yield* new UserInputError({
            code: "session-logs-line-count",
            reason: `Expected a positive integer line count, received ${args.lineCount}.`,
            nextStep: "Pass --lines <positive-integer> and retry the session logs request.",
            details: [],
          })
        }

        if (!Number.isInteger(args.captureSeconds) || args.captureSeconds <= 0 || args.captureSeconds > maxSessionLogCaptureSeconds) {
          return yield* new UserInputError({
            code: "session-logs-capture-seconds",
            reason: `Expected capture seconds between 1 and ${maxSessionLogCaptureSeconds}, received ${args.captureSeconds}.`,
            nextStep: `Pass --seconds <1-${maxSessionLogCaptureSeconds}> and retry the session logs request.`,
            details: [],
          })
        }

        if (
          args.source !== "simulator"
          && (args.predicate !== null || args.process !== null || args.subsystem !== null || args.category !== null)
        ) {
          return yield* new UserInputError({
            code: "session-logs-filter-source",
            reason: "Simulator predicate/process/subsystem/category filters only apply to --source simulator.",
            nextStep: "Retry with --source simulator, or drop the simulator-only filter flags.",
            details: [],
          })
        }
      })

    const renderLogResult = (args: {
      readonly sessionId: string
      readonly artifactRoot: string
      readonly source: SessionLogSource
      readonly content: string
      readonly summary: string
      readonly outputMode: OutputMode
    }): Effect.Effect<DrillResult, EnvironmentError> =>
      Effect.gen(function* () {
        if (outputPolicy.shouldInline(args.outputMode, args.content)) {
          return {
            kind: "inline",
            format: "text",
            summary: args.summary,
            content: args.content,
          } as const satisfies DrillResult
        }

        const logsTailDirectory = join(args.artifactRoot, "logs", "tails")
        const fileStem = `${timestampForFile()}-${sanitizeFileComponent(args.source, "log-tail")}`
        const absolutePath = join(logsTailDirectory, `${fileStem}.log`)

        yield* Effect.tryPromise({
          try: async () => {
            await mkdir(logsTailDirectory, { recursive: true })
            await writeFile(absolutePath, args.content, "utf8")
          },
          catch: (error) =>
            new EnvironmentError({
              code: "session-log-tail-write",
              reason: error instanceof Error ? error.message : String(error),
              nextStep: "Check write access to the session log-tail directory and retry.",
              details: [],
            }),
        })

        const artifact = createArtifactRecord({
          artifactRoot: args.artifactRoot,
          key: `log-tail-${fileStem}`,
          label: `log-tail-${args.source}`,
          kind: "text",
          absolutePath,
          summary: `${args.summary} (${summarizeContent(args.content)})`,
        })

        yield* artifactStore.registerArtifact(args.sessionId, artifact)

        return {
          kind: "summary+artifact",
          format: "text",
          summary: `${args.summary}; offloaded because ${describeLogOffloadReason(args.outputMode, args.content)}.`,
          artifact,
        } as const satisfies DrillResult
      })

    const writeSnapshotArtifact = (args: {
      readonly sessionId: string
      readonly artifactRoot: string
      readonly snapshot: StoredSnapshotArtifact
    }) =>
      Effect.gen(function* () {
        const snapshotsDirectory = join(args.artifactRoot, "snapshots")
        const fileStem = `${timestampForFile()}-${args.snapshot.snapshotId.replace(/^@/, "")}`
        const absolutePath = join(snapshotsDirectory, `${fileStem}.json`)

        yield* Effect.tryPromise({
          try: async () => {
            await mkdir(snapshotsDirectory, { recursive: true })
            await writeFile(absolutePath, `${JSON.stringify(args.snapshot, null, 2)}\n`, "utf8")
          },
          catch: (error) =>
            new EnvironmentError({
              code: "session-snapshot-write",
              reason: error instanceof Error ? error.message : String(error),
              nextStep: "Check write access to the session snapshots directory and retry the snapshot request.",
              details: [],
            }),
        })

        const artifact = createArtifactRecord({
          artifactRoot: args.artifactRoot,
          key: `snapshot-${args.snapshot.snapshotId.replace(/^@/, "")}`,
          label: `snapshot-${args.snapshot.snapshotId}`,
          kind: "json",
          absolutePath,
          summary:
            `Stable snapshot ${args.snapshot.snapshotId} with ${args.snapshot.metrics.nodeCount} nodes and ${args.snapshot.metrics.interactiveNodeCount} interactive nodes.`,
        })

        yield* artifactStore.registerArtifact(args.sessionId, artifact)
        return artifact
      })

    const writeJsonArtifact = (args: {
      readonly sessionId: string
      readonly artifactRoot: string
      readonly directory: string
      readonly fileStem: string
      readonly artifactKey: string
      readonly artifactLabel: string
      readonly summary: string
      readonly content: unknown
    }) =>
      Effect.gen(function* () {
        const targetDirectory = join(args.artifactRoot, args.directory)
        const absolutePath = join(targetDirectory, `${args.fileStem}.json`)

        yield* Effect.tryPromise({
          try: async () => {
            await mkdir(targetDirectory, { recursive: true })
            await writeFile(absolutePath, `${JSON.stringify(args.content, null, 2)}\n`, "utf8")
          },
          catch: (error) =>
            new EnvironmentError({
              code: "session-json-artifact-write",
              reason: error instanceof Error ? error.message : String(error),
              nextStep: `Check write access to the session ${args.directory} directory and retry.`,
              details: [],
            }),
        })

        const artifact = createArtifactRecord({
          artifactRoot: args.artifactRoot,
          key: args.artifactKey,
          label: args.artifactLabel,
          kind: "json",
          absolutePath,
          summary: args.summary,
        })

        yield* artifactStore.registerArtifact(args.sessionId, artifact)
        return artifact
      })

    const writeReplayReportArtifact = (args: {
      readonly sessionId: string
      readonly artifactRoot: string
      readonly report: ReplayReport
      readonly summary: string
    }) => {
      const fileStem = `${timestampForFile()}-replay`
      return writeJsonArtifact({
        sessionId: args.sessionId,
        artifactRoot: args.artifactRoot,
        directory: "replays",
        fileStem,
        artifactKey: `replay-${fileStem}`,
        artifactLabel: "replay-report",
        summary: args.summary,
        content: args.report,
      })
    }

    const captureRunnerScreenshotArtifact = (args: {
      readonly sessionId: string
      readonly record: RunnerBackedActiveSessionRecord
      readonly fileStem: string
      readonly artifactKey: string
      readonly artifactLabel: string
      readonly summary: string
    }) =>
      Effect.gen(function* () {
        const response = yield* sendRunnerCommand(args.sessionId, args.record, "screenshot")
        args.record.nextSequence += 1

        if (!response.ok) {
          return yield* new EnvironmentError({
            code: "session-screenshot-failed",
            reason: response.error ?? response.payload ?? `Runner screenshot failed with status ${response.statusLabel}.`,
            nextStep: "Inspect the latest runner artifacts, then retry the screenshot request.",
            details: [],
          })
        }

        if (!response.snapshotPayloadPath) {
          return yield* new EnvironmentError({
            code: "session-screenshot-payload-missing",
            reason: "Runner screenshot completed without reporting a PNG payload path.",
            nextStep: "Inspect the runner response artifact and align the screenshot transport contract before retrying.",
            details: [],
          })
        }

        const screenshotsDirectory = join(args.record.health.artifactRoot, "screenshots")
        const absolutePath = join(screenshotsDirectory, `${args.fileStem}.png`)

        yield* Effect.tryPromise({
          try: async () => {
            await mkdir(screenshotsDirectory, { recursive: true })
            await rename(response.snapshotPayloadPath!, absolutePath)
          },
          catch: (error) =>
            new EnvironmentError({
              code: "session-screenshot-artifact-write",
              reason: error instanceof Error ? error.message : String(error),
              nextStep: "Check write access to the session screenshots directory and retry the screenshot request.",
              details: [],
            }),
        })

        const artifact = createArtifactRecord({
          artifactRoot: args.record.health.artifactRoot,
          key: args.artifactKey,
          label: args.artifactLabel,
          kind: "png",
          absolutePath,
          summary: args.summary,
        })

        yield* artifactStore.registerArtifact(args.sessionId, artifact)

        return {
          artifact,
          statusLabel: response.statusLabel,
        }
      })

    const materializeFrameSequenceArtifact = (args: {
      readonly sessionId: string
      readonly artifactRoot: string
      readonly fileStem: string
      readonly artifactKey: string
      readonly artifactLabel: string
      readonly manifest: RunnerVideoCaptureManifest
    }) =>
      Effect.gen(function* () {
        const frameFiles = yield* Effect.tryPromise({
          try: async () => {
            const entries = await readdir(args.manifest.framesDirectoryPath)
            return entries.filter((entry) => entry.endsWith(".png")).sort()
          },
          catch: (error) =>
            new EnvironmentError({
              code: "session-video-frames-read",
              reason: error instanceof Error ? error.message : String(error),
              nextStep: "Inspect the runner video frames directory and retry the video request.",
              details: [],
            }),
        })

        if (frameFiles.length === 0) {
          return yield* new EnvironmentError({
            code: "session-video-frames-empty",
            reason: "Runner video capture completed without producing any frame PNGs.",
            nextStep: "Inspect the runner video manifest and frames directory, then retry the video request.",
            details: [],
          })
        }

        const bundlePath = join(args.artifactRoot, "video", `${args.fileStem}.frame-sequence`)
        const manifestPath = join(bundlePath, "frames.json")
        const archivePath = join(bundlePath, "frames.tar.gz")

        yield* Effect.tryPromise({
          try: async () => {
            await mkdir(bundlePath, { recursive: true })
            await writeFile(
              manifestPath,
              `${JSON.stringify({
                ...args.manifest,
                archivedAt: nowIso(),
                archiveFile: "frames.tar.gz",
              }, null, 2)}\n`,
              "utf8",
            )
          },
          catch: (error) =>
            new EnvironmentError({
              code: "session-video-manifest-write",
              reason: error instanceof Error ? error.message : String(error),
              nextStep: "Check write access to the session video directory and retry the video request.",
              details: [],
            }),
        })

        const tarResult = yield* Effect.tryPromise({
          try: () =>
            runHostCommand({
              command: tarExecutable,
              commandArgs: ["-czf", archivePath, ...frameFiles],
              cwd: args.manifest.framesDirectoryPath,
              timeoutMs: 60_000,
            }),
          catch: (error) =>
            new EnvironmentError({
              code: "session-video-frames-archive",
              reason: error instanceof Error ? error.message : String(error),
              nextStep: "Inspect tar availability and retry the video request.",
              details: [],
            }),
        })

        if (tarResult.exitCode !== 0) {
          return yield* new EnvironmentError({
            code: "session-video-frames-archive",
            reason: formatHostCommandFailure(`${tarExecutable} -czf`, tarResult),
            nextStep: "Inspect tar availability and retry the video request.",
            details: [],
          })
        }

        const artifact = createArtifactRecord({
          artifactRoot: args.artifactRoot,
          key: args.artifactKey,
          label: args.artifactLabel,
          kind: "directory",
          absolutePath: bundlePath,
          summary:
            `Frame-sequence bundle with ${args.manifest.frameCount} frame(s) at ${args.manifest.fps} fps because ffmpeg was not available for MP4 stitching.`,
        })

        yield* artifactStore.registerArtifact(args.sessionId, artifact)
        return artifact
      })

    const captureRunnerVideoArtifact = (args: {
      readonly sessionId: string
      readonly record: RunnerBackedActiveSessionRecord
      readonly durationMs: number
      readonly fileStem: string
      readonly artifactKey: string
      readonly artifactLabel: string
    }) =>
      Effect.gen(function* () {
        const response = yield* sendRunnerCommand(args.sessionId, args.record, "recordVideo", String(args.durationMs))
        args.record.nextSequence += 1

        if (!response.ok) {
          return yield* new EnvironmentError({
            code: "session-video-failed",
            reason: response.error ?? response.payload ?? `Runner video capture failed with status ${response.statusLabel}.`,
            nextStep: "Inspect the latest runner artifacts, then retry the video request.",
            details: [],
          })
        }

        if (!response.snapshotPayloadPath) {
          return yield* new EnvironmentError({
            code: "session-video-manifest-missing",
            reason: "Runner video capture completed without reporting a frames directory payload path.",
            nextStep: "Inspect the runner response artifact and align the video transport contract before retrying.",
            details: [],
          })
        }

        const framesDirectoryPath = response.snapshotPayloadPath
        const manifestPath = join(framesDirectoryPath, "manifest.json")

        const manifestContent = yield* Effect.tryPromise({
          try: () => readFile(manifestPath, "utf8"),
          catch: (error) =>
            new EnvironmentError({
              code: "session-video-manifest-read",
              reason: error instanceof Error ? error.message : String(error),
              nextStep: "Inspect the runner video manifest artifact and retry the video request.",
              details: [],
            }),
        })

        const manifest = yield* Effect.try({
          try: () => decodeRunnerVideoCaptureManifest(JSON.parse(manifestContent) as unknown, framesDirectoryPath),
          catch: (error) =>
            new EnvironmentError({
              code: "session-video-manifest-parse",
              reason: error instanceof Error ? error.message : String(error),
              nextStep: "Inspect the runner video manifest artifact and align the host/runner video contract before retrying.",
              details: [],
            }),
        })

        const framesExist = yield* Effect.tryPromise({
          try: () => fileExists(manifest.framesDirectoryPath),
          catch: (error) =>
            new EnvironmentError({
              code: "session-video-frames-check",
              reason: error instanceof Error ? error.message : String(error),
              nextStep: "Inspect the runner video frames directory and retry the video request.",
              details: [],
            }),
        })

        if (!framesExist) {
          return yield* new EnvironmentError({
            code: "session-video-frames-missing",
            reason: `Runner video manifest referenced missing frames directory ${manifest.framesDirectoryPath}.`,
            nextStep: "Inspect the runner video manifest artifact and retry the video request.",
            details: [],
          })
        }

        const ffmpegAvailable = yield* Effect.tryPromise({
          try: isFfmpegAvailable,
          catch: (error) =>
            new EnvironmentError({
              code: "session-video-ffmpeg-check",
              reason: error instanceof Error ? error.message : String(error),
              nextStep: "Inspect ffmpeg availability and retry the video request.",
              details: [],
            }),
        })

        if (!ffmpegAvailable) {
          const artifact = yield* materializeFrameSequenceArtifact({
            sessionId: args.sessionId,
            artifactRoot: args.record.health.artifactRoot,
            fileStem: args.fileStem,
            artifactKey: args.artifactKey,
            artifactLabel: args.artifactLabel,
            manifest,
          })

          return {
            artifact,
            statusLabel: response.statusLabel,
            mode: "frame-sequence" as const,
          }
        }

        const ffmpegExecutable = resolveFfmpegExecutable()
        const videoDirectory = join(args.record.health.artifactRoot, "video")
        const absolutePath = join(videoDirectory, `${args.fileStem}.mp4`)

        yield* Effect.tryPromise({
          try: async () => {
            await mkdir(videoDirectory, { recursive: true })
          },
          catch: (error) =>
            new EnvironmentError({
              code: "session-video-directory-create",
              reason: error instanceof Error ? error.message : String(error),
              nextStep: "Check write access to the session video directory and retry the video request.",
              details: [],
            }),
        })

        const ffmpegResult = yield* Effect.tryPromise({
          try: () =>
            runHostCommand({
              command: ffmpegExecutable,
              commandArgs: [
                "-y",
                "-framerate",
                String(manifest.fps || videoCaptureFps),
                "-i",
                "frame-%05d.png",
                "-c:v",
                "libx264",
                "-pix_fmt",
                "yuv420p",
                absolutePath,
              ],
              cwd: manifest.framesDirectoryPath,
              timeoutMs: manifest.durationMs + 60_000,
            }),
          catch: (error) =>
            new EnvironmentError({
              code: "session-video-ffmpeg-run",
              reason: error instanceof Error ? error.message : String(error),
              nextStep: "Inspect ffmpeg availability and retry the video request.",
              details: [],
            }),
        })

        if (ffmpegResult.exitCode !== 0) {
          return yield* new EnvironmentError({
            code: "session-video-ffmpeg-run",
            reason: formatHostCommandFailure(`${ffmpegExecutable} -framerate`, ffmpegResult),
            nextStep: "Inspect ffmpeg availability and retry the video request.",
            details: [],
          })
        }

        const artifact = createArtifactRecord({
          artifactRoot: args.record.health.artifactRoot,
          key: args.artifactKey,
          label: args.artifactLabel,
          kind: "mp4",
          absolutePath,
          summary: `MP4 video with ${manifest.frameCount} frame(s) at ${manifest.fps} fps stitched from runner screenshots via ffmpeg.`,
        })

        yield* artifactStore.registerArtifact(args.sessionId, artifact)

        return {
          artifact,
          statusLabel: response.statusLabel,
          mode: "mp4" as const,
        }
      })

    const persistRecordHealth = (sessionId: string, record: ActiveSessionRecord) =>
      persistHealth(sessionId, record.health).pipe(Effect.zipRight(syncDaemonMetadata))

    const setDebuggerHealth = (
      record: ActiveSessionRecord,
      debuggerDetails: SessionDebuggerDetails,
      debuggerResourceState: SessionResourceState,
    ) => {
      const nextHealthBase: SessionHealth = {
        ...record.health,
        updatedAt: nowIso(),
        expiresAt: expiresAtIso(),
        resources: setDebuggerResourceState(record.health.resources, debuggerResourceState),
        debugger: debuggerDetails,
        coordination: buildSessionCoordination(debuggerDetails),
      }

      record.health = {
        ...nextHealthBase,
        state: deriveSessionPhase(nextHealthBase),
      }
    }

    const isObjectRecord = (value: unknown): value is Record<string, unknown> =>
      typeof value === "object" && value !== null

    const readOptionalNumber = (value: unknown): number | null =>
      typeof value === "number" && Number.isFinite(value) ? value : null

    const readOptionalString = (value: unknown): string | null =>
      typeof value === "string" ? value : null

    const parseProcessSnapshot = (payload: Record<string, unknown>): DebugProcessSnapshot | null => {
      const process = payload.process

      if (!isObjectRecord(process)) {
        return null
      }

      const selectedThread = isObjectRecord(process.selectedThread)
        ? {
            threadId: readOptionalNumber(process.selectedThread.threadId) ?? -1,
            indexId: readOptionalNumber(process.selectedThread.indexId) ?? -1,
            stopReason: readOptionalString(process.selectedThread.stopReason) ?? "unknown",
            stopDescription: readOptionalString(process.selectedThread.stopDescription),
          }
        : null

      return {
        pid: readOptionalNumber(process.pid) ?? -1,
        state: readOptionalString(process.state) ?? "unknown",
        stopId: readOptionalNumber(process.stopId),
        selectedThread,
      }
    }

    const summarizeProcessState = (process: DebugProcessSnapshot | null): string => {
      if (!process) {
        return "no process state"
      }

      if (!process.selectedThread) {
        return process.state
      }

      const description = process.selectedThread.stopDescription
      return description
        ? `${process.state} (${process.selectedThread.stopReason}: ${description})`
        : `${process.state} (${process.selectedThread.stopReason})`
    }

    const describeDebugOffloadReason = (mode: OutputMode, content: string): string =>
      mode === "artifact"
        ? "artifact output was requested"
        : `${summarizeContent(content)} exceeds inline policy`

    const renderDebugOutput = (args: {
      readonly sessionId: string
      readonly artifactRoot: string
      readonly command: DebugCommandInput["command"]
      readonly summary: string
      readonly payload: Record<string, unknown>
      readonly outputMode: OutputMode
    }): Effect.Effect<DrillResult, EnvironmentError> =>
      Effect.gen(function* () {
        const content = `${JSON.stringify(args.payload, null, 2)}\n`

        if (outputPolicy.shouldInline(args.outputMode, content)) {
          return {
            kind: "inline",
            format: "json",
            summary: args.summary,
            content,
          } as const satisfies DrillResult
        }

        const fileStem = `${timestampForFile()}-${args.command}`
        const artifact = yield* writeJsonArtifact({
          sessionId: args.sessionId,
          artifactRoot: args.artifactRoot,
          directory: "debug/commands",
          fileStem,
          artifactKey: `debug-${fileStem}`,
          artifactLabel: `debug-${args.command}`,
          summary: `${args.summary} (${summarizeContent(content)})`,
          content: args.payload,
        })

        return {
          kind: "summary+artifact",
          format: "json",
          summary: `${args.summary}; offloaded because ${describeDebugOffloadReason(args.outputMode, content)}.`,
          artifact,
        } as const satisfies DrillResult
      })

    const requirePositiveInteger = (value: number | null, field: string, nextStep: string) => {
      if (value === null || !Number.isInteger(value) || value <= 0) {
        return new UserInputError({
          code: "session-debug-invalid-integer",
          reason: `${field} must be a positive integer when provided.`,
          nextStep,
          details: [],
        })
      }

      return null
    }

    const requireNonNegativeInteger = (value: number | null, field: string, nextStep: string) => {
      if (value === null || !Number.isInteger(value) || value < 0) {
        return new UserInputError({
          code: "session-debug-invalid-integer",
          reason: `${field} must be a non-negative integer when provided.`,
          nextStep,
          details: [],
        })
      }

      return null
    }

    const validateDebugCommand = (command: DebugCommandInput) =>
      Effect.gen(function* () {
        switch (command.command) {
          case "attach": {
            const error = requirePositiveInteger(
              command.pid,
              "attach pid",
              "Pass --pid <positive-integer> when attaching to an external host process.",
            )

            if (error) {
              return yield* error
            }

            return
          }

          case "backtrace": {
            if (!Number.isInteger(command.frameLimit) || command.frameLimit <= 0 || command.frameLimit > maxDebugFrameLimit) {
              return yield* new UserInputError({
                code: "session-debug-frame-limit",
                reason: `frameLimit must be an integer between 1 and ${maxDebugFrameLimit}.`,
                nextStep: `Pass --frame-limit <1-${maxDebugFrameLimit}> and retry the backtrace request.`,
                details: [],
              })
            }

            if (command.threadIndexId !== null) {
              const error = requirePositiveInteger(
                command.threadIndexId,
                "threadIndexId",
                "Pass --thread-index-id <positive-integer> and retry the backtrace request.",
              )

              if (error) {
                return yield* error
              }
            }

            return
          }

          case "vars": {
            if (command.threadIndexId !== null) {
              const error = requirePositiveInteger(
                command.threadIndexId,
                "threadIndexId",
                "Pass --thread-index-id <positive-integer> and retry the vars request.",
              )

              if (error) {
                return yield* error
              }
            }

            if (command.frameIndex !== null) {
              const error = requireNonNegativeInteger(
                command.frameIndex,
                "frameIndex",
                "Pass --frame-index <non-negative-integer> and retry the vars request.",
              )

              if (error) {
                return yield* error
              }
            }

            return
          }

          case "eval": {
            if (command.expression.trim().length === 0) {
              return yield* new UserInputError({
                code: "session-debug-expression-empty",
                reason: "Expression evaluation requires a non-empty expression string.",
                nextStep: "Pass --expression <code> and retry the eval request.",
                details: [],
              })
            }

            if (!Number.isInteger(command.timeoutMs) || command.timeoutMs <= 0 || command.timeoutMs > maxDebugEvalTimeoutMs) {
              return yield* new UserInputError({
                code: "session-debug-timeout-ms",
                reason: `timeoutMs must be an integer between 1 and ${maxDebugEvalTimeoutMs}.`,
                nextStep: `Pass --timeout-ms <1-${maxDebugEvalTimeoutMs}> and retry the eval request.`,
                details: [],
              })
            }

            if (command.threadIndexId !== null) {
              const error = requirePositiveInteger(
                command.threadIndexId,
                "threadIndexId",
                "Pass --thread-index-id <positive-integer> and retry the eval request.",
              )

              if (error) {
                return yield* error
              }
            }

            if (command.frameIndex !== null) {
              const error = requireNonNegativeInteger(
                command.frameIndex,
                "frameIndex",
                "Pass --frame-index <non-negative-integer> and retry the eval request.",
              )

              if (error) {
                return yield* error
              }
            }

            return
          }

          case "breakpoint-set": {
            if (command.location.kind === "function" && command.location.functionName.trim().length === 0) {
              return yield* new UserInputError({
                code: "session-debug-breakpoint-function",
                reason: "Function breakpoints require a non-empty function name.",
                nextStep: "Pass --function <symbol-name> and retry the breakpoint request.",
                details: [],
              })
            }

            if (command.location.kind === "file-line") {
              if (command.location.file.trim().length === 0 || !Number.isInteger(command.location.line) || command.location.line <= 0) {
                return yield* new UserInputError({
                  code: "session-debug-breakpoint-file-line",
                  reason: "File/line breakpoints require a non-empty file path and a positive line number.",
                  nextStep: "Pass --file <path> --line <positive-integer> and retry the breakpoint request.",
                  details: [],
                })
              }
            }

            return
          }

          case "breakpoint-clear": {
            if (!Number.isInteger(command.breakpointId) || command.breakpointId <= 0) {
              return yield* new UserInputError({
                code: "session-debug-breakpoint-id",
                reason: "breakpointId must be a positive integer.",
                nextStep: "Pass --breakpoint-id <positive-integer> and retry the breakpoint clear request.",
                details: [],
              })
            }

            return
          }

          case "continue":
          case "detach":
            return
        }
      })

    const resolveAttachTarget = (command: Extract<DebugCommandInput, { readonly command: "attach" }>) => ({
      pid: command.pid!,
      targetScope: command.targetScope,
      targetLabel: `external host process ${command.pid}`,
    } as const)

    const buildDebugSuccessSummary = (args: {
      readonly command: DebugCommandInput
      readonly response: Record<string, unknown>
      readonly processSnapshot: DebugProcessSnapshot | null
      readonly attachTarget: ReturnType<typeof resolveAttachTarget> | null
    }): string => {
      switch (args.command.command) {
        case "attach":
          return `Attached to ${args.attachTarget?.targetLabel ?? "target"}`
        case "backtrace":
          return `Backtrace captured for thread ${(args.response.thread as Record<string, unknown>)?.indexId ?? "unknown"}`
        case "vars":
          return `Variables captured for frame ${(args.response.frame as Record<string, unknown>)?.frameId ?? "unknown"}`
        case "eval":
          return `Expression evaluated: ${args.command.expression}`
        case "continue":
          return `Process continued, now ${summarizeProcessState(args.processSnapshot)}`
        case "detach":
          return `Debugger detached from process ${args.response.pid ?? "unknown"}`
        case "breakpoint-set":
          return `Breakpoint set at ${(args.response.breakpoint as Record<string, unknown>)?.numResolvedLocations ?? 0} location(s)`
        case "breakpoint-clear":
          return `Breakpoint ${args.command.breakpointId} cleared`
      }
    }

    const buildDebugFailureSummary = (args: {
      readonly command: DebugCommandInput
      readonly response: Record<string, unknown>
      readonly attachTarget: ReturnType<typeof resolveAttachTarget> | null
    }): string => {
      const error = typeof args.response.error === "string"
        ? args.response.error
        : "Unknown LLDB bridge error."

      if (args.command.command === "attach") {
        return `Attach to ${args.attachTarget?.targetLabel ?? "target"} failed: ${error}`
      }

      return `Debug command ${args.command.command} failed: ${error}`
    }

    const requireAttachedDebugger = (record: ActiveSessionRecord) =>
      Effect.gen(function* () {
        if (record.debuggerBridge === null || !record.debuggerBridge.isRunning()) {
          return yield* new UserInputError({
            code: "session-debug-not-attached",
            reason: "This session does not currently have a live LLDB bridge attached to a target.",
            nextStep: "Run session debug attach first, then retry the debugger command.",
            details: [],
          })
        }

        if (record.health.debugger.attachState !== "attached") {
          return yield* new UserInputError({
            code: "session-debug-not-attached",
            reason: "This session does not currently have an attached debug target.",
            nextStep: "Run session debug attach first, then retry the debugger command.",
            details: [],
          })
        }

        return record.debuggerBridge
      })

    const ensureDebuggerBridge = (sessionId: string, record: ActiveSessionRecord) =>
      Effect.gen(function* () {
        if (record.debuggerBridge !== null && record.debuggerBridge.isRunning()) {
          return record.debuggerBridge
        }

        const startedAt = nowIso()
        const bridge = yield* lldbBridgeFactory.start({
          sessionId,
          debugDirectory: join(record.health.artifactRoot, "debug"),
        })

        record.debuggerBridge = bridge

        const frameArtifact = createArtifactRecord({
          artifactRoot: record.health.artifactRoot,
          key: "lldb-bridge-frames",
          label: "lldb-bridge-frames",
          kind: "ndjson",
          absolutePath: bridge.frameLogPath,
          summary: "Raw LLDB bridge ready/response frames captured as NDJSON.",
        })
        const stderrArtifact = createArtifactRecord({
          artifactRoot: record.health.artifactRoot,
          key: "lldb-bridge-stderr",
          label: "lldb-bridge-stderr",
          kind: "text",
          absolutePath: bridge.stderrLogPath,
          summary: "stderr emitted by the LLDB Python bridge process.",
        })

        yield* artifactStore.registerArtifact(sessionId, frameArtifact)
        yield* artifactStore.registerArtifact(sessionId, stderrArtifact)

        setDebuggerHealth(
          record,
          {
            ...record.health.debugger,
            bridgePid: bridge.ready.bridgePid,
            bridgeStartedAt: startedAt,
            bridgeExitedAt: null,
            pythonExecutable: bridge.ready.pythonExecutable,
            lldbPythonPath: bridge.ready.lldbPythonPath,
            lldbVersion: bridge.ready.lldbVersion,
            lastUpdatedAt: startedAt,
            frameLogArtifactKey: frameArtifact.key,
            stderrArtifactKey: stderrArtifact.key,
          },
          record.health.debugger.attachState === "attached" ? "ready" : "ready",
        )
        yield* refreshSessionArtifacts(sessionId, record)

        bridge.waitForExit.then(() => {
          if (record.debuggerBridge !== bridge) {
            return
          }

          record.debuggerBridge = null

          const exitedAt = nowIso()
          const resourceState: SessionResourceState = record.health.state === "closing" || record.health.state === "closed"
            ? "stopped"
            : "failed"
          const attachState = resourceState === "failed"
            ? "failed"
            : record.health.debugger.attachState === "attached"
              ? "detached"
              : record.health.debugger.attachState

          setDebuggerHealth(
            record,
            {
              ...record.health.debugger,
              attachState,
              bridgeExitedAt: exitedAt,
              processState: resourceState === "failed" ? record.health.debugger.processState : "detached",
              lastCommandOk: resourceState === "failed" ? false : record.health.debugger.lastCommandOk,
              lastUpdatedAt: exitedAt,
            },
            resourceState,
          )

          void Effect.runPromise(persistRecordHealth(sessionId, record))
        })

        return bridge
      })

    const updateHealthCheck = (record: ActiveSessionRecord, command: string, ok: boolean) => {
      const nextHealth: SessionHealth = {
        ...record.health,
        updatedAt: nowIso(),
        expiresAt: expiresAtIso(),
        healthCheck: {
          ...record.health.healthCheck,
          checkedAt: nowIso(),
          wrapperRunning: record.isRunnerRunning(),
          lastCommand: command,
          lastOk: ok,
        },
      }

      record.health = {
        ...nextHealth,
        state: deriveSessionPhase(nextHealth),
      }
    }

    const assertRunnerActionsAvailable = (
      record: ActiveSessionRecord,
      nextStep = "Continue or detach the debugger before sending runner-backed actions, then retry.",
    ) =>
      Effect.gen(function* () {
        if (!record.health.coordination.runnerActionsBlocked) {
          return
        }

        return yield* new EnvironmentError({
          code: "session-runner-actions-blocked",
          reason: record.health.coordination.reason ?? "Runner-backed actions are currently blocked.",
          nextStep,
          details: [],
        })
      })

    const captureSnapshotArtifactInternal = (sessionId: string, record: ActiveSessionRecord) =>
      Effect.gen(function* () {
        yield* assertRunnerActionsAvailable(record)

        if (!isRunnerBackedRecord(record)) {
          return yield* new UnsupportedCapabilityError({
            code: "session-snapshot-real-device-runner",
            capability: "session.snapshot",
            reason: "This session does not currently expose a live runner transport for snapshots.",
            nextStep: "Inspect session health/artifacts, or reopen the session once the runner transport is live.",
            details: [],
            wall: false,
          })
        }

        const response = yield* sendRunnerCommand(sessionId, record, "snapshot")
        record.nextSequence += 1

        if (!response.ok) {
          updateHealthCheck(record, response.action, false)
          return yield* new EnvironmentError({
            code: "session-snapshot-failed",
            reason: response.error ?? response.payload ?? `Runner snapshot failed with status ${response.statusLabel}.`,
            nextStep: "Inspect the session runner log artifact and retry the snapshot request.",
            details: [],
          })
        }

        if (!response.snapshotPayloadPath) {
          updateHealthCheck(record, response.action, false)
          return yield* new EnvironmentError({
            code: "session-snapshot-payload-missing",
            reason: "Runner snapshot completed without reporting a snapshot payload path.",
            nextStep: "Inspect the runner response payload and align the snapshot transport contract before retrying.",
            details: [],
          })
        }

        const rawPayload = yield* Effect.tryPromise({
          try: () => readFile(response.snapshotPayloadPath!, "utf8"),
          catch: (error) =>
            new EnvironmentError({
              code: "session-snapshot-read",
              reason: error instanceof Error ? error.message : String(error),
              nextStep: "Inspect the runner snapshot payload path and retry the snapshot request.",
              details: [],
            }),
        })
        const rawSnapshot = yield* Effect.try({
          try: () => decodeRunnerSnapshotPayload(rawPayload),
          catch: (error) =>
            new EnvironmentError({
              code: "session-snapshot-parse",
              reason: error instanceof Error ? error.message : String(error),
              nextStep: "Inspect the runner snapshot payload JSON and align the host decoder before retrying.",
              details: [],
            }),
        })
        const built = buildSnapshotArtifact({
          previous: record.snapshotState.latest,
          nextSnapshotIndex: record.snapshotState.nextSnapshotIndex,
          nextElementRefIndex: record.snapshotState.nextElementRefIndex,
          raw: rawSnapshot,
        })
        const artifact = yield* writeSnapshotArtifact({
          sessionId,
          artifactRoot: record.health.artifactRoot,
          snapshot: built.artifact,
        })

        record.snapshotState = {
          latest: built.artifact,
          nextSnapshotIndex: built.nextSnapshotIndex,
          nextElementRefIndex: built.nextElementRefIndex,
        }
        updateHealthCheck(record, response.action, true)

        yield* refreshSessionArtifacts(sessionId, record)

        return {
          artifact: built.artifact,
          artifactRecord: artifact,
        }
      })

    const appendRecordedAction = (record: ActiveSessionRecord, action: RecordedSessionAction) => {
      record.recording.steps.push(action)
    }

    const syncDaemonMetadata =
      Effect.gen(function* () {
        const sessions = yield* Ref.get(sessionsRef)
        const opening = yield* Ref.get(openingRef)

        const metadata: Array<DaemonSessionMetadata> = [...sessions.values()].map((record) => ({
          sessionId: record.health.sessionId,
          state: record.health.state,
          bundleId: record.health.target.bundleId,
          simulatorUdid:
            record.health.target.platform === "simulator" ? record.health.target.deviceId : null,
          artifactRoot: record.health.artifactRoot,
          updatedAt: record.health.updatedAt,
        }))

        if (opening) {
          metadata.unshift({
            sessionId: opening.sessionId,
            state: "opening",
            bundleId: opening.bundleId,
            simulatorUdid: opening.simulatorUdid,
            artifactRoot: opening.artifactRoot,
            updatedAt: opening.updatedAt,
          })
        }

        yield* artifactStore.syncDaemonSessionMetadata(metadata)
      }).pipe(Effect.catchAll(() => Effect.void))

    const reserveOpeningSession = (args: {
      readonly platform: "simulator" | "device"
      readonly bundleId: string
      readonly simulatorUdid: string | null
      readonly deviceId: string | null
    }) =>
      openMutex.withPermits(1)(
        Effect.gen(function* () {
          const activeSessions = yield* Ref.get(sessionsRef)
          const opening = yield* Ref.get(openingRef)

          if (activeSessions.size > 0 || opening !== null) {
            return yield* new SessionConflictError({
              reason:
                "The current session registry only supports one active Probe session at a time while the simulator and real-device seams stay single-target.",
              nextStep:
                "Close the existing session or wait for it to expire before opening another one.",
            })
          }

          const openedAt = nowIso()
          const reservation: OpeningSessionReservation = {
            sessionId: randomUUID(),
            platform: args.platform,
            bundleId: args.bundleId,
            simulatorUdid: args.simulatorUdid,
            deviceId: args.deviceId,
            artifactRoot: null,
            openedAt,
            updatedAt: openedAt,
            expiresAt: expiresAtIso(),
          }

          yield* Ref.set(openingRef, reservation)
          yield* syncDaemonMetadata

          return reservation
        }),
      )

    const finalizeOpeningSession = (sessionId: string, removeLayout: boolean) =>
      Effect.gen(function* () {
        const opening = yield* Ref.get(openingRef)

        if (opening?.sessionId === sessionId) {
          yield* Ref.set(openingRef, null)
        }

        if (removeLayout) {
          yield* artifactStore.removeSessionLayout(sessionId)
        }

        yield* syncDaemonMetadata
      }).pipe(Effect.catchAll(() => Effect.void))

    const closeDebuggerBridgeInternal = (sessionId: string, record: ActiveSessionRecord) =>
      Effect.gen(function* () {
        const bridge = record.debuggerBridge

        if (bridge === null) {
          return false
        }

        record.debuggerBridge = null

        yield* Effect.tryPromise({
          try: () => bridge.close(),
          catch: (error) =>
            new EnvironmentError({
              code: "session-close-debugger",
              reason: error instanceof Error ? error.message : String(error),
              nextStep: "Inspect the LLDB bridge artifacts and retry closing the session.",
              details: [],
            }),
        }).pipe(Effect.catchAll(() => Effect.succeed(undefined)))

        const closedAt = nowIso()
        const debuggerWasRequested = record.health.resources.debugger !== "not-requested"
        const nextDebuggerState: SessionDebuggerDetails = {
          ...record.health.debugger,
          attachState: debuggerWasRequested
            ? (record.health.debugger.attachState === "failed" ? "failed" : "detached")
            : record.health.debugger.attachState,
          processState: debuggerWasRequested ? "detached" : record.health.debugger.processState,
          stopReason: debuggerWasRequested ? null : record.health.debugger.stopReason,
          stopDescription: debuggerWasRequested ? null : record.health.debugger.stopDescription,
          bridgeExitedAt: closedAt,
          lastUpdatedAt: closedAt,
        }

        const nextHealth: SessionHealth = {
          ...record.health,
          updatedAt: closedAt,
          expiresAt: expiresAtIso(),
          resources: setDebuggerResourceState(
            record.health.resources,
            debuggerWasRequested ? "stopped" : "not-requested",
          ),
          debugger: nextDebuggerState,
          coordination: buildSessionCoordination(nextDebuggerState),
        }

        record.health = {
          ...nextHealth,
          state: deriveSessionPhase(nextHealth),
        }

        yield* persistHealth(sessionId, record.health)
        return true
      })

    const closeSessionInternal = (
      sessionId: string,
      reason: "explicit-close" | "ttl-expired" | "daemon-shutdown" | "runner-exit",
    ) =>
      Effect.gen(function* () {
        const sessions = yield* Ref.get(sessionsRef)
        const record = sessions.get(sessionId)

        if (!record) {
          return false
        }

        if (record.health.state !== "closed") {
          record.health = {
            ...record.health,
            state: "closing",
            updatedAt: nowIso(),
            expiresAt: expiresAtIso(),
            resources: setSessionResourceStates(record.health.resources, {
              runner: "stopping",
              debugger: record.health.resources.debugger === "not-requested"
                ? "not-requested"
                : "stopping",
            }),
          }
          yield* persistHealth(sessionId, record.health)
        }

        yield* closeDebuggerBridgeInternal(sessionId, record)

        if (reason !== "runner-exit" && isRunnerBackedRecord(record) && record.isRunnerRunning()) {
          yield* Effect.tryPromise({
            try: async () => {
              await record.sendRunnerCommand(record.nextSequence, "shutdown")
            },
            catch: () => new EnvironmentError({
              code: "session-close-shutdown",
              reason: `Failed to send shutdown to session ${sessionId}; falling back to wrapper termination.`,
              nextStep: "Inspect the session log artifact if the runner did not exit cleanly.",
              details: [],
            }),
          }).pipe(Effect.catchAll(() => Effect.succeed(undefined)))
        }

        yield* Effect.tryPromise({
          try: () => record.closeResources(),
          catch: (error) =>
            new EnvironmentError({
              code: "session-close-resources",
              reason: error instanceof Error ? error.message : String(error),
              nextStep: "Inspect the session artifacts and retry closing the session.",
              details: [],
            }),
        })

        record.health = {
          ...record.health,
          state: "closed",
          updatedAt: nowIso(),
          expiresAt: expiresAtIso(),
          resources: setSessionResourceStates(record.health.resources, {
            runner: "stopped",
            debugger: record.health.resources.debugger === "not-requested"
              ? "not-requested"
              : "stopped",
          }),
          healthCheck: {
            ...record.health.healthCheck,
            checkedAt: nowIso(),
            wrapperRunning: false,
            lastCommand: reason === "runner-exit" ? "runner-exit" : "shutdown",
            lastOk: reason === "runner-exit" ? false : true,
          },
        }
        yield* persistHealth(sessionId, record.health)

        yield* Ref.update(sessionsRef, (current) => {
          const next = new Map(current)
          next.delete(sessionId)
          return next
        })
        yield* syncDaemonMetadata

        return true
      })

    const sweeper = Effect.forever(
      Effect.gen(function* () {
        const sessions = yield* Ref.get(sessionsRef)
        const expiredIds = [...sessions.values()]
          .filter((record) => Date.parse(record.health.expiresAt) <= Date.now())
          .map((record) => record.health.sessionId)

        for (const sessionId of expiredIds) {
          yield* closeSessionInternal(sessionId, "ttl-expired")
        }

        yield* Effect.sleep(ttlSweepIntervalMs)
      }),
    )

    yield* Effect.forkScoped(sweeper)
    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        const sessions = yield* Ref.get(sessionsRef)
        const opening = yield* Ref.get(openingRef)

        for (const sessionId of sessions.keys()) {
          yield* closeSessionInternal(sessionId, "daemon-shutdown")
        }

        if (opening) {
          yield* finalizeOpeningSession(opening.sessionId, true)
        }
      }).pipe(Effect.catchAll(() => Effect.succeed(undefined))),
    )

    return SessionRegistry.of({
      getSessionTtlMs: () => defaultSessionTtlMs,
      getActiveSessionCount: () =>
        Effect.gen(function* () {
          const sessions = yield* Ref.get(sessionsRef)
          const opening = yield* Ref.get(openingRef)
          return sessions.size + (opening ? 1 : 0)
        }),
      openDeviceSession: ({ bundleId, deviceId, rootDir, emitProgress }) =>
        Effect.gen(function* () {
          const reservation = yield* reserveOpeningSession({
            platform: "device",
            bundleId,
            simulatorUdid: null,
            deviceId,
          })

          return yield* Effect.acquireUseRelease(
            Effect.succeed(reservation),
            (opening) =>
              Effect.gen(function* () {
                const layout = yield* artifactStore.createSessionLayout(opening.sessionId)

                const hydratedOpening: OpeningSessionReservation = {
                  ...opening,
                  artifactRoot: layout.root,
                  updatedAt: nowIso(),
                }

                yield* Ref.set(openingRef, hydratedOpening)
                yield* writeOpeningManifest(opening.sessionId, bundleId, layout.root)
                yield* syncDaemonMetadata

                const manifestArtifact: ArtifactRecord = {
                  key: "session-manifest",
                  label: "session-manifest",
                  kind: "json",
                  summary: "Latest persisted session state snapshot.",
                  absolutePath: layout.manifestPath,
                  relativePath: relative(layout.root, layout.manifestPath),
                  external: false,
                  createdAt: nowIso(),
                }
                yield* artifactStore.registerArtifact(opening.sessionId, manifestArtifact)

                emitProgress("device.resolve", "Resolving a concrete real-device target through CoreDevice.")

                const opened = yield* realDeviceHarness.openLiveSession({
                  rootDir,
                  sessionId: opening.sessionId,
                  artifactRoot: layout.root,
                  runnerDirectory: layout.runnerDirectory,
                  logsDirectory: layout.logsDirectory,
                  bundleId,
                  requestedDeviceId: deviceId,
                })

                emitProgress("runner.ready", "Real-device runner attached and acknowledged the initial ping.")

                return yield* Effect.gen(function* () {
                  const discoveredArtifacts = yield* Effect.tryPromise({
                    try: () =>
                      makeArtifacts(layout.root, [
                        {
                          key: "device-preflight-report",
                          label: "device-preflight-report",
                          kind: "json",
                          absolutePath: opened.preflightReportPath,
                          summary: "Real-device preflight summary including DDI, device discovery, and signing checks.",
                        },
                        {
                          key: "preferred-ddi",
                          label: "preferred-ddi",
                          kind: "json",
                          absolutePath: opened.preferredDdiJsonPath,
                          summary: "Raw devicectl preferred DDI JSON captured during real-device preflight.",
                        },
                        {
                          key: "device-list",
                          label: "device-list",
                          kind: "json",
                          absolutePath: opened.devicesJsonPath,
                          summary: "Raw devicectl device-list JSON captured during real-device preflight.",
                        },
                        {
                          key: "installed-apps",
                          label: "installed-apps",
                          kind: "json",
                          absolutePath: opened.installedAppsJsonPath,
                          summary: "Raw devicectl installed-apps JSON filtered to the requested target bundle id.",
                        },
                        {
                          key: "device-process-launch",
                          label: "device-process-launch",
                          kind: "json",
                          absolutePath: opened.launchJsonPath,
                          summary: "Raw devicectl process-launch JSON for the target app Probe attached to on device.",
                        },
                        ...(opened.ddiServicesJsonPath
                          ? [{
                              key: "ddi-services",
                              label: "ddi-services",
                              kind: "json" as const,
                              absolutePath: opened.ddiServicesJsonPath,
                              summary: "Raw devicectl DDI-services JSON captured for the selected real device.",
                            }]
                          : []),
                        ...(opened.buildLogPath
                          ? [{
                              key: "build-log",
                              label: "build-log",
                              kind: "text" as const,
                              absolutePath: opened.buildLogPath,
                              summary: "Signed iPhoneOS build-for-testing output for the real-device preflight.",
                            }]
                          : []),
                        {
                          key: "xcodebuild-session-log",
                          label: "xcodebuild-session-log",
                          kind: "text",
                          absolutePath: opened.logPath,
                          summary: "Mixed xcodebuild and XCTest output from the active real-device runner session.",
                        },
                        {
                          key: "stdout-events",
                          label: "stdout-events",
                          kind: "ndjson",
                          absolutePath: opened.stdoutEventsPath,
                          summary: "Structured stdout-framed runner events captured by the observer wrapper for the real-device session.",
                        },
                        {
                          key: "result-bundle",
                          label: "result-bundle",
                          kind: "directory",
                          absolutePath: opened.resultBundlePath,
                          summary: "xcodebuild result bundle for the active real-device runner session.",
                        },
                        {
                          key: "wrapper-stderr",
                          label: "wrapper-stderr",
                          kind: "text",
                          absolutePath: opened.wrapperStderrPath,
                          summary: "stderr from the Python wrapper that supervises the real-device xcodebuild boundary.",
                        },
                        ...(opened.xctestrunPath
                          ? [{
                              key: "xctestrun",
                              label: "xctestrun",
                              kind: "xml" as const,
                              absolutePath: opened.xctestrunPath,
                              summary: "Generated xctestrun metadata emitted by the signed real-device preflight build.",
                            }]
                          : []),
                        ...(opened.targetAppPath
                          ? [{
                              key: "target-app",
                              label: "target-app",
                              kind: "directory" as const,
                              absolutePath: opened.targetAppPath,
                              summary: "Signed target app bundle emitted by the real-device preflight build for the requested bundle id.",
                            }]
                          : []),
                        ...(opened.runnerAppPath
                          ? [{
                              key: "runner-app",
                              label: "runner-app",
                              kind: "directory" as const,
                              absolutePath: opened.runnerAppPath,
                              summary: "Signed ProbeRunnerUITests-Runner.app emitted by the real-device preflight build.",
                            }]
                          : []),
                        ...(opened.runnerXctestPath
                          ? [{
                              key: "runner-xctest",
                              label: "runner-xctest",
                              kind: "directory" as const,
                              absolutePath: opened.runnerXctestPath,
                              summary: "ProbeRunnerUITests.xctest bundle emitted by the real-device preflight build.",
                            }]
                          : []),
                      ]),
                    catch: (error) =>
                      new EnvironmentError({
                        code: "device-session-artifact-discovery",
                        reason: error instanceof Error ? error.message : String(error),
                        nextStep: "Inspect the device session artifact root and retry opening the session.",
                        details: [],
                      }),
                  })

                  for (const artifact of discoveredArtifacts) {
                    yield* artifactStore.registerArtifact(opening.sessionId, artifact)
                  }

                  const warnings = buildRealDeviceWarnings(opened)
                  const debuggerState = makeDefaultDebuggerState()
                  const healthCheck: SessionHealthCheck = {
                    checkedAt: nowIso(),
                    wrapperRunning: opened.isWrapperRunning(),
                    pingRttMs: opened.initialPingRttMs,
                    lastCommand: "ping",
                    lastOk: true,
                  }

                  const health: SessionHealth = {
                    sessionId: opening.sessionId,
                    state: "ready",
                    openedAt: opening.openedAt,
                    updatedAt: nowIso(),
                    expiresAt: expiresAtIso(),
                    artifactRoot: layout.root,
                    target: {
                      platform: "device",
                      bundleId: opened.bundleId,
                      deviceId: opened.device.identifier,
                      deviceName: opened.device.name,
                        runtime: opened.device.runtime,
                    },
                    connection: opened.connection,
                    resources: makeSessionResources("ready"),
                    transport: {
                      kind: "real-device-live",
                      contract: opened.runnerTransportContract,
                      bootstrapSource: opened.bootstrapSource,
                      bootstrapPath: opened.bootstrapPath,
                      sessionIdentifier: opened.sessionIdentifier,
                      commandIngress: opened.commandIngress,
                      eventEgress: opened.eventEgress,
                      stdinProbeStatus: opened.stdinProbeStatus,
                      note:
                        "The current real-device slice reuses the validated XCUITest boundary seam: device bootstrap manifest plus file-backed command ingress plus stdout-framed event egress.",
                    },
                    capabilities: [...buildRealDeviceCapabilities({
                      connection: opened.connection,
                      integrationPoints: opened.integrationPoints,
                      liveRunner: true,
                    })],
                    runner: {
                      kind: "real-device-live",
                      wrapperProcessId: opened.wrapperProcessId,
                      testProcessId: opened.testProcessId,
                      targetProcessId: opened.targetProcessId,
                      attachLatencyMs: opened.attachLatencyMs,
                      runtimeControlDirectory: opened.runtimeControlDirectory,
                      observerControlDirectory: opened.observerControlDirectory,
                      logPath: opened.logPath,
                      buildLogPath: opened.buildLogPath,
                      stdoutEventsPath: opened.stdoutEventsPath,
                      resultBundlePath: opened.resultBundlePath,
                      wrapperStderrPath: opened.wrapperStderrPath,
                      stdinProbeStatus: opened.stdinProbeStatus,
                      connectionStatus: opened.connection.status,
                      lastCheckedAt: opened.connection.checkedAt,
                      note:
                        "The real-device runner is live over the same file-mailbox + stdout-JSONL mixed-log transport validated on simulator.",
                    },
                    healthCheck,
                    debugger: debuggerState,
                    coordination: buildSessionCoordination(debuggerState),
                    warnings: [...warnings],
                    artifacts: [...(yield* refreshArtifacts(opening.sessionId))],
                  }

                  const record: RealDeviceActiveSessionRecord = {
                    kind: "device",
                    health,
                    baseWarnings: warnings,
                    integrationPoints: opened.integrationPoints,
                    nextSequence: opened.nextSequence,
                    debuggerBridge: null,
                    snapshotState: {
                      latest: null,
                      nextSnapshotIndex: 1,
                      nextElementRefIndex: 1,
                    },
                    recording: {
                      steps: [],
                    },
                    sendRunnerCommand: opened.sendCommand,
                    refreshConnection: opened.refreshConnection,
                    closeResources: opened.close,
                    isRunnerRunning: opened.isWrapperRunning,
                    waitForExit: opened.waitForExit,
                  }

                  yield* persistHealth(opening.sessionId, health)
                  yield* Ref.update(sessionsRef, (current) => new Map(current).set(opening.sessionId, record))

                  record.waitForExit?.then(() => {
                    if (record.health.state === "closing" || record.health.state === "closed") {
                      return
                    }

                    void Effect.runPromise(
                      markSessionRunnerFailed({
                        sessionId: opening.sessionId,
                        record,
                        lastCommand: "runner-exit",
                        reason: "The real-device runner wrapper exited unexpectedly.",
                        wrapperRunning: false,
                      }).pipe(
                        Effect.catchAll(() => Effect.void),
                      ),
                    )
                  })

                  return health
                }).pipe(
                  Effect.onError(() => closeOpenedSessionOnFailure(opening.sessionId, opened)),
                )
              }),
            (opening, exit) => finalizeOpeningSession(opening.sessionId, exit._tag === "Failure"),
          )
        }),
      openSimulatorSession: ({ bundleId, sessionMode, simulatorUdid, rootDir, emitProgress }) =>
        Effect.gen(function* () {
          const reservation = yield* reserveOpeningSession({
            platform: "simulator",
            bundleId,
            simulatorUdid,
            deviceId: null,
          })

          return yield* Effect.acquireUseRelease(
            Effect.succeed(reservation),
            (opening) =>
              Effect.gen(function* () {
                const layout = yield* artifactStore.createSessionLayout(opening.sessionId)

                const hydratedOpening: OpeningSessionReservation = {
                  ...opening,
                  artifactRoot: layout.root,
                  updatedAt: nowIso(),
                }

                yield* Ref.set(openingRef, hydratedOpening)
                yield* writeOpeningManifest(opening.sessionId, bundleId, layout.root)
                yield* syncDaemonMetadata

                const manifestArtifact: ArtifactRecord = {
                  key: "session-manifest",
                  label: "session-manifest",
                  kind: "json",
                  summary: "Latest persisted session state snapshot.",
                  absolutePath: layout.manifestPath,
                  relativePath: relative(layout.root, layout.manifestPath),
                  external: false,
                  createdAt: nowIso(),
                }
                yield* artifactStore.registerArtifact(opening.sessionId, manifestArtifact)

                emitProgress("simulator.resolve", "Resolving a concrete Simulator target.")

                const opened = yield* simulatorHarness.openSession({
                  rootDir,
                  sessionId: opening.sessionId,
                  artifactRoot: layout.root,
                  runnerDirectory: layout.runnerDirectory,
                  logsDirectory: layout.logsDirectory,
                  bundleId,
                  sessionMode,
                  simulatorUdid,
                })

                emitProgress("runner.ready", "Runner attached and acknowledged the initial ping.")

                return yield* Effect.gen(function* () {
                  const discoveredArtifacts = yield* Effect.tryPromise({
                    try: () =>
                      makeArtifacts(layout.root, [
                        {
                          key: "build-log",
                          label: "build-log",
                          kind: "text",
                          absolutePath: opened.buildLogPath,
                          summary: "xcodebuild build-for-testing output for the session runner preparation.",
                        },
                        {
                          key: "xcodebuild-session-log",
                          label: "xcodebuild-session-log",
                          kind: "text",
                          absolutePath: opened.logPath,
                          summary: "Mixed xcodebuild and XCTest output from the active runner session.",
                        },
                        {
                          key: "stdout-events",
                          label: "stdout-events",
                          kind: "ndjson",
                          absolutePath: opened.stdoutEventsPath,
                          summary: "Structured stdout-framed runner events captured by the observer wrapper.",
                        },
                        {
                          key: "result-bundle",
                          label: "result-bundle",
                          kind: "directory",
                          absolutePath: opened.resultBundlePath,
                          summary: "xcodebuild result bundle for the active runner session.",
                        },
                        {
                          key: "wrapper-stderr",
                          label: "wrapper-stderr",
                          kind: "text",
                          absolutePath: opened.wrapperStderrPath,
                          summary: "stderr from the Python wrapper that supervises the xcodebuild boundary.",
                        },
                      ]),
                    catch: (error) =>
                      new EnvironmentError({
                        code: "session-artifact-discovery",
                        reason: error instanceof Error ? error.message : String(error),
                        nextStep: "Inspect the session artifact root and retry opening the session.",
                        details: [],
                      }),
                  })

                  for (const artifact of discoveredArtifacts) {
                    yield* artifactStore.registerArtifact(opening.sessionId, artifact)
                  }

                  const warnings = buildSimulatorWarnings(opened)
                  const debuggerState = makeDefaultDebuggerState()
                  const healthCheck: SessionHealthCheck = {
                    checkedAt: nowIso(),
                    wrapperRunning: opened.isWrapperRunning(),
                    pingRttMs: opened.initialPingRttMs,
                    lastCommand: "ping",
                    lastOk: true,
                  }

                  const health: SessionHealth = {
                    sessionId: opening.sessionId,
                    state: "ready",
                    openedAt: opening.openedAt,
                    updatedAt: nowIso(),
                    expiresAt: expiresAtIso(),
                    artifactRoot: layout.root,
                    target: {
                      platform: "simulator",
                      bundleId: opened.bundleId,
                      deviceId: opened.simulator.udid,
                      deviceName: opened.simulator.name,
                      runtime: opened.simulator.runtime,
                    },
                    connection: buildConnectedConnectionDetails({
                      summary: `Simulator ${opened.simulator.name} (${opened.simulator.udid}) is booted and under daemon control.`,
                      details: [
                        `runtime: ${opened.simulator.runtime}`,
                        "Simulator reachability is owned by the daemon-backed simctl/xcodebuild session.",
                      ],
                    }),
                    resources: makeSessionResources("ready"),
                    transport: {
                      kind: "simulator-runner",
                      contract: opened.runnerTransportContract,
                      bootstrapSource: opened.bootstrapSource,
                      bootstrapPath: opened.bootstrapPath,
                      sessionIdentifier: opened.sessionIdentifier,
                      commandIngress: opened.commandIngress,
                      eventEgress: opened.eventEgress,
                      stdinProbeStatus: opened.stdinProbeStatus,
                      note:
                        "The current vertical slice uses the transport seam validated by the runner boundary spikes: simulator bootstrap manifest plus file-backed command ingress plus stdout-framed event egress.",
                    },
                    capabilities: [...buildSimulatorCapabilities()],
                    runner: {
                      kind: "simulator-runner",
                      wrapperProcessId: opened.wrapperProcessId,
                      testProcessId: opened.testProcessId,
                      targetProcessId: opened.targetProcessId,
                      attachLatencyMs: opened.attachLatencyMs,
                      runtimeControlDirectory: opened.runtimeControlDirectory,
                      observerControlDirectory: opened.observerControlDirectory,
                      logPath: opened.logPath,
                      buildLogPath: opened.buildLogPath,
                      stdoutEventsPath: opened.stdoutEventsPath,
                      resultBundlePath: opened.resultBundlePath,
                      wrapperStderrPath: opened.wrapperStderrPath,
                      stdinProbeStatus: opened.stdinProbeStatus,
                    },
                    healthCheck,
                    debugger: debuggerState,
                    coordination: buildSessionCoordination(debuggerState),
                    warnings: [...warnings],
                    artifacts: [...(yield* refreshArtifacts(opening.sessionId))],
                  }

                  const record: SimulatorActiveSessionRecord = {
                    kind: "simulator",
                    health,
                    baseWarnings: warnings,
                    nextSequence: opened.nextSequence,
                    debuggerBridge: null,
                    snapshotState: {
                      latest: null,
                      nextSnapshotIndex: 1,
                      nextElementRefIndex: 1,
                    },
                    recording: {
                      steps: [],
                    },
                    sendRunnerCommand: opened.sendCommand,
                    closeResources: opened.close,
                    isRunnerRunning: opened.isWrapperRunning,
                    waitForExit: opened.waitForExit,
                  }

                  yield* persistHealth(opening.sessionId, health)
                  yield* Ref.update(sessionsRef, (current) => new Map(current).set(opening.sessionId, record))

                  record.waitForExit.then(() => {
                    if (record.health.state === "closing" || record.health.state === "closed") {
                      return
                    }

                    void Effect.runPromise(
                      markSessionRunnerFailed({
                        sessionId: opening.sessionId,
                        record,
                        lastCommand: "runner-exit",
                        reason: "The runner wrapper exited unexpectedly.",
                        wrapperRunning: false,
                      }).pipe(
                        Effect.catchAll(() => Effect.void),
                      ),
                    )
                  })

                  return health
                }).pipe(
                  Effect.onError(() => closeOpenedSessionOnFailure(opening.sessionId, opened)),
                )
              }),
            (opening, exit) => finalizeOpeningSession(opening.sessionId, exit._tag === "Failure"),
          )
        }),
      getSessionHealth: (sessionId) =>
        Effect.gen(function* () {
          const sessions = yield* Ref.get(sessionsRef)
          const record = sessions.get(sessionId)

          if (!record) {
            const nextStep = yield* buildMissingSessionNextStep(sessionId)
            return yield* new SessionNotFoundError({
              sessionId,
              nextStep,
            })
          }

          if (isRealDeviceRecord(record)) {
            const connection = yield* Effect.tryPromise({
              try: () => record.refreshConnection(),
              catch: (error) =>
                new EnvironmentError({
                  code: "device-session-health",
                  reason: error instanceof Error ? error.message : String(error),
                  nextStep: "Inspect the saved real-device preflight artifacts and retry the session health request.",
                  details: [],
                }),
            })

            if (!isRunnerBackedRecord(record)) {
              const runnerDetails = record.health.runner.kind === "real-device-preflight"
                ? {
                    ...record.health.runner,
                    connectionStatus: connection.status,
                    lastCheckedAt: connection.checkedAt,
                  }
                : record.health.runner

              const nextHealth: SessionHealth = {
                ...record.health,
                updatedAt: nowIso(),
                expiresAt: expiresAtIso(),
                connection,
                resources: setRunnerResourceState(record.health.resources, "degraded"),
                capabilities: [...buildRealDeviceCapabilities({
                  connection,
                  integrationPoints: record.integrationPoints,
                  liveRunner: false,
                })],
                runner: runnerDetails,
                healthCheck: {
                  checkedAt: nowIso(),
                  wrapperRunning: false,
                  pingRttMs: null,
                  lastCommand: "device-health",
                  lastOk: connection.status === "connected",
                },
                warnings: connection.status === "connected"
                  ? [...record.baseWarnings]
                  : composeWarnings(record, [
                      `Selected device ${record.health.target.deviceName} (${record.health.target.deviceId}) is currently disconnected. Probe keeps the session degraded instead of claiming transparent recovery.`,
                    ]),
                artifacts: [...(yield* refreshArtifacts(sessionId))],
              }

              record.health = {
                ...nextHealth,
                state: deriveSessionPhase(nextHealth),
              }

              yield* persistHealth(sessionId, record.health)
              yield* syncDaemonMetadata
              return record.health
            }

            const deviceDisconnectedWarning =
              `Selected device ${record.health.target.deviceName} (${record.health.target.deviceId}) is currently disconnected. Probe keeps the session degraded instead of claiming transparent recovery.`
            const runnerDetails = record.health.runner.kind === "real-device-live"
              ? {
                  ...record.health.runner,
                  connectionStatus: connection.status,
                  lastCheckedAt: connection.checkedAt,
                }
              : record.health.runner

            if (!record.isRunnerRunning()) {
              const nextHealth: SessionHealth = {
                ...record.health,
                updatedAt: nowIso(),
                expiresAt: expiresAtIso(),
                connection,
                resources: setRunnerResourceState(record.health.resources, "failed"),
                capabilities: [...buildRealDeviceCapabilities({
                  connection,
                  integrationPoints: record.integrationPoints,
                  liveRunner: false,
                })],
                runner: runnerDetails,
                healthCheck: {
                  checkedAt: nowIso(),
                  wrapperRunning: false,
                  pingRttMs: null,
                  lastCommand: "ping",
                  lastOk: false,
                },
                warnings: composeWarnings(record, [
                  "The real-device runner wrapper process is no longer running. Probe fails closed instead of pretending the device runner recovered.",
                  ...(connection.status === "connected" ? [] : [deviceDisconnectedWarning]),
                ]),
                artifacts: [...(yield* refreshArtifacts(sessionId))],
              }

              record.health = {
                ...nextHealth,
                state: deriveSessionPhase(nextHealth),
              }

              yield* persistHealth(sessionId, record.health)
              yield* syncDaemonMetadata
              return record.health
            }

            yield* assertRunnerActionsAvailable(
              record,
              "Continue or detach the debugger before retrying session health, then retry.",
            )

            const response = yield* sendRunnerCommand(sessionId, record, "ping", "health-check")
            record.nextSequence += 1

            const warnings = response.ok
              ? connection.status === "connected"
                ? [...record.baseWarnings]
                : composeWarnings(record, [deviceDisconnectedWarning])
              : composeWarnings(record, [
                  `Runner ping reported ${response.statusLabel}. ${nonRecoverableSessionWarning}`,
                  ...(connection.status === "connected" ? [] : [deviceDisconnectedWarning]),
                ])

            const nextHealth: SessionHealth = {
              ...record.health,
              updatedAt: nowIso(),
              expiresAt: expiresAtIso(),
              connection,
              resources: response.ok
                ? record.health.resources
                : setRunnerResourceState(record.health.resources, "failed"),
              capabilities: [...buildRealDeviceCapabilities({
                connection,
                integrationPoints: record.integrationPoints,
                liveRunner: response.ok && connection.status === "connected",
              })],
              runner: runnerDetails,
              healthCheck: {
                checkedAt: nowIso(),
                wrapperRunning: record.isRunnerRunning(),
                pingRttMs: response.hostRttMs,
                lastCommand: response.action,
                lastOk: response.ok,
              },
              warnings,
              artifacts: [...(yield* refreshArtifacts(sessionId))],
            }

            record.health = {
              ...nextHealth,
              state: deriveSessionPhase(nextHealth),
            }

            yield* persistHealth(sessionId, record.health)
            yield* syncDaemonMetadata
            return record.health
          }

          if (!record.isRunnerRunning()) {
            yield* markSessionRunnerFailed({
              sessionId,
              record,
              lastCommand: "ping",
              reason: "The runner wrapper process is no longer running.",
              wrapperRunning: false,
            })
            return record.health
          }

          yield* assertRunnerActionsAvailable(
            record,
            "Continue or detach the debugger before retrying session health, then retry.",
          )

          const response = yield* sendRunnerCommand(sessionId, record, "ping", "health-check")
          record.nextSequence += 1
          record.health = {
            ...record.health,
            state: response.ok ? record.health.state : "failed",
            updatedAt: nowIso(),
            expiresAt: expiresAtIso(),
            resources: response.ok
              ? record.health.resources
              : setRunnerResourceState(record.health.resources, "failed"),
            healthCheck: {
              checkedAt: nowIso(),
              wrapperRunning: record.isRunnerRunning(),
              pingRttMs: response.hostRttMs,
              lastCommand: response.action,
              lastOk: response.ok,
            },
            warnings: response.ok
              ? record.health.warnings
              : dedupeStrings([
                  ...record.health.warnings,
                  `Runner ping reported ${response.statusLabel}. ${nonRecoverableSessionWarning}`,
                ]),
            artifacts: [...(yield* refreshArtifacts(sessionId))],
          }

          yield* persistHealth(sessionId, record.health)
          yield* syncDaemonMetadata
          return record.health
        }),
      sendRunnerKeepalive: (sessionId) =>
        Effect.gen(function* () {
          const record = yield* requireSessionRecord(sessionId)

          if (!isRunnerBackedRecord(record)) {
            return
          }

          yield* sendRunnerCommand(sessionId, record, "ping", "perf-keepalive")
          record.nextSequence += 1
        }),
      getSessionLogs: ({
        sessionId,
        source,
        lineCount,
        match,
        outputMode,
        captureSeconds,
        predicate,
        process,
        subsystem,
        category,
      }) =>
        Effect.gen(function* () {
          yield* validateLogRequest({
            source,
            lineCount,
            captureSeconds,
            predicate,
            process,
            subsystem,
            category,
          })

          const record = yield* requireSessionRecord(sessionId)

          if (isRealDeviceRecord(record) && !isRunnerBackedRecord(record) && source !== "build") {
            return yield* new UnsupportedCapabilityError({
              code: "session-logs-real-device-source",
              capability: `session.logs.${source}`,
              reason: `The current real-device session slice only keeps build/preflight artifacts available for log-style inspection; ${source} is not a supported device log source yet.`,
              nextStep: "Retry with --source build to inspect the signed-build/preflight output, or wait for the real-device logging seam to be implemented.",
              details: [],
              wall: false,
            })
          }

          if (isRealDeviceRecord(record) && isRunnerBackedRecord(record) && source === "simulator") {
            return yield* new UnsupportedCapabilityError({
              code: "session-logs-real-device",
              capability: "session.logs.simulator-source",
              reason: "The current bounded log capture path only supports simulator sessions.",
              nextStep: "Retry against a simulator session, or inspect the saved device runner artifacts for this session.",
              details: [],
              wall: false,
            })
          }

          const sourceArtifact = yield* (source === "simulator"
            ? Effect.gen(function* () {
                if (record.health.target.platform !== "simulator") {
                  return yield* new UnsupportedCapabilityError({
                    code: "session-logs-real-device",
                    capability: "session.logs.simulator-source",
                    reason: "The current bounded log capture path only supports simulator sessions.",
                    nextStep: "Retry against a simulator session, or extend the device logging seam before requesting this source.",
                    details: [],
                    wall: false,
                  })
                }

                const simulatorPredicate = buildSimulatorLogPredicate({ predicate, process, subsystem, category })
                const capture = yield* simulatorHarness.captureSimulatorLogStream({
                  simulatorUdid: record.health.target.deviceId,
                  logsDirectory: join(record.health.artifactRoot, "logs"),
                  captureSeconds,
                  predicate: simulatorPredicate,
                })
                const captureKey = `simulator-log-capture-${timestampForFile()}`
                const captureSummary = simulatorPredicate
                  ? `Bounded simulator unified log capture over ${captureSeconds}s with predicate ${simulatorPredicate}.`
                  : `Bounded simulator unified log capture over ${captureSeconds}s with no extra predicate.`

                const artifact = createArtifactRecord({
                  artifactRoot: record.health.artifactRoot,
                  key: captureKey,
                  label: "simulator-log-capture",
                  kind: "ndjson",
                  absolutePath: capture.absolutePath,
                  summary: captureSummary,
                })

                yield* artifactStore.registerArtifact(sessionId, artifact)
                return artifact
              })
            : artifactStore.getArtifact(sessionId, resolveLogArtifactKey(source)))

          const rawContent = yield* Effect.tryPromise({
            try: () => readFile(sourceArtifact.absolutePath, "utf8"),
            catch: (error) =>
              new EnvironmentError({
                code: "session-log-read",
                reason: error instanceof Error ? error.message : String(error),
                nextStep: "Inspect the source log artifact path and retry the session logs request.",
                details: [],
              }),
          })

          const excerpt = selectBufferedLogLines({
            content: rawContent,
            lineCount,
            match,
            sourceLabel: sourceArtifact.label,
          })

          const result = yield* renderLogResult({
            sessionId,
            artifactRoot: record.health.artifactRoot,
            source,
            content: excerpt.content,
            summary: excerpt.summary,
            outputMode,
          })

          yield* refreshSessionArtifacts(sessionId, record)

          return {
            sourceArtifact,
            result,
          } satisfies SessionLogsResult
        }),
      captureSnapshot: ({ sessionId, outputMode }) =>
        Effect.gen(function* () {
          const record = yield* requireSessionRecord(sessionId)
          const captured = yield* captureSnapshotArtifactInternal(sessionId, record)
          return buildSessionSnapshotResult({
            artifact: captured.artifact,
            artifactRecord: captured.artifactRecord,
            outputMode,
          })
        }),
      performAction: ({ sessionId, action }) =>
        Effect.gen(function* () {
          const record = yield* requireSessionRecord(sessionId)

          if (!isRunnerBackedRecord(record)) {
            return yield* new UnsupportedCapabilityError({
              code: "session-action-real-device-runner",
              capability: "session.action",
              reason: "This session does not currently expose a live runner for UI actions.",
              nextStep: "Inspect session health/artifacts, or reopen the session once the runner transport is live.",
              details: [],
              wall: false,
            })
          }

          const validationError = validateSessionAction(action)

          if (validationError) {
            return yield* new UserInputError({
              code: "session-action-invalid",
              reason: validationError,
              nextStep: "Fix the action payload and retry the session action request.",
              details: [],
            })
          }

          const persistActionFailure = (kind: SessionAction["kind"]) =>
            Effect.gen(function* () {
              updateHealthCheck(record, kind, false)
              yield* persistHealth(sessionId, record.health)
              yield* syncDaemonMetadata
            })

          if (action.kind === "screenshot") {
            const fileStem = `${timestampForFile()}-screenshot`
            const captureResult = yield* Effect.either(captureRunnerScreenshotArtifact({
              sessionId,
              record,
              fileStem,
              artifactKey: `screenshot-${fileStem}`,
              artifactLabel: "screenshot",
              summary: `Runner screenshot captured for session ${sessionId}.`,
            }))

            if (captureResult._tag === "Left") {
              yield* persistActionFailure(action.kind)
              return yield* captureResult.left
            }

            appendRecordedAction(record, buildRecordedSessionAction(action, null))
            updateHealthCheck(record, action.kind, true)
            yield* refreshSessionArtifacts(sessionId, record)
            yield* persistHealth(sessionId, record.health)
            yield* syncDaemonMetadata

            return {
              summary: `Captured screenshot artifact ${captureResult.right.artifact.absolutePath}.`,
              action: action.kind,
              matchedRef: null,
              resolvedBy: "none",
              statusLabel: captureResult.right.statusLabel,
              latestSnapshotId: record.snapshotState.latest?.snapshotId ?? null,
              artifact: captureResult.right.artifact,
              recordingLength: record.recording.steps.length,
            } satisfies SessionActionResult
          }

          if (action.kind === "video") {
            const durationMs = normalizeVideoDurationMs(action.durationMs)
            const normalizedAction: SessionAction = { kind: "video", durationMs }
            const fileStem = `${timestampForFile()}-video`
            const captureResult = yield* Effect.either(captureRunnerVideoArtifact({
              sessionId,
              record,
              durationMs,
              fileStem,
              artifactKey: `video-${fileStem}`,
              artifactLabel: "video",
            }))

            if (captureResult._tag === "Left") {
              yield* persistActionFailure(action.kind)
              return yield* captureResult.left
            }

            appendRecordedAction(record, buildRecordedSessionAction(normalizedAction, null))
            updateHealthCheck(record, action.kind, true)
            yield* refreshSessionArtifacts(sessionId, record)
            yield* persistHealth(sessionId, record.health)
            yield* syncDaemonMetadata

            const modeSummary = captureResult.right.mode === "mp4"
              ? "MP4 video artifact"
              : "frame-sequence video artifact"
            const clampNote = durationMs !== action.durationMs
              ? ` Requested duration ${action.durationMs}ms was clamped to ${durationMs}ms.`
              : ""

            return {
              summary: `Captured ${modeSummary} at ${captureResult.right.artifact.absolutePath}.${clampNote}`,
              action: action.kind,
              matchedRef: null,
              resolvedBy: "none",
              statusLabel: captureResult.right.statusLabel,
              latestSnapshotId: record.snapshotState.latest?.snapshotId ?? null,
              artifact: captureResult.right.artifact,
              recordingLength: record.recording.steps.length,
            } satisfies SessionActionResult
          }

          const preSnapshot = yield* captureSnapshotArtifactInternal(sessionId, record)
          const resolution = resolveActionSelectorInSnapshot(preSnapshot.artifact, action.target)

          if (action.kind === "assert") {
            const evaluation = evaluateAssertion(resolution, action.expectation)
            updateHealthCheck(record, action.kind, evaluation.ok)
            yield* persistHealth(sessionId, record.health)
            yield* syncDaemonMetadata

            if (!evaluation.ok) {
              return yield* new EnvironmentError({
                code: "session-assert-failed",
                reason: evaluation.summary,
                nextStep: "Inspect the latest snapshot artifact and retry when the app is in the expected state.",
                details: [],
              })
            }

            appendRecordedAction(record, buildRecordedSessionAction(action, resolution.target))

            const summary = evaluation.resolvedBy === "semantic"
              && action.target.kind === "ref"
              && action.target.fallback !== null
              && resolution.target !== null
              ? `Assertion passed for ${describeSnapshotNode(resolution.target.node)} (${resolution.target.ref}) after semantic selector-drift recovery.`
              : evaluation.summary

            return {
              summary,
              action: action.kind,
              matchedRef: evaluation.matchedRef,
              resolvedBy: evaluation.resolvedBy,
              statusLabel: preSnapshot.artifact.statusLabel,
              latestSnapshotId: preSnapshot.artifact.snapshotId,
              artifact: null,
              recordingLength: record.recording.steps.length,
            } satisfies SessionActionResult
          }

          if (resolution.outcome !== "matched") {
            updateHealthCheck(record, action.kind, false)
            yield* persistHealth(sessionId, record.health)
            yield* syncDaemonMetadata
            return yield* new EnvironmentError({
              code: "session-action-target-not-found",
              reason: resolution.reason,
              nextStep: "Capture a fresh snapshot, refine the selector, and retry the action.",
              details: [],
            })
          }

          const resolvedTarget = resolution.target!

          const response = yield* sendRunnerCommand(
            sessionId,
            record,
            "uiAction",
            JSON.stringify(buildRunnerUiActionPayload(action, resolvedTarget, preSnapshot.artifact)),
          )
          record.nextSequence += 1

          if (!response.ok) {
            const failureReason = response.error
              ?? response.payload
              ?? `Runner ${action.kind} failed with status ${response.statusLabel}.`

            updateHealthCheck(record, action.kind, false)
            yield* persistHealth(sessionId, record.health)
            yield* syncDaemonMetadata
            return yield* new EnvironmentError({
              code: "session-action-failed",
              reason: failureReason,
              nextStep: withOffscreenNextStep(
                "Inspect the latest snapshot + runner log artifacts, then retry the action.",
                failureReason,
              ),
              details: [],
            })
          }

          const postSnapshot = yield* captureSnapshotArtifactInternal(sessionId, record)
          appendRecordedAction(record, buildRecordedSessionAction(action, resolvedTarget))
          updateHealthCheck(record, action.kind, true)
          yield* persistHealth(sessionId, record.health)
          yield* syncDaemonMetadata

          const summary = resolvedTarget.resolvedBy === "semantic"
            && action.target.kind === "ref"
            && action.target.fallback !== null
            ? `Executed ${action.kind} on ${describeSnapshotNode(resolvedTarget.node)} after semantic selector-drift recovery; captured ${postSnapshot.artifact.snapshotId}.`
            : `Executed ${action.kind} on ${describeSnapshotNode(resolvedTarget.node)}; captured ${postSnapshot.artifact.snapshotId}.`

          return {
            summary,
            action: action.kind,
            matchedRef: resolvedTarget.ref,
            resolvedBy: resolvedTarget.resolvedBy,
            statusLabel: postSnapshot.artifact.statusLabel,
            latestSnapshotId: postSnapshot.artifact.snapshotId,
            artifact: null,
            recordingLength: record.recording.steps.length,
          } satisfies SessionActionResult
        }),
      exportRecording: ({ sessionId, label }) =>
        Effect.gen(function* () {
          const record = yield* requireSessionRecord(sessionId)

          if (!isRunnerBackedRecord(record)) {
            return yield* new UnsupportedCapabilityError({
              code: "session-recording-real-device-runner",
              capability: "session.recording.export",
              reason: "This session has no runner-backed action recording to export.",
              nextStep: "Execute one or more runner-backed actions before exporting a recording.",
              details: [],
              wall: false,
            })
          }

          if (record.recording.steps.length === 0) {
            return yield* new UserInputError({
              code: "session-recording-empty",
              reason: `Session ${sessionId} does not have any recorded actions to export.`,
              nextStep: "Execute one or more session actions before exporting a recording.",
              details: [],
            })
          }

          const recordingScript: ActionRecordingScript = {
            contract: "probe.action-recording/script-v1",
            recordedAt: nowIso(),
            sessionId,
            bundleId: record.health.target.bundleId,
            steps: [...record.recording.steps],
          }
          const labelStem = sanitizeFileComponent(label, "recording")
          const fileStem = `${timestampForFile()}-${labelStem}`
          const artifact = yield* writeJsonArtifact({
            sessionId,
            artifactRoot: record.health.artifactRoot,
            directory: "recordings",
            fileStem,
            artifactKey: `recording-${fileStem}`,
            artifactLabel: label ?? "recording",
            summary: `Recorded action script with ${record.recording.steps.length} steps.`,
            content: recordingScript,
          })

          yield* refreshSessionArtifacts(sessionId, record)

          return {
            summary: `Exported ${record.recording.steps.length} recorded actions to ${artifact.absolutePath}.`,
            artifact,
            stepCount: record.recording.steps.length,
          } satisfies SessionRecordingExportResult
        }),
      replayRecording: ({ sessionId, script }) =>
        Effect.gen(function* () {
          const record = yield* requireSessionRecord(sessionId)

          if (!isRunnerBackedRecord(record)) {
            return yield* new UnsupportedCapabilityError({
              code: "session-replay-real-device-runner",
              capability: "session.replay",
              reason: "This session does not currently support replaying actions because no live runner is available.",
              nextStep: "Inspect session health/artifacts, or reopen the session once the runner transport is live.",
              details: [],
              wall: false,
            })
          }

          if (script.steps.length === 0) {
            return yield* new UserInputError({
              code: "session-replay-empty",
              reason: "Replay scripts must contain at least one recorded action.",
              nextStep: "Export a non-empty recording or add one or more steps before replaying.",
              details: [],
            })
          }

          const reports: Array<ReplayStepReport> = []
          let retriedStepCount = 0
          let semanticFallbackCount = 0
          let finalSnapshotId: string | null = record.snapshotState.latest?.snapshotId ?? null

          for (const [index, step] of script.steps.entries()) {
            let attempt = 0
            let succeeded = false
            let lastFailure = "unknown replay failure"

            while (attempt < defaultReplayAttemptLimit && !succeeded) {
              attempt += 1

              if (step.kind === "screenshot") {
                const fileStem = `step-${String(index + 1).padStart(3, "0")}-screenshot`
                const capture = yield* Effect.either(captureRunnerScreenshotArtifact({
                  sessionId,
                  record,
                  fileStem,
                  artifactKey: `screenshot-${fileStem}`,
                  artifactLabel: `replay-screenshot-${index + 1}`,
                  summary: `Replay step ${index + 1} screenshot captured for session ${sessionId}.`,
                }))

                if (capture._tag === "Left") {
                  lastFailure = capture.left.reason
                  continue
                }

                if (attempt > 1) {
                  retriedStepCount += 1
                }

                reports.push({
                  index: index + 1,
                  kind: step.kind,
                  attempts: attempt,
                  resolvedBy: "none",
                  matchedRef: null,
                  artifact: capture.right.artifact,
                  summary: `Captured replay screenshot artifact ${capture.right.artifact.absolutePath}.`,
                })
                succeeded = true
                continue
              }

              if (step.kind === "video") {
                const durationMs = normalizeVideoDurationMs(step.durationMs)
                const fileStem = `step-${String(index + 1).padStart(3, "0")}-video`
                const capture = yield* Effect.either(captureRunnerVideoArtifact({
                  sessionId,
                  record,
                  durationMs,
                  fileStem,
                  artifactKey: `video-${fileStem}`,
                  artifactLabel: `replay-video-${index + 1}`,
                }))

                if (capture._tag === "Left") {
                  lastFailure = capture.left.reason
                  continue
                }

                if (attempt > 1) {
                  retriedStepCount += 1
                }

                const modeSummary = capture.right.mode === "mp4"
                  ? "MP4 video"
                  : "frame-sequence video"
                const clampNote = durationMs !== step.durationMs
                  ? ` Requested duration ${step.durationMs}ms was clamped to ${durationMs}ms.`
                  : ""

                reports.push({
                  index: index + 1,
                  kind: step.kind,
                  attempts: attempt,
                  resolvedBy: "none",
                  matchedRef: null,
                  artifact: capture.right.artifact,
                  summary: `Captured replay ${modeSummary} artifact ${capture.right.artifact.absolutePath}.${clampNote}`,
                })
                succeeded = true
                continue
              }

              const preSnapshot = yield* captureSnapshotArtifactInternal(sessionId, record)
              finalSnapshotId = preSnapshot.artifact.snapshotId
              const resolution = resolveRecordedActionTargetInSnapshot(preSnapshot.artifact, step.target)

              if (step.kind === "assert") {
                const evaluation = evaluateAssertion(resolution, step.expectation)

                if (!evaluation.ok) {
                  lastFailure = evaluation.summary
                  continue
                }

                if (attempt > 1) {
                  retriedStepCount += 1
                }

                if (evaluation.resolvedBy === "semantic" && step.target.preferredRef !== null) {
                  semanticFallbackCount += 1
                }

                const summary = evaluation.resolvedBy === "semantic" && step.target.preferredRef !== null && resolution.target !== null
                  ? `Assertion passed for ${describeSnapshotNode(resolution.target.node)} (${resolution.target.ref}) after semantic selector-drift recovery.`
                  : evaluation.summary

                reports.push({
                  index: index + 1,
                  kind: step.kind,
                  attempts: attempt,
                  resolvedBy: evaluation.resolvedBy,
                  matchedRef: evaluation.matchedRef,
                  artifact: null,
                  summary,
                })
                succeeded = true
                continue
              }

              if (resolution.outcome !== "matched") {
                lastFailure = resolution.reason
                continue
              }

              const resolvedTarget = resolution.target!

              const response = yield* sendRunnerCommand(
                sessionId,
                record,
                "uiAction",
                JSON.stringify(
                  buildRunnerUiActionPayload(
                    step,
                    resolvedTarget,
                    preSnapshot.artifact,
                  ),
                ),
              )
              record.nextSequence += 1

              if (!response.ok) {
                lastFailure = response.error ?? response.payload ?? `Runner ${step.kind} failed with status ${response.statusLabel}.`
                continue
              }

              const postSnapshot = yield* captureSnapshotArtifactInternal(sessionId, record)
              finalSnapshotId = postSnapshot.artifact.snapshotId

              if (attempt > 1) {
                retriedStepCount += 1
              }

              if (resolvedTarget.resolvedBy === "semantic" && step.target.preferredRef !== null) {
                semanticFallbackCount += 1
              }

              const summary = resolvedTarget.resolvedBy === "semantic" && step.target.preferredRef !== null
                ? `Executed ${step.kind} on ${describeRecordedActionTarget(step.target)} after semantic selector-drift recovery; captured ${postSnapshot.artifact.snapshotId}.`
                : `Executed ${step.kind} on ${describeRecordedActionTarget(step.target)}; captured ${postSnapshot.artifact.snapshotId}.`

                reports.push({
                  index: index + 1,
                  kind: step.kind,
                  attempts: attempt,
                  resolvedBy: resolvedTarget.resolvedBy,
                  matchedRef: resolvedTarget.ref,
                  artifact: null,
                  summary,
                })
                succeeded = true
            }

            if (!succeeded) {
              const warnings = buildReplayWarnings(semanticFallbackCount)
              const report: ReplayReport = {
                contract: "probe.action-replay/report-v1",
                executedAt: nowIso(),
                sessionId,
                status: "failed",
                finalSnapshotId,
                retriedStepCount,
                semanticFallbackCount,
                sourceContract: script.contract,
                warnings,
                failure: {
                  index: index + 1,
                  kind: step.kind,
                  attempts: attempt,
                  reason: lastFailure,
                },
                steps: reports,
              }
              const artifact = yield* writeReplayReportArtifact({
                sessionId,
                artifactRoot: record.health.artifactRoot,
                report,
                summary: buildReplayArtifactSummary({
                  status: "failed",
                  stepCount: reports.length,
                  failureStepIndex: index + 1,
                }),
              })

              updateHealthCheck(record, "replay", false)
              yield* refreshSessionArtifacts(sessionId, record)
              yield* persistRecordHealth(sessionId, record)

              return yield* new EnvironmentError({
                code: "session-replay-step-failed",
                reason: `Replay step ${index + 1} (${step.kind}) failed after ${defaultReplayAttemptLimit} attempts: ${lastFailure}`,
                nextStep: withOffscreenNextStep(
                  "Inspect the replay report, latest snapshot, and runner log artifacts, refine the selector, and retry the replay.",
                  lastFailure,
                ),
                details: [
                  `replay report artifact: ${artifact.absolutePath}`,
                  ...(finalSnapshotId ? [`latest snapshot: ${finalSnapshotId}`] : []),
                ],
              })
            }
          }

          const warnings = buildReplayWarnings(semanticFallbackCount)
          const report: ReplayReport = {
            contract: "probe.action-replay/report-v1",
            executedAt: nowIso(),
            sessionId,
            status: "succeeded",
            finalSnapshotId,
            retriedStepCount,
            semanticFallbackCount,
            sourceContract: script.contract,
            warnings,
            failure: null,
            steps: reports,
          }
          const artifact = yield* writeReplayReportArtifact({
            sessionId,
            artifactRoot: record.health.artifactRoot,
            report,
            summary: buildReplayArtifactSummary({
              status: "succeeded",
              stepCount: reports.length,
              failureStepIndex: null,
            }),
          })

          updateHealthCheck(record, "replay", true)
          yield* refreshSessionArtifacts(sessionId, record)
          yield* persistRecordHealth(sessionId, record)

          return {
            summary: buildReplayResultSummary({
              stepCount: reports.length,
              retriedStepCount,
              semanticFallbackCount,
            }),
            artifact,
            stepCount: reports.length,
            retriedStepCount,
            semanticFallbackCount,
            finalSnapshotId,
          } satisfies SessionReplayResult
        }),
      captureScreenshot: ({ sessionId, label, outputMode }) =>
        Effect.gen(function* () {
          const record = yield* requireSessionRecord(sessionId)

          yield* assertRunnerActionsAvailable(record)

          if (!isRunnerBackedRecord(record)) {
            return yield* new UnsupportedCapabilityError({
              code: "session-screenshot-real-device",
              capability: "session.screenshot",
              reason: "This session does not currently expose a live runner transport for screenshots.",
              nextStep: "Inspect session health/artifacts, or reopen the session once the runner transport is live.",
              details: [],
              wall: false,
            })
          }

          const labelStem = sanitizeFileComponent(label, "screenshot")
          const fileStem = `${timestampForFile()}-${labelStem}`
          const capture = yield* Effect.either(captureRunnerScreenshotArtifact({
            sessionId,
            record,
            fileStem,
            artifactKey: `screenshot-${fileStem}`,
            artifactLabel: label ?? "screenshot",
            summary: `Runner screenshot captured for session ${sessionId}.`,
          }))

          if (capture._tag === "Left") {
            updateHealthCheck(record, "screenshot", false)
            yield* persistRecordHealth(sessionId, record)
            return yield* capture.left
          }

          updateHealthCheck(record, "screenshot", true)
          yield* refreshSessionArtifacts(sessionId, record)
          yield* persistRecordHealth(sessionId, record)

          const inlineBinary = outputPolicy.shouldInlineBinary(outputMode)

          return {
            kind: "summary+artifact",
            summary: inlineBinary
              ? `Screenshot captured inline at ${capture.right.artifact.absolutePath}.`
              : `Screenshot captured and returned as an artifact because ${describeScreenshotOffloadReason(outputMode)}.`,
            artifact: capture.right.artifact,
          } satisfies SummaryArtifactResult
        }),
      recordVideo: ({ sessionId, duration }) =>
        Effect.gen(function* () {
          const record = yield* requireSessionRecord(sessionId)

          yield* assertRunnerActionsAvailable(record)

          if (!isRunnerBackedRecord(record)) {
            return yield* new UnsupportedCapabilityError({
              code: "session-video-real-device",
              capability: "session.video",
              reason: "This session does not currently expose a live runner transport for video capture.",
              nextStep: "Inspect session health/artifacts, or reopen the session once the runner transport is live.",
              details: [],
              wall: false,
            })
          }

          const parsedDurationMs = parseDurationStringMs(duration)

          if (parsedDurationMs === null) {
            return yield* new UserInputError({
              code: "session-video-duration-invalid",
              reason: `Unsupported video duration ${duration}.`,
              nextStep: "Use a positive duration such as 500ms, 5s, 30s, 1m, or 120s.",
              details: [],
            })
          }

          const durationMs = normalizeVideoDurationMs(parsedDurationMs)
          const fileStem = `${timestampForFile()}-${sanitizeFileComponent(duration, "video")}`
          const capture = yield* Effect.either(captureRunnerVideoArtifact({
            sessionId,
            record,
            durationMs,
            fileStem,
            artifactKey: `video-${fileStem}`,
            artifactLabel: "video",
          }))

          if (capture._tag === "Left") {
            updateHealthCheck(record, "video", false)
            yield* persistRecordHealth(sessionId, record)
            return yield* capture.left
          }

          updateHealthCheck(record, "video", true)
          yield* refreshSessionArtifacts(sessionId, record)
          yield* persistRecordHealth(sessionId, record)

          const modeSummary = capture.right.mode === "mp4"
            ? "MP4 video artifact"
            : "frame-sequence video artifact"
          const clampNote = durationMs !== parsedDurationMs
            ? ` Requested duration ${duration} was clamped to ${durationMs}ms.`
            : ""

          return {
            kind: "summary+artifact",
            summary: `Captured ${modeSummary} at ${capture.right.artifact.absolutePath}.${clampNote}`,
            artifact: capture.right.artifact,
          } satisfies SummaryArtifactResult
        }),
      closeSession: (sessionId) =>
        Effect.gen(function* () {
          const closed = yield* closeSessionInternal(sessionId, "explicit-close")

          if (!closed) {
            return yield* new SessionNotFoundError({
              sessionId,
              nextStep: "Open a new session before attempting to close it.",
            })
          }

          return {
            sessionId,
            state: "closed",
            closedAt: nowIso(),
          }
        }),
      runDebugCommand: ({ sessionId, outputMode, command }) =>
        Effect.gen(function* () {
          const record = yield* requireSessionRecord(sessionId)

          if (!isSimulatorRecord(record)) {
            return yield* new UnsupportedCapabilityError({
              code: "session-debug-real-device",
              capability: "session.debug",
              reason: "The current real-device session slice does not yet expose an LLDB attach/eval flow for the device app target.",
              nextStep: "Inspect the device session health/preflight artifacts, or use the verified external host-process debug path until real-device attach is validated.",
              details: [],
              wall: false,
            })
          }

          yield* validateDebugCommand(command)

          const artifactRoot = record.health.artifactRoot
          const attachTarget = command.command === "attach"
            ? resolveAttachTarget(command)
            : null
          const bridge = command.command === "attach"
            ? yield* ensureDebuggerBridge(sessionId, record)
            : yield* requireAttachedDebugger(record)
          const commandStartedAt = nowIso()

          const sendCommand = (): Promise<LldbBridgeResponseFrame> => {
            switch (command.command) {
              case "attach":
                return bridge.send({
                  command: "attach",
                  pid: attachTarget!.pid,
                }, { timeoutMs: defaultDebugCommandTimeoutMs })
              case "backtrace":
                return bridge.send({
                  command: "backtrace",
                  threadIndexId: command.threadIndexId,
                  frameLimit: command.frameLimit,
                }, { timeoutMs: defaultDebugCommandTimeoutMs })
              case "vars":
                return bridge.send({
                  command: "vars",
                  threadIndexId: command.threadIndexId,
                  frameIndex: command.frameIndex,
                }, { timeoutMs: defaultDebugCommandTimeoutMs })
              case "eval":
                return bridge.send({
                  command: "eval",
                  expression: command.expression,
                  threadIndexId: command.threadIndexId,
                  frameIndex: command.frameIndex,
                  timeoutMs: command.timeoutMs,
                }, { timeoutMs: command.timeoutMs + 5_000 })
              case "continue":
                return bridge.send({
                  command: "continue",
                }, { timeoutMs: defaultDebugCommandTimeoutMs })
              case "detach":
                return bridge.send({
                  command: "detach",
                }, { timeoutMs: defaultDebugCommandTimeoutMs })
              case "breakpoint-set":
                return bridge.send({
                  command: "breakpoint-set",
                  locationKind: command.location.kind,
                  functionName: command.location.kind === "function" ? command.location.functionName : undefined,
                  file: command.location.kind === "file-line" ? command.location.file : undefined,
                  line: command.location.kind === "file-line" ? command.location.line : undefined,
                }, { timeoutMs: defaultDebugCommandTimeoutMs })
              case "breakpoint-clear":
                return bridge.send({
                  command: "breakpoint-clear",
                  breakpointId: command.breakpointId,
                }, { timeoutMs: defaultDebugCommandTimeoutMs })
            }
          }

          const response = yield* Effect.tryPromise({
            try: sendCommand,
            catch: (error) =>
              new EnvironmentError({
                code: "session-debug-command-failed",
                reason: error instanceof Error ? error.message : String(error),
                nextStep: "Inspect the LLDB bridge logs and retry the debug command.",
                details: [],
              }),
          })

          const commandOk = response.ok ?? false
          const processSnapshot = parseProcessSnapshot(response)
          const resp = response as Record<string, unknown>
          const summaryBase = commandOk
            ? buildDebugSuccessSummary({
                command,
                response: resp,
                processSnapshot,
                attachTarget,
              })
            : buildDebugFailureSummary({
                command,
                response: resp,
                attachTarget,
              })

          const nextDebuggerState: SessionDebuggerDetails = {
            ...record.health.debugger,
            attachState: command.command === "attach" && commandOk
              ? "attached"
              : command.command === "attach"
                ? "failed"
              : command.command === "detach"
                ? commandOk ? "detached" : record.health.debugger.attachState
                : record.health.debugger.attachState,
            targetScope: command.command === "attach"
              ? commandOk ? attachTarget!.targetScope : null
              : command.command === "detach" && commandOk
                ? null
                : record.health.debugger.targetScope,
            attachedPid: command.command === "attach" && !commandOk
              ? null
              : command.command === "detach" && commandOk
                ? null
                : processSnapshot?.pid ?? record.health.debugger.attachedPid,
            processState: command.command === "attach" && !commandOk
              ? null
              : command.command === "detach" && commandOk
                ? "detached"
                : processSnapshot?.state ?? record.health.debugger.processState,
            stopId: command.command === "attach" && !commandOk
              ? null
              : command.command === "detach" && commandOk
                ? null
                : processSnapshot?.stopId ?? record.health.debugger.stopId,
            stopReason: command.command === "attach" && !commandOk
              ? null
              : command.command === "detach" && commandOk
                ? null
                : processSnapshot?.selectedThread?.stopReason ?? record.health.debugger.stopReason,
            stopDescription: command.command === "attach" && !commandOk
              ? null
              : command.command === "detach" && commandOk
                ? null
                : processSnapshot?.selectedThread?.stopDescription ?? record.health.debugger.stopDescription,
            lastCommand: command.command,
            lastCommandOk: commandOk,
            lastUpdatedAt: commandStartedAt,
          }

          setDebuggerHealth(
            record,
            nextDebuggerState,
            commandOk ? "ready" : "degraded",
          )
          yield* refreshSessionArtifacts(sessionId, record)

          const output = yield* renderDebugOutput({
            sessionId,
            artifactRoot,
            command: command.command,
            summary: summaryBase,
            payload: response,
            outputMode,
          })

          return {
            sessionId,
            command: command.command,
            summary: summaryBase,
            output,
            debugger: nextDebuggerState,
            coordination: buildSessionCoordination(nextDebuggerState),
          } satisfies DebugCommandResult
        }),
    })
  }),
)
