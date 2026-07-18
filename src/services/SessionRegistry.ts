import { randomUUID } from "node:crypto"
import { statSync } from "node:fs"
import { access, appendFile, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises"
import { basename, dirname, join, relative } from "node:path"
import { Context, Deferred, Duration, Effect, Either, FiberRef, Layer, Ref } from "effect"
import { runAppleProcess } from "./AppleProcessSupervisor"
import {
  buildRecordedSessionAction,
  buildDirectRunnerUiActionPayload,
  buildRunnerUiActionPayload,
  describeActionSelector,
  describeRecordedActionTarget,
  describeSnapshotNode,
  evaluateAssertion,
  isRunnerUiSessionAction,
  isRunnerUiRecordedSessionAction,
  resolveActionSelectorInSnapshot,
  resolveRecordedActionTargetInSnapshot,
  validateSessionAction,
  type ActionRecordingScript,
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
  buildEvidenceReport,
  defaultMutationEvidencePolicy,
  emptyEvidenceReport,
  planSuccessEvidence,
  resolveEvidencePolicy,
  shouldCaptureFailureEvidence,
  type EvidenceCapture,
  type EvidenceCaptureReason,
  type EvidenceReport,
} from "../domain/evidence"
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
  isLiveRunnerDetails,
  SessionHealth,
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
import { RunnerTransportError } from "./RunnerTransportClient"
import {
  makeSessionController,
  type SessionCloseReason,
  type SessionController,
  type SessionControllerContext,
} from "./SessionController"
import { advertisedRunnerCapabilities, requireRunnerCapability } from "./runnerCapabilities"
import { SimulatorHarness, type OpenedSimulatorSession, type RunnerCommandResult } from "./SimulatorHarness"
import type { RunnerAction } from "./runnerProtocol"
import {
  defaultVideoCaptureFps,
  describeRunnerFrameSequenceFallback,
  describeRunnerMp4Artifact,
  describeSimulatorMovFallback,
  describeSimulatorMp4Remux,
  formatFpsLabel,
  normalizeVideoDurationMs,
  parseRationalNumber,
  resolveFfmpegExecutable,
  resolveFfprobeExecutable,
} from "./VideoCapturePolicy"
// PRB-073: runFlow's execution lanes, extracted into named executors — see
// src/services/flow/*.
import { executeBatchActionStep, buildBatchStepResult } from "./flow/batchActionExecutor"
import { executeDirectRunnerActionStep } from "./flow/directRunnerActionExecutor"
import {
  captureScreenshotEvidenceStep,
  captureSnapshotEvidenceStep,
  captureVideoEvidenceStep,
  markLogEvidenceStep,
} from "./flow/evidenceCaptureExecutor"
import type { FlowExecutorDeps } from "./flow/flowExecutorDeps"
import {
  assembleFlowResult,
  buildActionOutcomeStepResult,
  buildFlowStepResult,
  diffArtifacts,
  foldFlowStepOutcome,
} from "./flow/flowStepResultAssembly"
import { executeVerifiedActionStep } from "./flow/verifiedActionExecutor"

const defaultSessionTtlMs = Number(process.env.PROBE_SESSION_TTL_MS ?? 15 * 60 * 1000)
const ttlSweepIntervalMs = Number(process.env.PROBE_SESSION_SWEEP_INTERVAL_MS ?? 10_000)
// PRB-083: bounded operation queue per SessionController. Comfortably above
// any realistic in-flight command burst (batched UI actions, retries) so
// legitimate traffic never trips queue saturation; a caller issuing more
// than this many concurrent commands against one session gets a typed
// session-busy error instead of unbounded memory growth.
const sessionControllerQueueCapacity = Number(process.env.PROBE_SESSION_QUEUE_CAPACITY ?? 512)
const maxSessionLogCaptureSeconds = 30
const defaultDebugCommandTimeoutMs = Number(process.env.PROBE_LLDB_COMMAND_TIMEOUT_MS ?? 60_000)
const maxDebugFrameLimit = 200
const maxDebugEvalTimeoutMs = 30_000
const defaultReplayAttemptLimit = Number(process.env.PROBE_REPLAY_ATTEMPTS ?? 3)
const defaultVideoDurationMs = 10_000
const tarExecutable = process.env.PROBE_TAR_PATH ?? "/usr/bin/tar"
export const selectorDriftContractWarning = "Selector drift recovery only helps while the semantic fallback stays unique on the runner; duplicate weak targets still need stronger accessibility identifiers or labels."
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

// PRB-073: exported so the flow executors (src/services/flow/*) can type
// their evidence-capture deps without re-declaring the mode union.
export type VideoArtifactMode = "mp4" | "mov" | "frame-sequence"

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

// Exported for direct process-level test coverage of the AppleProcessSupervisor
// migration (PRB-085), in addition to its normal SessionRegistry service usage.
export const runHostCommand = (args: {
  readonly command: string
  readonly commandArgs: ReadonlyArray<string>
  readonly cwd?: string
  readonly timeoutMs?: number
}): Promise<HostCommandResult> => {
  let spawnError: unknown = null

  return runAppleProcess({
    command: args.command,
    commandArgs: args.commandArgs,
    cwd: args.cwd,
    timeoutMs: args.timeoutMs ?? 30_000,
    gracePeriodMs: 2_000,
    // Preserve the original behavior of rejecting with the raw spawn error
    // (not a ChildProcessError) so ENOENT-based optional-tool detection
    // (ffmpeg/ffprobe/tar availability) keeps working unchanged.
    onSpawnError: (error) => {
      spawnError = error
    },
  }).then(
    (result): HostCommandResult => ({
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
      signal: result.signal,
      timedOut: result.timedOut,
    }),
    (error): HostCommandResult => {
      throw spawnError ?? error
    },
  )
}

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

export const timestampForFile = (): string => new Date().toISOString().replace(/[:.]/g, "-")

export const sanitizeFileComponent = (value: string | null | undefined, fallback: string): string => {
  const sanitized = (value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")

  return sanitized.length > 0 ? sanitized : fallback
}

export const describeVideoArtifactLabel = (mode: VideoArtifactMode, options?: { readonly includeArtifact?: boolean }): string => {
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

export const withOffscreenNextStep = (base: string, reason: string): string =>
  isHittabilityFailure(reason)
    ? `${base} If the target is offscreen, add an explicit scroll step first; Probe does not auto-scroll until the element becomes hittable.`
    : base

const buildReplayWarnings = (semanticFallbackCount: number): ReadonlyArray<string> => [
  semanticFallbackCount > 0
    ? `${semanticFallbackCount} replay steps recovered selector drift via semantic fallback. ${selectorDriftContractWarning}`
    : selectorDriftContractWarning,
  offscreenHittabilityWarning,
]

export const dedupeStrings = (values: ReadonlyArray<string>): Array<string> => [...new Set(values)]

export const defaultReadOnlyRetryPolicy: RetryPolicy = {
  maxAttempts: 3,
  backoffMs: 250,
  refreshSnapshotBetweenAttempts: true,
  retryOn: ["not-found", "not-hittable", "runner-timeout", "transient-transport", "assertion-failed"],
}

export const defaultMutationRetryPolicy: RetryPolicy = {
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

export type SessionActionError =
  | SessionNotFoundError
  | UserInputError
  | UnsupportedCapabilityError
  | EnvironmentError
  | ChildProcessError

export interface RetryAttemptMetadata {
  readonly retryCount: number
  readonly retryReasons: Array<string>
}

// PRB-093: named separately (not `typeof lastSnapshot`) to sidestep a real
// TS inference cycle when a `let`-declared snapshot cache is read into a
// same-named `const` inside the loop that reassigns it -- see the wait-poll
// loop in executeSessionAction.
interface WaitPollSnapshot {
  readonly artifact: StoredSnapshotArtifact
  readonly artifactRecord: ArtifactRecord
  readonly handledMs: number
}

export type ExtendedSessionActionResult = SessionActionResult & {
  readonly handledMs?: number | null
  // PRB-091: `handledMs` broken into the runner's uiAction phases —
  // resolution/wait/interaction — plus generic response finalization.
  // Populated by the fast direct-runner-action lane (the one lane whose
  // response comes straight from a `uiAction` command); `null`/absent
  // everywhere else, matching `RunnerCommandResult`'s same fields.
  readonly resolutionMs?: number | null
  readonly waitMs?: number | null
  readonly interactionMs?: number | null
  readonly finalizationMs?: number | null
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

export type ActionExecutionOutcome =
  | {
      readonly ok: true
      readonly result: ExtendedSessionActionResult
    }
  | {
      readonly ok: false
      readonly error: SessionActionError
      readonly retry: RetryAttemptMetadata
      // PRB-093: every outcome reports its evidence, failure included -- a
      // best-effort failure snapshot is real capture work and must not be
      // silently discarded just because the mutation itself failed. See
      // evidence.ts's module doc: failure evidence never replaces or masks
      // the original failure, it only rides alongside it.
      readonly evidence: EvidenceReport
    }

export const emptyRetryAttemptMetadata = (): RetryAttemptMetadata => ({
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

export const attemptWithRetry = <T, E extends SessionActionError>(args: {
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
  readonly evidence: EvidenceReport
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
    evidence: args.evidence,
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

export interface BaseActiveSessionRecord {
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
  // PRB-083: the controller is the sole writer of `health` (reassigned as a
  // whole object, never mutated in place) and the sole allocator of runner
  // command sequence numbers. Every other field above stays a plain mutable
  // property because nothing outside the controller's serialized execution
  // ever writes it concurrently; see SessionController.ts for the invariant
  // this buys.
  readonly controller: SessionController
}

export interface SimulatorActiveSessionRecord extends BaseActiveSessionRecord {
  kind: "simulator"
  readonly sendRunnerCommand: (
    sequence: number,
    action: RunnerAction,
    payload?: string,
  ) => Promise<RunnerCommandResult>
  /** PRB-089: this runner process's epoch, for indeterminate-outcome diagnostics. */
  readonly runnerEpoch: string
  readonly closeResources: () => Promise<void>
  readonly isRunnerRunning: () => boolean
  readonly waitForExit: Promise<{ readonly code: number | null; readonly signal: string | null }>
}

export interface RealDeviceActiveSessionRecord extends BaseActiveSessionRecord {
  kind: "device"
  integrationPoints: ReadonlyArray<string>
  readonly sendRunnerCommand: ((
    sequence: number,
    action: RunnerAction,
    payload?: string,
  ) => Promise<RunnerCommandResult>) | null
  /** PRB-089: this runner process's epoch, for indeterminate-outcome diagnostics. Null until a live runner has opened. */
  readonly runnerEpoch: string | null
  readonly refreshConnection: () => Promise<SessionConnectionDetails>
  readonly closeResources: () => Promise<void>
  readonly isRunnerRunning: () => boolean
  readonly waitForExit: Promise<{ readonly code: number | null; readonly signal: string | null }> | null
}

export type ActiveSessionRecord = SimulatorActiveSessionRecord | RealDeviceActiveSessionRecord
export type RunnerBackedActiveSessionRecord = SimulatorActiveSessionRecord | (RealDeviceActiveSessionRecord & {
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

export const isSimulatorRecord = (record: ActiveSessionRecord): record is SimulatorActiveSessionRecord =>
  record.kind === "simulator"

const isRealDeviceRecord = (record: ActiveSessionRecord): record is RealDeviceActiveSessionRecord =>
  record.kind === "device"

export const isRunnerBackedRecord = (record: ActiveSessionRecord): record is RunnerBackedActiveSessionRecord =>
  isSimulatorRecord(record) || record.sendRunnerCommand !== null

// PRB-096: the target-process lease surface. `resources.trace` (already part
// of the frozen `SessionResourceStates` contract in domain/session.ts) is the
// independent trace lane ARCHITECTURE.md describes ("xctrace recorder ...
// SessionRegistry with PerfService helpers"). These types are the seam
// PerfService's raw record path uses instead of `getSessionHealth` — no
// runner ping, no `wrapperRunning`/`ready|degraded` gate, just the device,
// bundle, live target pid, and artifact root a raw capture actually needs.
export interface TraceTargetSnapshot {
  readonly sessionId: string
  readonly platform: "simulator" | "device"
  readonly deviceId: string
  readonly deviceName: string
  readonly bundleId: string
  readonly targetProcessId: number
  readonly artifactRoot: string
}

export interface TraceLeaseHandle {
  readonly target: TraceTargetSnapshot
  /**
   * Aborts when the owning session starts closing (explicit close, TTL
   * expiry, runner exit, or daemon shutdown) — combine with a caller's own
   * per-attempt signal via `AbortSignal.any([signal, lease.signal])` so a
   * session close interrupts an in-flight raw capture through the same
   * `AppleProcessSupervisor` TERM -> grace -> KILL ladder every other owned
   * child process already uses, instead of orphaning it.
   */
  readonly signal: AbortSignal
}

export type TraceLeaseOutcome =
  | { readonly kind: "stopped" }
  | { readonly kind: "degraded"; readonly detail: string }
  | { readonly kind: "failed"; readonly detail: string }

// PRB-073: hoisted out of `SessionRegistryLive`'s Effect.gen body — this has
// no dependency on any layer-scoped service (ArtifactStore, harnesses, …),
// only on the module-level `nowIso`/`expiresAtIso`/`deriveSessionPhase`
// helpers above, so it is safe as a plain top-level function. Exported so
// the flow executors (src/services/flow/*) can call it as an explicit
// dependency without closing over `SessionRegistryLive`'s internals.
export const updateHealthCheck = (record: ActiveSessionRecord, command: string, ok: boolean) => {
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

// PRB-073: hoisted alongside `updateHealthCheck` for the same reason — pure,
// no layer-scoped dependency.
export const buildActionResultMetadata = (
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

export class SessionRegistry extends Context.Tag("@probe/SessionRegistry")<
  SessionRegistry,
  {
    readonly getSessionTtlMs: () => number
    readonly getActiveSessionCount: () => Effect.Effect<number>
    readonly listActiveSessions: () => Effect.Effect<ReadonlyArray<SessionListEntry>>
    readonly openDeviceSession: (params: {
      readonly bundleId: string
      readonly deviceId: string | null
      readonly signingTeamId: string | null
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
    /**
     * PRB-096: a passive, non-mutating read of the session's last-known
     * health snapshot. Unlike `getSessionHealth`, this never pings the
     * runner, never mutates `record.health`, and never persists — it is the
     * "no runner ping side effect" seam PerfService's raw record path uses
     * to report a best-effort `session` outcome without coupling the raw
     * capture to XCUITest runner liveness.
     */
    readonly peekSessionHealth: (sessionId: string) => Effect.Effect<SessionHealth, SessionNotFoundError>
    /**
     * PRB-096: acquires the target-process lease a raw perf capture needs —
     * device, live target pid, bundle, and artifact root — gated only on a
     * live runner-backed record having ever attached (so the pid is known)
     * and the device connection's last-known status, never on
     * `wrapperRunning`/`ready|degraded` XCUITest runner health. Sets
     * `resources.trace` to "starting" and fails if another trace lease is
     * already active for this session (Probe records at most one trace per
     * session at a time).
     */
    readonly beginTraceLease: (sessionId: string) => Effect.Effect<
      TraceLeaseHandle,
      SessionNotFoundError | EnvironmentError | UnsupportedCapabilityError
    >
    /**
     * PRB-096: releases a lease acquired via `beginTraceLease`, moving
     * `resources.trace` to its terminal state ("stopped"/"degraded"/"failed")
     * independently of `resources.runner` — a profiler failure never
     * corrupts the UI/runner lane. Also resolves the join point
     * `closeSessionInternal` awaits after aborting `lease.signal`, so a
     * concurrent session close can never hang forever on an orphaned trace.
     * Idempotent and safe to call after the owning session has fully closed.
     */
    readonly endTraceLease: (sessionId: string, outcome: TraceLeaseOutcome) => Effect.Effect<void>
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
    // PRB-083 gate 10: `closeSessionInternal` removes a session from
    // `sessionsRef` once it is fully closed (so it stops counting as
    // active and stops showing up in listings), but a *repeat* close call
    // for that same session id must still return the already-closed result
    // rather than SessionNotFoundError. This small side-table is what makes
    // that possible: it keeps just the closed record's controller (already
    // memoized/terminal) reachable by session id after removal from the
    // main table.
    const closedRecordsRef = yield* Ref.make(new Map<string, ActiveSessionRecord>())
    const openingRef = yield* Ref.make<OpeningSessionReservation | null>(null)
    const openMutex = yield* Effect.makeSemaphore(1)
    // PRB-096: at most one active target-process (trace) lease per session —
    // the `AbortController` is what `closeSessionInternal` aborts to
    // interrupt an in-flight raw capture through the owned
    // `AppleProcessSupervisor` child, and `settled` is the join point it
    // awaits (bounded) so a raw capture can never orphan a session close.
    const activeTraceLeasesRef = yield* Ref.make(
      new Map<string, { readonly controller: AbortController; readonly settled: Deferred.Deferred<void> }>(),
    )
    // Resource states in which a trace lease is doing real work — the TTL
    // sweeper must never expire a session while one of these holds, even
    // though PRB-096 stops the raw capture path from sending runner
    // keepalives ("Active target/trace lease prevents TTL cleanup without
    // runner keepalives").
    const activeTraceLeaseStates = new Set<SessionResourceState>(["starting", "ready", "stopping"])

    // PRB-083: the ambient handle for "we are currently executing inside
    // this session's controller fiber". Every top-level entry point that
    // mutates health or allocates a runner command sequence number wraps
    // its body with `withControllerContext`; everything nested underneath
    // (sendRunnerCommand, snapshot capture, etc.) recovers the same context
    // via `requireControllerContext` instead of threading it through every
    // call signature. It is a FiberRef, not a plain module variable,
    // because each session's controller fiber runs its own submitted
    // operation with its own context value, and operations for different
    // sessions (or concurrent operations serialized one after another on
    // the same session) must never see each other's allocator.
    const controllerContextRef = yield* FiberRef.make<SessionControllerContext | null>(null)

    const requireControllerContext = (sessionId: string) =>
      Effect.gen(function* () {
        const ctx = yield* FiberRef.get(controllerContextRef)

        if (ctx === null) {
          return yield* new EnvironmentError({
            code: "session-controller-context-missing",
            reason:
              `Internal error: a runner dispatch for session ${sessionId} ran outside its SessionController's `
              + "exclusive execution.",
            nextStep: "This indicates a Probe defect. File a bug with the session id and command attempted.",
            details: [],
          })
        }

        return ctx
      })

    const withControllerContext = <A, E>(ctx: SessionControllerContext, effect: Effect.Effect<A, E>) =>
      effect.pipe(Effect.locally(controllerContextRef, ctx))

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

    // PRB-083 gate 5/6: a transport failure against a wrapper that is still
    // running is ambiguous, not proof the runner died — `RunnerTransportError`
    // already carries that fact (`ambiguous`, populated for timeouts and
    // decode failures; false for a dispatch that never reached the runner,
    // e.g. connection refused). `waitForFreshJson`'s stdout-transport
    // fallback signals the same ambiguity as `ChildProcessError` with code
    // "runner-timeout". Treat either as recoverable ("degraded") exactly
    // when the wrapper process itself is still alive; everything else is a
    // hard failure.
    const isAmbiguousTransportFailure = (error: unknown): boolean => {
      if (error instanceof RunnerTransportError) {
        return error.ambiguous
      }

      return error instanceof ChildProcessError && error.code === "runner-timeout"
    }

    const classifyRunnerDispatchFailure = (args: {
      readonly error: unknown
      readonly wrapperRunning: boolean
    }): "degraded" | "failed" =>
      args.wrapperRunning && isAmbiguousTransportFailure(args.error) ? "degraded" : "failed"

    const markSessionRunnerFailed = (args: {
      readonly sessionId: string
      readonly record: ActiveSessionRecord
      readonly lastCommand: string
      readonly reason: string
      readonly wrapperRunning: boolean
      readonly pingRttMs?: number | null
      /** "degraded": ambiguous/transient, wrapper still live — recoverable by a later successful same-controller ping.
       *  "failed" (default): hard failure — Probe's fail-closed policy applies (`nonRecoverableSessionWarning`). */
      readonly severity?: "degraded" | "failed"
    }) =>
      Effect.gen(function* () {
        if (args.record.health.state === "closing" || args.record.health.state === "closed") {
          return
        }

        const severity = args.severity ?? "failed"
        const liveRunner = severity === "degraded"

        const capabilities = isRealDeviceRecord(args.record)
          ? [...buildRealDeviceCapabilities({
              connection: args.record.health.connection,
              integrationPoints: args.record.integrationPoints,
              liveRunner,
            })]
          : args.record.health.capabilities

        const nextHealthBase: SessionHealth = {
          ...args.record.health,
          updatedAt: nowIso(),
          expiresAt: expiresAtIso(),
          resources: setRunnerResourceState(args.record.health.resources, severity),
          capabilities,
          healthCheck: {
            ...args.record.health.healthCheck,
            checkedAt: nowIso(),
            wrapperRunning: args.wrapperRunning,
            pingRttMs: args.pingRttMs ?? null,
            lastCommand: args.lastCommand,
            // "degraded" is deliberately indeterminate (`null`), not `false`:
            // the transport attempt was ambiguous, so Probe does not know
            // whether the runner executed the command.
            lastOk: severity === "degraded" ? null : false,
          },
          warnings: dedupeStrings([
            ...args.record.health.warnings,
            severity === "degraded"
              ? `${args.reason} The runner wrapper is still running; Probe marked the session degraded rather than failed and will recover automatically on the next successful ping.`
              : `${args.reason} ${nonRecoverableSessionWarning}`,
          ]),
          artifacts: [...(yield* refreshArtifacts(args.sessionId))],
        }

        args.record.health = {
          ...nextHealthBase,
          state: severity === "degraded" ? deriveSessionPhase(nextHealthBase) : "failed",
        }

        yield* persistHealth(args.sessionId, args.record.health)
        yield* syncDaemonMetadata
      })

    // PRB-089: bounded, identity-reused redelivery for ambiguous mutation
    // failures. The command sequence is allocated exactly once, before the
    // loop, and every delivery attempt below (the first dispatch and every
    // redelivery) reuses that same sequence number — the runner's bounded
    // terminal-result cache is keyed by (epoch, sequence), so redelivering
    // the identical identity after an ambiguous transport failure is safe:
    // the runner either replays the cached result or, if it never actually
    // ran the command, executes it exactly once.
    //
    // Only ambiguous `RunnerTransportError` outcomes are retryable here
    // ("sent-no-response" / "invalid-response" — the runner may already have
    // executed the command). An unambiguous "not-sent" failure means nothing
    // reached the runner at all, so there is nothing to redeliver into a
    // cache; it keeps its prior single-attempt, immediate-classification
    // behavior. `ping` is excluded entirely — it already has its own safe
    // idempotent retry *inside* RunnerTransportClient's one absolute
    // deadline (see `idempotent: action === "ping"` in each harness), and
    // redelivering it here too would double up two independent retry
    // policies over the same health-check call.
    const mutationRedeliveryMaxAttempts = 100
    const mutationRedeliveryBackoffMs = 10

    const sendRunnerCommand = (
      sessionId: string,
      record: RunnerBackedActiveSessionRecord,
      action: RunnerAction,
      payload?: string,
    ) =>
      Effect.gen(function* () {
        const ctx = yield* requireControllerContext(sessionId)
        const sequence = ctx.allocateSequence()
        const mayRedeliver = action !== "ping"

        let attempts = 0
        let lastError: unknown = null
        // Tracks whether ANY attempt in the loop was ambiguous, not just the
        // final one. An interleaving like attempt 1 ambiguous
        // (sent-no-response, retried) then attempt 2 unambiguous (not-sent,
        // e.g. the runner crashed between attempts) breaks the loop on a
        // non-ambiguous final error — but attempt 1 may still have executed
        // the mutation, so the outcome must stay indeterminate regardless of
        // what the last attempt looked like.
        let everAmbiguous = false

        while (true) {
          attempts += 1

          const attempt = yield* Effect.either(
            Effect.tryPromise({
              try: () => record.sendRunnerCommand(sequence, action, payload),
              catch: (error) => error,
            }),
          )

          if (Either.isRight(attempt)) {
            return attempt.right
          }

          lastError = attempt.left

          const ambiguousFailure = attempt.left instanceof RunnerTransportError && attempt.left.ambiguous

          if (ambiguousFailure) {
            everAmbiguous = true
          }

          const retryable = mayRedeliver
            && ambiguousFailure
            && attempts < mutationRedeliveryMaxAttempts

          if (!retryable) {
            break
          }

          yield* Effect.sleep(Duration.millis(mutationRedeliveryBackoffMs))
        }

        const rawError = lastError
        const reason = rawError instanceof Error ? rawError.message : String(rawError)
        const wrapperRunning = record.isRunnerRunning()

        yield* markSessionRunnerFailed({
          sessionId,
          record,
          lastCommand: action,
          reason,
          wrapperRunning,
          severity: classifyRunnerDispatchFailure({ error: rawError, wrapperRunning }),
        })

        // The runner may have executed the mutation on ANY attempt that came
        // back ambiguous — not only the final one — and Probe simply never
        // got a durable result back for it. This is the glyph's "runner loss
        // after dispatch without a durable result" case — report it as its
        // own typed, explicitly indeterminate outcome (never as a bare "the
        // command failed", which would understate what is actually known).
        // `everAmbiguous` covers both the all-attempts-ambiguous exhaustion
        // case and the interleaved case where an earlier ambiguous attempt
        // is followed by a later unambiguous one that breaks the loop.
        const indeterminate = mayRedeliver && everAmbiguous

        return yield* new EnvironmentError({
          code: indeterminate ? `session-runner-${action}-indeterminate` : `session-runner-${action}`,
          reason: indeterminate
            ? `${reason} Command identity (sequence=${sequence}, epoch=${record.runnerEpoch ?? "unknown"}, `
              + `last delivery phase=${rawError instanceof RunnerTransportError ? rawError.phase : "unknown"}) `
              + `could not be confirmed executed or not-executed after ${attempts} delivery attempts; `
              + "treat this outcome as indeterminate, never as success."
            : reason,
          nextStep: "Inspect the runner artifacts, then close and reopen the session instead of expecting transparent recovery.",
          details: [],
        })
      })

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
              // A failed screenshot capture has no separate failure-evidence
              // concept: the capture that failed IS the action, not a
              // discretionary policy capture around a mutation.
              evidence: emptyEvidenceReport(resolveEvidencePolicy()),
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
              // Screenshot captures are explicit, not policy-driven — see
              // evidence.ts's module doc (acceptance criterion #11).
              evidence: emptyEvidenceReport(resolveEvidencePolicy()),
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
              // A failed video capture has no separate failure-evidence
              // concept, same reasoning as the screenshot failure above.
              evidence: emptyEvidenceReport(resolveEvidencePolicy()),
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
              // Video captures are explicit, not policy-driven — see
              // evidence.ts's module doc (acceptance criterion #11).
              evidence: emptyEvidenceReport(resolveEvidencePolicy()),
              ...buildActionResultMetadata(emptyRetryAttemptMetadata()),
            } satisfies ExtendedSessionActionResult,
          } satisfies ActionExecutionOutcome
        }

        if (args.action.kind === "assert") {
          const action = args.action
          const retryPolicy = action.retryPolicy ?? defaultAssertRetryPolicy
          let cachedSnapshot: { readonly artifact: StoredSnapshotArtifact; readonly artifactRecord: ArtifactRecord; readonly handledMs: number } | null = null
          // PRB-093: assert always needs a current snapshot to resolve its
          // target -- that capture is "resolution" evidence, not a
          // discretionary evidence-policy capture (assert has no
          // evidencePolicy field; see evidence.ts). Accumulated across every
          // retry attempt, not just the winning one, for an honest count.
          const evidenceCaptures: Array<EvidenceCapture> = []
          const result = yield* attemptWithRetry({
            policy: retryPolicy,
            run: () =>
              Effect.gen(function* () {
                const previousSnapshot = cachedSnapshot
                const snapshot = retryPolicy.refreshSnapshotBetweenAttempts || previousSnapshot === null
                  ? yield* captureSnapshotArtifactInternal(args.sessionId, record)
                  : previousSnapshot

                if (snapshot !== previousSnapshot) {
                  evidenceCaptures.push({
                    reason: "resolution",
                    phase: "pre",
                    snapshotId: snapshot.artifact.snapshotId,
                    ms: snapshot.handledMs,
                  })
                }

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
              // assert has no evidencePolicy field (unaffected by evidence
              // policy) -- but the resolution snapshots taken across its
              // retry attempts are still real capture work, so report them
              // here exactly like the passing branch below does.
              evidence: buildEvidenceReport(resolveEvidencePolicy(), evidenceCaptures),
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
              evidence: buildEvidenceReport(resolveEvidencePolicy(), evidenceCaptures),
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
                // Duration waits never resolve a target, so they never touch
                // a snapshot -- zero captures, trivially.
                evidence: emptyEvidenceReport(resolveEvidencePolicy()),
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
          let lastSnapshot: WaitPollSnapshot | null = null
          let lastEvaluation: ReturnType<typeof evaluateAssertion> | null = null
          // PRB-093: same "resolution, not policy" accounting as assert above.
          const evidenceCaptures: Array<EvidenceCapture> = []

          while (attempts < retryPolicy.maxAttempts) {
            attempts += 1

            const previousSnapshot: WaitPollSnapshot | null = lastSnapshot
            const snapshot: WaitPollSnapshot = retryPolicy.refreshSnapshotBetweenAttempts || previousSnapshot === null
              ? yield* captureSnapshotArtifactInternal(args.sessionId, record)
              : previousSnapshot

            if (snapshot !== previousSnapshot) {
              evidenceCaptures.push({
                reason: "resolution",
                phase: "pre",
                snapshotId: snapshot.artifact.snapshotId,
                ms: snapshot.handledMs,
              })
            }

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
                  evidence: buildEvidenceReport(resolveEvidencePolicy(), evidenceCaptures),
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
            // wait has no evidencePolicy field, same "resolution, not
            // policy" accounting as assert above -- report the polling
            // snapshots taken across the timed-out attempts rather than
            // discarding that capture work.
            evidence: buildEvidenceReport(resolveEvidencePolicy(), evidenceCaptures),
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
        // PRB-093: the canonical evidence policy replaces the old implicit
        // "always capture pre, always capture post" behavior. `wantsPre`
        // covers two independent reasons a pre-mutation snapshot might be
        // needed: resolving a ref/semantic target at all (mandatory,
        // regardless of policy), or "around" explicitly requesting
        // pre-mutation evidence even for a point target that needs no
        // resolution. Only "around" ever forces a *fresh* pre, ignoring the
        // session's cached latest snapshot -- "end" and "none" trust that
        // cache for resolution (the previous action's own post capture, or
        // an explicit snapshot command) rather than paying for a redundant
        // fresh capture before every mutation. See evidence.ts's module doc.
        const policy = resolveEvidencePolicy(action.evidencePolicy)
        const successPlan = planSuccessEvidence(policy.success)
        const requiresResolution = action.target.kind !== "point"
        const wantsPre = requiresResolution || successPlan.forcedFreshPre
        const evidenceCaptures: Array<EvidenceCapture> = []
        let cachedPreSnapshot: StoredSnapshotArtifact | null = wantsPre && !successPlan.forcedFreshPre
          ? record.snapshotState.latest
          : null
        // `refreshSnapshotBetweenAttempts` governs refreshing *between this
        // action's own retry attempts* -- it must not force a fresh capture
        // on the action's first attempt just because a cross-action cached
        // snapshot was seeded above; that would silently undo the whole
        // point of reusing the cache. Only a genuine retry (attempt > 1)
        // asks `refreshSnapshotBetweenAttempts`.
        let attemptCount = 0

        const actionResult = yield* attemptWithRetry({
          policy: retryPolicy,
          run: () =>
            Effect.gen(function* () {
              attemptCount += 1
              const previousPreSnapshot = cachedPreSnapshot
              const isRetryAttempt = attemptCount > 1
              const needsFreshPre = wantsPre
                && (previousPreSnapshot === null || (isRetryAttempt && retryPolicy.refreshSnapshotBetweenAttempts))
              const preSnapshot = !wantsPre
                ? null
                : needsFreshPre
                  ? yield* captureSnapshotArtifactInternal(args.sessionId, record)
                  : { artifact: previousPreSnapshot!, handledMs: 0 }

              if (needsFreshPre && preSnapshot !== null) {
                const reason: EvidenceCaptureReason = successPlan.forcedFreshPre ? "policy-pre" : "resolution"
                evidenceCaptures.push({
                  reason,
                  phase: "pre",
                  snapshotId: preSnapshot.artifact.snapshotId,
                  ms: preSnapshot.handledMs,
                })
              }

              if (preSnapshot !== null) {
                cachedPreSnapshot = preSnapshot.artifact
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

              const postSnapshot = successPlan.needsPost
                ? yield* captureSnapshotArtifactInternal(args.sessionId, record)
                : null

              if (postSnapshot !== null) {
                evidenceCaptures.push({
                  reason: "policy-post",
                  phase: "post",
                  snapshotId: postSnapshot.artifact.snapshotId,
                  ms: postSnapshot.handledMs,
                })
              }

              return {
                postSnapshot,
                resolvedTarget,
                handledMs: response.handledMs,
              }
            }),
        })

        if (!actionResult.ok) {
          // Failure evidence: best-effort, additive only -- never replaces
          // the original mutation failure above. Swallowed via Effect.either
          // exactly like the fast direct-runner lane (directRunnerActionExecutor.ts),
          // but a successful capture is still reported through `evidence`
          // below rather than silently discarded (PRB-093 review finding).
          if (shouldCaptureFailureEvidence(policy.failure)) {
            const failureCapture = yield* Effect.either(captureSnapshotArtifactInternal(args.sessionId, record))

            if (failureCapture._tag === "Right") {
              evidenceCaptures.push({
                reason: "policy-failure",
                phase: "post",
                snapshotId: failureCapture.right.artifact.snapshotId,
                ms: failureCapture.right.handledMs,
              })
            }
          }

          yield* persistActionFailure(args.sessionId, record, args.action.kind)
          return {
            ok: false,
            error: actionResult.error,
            retry: actionResult.retry,
            evidence: buildEvidenceReport(policy, evidenceCaptures),
          } satisfies ActionExecutionOutcome
        }

        if (args.recordAction) {
          appendRecordedAction(record, buildRecordedSessionAction(action, actionResult.value.resolvedTarget))
        }

        updateHealthCheck(record, args.action.kind, true)
        yield* persistHealth(args.sessionId, record.health)
        yield* syncDaemonMetadata

        const latestSnapshotId = actionResult.value.postSnapshot?.artifact.snapshotId
          ?? record.snapshotState.latest?.snapshotId
          ?? null
        const statusLabel = actionResult.value.postSnapshot?.artifact.statusLabel
          ?? record.snapshotState.latest?.statusLabel
          ?? null
        const captureNote = actionResult.value.postSnapshot !== null
          ? `; captured ${actionResult.value.postSnapshot.artifact.snapshotId}`
          : ""

        const summary = actionResult.value.resolvedTarget.kind === "snapshot"
          ? actionResult.value.resolvedTarget.resolvedBy === "semantic"
              && action.target.kind === "ref"
              && action.target.fallback !== null
            ? `Executed ${action.kind} on ${describeSnapshotNode(actionResult.value.resolvedTarget.node)} after semantic selector-drift recovery${captureNote}.`
            : `Executed ${action.kind} on ${describeSnapshotNode(actionResult.value.resolvedTarget.node)}${captureNote}.`
          : `Executed ${action.kind} at point(${actionResult.value.resolvedTarget.x}, ${actionResult.value.resolvedTarget.y}) in interaction-root coordinates${captureNote}.`

        return {
          ok: true,
          result: {
            summary,
            action: args.action.kind,
            matchedRef: actionResult.value.resolvedTarget.kind === "snapshot" ? actionResult.value.resolvedTarget.ref : null,
            resolvedBy: actionResult.value.resolvedTarget.resolvedBy,
            statusLabel,
            latestSnapshotId,
              artifact: null,
              recordingLength: record.recording.steps.length,
              handledMs: actionResult.value.handledMs,
              evidence: buildEvidenceReport(policy, evidenceCaptures),
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
          ...describeRunnerFrameSequenceFallback({ frameCount: args.manifest.frameCount, fps: args.manifest.fps }),
          absolutePath: bundlePath,
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
                String(manifest.fps || defaultVideoCaptureFps),
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
          ...describeRunnerMp4Artifact({ frameCount: manifest.frameCount, fps: manifest.fps }),
          absolutePath,
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
            ...describeSimulatorMovFallback({ durationMs: args.durationMs }),
            absolutePath: movPath,
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
          ...describeSimulatorMp4Remux({
            durationMs: args.durationMs,
            sourceFrameRateLabel: sourceFrameRate === null ? null : sourceFrameRate.label,
          }),
          absolutePath,
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

    // PRB-083 gate 3/4/10: explicit close, TTL expiry, runner exit, and
    // daemon shutdown all call this. Every one of those triggers routes
    // through the *same* `record.controller.close(...)` call, so whichever
    // one reaches the controller first is the only one that ever runs the
    // teardown body below — the others (concurrent or later, including a
    // caller that arrives after the session is already fully closed) all
    // receive that exact same terminal health back. `closeResources()` is
    // best-effort inside teardown (a warning, not a failure the caller must
    // handle) because teardown itself cannot fail: a close that failed
    // outright would leave the session stuck in "closing" forever with no
    // way to retry cleanly, which is worse than a closed session carrying a
    // cleanup warning.
    const closeSessionInternal = (
      sessionId: string,
      reason: SessionCloseReason,
    ): Effect.Effect<SessionHealth | null> =>
      Effect.gen(function* () {
        const sessions = yield* Ref.get(sessionsRef)
        const record = sessions.get(sessionId)

        if (!record) {
          const closedSessions = yield* Ref.get(closedRecordsRef)
          const closedRecord = closedSessions.get(sessionId)

          if (!closedRecord) {
            return null
          }

          // Already fully closed and removed from `sessionsRef`; the
          // controller is terminal, so this just replays the cached
          // terminal result instead of re-running teardown or claiming
          // the session was never found.
          return yield* closedRecord.controller.close(reason, () => Effect.succeed(closedRecord.health))
        }

        yield* record.controller.close(reason, (closeReason, ctx) =>
          Effect.gen(function* () {
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

            // PRB-096: interrupt and join any in-flight raw perf trace lease
            // through the same scoped AppleProcessSupervisor every other
            // owned child process uses, instead of orphaning it. Aborting
            // `lease.signal` races into PerfService's `AbortSignal.any`
            // combination, which reaches `AppleProcessSupervisor.run`'s
            // `spec.signal` and drives the usual TERM -> grace -> KILL
            // ladder. The bounded wait below is the "join": `endTraceLease`
            // resolves `settled` once the capture has actually unwound
            // (success, failure, or interruption), so teardown never
            // proceeds while a trace is still writing into an artifact root
            // it is about to help tear down -- but a wedged trace can never
            // hang the close forever either.
            const activeTraceLease = (yield* Ref.get(activeTraceLeasesRef)).get(sessionId)

            if (activeTraceLease) {
              activeTraceLease.controller.abort(`session ${sessionId} is ${closeReason}`)
              yield* Deferred.await(activeTraceLease.settled).pipe(
                Effect.timeout(Duration.seconds(90)),
                Effect.catchAll(() => Effect.void),
              )
            }

            yield* closeDebuggerBridgeInternal(sessionId, record).pipe(Effect.catchAll(() => Effect.succeed(false)))

            if (closeReason !== "runner-exit" && isRunnerBackedRecord(record) && record.isRunnerRunning()) {
              yield* Effect.tryPromise({
                try: async () => {
                  await record.sendRunnerCommand(ctx.allocateSequence(), "shutdown")
                },
                catch: () => new EnvironmentError({
                  code: "session-close-shutdown",
                  reason: `Failed to send shutdown to session ${sessionId}; falling back to wrapper termination.`,
                  nextStep: "Inspect the session log artifact if the runner did not exit cleanly.",
                  details: [],
                }),
              }).pipe(Effect.catchAll(() => Effect.succeed(undefined)))
            }

            const closeResourcesFailure = yield* Effect.tryPromise({
              try: () => record.closeResources(),
              catch: (error) => (error instanceof Error ? error.message : String(error)),
            }).pipe(Effect.either)

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
                lastCommand: closeReason === "runner-exit" ? "runner-exit" : "shutdown",
                lastOk: closeReason === "runner-exit" ? false : true,
              },
              warnings: Either.isLeft(closeResourcesFailure)
                ? dedupeStrings([
                    ...record.health.warnings,
                    `Session resource cleanup reported an error and may be incomplete: ${closeResourcesFailure.left}`,
                  ])
                : record.health.warnings,
            }
            yield* persistHealth(sessionId, record.health)

            return record.health
          }).pipe(
            // teardown's contract is Effect<SessionHealth, never>: it must
            // always settle to a terminal health so every observer waiting
            // on the coalesced close gets a value, never a hung deferred.
            // An artifact-manifest write failure mid-teardown (the only
            // remaining fallible step here) becomes a warning on the
            // closed health snapshot rather than a close that never
            // finishes.
            Effect.catchAll((error) =>
              Effect.sync(() => {
                record.health = {
                  ...record.health,
                  state: "closed",
                  updatedAt: nowIso(),
                  warnings: dedupeStrings([
                    ...record.health.warnings,
                    `Session close teardown reported an error and health persistence may be incomplete: ${error.reason}`,
                  ]),
                }
                return record.health
              }),
            ),
          ),
        )

        yield* Ref.update(sessionsRef, (current) => {
          const next = new Map(current)
          next.delete(sessionId)
          return next
        })
        yield* Ref.update(closedRecordsRef, (current) => new Map(current).set(sessionId, record))
        yield* syncDaemonMetadata

        return record.health
      })

    const sweeper = Effect.forever(
      Effect.gen(function* () {
        const sessions = yield* Ref.get(sessionsRef)
        // PRB-096: an active trace lease keeps the session alive on its own,
        // independent of runner keepalives -- the raw perf path deliberately
        // sends none of those now, so gating expiry on `expiresAt` alone
        // would let a long recording get TTL-swept out from under itself.
        const expiredIds = [...sessions.values()]
          .filter((record) =>
            Date.parse(record.health.expiresAt) <= Date.now()
            && !activeTraceLeaseStates.has(record.health.resources.trace))
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
      openDeviceSession: ({ bundleId, deviceId, signingTeamId, projectRoot, emitProgress }) =>
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
                  signingTeamId,
                })

                emitProgress(
                  "runner-cache",
                  opened.runnerBuildCache.status
                    ? `Signed runner build ${opened.runnerBuildCache.status} (key ${opened.runnerBuildCache.key ?? "unknown"})${
                        opened.runnerBuildCache.invalidationReason
                          ? ` -- invalidated: ${opened.runnerBuildCache.invalidationReason}`
                          : ""
                      }.`
                    : "No signing team resolved; the runner build cache was not evaluated.",
                )
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
                      runnerBuildCache: opened.runnerBuildCache,
                      note:
                        "The real-device runner is live over HTTP POST command ingress with stdout-JSONL mixed-log observation for readiness and diagnostics.",
                    },
                    healthCheck,
                    debugger: debuggerState,
                    coordination: buildSessionCoordination(debuggerState),
                    warnings: [...warnings],
                    artifacts: [...(yield* refreshArtifacts(opening.sessionId))],
                  }

                  const controller = yield* makeSessionController({
                    sessionId: opening.sessionId,
                    initialSequence: opened.nextSequence,
                    opQueueCapacity: sessionControllerQueueCapacity,
                  })

                  const record: RealDeviceActiveSessionRecord = {
                    kind: "device",
                    health,
                    baseWarnings: warnings,
                    integrationPoints: opened.integrationPoints,
                    controller,
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
                    runnerEpoch: opened.runnerEpoch,
                    refreshConnection: opened.refreshConnection,
                    closeResources: opened.close,
                    isRunnerRunning: opened.isWrapperRunning,
                    waitForExit: opened.waitForExit,
                  }

                  yield* persistHealth(opening.sessionId, health)
                  yield* Ref.update(sessionsRef, (current) => new Map(current).set(opening.sessionId, record))

                  // PRB-083 gate 3: runner exit is one of the four triggers
                  // that must go through the same coalesced close as
                  // explicit close / TTL expiry / daemon shutdown, instead
                  // of only marking the session "failed" and leaving it
                  // registered (the prior sticky-failure behavior this
                  // glyph fixes).
                  record.waitForExit?.then(() => {
                    void Effect.runPromise(
                      closeSessionInternal(opening.sessionId, "runner-exit").pipe(
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

                  const controller = yield* makeSessionController({
                    sessionId: opening.sessionId,
                    initialSequence: opened.nextSequence,
                    opQueueCapacity: sessionControllerQueueCapacity,
                  })

                  const record: SimulatorActiveSessionRecord = {
                    kind: "simulator",
                    health,
                    baseWarnings: warnings,
                    controller,
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
                    runnerEpoch: opened.runnerEpoch,
                    closeResources: opened.close,
                    isRunnerRunning: opened.isWrapperRunning,
                    waitForExit: opened.waitForExit,
                  }

                  yield* persistHealth(opening.sessionId, health)
                  yield* Ref.update(sessionsRef, (current) => new Map(current).set(opening.sessionId, record))

                  // PRB-083 gate 3: see the matching comment in the device
                  // open flow above.
                  record.waitForExit.then(() => {
                    void Effect.runPromise(
                      closeSessionInternal(opening.sessionId, "runner-exit").pipe(
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

          // PRB-083: the whole health-check body (both the ping dispatch
          // and every health mutation it makes) runs as one operation on
          // this session's controller fiber, serialized against every
          // other command, TTL sweep, runner exit, and close on the same
          // session.
          return yield* record.controller.submit((ctx) => withControllerContext(ctx, Effect.gen(function* () {
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
                try: () => record.sendRunnerCommand(ctx.allocateSequence(), "ping", "health-check"),
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

          // PRB-083 gate 5: dispatched directly (not through the shared
          // `sendRunnerCommand` helper, which always fails the calling
          // Effect on any transport error) so an ambiguous/degraded outcome
          // can return successfully with a degraded health snapshot,
          // mirroring the real-device ping branch above instead of
          // surfacing a hard failure for what may just be a transient
          // timeout against a still-live wrapper.
          const pingAttempt = yield* Effect.either(
            Effect.tryPromise({
              try: () => record.sendRunnerCommand(ctx.allocateSequence(), "ping", "health-check"),
              catch: (error) => error,
            }),
          )

          if (Either.isLeft(pingAttempt)) {
            const wrapperRunning = record.isRunnerRunning()
            const severity = classifyRunnerDispatchFailure({ error: pingAttempt.left, wrapperRunning })
            const reason = pingAttempt.left instanceof Error ? pingAttempt.left.message : String(pingAttempt.left)

            yield* markSessionRunnerFailed({
              sessionId,
              record,
              lastCommand: "ping",
              reason,
              wrapperRunning,
              severity,
            })

            if (severity === "degraded") {
              return record.health
            }

            return yield* new EnvironmentError({
              code: "session-runner-ping",
              reason,
              nextStep: "Inspect the runner artifacts, then close and reopen the session instead of expecting transparent recovery.",
              details: [],
            })
          }

          const response = pingAttempt.right

          // PRB-083 gate 6: a successful ping against the same live wrapper
          // restores `resources.runner` to "ready" (rather than carrying
          // forward whatever it was, which is how a prior "failed" used to
          // stick forever) and re-derives `state` from that instead of
          // hard-coding it — so a session genuinely recovers instead of
          // staying stuck failed after the runner answers again.
          const nextHealthBase: SessionHealth = {
            ...record.health,
            updatedAt: nowIso(),
            expiresAt: expiresAtIso(),
            resources: setRunnerResourceState(record.health.resources, response.ok ? "ready" : "failed"),
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

          record.health = {
            ...nextHealthBase,
            state: deriveSessionPhase(nextHealthBase),
          }

          yield* persistHealth(sessionId, record.health)
          yield* syncDaemonMetadata
          return record.health
          })))
        }),
      sendRunnerKeepalive: (sessionId) =>
        Effect.gen(function* () {
          const record = yield* requireSessionRecord(sessionId)

          if (!isRunnerBackedRecord(record)) {
            return
          }

          yield* record.controller.submit((ctx) =>
            withControllerContext(ctx, sendRunnerCommand(sessionId, record, "ping", "perf-keepalive")),
          ).pipe(Effect.asVoid)
        }),
      peekSessionHealth: (sessionId) =>
        Effect.gen(function* () {
          const sessions = yield* Ref.get(sessionsRef)
          const record = sessions.get(sessionId)

          if (record) {
            return record.health
          }

          const closedSessions = yield* Ref.get(closedRecordsRef)
          const closedRecord = closedSessions.get(sessionId)

          if (closedRecord) {
            return closedRecord.health
          }

          // A passive peek never touches the artifact manifest (that read
          // can itself fail with EnvironmentError) -- a generic next step is
          // an honest tradeoff for a method whose entire point is "no side
          // effects, no extra I/O."
          return yield* new SessionNotFoundError({
            sessionId,
            nextStep: "Open a new session or inspect the artifact root directly if the session has already closed.",
          })
        }),
      beginTraceLease: (sessionId) =>
        Effect.gen(function* () {
          const record = yield* requireSessionRecord(sessionId)

          return yield* record.controller.submit((_ctx) =>
            Effect.gen(function* () {
              const runnerDetails = record.health.runner

              if (!isLiveRunnerDetails(runnerDetails)) {
                return yield* new UnsupportedCapabilityError({
                  code: "perf-session-real-device-runner",
                  capability: "perf.record.trace-lease",
                  reason: "The current session does not expose a live runner-backed target pid for perf recording.",
                  nextStep: "Retry on a simulator-backed runner session, or wait for the real-device runner/perf seam to be validated.",
                  details: [],
                  wall: false,
                })
              }

              // Last-known cached status, not a fresh ping -- a fresh
              // pid-liveness/identity check happens right before xctrace
              // spawns (PerfService's job); this is just an honest,
              // side-effect-free early reject for a device already known to
              // be disconnected.
              if (record.health.connection.status === "disconnected") {
                return yield* new EnvironmentError({
                  code: "perf-target-device-disconnected",
                  reason: `Device ${record.health.target.deviceName} (${record.health.target.deviceId}) is currently disconnected; Probe will not start a raw perf capture against it.`,
                  nextStep: "Reconnect the device, refresh session health, and retry the profiling command.",
                  details: [],
                })
              }

              const existingLeases = yield* Ref.get(activeTraceLeasesRef)

              if (existingLeases.has(sessionId)) {
                return yield* new EnvironmentError({
                  code: "perf-trace-lease-busy",
                  reason: `Session ${sessionId} already has an active raw perf trace recording.`,
                  nextStep: "Wait for the in-flight profiling command to finish, then retry.",
                  details: [],
                })
              }

              const controller = new AbortController()
              const settled = yield* Deferred.make<void>()

              yield* Ref.update(activeTraceLeasesRef, (current) => new Map(current).set(sessionId, { controller, settled }))

              record.health = {
                ...record.health,
                updatedAt: nowIso(),
                expiresAt: expiresAtIso(),
                resources: setSessionResourceStates(record.health.resources, { trace: "starting" }),
              }
              yield* persistHealth(sessionId, record.health)
              yield* syncDaemonMetadata

              return {
                target: {
                  sessionId,
                  platform: record.health.target.platform,
                  deviceId: record.health.target.deviceId,
                  deviceName: record.health.target.deviceName,
                  bundleId: record.health.target.bundleId,
                  targetProcessId: runnerDetails.targetProcessId,
                  artifactRoot: record.health.artifactRoot,
                },
                signal: controller.signal,
              } satisfies TraceLeaseHandle
            }),
          )
        }),
      endTraceLease: (sessionId, outcome) =>
        Effect.gen(function* () {
          const applyOutcome = (health: SessionHealth): SessionHealth => {
            const nextTraceState: SessionResourceState =
              outcome.kind === "stopped" ? "stopped" : outcome.kind === "degraded" ? "degraded" : "failed"

            return {
              ...health,
              updatedAt: nowIso(),
              expiresAt: expiresAtIso(),
              // Only `resources.trace` moves here -- `state` and
              // `resources.runner` stay untouched, so a profiler failure
              // degrades the trace lane without corrupting the UI lane.
              resources: setSessionResourceStates(health.resources, { trace: nextTraceState }),
              warnings: outcome.kind === "stopped"
                ? health.warnings
                : dedupeStrings([...health.warnings, `Raw perf trace capture ${outcome.kind}: ${outcome.detail}`]),
            }
          }

          const mutateRecord = (record: ActiveSessionRecord) =>
            Effect.sync(() => {
              record.health = applyOutcome(record.health)
            }).pipe(
              Effect.flatMap(() => persistHealth(sessionId, record.health)),
              // Best-effort persistence: `endTraceLease` is called from
              // PerfService's `Effect.onExit` finalizer and awaited (via the
              // Deferred below) by a concurrent session close, so it must
              // never itself fail.
              Effect.catchAll(() => Effect.void),
            )

          const sessions = yield* Ref.get(sessionsRef)
          const record = sessions.get(sessionId)

          if (record) {
            yield* record.controller.submit((_ctx) => mutateRecord(record)).pipe(
              Effect.tap(() => syncDaemonMetadata),
              // The owning session may already be mid-close (a terminal
              // controller rejects with `session-closed`) -- exactly the
              // case `closeSessionInternal` is blocked awaiting `settled`
              // for below, so no other fiber can be racing this direct
              // mutation.
              Effect.catchAll(() => mutateRecord(record)),
            )
          } else {
            const closedSessions = yield* Ref.get(closedRecordsRef)
            const closedRecord = closedSessions.get(sessionId)

            if (closedRecord) {
              yield* mutateRecord(closedRecord)
            }
          }

          const leases = yield* Ref.get(activeTraceLeasesRef)
          const lease = leases.get(sessionId)

          if (lease) {
            yield* Ref.update(activeTraceLeasesRef, (current) => {
              const next = new Map(current)
              next.delete(sessionId)
              return next
            })
            yield* Deferred.succeed(lease.settled, undefined)
          }
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
          const captured = yield* record.controller.submit((ctx) =>
            withControllerContext(
              ctx,
              runWithRetry({
                policy: defaultReadOnlyRetryPolicy,
                run: () => captureSnapshotArtifactInternal(sessionId, record),
              }) as Effect.Effect<
                { readonly value: { readonly artifact: StoredSnapshotArtifact; readonly artifactRecord: ArtifactRecord }; readonly retry: RetryAttemptMetadata },
                UnsupportedCapabilityError | EnvironmentError | ChildProcessError
              >,
            ),
          )
          return buildSessionSnapshotResult({
            artifact: captured.value.artifact,
            artifactRecord: captured.value.artifactRecord,
            outputMode,
            retry: captured.retry,
          })
        }),
      performAction: ({ sessionId, action }) =>
        Effect.gen(function* () {
          const record = yield* requireSessionRecord(sessionId)
          const outcome = yield* record.controller.submit((ctx) =>
            withControllerContext(
              ctx,
              executeSessionAction({
                sessionId,
                action,
                recordAction: true,
              }),
            ),
          )

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

          const record = yield* requireSessionRecord(sessionId)

          // PRB-083: the whole flow run — every step it dispatches — is one
          // operation on this session's controller fiber, exactly like a
          // single action. This is a mechanical integration (routing the
          // flow's existing runner dispatches through the shared
          // controller context), not a change to flow planning/execution
          // itself, which stays out of PRB-083's scope per the glyph notes.
          return yield* record.controller.submit((ctx) => withControllerContext(ctx, Effect.gen(function* () {
          yield* refreshSessionArtifacts(sessionId, record)
          const plan = planFlowExecution(flow)

          // PRB-073: the port bag every extracted executor takes instead of
          // closing over this closure's locals. Built once per flow run —
          // `registry` is already fully assigned by the time `runFlow`
          // actually executes (it is only referenced here, not called, at
          // module-construction time), exactly like the `registry.markLog`
          // self-reference this replaces.
          const deps: FlowExecutorDeps = {
            sendRunnerCommand,
            captureSnapshotArtifactInternal,
            captureScreenshotArtifact,
            captureVideoArtifact,
            markLog: registry.markLog,
            updateHealthCheck,
            persistHealth,
            persistRecordHealth,
            refreshSessionArtifacts,
            persistActionFailure,
            syncDaemonMetadata,
            executeSessionAction,
          }

          // PRB-073: `runFlow` itself is now a bounded orchestration loop —
          // per-step dispatch lives in the named executors under
          // src/services/flow/*; this loop only sequences them and folds
          // their results. Its size no longer grows per execution lane: a
          // new step kind adds one more executor and one more branch here,
          // not more inline logic.
          let executedSteps: ReadonlyArray<FlowV2StepResult> = []
          let createdArtifacts: ReadonlyArray<ArtifactRecord> = []
          let failedStep: FlowV2FailedStep | null = null
          let overallVerdict: SessionFlowResult["verdict"] = "passed"
          let totalRetries = 0
          let stoppedEarly = false

          for (const plannedStep of plan.steps) {
            const step = plannedStep.step
            const beforeArtifacts = [...record.health.artifacts]
            const continueOnError = step.continueOnError === true
            const latestSnapshotIdBefore = record.snapshotState.latest?.snapshotId ?? null
            let stepResult: FlowV2StepResult

            if (step.kind === "snapshot") {
              stepResult = yield* captureSnapshotEvidenceStep({ sessionId, record, plannedStep, step, continueOnError, deps })
            } else if (step.kind === "screenshot") {
              stepResult = yield* captureScreenshotEvidenceStep({ sessionId, record, plannedStep, step, continueOnError, deps })
            } else if (step.kind === "video") {
              stepResult = yield* captureVideoEvidenceStep({ sessionId, record, plannedStep, step, continueOnError, deps })
            } else if (step.kind === "logMark") {
              stepResult = yield* markLogEvidenceStep({ sessionId, record, plannedStep, step, continueOnError, deps })
            } else if (step.kind === "sleep") {
              yield* Effect.sleep(step.durationMs)
              stepResult = buildFlowStepResult({
                plannedStep,
                kind: step.kind,
                summary: `Slept for ${step.durationMs}ms.`,
                verdict: "passed",
                matchedRef: null,
                latestSnapshotId: latestSnapshotIdBefore,
                retryCount: 0,
                retryReasons: [],
                handledMs: null,
                warnings: [],
              })
            } else if (plannedStep.kind === "batch-sequence") {
              const outcome = yield* executeBatchActionStep({ sessionId, record, step: plannedStep.step, deps })
              // Read after dispatch, not before: the batch executor may have
              // captured one or more evidence snapshots per its evidence
              // policy (or none at all under "none"), and
              // `buildBatchStepResult` also falls back to
              // `record.snapshotState.latest` when nothing was captured —
              // exactly like the original inline branch read it post-dispatch.
              stepResult = buildBatchStepResult({
                plannedStep,
                step: plannedStep.step,
                continueOnError,
                outcome,
                latestSnapshotIdBefore: record.snapshotState.latest?.snapshotId ?? null,
              })
            } else {
              const outcome = plannedStep.kind === "fast-single"
                ? yield* Effect.either(executeDirectRunnerActionStep({ sessionId, record, step: plannedStep.step as FlowV2FastSingleStep, deps }))
                : yield* Effect.either(executeVerifiedActionStep({ sessionId, step, deps }))

              // Read after dispatch, not before: a failed direct-runner
              // action captures a failure snapshot as part of its own
              // executor, so `record.snapshotState.latest` can change during
              // dispatch — the original inline branch read it after too.
              stepResult = buildActionOutcomeStepResult({
                plannedStep,
                step,
                continueOnError,
                latestSnapshotIdBefore: record.snapshotState.latest?.snapshotId ?? null,
                outcome,
              })
            }

            yield* refreshSessionArtifacts(sessionId, record)

            const stepArtifacts = diffArtifacts(beforeArtifacts, record.health.artifacts)
            const folded = foldFlowStepOutcome({
              executedSteps,
              createdArtifacts,
              overallVerdict,
              totalRetries,
              failedStep,
              stepResult,
              stepArtifacts,
              continueOnError,
            })

            executedSteps = folded.executedSteps
            createdArtifacts = folded.createdArtifacts
            overallVerdict = folded.overallVerdict
            totalRetries = folded.totalRetries
            failedStep = folded.failedStep

            if (folded.stoppedEarly) {
              stoppedEarly = true
              break
            }
          }

          return assembleFlowResult({
            sessionId,
            executedAt: nowIso(),
            executedSteps,
            createdArtifacts,
            overallVerdict,
            totalRetries,
            failedStep,
            stoppedEarly,
            finalSnapshotId: record.snapshotState.latest?.snapshotId ?? null,
          })
          })))
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

          // PRB-093: replay shares the canonical mutation evidence policy
          // (evidence.ts) rather than the old "always fresh pre + always
          // post" behavior every mutation step used to have. Recorded steps
          // carry no per-step evidencePolicy field (matching the existing
          // precedent that retryPolicy also isn't recorded/replayed
          // per-step; see ActionRecordingScript), so replay runs under the
          // one canonical default for its whole duration: success=end,
          // failure=snapshot.
          const replayEvidencePolicy = defaultMutationEvidencePolicy
          const replaySuccessPlan = planSuccessEvidence(replayEvidencePolicy.success)

          // PRB-083: the whole replay run is one operation on this
          // session's controller fiber, mirroring runFlow above.
          return yield* record.controller.submit((ctx) => withControllerContext(ctx, Effect.gen(function* () {
          const reports: Array<ReplayStepReport> = []
          let retriedStepCount = 0
          let semanticFallbackCount = 0
          let finalSnapshotId: string | null = record.snapshotState.latest?.snapshotId ?? null
          // PRB-093 review finding: an aggregate roll-up of every step's
          // evidence captures, in step order, surfaced on the top-level
          // SessionReplayResult -- mirrors retriedStepCount/semanticFallbackCount.
          const allEvidenceCaptures: Array<EvidenceCapture> = []

          for (const [index, step] of script.steps.entries()) {
            let attempt = 0
            let succeeded = false
            let lastFailure = "unknown replay failure"
            let lastResolvedBy: ReplayStepReport["resolvedBy"] = "none"
            let lastMatchedRef: string | null = null
            // Reset per step -- captures accumulate across this step's own
            // retry attempts only (mirrors the assert/wait accounting in
            // executeSessionAction above).
            const evidenceCaptures: Array<EvidenceCapture> = []

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
                  // Screenshot captures are explicit, not policy-driven --
                  // see evidence.ts's module doc (acceptance criterion #11),
                  // mirroring the live screenshot action above.
                  evidence: emptyEvidenceReport(replayEvidencePolicy),
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
                  // Video captures are explicit, not policy-driven -- see
                  // evidence.ts's module doc (acceptance criterion #11),
                  // mirroring the live video action above.
                  evidence: emptyEvidenceReport(replayEvidencePolicy),
                }))
                succeeded = true
                continue
              }

              if (step.kind === "wait") {
                lastFailure = "Wait replay steps are not supported in replay yet. Re-run the wait before replay, or remove it from the recording."
                continue
              }

              const recordedTarget = step.target
              const wantsResolution = !(recordedTarget.preferredRef === null && recordedTarget.fallback?.kind === "point")

              // Asserts always verify against a fresh snapshot -- unaffected
              // by evidence policy, exactly like the live assert action.
              // Mutations reuse the session's cached latest snapshot for
              // resolution when one exists (the previous step's own post
              // capture) instead of forcing a redundant fresh one; only a
              // true bootstrap (no snapshot yet) forces a fresh capture.
              const cachedSnapshot = record.snapshotState.latest
              const forcesFreshResolution = step.kind === "assert" || (wantsResolution && cachedSnapshot === null)
              const preSnapshot = forcesFreshResolution
                ? yield* captureSnapshotArtifactInternal(sessionId, record)
                : wantsResolution && cachedSnapshot !== null
                  ? { artifact: cachedSnapshot, handledMs: 0 }
                  : null

              if (preSnapshot !== null) {
                finalSnapshotId = preSnapshot.artifact.snapshotId
              }

              // A capture is only reported when one actually happened --
              // reusing the cached snapshot (ms: 0) is not discretionary
              // capture work, exactly like the live mutation lane's cached
              // pre-reuse above never adds an evidence entry either.
              if (forcesFreshResolution && preSnapshot !== null) {
                evidenceCaptures.push({
                  reason: "resolution",
                  phase: "pre",
                  snapshotId: preSnapshot.artifact.snapshotId,
                  ms: preSnapshot.handledMs,
                })
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
                  evidence: buildEvidenceReport(replayEvidencePolicy, evidenceCaptures),
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

              if (!response.ok) {
                lastFailure = response.error ?? response.payload ?? `Runner ${step.kind} failed with status ${response.statusLabel}.`
                continue
              }

              const postSnapshot = replaySuccessPlan.needsPost
                ? yield* captureSnapshotArtifactInternal(sessionId, record)
                : null

              if (postSnapshot !== null) {
                finalSnapshotId = postSnapshot.artifact.snapshotId
                evidenceCaptures.push({
                  reason: "policy-post",
                  phase: "post",
                  snapshotId: postSnapshot.artifact.snapshotId,
                  ms: postSnapshot.handledMs,
                })
              }

              if (attempt > 1) {
                retriedStepCount += 1
              }

              if (resolvedTarget.resolvedBy === "semantic" && recordedTarget.preferredRef !== null) {
                semanticFallbackCount += 1
              }

              const captureNote = postSnapshot !== null ? `; captured ${postSnapshot.artifact.snapshotId}` : ""
              const summary = resolvedTarget.kind === "snapshot"
                ? resolvedTarget.resolvedBy === "semantic" && recordedTarget.preferredRef !== null
                  ? `Executed ${step.kind} on ${describeRecordedActionTarget(recordedTarget)} after semantic selector-drift recovery${captureNote}.`
                  : `Executed ${step.kind} on ${describeRecordedActionTarget(recordedTarget)}${captureNote}.`
                : `Executed ${step.kind} at point(${resolvedTarget.x}, ${resolvedTarget.y}) in interaction-root coordinates${captureNote}.`

                reports.push(buildReplayStepReport({
                  index: index + 1,
                  kind: step.kind,
                  attempts: attempt,
                  resolvedBy: resolvedTarget.resolvedBy,
                  matchedRef: resolvedTarget.kind === "snapshot" ? resolvedTarget.ref : null,
                  artifact: null,
                  summary,
                  evidence: buildEvidenceReport(replayEvidencePolicy, evidenceCaptures),
                }))
                succeeded = true
            }

            // Folded into the run-wide aggregate regardless of whether this
            // step succeeded or exhausted its retries -- harmless either
            // way, since the exhausted branch below returns early via a
            // typed error before the final result (the only place
            // `allEvidenceCaptures` is read) is ever built.
            allEvidenceCaptures.push(...evidenceCaptures)

            if (!succeeded) {
              const failedStepReport = buildReplayStepReport({
                index: index + 1,
                kind: step.kind,
                attempts: attempt,
                resolvedBy: lastResolvedBy,
                matchedRef: lastMatchedRef,
                artifact: null,
                summary: lastFailure,
                evidence: buildEvidenceReport(replayEvidencePolicy, evidenceCaptures),
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
            evidence: buildEvidenceReport(replayEvidencePolicy, allEvidenceCaptures),
          } satisfies SessionReplayResult
          })))
        }),
      captureScreenshot: ({ sessionId, label, outputMode }) =>
        Effect.gen(function* () {
          const record = yield* requireSessionRecord(sessionId)

          yield* assertRunnerActionsAvailable(record)

          return yield* record.controller.submit((ctx) => withControllerContext(ctx, Effect.gen(function* () {
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
          })))
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

          return yield* record.controller.submit((ctx) => withControllerContext(ctx, Effect.gen(function* () {
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
          })))
        }),
      closeSession: (sessionId) =>
        Effect.gen(function* () {
          const closedHealth = yield* closeSessionInternal(sessionId, "explicit-close")

          if (closedHealth === null) {
            return yield* new SessionNotFoundError({
              sessionId,
              nextStep: "Open a new session before attempting to close it.",
            })
          }

          // PRB-083 gate 10: `closedAt` comes from the terminal health
          // itself, so a repeat close call reports the moment the session
          // actually closed rather than a fresh timestamp on every call.
          return {
            sessionId,
            state: "closed",
            closedAt: closedHealth.updatedAt,
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
