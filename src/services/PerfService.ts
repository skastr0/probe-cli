import { spawn } from "node:child_process"
import { createWriteStream } from "node:fs"
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { basename, join, relative } from "node:path"
import { Transform } from "node:stream"
import { pipeline } from "node:stream/promises"
import { Context, Effect, Fiber, Layer } from "effect"
import {
  PerfRecordResult,
  PerfTemplate,
  analyzeHangsTables,
  analyzeMetalSystemTraceTables,
  analyzeSystemTraceTables,
  analyzeSwiftConcurrencyTables,
  analyzeTimeProfilerTable,
  parsePerfTableExport,
  type PerfDiagnosis,
  type PerfSummary,
  type ParsedPerfTable,
} from "../domain/perf"
import type { ArtifactRecord } from "../domain/output"
import { isLiveRunnerDetails, type SessionHealth } from "../domain/session"
import {
  ChildProcessError,
  EnvironmentError,
  SessionNotFoundError,
  UnsupportedCapabilityError,
} from "../domain/errors"
import { ArtifactStore } from "./ArtifactStore"
import { SessionRegistry } from "./SessionRegistry"

const nowIso = (): string => new Date().toISOString()

const timestampForFile = (): string => nowIso().replace(/[:.]/g, "-")

const defaultCommandOverheadMs = 120_000
const recordingOverheadMs = 240_000
const recordingGracePeriodMs = 60_000
const runnerKeepaliveIntervalMs = 10_000
const maxPerfTimeLimitMs = 5 * 60_000
const mib = 1024 * 1024
const maxExportFileSizeBytes = 8 * mib
const rowTag = "<row>"
const rowTagTailLength = rowTag.length - 1

const formatBytes = (value: number): string => {
  if (value >= mib) {
    return `${(value / mib).toFixed(1)} MiB`
  }

  if (value >= 1024) {
    return `${(value / 1024).toFixed(1)} KiB`
  }

  return `${value} B`
}

const formatTimeLimitMs = (value: number): string => {
  if (value % 60_000 === 0) {
    return `${value / 60_000}m`
  }

  if (value % 1_000 === 0) {
    return `${value / 1_000}s`
  }

  return `${value}ms`
}

const countOccurrences = (source: string, token: string): number => {
  let count = 0
  let index = source.indexOf(token)

  while (index !== -1) {
    count += 1
    index = source.indexOf(token, index + token.length)
  }

  return count
}

interface CommandResult {
  readonly stdout: string
  readonly stderr: string
  readonly exitCode: number | null
}

interface ExportBudget {
  readonly maxBytes: number
  readonly maxRows: number
}

interface TemplateExportSpec {
  readonly schema: string
  readonly budget: ExportBudget
  readonly required?: boolean
}

interface StreamedCommandResult extends CommandResult {
  readonly bytesWritten: number
  readonly rowCount: number
}

export class ExportBudgetExceededError extends Error {
  readonly kind: "bytes" | "rows"
  readonly limit: number
  readonly observed: number

  constructor(args: {
    readonly kind: "bytes" | "rows"
    readonly limit: number
    readonly observed: number
  }) {
    super(
      args.kind === "bytes"
        ? `Export exceeded ${formatBytes(args.limit)}.`
        : `Export exceeded ${args.limit} rows.`,
    )
    this.name = "ExportBudgetExceededError"
    this.kind = args.kind
    this.limit = args.limit
    this.observed = args.observed
  }
}

class ExportBudgetTransform extends Transform {
  bytesWritten = 0
  rowCount = 0
  private trailingText = ""

  constructor(private readonly budget: ExportBudget) {
    super()
  }

  override _transform(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null, data?: Buffer | string) => void,
  ): void {
    const text = typeof chunk === "string" ? chunk : chunk.toString("utf8")
    this.bytesWritten += Buffer.byteLength(text, "utf8")

    if (this.bytesWritten > this.budget.maxBytes) {
      callback(
        new ExportBudgetExceededError({
          kind: "bytes",
          limit: this.budget.maxBytes,
          observed: this.bytesWritten,
        }),
      )
      return
    }

    const combined = `${this.trailingText}${text}`
    this.rowCount += countOccurrences(combined, rowTag)
    this.trailingText = combined.slice(-rowTagTailLength)

    if (this.rowCount > this.budget.maxRows) {
      callback(
        new ExportBudgetExceededError({
          kind: "rows",
          limit: this.budget.maxRows,
          observed: this.rowCount,
        }),
      )
      return
    }

    callback(null, chunk)
  }
}

interface TemplateSpec {
  readonly slug: PerfTemplate
  readonly displayName: string
  readonly xctraceTemplateName: string
  readonly exportSchemas: ReadonlyArray<TemplateExportSpec>
  readonly maxRecordingTimeLimitMs?: number
  readonly analyze: (tables: Record<string, ParsedPerfTable>, targetPid: number) => {
    readonly summary: PerfSummary
    readonly diagnoses: ReadonlyArray<PerfDiagnosis>
  }
}

const templateSpecs: Record<PerfTemplate, TemplateSpec> = {
  "time-profiler": {
    slug: "time-profiler",
    displayName: "Time Profiler",
    xctraceTemplateName: "Time Profiler",
    exportSchemas: [{
      schema: "time-sample",
      required: true,
      budget: {
        maxBytes: 4 * mib,
        maxRows: 20_000,
      },
    }],
    analyze: (tables) => analyzeTimeProfilerTable(tables["time-sample"]),
  },
  "system-trace": {
    slug: "system-trace",
    displayName: "System Trace",
    xctraceTemplateName: "System Trace",
    exportSchemas: [{
      schema: "thread-state",
      required: true,
      budget: {
        maxBytes: 2 * mib,
        maxRows: 8_000,
      },
    }, {
      schema: "cpu-state",
      required: true,
      budget: {
        maxBytes: 2 * mib,
        maxRows: 8_000,
      },
    }],
    maxRecordingTimeLimitMs: 10_000,
    analyze: (tables, targetPid) =>
      analyzeSystemTraceTables({
        threadStateTable: tables["thread-state"],
        cpuStateTable: tables["cpu-state"],
        targetPid,
      }),
  },
  "metal-system-trace": {
    slug: "metal-system-trace",
    displayName: "Metal System Trace",
    xctraceTemplateName: "Metal System Trace",
    exportSchemas: [{
      schema: "metal-gpu-intervals",
      required: true,
      budget: {
        maxBytes: 8 * mib,
        maxRows: 25_000,
      },
    }, {
      schema: "metal-driver-event-intervals",
      budget: {
        maxBytes: 4 * mib,
        maxRows: 12_000,
      },
    }, {
      schema: "metal-application-encoders-list",
      budget: {
        maxBytes: 4 * mib,
        maxRows: 12_000,
      },
    }],
    maxRecordingTimeLimitMs: 120_000,
    analyze: (tables) => analyzeMetalSystemTraceTables({
      gpuIntervalsTable: tables["metal-gpu-intervals"],
      driverEventTable: tables["metal-driver-event-intervals"],
      encoderListTable: tables["metal-application-encoders-list"],
    }),
  },
  hangs: {
    slug: "hangs",
    displayName: "Hangs",
    xctraceTemplateName: "Hangs",
    exportSchemas: [{
      schema: "potential-hangs",
      required: true,
      budget: {
        maxBytes: 2 * mib,
        maxRows: 4_000,
      },
    }, {
      schema: "hang-risks",
      budget: {
        maxBytes: 2 * mib,
        maxRows: 4_000,
      },
    }],
    analyze: (tables) => analyzeHangsTables({
      hangTable: tables["potential-hangs"],
      hangRiskTable: tables["hang-risks"],
    }),
  },
  "swift-concurrency": {
    slug: "swift-concurrency",
    displayName: "Swift Concurrency",
    xctraceTemplateName: "Swift Concurrency",
    exportSchemas: [{
      schema: "swift-task-state",
      required: true,
      budget: {
        maxBytes: 4 * mib,
        maxRows: 25_000,
      },
    }, {
      schema: "swift-task-lifetime",
      required: true,
      budget: {
        maxBytes: 3 * mib,
        maxRows: 20_000,
      },
    }, {
      schema: "swift-actor-execution",
      budget: {
        maxBytes: 2 * mib,
        maxRows: 10_000,
      },
    }],
    analyze: (tables) => analyzeSwiftConcurrencyTables({
      taskStateTable: tables["swift-task-state"],
      taskLifetimeTable: tables["swift-task-lifetime"],
      actorExecutionTable: tables["swift-actor-execution"],
    }),
  },
}

const parseTimeLimitMs = (timeLimit: string): number | null => {
  const match = timeLimit.match(/^(\d+)(ms|s|m|h)$/)

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

const fileExists = async (path: string): Promise<boolean> => {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

const ensureDirectory = async (path: string): Promise<void> => {
  await mkdir(path, { recursive: true })
}

const parseFirstRunNumber = (tocXml: string): string | null => {
  const match = tocXml.match(/<run[^>]*number="([^"]+)"/)
  return match?.[1] ?? null
}

const parseAvailableSchemaNames = (tocXml: string): ReadonlySet<string> =>
  new Set(
    [...tocXml.matchAll(/<(?:table|schema)\b[^>]*(?:schema|name)="([^"]+)"/g)]
      .map((match) => match[1]?.trim() ?? "")
      .filter((schema) => schema.length > 0),
  )

const runCommand = (args: {
  readonly command: string
  readonly commandArgs: ReadonlyArray<string>
  readonly timeoutMs: number
  readonly gracePeriodMs?: number
  readonly allowFailure?: boolean
}): Promise<CommandResult> =>
  new Promise((resolve, reject) => {
    const child = spawn(args.command, [...args.commandArgs], {
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    })

    let stdout = ""
    let stderr = ""
    let timedOut = false

    const timeout = setTimeout(() => {
      timedOut = true
      stopChildProcess(child, args.gracePeriodMs)
    }, args.timeoutMs)

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
      reject(
        new ChildProcessError({
          code: "command-spawn-failed",
          command: `${args.command} ${args.commandArgs.join(" ")}`,
          reason: error instanceof Error ? error.message : String(error),
          nextStep: "Verify the local toolchain installation and retry the command.",
          exitCode: null,
          stderrExcerpt: stderr.trim(),
        }),
      )
    })

    child.once("close", (code) => {
      clearTimeout(timeout)

      if (timedOut) {
        reject(
          new ChildProcessError({
            code: "command-timeout",
            command: `${args.command} ${args.commandArgs.join(" ")}`,
            reason: `${args.command} exceeded the ${args.timeoutMs} ms timeout window.`,
            nextStep: "Reduce the trace duration or inspect host load, then retry.",
            exitCode: code,
            stderrExcerpt: stderr.trim() || stdout.trim(),
          }),
        )
        return
      }

      const result = {
        stdout,
        stderr,
        exitCode: code,
      } satisfies CommandResult

      if (code === 0 || args.allowFailure) {
        resolve(result)
        return
      }

      reject(
        new ChildProcessError({
          code: "command-failed",
          command: `${args.command} ${args.commandArgs.join(" ")}`,
          reason: `${args.command} exited with code ${code ?? "unknown"}.`,
          nextStep: "Inspect stderr and the generated trace artifacts, then retry the request.",
          exitCode: code,
          stderrExcerpt: stderr.trim() || stdout.trim(),
        }),
      )
    })
  })

const cleanupOutputFile = async (path: string): Promise<void> => {
  await rm(path, { force: true }).catch(() => undefined)
}

const stopChildProcess = (
  child: ReturnType<typeof spawn>,
  gracePeriodMs = 2_000,
) => {
  child.kill("SIGTERM")
  setTimeout(() => {
    if (child.exitCode === null) {
      child.kill("SIGKILL")
    }
  }, gracePeriodMs)
}

const runCommandToFile = (args: {
  readonly command: string
  readonly commandArgs: ReadonlyArray<string>
  readonly timeoutMs: number
  readonly gracePeriodMs?: number
  readonly outputPath: string
  readonly budget: ExportBudget
}): Promise<StreamedCommandResult> =>
  new Promise((resolve, reject) => {
    const child = spawn(args.command, [...args.commandArgs], {
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    })

    const outputGuard = new ExportBudgetTransform(args.budget)
    const outputStream = createWriteStream(args.outputPath, { encoding: "utf8" })
    let stderr = ""
    let timedOut = false
    let pipelineError: unknown = null

    const timeout = setTimeout(() => {
      timedOut = true
      stopChildProcess(child, args.gracePeriodMs)
    }, args.timeoutMs)

    child.stderr?.setEncoding("utf8")
    child.stderr?.on("data", (chunk) => {
      stderr += chunk
    })

    const outputPromise = pipeline(child.stdout!, outputGuard, outputStream).catch((error) => {
      pipelineError = error
      stopChildProcess(child, args.gracePeriodMs)
    })

    child.once("error", (error) => {
      clearTimeout(timeout)

      void outputPromise.finally(() => {
        void cleanupOutputFile(args.outputPath).finally(() => {
          reject(
            new ChildProcessError({
              code: "command-spawn-failed",
              command: `${args.command} ${args.commandArgs.join(" ")}`,
              reason: error instanceof Error ? error.message : String(error),
              nextStep: "Verify the local toolchain installation and retry the command.",
              exitCode: null,
              stderrExcerpt: stderr.trim(),
            }),
          )
        })
      })
    })

    child.once("close", (code) => {
      clearTimeout(timeout)

      void outputPromise.finally(() => {
        if (timedOut) {
          void cleanupOutputFile(args.outputPath).finally(() => {
            reject(
              new ChildProcessError({
                code: "command-timeout",
                command: `${args.command} ${args.commandArgs.join(" ")}`,
                reason: `${args.command} exceeded the ${args.timeoutMs} ms timeout window.`,
                nextStep: "Reduce the trace duration or inspect host load, then retry.",
                exitCode: code,
                stderrExcerpt: stderr.trim(),
              }),
            )
          })
          return
        }

        if (pipelineError instanceof ExportBudgetExceededError) {
          void cleanupOutputFile(args.outputPath).finally(() => {
            reject(pipelineError)
          })
          return
        }

        if (pipelineError) {
          void cleanupOutputFile(args.outputPath).finally(() => {
            reject(pipelineError)
          })
          return
        }

        const result = {
          stdout: "",
          stderr,
          exitCode: code,
          bytesWritten: outputGuard.bytesWritten,
          rowCount: outputGuard.rowCount,
        } satisfies StreamedCommandResult

        if (code === 0) {
          resolve(result)
          return
        }

        void cleanupOutputFile(args.outputPath).finally(() => {
          reject(
            new ChildProcessError({
              code: "command-failed",
              command: `${args.command} ${args.commandArgs.join(" ")}`,
              reason: `${args.command} exited with code ${code ?? "unknown"}.`,
              nextStep: "Inspect stderr and the generated trace artifacts, then retry the request.",
              exitCode: code,
              stderrExcerpt: stderr.trim(),
            }),
          )
        })
      })
    })
  })

const parseTemplateNames = (stdout: string): ReadonlyArray<string> =>
  stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("=="))

const buildExportBudgetError = (args: {
  readonly templateName: string
  readonly schema: string
  readonly error: ExportBudgetExceededError
}): EnvironmentError =>
  new EnvironmentError({
    code: args.error.kind === "bytes" ? "perf-export-size-budget" : "perf-export-row-budget",
    reason:
      args.error.kind === "bytes"
        ? `${args.templateName} export for ${args.schema} exceeded Probe's current ${formatBytes(args.error.limit)} budget.`
        : `${args.templateName} export for ${args.schema} exceeded Probe's current ${args.error.limit}-row budget.`,
    nextStep:
      "Reduce --time-limit, prefer a narrower recording window, or inspect the saved .trace and TOC artifacts directly.",
    details: [
      `schema: ${args.schema}`,
      args.error.kind === "bytes"
        ? `observed: ${formatBytes(args.error.observed)}`
        : `observed rows: ${args.error.observed}`,
    ],
  })

const buildPostRecordSessionDiagnoses = (args: {
  readonly before: SessionHealth
  readonly after: SessionHealth
}): ReadonlyArray<PerfDiagnosis> => {
  if (args.after.state === "ready") {
    return []
  }

  const stateCode = args.after.state.replace(/[^a-z-]+/g, "-")
  const remainedInState = args.before.state === args.after.state
  const summary = args.after.state === "failed"
    ? (remainedInState
      ? "Perf recording completed while the session remained failed."
      : "Perf recording completed, but the session failed its post-record health check.")
    : args.after.state === "degraded"
      ? (remainedInState
        ? "Perf recording completed while the session remained degraded."
        : "Perf recording completed, but the session is degraded afterwards.")
      : `Perf recording completed, but the session is ${args.after.state} afterwards.`

  const details = [
    args.after.healthCheck.wrapperRunning
      ? "Runner wrapper is still running after recording."
      : "Runner wrapper is no longer running after recording.",
    args.after.healthCheck.lastOk === null
      ? "Post-record ping did not produce a success/failure result."
      : args.after.healthCheck.lastOk
        ? `Post-record ping succeeded${args.after.healthCheck.pingRttMs === null ? "." : ` in ${args.after.healthCheck.pingRttMs} ms.`}`
        : "Post-record ping failed.",
  ]

  if (args.after.coordination.runnerActionsBlocked) {
    details.push(args.after.coordination.reason ?? "Runner-backed actions are currently blocked.")
  }

  details.push("Treat the saved trace artifacts as valid, but reopen or restore a healthy session before more runner-backed commands.")

  return [{
    code: `perf-session-${stateCode}-after-record`,
    severity: "warning",
    summary,
    details,
    wall: false,
  }]
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

export class PerfService extends Context.Tag("@probe/PerfService")<
  PerfService,
  {
    readonly record: (args: {
      readonly sessionId: string
      readonly template: typeof PerfTemplate.Type
      readonly timeLimit: string
      readonly emitProgress: (stage: string, message: string) => void
    }) => Effect.Effect<
      typeof PerfRecordResult.Type,
      | EnvironmentError
      | SessionNotFoundError
      | UnsupportedCapabilityError
      | ChildProcessError
    >
  }
>() {}

interface PerfCommandRunner {
  readonly capture: (args: {
    readonly command: string
    readonly commandArgs: ReadonlyArray<string>
    readonly timeoutMs: number
    readonly gracePeriodMs?: number
    readonly allowFailure?: boolean
  }) => Promise<CommandResult>
  readonly exportToFile: (args: {
    readonly command: string
    readonly commandArgs: ReadonlyArray<string>
    readonly timeoutMs: number
    readonly gracePeriodMs?: number
    readonly outputPath: string
    readonly budget: ExportBudget
  }) => Promise<StreamedCommandResult>
}

interface PerfArtifactStoreAccess {
  readonly registerArtifact: (
    sessionId: string,
    record: ArtifactRecord,
  ) => Effect.Effect<ArtifactRecord, EnvironmentError>
}

interface PerfSessionRegistryAccess {
  readonly getSessionHealth: (sessionId: string) => Effect.Effect<SessionHealth, SessionNotFoundError | EnvironmentError>
  readonly sendRunnerKeepalive: (sessionId: string) => Effect.Effect<void, SessionNotFoundError | EnvironmentError>
}

const liveCommandRunner: PerfCommandRunner = {
  capture: runCommand,
  exportToFile: runCommandToFile,
}

export const createPerfService = (dependencies: {
  readonly artifactStore: PerfArtifactStoreAccess
  readonly sessionRegistry: PerfSessionRegistryAccess
  readonly commandRunner?: PerfCommandRunner
}) => {
  const commandRunner = dependencies.commandRunner ?? liveCommandRunner

  const record = ({ sessionId, template, timeLimit, emitProgress }: {
    readonly sessionId: string
    readonly template: PerfTemplate
    readonly timeLimit: string
    readonly emitProgress: (stage: string, message: string) => void
  }) =>
    Effect.gen(function* () {
      const spec = templateSpecs[template]
      const timeLimitMs = parseTimeLimitMs(timeLimit)

      if (timeLimitMs === null) {
        return yield* new EnvironmentError({
          code: "perf-invalid-time-limit",
          reason: `Unsupported xctrace time limit ${timeLimit}.`,
          nextStep: "Use a positive integer duration such as 500ms, 3s, 1m, or 5m.",
          details: [],
        })
      }

      const templateTimeLimitMs = spec.maxRecordingTimeLimitMs ?? maxPerfTimeLimitMs

      if (timeLimitMs > templateTimeLimitMs) {
        return yield* new EnvironmentError({
          code: spec.maxRecordingTimeLimitMs ? "perf-template-time-limit-too-large" : "perf-time-limit-too-large",
          reason: `Requested time limit ${timeLimit} exceeds the current ${spec.displayName} cap of ${formatTimeLimitMs(templateTimeLimitMs)}.`,
          nextStep: spec.maxRecordingTimeLimitMs
            ? `Use --time-limit ${formatTimeLimitMs(templateTimeLimitMs)} or less for ${spec.displayName}; larger exports are outside the current supported summary contract.`
            : "Keep perf recordings at 5m or less in this slice so RPC/session timeouts stay honest.",
          details: [],
        })
      }

      const sessionBeforeRecord = yield* dependencies.sessionRegistry.getSessionHealth(sessionId)

      if (!isLiveRunnerDetails(sessionBeforeRecord.runner)) {
        return yield* new UnsupportedCapabilityError({
          code: "perf-session-real-device-runner",
          capability: `perf.record.template.${template}`,
          reason: "The current session does not expose a live runner-backed target pid for perf recording.",
          nextStep: "Retry on a simulator-backed runner session, or wait for the real-device runner/perf seam to be validated.",
          details: [],
          wall: false,
        })
      }

      const runnerDetails = sessionBeforeRecord.runner

      if (
        !sessionBeforeRecord.healthCheck.wrapperRunning
        || (sessionBeforeRecord.state !== "ready" && sessionBeforeRecord.state !== "degraded")
      ) {
        return yield* new EnvironmentError({
          code: "perf-session-not-ready",
          reason: `Session ${sessionId} is ${sessionBeforeRecord.state} and cannot safely anchor a profiling request.`,
          nextStep: "Reopen a healthy session, then retry the profiling command.",
          details: [],
        })
      }

      emitProgress("perf.record", `Checking xctrace template availability for ${spec.displayName}.`)

      const templateList = yield* Effect.tryPromise({
        try: () =>
          commandRunner.capture({
            command: "xcrun",
            commandArgs: ["xctrace", "list", "templates"],
            timeoutMs: defaultCommandOverheadMs,
          }),
        catch: (error) =>
          error instanceof ChildProcessError
            ? error
            : new EnvironmentError({
                code: "perf-template-list",
                reason: error instanceof Error ? error.message : String(error),
                nextStep: "Verify the local Xcode toolchain and retry template discovery.",
                details: [],
              }),
      })

      const availableTemplates = new Set(parseTemplateNames(templateList.stdout))

      if (!availableTemplates.has(spec.xctraceTemplateName)) {
        return yield* new UnsupportedCapabilityError({
          code: "perf-template-unavailable",
          capability: `perf.record.template.${template}`,
          reason: `The local xctrace installation does not expose the ${spec.xctraceTemplateName} template required for ${spec.displayName}.`,
          nextStep: "Run `xcrun xctrace list templates`, then choose a supported template or update Xcode.",
          details: [],
          wall: false,
        })
      }

      const xctraceVersionResult = yield* Effect.tryPromise({
        try: () =>
          commandRunner.capture({
            command: "xcrun",
            commandArgs: ["xctrace", "version"],
            timeoutMs: defaultCommandOverheadMs,
          }),
        catch: (error) =>
          error instanceof ChildProcessError
            ? error
            : new EnvironmentError({
                code: "perf-xctrace-version",
                reason: error instanceof Error ? error.message : String(error),
                nextStep: "Verify xctrace is installed and retry the profiling command.",
                details: [],
              }),
      })

      const tracesDirectory = join(sessionBeforeRecord.artifactRoot, "traces")
      const baseName = `${timestampForFile()}-${spec.slug}`
      const tracePath = join(tracesDirectory, `${baseName}.trace`)
      const tocPath = join(tracesDirectory, `${baseName}.toc.xml`)

      yield* Effect.tryPromise({
        try: () => ensureDirectory(tracesDirectory),
        catch: (error) =>
          new EnvironmentError({
            code: "perf-traces-directory",
            reason: error instanceof Error ? error.message : String(error),
            nextStep: "Check the session artifact root permissions and retry the profiling command.",
            details: [],
          }),
      })

      emitProgress(
        "perf.record",
        `Recording ${spec.displayName} for pid ${runnerDetails.targetProcessId} on device ${sessionBeforeRecord.target.deviceId}.`,
      )

      const keepaliveFiber = yield* Effect.gen(function* () {
        yield* Effect.sleep(runnerKeepaliveIntervalMs)
        yield* dependencies.sessionRegistry.sendRunnerKeepalive(sessionId)
      }).pipe(
        Effect.catchAll((error) =>
          Effect.sync(() => {
            emitProgress("perf.record", `Runner keepalive failed: ${error instanceof Error ? error.message : String(error)}`)
          })
        ),
        Effect.forever,
        Effect.fork,
      )

      yield* Effect.tryPromise({
        try: () =>
          commandRunner.capture({
            command: "xcrun",
            commandArgs: [
              "xctrace",
              "record",
              "--template",
              spec.xctraceTemplateName,
              "--device",
              sessionBeforeRecord.target.deviceId,
              "--attach",
              String(runnerDetails.targetProcessId),
              "--time-limit",
              timeLimit,
              "--output",
              tracePath,
              "--run-name",
              baseName,
              "--no-prompt",
            ],
            timeoutMs: timeLimitMs + recordingOverheadMs,
            gracePeriodMs: recordingGracePeriodMs,
          }),
        catch: (error) =>
          error instanceof ChildProcessError
            ? error
            : new EnvironmentError({
                code: "perf-record-command",
                reason: error instanceof Error ? error.message : String(error),
                nextStep: "Inspect xctrace stderr and retry the profiling command.",
                details: [],
              }),
      }).pipe(
        Effect.ensuring(Fiber.interrupt(keepaliveFiber)),
      )

      const traceExists = yield* Effect.tryPromise({
        try: () => fileExists(tracePath),
        catch: (error) =>
          new EnvironmentError({
            code: "perf-trace-stat",
            reason: error instanceof Error ? error.message : String(error),
            nextStep: "Inspect the traces directory and retry the profiling command.",
            details: [],
          }),
      })

      if (!traceExists) {
        return yield* new EnvironmentError({
          code: "perf-trace-missing",
          reason: `xctrace completed without creating the expected trace bundle at ${tracePath}.`,
          nextStep: "Inspect the xctrace output and retry the profiling command.",
          details: [],
        })
      }

      const traceArtifact = yield* dependencies.artifactStore.registerArtifact(
        sessionId,
        createArtifactRecord({
          artifactRoot: sessionBeforeRecord.artifactRoot,
          key: `${baseName}-trace`,
          label: `${spec.slug}-trace`,
          kind: "directory",
          absolutePath: tracePath,
          summary: `${spec.displayName} raw .trace bundle.`,
        }),
      )

      emitProgress("perf.record", `Refreshing session health after recording ${spec.displayName}.`)
      const sessionAfterRecord = yield* dependencies.sessionRegistry.getSessionHealth(sessionId)

      emitProgress("perf.export", `Exporting TOC for ${basename(tracePath)}.`)

      const tocResult = yield* Effect.tryPromise({
        try: () =>
          commandRunner.capture({
            command: "xcrun",
            commandArgs: ["xctrace", "export", "--input", tracePath, "--toc"],
            timeoutMs: defaultCommandOverheadMs,
          }),
        catch: (error) =>
          error instanceof ChildProcessError
            ? error
            : new EnvironmentError({
                code: "perf-export-toc",
                reason: error instanceof Error ? error.message : String(error),
                nextStep: "Inspect the saved trace bundle and retry the TOC export.",
                details: [],
              }),
      })

      yield* Effect.tryPromise({
        try: () => writeFile(tocPath, tocResult.stdout, "utf8"),
        catch: (error) =>
          new EnvironmentError({
            code: "perf-write-toc",
            reason: error instanceof Error ? error.message : String(error),
            nextStep: "Check write access to the session traces directory and retry the profiling command.",
            details: [],
          }),
      })

      const tocArtifact = yield* dependencies.artifactStore.registerArtifact(
        sessionId,
        createArtifactRecord({
          artifactRoot: sessionBeforeRecord.artifactRoot,
          key: `${baseName}-toc`,
          label: `${spec.slug}-toc`,
          kind: "xml",
          absolutePath: tocPath,
          summary: `${spec.displayName} TOC export.`,
        }),
      )

      const runNumber = parseFirstRunNumber(tocResult.stdout)

      if (!runNumber) {
        return yield* new EnvironmentError({
          code: "perf-run-number-missing",
          reason: `Could not resolve a run number from ${basename(tocPath)}.`,
          nextStep: "Inspect the TOC export and retry the profiling command.",
          details: [],
        })
      }

      const exportArtifacts: Array<ArtifactRecord> = []
      const parsedTables: Record<string, ParsedPerfTable> = {}
      const availableSchemas = parseAvailableSchemaNames(tocResult.stdout)
      const tocAdvertisesSchemas = availableSchemas.size > 0

      for (const exportSpec of spec.exportSchemas) {
        if (tocAdvertisesSchemas && !availableSchemas.has(exportSpec.schema)) {
          if (exportSpec.required) {
            return yield* new EnvironmentError({
              code: "perf-export-schema-missing",
              reason: `${spec.displayName} TOC did not expose the expected ${exportSpec.schema} schema.`,
              nextStep: "Inspect the saved TOC export and align Probe's supported schema contract before retrying.",
              details: [...availableSchemas].sort(),
            })
          }

          continue
        }

        const { schema, budget } = exportSpec
        const exportPath = join(tracesDirectory, `${baseName}.${schema}.xml`)
        emitProgress(
          "perf.export",
          `Exporting ${schema} rows for ${spec.displayName} (budget ${budget.maxRows} rows / ${formatBytes(budget.maxBytes)}).`,
        )

        const exportResult = yield* Effect.tryPromise({
          try: () =>
            commandRunner.exportToFile({
              command: "xcrun",
              commandArgs: [
                "xctrace",
                "export",
                "--input",
                tracePath,
                "--xpath",
                `/trace-toc/run[@number=\"${runNumber}\"]/data/table[@schema=\"${schema}\"]`,
              ],
              timeoutMs: defaultCommandOverheadMs,
              outputPath: exportPath,
              budget,
            }),
          catch: (error) =>
            error instanceof ChildProcessError
              ? error
              : error instanceof ExportBudgetExceededError
                ? buildExportBudgetError({ templateName: spec.displayName, schema, error })
                : new EnvironmentError({
                    code: "perf-export-schema",
                    reason: error instanceof Error ? error.message : String(error),
                    nextStep: `Inspect the TOC export and retry the ${schema} export.`,
                    details: [],
                  }),
        })

        const artifact = yield* dependencies.artifactStore.registerArtifact(
          sessionId,
          createArtifactRecord({
            artifactRoot: sessionBeforeRecord.artifactRoot,
            key: `${baseName}-${schema}`,
            label: `${spec.slug}-${schema}`,
            kind: "xml",
            absolutePath: exportPath,
            summary: `${schema} export for ${spec.displayName} (${exportResult.rowCount} rows, ${formatBytes(exportResult.bytesWritten)}).`,
          }),
        )

        exportArtifacts.push(artifact)

        // Memory amplification check: verify export file size before loading
        let maybeOversized: EnvironmentError | undefined
        try {
          const { statSync } = require("node:fs")
          const s = statSync(exportPath)
          if (s.size > maxExportFileSizeBytes) {
            maybeOversized = new EnvironmentError({
              code: "perf-export-file-too-large",
              reason: `${spec.displayName} ${schema} export file (${formatBytes(s.size)}) exceeds the ${formatBytes(maxExportFileSizeBytes)} parse limit.`,
              nextStep: "Reduce --time-limit or use a narrower recording window; inspect the saved .trace directly for full data.",
              details: [`schema: ${schema}`, `file: ${exportPath}`, `size: ${s.size}`],
            })
          }
        } catch {
          // File stat failed; let downstream readFile fail with a better error
        }

        if (maybeOversized !== undefined) {
          return yield* Effect.fail(maybeOversized)
        }

        const exportXml = yield* Effect.tryPromise({
          try: () => readFile(exportPath, "utf8"),
          catch: (error) =>
            new EnvironmentError({
              code: "perf-read-schema-export",
              reason: error instanceof Error ? error.message : String(error),
              nextStep: `Inspect the saved ${schema} export XML and retry the profiling command.`,
              details: [],
            }),
        })

        parsedTables[schema] = yield* Effect.try({
          try: () => parsePerfTableExport(exportXml),
          catch: (error) =>
            new EnvironmentError({
              code: "perf-parse-export",
              reason: error instanceof Error ? error.message : String(error),
              nextStep: `Inspect the saved ${schema} export XML and retry the profiling command.`,
              details: [],
            }),
        })
      }

      const analysis = yield* Effect.try({
        try: () => spec.analyze(parsedTables, runnerDetails.targetProcessId),
        catch: (error) =>
          new EnvironmentError({
            code: "perf-analyze-export-contract",
            reason: error instanceof Error ? error.message : String(error),
            nextStep: "Inspect the saved schema exports and align Probe's supported xctrace contract before retrying.",
            details: spec.exportSchemas.map((exportSpec) => exportSpec.schema),
          }),
      })

      return {
        sessionId,
        template,
        templateName: spec.displayName,
        timeLimit,
        recordedAt: nowIso(),
        xctraceVersion: xctraceVersionResult.stdout.trim(),
        session: {
          state: sessionAfterRecord.state,
          healthCheck: sessionAfterRecord.healthCheck,
        },
        summary: analysis.summary,
        diagnoses: [
          ...analysis.diagnoses,
          ...buildPostRecordSessionDiagnoses({
            before: sessionBeforeRecord,
            after: sessionAfterRecord,
          }),
        ],
        artifacts: {
          trace: traceArtifact,
          toc: tocArtifact,
          exports: exportArtifacts,
        },
      } satisfies typeof PerfRecordResult.Type
    })

  return PerfService.of({
    record,
  })
}

export const PerfServiceLive = Layer.effect(
  PerfService,
  Effect.gen(function* () {
    const artifactStore = yield* ArtifactStore
    const sessionRegistry = yield* SessionRegistry

    return createPerfService({
      artifactStore,
      sessionRegistry,
      commandRunner: liveCommandRunner,
    })
  }),
)
