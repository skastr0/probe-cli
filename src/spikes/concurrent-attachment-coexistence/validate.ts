#!/usr/bin/env bun

import { spawn, type ChildProcess } from "node:child_process"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import type { DebugCommandResult } from "../../domain/debug"
import { isProbeError, toFailurePayload, type ProbeFailurePayload } from "../../domain/errors"
import type { PerfRecordResult } from "../../domain/perf"
import { isLiveRunnerDetails, type SessionHealth } from "../../domain/session"
import type { SessionSnapshotResult } from "../../domain/snapshot"
import { probeRuntime } from "../../runtime"
import { PerfService } from "../../services/PerfService"
import { SessionRegistry } from "../../services/SessionRegistry"

const resultsDirectory = join(process.cwd(), "knowledge", "session-surface-coexistence")
const resultsJsonPath = join(resultsDirectory, "coexistence-spike-results.json")
const resultsMarkdownPath = join(resultsDirectory, "coexistence-spike-results.md")

const hostDebugSpikeDirectory = join(process.cwd(), "src", "spikes", "lldb-python-bridge")
const hostDebugTargetSourcePath = join(hostDebugSpikeDirectory, "target.c")
const hostDebugEntitlementsPath = join(hostDebugSpikeDirectory, "debuggee-entitlements.plist")

const overlapDelayMs = 2_000
const pauseSettlingDelayMs = 500
const hostDebugTargetStartupDelayMs = 1_000
const hostDebugTargetShutdownTimeoutMs = 3_000

const sameTargetDebuggerWall = [
  "The current Probe LLDB session surface only exposes external-host-process attach.",
  "The validated LLDB proof in knowledge/lldb-python/ is a signed local macOS process, not the simulator fixture app.",
  "Runner + LLDB same-target coexistence therefore remains an explicit hard wall for this spike.",
].join(" ")

type SerializedFailure =
  | ProbeFailurePayload
  | {
      readonly category: "unexpected" | "debug-command" | "health-check" | "command"
      readonly reason: string
    }

type OperationResult =
  | {
      readonly ok: true
      readonly elapsedMs: number
      readonly value: unknown
    }
  | {
      readonly ok: false
      readonly elapsedMs: number
      readonly error: SerializedFailure
      readonly observed?: unknown
    }

interface HostDebugBinary {
  readonly binaryPath: string
  readonly workDirectory: string
  readonly compileCommand: string
  readonly codesignCommand: string
  readonly compileStdout: string
  readonly compileStderr: string
  readonly codesignStdout: string
  readonly codesignStderr: string
  readonly entitlementsDump: string
}

interface HostDebugTargetHandle {
  readonly binaryPath: string
  readonly child: ChildProcess
  readonly pid: number
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

const runCommand = async (command: string, commandArgs: ReadonlyArray<string>) =>
  await new Promise<{ readonly stdout: string; readonly stderr: string; readonly exitCode: number | null }>((resolve, reject) => {
    const child = spawn(command, [...commandArgs], {
      cwd: process.cwd(),
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
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

const requireSuccessfulCommand = (
  label: string,
  command: string,
  result: { readonly stdout: string; readonly stderr: string; readonly exitCode: number | null },
) => {
  if (result.exitCode === 0) {
    return result
  }

  throw new Error(
    `${label} failed (${command}) with exit code ${result.exitCode ?? "unknown"}\n${result.stdout}${result.stderr}`,
  )
}

const serializeUnknownError = (error: unknown): SerializedFailure =>
  isProbeError(error)
    ? toFailurePayload(error)
    : {
        category: "unexpected",
        reason: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      }

const summarizeHealth = (health: SessionHealth) => ({
  sessionId: health.sessionId,
  state: health.state,
  artifactRoot: health.artifactRoot,
  wrapperRunning: health.healthCheck.wrapperRunning,
  pingRttMs: health.healthCheck.pingRttMs,
  lastCommand: health.healthCheck.lastCommand,
  lastOk: health.healthCheck.lastOk,
  runnerProcessId: isLiveRunnerDetails(health.runner) ? health.runner.fixtureProcessId : null,
  coordination: health.coordination,
  debugger: {
    attachState: health.debugger.attachState,
    targetScope: health.debugger.targetScope,
    attachedPid: health.debugger.attachedPid,
    processState: health.debugger.processState,
    stopId: health.debugger.stopId,
    stopReason: health.debugger.stopReason,
    stopDescription: health.debugger.stopDescription,
    lastCommand: health.debugger.lastCommand,
    lastCommandOk: health.debugger.lastCommandOk,
  },
})

const requireRunnerPid = (health: SessionHealth): number => {
  if (!isLiveRunnerDetails(health.runner)) {
    throw new Error("Expected a simulator runner-backed session for this spike.")
  }

  return health.runner.fixtureProcessId
}

const summarizeSnapshot = (snapshot: SessionSnapshotResult) => ({
  summary: snapshot.summary,
  snapshotId: snapshot.snapshotId,
  artifactPath: snapshot.artifact.absolutePath,
  nodeCount: snapshot.metrics.nodeCount,
  interactiveNodeCount: snapshot.metrics.interactiveNodeCount,
  weakIdentityNodeCount: snapshot.metrics.weakIdentityNodeCount,
  diffKind: snapshot.diff.kind,
})

const summarizePerfRecord = (result: PerfRecordResult) => ({
  template: result.template,
  templateName: result.templateName,
  timeLimit: result.timeLimit,
  recordedAt: result.recordedAt,
  xctraceVersion: result.xctraceVersion,
  session: result.session,
  summary: result.summary,
  diagnoses: result.diagnoses.map((diagnosis) => ({
    code: diagnosis.code,
    severity: diagnosis.severity,
    summary: diagnosis.summary,
    wall: diagnosis.wall,
    details: diagnosis.details,
  })),
  artifacts: {
    trace: result.artifacts.trace.absolutePath,
    toc: result.artifacts.toc.absolutePath,
    exports: result.artifacts.exports.map((artifact) => ({
      key: artifact.key,
      label: artifact.label,
      path: artifact.absolutePath,
      summary: artifact.summary,
    })),
  },
})

const summarizeDebugResult = (result: DebugCommandResult) => ({
  summary: result.summary,
  command: result.command,
  commandOk: result.debugger.lastCommandOk,
  outputKind: result.output.kind,
  coordination: result.coordination,
  debugger: {
    attachState: result.debugger.attachState,
    targetScope: result.debugger.targetScope,
    attachedPid: result.debugger.attachedPid,
    processState: result.debugger.processState,
    stopId: result.debugger.stopId,
    stopReason: result.debugger.stopReason,
    stopDescription: result.debugger.stopDescription,
    lastCommand: result.debugger.lastCommand,
    lastCommandOk: result.debugger.lastCommandOk,
  },
})

const timed = async (operation: () => Promise<unknown>): Promise<OperationResult> => {
  const startedAt = Date.now()

  try {
    const value = await operation()
    return {
      ok: true,
      elapsedMs: Date.now() - startedAt,
      value,
    }
  } catch (error) {
    return {
      ok: false,
      elapsedMs: Date.now() - startedAt,
      error: serializeUnknownError(error),
    }
  }
}

const timedSummary = async <T>(operation: () => Promise<T>, summarize: (value: T) => unknown): Promise<OperationResult> => {
  const result = await timed(operation)

  if (!result.ok) {
    return result
  }

  return {
    ...result,
    value: summarize(result.value as T),
  }
}

const timedHealthSummary = async (operation: () => Promise<SessionHealth>): Promise<OperationResult> => {
  const startedAt = Date.now()

  try {
    const health = await operation()
    const summary = summarizeHealth(health)

    if (!health.healthCheck.wrapperRunning || health.healthCheck.lastOk === false) {
      return {
        ok: false,
        elapsedMs: Date.now() - startedAt,
        error: {
          category: "health-check",
          reason: `Session health ping reported wrapperRunning=${health.healthCheck.wrapperRunning} lastOk=${health.healthCheck.lastOk} state=${health.state}.`,
        },
        observed: summary,
      }
    }

    return {
      ok: true,
      elapsedMs: Date.now() - startedAt,
      value: summary,
    }
  } catch (error) {
    return {
      ok: false,
      elapsedMs: Date.now() - startedAt,
      error: serializeUnknownError(error),
    }
  }
}

const timedDebugSummary = async (operation: () => Promise<DebugCommandResult>): Promise<OperationResult> => {
  const startedAt = Date.now()

  try {
    const result = await operation()
    const summary = summarizeDebugResult(result)

    if (result.debugger.lastCommandOk !== true) {
      return {
        ok: false,
        elapsedMs: Date.now() - startedAt,
        error: {
          category: "debug-command",
          reason: result.summary,
        },
        observed: summary,
      }
    }

    return {
      ok: true,
      elapsedMs: Date.now() - startedAt,
      value: summary,
    }
  } catch (error) {
    return {
      ok: false,
      elapsedMs: Date.now() - startedAt,
      error: serializeUnknownError(error),
    }
  }
}

const renderOperation = (label: string, result: OperationResult): Array<string> => {
  if (!result.ok) {
    return [
      `- ${label}: failed in ${result.elapsedMs} ms`,
      `  - ${result.error.category}: ${result.error.reason}`,
    ]
  }

  return [`- ${label}: ok in ${result.elapsedMs} ms`]
}

const sendSignal = (pid: number, signal: NodeJS.Signals) => {
  process.kill(pid, signal)
  return {
    pid,
    signal,
    sentAt: new Date().toISOString(),
  }
}

const waitForPidExit = async (pid: number, timeoutMs: number): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0)
      await delay(50)
    } catch {
      return true
    }
  }

  return false
}

const prepareHostDebugBinary = async (): Promise<HostDebugBinary> => {
  const workDirectory = await mkdtemp(join(tmpdir(), "probe-coexistence-lldb-"))
  const binaryPath = join(workDirectory, "probe-lldb-target")
  const compileArgs = [
    "clang",
    "-g",
    "-O0",
    "-fno-omit-frame-pointer",
    hostDebugTargetSourcePath,
    "-o",
    binaryPath,
  ]

  const compile = requireSuccessfulCommand(
    "compile host debug target",
    `xcrun ${compileArgs.join(" ")}`,
    await runCommand("xcrun", compileArgs),
  )
  const codesignArgs = [
    "--force",
    "--sign",
    "-",
    "--entitlements",
    hostDebugEntitlementsPath,
    binaryPath,
  ]
  const codesign = requireSuccessfulCommand(
    "codesign host debug target",
    `codesign ${codesignArgs.join(" ")}`,
    await runCommand("codesign", codesignArgs),
  )
  const entitlementsDump = requireSuccessfulCommand(
    "dump host debug target entitlements",
    `codesign -d --entitlements :- ${binaryPath}`,
    await runCommand("codesign", ["-d", "--entitlements", ":-", binaryPath]),
  )

  return {
    binaryPath,
    workDirectory,
    compileCommand: `xcrun ${compileArgs.join(" ")}`,
    codesignCommand: `codesign ${codesignArgs.join(" ")}`,
    compileStdout: compile.stdout,
    compileStderr: compile.stderr,
    codesignStdout: codesign.stdout,
    codesignStderr: codesign.stderr,
    entitlementsDump: entitlementsDump.stdout || entitlementsDump.stderr,
  }
}

const launchHostDebugTarget = async (binaryPath: string): Promise<HostDebugTargetHandle> => {
  const child = spawn(binaryPath, [], {
    cwd: process.cwd(),
    stdio: "ignore",
  })

  if (child.pid === undefined) {
    throw new Error(`Host debug target ${binaryPath} did not expose a pid.`)
  }

  await delay(hostDebugTargetStartupDelayMs)

  return {
    binaryPath,
    child,
    pid: child.pid,
  }
}

const stopHostDebugTarget = async (target: HostDebugTargetHandle) => {
  if (target.child.exitCode !== null || target.child.killed) {
    return
  }

  target.child.kill("SIGTERM")
  const exitedAfterTerm = await waitForPidExit(target.pid, hostDebugTargetShutdownTimeoutMs)

  if (!exitedAfterTerm && target.child.exitCode === null && !target.child.killed) {
    target.child.kill("SIGKILL")
    await waitForPidExit(target.pid, hostDebugTargetShutdownTimeoutMs)
  }
}

const withHostDebugTarget = async <T>(binaryPath: string, run: (target: HostDebugTargetHandle) => Promise<T>) => {
  const target = await launchHostDebugTarget(binaryPath)

  try {
    return await run(target)
  } finally {
    await stopHostDebugTarget(target)
  }
}

const main = async () => {
  const tooling = {
    xcodebuild: await runCommand("xcodebuild", ["-version"]),
    xctrace: await runCommand("xcrun", ["xctrace", "version"]),
    lldb: await runCommand("xcrun", ["lldb", "--version"]),
  }

  const hostDebugBinary = await prepareHostDebugBinary()

  const services = await probeRuntime.runPromise(Effect.gen(function* () {
    return {
      sessionRegistry: yield* SessionRegistry,
      perfService: yield* PerfService,
    }
  }))

  const openSession = () =>
    probeRuntime.runPromise(
      services.sessionRegistry.openSimulatorSession({
        bundleId: "dev.probe.fixture",
        simulatorUdid: null,
        rootDir: process.cwd(),
        emitProgress: () => undefined,
      }),
    )

  const closeSession = (sessionId: string) =>
    probeRuntime.runPromise(services.sessionRegistry.closeSession(sessionId)).catch(() => undefined)

  const getSessionHealth = (sessionId: string) =>
    probeRuntime.runPromise(services.sessionRegistry.getSessionHealth(sessionId))

  const captureSnapshot = (sessionId: string) =>
    probeRuntime.runPromise(
      services.sessionRegistry.captureSnapshot({
        sessionId,
        outputMode: "inline",
      }),
    )

  const attachExternalDebugger = (sessionId: string, pid: number) =>
    probeRuntime.runPromise(
      services.sessionRegistry.runDebugCommand({
        sessionId,
        outputMode: "inline",
        command: {
          command: "attach",
          targetScope: "external-host-process",
          pid,
        },
      }),
    )

  const captureBacktrace = (sessionId: string) =>
    probeRuntime.runPromise(
      services.sessionRegistry.runDebugCommand({
        sessionId,
        outputMode: "inline",
        command: {
          command: "backtrace",
          threadIndexId: null,
          frameLimit: 8,
        },
      }),
    )

  const detachDebugger = (sessionId: string) =>
    probeRuntime.runPromise(
      services.sessionRegistry.runDebugCommand({
        sessionId,
        outputMode: "inline",
        command: {
          command: "detach",
        },
      }),
    )

  const recordTimeProfiler = (sessionId: string) =>
    probeRuntime.runPromise(
      services.perfService.record({
        sessionId,
        template: "time-profiler",
        timeLimit: "3s",
        emitProgress: () => undefined,
      }),
    )

  const withSession = async <T>(label: string, run: (health: SessionHealth) => Promise<T>) => {
    const opened = await openSession()

    try {
      return await run(opened)
    } finally {
      await closeSession(opened.sessionId)
      console.error(`[cleanup] closed ${label} session ${opened.sessionId}`)
    }
  }

  const runnerAndXctrace = await withSession("runner+xctrace", async (opened) => {
    const baselineHealth = summarizeHealth(opened)
    const baselineSnapshot = await timedSummary(() => captureSnapshot(opened.sessionId), summarizeSnapshot)

    const perfPromise = timedSummary(() => recordTimeProfiler(opened.sessionId), summarizePerfRecord)
    await delay(overlapDelayMs)

    const snapshotDuringRecord = await timedSummary(() => captureSnapshot(opened.sessionId), summarizeSnapshot)
    const healthDuringRecord = await timedHealthSummary(() => getSessionHealth(opened.sessionId))
    const perfRecord = await perfPromise
    const postRecordSnapshot = await timedSummary(() => captureSnapshot(opened.sessionId), summarizeSnapshot)

    return {
      scope: "same-target-simulator-session",
      baselineHealth,
      baselineSnapshot,
      snapshotDuringRecord,
      healthDuringRecord,
      perfRecord,
      postRecordSnapshot,
    }
  })

  const pausedSnapshot = await withSession("paused-target-snapshot", async (opened) => {
    const baselineSnapshot = await timedSummary(() => captureSnapshot(opened.sessionId), summarizeSnapshot)
    const targetPid = requireRunnerPid(opened)
    const pauseSignal = sendSignal(targetPid, "SIGSTOP")
    await delay(pauseSettlingDelayMs)

    try {
      const snapshotWhilePaused = await timedSummary(() => captureSnapshot(opened.sessionId), summarizeSnapshot)

      return {
        targetPid,
        pauseSignal,
        baselineSnapshot,
        snapshotWhilePaused,
      }
    } finally {
      try {
        sendSignal(targetPid, "SIGCONT")
      } catch {
        // ignore cleanup signal failures
      }
    }
  })

  const pausedHealth = await withSession("paused-target-health", async (opened) => {
    const baselineHealth = summarizeHealth(opened)
    const targetPid = requireRunnerPid(opened)
    const pauseSignal = sendSignal(targetPid, "SIGSTOP")
    await delay(pauseSettlingDelayMs)

    try {
      const healthWhilePaused = await timedHealthSummary(() => getSessionHealth(opened.sessionId))

      return {
        targetPid,
        pauseSignal,
        baselineHealth,
        healthWhilePaused,
      }
    } finally {
      try {
        sendSignal(targetPid, "SIGCONT")
      } catch {
        // ignore cleanup signal failures
      }
    }
  })

  const runnerAndLldb = await withSession("runner+lldb", async (opened) =>
    await withHostDebugTarget(hostDebugBinary.binaryPath, async (target) => {
      const baselineHealth = summarizeHealth(opened)
      const baselineSnapshot = await timedSummary(() => captureSnapshot(opened.sessionId), summarizeSnapshot)
      const attach = await timedDebugSummary(() => attachExternalDebugger(opened.sessionId, target.pid))
      const backtrace = attach.ok
        ? await timedDebugSummary(() => captureBacktrace(opened.sessionId))
        : null
      const snapshotWhileExternalTargetStopped = await timedSummary(
        () => captureSnapshot(opened.sessionId),
        summarizeSnapshot,
      )
      const healthWhileExternalTargetStopped = await timedHealthSummary(() => getSessionHealth(opened.sessionId))
      const detach = attach.ok
        ? await timedDebugSummary(() => detachDebugger(opened.sessionId))
        : null
      const postDetachSnapshot = attach.ok
        ? await timedSummary(() => captureSnapshot(opened.sessionId), summarizeSnapshot)
        : null

      return {
        scope: "split-target-only",
        sameTargetWall: sameTargetDebuggerWall,
        externalDebugTarget: {
          pid: target.pid,
          binaryPath: target.binaryPath,
        },
        baselineHealth,
        baselineSnapshot,
        attach,
        backtrace,
        snapshotWhileExternalTargetStopped,
        healthWhileExternalTargetStopped,
        detach,
        postDetachSnapshot,
      }
    }),
  )

  const allThree = await withSession("runner+xctrace+lldb", async (opened) =>
    await withHostDebugTarget(hostDebugBinary.binaryPath, async (target) => {
      const baselineHealth = summarizeHealth(opened)
      const perfPromise = timedSummary(() => recordTimeProfiler(opened.sessionId), summarizePerfRecord)
      await delay(overlapDelayMs)

      const attach = await timedDebugSummary(() => attachExternalDebugger(opened.sessionId, target.pid))
      const backtrace = attach.ok
        ? await timedDebugSummary(() => captureBacktrace(opened.sessionId))
        : null
      const snapshotDuringOverlap = await timedSummary(() => captureSnapshot(opened.sessionId), summarizeSnapshot)
      const healthDuringOverlap = await timedHealthSummary(() => getSessionHealth(opened.sessionId))
      const perfRecord = await perfPromise
      const detach = attach.ok
        ? await timedDebugSummary(() => detachDebugger(opened.sessionId))
        : null
      const postRecordSnapshot = await timedSummary(() => captureSnapshot(opened.sessionId), summarizeSnapshot)

      return {
        scope: "split-target-only",
        sameTargetWall: sameTargetDebuggerWall,
        externalDebugTarget: {
          pid: target.pid,
          binaryPath: target.binaryPath,
        },
        baselineHealth,
        attach,
        backtrace,
        snapshotDuringOverlap,
        healthDuringOverlap,
        perfRecord,
        detach,
        postRecordSnapshot,
      }
    }),
  )

  const runnerAndXctraceViable = runnerAndXctrace.snapshotDuringRecord.ok
    && runnerAndXctrace.healthDuringRecord.ok
    && runnerAndXctrace.perfRecord.ok
  const pausedSnapshotBlocked = !pausedSnapshot.snapshotWhilePaused.ok
  const pausedHealthBlocked = !pausedHealth.healthWhilePaused.ok
  const runnerAndLldbSplitTargetViable = runnerAndLldb.attach.ok
    && runnerAndLldb.backtrace?.ok === true
    && runnerAndLldb.snapshotWhileExternalTargetStopped.ok
    && runnerAndLldb.healthWhileExternalTargetStopped.ok
  const allThreeSplitTargetViable = allThree.attach.ok
    && allThree.backtrace?.ok === true
    && allThree.snapshotDuringOverlap.ok
    && allThree.healthDuringOverlap.ok
    && allThree.perfRecord.ok

  const coordinationPolicy = {
    runnerAndXctrace: runnerAndXctraceViable
      ? "Allow runner-backed snapshot/action work while Time Profiler records on the same simulator session target. Keep this as the current supported coexistence mode for runner + xctrace."
      : "Do not claim runner + xctrace coexistence until the failing overlap step is resolved on the simulator fixture path.",
    pausedSessionApp: pausedSnapshotBlocked && pausedHealthBlocked
      ? "When the session app is paused, runner-backed snapshot and health ping requests time out at the runner command boundary. Probe should fail closed for runner-backed snapshot/action/health work whenever it knows the session app is stopped, suspended, or crashed, instead of probing and waiting for the full timeout budget."
      : "Pause behavior did not show the expected runner timeout wall; inspect the recorded evidence before changing the current coordination assumptions.",
    runnerAndLldb: runnerAndLldbSplitTargetViable
      ? "Treat runner + LLDB as only partially supported today: viable when LLDB is attached to a separate external host process, but still blocked for same-target session-app attach until Probe has a proven simulator-app debug path."
      : "Do not claim runner + LLDB coexistence beyond the hard wall until the split-target overlap path is stable.",
    allThree: allThreeSplitTargetViable
      ? "Treat all-three overlap as partial only: runner + xctrace can share the session app while LLDB operates on a separate host process, but this is not proof of same-target triple coexistence."
      : "Do not claim all-three coexistence yet; the split-target overlap run itself did not stay clean on the validated local surfaces.",
  }

  const results = {
    generatedAt: new Date().toISOString(),
    outcome: runnerAndXctraceViable && runnerAndLldbSplitTargetViable && allThreeSplitTargetViable ? "partial" : "blocked",
    environment: {
      cwd: process.cwd(),
      platform: process.platform,
      arch: process.arch,
      tooling: {
        xcodebuild: tooling.xcodebuild.stdout.trim(),
        xctrace: tooling.xctrace.stdout.trim(),
        lldb: tooling.lldb.stdout.trim(),
      },
      hostDebugBinary: hostDebugBinary,
    },
    hardWalls: {
      sameTargetDebuggerWall,
      pauseMeasurementNote:
        "The current LLDB surface cannot yet pause the session app itself, so pause behavior was measured by sending SIGSTOP/SIGCONT directly to the simulator fixture process.",
    },
    scenarios: {
      runnerAndXctrace,
      pausedSnapshot,
      pausedHealth,
      runnerAndLldb,
      allThree,
    },
    coordinationPolicy,
  }

  const markdown = [
    "# Concurrent attachment coexistence spike results",
    "",
    `Generated: ${results.generatedAt}`,
    "",
    "## Environment",
    `- xcodebuild: ${results.environment.tooling.xcodebuild}`,
    `- xctrace: ${results.environment.tooling.xctrace}`,
    `- lldb: ${results.environment.tooling.lldb}`,
    `- host debug target: ${hostDebugBinary.binaryPath}`,
    "",
    "## runner + xctrace (same simulator session target)",
    ...renderOperation("baseline snapshot", runnerAndXctrace.baselineSnapshot),
    ...renderOperation("snapshot during Time Profiler", runnerAndXctrace.snapshotDuringRecord),
    ...renderOperation("health during Time Profiler", runnerAndXctrace.healthDuringRecord),
    ...renderOperation("Time Profiler record", runnerAndXctrace.perfRecord),
    ...renderOperation("post-record snapshot", runnerAndXctrace.postRecordSnapshot),
    "",
    "## paused session app (SIGSTOP/SIGCONT surrogate for same-target pause behavior)",
    ...renderOperation("baseline snapshot before SIGSTOP", pausedSnapshot.baselineSnapshot),
    ...renderOperation("snapshot while paused", pausedSnapshot.snapshotWhilePaused),
    ...renderOperation("health while paused", pausedHealth.healthWhilePaused),
    "",
    "## runner + LLDB (only current proven split-target path)",
    `- same-target wall: ${sameTargetDebuggerWall}`,
    ...renderOperation("attach external host process", runnerAndLldb.attach),
    ...(runnerAndLldb.backtrace ? renderOperation("backtrace external host process", runnerAndLldb.backtrace) : ["- backtrace external host process: skipped"]),
    ...renderOperation("snapshot while external target is stopped", runnerAndLldb.snapshotWhileExternalTargetStopped),
    ...renderOperation("health while external target is stopped", runnerAndLldb.healthWhileExternalTargetStopped),
    ...(runnerAndLldb.detach ? renderOperation("detach external host process", runnerAndLldb.detach) : ["- detach external host process: skipped"]),
    ...(runnerAndLldb.postDetachSnapshot ? renderOperation("post-detach snapshot", runnerAndLldb.postDetachSnapshot) : ["- post-detach snapshot: skipped"]),
    "",
    "## runner + xctrace + LLDB (split-target only)",
    `- same-target wall: ${sameTargetDebuggerWall}`,
    ...renderOperation("attach external host process during Time Profiler", allThree.attach),
    ...(allThree.backtrace ? renderOperation("backtrace during overlap", allThree.backtrace) : ["- backtrace during overlap: skipped"]),
    ...renderOperation("snapshot during overlap", allThree.snapshotDuringOverlap),
    ...renderOperation("health during overlap", allThree.healthDuringOverlap),
    ...renderOperation("Time Profiler record", allThree.perfRecord),
    ...(allThree.detach ? renderOperation("detach external host process", allThree.detach) : ["- detach external host process: skipped"]),
    ...renderOperation("post-record snapshot", allThree.postRecordSnapshot),
    "",
    "## Coordination policy",
    `- runner + xctrace: ${coordinationPolicy.runnerAndXctrace}`,
    `- paused session app: ${coordinationPolicy.pausedSessionApp}`,
    `- runner + LLDB: ${coordinationPolicy.runnerAndLldb}`,
    `- all three: ${coordinationPolicy.allThree}`,
    "",
  ].join("\n")

  await mkdir(resultsDirectory, { recursive: true })
  await writeFile(resultsJsonPath, `${JSON.stringify(results, null, 2)}\n`, "utf8")
  await writeFile(resultsMarkdownPath, `${markdown}\n`, "utf8")

  console.log(JSON.stringify({ resultsJsonPath, resultsMarkdownPath }, null, 2))

  await rm(hostDebugBinary.workDirectory, { recursive: true, force: true })
}

try {
  await main()
} finally {
  await probeRuntime.dispose()
}
