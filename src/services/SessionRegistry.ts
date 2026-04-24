import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { statSync } from "node:fs"
import { access, appendFile, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises"
import { basename, dirname, join, relative } from "node:path"
import { Context, Effect, Either, Layer, Ref } from "effect"
import {
  buildRecordedSessionAction,
  buildDirectRunnerUiActionPayload,
  buildRunnerUiActionPayload,
  describeActionSelector,
  describeRecordedActionTarget,
  describeSnapshotNode,
  evaluateAssertion,
  flowStepToSessionAction,
  isFlowSessionActionStep,
  isRunnerUiSessionAction,
  isRunnerUiRecordedSessionAction,
  resolveActionSelectorInSnapshot,
  resolveRecordedActionTargetInSnapshot,
  validateFlowContract,
  validateSessionAction,
  type ActionRecordingScript,
  type FlowFailedStep,
  type FlowResult,
  type FlowStep,
  type FlowStepResult,
  type RecordedSessionAction,
  type ReplayReport,
  type ReplayStepReport,
  type RetryPolicy,
  type RetryReasonCode,
  type SessionAction,
  type SessionActionResult,
  type SessionRecordingExportResult,
  type SessionReplayResult,
} from "../domain/action"
import {
  flowV2StepToSessionAction,
  isFlowV2Contract,
  isFlowV2SessionActionStep,
  validateSessionFlowContract,
  type FlowSequenceAction,
  type FlowSequenceChildFailure,
  type FlowSequenceStep,
  type FlowV2FastSingleStep,
  type FlowV2FailedStep,
  type FlowV2Result,
  type FlowV2Step,
  type FlowV2StepResult,
  type SessionFlowContract,
  type SessionFlowResult,
} from "../domain/flow-v2"
import { planFlowExecution, type PlannedStep } from "../domain/flow-planner"
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
  DeviceInterruptionError,
  EnvironmentError,
  SessionConflictError,
  SessionNotFoundError,
  UnsupportedCapabilityError,
  UserInputError,
} from "../domain/errors"
import type { DiagnosticCaptureKind, DiagnosticCaptureTarget } from "../domain/diagnostics"
import type {
  ArtifactRecord,
  DrillResult,
  OutputMode,
  SessionLogDoctorReport,
  SessionLogMarker,
  SessionLogSource,
  SessionLogsResult,
  SessionScreenshotResult,
  SummaryArtifactResult,
} from "../domain/output"
import { appendSessionLogMarkers, summarizeContent } from "../domain/output"
import {
  SessionHealth,
  isLiveRunnerDetails,
  type SessionConnectionDetails,
  type SessionHealthCheck,
  type SessionListEntry,
  type SessionResourceState,
  type SessionResourceStates,
  type SimulatorSessionMode,
} from "../domain/session"
import { buildSessionSnapshotResult, buildSnapshotArtifact, decodeRunnerSnapshotPayload, type SessionSnapshotResult, type StoredSnapshotArtifact } from "../domain/snapshot"
import { ArtifactStore, type DaemonSessionMetadata } from "./ArtifactStore"
import { type LldbBridgeHandle, type LldbBridgeResponseFrame, LldbBridgeFactory } from "./LldbBridge"
import { OutputPolicy } from "./OutputPolicy"
import {
  buildRealDeviceInterruptionWarning,
  detectRealDeviceInterruption,
  type OpenedRealDeviceSession,
  RealDeviceHarness,
} from "./RealDeviceHarness"
import { SimulatorHarness, type OpenedSimulatorSession, type RunnerCommandResult } from "./SimulatorHarness"
import type { RunnerAction } from "./runnerProtocol"

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

type VideoArtifactMode = "mp4" | "mov" | "frame-sequence"

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

const resolveFfprobeExecutable = (): string => {
  const configured = process.env.PROBE_FFPROBE_PATH

  if (configured) {
    return configured
  }

  const ffmpegExecutable = resolveFfmpegExecutable()
  const executableName = basename(ffmpegExecutable)

  if (executableName.includes("ffmpeg")) {
    return join(dirname(ffmpegExecutable), executableName.replace("ffmpeg", "ffprobe"))
  }

  return "ffprobe"
}

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

const parseRationalNumber = (value: string): number | null => {
  const trimmed = value.trim()

  if (trimmed.length === 0) {
    return null
  }

  if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) {
    const numeric = Number(trimmed)
    return Number.isFinite(numeric) ? numeric : null
  }

  const match = trimmed.match(/^(-?\d+)\/(-?\d+)$/)

  if (!match) {
    return null
  }

  const numerator = Number(match[1])
  const denominator = Number(match[2])

  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) {
    return null
  }

  const numeric = numerator / denominator
  return Number.isFinite(numeric) ? numeric : null
}

const formatFpsLabel = (value: number): string => {
  if (!Number.isFinite(value)) {
    return "unknown"
  }

  const rounded = Math.round(value * 100) / 100
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(2)
}

const probeSimulatorVideoFrameRate = async (absolutePath: string): Promise<{
  readonly expression: string
  readonly label: string
} | null> => {
  const ffprobeExecutable = resolveFfprobeExecutable()

  try {
    const result = await runHostCommand({
      command: ffprobeExecutable,
      commandArgs: [
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-show_entries",
        "stream=avg_frame_rate",
        "-of",
        "default=noprint_wrappers=1:nokey=0",
        absolutePath,
      ],
      timeoutMs: 10_000,
    })

    if (result.exitCode !== 0) {
      return null
    }

    const match = result.stdout.match(/avg_frame_rate=([^\r\n]+)/)
    const expression = match?.[1]?.trim() ?? ""
    const numeric = parseRationalNumber(expression)

    if (numeric === null || numeric <= 0) {
      return null
    }

    return {
      expression,
      label: formatFpsLabel(numeric),
    }
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return null
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

const describeVideoArtifactLabel = (mode: VideoArtifactMode, options?: { readonly includeArtifact?: boolean }): string => {
  const suffix = options?.includeArtifact === false ? "" : " artifact"

  switch (mode) {
    case "mp4":
      return `MP4 video${suffix}`
    case "mov":
      return `QuickTime video${suffix}`
    case "frame-sequence":
      return `frame-sequence video${suffix}`
  }
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

const defaultReadOnlyRetryPolicy: RetryPolicy = {
  maxAttempts: 3,
  backoffMs: 250,
  refreshSnapshotBetweenAttempts: true,
  retryOn: ["not-found", "not-hittable", "runner-timeout", "transient-transport", "assertion-failed"],
}

const defaultMutationRetryPolicy: RetryPolicy = {
  maxAttempts: 3,
  backoffMs: 250,
  refreshSnapshotBetweenAttempts: true,
  retryOn: ["not-found", "not-hittable"],
}

const defaultAssertRetryPolicy: RetryPolicy = {
  maxAttempts: 1,
  backoffMs: 250,
  refreshSnapshotBetweenAttempts: true,
  retryOn: ["not-found", "assertion-failed"],
}

const waitPollIntervalMs = 200

const defaultWaitRetryPolicy = (timeoutMs: number): RetryPolicy => ({
  maxAttempts: Math.max(1, Math.floor(timeoutMs / waitPollIntervalMs) + 1),
  backoffMs: waitPollIntervalMs,
  refreshSnapshotBetweenAttempts: true,
  retryOn: ["not-found", "assertion-failed"],
})

type SessionActionError =
  | SessionNotFoundError
  | UserInputError
  | UnsupportedCapabilityError
  | EnvironmentError
  | ChildProcessError

interface RetryAttemptMetadata {
  readonly retryCount: number
  readonly retryReasons: Array<string>
}

type ExtendedSessionActionResult = SessionActionResult & {
  readonly handledMs?: number | null
}

type RetryAttemptOutcome<T, E extends SessionActionError> =
  | {
      readonly ok: true
      readonly value: T
      readonly retry: RetryAttemptMetadata
    }
  | {
      readonly ok: false
      readonly error: E
      readonly retry: RetryAttemptMetadata
    }

type ActionExecutionOutcome =
  | {
      readonly ok: true
      readonly result: ExtendedSessionActionResult
    }
  | {
      readonly ok: false
      readonly error: SessionActionError
      readonly retry: RetryAttemptMetadata
    }

const emptyRetryAttemptMetadata = (): RetryAttemptMetadata => ({
  retryCount: 0,
  retryReasons: [],
})

const classifyRetryableFailure = (error: SessionActionError): { readonly code: RetryReasonCode; readonly reason: string } | null => {
  if (error instanceof EnvironmentError) {
    switch (error.code) {
      case "session-action-target-not-found":
        return { code: "not-found", reason: error.reason }
      case "session-assert-failed":
        return { code: "assertion-failed", reason: error.reason }
      case "session-action-failed":
        return {
          code: isHittabilityFailure(error.reason) ? "not-hittable" : "transient-transport",
          reason: error.reason,
        }
      case "session-snapshot-failed":
      case "session-snapshot-payload-missing":
      case "session-snapshot-read":
      case "session-snapshot-parse":
      case "session-snapshot-write":
      case "session-screenshot-failed":
      case "session-screenshot-payload-missing":
      case "session-screenshot-artifact-write":
        return {
          code: /timeout/i.test(error.reason) ? "runner-timeout" : "transient-transport",
          reason: error.reason,
        }
      default:
        if (error.code.startsWith("session-runner-")) {
          return {
            code: /timeout/i.test(error.reason) ? "runner-timeout" : "transient-transport",
            reason: error.reason,
          }
        }

        return null
    }
  }

  if (error instanceof ChildProcessError) {
    return {
      code: /timeout/i.test(error.reason) ? "runner-timeout" : "transient-transport",
      reason: error.reason,
    }
  }

  return null
}

const attemptWithRetry = <T, E extends SessionActionError>(args: {
  readonly policy: RetryPolicy
  readonly run: () => Effect.Effect<T, E>
}) =>
  Effect.gen(function* () {
    const retryReasons: Array<string> = []
    let attempt = 0

    while (true) {
      attempt += 1
      const result = (yield* Effect.either(args.run())) as { _tag: "Right"; right: T } | { _tag: "Left"; left: E }

      if (result._tag === "Right") {
        return {
          ok: true as const,
          value: result.right,
          retry: {
            retryCount: attempt - 1,
            retryReasons,
          },
        }
      }

      const retryable = classifyRetryableFailure(result.left)
      const shouldRetry = retryable !== null
        && args.policy.retryOn.includes(retryable.code)
        && attempt < args.policy.maxAttempts

      if (!shouldRetry) {
        return {
          ok: false as const,
          error: result.left,
          retry: {
            retryCount: attempt - 1,
            retryReasons,
          },
        }
      }

      retryReasons.push(`${retryable.code}: ${retryable.reason}`)

      if (args.policy.backoffMs > 0) {
        yield* Effect.sleep(args.policy.backoffMs)
      }
    }
  })

const runWithRetry = <T, E extends SessionActionError>(args: {
  readonly policy: RetryPolicy
  readonly run: () => Effect.Effect<T, E>
}) =>
  attemptWithRetry(args).pipe(
    Effect.flatMap((result) => result.ok ? Effect.succeed({ value: result.value, retry: result.retry }) : Effect.fail(result.error)),
  )

const buildReplayResultSummary = (args: {
  readonly stepCount: number
  readonly retriedStepCount: number
  readonly semanticFallbackCount: number
}): string =>
  `Replayed ${args.stepCount} steps with ${args.retriedStepCount} retried steps and ${args.semanticFallbackCount} semantic fallback recoveries. Replay report steps are labeled as no retry needed, retry succeeded, semantic fallback succeeded, or retry exhausted. ${selectorDriftContractWarning} ${offscreenHittabilityWarning}`

const classifyReplayStepOutcome = (args: {
  readonly attempts: number
  readonly resolvedBy: ReplayStepReport["resolvedBy"]
  readonly exhausted?: boolean
}): ReplayStepReport["outcome"] => {
  if (args.exhausted) {
    return "retry-exhausted"
  }

  if (args.resolvedBy === "semantic") {
    return "semantic-fallback"
  }

  return args.attempts > 1 ? "retry-succeeded" : "no-retry"
}

const withReplayStepOutcomeLabel = (args: {
  readonly outcome: ReplayStepReport["outcome"]
  readonly summary: string
}): string => {
  const label = (() => {
    switch (args.outcome) {
      case "no-retry":
        return "no retry needed"
      case "retry-succeeded":
        return "retry succeeded"
      case "semantic-fallback":
        return "semantic fallback succeeded"
      case "retry-exhausted":
        return "retry exhausted"
    }
  })()

  return `${label}: ${args.summary}`
}

const buildReplayStepReport = (args: {
  readonly index: number
  readonly kind: ReplayStepReport["kind"]
  readonly attempts: number
  readonly resolvedBy: ReplayStepReport["resolvedBy"]
  readonly matchedRef: string | null
  readonly artifact: ArtifactRecord | null
  readonly summary: string
  readonly exhausted?: boolean
}): ReplayStepReport => {
  const outcome = classifyReplayStepOutcome({
    attempts: args.attempts,
    resolvedBy: args.resolvedBy,
    exhausted: args.exhausted,
  })

  return {
    index: args.index,
    kind: args.kind,
    attempts: args.attempts,
    outcome,
    resolvedBy: args.resolvedBy,
    matchedRef: args.matchedRef,
    artifact: args.artifact,
    summary: withReplayStepOutcomeLabel({
      outcome,
      summary: args.summary,
    }),
  }
}

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
    action: RunnerAction,
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
    action: RunnerAction,
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
  ...(() => {
    try {
      const fileStat = statSync(args.absolutePath)
      return fileStat.isFile() ? { sizeBytes: fileStat.size } : {}
    } catch {
      return {}
    }
  })(),
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

const isSessionLogMarkerRecord = (value: unknown): value is SessionLogMarker =>
  typeof value === "object"
  && value !== null
  && typeof (value as { readonly timestamp?: unknown }).timestamp === "string"
  && typeof (value as { readonly label?: unknown }).label === "string"
  && typeof (value as { readonly sessionId?: unknown }).sessionId === "string"

const readSessionLogMarkers = (artifactRoot: string): Effect.Effect<ReadonlyArray<SessionLogMarker>> =>
  Effect.tryPromise({
    try: async () => {
      const marksDirectory = join(artifactRoot, "logs", "marks")

      let entries: Array<string>

      try {
        entries = await readdir(marksDirectory)
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") {
          return []
        }

        throw error
      }

      const markers: Array<SessionLogMarker> = []

      for (const entry of entries.filter((candidate) => candidate.endsWith(".json")).sort()) {
        try {
          const raw = await readFile(join(marksDirectory, entry), "utf8")
          const parsed = JSON.parse(raw) as unknown

          if (isSessionLogMarkerRecord(parsed)) {
            markers.push(parsed)
          }
        } catch {
          continue
        }
      }

      return markers.sort((left, right) => left.timestamp.localeCompare(right.timestamp))
    },
    catch: (error) =>
      new EnvironmentError({
        code: "session-log-mark-read",
        reason: error instanceof Error ? error.message : String(error),
        nextStep: "Inspect the session log marks directory and retry the logs request.",
        details: [],
      }),
  }).pipe(Effect.catchAll(() => Effect.succeed([])))

const resolveWritableLogStreamArtifact = (artifacts: ReadonlyArray<ArtifactRecord>): ArtifactRecord | null =>
  artifacts.find((artifact) => artifact.key === "stdout-events")
  ?? artifacts.find((artifact) => artifact.key === "wrapper-stderr")
  ?? null

const buildSessionLogMarkStreamEntry = (marker: SessionLogMarker): string =>
  `${JSON.stringify({
    kind: "probe.log.mark",
    timestamp: marker.timestamp,
    label: marker.label,
    sessionId: marker.sessionId,
  })}\n`

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

const resolveDeviceDiagnosticCaptureMode = (kind: DiagnosticCaptureKind | null): "diagnose" | "sysdiagnose" =>
  kind ?? "diagnose"

const describeDiagnosticCapture = (args: {
  readonly target: DiagnosticCaptureTarget
  readonly kind: DiagnosticCaptureKind | null
}): {
  readonly artifactKeyPrefix: string
  readonly artifactLabel: string
  readonly summary: string
} => {
  if (args.target === "simulator") {
    return {
      artifactKeyPrefix: "diagnostic-simulator",
      artifactLabel: "simulator-diagnostic",
      summary: "Simulator diagnostic bundle captured via xcrun simctl diagnose.",
    }
  }

  const mode = resolveDeviceDiagnosticCaptureMode(args.kind)
  return mode === "sysdiagnose"
    ? {
        artifactKeyPrefix: "diagnostic-device-sysdiagnose",
        artifactLabel: "device-sysdiagnose",
        summary: "Device sysdiagnose bundle captured via xcrun devicectl device sysdiagnose.",
      }
    : {
        artifactKeyPrefix: "diagnostic-device",
        artifactLabel: "device-diagnostic",
        summary: "Device diagnostic bundle captured via xcrun devicectl diagnose.",
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
      "The daemon can resolve a concrete simulator UDID, boot it, either build/install Probe's fixture app or attach to an already-running installed app, and capture native simulator screenshots and videos into the session artifact root.",
    details: [
      "Uses simctl list --json plus bootstatus -b for deterministic simulator selection.",
      "Fixture sessions use simctl install and simctl launch --terminate-running-process before runner attach.",
      "Arbitrary-app sessions verify installation/running state with simctl launch plus simctl listapps before runner attach.",
      "Screenshots use simctl io screenshot and land under screenshots/.",
      "Videos use simctl io recordVideo and land under video/.",
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
      "Runner control works through the honest transport-boundary seam: simulator bootstrap manifest plus HTTP POST command ingress plus stdout-framed mixed-log readiness/diagnostics.",
    details: [
      "xcodebuild stdin is not treated as a usable host-to-runner transport in this slice.",
      "The same runner transport is used for both Probe's built-in fixture app and attach-to-running simulator sessions.",
      "Runner feature flags such as uiAction and uiActionBatch are reported under session health runner details.",
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
      ? "The real-device runner is live over a device-specific bootstrap-manifest + HTTP POST + stdout-ready transport."
      : "The real-device runner transport is not established in this slice; Probe only keeps preflight state and explicit integration points alive.",
    details: args.liveRunner
      ? [
          "Command ingress uses the runner-local HTTP listener reported in the ready frame.",
          "Ready-state events are still parsed from stdout JSONL frames embedded in the mixed xcodebuild/XCTest log stream.",
          "Runner feature flags such as uiAction and uiActionBatch are reported under session health runner details.",
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

const buildSimulatorWarnings = (_opened: OpenedSimulatorSession): ReadonlyArray<string> => {
  const warnings = [
    "Runner command ingress now uses the validated HTTP POST listener seam rather than xcodebuild stdin.",
    daemonOwnedCleanupWarning,
    nonRecoverableSessionWarning,
    selectorDriftContractWarning,
    offscreenHittabilityWarning,
  ]

  return warnings
}

const buildRealDeviceWarnings = (opened: OpenedRealDeviceSession): ReadonlyArray<string> => {
  const warnings = [
    ...opened.warnings,
    daemonOwnedCleanupWarning,
  ]

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
    readonly listActiveSessions: () => Effect.Effect<ReadonlyArray<SessionListEntry>>
    readonly openDeviceSession: (params: {
      readonly bundleId: string
      readonly deviceId: string | null
      readonly projectRoot: string
      readonly emitProgress: (stage: string, message: string) => void
    }) => Effect.Effect<
      SessionHealth,
      SessionConflictError | DeviceInterruptionError | EnvironmentError | UserInputError | UnsupportedCapabilityError | ChildProcessError
    >
    readonly openSimulatorSession: (params: {
      readonly bundleId: string
      readonly sessionMode?: SimulatorSessionMode
      readonly simulatorUdid: string | null
      readonly projectRoot: string
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
    readonly markLog: (params: {
      readonly sessionId: string
      readonly label: string
    }) => Effect.Effect<
      SummaryArtifactResult,
      SessionNotFoundError | UserInputError | EnvironmentError
    >
    readonly captureLogWindow: (params: {
      readonly sessionId: string
      readonly captureSeconds: number
    }) => Effect.Effect<
      SummaryArtifactResult,
      SessionNotFoundError | ArtifactNotFoundError | UserInputError | UnsupportedCapabilityError | EnvironmentError | ChildProcessError
    >
    readonly captureDiagnosticBundle: (params: {
      readonly sessionId: string
      readonly target: DiagnosticCaptureTarget
      readonly kind: DiagnosticCaptureKind | null
    }) => Effect.Effect<
      SummaryArtifactResult,
      SessionNotFoundError | UserInputError | EnvironmentError | ChildProcessError
    >
    readonly getLogDoctorReport: (sessionId: string) => Effect.Effect<
      SessionLogDoctorReport,
      SessionNotFoundError | EnvironmentError
    >
    readonly captureScreenshot: (params: {
      readonly sessionId: string
      readonly label: string | null
      readonly outputMode: OutputMode
    }) => Effect.Effect<
      SessionScreenshotResult,
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
    readonly runFlow: (params: {
      readonly sessionId: string
      readonly flow: SessionFlowContract
    }) => Effect.Effect<
      SessionFlowResult,
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
      action: RunnerAction,
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

    const buildActionResultMetadata = (
      retry: RetryAttemptMetadata,
      verdict: SessionActionResult["verdict"] = null,
      waitedMs: number | null = null,
      polledCount: number | null = null,
    ) => ({
      retryCount: retry.retryCount,
      retryReasons: retry.retryReasons,
      verdict,
      waitedMs,
      polledCount,
    })

    const persistActionFailure = (sessionId: string, record: ActiveSessionRecord, kind: SessionAction["kind"]) =>
      Effect.gen(function* () {
        updateHealthCheck(record, kind, false)
        yield* persistHealth(sessionId, record.health)
        yield* syncDaemonMetadata
      })

    const executeSessionAction = (args: {
      readonly sessionId: string
      readonly action: SessionAction
      readonly recordAction: boolean
    }) =>
      Effect.gen(function* () {
        const record = yield* requireSessionRecord(args.sessionId)

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

        const validationError = validateSessionAction(args.action)

        if (validationError) {
          return yield* new UserInputError({
            code: "session-action-invalid",
            reason: validationError,
            nextStep: "Fix the action payload and retry the session action request.",
            details: [],
          })
        }

        if (args.action.kind === "screenshot") {
          const fileStem = `${timestampForFile()}-screenshot`
          const captureResult = yield* attemptWithRetry({
            policy: args.action.retryPolicy ?? defaultReadOnlyRetryPolicy,
            run: () => captureScreenshotArtifact({
              sessionId: args.sessionId,
              record,
              fileStem,
              artifactKey: `screenshot-${fileStem}`,
              artifactLabel: "screenshot",
              summary: `Screenshot captured for session ${args.sessionId}.`,
            }),
          })

          if (!captureResult.ok) {
            yield* persistActionFailure(args.sessionId, record, args.action.kind)
            return {
              ok: false,
              error: captureResult.error,
              retry: captureResult.retry,
            } satisfies ActionExecutionOutcome
          }

          if (args.recordAction) {
            appendRecordedAction(record, buildRecordedSessionAction(args.action, null))
          }

          updateHealthCheck(record, args.action.kind, true)
          yield* refreshSessionArtifacts(args.sessionId, record)

          return {
            ok: true,
            result: {
              summary: `Captured screenshot artifact ${captureResult.value.artifact.absolutePath}.`,
              action: args.action.kind,
              matchedRef: null,
              resolvedBy: "none",
              statusLabel: captureResult.value.statusLabel,
              latestSnapshotId: record.snapshotState.latest?.snapshotId ?? null,
              artifact: captureResult.value.artifact,
              recordingLength: record.recording.steps.length,
              handledMs: captureResult.value.handledMs,
              ...buildActionResultMetadata(captureResult.retry),
            } satisfies ExtendedSessionActionResult,
          } satisfies ActionExecutionOutcome
        }

        if (args.action.kind === "video") {
          const durationMs = normalizeVideoDurationMs(args.action.durationMs)
          const normalizedAction: SessionAction = { kind: "video", durationMs }
          const fileStem = `${timestampForFile()}-video`
          const captureResult = yield* Effect.either(captureVideoArtifact({
            sessionId: args.sessionId,
            record,
            durationMs,
            fileStem,
            artifactKey: `video-${fileStem}`,
            artifactLabel: "video",
          }))

          if (captureResult._tag === "Left") {
            yield* persistActionFailure(args.sessionId, record, args.action.kind)
            return {
              ok: false,
              error: captureResult.left,
              retry: emptyRetryAttemptMetadata(),
            } satisfies ActionExecutionOutcome
          }

          if (args.recordAction) {
            appendRecordedAction(record, buildRecordedSessionAction(normalizedAction, null))
          }

          updateHealthCheck(record, args.action.kind, true)
          yield* refreshSessionArtifacts(args.sessionId, record)

          const modeSummary = describeVideoArtifactLabel(captureResult.right.mode)
          const clampNote = durationMs !== args.action.durationMs
            ? ` Requested duration ${args.action.durationMs}ms was clamped to ${durationMs}ms.`
            : ""

          return {
            ok: true,
            result: {
              summary: `Captured ${modeSummary} at ${captureResult.right.artifact.absolutePath}.${clampNote}`,
              action: args.action.kind,
              matchedRef: null,
              resolvedBy: "none",
              statusLabel: captureResult.right.statusLabel,
              latestSnapshotId: record.snapshotState.latest?.snapshotId ?? null,
              artifact: captureResult.right.artifact,
              recordingLength: record.recording.steps.length,
              handledMs: captureResult.right.handledMs,
              ...buildActionResultMetadata(emptyRetryAttemptMetadata()),
            } satisfies ExtendedSessionActionResult,
          } satisfies ActionExecutionOutcome
        }

        if (args.action.kind === "assert") {
          const action = args.action
          const retryPolicy = action.retryPolicy ?? defaultAssertRetryPolicy
          let cachedSnapshot: { readonly artifact: StoredSnapshotArtifact; readonly artifactRecord: ArtifactRecord } | null = null
          const result = yield* attemptWithRetry({
            policy: retryPolicy,
            run: () =>
              Effect.gen(function* () {
                const snapshot = retryPolicy.refreshSnapshotBetweenAttempts || cachedSnapshot === null
                  ? yield* captureSnapshotArtifactInternal(args.sessionId, record)
                  : cachedSnapshot

                cachedSnapshot = snapshot

                const resolution = resolveActionSelectorInSnapshot(snapshot.artifact, action.target)
                const evaluation = evaluateAssertion(resolution, action.expectation)

                if (!evaluation.ok) {
                  return yield* new EnvironmentError({
                    code: "session-assert-failed",
                    reason: evaluation.summary,
                    nextStep: "Inspect the latest snapshot artifact and retry when the app is in the expected state.",
                    details: [],
                  })
                }

                return { snapshot, resolution, evaluation }
              }),
          })

          if (!result.ok) {
            yield* persistActionFailure(args.sessionId, record, args.action.kind)
            return {
              ok: false,
              error: result.error,
              retry: result.retry,
            } satisfies ActionExecutionOutcome
          }

          if (args.recordAction) {
            appendRecordedAction(record, buildRecordedSessionAction(action, result.value.resolution.target))
          }

          updateHealthCheck(record, args.action.kind, true)
          yield* persistHealth(args.sessionId, record.health)
          yield* syncDaemonMetadata

          const summary = result.value.evaluation.resolvedBy === "semantic"
            && action.target.kind === "ref"
            && action.target.fallback !== null
            && result.value.resolution.target?.kind === "snapshot"
            ? `Assertion passed for ${describeSnapshotNode(result.value.resolution.target.node)} (${result.value.resolution.target.ref}) after semantic selector-drift recovery.`
            : result.value.evaluation.summary

          return {
            ok: true,
            result: {
              summary,
              action: args.action.kind,
              matchedRef: result.value.evaluation.matchedRef,
              resolvedBy: result.value.evaluation.resolvedBy,
              statusLabel: result.value.snapshot.artifact.statusLabel,
              latestSnapshotId: result.value.snapshot.artifact.snapshotId,
              artifact: null,
              recordingLength: record.recording.steps.length,
              handledMs: null,
              ...buildActionResultMetadata(result.retry, "passed", null, result.retry.retryCount + 1),
            } satisfies ExtendedSessionActionResult,
          } satisfies ActionExecutionOutcome
        }

        if (args.action.kind === "wait") {
          const action = args.action

          if (action.condition === "duration") {
            yield* Effect.sleep(action.timeoutMs)
            updateHealthCheck(record, args.action.kind, true)
            yield* persistHealth(args.sessionId, record.health)
            yield* syncDaemonMetadata

            return {
              ok: true,
              result: {
                summary: `Waited ${action.timeoutMs}ms before continuing.`,
                action: args.action.kind,
                matchedRef: null,
                resolvedBy: "none",
                statusLabel: record.snapshotState.latest?.statusLabel ?? null,
                latestSnapshotId: record.snapshotState.latest?.snapshotId ?? null,
                artifact: null,
                recordingLength: record.recording.steps.length,
                handledMs: null,
                ...buildActionResultMetadata(emptyRetryAttemptMetadata(), "passed", action.timeoutMs, 1),
              } satisfies ExtendedSessionActionResult,
            } satisfies ActionExecutionOutcome
          }

          if (action.target === null) {
            return yield* new UserInputError({
              code: "session-action-invalid",
              reason: "Wait actions require a selector or target unless condition is duration.",
              nextStep: "Fix the wait payload and retry the session action request.",
              details: [],
            })
          }

          const waitTarget = action.target

          if (waitTarget.kind === "point") {
            return yield* new UserInputError({
              code: "session-action-invalid",
              reason: "Point selectors cannot be used with wait actions. Use ref, semantic, or absence selectors instead.",
              nextStep: "Fix the wait payload and retry the session action request.",
              details: [],
            })
          }

          const retryPolicy = action.retryPolicy ?? defaultWaitRetryPolicy(action.timeoutMs)
          const startedAt = Date.now()
          const retryReasons: Array<string> = []
          let attempts = 0
          let lastSnapshot: { readonly artifact: StoredSnapshotArtifact; readonly artifactRecord: ArtifactRecord } | null = null
          let lastEvaluation: ReturnType<typeof evaluateAssertion> | null = null

          while (attempts < retryPolicy.maxAttempts) {
            attempts += 1

            const snapshot: { readonly artifact: StoredSnapshotArtifact; readonly artifactRecord: ArtifactRecord } = retryPolicy.refreshSnapshotBetweenAttempts || lastSnapshot === null
              ? yield* captureSnapshotArtifactInternal(args.sessionId, record)
              : lastSnapshot

            lastSnapshot = snapshot

            const selector = action.condition === "absence" && waitTarget.kind !== "absence"
              ? { kind: "absence", negate: waitTarget } as const
              : waitTarget
            const resolution = resolveActionSelectorInSnapshot(snapshot.artifact, selector)
            const expectation: Parameters<typeof evaluateAssertion>[1] = {
              exists: true,
              visible: null,
              hidden: null,
              text: action.condition === "text" ? action.text : null,
              label: null,
              value: null,
              type: null,
              enabled: null,
              selected: null,
              focused: null,
              interactive: null,
            }
            const evaluation = evaluateAssertion(resolution, expectation)
            lastEvaluation = evaluation

            if (evaluation.ok) {
              updateHealthCheck(record, args.action.kind, true)
              yield* persistHealth(args.sessionId, record.health)
              yield* syncDaemonMetadata

              const waitedMs = Date.now() - startedAt

              return {
                ok: true,
                result: {
                  summary: `Wait condition ${action.condition} passed after ${waitedMs}ms across ${attempts} poll(s).`,
                  action: args.action.kind,
                  matchedRef: evaluation.matchedRef,
                  resolvedBy: evaluation.resolvedBy,
                  statusLabel: snapshot.artifact.statusLabel,
                  latestSnapshotId: snapshot.artifact.snapshotId,
                  artifact: null,
                  recordingLength: record.recording.steps.length,
                  handledMs: null,
                  ...buildActionResultMetadata({ retryCount: attempts - 1, retryReasons }, "passed", waitedMs, attempts),
                } satisfies ExtendedSessionActionResult,
              } satisfies ActionExecutionOutcome
            }

            const elapsedMs = Date.now() - startedAt
            const remainingMs = action.timeoutMs - elapsedMs
            const retryCode: RetryReasonCode = resolution.outcome === "not-found" ? "not-found" : "assertion-failed"

            if (attempts >= retryPolicy.maxAttempts || remainingMs <= 0 || !retryPolicy.retryOn.includes(retryCode)) {
              break
            }

            retryReasons.push(`${retryCode}: ${evaluation.summary}`)
            yield* Effect.sleep(Math.min(retryPolicy.backoffMs, remainingMs))
          }

          yield* persistActionFailure(args.sessionId, record, args.action.kind)
          return {
            ok: false,
            error: new EnvironmentError({
              code: "session-wait-timeout",
              reason: lastEvaluation?.summary ?? "Wait condition did not become true before timeout.",
              nextStep: "Inspect the latest snapshot artifact, adjust the wait condition, and retry once the app stabilizes.",
              details: lastSnapshot === null ? [] : [`latest snapshot: ${lastSnapshot.artifact.snapshotId}`],
            }),
            retry: {
              retryCount: Math.max(0, attempts - 1),
              retryReasons,
            },
          } satisfies ActionExecutionOutcome
        }

        if (!isRunnerUiSessionAction(args.action)) {
          return yield* new UserInputError({
            code: "session-action-invalid",
            reason: "Unsupported runner-backed action kind.",
            nextStep: "Use tap, press, swipe, type, or scroll for runner UI actions.",
            details: [],
          })
        }

        const action = args.action
        const retryPolicy = action.retryPolicy ?? defaultMutationRetryPolicy
        let cachedPreSnapshot: { readonly artifact: StoredSnapshotArtifact; readonly artifactRecord: ArtifactRecord } | null = null
        const actionResult = yield* attemptWithRetry({
          policy: retryPolicy,
          run: () =>
            Effect.gen(function* () {
              const preSnapshot = action.target.kind === "point"
                ? null
                : retryPolicy.refreshSnapshotBetweenAttempts || cachedPreSnapshot === null
                  ? yield* captureSnapshotArtifactInternal(args.sessionId, record)
                  : cachedPreSnapshot

              if (preSnapshot !== null) {
                cachedPreSnapshot = preSnapshot
              }

              const resolution = resolveActionSelectorInSnapshot(preSnapshot?.artifact ?? null, action.target)

              if (resolution.outcome !== "matched") {
                return yield* new EnvironmentError({
                  code: "session-action-target-not-found",
                  reason: resolution.reason,
                  nextStep: "Capture a fresh snapshot, refine the selector, and retry the action.",
                  details: [],
                })
              }

              const resolvedTarget = resolution.target!

              if (resolvedTarget.kind === "absence") {
                return yield* new EnvironmentError({
                  code: "session-action-target-not-found",
                  reason: "Absence selectors can only be used with assert actions.",
                  nextStep: "Use a ref, semantic, or point selector for runner UI actions, or move the absence check into an assert.",
                  details: [],
                })
              }

              const response = yield* sendRunnerCommand(
                args.sessionId,
                record,
                "uiAction",
                JSON.stringify(buildRunnerUiActionPayload(action, resolvedTarget, preSnapshot?.artifact ?? null)),
              )
              record.nextSequence += 1

              if (!response.ok) {
                const failureReason = response.error
                  ?? response.payload
                  ?? `Runner ${action.kind} failed with status ${response.statusLabel}.`

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

              const postSnapshot = yield* captureSnapshotArtifactInternal(args.sessionId, record)

              return {
                postSnapshot,
                resolvedTarget,
                handledMs: response.handledMs,
              }
            }),
        })

        if (!actionResult.ok) {
          yield* persistActionFailure(args.sessionId, record, args.action.kind)
          return {
            ok: false,
            error: actionResult.error,
            retry: actionResult.retry,
          } satisfies ActionExecutionOutcome
        }

        if (args.recordAction) {
          appendRecordedAction(record, buildRecordedSessionAction(action, actionResult.value.resolvedTarget))
        }

        updateHealthCheck(record, args.action.kind, true)
        yield* persistHealth(args.sessionId, record.health)
        yield* syncDaemonMetadata

        const summary = actionResult.value.resolvedTarget.kind === "snapshot"
          ? actionResult.value.resolvedTarget.resolvedBy === "semantic"
              && action.target.kind === "ref"
              && action.target.fallback !== null
            ? `Executed ${action.kind} on ${describeSnapshotNode(actionResult.value.resolvedTarget.node)} after semantic selector-drift recovery; captured ${actionResult.value.postSnapshot.artifact.snapshotId}.`
            : `Executed ${action.kind} on ${describeSnapshotNode(actionResult.value.resolvedTarget.node)}; captured ${actionResult.value.postSnapshot.artifact.snapshotId}.`
          : `Executed ${action.kind} at point(${actionResult.value.resolvedTarget.x}, ${actionResult.value.resolvedTarget.y}) in interaction-root coordinates; captured ${actionResult.value.postSnapshot.artifact.snapshotId}.`

        return {
          ok: true,
          result: {
            summary,
            action: args.action.kind,
            matchedRef: actionResult.value.resolvedTarget.kind === "snapshot" ? actionResult.value.resolvedTarget.ref : null,
            resolvedBy: actionResult.value.resolvedTarget.resolvedBy,
            statusLabel: actionResult.value.postSnapshot.artifact.statusLabel,
            latestSnapshotId: actionResult.value.postSnapshot.artifact.snapshotId,
              artifact: null,
              recordingLength: record.recording.steps.length,
              handledMs: actionResult.value.handledMs,
              ...buildActionResultMetadata(actionResult.retry),
            } satisfies ExtendedSessionActionResult,
          } satisfies ActionExecutionOutcome
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

            if (response.inlinePayload != null) {
              if (response.inlinePayloadEncoding !== "base64") {
                throw new Error(
                  `Expected base64 inline screenshot payload, received ${response.inlinePayloadEncoding ?? "unknown"}.`,
                )
              }

              await writeFile(absolutePath, Buffer.from(response.inlinePayload, "base64"))
              return
            }

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
          handledMs: response.handledMs,
        }
      })

    const captureSimulatorScreenshotArtifact = (args: {
      readonly sessionId: string
      readonly record: SimulatorActiveSessionRecord
      readonly fileStem: string
      readonly artifactKey: string
      readonly artifactLabel: string
      readonly summary: string
    }) =>
      Effect.gen(function* () {
        const screenshotsDirectory = join(args.record.health.artifactRoot, "screenshots")
        const absolutePath = join(screenshotsDirectory, `${args.fileStem}.png`)

        yield* simulatorHarness.captureSimulatorScreenshot({
          simulatorUdid: args.record.health.target.deviceId,
          absolutePath,
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
          statusLabel: null,
          handledMs: null,
        }
      })

    const captureScreenshotArtifact = (args: {
      readonly sessionId: string
      readonly record: ActiveSessionRecord
      readonly fileStem: string
      readonly artifactKey: string
      readonly artifactLabel: string
      readonly summary: string
    }) =>
      Effect.gen(function* () {
        if (isSimulatorRecord(args.record)) {
          return yield* captureSimulatorScreenshotArtifact({
            ...args,
            record: args.record,
          })
        }

        if (!isRunnerBackedRecord(args.record)) {
          return yield* new UnsupportedCapabilityError({
            code: "session-screenshot-real-device",
            capability: "session.screenshot",
            reason: "This session does not currently expose a live runner transport for screenshots.",
            nextStep: "Inspect session health/artifacts, or reopen the session once the runner transport is live.",
            details: [],
            wall: false,
          })
        }

        return yield* captureRunnerScreenshotArtifact({
          ...args,
          record: args.record,
        })
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
            handledMs: response.handledMs,
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
          handledMs: response.handledMs,
        }
      })

    const captureSimulatorVideoArtifact = (args: {
      readonly sessionId: string
      readonly record: SimulatorActiveSessionRecord
      readonly durationMs: number
      readonly fileStem: string
      readonly artifactKey: string
      readonly artifactLabel: string
    }) =>
      Effect.gen(function* () {
        const videoDirectory = join(args.record.health.artifactRoot, "video")
        const movPath = join(videoDirectory, `${args.fileStem}.mov`)

        yield* simulatorHarness.recordSimulatorVideo({
          simulatorUdid: args.record.health.target.deviceId,
          absolutePath: movPath,
          durationMs: args.durationMs,
        })

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
          const artifact = createArtifactRecord({
            artifactRoot: args.record.health.artifactRoot,
            key: args.artifactKey,
            label: args.artifactLabel,
            kind: "mov",
            absolutePath: movPath,
            summary:
              `Native simulator QuickTime video captured over simctl with requested duration ${args.durationMs}ms because ffmpeg was not available to remux it to MP4.`,
          })

          yield* artifactStore.registerArtifact(args.sessionId, artifact)

          return {
            artifact,
            statusLabel: null,
            mode: "mov" as const,
            handledMs: null,
          }
        }

        const ffmpegExecutable = resolveFfmpegExecutable()
        const sourceFrameRate = yield* Effect.tryPromise({
          try: () => probeSimulatorVideoFrameRate(movPath),
          catch: (error) =>
            new EnvironmentError({
              code: "session-video-ffprobe-run",
              reason: error instanceof Error ? error.message : String(error),
              nextStep: "Inspect ffprobe availability and retry the video request.",
              details: [],
            }),
        })
        const absolutePath = join(videoDirectory, `${args.fileStem}.mp4`)
        const ffmpegResult = yield* Effect.tryPromise({
          try: () =>
            runHostCommand({
              command: ffmpegExecutable,
              commandArgs: [
                "-y",
                "-i",
                movPath,
                ...(sourceFrameRate === null ? [] : ["-vf", `fps=${sourceFrameRate.expression}`]),
                "-c:v",
                "libx264",
                "-pix_fmt",
                "yuv420p",
                "-movflags",
                "+faststart",
                absolutePath,
              ],
              timeoutMs: args.durationMs + 60_000,
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
            reason: formatHostCommandFailure(`${ffmpegExecutable} -i`, ffmpegResult),
            nextStep: "Inspect ffmpeg availability and retry the video request.",
            details: [],
          })
        }

        yield* Effect.tryPromise({
          try: () => rm(movPath, { force: true }).catch(() => undefined),
          catch: (error) =>
            new EnvironmentError({
              code: "session-video-cleanup",
              reason: error instanceof Error ? error.message : String(error),
              nextStep: "Inspect the session video directory and retry the video request.",
              details: [],
            }),
        })

        const artifact = createArtifactRecord({
          artifactRoot: args.record.health.artifactRoot,
          key: args.artifactKey,
          label: args.artifactLabel,
          kind: "mp4",
          absolutePath,
          summary:
            sourceFrameRate === null
              ? `Native simulator video captured over simctl and transcoded to MP4 via ffmpeg using the source timing for requested duration ${args.durationMs}ms.`
              : `Native simulator video captured over simctl and normalized to captured simulator rate ${sourceFrameRate.label} fps MP4 via ffmpeg for requested duration ${args.durationMs}ms.`,
        })

        yield* artifactStore.registerArtifact(args.sessionId, artifact)

        return {
          artifact,
          statusLabel: null,
          mode: "mp4" as const,
          handledMs: null,
        }
      })

    const captureVideoArtifact = (args: {
      readonly sessionId: string
      readonly record: ActiveSessionRecord
      readonly durationMs: number
      readonly fileStem: string
      readonly artifactKey: string
      readonly artifactLabel: string
    }) =>
      Effect.gen(function* () {
        if (isSimulatorRecord(args.record)) {
          return yield* captureSimulatorVideoArtifact({
            ...args,
            record: args.record,
          })
        }

        if (!isRunnerBackedRecord(args.record)) {
          return yield* new UnsupportedCapabilityError({
            code: "session-video-real-device",
            capability: "session.video",
            reason: "This session does not currently expose a live runner transport for video capture.",
            nextStep: "Inspect session health/artifacts, or reopen the session once the runner transport is live.",
            details: [],
            wall: false,
          })
        }

        return yield* captureRunnerVideoArtifact({
          ...args,
          record: args.record,
        })
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
          try: async () => {
            if (response.inlinePayload != null) {
              if (response.inlinePayloadEncoding !== "utf8") {
                throw new Error(
                  `Expected utf8 inline snapshot payload, received ${response.inlinePayloadEncoding ?? "unknown"}.`,
                )
              }

              return response.inlinePayload
            }

            return await readFile(response.snapshotPayloadPath!, "utf8")
          },
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
          handledMs: response.handledMs,
        }
      })

    const appendRecordedAction = (record: ActiveSessionRecord, action: RecordedSessionAction) => {
      record.recording.steps.push(action)
    }

    const toSessionListEntry = (health: SessionHealth): SessionListEntry => ({
      id: health.sessionId,
      target: {
        platform: health.target.platform,
        deviceId: health.target.deviceId,
        deviceName: health.target.deviceName,
        runtime: health.target.runtime,
      },
      bundleId: health.target.bundleId,
      state: health.state,
      openedAt: health.openedAt,
    })

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

    const registry = SessionRegistry.of({
      getSessionTtlMs: () => defaultSessionTtlMs,
      getActiveSessionCount: () =>
        Effect.gen(function* () {
          const sessions = yield* Ref.get(sessionsRef)
          const opening = yield* Ref.get(openingRef)
          return sessions.size + (opening ? 1 : 0)
        }),
      listActiveSessions: () =>
        Effect.gen(function* () {
          const sessions = yield* Ref.get(sessionsRef)

          return [...sessions.values()]
            .map((record) => toSessionListEntry(record.health))
            .sort((left, right) => left.openedAt.localeCompare(right.openedAt))
        }),
      openDeviceSession: ({ bundleId, deviceId, projectRoot, emitProgress }) =>
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
                  projectRoot,
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
                        "The current real-device slice uses a device bootstrap manifest plus runner-local HTTP ingress, while stdout remains the canonical ready-frame observation seam and diagnostics stream.",
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
                      capabilities: [...opened.capabilities],
                      note:
                        "The real-device runner is live over HTTP POST command ingress with stdout-JSONL mixed-log observation for readiness and diagnostics.",
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
      openSimulatorSession: ({ bundleId, sessionMode, simulatorUdid, projectRoot, emitProgress }) =>
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
                  projectRoot,
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
                        "The current vertical slice uses the transport seam validated by the runner boundary spikes: simulator bootstrap manifest plus HTTP POST command ingress plus stdout-framed readiness/diagnostic egress.",
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
                      capabilities: [...opened.capabilities],
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
            const liveRunnerDetails = record.health.runner.kind === "real-device-live"
              ? record.health.runner
              : null
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

            const pingAttempt = yield* Effect.either(
              Effect.tryPromise({
                try: () => record.sendRunnerCommand(record.nextSequence, "ping", "health-check"),
                catch: (error) =>
                  new EnvironmentError({
                    code: "device-session-health-ping",
                    reason: error instanceof Error ? error.message : String(error),
                    nextStep: "Inspect the runner artifacts, unlock the device if it is blocked, then retry session health or reopen the session.",
                    details: [],
                  }),
              }),
            )

            const interruption = yield* Effect.tryPromise({
              try: () => detectRealDeviceInterruption({
                targetBundleId: record.health.target.bundleId,
                device: {
                  identifier: record.health.target.deviceId,
                  name: record.health.target.deviceName,
                },
                statusLabel: Either.isRight(pingAttempt) ? pingAttempt.right.statusLabel : null,
                logPath: liveRunnerDetails?.logPath ?? null,
                wrapperStderrPath: liveRunnerDetails?.wrapperStderrPath ?? null,
              }),
              catch: (error) =>
                new EnvironmentError({
                  code: "device-session-health-interruption-detect",
                  reason: error instanceof Error ? error.message : String(error),
                  nextStep: "Inspect the saved device session artifacts and retry the health request.",
                  details: [],
                }),
            })
            const interruptionWarning = interruption
              ? buildRealDeviceInterruptionWarning(interruption)
              : null

            if (Either.isLeft(pingAttempt)) {
              if (!interruption || interruption.evidenceKind !== "direct") {
                yield* markSessionRunnerFailed({
                  sessionId,
                  record,
                  lastCommand: "ping",
                  reason: pingAttempt.left.reason,
                  wrapperRunning: record.isRunnerRunning(),
                })
                return yield* pingAttempt.left
              }

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
                  wrapperRunning: record.isRunnerRunning(),
                  pingRttMs: null,
                  lastCommand: "ping",
                  lastOk: false,
                },
                warnings: composeWarnings(record, [
                  ...(interruptionWarning ? [interruptionWarning] : []),
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

            const response = pingAttempt.right
            record.nextSequence += 1
            const interruptionIsActive = interruption?.evidenceKind === "direct"
            const warningExtras = [
              ...(interruptionWarning ? [interruptionWarning] : []),
              ...(connection.status === "connected" ? [] : [deviceDisconnectedWarning]),
              ...(!response.ok && !interruptionIsActive
                ? [`Runner ping reported ${response.statusLabel}. ${nonRecoverableSessionWarning}`]
                : []),
            ]
            const warnings = warningExtras.length === 0
              ? [...record.baseWarnings]
              : composeWarnings(record, warningExtras)

            const nextHealth: SessionHealth = {
              ...record.health,
              updatedAt: nowIso(),
              expiresAt: expiresAtIso(),
              connection,
              resources: interruptionIsActive
                ? setRunnerResourceState(record.health.resources, "degraded")
                : response.ok
                  ? record.health.resources
                  : setRunnerResourceState(record.health.resources, "failed"),
              capabilities: [...buildRealDeviceCapabilities({
                connection,
                integrationPoints: record.integrationPoints,
                liveRunner: response.ok && connection.status === "connected" && !interruptionIsActive,
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

          const markers = yield* readSessionLogMarkers(record.health.artifactRoot)
          const excerpt = selectBufferedLogLines({
            content: rawContent,
            lineCount,
            match,
            sourceLabel: sourceArtifact.label,
          })
          const content = appendSessionLogMarkers(excerpt.content, markers)
          const summary = markers.length > 0
            ? `${excerpt.summary}; included ${markers.length} log marker${markers.length === 1 ? "" : "s"}.`
            : excerpt.summary

          const result = yield* renderLogResult({
            sessionId,
            artifactRoot: record.health.artifactRoot,
            source,
            content,
            summary,
            outputMode,
          })

          yield* refreshSessionArtifacts(sessionId, record)

          return {
            sourceArtifact,
            result,
          } satisfies SessionLogsResult
        }),
      markLog: ({ sessionId, label }) =>
        Effect.gen(function* () {
          const trimmedLabel = label.trim()

          if (trimmedLabel.length === 0) {
            return yield* new UserInputError({
              code: "session-log-mark-label",
              reason: "Expected a non-empty log mark label.",
              nextStep: "Pass --label <text> and retry the log mark request.",
              details: [],
            })
          }

          const record = yield* requireSessionRecord(sessionId)
          const marksDirectory = join(record.health.artifactRoot, "logs", "marks")
          const timestamp = nowIso()
          const fileStem = `${timestampForFile()}-${sanitizeFileComponent(trimmedLabel, "mark")}`
          const marker: SessionLogMarker = {
            timestamp,
            label: trimmedLabel,
            sessionId,
          }
          const absolutePath = join(marksDirectory, `${fileStem}.json`)

          yield* Effect.tryPromise({
            try: async () => {
              await mkdir(marksDirectory, { recursive: true })
              await writeFile(
                absolutePath,
                `${JSON.stringify(marker, null, 2)}\n`,
                "utf8",
              )
            },
            catch: (error) =>
              new EnvironmentError({
                code: "session-log-mark-write",
                reason: error instanceof Error ? error.message : String(error),
                nextStep: "Inspect the session log marker directory permissions and retry.",
                details: [],
              }),
          })

          const writableLogStream = resolveWritableLogStreamArtifact(record.health.artifacts)

          if (writableLogStream === null) {
            return yield* new EnvironmentError({
              code: "session-log-mark-stream-missing",
              reason: "Probe could not find a writable stdout-events or wrapper-stderr artifact for this session.",
              nextStep: "Inspect the session artifact list and reopen the session if the runner log stream is missing.",
              details: [],
            })
          }

          yield* Effect.tryPromise({
            try: () => appendFile(writableLogStream.absolutePath, buildSessionLogMarkStreamEntry(marker), "utf8"),
            catch: (error) =>
              new EnvironmentError({
                code: "session-log-mark-stream-write",
                reason: error instanceof Error ? error.message : String(error),
                nextStep: `Inspect the ${writableLogStream.key} artifact path and retry the log mark request.`,
                details: [],
              }),
          })

          const artifact = createArtifactRecord({
            artifactRoot: record.health.artifactRoot,
            key: `log-mark-${fileStem}`,
            label: "log-mark",
            kind: "json",
            absolutePath,
            summary: `Log mark '${trimmedLabel}' recorded at ${timestamp} for session ${sessionId}.`,
          })

          yield* artifactStore.registerArtifact(sessionId, artifact)
          yield* refreshSessionArtifacts(sessionId, record)

          return {
            kind: "summary+artifact",
            summary: `Recorded log mark '${trimmedLabel}' and appended it to ${writableLogStream.label}.`,
            artifact,
          } satisfies SummaryArtifactResult
        }),
      captureLogWindow: ({ sessionId, captureSeconds }) =>
        Effect.gen(function* () {
          const record = yield* requireSessionRecord(sessionId)

          if (record.health.target.platform !== "simulator") {
            return yield* new UnsupportedCapabilityError({
              code: "session-log-window-real-device",
              capability: "session.logs.capture",
              reason: "Bounded live log-window capture is currently only supported for simulator sessions.",
              nextStep: "Inspect the saved device log artifacts, or retry this command against a simulator session.",
              details: [],
              wall: false,
            })
          }

          if (!Number.isInteger(captureSeconds) || captureSeconds <= 0 || captureSeconds > maxSessionLogCaptureSeconds) {
            return yield* new UserInputError({
              code: "session-log-window-seconds",
              reason: `Expected capture seconds between 1 and ${maxSessionLogCaptureSeconds}, received ${captureSeconds}.`,
              nextStep: `Pass --seconds <1-${maxSessionLogCaptureSeconds}> and retry the log capture request.`,
              details: [],
            })
          }

          const capture = yield* simulatorHarness.captureSimulatorLogStream({
            simulatorUdid: record.health.target.deviceId,
            logsDirectory: join(record.health.artifactRoot, "logs"),
            captureSeconds,
            predicate: null,
          })
          const artifact = createArtifactRecord({
            artifactRoot: record.health.artifactRoot,
            key: `simulator-log-capture-${timestampForFile()}`,
            label: "simulator-log-capture",
            kind: "ndjson",
            absolutePath: capture.absolutePath,
            summary: `Bounded simulator unified log capture over ${captureSeconds}s with no extra predicate.`,
          })

          yield* artifactStore.registerArtifact(sessionId, artifact)
          yield* refreshSessionArtifacts(sessionId, record)

          return {
            kind: "summary+artifact",
            summary: `Captured a ${captureSeconds}s simulator log window.`,
            artifact,
          } satisfies SummaryArtifactResult
        }),
      captureDiagnosticBundle: ({ sessionId, target, kind }) =>
        Effect.gen(function* () {
          const record = yield* requireSessionRecord(sessionId)

          if (record.health.target.platform !== target) {
            return yield* new UserInputError({
              code: "session-diagnostic-target-mismatch",
              reason: `Session ${sessionId} targets ${record.health.target.platform}, not ${target}.`,
              nextStep: `Retry with --target ${record.health.target.platform}, or use a session id for a ${target} session.`,
              details: [],
            })
          }

          if (target === "simulator" && kind !== null) {
            return yield* new UserInputError({
              code: "session-diagnostic-kind-invalid",
              reason: "Simulator diagnostic capture does not accept --kind.",
              nextStep: "Omit --kind when capturing a simulator diagnostic bundle.",
              details: [],
            })
          }

          const diagnosticsDirectory = join(record.health.artifactRoot, "diagnostics")
          const captureDescription = describeDiagnosticCapture({ target, kind })
          const fileStem = `${timestampForFile()}-${captureDescription.artifactLabel}`
          const capture = yield* Effect.either(
            target === "simulator"
              ? simulatorHarness.captureSimulatorDiagnosticBundle({
                  simulatorUdid: record.health.target.deviceId,
                  diagnosticsDirectory,
                  fileStem,
                })
              : realDeviceHarness.captureDeviceDiagnosticBundle({
                  deviceId: record.health.target.deviceId,
                  diagnosticsDirectory,
                  fileStem,
                  kind: resolveDeviceDiagnosticCaptureMode(kind),
                }),
          )

          if (capture._tag === "Left") {
            updateHealthCheck(record, "diagnostic-capture", false)
            yield* persistRecordHealth(sessionId, record)
            return yield* capture.left
          }

          const artifact = createArtifactRecord({
            artifactRoot: record.health.artifactRoot,
            key: `${captureDescription.artifactKeyPrefix}-${fileStem}`,
            label: captureDescription.artifactLabel,
            kind: "binary",
            absolutePath: capture.right.absolutePath,
            summary: captureDescription.summary,
          })

          yield* artifactStore.registerArtifact(sessionId, artifact)
          updateHealthCheck(record, "diagnostic-capture", true)
          yield* refreshSessionArtifacts(sessionId, record)

          return {
            kind: "summary+artifact",
            summary: captureDescription.summary,
            artifact,
          } satisfies SummaryArtifactResult
        }),
      getLogDoctorReport: (sessionId) =>
        Effect.gen(function* () {
          const record = yield* requireSessionRecord(sessionId)
          const artifacts = yield* refreshArtifacts(sessionId)
          const latestSimulatorCapture = [...artifacts]
            .filter((artifact) => artifact.label === "simulator-log-capture")
            .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0] ?? null
          const resolveSourceArtifact = (source: SessionLogSource): ArtifactRecord | null => {
            if (source === "simulator") {
              return latestSimulatorCapture
            }

            return artifacts.find((artifact) => artifact.key === resolveLogArtifactKey(source)) ?? null
          }

          const describeSourceAvailability = (source: SessionLogSource, artifact: ArtifactRecord | null) => {
            if (source === "simulator") {
              if (record.health.target.platform !== "simulator") {
                return {
                  available: false,
                  reason: "Bounded simulator live capture is only available for simulator sessions.",
                }
              }

              return {
                available: true,
                reason: artifact
                  ? `Available via bounded simulator live capture; latest artifact is ${artifact.key}.`
                  : "Available via bounded simulator live capture; no capture artifact has been recorded yet.",
              }
            }

            if (artifact) {
              return {
                available: true,
                reason: `Available via artifact ${artifact.key}.`,
              }
            }

            return {
              available: false,
              reason: `No ${source} log artifact is currently registered for this session.`,
            }
          }

          const sources = (["runner", "build", "wrapper", "stdout", "simulator"] as const).map((source) => {
            const artifact = resolveSourceArtifact(source)
            const availability = describeSourceAvailability(source, artifact)

            return {
              source,
              available: availability.available,
              reason: availability.reason,
              artifactKey: artifact?.key ?? null,
              artifactPath: artifact?.absolutePath ?? null,
            }
          })

          return {
            sessionId,
            targetPlatform: record.health.target.platform,
            summary: record.health.target.platform === "simulator"
              ? "Simulator log doctor reports artifact-backed runner/build/wrapper/stdout sources plus bounded live simulator capture."
              : "Real-device log doctor reports artifact-backed build/runner/wrapper/stdout sources; bounded live simulator capture is unavailable.",
            sources,
          } satisfies SessionLogDoctorReport
        }),
      captureSnapshot: ({ sessionId, outputMode }) =>
        Effect.gen(function* () {
          const record = yield* requireSessionRecord(sessionId)
          const captured = yield* (runWithRetry({
            policy: defaultReadOnlyRetryPolicy,
            run: () => captureSnapshotArtifactInternal(sessionId, record),
          }) as Effect.Effect<
            { readonly value: { readonly artifact: StoredSnapshotArtifact; readonly artifactRecord: ArtifactRecord }; readonly retry: RetryAttemptMetadata },
            UnsupportedCapabilityError | EnvironmentError | ChildProcessError
          >)
          return buildSessionSnapshotResult({
            artifact: captured.value.artifact,
            artifactRecord: captured.value.artifactRecord,
            outputMode,
            retry: captured.retry,
          })
        }),
      performAction: ({ sessionId, action }) =>
        Effect.gen(function* () {
          const outcome = yield* executeSessionAction({
            sessionId,
            action,
            recordAction: true,
          })

          if (!outcome.ok) {
            return yield* outcome.error
          }

          return outcome.result
        }),
      runFlow: ({ sessionId, flow }) =>
        Effect.gen(function* () {
          const validationError = validateSessionFlowContract(flow)

          if (validationError !== null) {
            return yield* new UserInputError({
              code: "session-flow-invalid",
              reason: validationError,
              nextStep: "Fix the flow contract and retry the flow request.",
              details: [],
            })
          }

          const isV2SessionFlow = isFlowV2Contract(flow)
          const record = yield* requireSessionRecord(sessionId)
          yield* refreshSessionArtifacts(sessionId, record)
          const plan = planFlowExecution(flow)

          const diffArtifacts = (before: ReadonlyArray<ArtifactRecord>, after: ReadonlyArray<ArtifactRecord>) => {
            const knownKeys = new Set(before.map((artifact) => artifact.key))
            return after.filter((artifact) => !knownKeys.has(artifact.key))
          }

          const failureVerdict = (error: SessionActionError | SessionNotFoundError): SessionFlowResult["verdict"] =>
            error instanceof EnvironmentError && error.code === "session-wait-timeout" ? "timed-out" : "failed"

          const failureWarnings = (args: {
            readonly error: SessionActionError | SessionNotFoundError
            readonly continued: boolean
          }): Array<string> => {
            const warnings: Array<string> = []

            if ("nextStep" in args.error && typeof args.error.nextStep === "string") {
              warnings.push(args.error.nextStep)
            }

            if ("details" in args.error && Array.isArray(args.error.details)) {
              warnings.push(...args.error.details)
            }

            if (args.continued) {
              warnings.push("Step failed but flow continued because continueOnError was enabled.")
            }

            return dedupeStrings(warnings)
          }

          const errorSummary = (error: SessionActionError | SessionNotFoundError): string =>
            error instanceof SessionNotFoundError
              ? `Session ${error.sessionId} was not found.`
              : error.reason

          const successWarnings = (args: {
            readonly step: FlowStep | FlowV2Step
            readonly baseWarnings: ReadonlyArray<string>
            readonly resolvedBy?: SessionActionResult["resolvedBy"]
          }) => {
            const warnings = [...args.baseWarnings]
            const target = "target" in args.step ? args.step.target : null

            if (
              args.resolvedBy === "semantic"
              && target !== null
              && target.kind === "ref"
              && target.fallback !== null
            ) {
              warnings.push(selectorDriftContractWarning)
            }

            return dedupeStrings(warnings)
          }

          const plannedExecutionProfile = (plannedStep: PlannedStep): FlowStepResult["executionProfile"] => {
            if (!isV2SessionFlow) {
              return null
            }

            return plannedStep.kind === "fast-single" || plannedStep.kind === "batch-sequence"
              ? "fast"
              : "verified"
          }

          const plannedTransportLane = (plannedStep: PlannedStep): FlowStepResult["transportLane"] => {
            if (!isV2SessionFlow) {
              return null
            }

            if (plannedStep.kind === "batch-sequence") {
              return "runner-batch"
            }

            if (plannedStep.kind !== "fast-single") {
              return "host-single"
            }

            return plannedStep.step.kind === "wait" ? "host-single" : "runner-single"
          }

          const runnerSupportsCapability = (
            activeRecord: ActiveSessionRecord,
            capability: "uiAction" | "uiActionBatch",
          ): boolean =>
            isLiveRunnerDetails(activeRecord.health.runner)
            && (activeRecord.health.runner.capabilities ?? []).includes(capability)

          const describeRunnerCapabilities = (activeRecord: ActiveSessionRecord): string =>
            isLiveRunnerDetails(activeRecord.health.runner)
              ? (activeRecord.health.runner.capabilities ?? []).join(", ") || "none"
              : "none"

          type RunnerBatchWaitActionPayload = {
            readonly kind: "wait"
            readonly timeoutMs: number
          }

          type RunnerBatchSequenceActionPayload = ReturnType<typeof buildDirectRunnerUiActionPayload> | RunnerBatchWaitActionPayload

          type RunnerBatchSequencePayload = {
            readonly actions: ReadonlyArray<RunnerBatchSequenceActionPayload>
          }

          const buildRunnerBatchSequencePayload = (actions: ReadonlyArray<FlowSequenceAction>): RunnerBatchSequencePayload => ({
            actions: actions.map((action) => {
              switch (action.kind) {
                case "wait":
                  return {
                    kind: "wait",
                    timeoutMs: action.timeoutMs,
                  }
                case "tap":
                case "press":
                case "swipe":
                case "type":
                case "scroll":
                  return buildDirectRunnerUiActionPayload(action, action.target)
              }
            }),
          })

          const toFlowSequenceActionKind = (value: string | null | undefined): FlowSequenceAction["kind"] | null => {
            switch (value) {
              case "tap":
              case "press":
              case "swipe":
              case "type":
              case "scroll":
              case "wait":
                return value
              default:
                return null
            }
          }

          const buildBatchSequenceChildFailure = (args: {
            readonly step: FlowSequenceStep
            readonly response: RunnerCommandResult
            readonly failureReason: string
          }): FlowSequenceChildFailure | null => {
            const rawIndex = args.response.failedActionIndex

            if (rawIndex === null || rawIndex === undefined || !Number.isInteger(rawIndex) || rawIndex < 0) {
              return null
            }

            const plannedChild = args.step.actions[rawIndex]
            const fallbackKind = toFlowSequenceActionKind(args.response.failedActionKind)

            return {
              index: rawIndex + 1,
              kind: plannedChild?.kind ?? fallbackKind ?? "tap",
              summary: args.failureReason,
            }
          }

          type BuiltFlowStepResult = FlowStepResult | FlowV2StepResult
          type BuiltFailedStep = FlowFailedStep | FlowV2FailedStep

          const buildFlowStepResult = (args: {
            readonly plannedStep: PlannedStep
            readonly kind: FlowStepResult["kind"] | FlowV2StepResult["kind"]
            readonly summary: string
            readonly verdict: SessionFlowResult["verdict"]
            readonly matchedRef: string | null
            readonly latestSnapshotId: string | null
            readonly retryCount: number
            readonly retryReasons: Array<string>
            readonly warnings: Array<string>
            readonly handledMs: number | null
            readonly checkpoint?: FlowV2StepResult["checkpoint"]
            readonly sequenceChildFailure?: FlowSequenceChildFailure | null
          }): BuiltFlowStepResult => {
            const executionProfile = plannedExecutionProfile(args.plannedStep)
            const transportLane = plannedTransportLane(args.plannedStep)

            const base = {
              index: args.plannedStep.index,
              kind: args.kind as FlowStepResult["kind"],
              summary: args.summary,
              verdict: args.verdict,
              matchedRef: args.matchedRef,
              latestSnapshotId: args.latestSnapshotId,
              retryCount: args.retryCount,
              retryReasons: args.retryReasons,
              artifacts: [] as Array<ArtifactRecord>,
              executionProfile,
              transportLane,
              handledMs: args.handledMs,
              warnings: args.warnings,
            }

            if (!isV2SessionFlow) {
              return base satisfies FlowStepResult
            }

            return {
              ...base,
              kind: args.kind as FlowV2StepResult["kind"],
              executionProfile: executionProfile ?? "verified",
              transportLane: transportLane ?? "host-single",
              checkpoint: args.checkpoint ?? null,
              sequenceChildFailure: args.sequenceChildFailure ?? null,
            } satisfies FlowV2StepResult
          }

          const toFailedStep = (step: BuiltFlowStepResult): BuiltFailedStep => {
            if (!isV2SessionFlow) {
              return {
                index: step.index,
                kind: step.kind as FlowFailedStep["kind"],
                summary: step.summary,
                verdict: step.verdict,
              } satisfies FlowFailedStep
            }

            const stepResult = step as FlowV2StepResult
            return {
              index: stepResult.index,
              kind: stepResult.kind,
              summary: stepResult.summary,
              verdict: stepResult.verdict,
              executionProfile: stepResult.executionProfile,
              transportLane: stepResult.transportLane,
              handledMs: stepResult.handledMs,
              checkpoint: stepResult.checkpoint,
              sequenceChildFailure: stepResult.sequenceChildFailure,
            } satisfies FlowV2FailedStep
          }

          const mergeVerdict = (
            current: SessionFlowResult["verdict"],
            next: SessionFlowResult["verdict"],
          ): SessionFlowResult["verdict"] => {
            if (current === "timed-out" || next === "timed-out") {
              return "timed-out"
            }

            if (current === "failed" || next === "failed") {
              return "failed"
            }

            return "passed"
          }

          const toSessionAction = (step: FlowStep | FlowV2Step): SessionAction => {
            if (isV2SessionFlow && isFlowV2SessionActionStep(step as FlowV2Step)) {
              return flowV2StepToSessionAction(step as Parameters<typeof flowV2StepToSessionAction>[0])
            }

            if (isFlowSessionActionStep(step as FlowStep)) {
              return flowStepToSessionAction(step as Parameters<typeof flowStepToSessionAction>[0])
            }

            throw new Error(`Expected a flow session-action step, received ${(step as { readonly kind: string }).kind}.`)
          }

          const classifyFastFailureCode = (reason: string): "session-action-target-not-found" | "session-action-failed" =>
            /\bnot found\b|\bno element\b|\bmissing\b|\bcould not resolve\b/i.test(reason)
              ? "session-action-target-not-found"
              : "session-action-failed"

          const executeFastSingleStep = (
            step: FlowV2FastSingleStep,
          ) =>
            Effect.gen(function* () {
              if (!isRunnerBackedRecord(record)) {
                return yield* new UnsupportedCapabilityError({
                  code: "session-action-real-device-runner",
                  capability: "session.run.fast",
                  reason: "This session does not currently expose a live runner transport for fast flow actions.",
                  nextStep: "Inspect session health/artifacts, or reopen the session once the runner transport is live.",
                  details: [],
                  wall: false,
                })
              }

              if (!runnerSupportsCapability(record, "uiAction")) {
                return yield* new UnsupportedCapabilityError({
                  code: "session-runner-capability-ui-action",
                  capability: "session.run.fast",
                  reason: "The connected runner does not advertise uiAction support required for fast single-step flow execution.",
                  nextStep: "Open a session against a runner that reports uiAction capability, or switch the flow step back to verified execution.",
                  details: [`runner capabilities: ${describeRunnerCapabilities(record)}`],
                  wall: false,
                })
              }

              const runnerRecord = record

              if (step.kind === "wait") {
                yield* Effect.sleep(step.timeoutMs)
                updateHealthCheck(record, step.kind, true)
                yield* persistHealth(sessionId, record.health)
                yield* syncDaemonMetadata

                return {
                  ok: true as const,
                  result: {
                    summary: `Waited ${step.timeoutMs}ms before continuing.`,
                    action: step.kind,
                    matchedRef: null,
                    resolvedBy: "none",
                    statusLabel: record.snapshotState.latest?.statusLabel ?? null,
                    latestSnapshotId: record.snapshotState.latest?.snapshotId ?? null,
                    artifact: null,
                    recordingLength: record.recording.steps.length,
                    handledMs: null,
                    ...buildActionResultMetadata(emptyRetryAttemptMetadata(), "passed", step.timeoutMs, 1),
                  } satisfies ExtendedSessionActionResult,
                } satisfies ActionExecutionOutcome
              }

              const action = flowV2StepToSessionAction(step)

              if (!isRunnerUiSessionAction(action)) {
                return yield* new EnvironmentError({
                  code: "session-action-invalid",
                  reason: `Fast runner execution only supports tap, press, swipe, type, scroll, and duration waits; received ${step.kind}.`,
                  nextStep: "Use verified execution for unsupported steps, or adjust the flow contract before retrying.",
                  details: [],
                })
              }

              const resolvedBy: SessionActionResult["resolvedBy"] = step.target.kind === "point" ? "point" : "semantic"
              const actionResult = yield* attemptWithRetry({
                policy: action.retryPolicy ?? defaultMutationRetryPolicy,
                run: () =>
                  Effect.gen(function* () {
                    const payload = yield* Effect.try({
                      try: () => buildDirectRunnerUiActionPayload(action, step.target),
                      catch: (error) =>
                        new EnvironmentError({
                          code: "session-action-target-not-found",
                          reason: error instanceof Error ? error.message : String(error),
                          nextStep: "Use a semantic selector, point selector, or ref selector with a semantic fallback for fast runner steps.",
                          details: [],
                        }),
                    })

                    const response = yield* sendRunnerCommand(
                      sessionId,
                      runnerRecord,
                      "uiAction",
                      JSON.stringify(payload),
                    )
                    record.nextSequence += 1

                    if (!response.ok) {
                      const failureReason = response.error
                        ?? response.payload
                        ?? `Runner ${action.kind} failed with status ${response.statusLabel}.`

                      return yield* new EnvironmentError({
                        code: classifyFastFailureCode(failureReason),
                        reason: failureReason,
                        nextStep: withOffscreenNextStep(
                          "Inspect the latest runner log artifacts, refine the direct selector, and retry the fast step.",
                          failureReason,
                        ),
                        details: [],
                      })
                    }

                    return { response }
                  }),
              })

              if (!actionResult.ok) {
                yield* Effect.either(captureSnapshotArtifactInternal(sessionId, record))
                yield* persistActionFailure(sessionId, record, step.kind)

                return {
                  ok: false,
                  error: actionResult.error,
                  retry: actionResult.retry,
                } satisfies ActionExecutionOutcome
              }

              updateHealthCheck(record, step.kind, true)
              yield* persistHealth(sessionId, record.health)
              yield* syncDaemonMetadata

              const summary = step.target.kind === "point"
                ? `Executed fast ${step.kind} at point(${step.target.x}, ${step.target.y}) without host snapshots.`
                : `Executed fast ${step.kind} on ${describeActionSelector(step.target)} without host snapshots.`

              return {
                ok: true,
                result: {
                  summary,
                  action: step.kind,
                  matchedRef: null,
                  resolvedBy,
                  statusLabel: actionResult.value.response.statusLabel,
                  latestSnapshotId: record.snapshotState.latest?.snapshotId ?? null,
                  artifact: null,
                  recordingLength: record.recording.steps.length,
                  handledMs: actionResult.value.response.handledMs,
                  ...buildActionResultMetadata(actionResult.retry),
                } satisfies ExtendedSessionActionResult,
              } satisfies ActionExecutionOutcome
            })

          const executedSteps: Array<BuiltFlowStepResult> = []
          const createdArtifacts: Array<ArtifactRecord> = []
          let failedStep: BuiltFailedStep | null = null
          let overallVerdict: SessionFlowResult["verdict"] = "passed"
          let totalRetries = 0
          let stoppedEarly = false

          for (const plannedStep of plan.steps) {
            const step = plannedStep.step
            const beforeArtifacts = [...record.health.artifacts]
            const continueOnError = step.continueOnError === true
            let stepResult: BuiltFlowStepResult

            if (step.kind === "snapshot") {
              const captured = yield* attemptWithRetry({
                policy: defaultReadOnlyRetryPolicy,
                run: () => captureSnapshotArtifactInternal(sessionId, record),
              })

              if (captured.ok) {
                const snapshotResult = buildSessionSnapshotResult({
                  artifact: captured.value.artifact,
                  artifactRecord: captured.value.artifactRecord,
                  outputMode: step.output ?? "artifact",
                  retry: captured.retry,
                })

                stepResult = buildFlowStepResult({
                  plannedStep,
                  kind: step.kind,
                  summary: snapshotResult.summary,
                  verdict: "passed",
                  matchedRef: null,
                  latestSnapshotId: snapshotResult.snapshotId,
                  retryCount: captured.retry.retryCount,
                  retryReasons: captured.retry.retryReasons,
                  handledMs: captured.value.handledMs,
                  warnings: successWarnings({
                    step,
                    baseWarnings: snapshotResult.warnings,
                  }),
                })
              } else {
                stepResult = buildFlowStepResult({
                  plannedStep,
                  kind: step.kind,
                  summary: captured.error.reason,
                  verdict: failureVerdict(captured.error),
                  matchedRef: null,
                  latestSnapshotId: record.snapshotState.latest?.snapshotId ?? null,
                  retryCount: captured.retry.retryCount,
                  retryReasons: captured.retry.retryReasons,
                  handledMs: null,
                  warnings: failureWarnings({
                    error: captured.error,
                    continued: continueOnError,
                  }),
                })
              }
            } else if (step.kind === "screenshot") {
              const labelStem = sanitizeFileComponent(step.label ?? null, "screenshot")
              const fileStem = `${timestampForFile()}-${labelStem}`
              const captured = yield* attemptWithRetry({
                policy: step.retryPolicy ?? defaultReadOnlyRetryPolicy,
                run: () => captureScreenshotArtifact({
                  sessionId,
                  record,
                  fileStem,
                  artifactKey: `screenshot-${fileStem}`,
                  artifactLabel: step.label ?? "screenshot",
                  summary: `Screenshot captured for session ${sessionId}.`,
                }),
              })

              if (captured.ok) {
                updateHealthCheck(record, step.kind, true)
                stepResult = buildFlowStepResult({
                  plannedStep,
                  kind: step.kind,
                  summary: `Captured screenshot artifact ${captured.value.artifact.absolutePath}.`,
                  verdict: "passed",
                  matchedRef: null,
                  latestSnapshotId: record.snapshotState.latest?.snapshotId ?? null,
                  retryCount: captured.retry.retryCount,
                  retryReasons: captured.retry.retryReasons,
                  handledMs: captured.value.handledMs,
                  warnings: successWarnings({
                    step,
                    baseWarnings: [],
                  }),
                })
              } else {
                updateHealthCheck(record, step.kind, false)
                yield* persistRecordHealth(sessionId, record)
                stepResult = buildFlowStepResult({
                  plannedStep,
                  kind: step.kind,
                  summary: captured.error.reason,
                  verdict: failureVerdict(captured.error),
                  matchedRef: null,
                  latestSnapshotId: record.snapshotState.latest?.snapshotId ?? null,
                  retryCount: captured.retry.retryCount,
                  retryReasons: captured.retry.retryReasons,
                  handledMs: null,
                  warnings: failureWarnings({
                    error: captured.error,
                    continued: continueOnError,
                  }),
                })
              }
            } else if (step.kind === "video") {
              const durationMs = normalizeVideoDurationMs(step.durationMs)
              const fileStem = `${timestampForFile()}-video`
              const captured = yield* Effect.either(captureVideoArtifact({
                sessionId,
                record,
                durationMs,
                fileStem,
                artifactKey: `video-${fileStem}`,
                artifactLabel: "video",
              }))

              if (captured._tag === "Right") {
                updateHealthCheck(record, step.kind, true)
                const modeSummary = describeVideoArtifactLabel(captured.right.mode)
                const clampNote = durationMs !== step.durationMs
                  ? ` Requested duration ${step.durationMs}ms was clamped to ${durationMs}ms.`
                  : ""

                stepResult = buildFlowStepResult({
                  plannedStep,
                  kind: step.kind,
                  summary: `Captured ${modeSummary} at ${captured.right.artifact.absolutePath}.${clampNote}`,
                  verdict: "passed",
                  matchedRef: null,
                  latestSnapshotId: record.snapshotState.latest?.snapshotId ?? null,
                  retryCount: 0,
                  retryReasons: [],
                  handledMs: captured.right.handledMs,
                  warnings: successWarnings({
                    step,
                    baseWarnings: [],
                  }),
                })
              } else {
                updateHealthCheck(record, step.kind, false)
                yield* persistRecordHealth(sessionId, record)
                stepResult = buildFlowStepResult({
                  plannedStep,
                  kind: step.kind,
                  summary: captured.left.reason,
                  verdict: failureVerdict(captured.left),
                  matchedRef: null,
                  latestSnapshotId: record.snapshotState.latest?.snapshotId ?? null,
                  retryCount: 0,
                  retryReasons: [],
                  handledMs: null,
                  warnings: failureWarnings({
                    error: captured.left,
                    continued: continueOnError,
                  }),
                })
              }
            } else if (step.kind === "logMark") {
              const marked = yield* Effect.either(registry.markLog({
                sessionId,
                label: step.label,
              }))

              if (marked._tag === "Right") {
                stepResult = buildFlowStepResult({
                  plannedStep,
                  kind: step.kind,
                  summary: marked.right.summary,
                  verdict: "passed",
                  matchedRef: null,
                  latestSnapshotId: record.snapshotState.latest?.snapshotId ?? null,
                  retryCount: 0,
                  retryReasons: [],
                  handledMs: null,
                  warnings: successWarnings({
                    step,
                    baseWarnings: [],
                  }),
                })
              } else {
                stepResult = buildFlowStepResult({
                  plannedStep,
                  kind: step.kind,
                  summary: errorSummary(marked.left),
                  verdict: failureVerdict(marked.left),
                  matchedRef: null,
                  latestSnapshotId: record.snapshotState.latest?.snapshotId ?? null,
                  retryCount: 0,
                  retryReasons: [],
                  handledMs: null,
                  warnings: failureWarnings({
                    error: marked.left,
                    continued: continueOnError,
                  }),
                })
              }
            } else if (step.kind === "sleep") {
              yield* Effect.sleep(step.durationMs)
              stepResult = buildFlowStepResult({
                plannedStep,
                kind: step.kind,
                summary: `Slept for ${step.durationMs}ms.`,
                verdict: "passed",
                matchedRef: null,
                latestSnapshotId: record.snapshotState.latest?.snapshotId ?? null,
                retryCount: 0,
                retryReasons: [],
                handledMs: null,
                warnings: [],
              })
            } else if (plannedStep.kind === "batch-sequence") {
              const checkpoint = plannedStep.step.checkpoint ?? "none"
              const batchEffect = yield* Effect.either(
                Effect.gen(function* () {
                  if (!isRunnerBackedRecord(record)) {
                    return yield* new UnsupportedCapabilityError({
                      code: "session-action-real-device-runner",
                      capability: "session.run.sequence.batch",
                      reason: "This session does not currently expose a live runner transport for batch sequence flow steps.",
                      nextStep: "Inspect session health/artifacts, or reopen the session once the runner transport is live.",
                      details: [],
                      wall: false,
                    })
                  }

                  if (!runnerSupportsCapability(record, "uiActionBatch")) {
                    return yield* new UnsupportedCapabilityError({
                      code: "session-runner-capability-ui-action-batch",
                      capability: "session.run.sequence.batch",
                      reason: "The connected runner does not advertise uiActionBatch support required for fast sequence execution.",
                      nextStep: "Open a session against a runner that reports uiActionBatch capability, or rewrite the flow as verified single steps.",
                      details: [`runner capabilities: ${describeRunnerCapabilities(record)}`],
                      wall: false,
                    })
                  }

                  const payload = yield* Effect.try({
                    try: () => buildRunnerBatchSequencePayload(plannedStep.step.actions),
                    catch: (error) =>
                      new EnvironmentError({
                        code: "session-action-target-not-found",
                        reason: error instanceof Error ? error.message : String(error),
                        nextStep: "Use semantic selectors, point selectors, or ref selectors with semantic fallbacks for batched sequence actions.",
                        details: [],
                      }),
                  })

                  const response = yield* sendRunnerCommand(
                    sessionId,
                    record,
                    "uiActionBatch",
                    JSON.stringify(payload),
                  )
                  record.nextSequence += 1
                  updateHealthCheck(record, response.action, response.ok)

                  const checkpointCapture = checkpoint === "end"
                    ? yield* Effect.either(captureSnapshotArtifactInternal(sessionId, record))
                    : null

                  if (checkpoint === "none") {
                    yield* persistRecordHealth(sessionId, record)
                  }

                  return {
                    response,
                    checkpointCapture,
                  }
                }),
              )

              if (batchEffect._tag === "Left") {
                stepResult = buildFlowStepResult({
                  plannedStep,
                  kind: plannedStep.step.kind,
                  summary: errorSummary(batchEffect.left),
                  verdict: failureVerdict(batchEffect.left),
                  matchedRef: null,
                  latestSnapshotId: record.snapshotState.latest?.snapshotId ?? null,
                  retryCount: 0,
                  retryReasons: [],
                  handledMs: null,
                  warnings: failureWarnings({
                    error: batchEffect.left,
                    continued: continueOnError,
                  }),
                  checkpoint,
                  sequenceChildFailure: null,
                })
              } else {
                const { response, checkpointCapture } = batchEffect.right
                const checkpointSnapshot = checkpointCapture !== null && checkpointCapture._tag === "Right"
                  ? checkpointCapture.right
                  : null
                const checkpointError = checkpointCapture !== null && checkpointCapture._tag === "Left"
                  ? checkpointCapture.left
                  : null
                const batchHandledMs = response.totalHandledMs ?? response.handledMs
                const latestSnapshotId = checkpointSnapshot?.artifact.snapshotId
                  ?? record.snapshotState.latest?.snapshotId
                  ?? null

                if (!response.ok) {
                  const failureReason = response.error
                    ?? response.payload
                    ?? `Runner batch sequence failed with status ${response.statusLabel}.`
                  const sequenceChildFailure = buildBatchSequenceChildFailure({
                    step: plannedStep.step,
                    response,
                    failureReason,
                  })
                  const batchFailure = new EnvironmentError({
                    code: classifyFastFailureCode(failureReason),
                    reason: failureReason,
                    nextStep: withOffscreenNextStep(
                      "Inspect the latest runner log artifacts, refine the direct selectors, and retry the batch sequence step.",
                      failureReason,
                    ),
                    details: [],
                  })
                  const warnings = failureWarnings({
                    error: batchFailure,
                    continued: continueOnError,
                  })

                  if (checkpointError) {
                    warnings.push(
                      `Requested end checkpoint failed after the batch error: ${checkpointError.reason}`,
                      ...("details" in checkpointError && Array.isArray(checkpointError.details) ? checkpointError.details : []),
                    )
                  }

                  stepResult = buildFlowStepResult({
                    plannedStep,
                    kind: plannedStep.step.kind,
                    summary: sequenceChildFailure
                      ? `Sequence child ${sequenceChildFailure.index} (${sequenceChildFailure.kind}) failed in runner batch lane: ${sequenceChildFailure.summary}`
                      : failureReason,
                    verdict: failureVerdict(batchFailure),
                    matchedRef: null,
                    latestSnapshotId,
                    retryCount: 0,
                    retryReasons: [],
                    handledMs: batchHandledMs,
                    warnings: dedupeStrings(warnings),
                    checkpoint,
                    sequenceChildFailure,
                  })
                } else if (checkpointError) {
                  stepResult = buildFlowStepResult({
                    plannedStep,
                    kind: plannedStep.step.kind,
                    summary: `Batch sequence executed, but the requested end checkpoint failed: ${checkpointError.reason}`,
                    verdict: failureVerdict(checkpointError),
                    matchedRef: null,
                    latestSnapshotId,
                    retryCount: 0,
                    retryReasons: [],
                    handledMs: batchHandledMs,
                    warnings: failureWarnings({
                      error: checkpointError,
                      continued: continueOnError,
                    }),
                    checkpoint,
                    sequenceChildFailure: null,
                  })
                } else {
                  stepResult = buildFlowStepResult({
                    plannedStep,
                    kind: plannedStep.step.kind,
                    summary: checkpoint === "end"
                      ? `Executed fast sequence step with ${plannedStep.step.actions.length} child action(s) through the runner batch lane; captured ${latestSnapshotId}.`
                      : `Executed fast sequence step with ${plannedStep.step.actions.length} child action(s) through the runner batch lane without host checkpoints.`,
                    verdict: "passed",
                    matchedRef: null,
                    latestSnapshotId,
                    retryCount: 0,
                    retryReasons: [],
                    handledMs: batchHandledMs,
                    warnings: successWarnings({
                      step,
                      baseWarnings: [],
                    }),
                    checkpoint,
                    sequenceChildFailure: null,
                  })
                }
              }
            } else {
              const actionEffect = plannedStep.kind === "fast-single"
                ? yield* Effect.either(executeFastSingleStep(plannedStep.step as FlowV2FastSingleStep))
                : yield* Effect.either(executeSessionAction({
                    sessionId,
                    action: toSessionAction(step),
                    recordAction: false,
                  }))

              if (actionEffect._tag === "Left") {
                stepResult = buildFlowStepResult({
                  plannedStep,
                  kind: step.kind,
                  summary: errorSummary(actionEffect.left),
                  verdict: failureVerdict(actionEffect.left),
                  matchedRef: null,
                  latestSnapshotId: record.snapshotState.latest?.snapshotId ?? null,
                  retryCount: 0,
                  retryReasons: [],
                  handledMs: null,
                  warnings: failureWarnings({
                    error: actionEffect.left,
                    continued: continueOnError,
                  }),
                })
              } else if (!actionEffect.right.ok) {
                stepResult = buildFlowStepResult({
                  plannedStep,
                  kind: step.kind,
                  summary: actionEffect.right.error.reason,
                  verdict: failureVerdict(actionEffect.right.error),
                  matchedRef: null,
                  latestSnapshotId: record.snapshotState.latest?.snapshotId ?? null,
                  retryCount: actionEffect.right.retry.retryCount,
                  retryReasons: actionEffect.right.retry.retryReasons,
                  handledMs: null,
                  warnings: failureWarnings({
                    error: actionEffect.right.error,
                    continued: continueOnError,
                  }),
                })
              } else {
                const actionResult = actionEffect.right.result
                stepResult = buildFlowStepResult({
                  plannedStep,
                  kind: step.kind,
                  summary: actionResult.summary,
                  verdict: actionResult.verdict ?? "passed",
                  matchedRef: actionResult.matchedRef,
                  latestSnapshotId: actionResult.latestSnapshotId,
                  retryCount: actionResult.retryCount,
                  retryReasons: actionResult.retryReasons,
                  handledMs: actionResult.handledMs ?? null,
                  warnings: successWarnings({
                    step,
                    baseWarnings: [],
                    resolvedBy: actionResult.resolvedBy,
                  }),
                })
              }
            }

            yield* refreshSessionArtifacts(sessionId, record)

            const artifacts = diffArtifacts(beforeArtifacts, record.health.artifacts)
            stepResult = { ...stepResult, artifacts } as BuiltFlowStepResult

            executedSteps.push(stepResult)
            createdArtifacts.push(...artifacts)
            totalRetries += stepResult.retryCount

            if (stepResult.verdict !== "passed") {
              overallVerdict = mergeVerdict(overallVerdict, stepResult.verdict)
              failedStep = toFailedStep(stepResult)

              if (!continueOnError) {
                stoppedEarly = true
                break
              }
            }
          }

          const dedupedArtifacts = createdArtifacts.filter((artifact, index, all) =>
            all.findIndex((candidate) => candidate.key === artifact.key) === index,
          )
          const overallWarnings = dedupeStrings(executedSteps.flatMap((step) => step.warnings))
          const failedStepCount = executedSteps.filter((step) => step.verdict !== "passed").length
          const summary = failedStep === null
            ? `Executed ${executedSteps.length} flow step(s) successfully with ${totalRetries} retr${totalRetries === 1 ? "y" : "ies"}.`
            : stoppedEarly
              ? `Flow ${overallVerdict === "timed-out" ? "timed out" : "failed"} at step ${failedStep.index} after ${executedSteps.length} executed step(s) and ${totalRetries} retr${totalRetries === 1 ? "y" : "ies"}.`
              : `Executed ${executedSteps.length} flow step(s) with ${failedStepCount} failed step(s), continuing past failures where continueOnError was enabled.`

          if (isV2SessionFlow) {
            return {
              contract: "probe.session-flow/report-v2",
              executedAt: nowIso(),
              sessionId,
              summary,
              verdict: overallVerdict,
              executedSteps: executedSteps as Array<FlowV2StepResult>,
              failedStep: failedStep as FlowV2FailedStep | null,
              retries: totalRetries,
              artifacts: dedupedArtifacts,
              finalSnapshotId: record.snapshotState.latest?.snapshotId ?? null,
              warnings: overallWarnings,
            } satisfies FlowV2Result
          }

          return {
            contract: "probe.session-flow/report-v1",
            executedAt: nowIso(),
            sessionId,
            summary,
            verdict: overallVerdict,
            executedSteps: executedSteps as Array<FlowStepResult>,
            failedStep: failedStep as FlowFailedStep | null,
            retries: totalRetries,
            artifacts: dedupedArtifacts,
            finalSnapshotId: record.snapshotState.latest?.snapshotId ?? null,
            warnings: overallWarnings,
          } satisfies FlowResult
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
            let lastResolvedBy: ReplayStepReport["resolvedBy"] = "none"
            let lastMatchedRef: string | null = null

            while (attempt < defaultReplayAttemptLimit && !succeeded) {
              attempt += 1
              lastResolvedBy = "none"
              lastMatchedRef = null

              if (step.kind === "screenshot") {
                const fileStem = `step-${String(index + 1).padStart(3, "0")}-screenshot`
                const capture = yield* Effect.either(captureScreenshotArtifact({
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

                reports.push(buildReplayStepReport({
                  index: index + 1,
                  kind: step.kind,
                  attempts: attempt,
                  resolvedBy: "none",
                  matchedRef: null,
                  artifact: capture.right.artifact,
                  summary: `Captured replay screenshot artifact ${capture.right.artifact.absolutePath}.`,
                }))
                succeeded = true
                continue
              }

              if (step.kind === "video") {
                const durationMs = normalizeVideoDurationMs(step.durationMs)
                const fileStem = `step-${String(index + 1).padStart(3, "0")}-video`
                const capture = yield* Effect.either(captureVideoArtifact({
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

                const modeSummary = describeVideoArtifactLabel(capture.right.mode, { includeArtifact: false })
                const clampNote = durationMs !== step.durationMs
                  ? ` Requested duration ${step.durationMs}ms was clamped to ${durationMs}ms.`
                  : ""

                reports.push(buildReplayStepReport({
                  index: index + 1,
                  kind: step.kind,
                  attempts: attempt,
                  resolvedBy: "none",
                  matchedRef: null,
                  artifact: capture.right.artifact,
                  summary: `Captured replay ${modeSummary} artifact ${capture.right.artifact.absolutePath}.${clampNote}`,
                }))
                succeeded = true
                continue
              }

              if (step.kind === "wait") {
                lastFailure = "Wait replay steps are not supported in replay yet. Re-run the wait before replay, or remove it from the recording."
                continue
              }

              const recordedTarget = step.target

              const preSnapshot = step.kind === "assert" || !(recordedTarget.preferredRef === null && recordedTarget.fallback?.kind === "point")
                ? yield* captureSnapshotArtifactInternal(sessionId, record)
                : null

              if (preSnapshot !== null) {
                finalSnapshotId = preSnapshot.artifact.snapshotId
              }

              const resolution = resolveRecordedActionTargetInSnapshot(preSnapshot?.artifact ?? null, recordedTarget)

              if (step.kind === "assert") {
                const evaluation = evaluateAssertion(resolution, step.expectation)
                lastResolvedBy = evaluation.resolvedBy
                lastMatchedRef = evaluation.matchedRef

                if (!evaluation.ok) {
                  lastFailure = evaluation.summary
                  continue
                }

                if (attempt > 1) {
                  retriedStepCount += 1
                }

                if (evaluation.resolvedBy === "semantic" && recordedTarget.preferredRef !== null) {
                  semanticFallbackCount += 1
                }

                const summary = evaluation.resolvedBy === "semantic" && recordedTarget.preferredRef !== null && resolution.target?.kind === "snapshot"
                  ? `Assertion passed for ${describeSnapshotNode(resolution.target.node)} (${resolution.target.ref}) after semantic selector-drift recovery.`
                  : evaluation.summary

                reports.push(buildReplayStepReport({
                  index: index + 1,
                  kind: step.kind,
                  attempts: attempt,
                  resolvedBy: evaluation.resolvedBy,
                  matchedRef: evaluation.matchedRef,
                  artifact: null,
                  summary,
                }))
                succeeded = true
                continue
              }

              if (!isRunnerUiRecordedSessionAction(step)) {
                lastFailure = "Unsupported replay step kind."
                continue
              }

              if (resolution.outcome !== "matched") {
                lastFailure = resolution.reason
                continue
              }

              const resolvedTarget = resolution.target!
              lastResolvedBy = resolvedTarget.resolvedBy
              lastMatchedRef = resolvedTarget.kind === "snapshot" ? resolvedTarget.ref : null

              if (resolvedTarget.kind === "absence") {
                lastFailure = "Absence selectors can only be used with assert replay steps."
                continue
              }

              const response = yield* sendRunnerCommand(
                sessionId,
                record,
                "uiAction",
                JSON.stringify(
                  buildRunnerUiActionPayload(
                    step,
                    resolvedTarget,
                    preSnapshot?.artifact ?? null,
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

              if (resolvedTarget.resolvedBy === "semantic" && recordedTarget.preferredRef !== null) {
                semanticFallbackCount += 1
              }

              const summary = resolvedTarget.kind === "snapshot"
                ? resolvedTarget.resolvedBy === "semantic" && recordedTarget.preferredRef !== null
                  ? `Executed ${step.kind} on ${describeRecordedActionTarget(recordedTarget)} after semantic selector-drift recovery; captured ${postSnapshot.artifact.snapshotId}.`
                  : `Executed ${step.kind} on ${describeRecordedActionTarget(recordedTarget)}; captured ${postSnapshot.artifact.snapshotId}.`
                : `Executed ${step.kind} at point(${resolvedTarget.x}, ${resolvedTarget.y}) in interaction-root coordinates; captured ${postSnapshot.artifact.snapshotId}.`

                reports.push(buildReplayStepReport({
                  index: index + 1,
                  kind: step.kind,
                  attempts: attempt,
                  resolvedBy: resolvedTarget.resolvedBy,
                  matchedRef: resolvedTarget.kind === "snapshot" ? resolvedTarget.ref : null,
                  artifact: null,
                  summary,
                }))
                succeeded = true
            }

            if (!succeeded) {
              const failedStepReport = buildReplayStepReport({
                index: index + 1,
                kind: step.kind,
                attempts: attempt,
                resolvedBy: lastResolvedBy,
                matchedRef: lastMatchedRef,
                artifact: null,
                summary: lastFailure,
                exhausted: true,
              })
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
                  reason: failedStepReport.summary,
                },
                steps: [...reports, failedStepReport],
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

          const labelStem = sanitizeFileComponent(label, "screenshot")
          const fileStem = `${timestampForFile()}-${labelStem}`
          const capture = yield* Effect.either(runWithRetry({
            policy: defaultReadOnlyRetryPolicy,
            run: () => captureScreenshotArtifact({
              sessionId,
              record,
              fileStem,
              artifactKey: `screenshot-${fileStem}`,
              artifactLabel: label ?? "screenshot",
              summary: `Screenshot captured for session ${sessionId}.`,
            }),
          }) as Effect.Effect<
            { readonly value: { readonly artifact: ArtifactRecord; readonly statusLabel: string | null }; readonly retry: RetryAttemptMetadata },
            UnsupportedCapabilityError | EnvironmentError | ChildProcessError
          >)

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
              ? `Screenshot captured inline at ${capture.right.value.artifact.absolutePath}.`
              : `Screenshot captured and returned as an artifact because ${describeScreenshotOffloadReason(outputMode)}.`,
            artifact: capture.right.value.artifact,
            retryCount: capture.right.retry.retryCount,
            retryReasons: capture.right.retry.retryReasons,
          } satisfies SessionScreenshotResult
        }),
      recordVideo: ({ sessionId, duration }) =>
        Effect.gen(function* () {
          const record = yield* requireSessionRecord(sessionId)

          yield* assertRunnerActionsAvailable(record)

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
          const capture = yield* Effect.either(captureVideoArtifact({
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

          const modeSummary = describeVideoArtifactLabel(capture.right.mode)
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

    return registry
  }),
)
