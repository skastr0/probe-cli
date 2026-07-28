import { constants, createWriteStream, statSync } from "node:fs"
import { access, mkdir, open as openFile, readFile, rm, writeFile } from "node:fs/promises"
import { createHash } from "node:crypto"
import { basename, dirname, join, relative } from "node:path"
import { pipeline } from "node:stream/promises"
import { Cause, Context, Effect, Either, Exit, Fiber, Layer, Option } from "effect"
import { runAppleProcess, spawnAppleProcessHandle, type AppleProcessHandle } from "./AppleProcessSupervisor"
import { type ExportBudget, ExportBudgetExceededError, ExportBudgetTransform, formatBytes } from "./ArtifactExportPolicy"
import {
  PerfAnalyzeResult,
  PerfAroundFlowResult,
  PerfExportResult,
  PerfRecordResult,
  PerfSignpostSummaryResult,
  PerfTemplate,
  analyzeSignpostIntervalTable,
  analyzeHangsTables,
  analyzeMetalSystemTraceTables,
  summarizeSignpostIntervalsTable,
  analyzeSystemTraceTables,
  analyzeSwiftConcurrencyTables,
  analyzeTimeProfilerTable,
  applyCallstackSymbols,
  leafPcsFromTimeProfilerSummary,
  parsePerfTableExport,
  type CustomTemplateRef,
  type PerfAnalyzerName,
  type PerfDiagnosis,
  type PerfSummary,
  type ParsedPerfTable,
} from "../domain/perf"
import type { SessionFlowContract, SessionFlowResult } from "../domain/flow-v2"
import type { ArtifactRecord } from "../domain/output"
import { isLiveRunnerDetails, type SessionHealth } from "../domain/session"
import {
  ArtifactNotFoundError,
  ChildProcessError,
  EnvironmentError,
  SessionNotFoundError,
  UnsupportedCapabilityError,
  UserInputError,
} from "../domain/errors"
import { ArtifactStore } from "./ArtifactStore"
import { SessionRegistry, type TraceLeaseHandle, type TraceLeaseOutcome } from "./SessionRegistry"
import { verifyTargetProcessIdentity } from "./TargetProcessIdentity"
import { resolveAtosBinaryPath, symbolicateAddressesWithAtos } from "./AtosSymbolicate"

const nowIso = (): string => new Date().toISOString()

const timestampForFile = (): string => nowIso().replace(/[:.]/g, "-")

const defaultCommandOverheadMs = 120_000
const recordingOverheadMs = 240_000
const recordingGracePeriodMs = 60_000
const runnerKeepaliveIntervalMs = 10_000
const maxPerfTimeLimitMs = 5 * 60_000
const recordingStartupTimeoutMs = 30_000
const mib = 1024 * 1024
// Parse cap for a single schema export after it lands on disk. Sized to fit
// dense ~60s Time Profiler / Metal encoder tables while still bounding agent
// memory. Metal GPU interval tables for a full shader minute can be 100+ MiB;
// those stay under the per-schema stream budget and are truncated instead.
const maxExportFileSizeBytes = 32 * mib
const customTemplateExtension = ".tracetemplate"

// How a schema export reacts when the stream budget is hit mid-export.
// - fail: typed EnvironmentError (explicit `perf export`)
// - skip: drop this schema and continue
// - truncate: keep prefix; if salvage fails, fail (required analyze schemas)
// - truncate-or-skip: keep prefix; if salvage fails, skip (optional analyze schemas)
type ExportBudgetPolicy = "fail" | "skip" | "truncate" | "truncate-or-skip"

const formatTimeLimitMs = (value: number): string => {
  if (value % 60_000 === 0) {
    return `${value / 60_000}m`
  }

  if (value % 1_000 === 0) {
    return `${value / 1_000}s`
  }

  return `${value}ms`
}

interface CommandResult {
  readonly stdout: string
  readonly stderr: string
  readonly exitCode: number | null
}

interface TemplateExportSpec {
  readonly schema: string
  readonly budget: ExportBudget
  readonly required?: boolean
}

interface StreamedCommandResult extends CommandResult {
  readonly bytesWritten: number
  readonly rowCount: number
  /** True when the stream budget stopped the export and a prefix was kept. */
  readonly truncated: boolean
}

// PRB-097: the outcome of a single lazy schema export attempt, shared by
// `exportSchema` (one explicit request, always fails closed on a budget
// overrun) and `analyzeTrace` (per-analyzer required/optional schemas, where
// an optional overrun is skipped and a required overrun keeps a truncated
// prefix so the full record→analyze loop still yields a summary).
type SchemaExportOutcome =
  | {
      readonly kind: "exported"
      readonly artifact: ArtifactRecord
      readonly xpath: string
      readonly cacheHit: boolean
      readonly rowCount: number
      readonly bytesWritten: number
      readonly truncated: boolean
    }
  | {
      readonly kind: "skipped-budget"
      readonly error: ExportBudgetExceededError
    }

interface BackgroundRecordingStopResult extends CommandResult {
  readonly wasRunning: boolean
}

interface BackgroundRecordingHandle {
  readonly stop: () => Promise<BackgroundRecordingStopResult>
}

// Re-exported for backward compatibility: this error's policy now lives in
// ArtifactExportPolicy (PRB-085 gate 12), but existing callers/tests still
// import it from PerfService.
export { ExportBudgetExceededError }

type TemplateSlug = PerfTemplate | "custom"

interface TemplateSpec {
  readonly slug: TemplateSlug
  readonly displayName: string
  readonly xctraceTemplateName: string
  readonly exportSchemas: ReadonlyArray<TemplateExportSpec>
  readonly maxRecordingTimeLimitMs?: number
}

// PRB-103: `analyze` only ever lives on a *built-in* template's spec.
// `analyzeTrace`'s `analyzer: PerfAnalyzerName` is exactly `PerfTemplate`
// (excludes "custom" by design -- see `PerfAnalyzerName` in domain/perf.ts)
// and `analyzeTrace` always looks its spec up from `templateSpecs` (built-ins
// only, keyed by `PerfTemplate`), never from a custom template's spec. This
// narrower interface makes that exclusion structural instead of a
// same-shaped `analyze` field on `buildCustomTemplateSpec`'s output that
// happened to be unreachable at runtime (record()/recordAroundFlow() never
// call `.analyze()` -- only analyzeTrace does, and only for a built-in spec).
interface AnalyzableTemplateSpec extends TemplateSpec {
  readonly analyze: (tables: Record<string, ParsedPerfTable>, targetPid: number) => {
    readonly summary: PerfSummary
    readonly diagnoses: ReadonlyArray<PerfDiagnosis>
  }
}

const templateSpecs: Record<PerfTemplate, AnalyzableTemplateSpec> = {
  "time-profiler": {
    slug: "time-profiler",
    displayName: "Time Profiler",
    xctraceTemplateName: "Time Profiler",
    exportSchemas: [{
      schema: "time-sample",
      required: true,
      // Sized for a dense ~60s attach (observed ~9 MiB / ~30k rows on a live
      // Metal breathing scene). Larger captures truncate to this prefix.
      budget: {
        maxBytes: 12 * mib,
        maxRows: 50_000,
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
        maxBytes: 6 * mib,
        maxRows: 20_000,
      },
    }, {
      schema: "cpu-state",
      budget: {
        maxBytes: 12 * mib,
        maxRows: 50_000,
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
      // Full 60s shader scenes export ~150 MiB / 160k+ rows — far past agent
      // memory. Cap keeps a dense prefix; analyze diagnoses truncation.
      budget: {
        maxBytes: 16 * mib,
        maxRows: 50_000,
      },
    }, {
      schema: "metal-driver-event-intervals",
      budget: {
        maxBytes: 8 * mib,
        maxRows: 25_000,
      },
    }, {
      schema: "metal-application-encoders-list",
      // Observed ~19 MiB on a 60s in-session Metal breathing capture.
      budget: {
        maxBytes: 24 * mib,
        maxRows: 50_000,
      },
    }, {
      // Present when recording with a counters-enabled custom template
      // (e.g. Instruments "Ripple Scene Profiler.tracetemplate").
      schema: "gpu-counter-value",
      budget: {
        maxBytes: 8 * mib,
        maxRows: 50_000,
      },
    }, {
      schema: "metal-gpu-counter-intervals",
      budget: {
        maxBytes: 8 * mib,
        maxRows: 25_000,
      },
    }, {
      // Display presentation rate — tiny table, preferred FPS source.
      schema: "displayed-surfaces-per-second",
      budget: {
        maxBytes: 1 * mib,
        maxRows: 4_000,
      },
    }],
    maxRecordingTimeLimitMs: 120_000,
    analyze: (tables) => analyzeMetalSystemTraceTables({
      gpuIntervalsTable: tables["metal-gpu-intervals"],
      driverEventTable: tables["metal-driver-event-intervals"],
      encoderListTable: tables["metal-application-encoders-list"],
      gpuCounterTable: tables["gpu-counter-value"] ?? tables["metal-gpu-counter-intervals"],
      displayedSurfacesTable: tables["displayed-surfaces-per-second"],
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
  logging: {
    slug: "logging",
    displayName: "Logging",
    xctraceTemplateName: "Logging",
    exportSchemas: [{
      schema: "os-signpost-interval",
      required: true,
      budget: {
        maxBytes: 4 * mib,
        maxRows: 20_000,
      },
    }],
    analyze: (tables) => analyzeSignpostIntervalTable(tables["os-signpost-interval"]),
  },
}

const defaultCustomTemplateExportBudget = {
  maxBytes: 4 * mib,
  maxRows: 20_000,
} satisfies ExportBudget

const customTemplateNameFromPath = (templatePath: string): string =>
  basename(templatePath).replace(/\.tracetemplate$/i, "")

const buildCustomTemplateRef = (templatePath: string): CustomTemplateRef => ({
  path: templatePath,
  name: customTemplateNameFromPath(templatePath),
})

// PRB-103: no `analyze` field -- see AnalyzableTemplateSpec's doc comment.
// Custom templates have no built-in schema/diagnosis contract to lazily
// analyze against (an arbitrary `.tracetemplate` can declare any schema set;
// Probe's built-in analyzers are hand-written per named template), so this
// was never wired to a lazy-analysis path rather than left dead: `probe perf
// export`/`probe drill` remain the supported way to inspect custom-template
// output, unchanged from before this fix.
const buildCustomTemplateSpec = (templatePath: string): TemplateSpec => ({
  slug: "custom",
  displayName: customTemplateNameFromPath(templatePath),
  xctraceTemplateName: templatePath,
  exportSchemas: [],
  maxRecordingTimeLimitMs: 120_000,
})

const validateCustomTemplatePath = (templatePath: string) =>
  Effect.gen(function* () {
    if (!templatePath.toLowerCase().endsWith(customTemplateExtension)) {
      return yield* new UserInputError({
        code: "perf-custom-template-extension",
        reason: `Custom template path ${templatePath} must end with ${customTemplateExtension}.`,
        nextStep: "Save the template from Instruments.app as a .tracetemplate file and retry with --custom-template.",
        details: [],
      })
    }

    yield* Effect.tryPromise({
      try: () => access(templatePath, constants.R_OK),
      catch: (error) =>
        new UserInputError({
          code: "perf-custom-template-read",
          reason: `Custom template path ${templatePath} is not readable: ${error instanceof Error ? error.message : String(error)}.`,
          nextStep: "Verify the .tracetemplate file exists, is readable, and points to a template saved from Instruments.app, then retry.",
          details: [],
        }),
    })

    return buildCustomTemplateRef(templatePath)
  })

// PRB-097: reverse lookup from a schema name to the budget a built-in
// template already knows for it, so an on-demand `perf.export`/`perf.analyze`
// call reuses the same tuned budget record() used to use eagerly. Schemas
// outside every built-in template's contract (the bulk of a 40+-schema
// custom template) fall back to `defaultCustomTemplateExportBudget`.
const schemaExportBudgets: Record<string, ExportBudget> = Object.values(templateSpecs).reduce(
  (map, spec) => {
    for (const exportSpec of spec.exportSchemas) {
      if (!(exportSpec.schema in map)) {
        map[exportSpec.schema] = exportSpec.budget
      }
    }

    return map
  },
  {} as Record<string, ExportBudget>,
)

const resolveExportBudgetForSchema = (schema: string): ExportBudget => schemaExportBudgets[schema] ?? defaultCustomTemplateExportBudget

const buildSchemaExportXpath = (runNumber: string, schema: string): string =>
  `/trace-toc/run[@number=\"${runNumber}\"]/data/table[@schema=\"${schema}\"]`

// PRB-097: export cache key -- trace identity (the trace artifact's own key,
// unique per recording) + run number + schema + XPath + xctrace version.
// Any of those changing (a different run, a different XPath override, an
// Xcode upgrade) is a different cache entry, never a stale hit.
const buildExportCacheKey = (args: {
  readonly traceArtifactKey: string
  readonly runNumber: string
  readonly schema: string
  readonly xpath: string
  readonly xctraceVersion: string
}): string => {
  const digest = createHash("sha1")
    .update(`${args.traceArtifactKey} ${args.runNumber} ${args.schema} ${args.xpath} ${args.xctraceVersion}`)
    .digest("hex")
    .slice(0, 20)
  const safeSchema = args.schema.replace(/[^a-zA-Z0-9_-]/g, "_")

  return `export-${safeSchema}-${digest}`
}

// PRB-097: record() and recordAroundFlow() key a trace's TOC artifact as
// `${baseName}-toc` next to the trace's own `${baseName}-trace` -- lazy
// export/analyze derives the TOC key from the trace key it was handed
// instead of re-deriving `baseName` structurally, so it stays correct even
// if the baseName format changes as long as the `-trace`/`-toc` suffix pair
// does not.
const traceArtifactKeySuffix = "-trace"

const deriveTocArtifactKey = (traceArtifactKey: string): string | null =>
  traceArtifactKey.endsWith(traceArtifactKeySuffix)
    ? `${traceArtifactKey.slice(0, -traceArtifactKeySuffix.length)}-toc`
    : null

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

// PRB-097: record()'s per-trace sidecar path -- lives next to the trace
// bundle and its TOC, keyed off the same base name, so a later lazy
// `perf.analyze` call can recover the recorded target pid without a live
// trace lease.
const perfMetaPathForTrace = (tracePath: string): string => tracePath.replace(/\.trace$/, ".perf-meta.json")

interface PerfTraceMeta {
  readonly targetProcessId?: number
}

const readPerfTraceMeta = async (tracePath: string): Promise<PerfTraceMeta | null> => {
  try {
    const raw = await readFile(perfMetaPathForTrace(tracePath), "utf8")
    const parsed = JSON.parse(raw) as unknown

    if (parsed && typeof parsed === "object" && typeof (parsed as PerfTraceMeta).targetProcessId === "number") {
      return { targetProcessId: (parsed as PerfTraceMeta).targetProcessId }
    }

    return {}
  } catch {
    return null
  }
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

// Process spawning, registration, continuous stdio draining, and TERM -> grace
// -> KILL escalation all live in AppleProcessSupervisor now. These helpers keep
// only PerfService's own policy: how each command's success/failure/timeout is
// worded, and (for runCommandToFile) how the xctrace export-budget guard is
// wired into the stdout pipeline.

const remapSpawnFailure = (args: {
  readonly command: string
  readonly commandArgs: ReadonlyArray<string>
  readonly error: ChildProcessError
}): ChildProcessError =>
  new ChildProcessError({
    code: "command-spawn-failed",
    command: `${args.command} ${args.commandArgs.join(" ")}`,
    reason: args.error.reason,
    nextStep: "Verify the local toolchain installation and retry the command.",
    exitCode: null,
    stderrExcerpt: args.error.stderrExcerpt,
  })

const rethrowSupervisorError = (args: {
  readonly command: string
  readonly commandArgs: ReadonlyArray<string>
  readonly error: unknown
}): never => {
  if (args.error instanceof ChildProcessError && args.error.code === "command-spawn-failed") {
    throw remapSpawnFailure({ ...args, error: args.error })
  }
  throw args.error
}

/**
 * PRB-096: readable one-line reason a raw capture's `Effect.onExit`
 * finalizer reports to `endTraceLease` -- the typed error's own `reason`
 * when there is one, falling back to a plain message/pretty-cause for a
 * defect or fiber interruption (e.g. a concurrent session close aborting
 * `lease.signal`).
 */
const describeExitFailure = (exit: Exit.Exit<unknown, unknown>): string => {
  if (Exit.isSuccess(exit)) {
    return "none"
  }

  const failure = Cause.failureOption(exit.cause)

  if (Option.isSome(failure)) {
    const value = failure.value

    if (value && typeof value === "object" && "reason" in value && typeof (value as { reason: unknown }).reason === "string") {
      return (value as { reason: string }).reason
    }

    return value instanceof Error ? value.message : String(value)
  }

  if (Cause.isInterrupted(exit.cause)) {
    return "interrupted (the owning session likely started closing)"
  }

  return Cause.pretty(exit.cause)
}

// Exported (in addition to being wired into `liveCommandRunner` below) so their
// real AppleProcessSupervisor-backed behavior -- not just the PerfCommandRunner
// mock seam most of this file's tests use -- has direct test coverage.
export const runCommand = (args: {
  readonly command: string
  readonly commandArgs: ReadonlyArray<string>
  readonly timeoutMs: number
  readonly gracePeriodMs?: number
  readonly allowFailure?: boolean
  /** Aborting kills the process group (TERM -> grace -> KILL) and rejects with a `command-cancelled` ChildProcessError. */
  readonly signal?: AbortSignal
}): Promise<CommandResult> =>
  runAppleProcess({
    command: args.command,
    commandArgs: args.commandArgs,
    timeoutMs: args.timeoutMs,
    gracePeriodMs: args.gracePeriodMs,
    signal: args.signal,
  }).then((result) => {
    if (result.cancelled) {
      throw new ChildProcessError({
        code: "command-cancelled",
        command: `${args.command} ${args.commandArgs.join(" ")}`,
        reason: `${args.command} was cancelled before it completed.`,
        nextStep: "Retry the request if the cancellation was unintended.",
        exitCode: result.exitCode,
        stderrExcerpt: result.stderr.trim() || result.stdout.trim(),
      })
    }

    if (result.timedOut) {
      throw new ChildProcessError({
        code: "command-timeout",
        command: `${args.command} ${args.commandArgs.join(" ")}`,
        reason: `${args.command} exceeded the ${args.timeoutMs} ms timeout window.`,
        nextStep: "Reduce the trace duration or inspect host load, then retry.",
        exitCode: result.exitCode,
        stderrExcerpt: result.stderr.trim() || result.stdout.trim(),
      })
    }

    const commandResult = { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode } satisfies CommandResult

    if (result.exitCode === 0 || args.allowFailure) {
      return commandResult
    }

    throw new ChildProcessError({
      code: "command-failed",
      command: `${args.command} ${args.commandArgs.join(" ")}`,
      reason: `${args.command} exited with code ${result.exitCode ?? "unknown"}.`,
      nextStep: "Inspect stderr and the generated trace artifacts, then retry the request.",
      exitCode: result.exitCode,
      stderrExcerpt: result.stderr.trim() || result.stdout.trim(),
    })
  }, (error) => rethrowSupervisorError({ command: args.command, commandArgs: args.commandArgs, error }))

const cleanupOutputFile = async (path: string): Promise<void> => {
  await rm(path, { force: true }).catch(() => undefined)
}

const countExportRowsInContent = (content: string): number => (content.match(/<row>/g) ?? []).length

const countExportRowsInFile = async (path: string): Promise<number> => {
  try {
    const content = await readFile(path, "utf8")
    return countExportRowsInContent(content)
  } catch {
    return 0
  }
}

/**
 * Clamp an xctrace table export to a byte budget by cutting after the last
 * complete `</row>` that still fits. `parsePerfTableExport` only needs a
 * leading `<schema>` block and complete row pairs — trailing close tags are
 * optional — so this is enough to keep analysis honest under agent budgets.
 */
/** @internal exported for unit tests — clamps a partial xctrace XML export to budget. */
export const clampExportFileToBudget = async (args: {
  readonly outputPath: string
  readonly maxBytes: number
}): Promise<{ readonly bytesWritten: number; readonly rowCount: number; readonly truncated: boolean } | null> => {
  try {
    const stats = statSync(args.outputPath)
    if (stats.size <= 0) {
      return null
    }

    if (stats.size <= args.maxBytes) {
      const rowCount = await countExportRowsInFile(args.outputPath)
      if (rowCount <= 0) {
        return null
      }
      return { bytesWritten: stats.size, rowCount, truncated: false }
    }

    // Read only the budget window — avoid loading a 100+ MiB export for clamp.
    const handle = await openFile(args.outputPath, "r")
    try {
      const length = Math.min(stats.size, args.maxBytes)
      const buffer = Buffer.alloc(length)
      await handle.read(buffer, 0, length, 0)
      const text = buffer.toString("utf8")
      const lastRowEnd = text.lastIndexOf("</row>")
      if (lastRowEnd < 0) {
        return null
      }
      const clamped = text.slice(0, lastRowEnd + "</row>".length)
      const rowCount = countExportRowsInContent(clamped)
      if (rowCount <= 0) {
        return null
      }
      await writeFile(args.outputPath, clamped, "utf8")
      return {
        bytesWritten: Buffer.byteLength(clamped, "utf8"),
        rowCount,
        truncated: true,
      }
    } finally {
      await handle.close()
    }
  } catch {
    return null
  }
}

const tryKeepPartialExport = async (args: {
  readonly outputPath: string
  readonly budgetError: ExportBudgetExceededError
  readonly stderr: string
  readonly maxBytes: number
}): Promise<StreamedCommandResult | null> => {
  const clamped = await clampExportFileToBudget({
    outputPath: args.outputPath,
    maxBytes: args.maxBytes,
  })
  if (!clamped) {
    return null
  }

  return {
    stdout: "",
    stderr: args.stderr,
    exitCode: 0,
    bytesWritten: clamped.bytesWritten,
    rowCount: clamped.rowCount,
    truncated: true,
  }
}

export const runCommandToFile = (args: {
  readonly command: string
  readonly commandArgs: ReadonlyArray<string>
  readonly timeoutMs: number
  readonly gracePeriodMs?: number
  readonly outputPath: string
  readonly budget: ExportBudget
  /**
   * `fail` (default): delete partial output and throw ExportBudgetExceededError.
   * `truncate`: keep a prefix of complete rows when the budget fires, so analyze
   * can still produce a summary from dense long captures.
   */
  readonly budgetPolicy?: Exclude<ExportBudgetPolicy, "skip">
  /** Aborting kills the process group (TERM -> grace -> KILL), removes the partial output file, and rejects with a `command-cancelled` ChildProcessError. */
  readonly signal?: AbortSignal
}): Promise<StreamedCommandResult> => {
  const outputGuard = new ExportBudgetTransform(args.budget)
  const budgetPolicy = args.budgetPolicy ?? "fail"

  return runAppleProcess({
    command: args.command,
    commandArgs: args.commandArgs,
    timeoutMs: args.timeoutMs,
    gracePeriodMs: args.gracePeriodMs,
    stdoutArtifactPath: args.outputPath,
    stdoutTransform: outputGuard,
    signal: args.signal,
  }).then(
    async (result) => {
      if (outputGuard.exceededError) {
        if (budgetPolicy === "truncate") {
          const partial = await tryKeepPartialExport({
            outputPath: args.outputPath,
            budgetError: outputGuard.exceededError,
            stderr: result.stderr,
            maxBytes: args.budget.maxBytes,
          })
          if (partial) {
            return partial
          }
        }

        await cleanupOutputFile(args.outputPath)
        throw outputGuard.exceededError
      }

      if (result.cancelled) {
        await cleanupOutputFile(args.outputPath)
        throw new ChildProcessError({
          code: "command-cancelled",
          command: `${args.command} ${args.commandArgs.join(" ")}`,
          reason: `${args.command} was cancelled before it completed.`,
          nextStep: "Retry the request if the cancellation was unintended.",
          exitCode: result.exitCode,
          stderrExcerpt: result.stderr.trim(),
        })
      }

      if (result.timedOut) {
        await cleanupOutputFile(args.outputPath)
        throw new ChildProcessError({
          code: "command-timeout",
          command: `${args.command} ${args.commandArgs.join(" ")}`,
          reason: `${args.command} exceeded the ${args.timeoutMs} ms timeout window.`,
          nextStep: "Reduce the trace duration or inspect host load, then retry.",
          exitCode: result.exitCode,
          stderrExcerpt: result.stderr.trim(),
        })
      }

      if (result.exitCode === 0) {
        // Belt-and-suspenders: even if the stream guard missed (or the process
        // flushed past SIGTERM), clamp the on-disk export to the declared budget
        // so analyze never loads an unbounded XML into memory.
        const clamped = await clampExportFileToBudget({
          outputPath: args.outputPath,
          maxBytes: args.budget.maxBytes,
        })
        if (clamped?.truncated) {
          if (budgetPolicy === "fail") {
            await cleanupOutputFile(args.outputPath)
            throw new ExportBudgetExceededError({
              kind: "bytes",
              limit: args.budget.maxBytes,
              observed: clamped.bytesWritten,
            })
          }
          return {
            stdout: "",
            stderr: result.stderr,
            exitCode: 0,
            bytesWritten: clamped.bytesWritten,
            rowCount: clamped.rowCount,
            truncated: true,
          } satisfies StreamedCommandResult
        }

        return {
          stdout: "",
          stderr: result.stderr,
          exitCode: result.exitCode,
          bytesWritten: clamped?.bytesWritten ?? outputGuard.bytesWritten,
          rowCount: clamped?.rowCount ?? outputGuard.rowCount,
          truncated: false,
        } satisfies StreamedCommandResult
      }

      await cleanupOutputFile(args.outputPath)
      throw new ChildProcessError({
        code: "command-failed",
        command: `${args.command} ${args.commandArgs.join(" ")}`,
        reason: `${args.command} exited with code ${result.exitCode ?? "unknown"}.`,
        nextStep: "Inspect stderr and the generated trace artifacts, then retry the request.",
        exitCode: result.exitCode,
        stderrExcerpt: result.stderr.trim(),
      })
    },
    async (error) => {
      if (outputGuard.exceededError) {
        if (budgetPolicy === "truncate") {
          const partial = await tryKeepPartialExport({
            outputPath: args.outputPath,
            budgetError: outputGuard.exceededError,
            stderr: "",
            maxBytes: args.budget.maxBytes,
          })
          if (partial) {
            return partial
          }
        }

        await cleanupOutputFile(args.outputPath)
        throw outputGuard.exceededError
      }

      await cleanupOutputFile(args.outputPath)
      return rethrowSupervisorError({ command: args.command, commandArgs: args.commandArgs, error })
    },
  )
}

export const liveStartRecording = async (args: {
  readonly command: string
  readonly commandArgs: ReadonlyArray<string>
  readonly startupNotificationKey: string
  readonly startupTimeoutMs: number
  readonly timeoutMs: number
  readonly gracePeriodMs?: number
}): Promise<BackgroundRecordingHandle> => {
  const startupWait = runCommand({
    command: "notifyutil",
    commandArgs: ["-1", args.startupNotificationKey],
    timeoutMs: args.startupTimeoutMs,
    gracePeriodMs: 1_000,
  })

  const handle: AppleProcessHandle = await spawnAppleProcessHandle({
    command: args.command,
    commandArgs: args.commandArgs,
    timeoutMs: args.timeoutMs,
    gracePeriodMs: args.gracePeriodMs,
  }).catch((error) => {
    return rethrowSupervisorError({ command: args.command, commandArgs: args.commandArgs, error })
  })

  const exitPromise = handle.awaitExit.then(
    (result): CommandResult => ({ stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode }),
    (error) => rethrowSupervisorError({ command: args.command, commandArgs: args.commandArgs, error }),
  )

  await new Promise<void>((resolve, reject) => {
    let settled = false

    startupWait.then(() => {
      if (!settled) {
        settled = true
        resolve()
      }
    }).catch((error) => {
      if (!settled) {
        settled = true
        reject(error)
      }
    })

    exitPromise.then((result) => {
      if (!settled) {
        settled = true
        reject(
          new ChildProcessError({
            code: "command-failed",
            command: `${args.command} ${args.commandArgs.join(" ")}`,
            reason: `${args.command} exited before signaling that recording started.`,
            nextStep: "Inspect stderr and retry the profiling command.",
            exitCode: result.exitCode,
            stderrExcerpt: result.stderr.trim() || result.stdout.trim(),
          }),
        )
      }
    }).catch((error) => {
      if (!settled) {
        settled = true
        reject(error)
      }
    })
  }).catch(async (error) => {
    await handle.stop("SIGTERM")

    try {
      await exitPromise
    } catch {
      // Ignore cleanup errors and surface the startup failure.
    }

    throw error
  })

  return {
    stop: async () => {
      const wasRunning = handle.isRunning()
      const result = wasRunning ? await handle.stop("SIGINT") : await exitPromise.then((r) => ({ ...r, signal: null }))
      return {
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
        wasRunning,
      }
    },
  }
}

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

export class PerfService extends Context.Tag("@probe/PerfService")<
  PerfService,
  {
    readonly record: (args: {
      readonly sessionId: string
      readonly template?: typeof PerfTemplate.Type
      readonly customTemplatePath?: string
      readonly timeLimit: string
      readonly emitProgress: (stage: string, message: string) => void
    }) => Effect.Effect<
      typeof PerfRecordResult.Type,
      | UserInputError
      | EnvironmentError
      | SessionNotFoundError
      | UnsupportedCapabilityError
      | ChildProcessError
    >
    readonly recordAroundFlow: (args: {
      readonly sessionId: string
      readonly template: typeof PerfTemplate.Type
      readonly flow: SessionFlowContract
      readonly emitProgress: (stage: string, message: string) => void
    }) => Effect.Effect<
      typeof PerfAroundFlowResult.Type,
      | UserInputError
      | EnvironmentError
      | SessionNotFoundError
      | UnsupportedCapabilityError
      | ChildProcessError
    >
    readonly summarizeBySignpost: (args: {
      readonly sessionId: string
      readonly artifactKey: string
      readonly emitProgress: (stage: string, message: string) => void
    }) => Effect.Effect<
      typeof PerfSignpostSummaryResult.Type,
      | ArtifactNotFoundError
      | UserInputError
      | EnvironmentError
      | SessionNotFoundError
      | UnsupportedCapabilityError
      | ChildProcessError
    >
    // PRB-097: one requested schema/XPath derivative, exported on demand
    // from an already-recorded trace and cached by trace identity + run
    // number + schema + XPath + xctrace version.
    readonly exportSchema: (args: {
      readonly sessionId: string
      readonly artifactKey: string
      readonly schema: string
      readonly xpath?: string
      readonly emitProgress: (stage: string, message: string) => void
    }) => Effect.Effect<
      typeof PerfExportResult.Type,
      | ArtifactNotFoundError
      | UserInputError
      | EnvironmentError
      | SessionNotFoundError
      | UnsupportedCapabilityError
      | ChildProcessError
    >
    // PRB-097: lazily exports (and reuses the same export cache as
    // `exportSchema`) only the schemas one named built-in analyzer needs,
    // then runs that analyzer's existing math.
    readonly analyzeTrace: (args: {
      readonly sessionId: string
      readonly artifactKey: string
      readonly analyzer: PerfAnalyzerName
      readonly emitProgress: (stage: string, message: string) => void
    }) => Effect.Effect<
      typeof PerfAnalyzeResult.Type,
      | ArtifactNotFoundError
      | UserInputError
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
    // Required (not optional) so every call site is forced to thread the
    // Effect.tryPromise-provided AbortSignal through -- a client disconnect
    // (gate 10) interrupts the RPC request fiber, which aborts this signal,
    // which kills the owned process group. Omitting it at a call site is a
    // compile error, not a silent gap.
    readonly signal: AbortSignal
  }) => Promise<CommandResult>
  readonly exportToFile: (args: {
    readonly command: string
    readonly commandArgs: ReadonlyArray<string>
    readonly timeoutMs: number
    readonly gracePeriodMs?: number
    readonly outputPath: string
    readonly budget: ExportBudget
    readonly budgetPolicy?: Exclude<ExportBudgetPolicy, "skip">
    readonly signal: AbortSignal
  }) => Promise<StreamedCommandResult>
  readonly startRecording?: (args: {
    readonly command: string
    readonly commandArgs: ReadonlyArray<string>
    readonly startupNotificationKey: string
    readonly startupTimeoutMs: number
    readonly timeoutMs: number
    readonly gracePeriodMs?: number
  }) => Promise<BackgroundRecordingHandle>
}

interface PerfArtifactStoreAccess {
  readonly registerArtifact: (
    sessionId: string,
    record: ArtifactRecord,
  ) => Effect.Effect<ArtifactRecord, EnvironmentError>
  readonly getArtifact?: (
    sessionId: string,
    artifactKey: string,
  ) => Effect.Effect<ArtifactRecord, EnvironmentError | ArtifactNotFoundError>
}

interface PerfSessionRegistryAccess {
  readonly getSessionHealth: (sessionId: string) => Effect.Effect<SessionHealth, SessionNotFoundError | EnvironmentError>
  readonly sendRunnerKeepalive: (sessionId: string) => Effect.Effect<void, SessionNotFoundError | EnvironmentError>
  readonly runFlow?: (params: {
    readonly sessionId: string
    readonly flow: SessionFlowContract
  }) => Effect.Effect<
    SessionFlowResult,
    SessionNotFoundError | UserInputError | UnsupportedCapabilityError | EnvironmentError | ChildProcessError
  >
  // PRB-096: raw record's target-process lease seam -- see SessionRegistry.ts.
  // Required (not optional like `runFlow`/`getArtifact`): the raw path's
  // whole point is decoupling from `getSessionHealth`/runner health, so it
  // has no honest fallback to degrade to when these are absent.
  readonly peekSessionHealth: (sessionId: string) => Effect.Effect<SessionHealth, SessionNotFoundError>
  readonly beginTraceLease: (sessionId: string) => Effect.Effect<
    TraceLeaseHandle,
    SessionNotFoundError | EnvironmentError | UnsupportedCapabilityError
  >
  readonly endTraceLease: (sessionId: string, outcome: TraceLeaseOutcome) => Effect.Effect<void>
}

const liveCommandRunner: PerfCommandRunner = {
  capture: runCommand,
  exportToFile: runCommandToFile,
  startRecording: liveStartRecording,
}

export const createPerfService = (dependencies: {
  readonly artifactStore: PerfArtifactStoreAccess
  readonly sessionRegistry: PerfSessionRegistryAccess
  readonly commandRunner?: PerfCommandRunner
}) => {
  const commandRunner = dependencies.commandRunner ?? liveCommandRunner
  const startRecordingCommand = commandRunner.startRecording ?? liveStartRecording

  const resolveRecordingContext = ({
    sessionId,
    template,
    emitProgress,
    progressStage,
    capabilityPrefix,
  }: {
    readonly sessionId: string
    readonly template: PerfTemplate
    readonly emitProgress: (stage: string, message: string) => void
    readonly progressStage: string
    readonly capabilityPrefix: string
  }) =>
    Effect.gen(function* () {
      const spec = templateSpecs[template]
      const sessionBeforeRecord = yield* dependencies.sessionRegistry.getSessionHealth(sessionId)

      if (!isLiveRunnerDetails(sessionBeforeRecord.runner)) {
        return yield* new UnsupportedCapabilityError({
          code: "perf-session-real-device-runner",
          capability: `${capabilityPrefix}.template.${template}`,
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

      emitProgress(progressStage, `Checking xctrace template availability for ${spec.displayName}.`)

      const templateList = yield* Effect.tryPromise({
        try: (signal) =>
          commandRunner.capture({
            command: "xcrun",
            commandArgs: ["xctrace", "list", "templates"],
            timeoutMs: defaultCommandOverheadMs,
            signal,
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
          capability: `${capabilityPrefix}.template.${template}`,
          reason: `The local xctrace installation does not expose the ${spec.xctraceTemplateName} template required for ${spec.displayName}.`,
          nextStep: "Run `xcrun xctrace list templates`, then choose a supported template or update Xcode.",
          details: [],
          wall: false,
        })
      }

      const xctraceVersionResult = yield* Effect.tryPromise({
        try: (signal) =>
          commandRunner.capture({
            command: "xcrun",
            commandArgs: ["xctrace", "version"],
            timeoutMs: defaultCommandOverheadMs,
            signal,
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

      return {
        spec,
        sessionBeforeRecord,
        runnerDetails,
        xctraceVersion: xctraceVersionResult.stdout.trim(),
      } as const
    })

  const startRunnerKeepalive = ({
    sessionId,
    emitProgress,
    progressStage,
  }: {
    readonly sessionId: string
    readonly emitProgress: (stage: string, message: string) => void
    readonly progressStage: string
  }) =>
    Effect.gen(function* () {
      yield* Effect.sleep(runnerKeepaliveIntervalMs)
      yield* dependencies.sessionRegistry.sendRunnerKeepalive(sessionId)
    }).pipe(
      Effect.catchAll((error) =>
        Effect.sync(() => {
          emitProgress(progressStage, `Runner keepalive failed: ${error instanceof Error ? error.message : String(error)}`)
        })
      ),
      Effect.forever,
      Effect.fork,
    )

  const exportTocArtifact = ({
    sessionId,
    artifactRoot,
    tracePath,
    tocPath,
    artifactKey,
    artifactLabel,
    artifactSummary,
    emitProgress,
  }: {
    readonly sessionId: string
    readonly artifactRoot: string
    readonly tracePath: string
    readonly tocPath: string
    readonly artifactKey: string
    readonly artifactLabel: string
    readonly artifactSummary: string
    readonly emitProgress: (stage: string, message: string) => void
  }) =>
    Effect.gen(function* () {
      emitProgress("perf.export", `Exporting TOC for ${basename(tracePath)}.`)

      const tocResult = yield* Effect.tryPromise({
        try: (signal) =>
          commandRunner.capture({
            command: "xcrun",
            commandArgs: ["xctrace", "export", "--input", tracePath, "--toc"],
            timeoutMs: defaultCommandOverheadMs,
            signal,
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
          artifactRoot,
          key: artifactKey,
          label: artifactLabel,
          kind: "xml",
          absolutePath: tocPath,
          summary: artifactSummary,
        }),
      )

      return {
        tocXml: tocResult.stdout,
        tocArtifact,
      } as const
    })

  const artifactRootFromArtifact = (artifact: ArtifactRecord): string => {
    if (artifact.relativePath !== null && artifact.relativePath.length > 0 && artifact.absolutePath.endsWith(artifact.relativePath)) {
      const root = artifact.absolutePath.slice(0, artifact.absolutePath.length - artifact.relativePath.length)
      return root.endsWith("/") ? root.slice(0, -1) : root
    }

    return dirname(dirname(artifact.absolutePath))
  }

  const resolveRecordTemplateSelection = ({
    template,
    customTemplatePath,
  }: {
    readonly template?: PerfTemplate
    readonly customTemplatePath?: string
  }) =>
    Effect.gen(function* () {
      const hasBuiltInTemplate = template !== undefined
      const hasCustomTemplatePath = customTemplatePath !== undefined

      if (hasBuiltInTemplate && hasCustomTemplatePath) {
        return yield* new UserInputError({
          code: "perf-record-template-exclusive",
          reason: "Use either --template or --custom-template, but not both.",
          nextStep: "Choose a built-in template or pass a single custom .tracetemplate path, then retry.",
          details: [],
        })
      }

      if (!hasBuiltInTemplate && !hasCustomTemplatePath) {
        return yield* new UserInputError({
          code: "perf-record-template-missing",
          reason: "Missing required perf template selection.",
          nextStep: "Provide either --template <built-in-template> or --custom-template <path.tracetemplate> and retry.",
          details: [],
        })
      }

      if (customTemplatePath !== undefined) {
        const customTemplate = yield* validateCustomTemplatePath(customTemplatePath)

        return {
          template: "custom" as const,
          customTemplate,
          spec: buildCustomTemplateSpec(customTemplate.path),
        }
      }

      return {
        template: template!,
        customTemplate: undefined,
        spec: templateSpecs[template!],
      }
    })

  const record = ({ sessionId, template, customTemplatePath, timeLimit, emitProgress }: {
    readonly sessionId: string
    readonly template?: PerfTemplate
    readonly customTemplatePath?: string
    readonly timeLimit: string
    readonly emitProgress: (stage: string, message: string) => void
  }) =>
    Effect.gen(function* () {
      const resolvedTemplate = yield* resolveRecordTemplateSelection({
        template,
        customTemplatePath,
      })
      const spec = resolvedTemplate.spec
      const templateKind = resolvedTemplate.template
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

      // PRB-096: raw record gates on a live, connected target-process lease
      // -- device, live target pid, bundle, artifact root -- never on
      // XCUITest runner health. `beginTraceLease` performs no runner ping
      // and sets `resources.trace` ("starting") independently of
      // `resources.runner`, so a degraded/failed runner wrapper with a
      // still-live target pid can record successfully.
      const lease = yield* dependencies.sessionRegistry.beginTraceLease(sessionId)

      const captureResult = yield* recordWithTraceLease({
        sessionId,
        lease,
        resolvedTemplate,
        spec,
        templateKind,
        timeLimit,
        timeLimitMs,
        emitProgress,
      })

      // Passive, side-effect-free read (no runner ping) -- AC 9's "raw
      // acquisition performs no pre/post runner ping side effect" -- for a
      // best-effort `session` outcome in the result.
      const sessionSnapshot = yield* dependencies.sessionRegistry.peekSessionHealth(sessionId)

      return {
        ...captureResult,
        session: {
          state: sessionSnapshot.state,
          healthCheck: sessionSnapshot.healthCheck,
        },
      } satisfies typeof PerfRecordResult.Type
    })

  // PRB-096: everything a raw capture does once it holds the lease --
  // fresh pre-spawn process-identity verification, the xctrace record
  // itself, TOC/schema exports, and analysis -- lives in its own Effect so
  // `Effect.onExit` can guarantee `endTraceLease` runs exactly once no
  // matter how it settles (success, a typed failure, or interruption from a
  // concurrent session close aborting `lease.signal`). That is the "join":
  // the trace lane always reaches a terminal state, and a session close
  // blocked on it can never hang forever.
  const recordWithTraceLease = (args: {
    readonly sessionId: string
    readonly lease: TraceLeaseHandle
    readonly resolvedTemplate: { readonly customTemplate?: CustomTemplateRef }
    readonly spec: TemplateSpec
    readonly templateKind: TemplateSlug
    readonly timeLimit: string
    readonly timeLimitMs: number
    readonly emitProgress: (stage: string, message: string) => void
  }) => {
    const { sessionId, lease, resolvedTemplate, spec, templateKind, timeLimit, timeLimitMs, emitProgress } = args
    const target = lease.target
    const withLeaseSignal = (signal: AbortSignal): AbortSignal => AbortSignal.any([signal, lease.signal])

    return Effect.gen(function* () {
      const identity = yield* verifyTargetProcessIdentity({
        platform: target.platform,
        deviceId: target.deviceId,
        targetProcessId: target.targetProcessId,
        capture: commandRunner.capture,
        signal: lease.signal,
      })

      if (templateKind !== "custom") {
        emitProgress("perf.record", `Checking xctrace template availability for ${spec.displayName}.`)

        const templateList = yield* Effect.tryPromise({
          try: (signal) =>
            commandRunner.capture({
              command: "xcrun",
              commandArgs: ["xctrace", "list", "templates"],
              timeoutMs: defaultCommandOverheadMs,
              signal: withLeaseSignal(signal),
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
            capability: `perf.record.template.${templateKind}`,
            reason: `The local xctrace installation does not expose the ${spec.xctraceTemplateName} template required for ${spec.displayName}.`,
            nextStep: "Run `xcrun xctrace list templates`, then choose a supported template or update Xcode.",
            details: [],
            wall: false,
          })
        }
      }

      const xctraceVersionResult = yield* Effect.tryPromise({
        try: (signal) =>
          commandRunner.capture({
            command: "xcrun",
            commandArgs: ["xctrace", "version"],
            timeoutMs: defaultCommandOverheadMs,
            signal: withLeaseSignal(signal),
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

      const tracesDirectory = join(target.artifactRoot, "traces")
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
        `Recording ${spec.displayName} for pid ${target.targetProcessId} on device ${target.deviceId} `
          + `(process identity verified via ${identity.method}).`,
      )

      // PRB-096: no runner keepalive fiber here -- the raw capture never
      // pings or pokes the XCUITest runner, before, during, or after
      // recording. Session liveness while this runs is the trace lease
      // itself (see the TTL sweeper's `activeTraceLeaseStates` exemption in
      // SessionRegistry), not a runner-coupled ping.
      yield* Effect.tryPromise({
        try: (signal) =>
          commandRunner.capture({
            command: "xcrun",
            commandArgs: [
              "xctrace",
              "record",
              "--template",
              spec.xctraceTemplateName,
              "--device",
              target.deviceId,
              "--attach",
              String(target.targetProcessId),
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
            signal: withLeaseSignal(signal),
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
      })

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
          artifactRoot: target.artifactRoot,
          key: `${baseName}-trace`,
          label: `${spec.slug}-trace`,
          kind: "directory",
          absolutePath: tracePath,
          summary: `${spec.displayName} raw .trace bundle.`,
        }),
      )

      // PRB-096: no post-record runner health refresh here either -- the
      // raw path's `session` outcome (built by `record()` after this
      // Effect resolves) comes from `peekSessionHealth`'s passive read, not
      // a fresh ping issued from inside the capture.
      const { tocXml, tocArtifact } = yield* exportTocArtifact({
        sessionId,
        artifactRoot: target.artifactRoot,
        tracePath,
        tocPath,
        artifactKey: `${baseName}-toc`,
        artifactLabel: `${spec.slug}-toc`,
        artifactSummary: `${spec.displayName} TOC export.`,
        emitProgress,
      })

      const runNumber = parseFirstRunNumber(tocXml)

      if (!runNumber) {
        return yield* new EnvironmentError({
          code: "perf-run-number-missing",
          reason: `Could not resolve a run number from ${basename(tocPath)}.`,
          nextStep: "Inspect the TOC export and retry the profiling command.",
          details: [],
        })
      }

      // PRB-097: record() is trace-first -- it stops here. No schema is
      // exported, parsed, or analyzed eagerly; the TOC's advertised schema
      // names become a compact catalog, and `probe perf export`/`probe perf
      // analyze` pull specific tables lazily, on demand, from this same
      // trace bundle.
      const availableSchemas = parseAvailableSchemaNames(tocXml)
      const schemaCatalog = [...availableSchemas]
        .sort((left, right) => left.localeCompare(right))
        .map((schema) => ({ schema }))

      emitProgress(
        "perf.record",
        `Discovered ${schemaCatalog.length} schema(s) in the TOC; launched zero schema-export subprocesses.`,
      )

      // Persist the target pid alongside the trace so a later `perf analyze
      // --analyzer system-trace` call -- which has no live trace lease, and
      // so no other way to learn the recorded app's pid -- can still filter
      // thread/cpu rows to the target process (see resolveTraceAnalysisContext).
      yield* Effect.tryPromise({
        try: () =>
          writeFile(
            perfMetaPathForTrace(tracePath),
            `${JSON.stringify({ targetProcessId: target.targetProcessId, template: templateKind, recordedAt: nowIso() }, null, 2)}\n`,
            "utf8",
          ),
        catch: (error) =>
          new EnvironmentError({
            code: "perf-write-meta",
            reason: error instanceof Error ? error.message : String(error),
            nextStep: "Check write access to the session traces directory and retry the profiling command.",
            details: [],
          }),
      })

      return {
        sessionId,
        template: templateKind,
        templateName: spec.displayName,
        customTemplatePath: resolvedTemplate.customTemplate?.path,
        timeLimit,
        recordedAt: nowIso(),
        xctraceVersion: xctraceVersionResult.stdout.trim(),
        summary: {
          headline: schemaCatalog.length === 0
            ? `Recorded ${spec.displayName} in ${timeLimit}; the TOC did not advertise any schema names.`
            : `Recorded ${spec.displayName} in ${timeLimit}; the TOC advertises ${schemaCatalog.length} schema(s). Call \`probe perf analyze\` for built-in diagnostics or \`probe perf export\` for a specific schema.`,
          metrics: [
            { label: "Schemas discovered", value: String(schemaCatalog.length) },
            { label: "Run number", value: runNumber },
          ],
        },
        diagnoses: [
          {
            code: "perf-target-identity-verified",
            severity: "info" as const,
            summary: `Target process ${target.targetProcessId} identity verified via ${identity.method} immediately before recording (no XCUITest runner ping performed).`,
            details: [identity.detail],
            wall: false,
          },
        ],
        schemas: schemaCatalog,
        artifacts: {
          trace: traceArtifact,
          toc: tocArtifact,
        },
      } satisfies Omit<typeof PerfRecordResult.Type, "session">
    }).pipe(
      Effect.onExit((exit) =>
        dependencies.sessionRegistry.endTraceLease(
          sessionId,
          Exit.isSuccess(exit) ? { kind: "stopped" } : { kind: "failed", detail: describeExitFailure(exit) },
        )),
    )
  }

  const recordAroundFlow = ({ sessionId, template, flow, emitProgress }: {
    readonly sessionId: string
    readonly template: PerfTemplate
    readonly flow: SessionFlowContract
    readonly emitProgress: (stage: string, message: string) => void
  }) =>
    Effect.gen(function* () {
      const runFlow = dependencies.sessionRegistry.runFlow

      if (!runFlow) {
        return yield* new EnvironmentError({
          code: "perf-around-flow-unavailable",
          reason: "The current PerfService wiring does not expose session flow execution.",
          nextStep: "Provide SessionRegistry.runFlow when constructing PerfService and retry the perf around request.",
          details: [],
        })
      }

      const { spec, sessionBeforeRecord, runnerDetails, xctraceVersion } = yield* resolveRecordingContext({
        sessionId,
        template,
        emitProgress,
        progressStage: "perf.around",
        capabilityPrefix: "perf.around",
      })
      const recordingTimeLimitMs = spec.maxRecordingTimeLimitMs ?? maxPerfTimeLimitMs
      const recordingTimeLimit = formatTimeLimitMs(recordingTimeLimitMs)
      const tracesDirectory = join(sessionBeforeRecord.artifactRoot, "traces")
      const baseName = `${timestampForFile()}-${spec.slug}-around`
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

      const startupNotificationKey = `dev.probe.perf.${sessionId}.${Date.now()}.${Math.random().toString(16).slice(2)}`
      emitProgress(
        "perf.around",
        `Starting ${spec.displayName} recording for pid ${runnerDetails.targetProcessId} on device ${sessionBeforeRecord.target.deviceId}.`,
      )

      const recordingHandle = yield* Effect.tryPromise({
        try: () =>
          startRecordingCommand({
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
              recordingTimeLimit,
              "--output",
              tracePath,
              "--run-name",
              baseName,
              "--notify-tracing-started",
              startupNotificationKey,
              "--no-prompt",
            ],
            startupNotificationKey,
            startupTimeoutMs: recordingStartupTimeoutMs,
            timeoutMs: recordingTimeLimitMs + recordingOverheadMs,
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
      })

      emitProgress("perf.around", `Recording started; executing ${flow.steps.length} flow step(s).`)
      const keepaliveFiber = yield* startRunnerKeepalive({
        sessionId,
        emitProgress,
        progressStage: "perf.around",
      })
      const flowExit = yield* Effect.either(runFlow({
        sessionId,
        flow,
      }))
      emitProgress("perf.around", `Stopping ${spec.displayName} recording after the bounded flow completed.`)

      const stopResult = yield* Effect.tryPromise({
        try: () => recordingHandle.stop(),
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

      if (!stopResult.wasRunning) {
        return yield* new EnvironmentError({
          code: "perf-around-recording-ended-early",
          reason: `${spec.displayName} recording ended before the flow completed.`,
          nextStep: `Keep the bounded flow under ${recordingTimeLimit}, or choose a lighter template and retry the perf around request.`,
          details: stopResult.stderr.trim().length > 0
            ? [stopResult.stderr.trim()]
            : [],
        })
      }

      if (flowExit._tag === "Left") {
        return yield* flowExit.left
      }

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
          summary: `${spec.displayName} raw .trace bundle recorded around a bounded flow.`,
        }),
      )

      // Best-effort sidecar (mirrors record()'s) so a later `perf analyze
      // --analyzer system-trace` on this trace can recover the target pid.
      // Non-fatal: an around-flow trace and its diagnoses are already
      // complete by this point and must not be discarded over a sidecar
      // write failure.
      yield* Effect.tryPromise({
        try: () =>
          writeFile(
            perfMetaPathForTrace(tracePath),
            `${JSON.stringify({ targetProcessId: runnerDetails.targetProcessId, template, recordedAt: nowIso() }, null, 2)}\n`,
            "utf8",
          ),
        catch: (error) => error,
      }).pipe(Effect.ignore)

      emitProgress("perf.around", `Refreshing session health after recording ${spec.displayName}.`)
      const sessionHealthRefresh = yield* Effect.either(dependencies.sessionRegistry.getSessionHealth(sessionId))

      // PRB-096 gate 8: a UI/runner failure in this post-flow health
      // refresh must never discard an already-completed trace -- the
      // recording and its artifacts are already done and registered by this
      // point. Fall back to the pre-flow snapshot (marked degraded, with an
      // explicit warning) instead of failing the whole `recordAroundFlow`
      // result and losing the trace summary the caller would otherwise get.
      const sessionAfterRecord: SessionHealth = Either.isRight(sessionHealthRefresh)
        ? sessionHealthRefresh.right
        : {
            ...sessionBeforeRecord,
            state: "degraded",
            warnings: [
              ...sessionBeforeRecord.warnings,
              `Post-flow session health refresh failed after the trace recording completed: ${
                sessionHealthRefresh.left instanceof Error ? sessionHealthRefresh.left.message : String(sessionHealthRefresh.left)
              }. The recorded trace and its artifacts are preserved.`,
            ],
          }
      const { tocArtifact } = yield* exportTocArtifact({
        sessionId,
        artifactRoot: sessionBeforeRecord.artifactRoot,
        tracePath,
        tocPath,
        artifactKey: `${baseName}-toc`,
        artifactLabel: `${spec.slug}-toc`,
        artifactSummary: `${spec.displayName} TOC export for bounded-flow recording.`,
        emitProgress,
      })

      return {
        sessionId,
        template,
        templateName: spec.displayName,
        recordedAt: nowIso(),
        xctraceVersion,
        session: {
          state: sessionAfterRecord.state,
          healthCheck: sessionAfterRecord.healthCheck,
        },
        flow: flowExit.right,
        diagnoses: buildPostRecordSessionDiagnoses({
          before: sessionBeforeRecord,
          after: sessionAfterRecord,
        }),
        artifacts: {
          trace: traceArtifact,
          toc: tocArtifact,
        },
      } satisfies typeof PerfAroundFlowResult.Type
    })

  const summarizeBySignpost = ({ sessionId, artifactKey, emitProgress }: {
    readonly sessionId: string
    readonly artifactKey: string
    readonly emitProgress: (stage: string, message: string) => void
  }) =>
    Effect.gen(function* () {
      const getArtifact = dependencies.artifactStore.getArtifact

      if (!getArtifact) {
        return yield* new EnvironmentError({
          code: "perf-artifact-lookup-unavailable",
          reason: "The current PerfService wiring does not expose artifact lookup.",
          nextStep: "Provide ArtifactStore.getArtifact when constructing PerfService and retry the perf summarize request.",
          details: [],
        })
      }

      const traceArtifact = yield* getArtifact(sessionId, artifactKey)

      if (traceArtifact.kind !== "directory" || !traceArtifact.absolutePath.endsWith(".trace")) {
        return yield* new UserInputError({
          code: "perf-summarize-artifact-not-trace",
          reason: `Artifact ${artifactKey} is not a .trace bundle.`,
          nextStep: "Pass the perf trace artifact key and retry the summarize command.",
          details: [],
        })
      }

      const xctraceVersionResult = yield* Effect.tryPromise({
        try: (signal) =>
          commandRunner.capture({
            command: "xcrun",
            commandArgs: ["xctrace", "version"],
            timeoutMs: defaultCommandOverheadMs,
            signal,
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

      const tracePath = traceArtifact.absolutePath
      const tracesDirectory = dirname(tracePath)
      const artifactRoot = artifactRootFromArtifact(traceArtifact)
      const traceBaseName = basename(tracePath).replace(/\.trace$/, "")
      const summaryBase = `${timestampForFile()}-${traceBaseName}-signpost`
      const tocPath = join(tracesDirectory, `${summaryBase}.toc.xml`)
      const { tocXml, tocArtifact } = yield* exportTocArtifact({
        sessionId,
        artifactRoot,
        tracePath,
        tocPath,
        artifactKey: `${summaryBase}-toc`,
        artifactLabel: "signpost-toc",
        artifactSummary: `TOC export used for signpost summary of ${basename(tracePath)}.`,
        emitProgress,
      })

      const runNumber = parseFirstRunNumber(tocXml)

      if (!runNumber) {
        return yield* new EnvironmentError({
          code: "perf-run-number-missing",
          reason: `Could not resolve a run number from ${basename(tocPath)}.`,
          nextStep: "Inspect the TOC export and retry the profiling command.",
          details: [],
        })
      }

      const availableSchemas = parseAvailableSchemaNames(tocXml)

      if (availableSchemas.size > 0 && !availableSchemas.has("os-signpost-interval")) {
        return yield* new UnsupportedCapabilityError({
          code: "perf-signpost-schema-missing",
          capability: "perf.summarize.group-by.signpost",
          reason: `The trace ${artifactKey} does not expose the os-signpost-interval schema required for signpost grouping.`,
          nextStep: "Record with the Logging template or choose a trace that captured os_signpost intervals, then retry the summarize command.",
          details: [...availableSchemas].sort(),
          wall: false,
        })
      }

      const schema = "os-signpost-interval"
      const exportPath = join(tracesDirectory, `${summaryBase}.${schema}.xml`)
      const budget = {
        maxBytes: 4 * mib,
        maxRows: 20_000,
      } satisfies ExportBudget

      emitProgress(
        "perf.export",
        `Exporting ${schema} rows for signpost summary (budget ${budget.maxRows} rows / ${formatBytes(budget.maxBytes)}).`,
      )

      const exportResult = yield* Effect.tryPromise({
        try: (signal) =>
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
            signal,
          }),
        catch: (error) =>
          error instanceof ChildProcessError
            ? new EnvironmentError({
                code: "perf-export-schema-failed",
                reason: `xctrace export for schema ${schema} exited with code ${error.exitCode ?? "unknown"}: ${error.stderrExcerpt || error.reason}`,
                nextStep: `The trace TOC lists ${schema} but the export command failed. This typically means no signpost intervals were captured during the recording. Verify the app emits os_signpost intervals during the recorded flow, then retry.`,
                details: [
                  `schema: ${schema}`,
                  `exitCode: ${String(error.exitCode ?? "unknown")}`,
                  `stderr: ${error.stderrExcerpt.length > 0 ? error.stderrExcerpt : "none"}`,
                ],
              })
            : error instanceof ExportBudgetExceededError
              ? buildExportBudgetError({ templateName: "Signpost summary", schema, error })
              : error instanceof EnvironmentError
                ? error
              : new EnvironmentError({
                  code: "perf-read-schema-export",
                  reason: error instanceof Error ? error.message : String(error),
                  nextStep: `Inspect the saved ${schema} export XML and retry the summarize command.`,
                  details: [],
                }),
      })

      const exportArtifact = yield* dependencies.artifactStore.registerArtifact(
        sessionId,
        createArtifactRecord({
          artifactRoot,
          key: `${summaryBase}-${schema}`,
          label: "signpost-intervals",
          kind: "xml",
          absolutePath: exportPath,
          summary: `${schema} export for signpost summary (${exportResult.rowCount} rows, ${formatBytes(exportResult.bytesWritten)}).`,
        }),
      )

      let maybeOversized: EnvironmentError | undefined
      try {
        const { statSync } = require("node:fs")
        const stats = statSync(exportPath)

        if (stats.size > maxExportFileSizeBytes) {
          maybeOversized = new EnvironmentError({
            code: "perf-export-file-too-large",
            reason: `${schema} export file (${formatBytes(stats.size)}) exceeds the ${formatBytes(maxExportFileSizeBytes)} parse limit.`,
            nextStep: "Inspect the saved .trace directly or use a narrower recording window before retrying the summarize command.",
            details: [`schema: ${schema}`, `file: ${exportPath}`, `size: ${stats.size}`],
          })
        }
      } catch {
        // Let downstream readFile fail with a better typed error.
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
            nextStep: `Inspect the saved ${schema} export XML and retry the summarize command.`,
            details: [],
          }),
      })

      const parsedTable = yield* Effect.try({
        try: () => parsePerfTableExport(exportXml),
        catch: (error) =>
          new EnvironmentError({
            code: "perf-parse-export",
            reason: error instanceof Error ? error.message : String(error),
            nextStep: `Inspect the saved ${schema} export XML and retry the summarize command.`,
            details: [],
          }),
      })

      const groups = yield* Effect.try({
        try: () => summarizeSignpostIntervalsTable(parsedTable),
        catch: (error) =>
          new EnvironmentError({
            code: "perf-analyze-export-contract",
            reason: error instanceof Error ? error.message : String(error),
            nextStep: "Inspect the saved signpost export and align Probe's supported xctrace contract before retrying.",
            details: [schema],
          }),
      })

      return {
        sessionId,
        artifactKey,
        groupBy: "signpost",
        generatedAt: nowIso(),
        xctraceVersion: xctraceVersionResult.stdout.trim(),
        totalIntervals: groups.reduce((total, group) => total + group.count, 0),
        groups,
        artifacts: {
          trace: traceArtifact,
          toc: tocArtifact,
          export: exportArtifact,
        },
      } satisfies typeof PerfSignpostSummaryResult.Type
    })

  // PRB-097: resolves the already-recorded TOC for a trace artifact --
  // preferring the sibling TOC record() already wrote (read straight off
  // disk, no subprocess) and only falling back to re-deriving it via a
  // fresh `xctrace export --toc` when that sibling is missing or its file
  // no longer exists (e.g. an older recording, or manual cleanup).
  const resolveTocForTrace = ({ sessionId, artifactRoot, traceArtifact, emitProgress, progressStage }: {
    readonly sessionId: string
    readonly artifactRoot: string
    readonly traceArtifact: ArtifactRecord
    readonly emitProgress: (stage: string, message: string) => void
    readonly progressStage: string
  }) =>
    Effect.gen(function* () {
      const getArtifact = dependencies.artifactStore.getArtifact!
      const tocKey = deriveTocArtifactKey(traceArtifact.key)

      if (tocKey) {
        const existing = yield* Effect.either(getArtifact(sessionId, tocKey))

        if (Either.isRight(existing)) {
          const stillExists = yield* Effect.promise(() => fileExists(existing.right.absolutePath))

          if (stillExists) {
            emitProgress(
              progressStage,
              `Reusing the TOC already exported for ${basename(traceArtifact.absolutePath)} (no xctrace subprocess).`,
            )

            const tocXml = yield* Effect.tryPromise({
              try: () => readFile(existing.right.absolutePath, "utf8"),
              catch: (error) =>
                new EnvironmentError({
                  code: "perf-read-toc",
                  reason: error instanceof Error ? error.message : String(error),
                  nextStep: "Inspect the saved TOC export and retry the request.",
                  details: [],
                }),
            })

            return { tocXml, tocArtifact: existing.right }
          }
        }
      }

      const tracesDirectory = dirname(traceArtifact.absolutePath)
      const rebuiltBase = `${timestampForFile()}-${basename(traceArtifact.absolutePath).replace(/\.trace$/, "")}`

      return yield* exportTocArtifact({
        sessionId,
        artifactRoot,
        tracePath: traceArtifact.absolutePath,
        tocPath: join(tracesDirectory, `${rebuiltBase}.toc.xml`),
        artifactKey: `${rebuiltBase}-toc`,
        artifactLabel: "trace-toc",
        artifactSummary: `TOC export re-derived for lazy analysis of ${traceArtifact.key}.`,
        emitProgress,
      })
    })

  // PRB-097: shared entry seam for `perf.export` and `perf.analyze` -- both
  // start from an already-registered trace artifact key, not a live trace
  // lease, so they resolve the trace, its TOC (lazily, see above), the run
  // number, the TOC's advertised schema names, and the target pid recorded
  // alongside the trace (see readPerfTraceMeta).
  const resolveTraceAnalysisContext = ({ sessionId, artifactKey, emitProgress, progressStage, capabilitySlug }: {
    readonly sessionId: string
    readonly artifactKey: string
    readonly emitProgress: (stage: string, message: string) => void
    readonly progressStage: string
    readonly capabilitySlug: string
  }) =>
    Effect.gen(function* () {
      const getArtifact = dependencies.artifactStore.getArtifact

      if (!getArtifact) {
        return yield* new EnvironmentError({
          code: "perf-artifact-lookup-unavailable",
          reason: "The current PerfService wiring does not expose artifact lookup.",
          nextStep: `Provide ArtifactStore.getArtifact when constructing PerfService and retry the perf ${capabilitySlug} request.`,
          details: [],
        })
      }

      const traceArtifact = yield* getArtifact(sessionId, artifactKey)

      if (traceArtifact.kind !== "directory" || !traceArtifact.absolutePath.endsWith(".trace")) {
        return yield* new UserInputError({
          code: `perf-${capabilitySlug}-artifact-not-trace`,
          reason: `Artifact ${artifactKey} is not a .trace bundle.`,
          nextStep: `Pass the perf trace artifact key and retry the perf ${capabilitySlug} command.`,
          details: [],
        })
      }

      const xctraceVersionResult = yield* Effect.tryPromise({
        try: (signal) =>
          commandRunner.capture({
            command: "xcrun",
            commandArgs: ["xctrace", "version"],
            timeoutMs: defaultCommandOverheadMs,
            signal,
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

      const artifactRoot = artifactRootFromArtifact(traceArtifact)
      const { tocXml, tocArtifact } = yield* resolveTocForTrace({
        sessionId,
        artifactRoot,
        traceArtifact,
        emitProgress,
        progressStage,
      })

      const runNumber = parseFirstRunNumber(tocXml)

      if (!runNumber) {
        return yield* new EnvironmentError({
          code: "perf-run-number-missing",
          reason: `Could not resolve a run number from the TOC for ${artifactKey}.`,
          nextStep: "Inspect the TOC export and retry the request.",
          details: [],
        })
      }

      const availableSchemas = parseAvailableSchemaNames(tocXml)
      const meta = yield* Effect.promise(() => readPerfTraceMeta(traceArtifact.absolutePath))

      return {
        traceArtifact,
        tocArtifact,
        artifactRoot,
        runNumber,
        availableSchemas,
        xctraceVersion: xctraceVersionResult.stdout.trim(),
        targetProcessId: meta?.targetProcessId,
      } as const
    })

  // PRB-097: one schema/XPath export, cached by trace identity + run number
  // + schema + XPath + xctrace version (see buildExportCacheKey). A cache
  // hit never reruns xctrace; a miss exports, budget-guards, and registers
  // the result under the deterministic cache key so the next identical
  // request is a hit.
  const exportSchemaWithCache = ({
    sessionId,
    artifactRoot,
    traceArtifact,
    runNumber,
    schema,
    xpath,
    budget,
    xctraceVersion,
    emitProgress,
    budgetPolicy,
  }: {
    readonly sessionId: string
    readonly artifactRoot: string
    readonly traceArtifact: ArtifactRecord
    readonly runNumber: string
    readonly schema: string
    readonly xpath?: string
    readonly budget: ExportBudget
    readonly xctraceVersion: string
    readonly emitProgress: (stage: string, message: string) => void
    readonly budgetPolicy: ExportBudgetPolicy
  }): Effect.Effect<SchemaExportOutcome, EnvironmentError | ChildProcessError> =>
    Effect.gen(function* () {
      const getArtifact = dependencies.artifactStore.getArtifact!
      const resolvedXpath = xpath ?? buildSchemaExportXpath(runNumber, schema)
      // Cache key includes budget policy so a failed fail-closed export cannot
      // be reused as a truncated analyze result (and vice versa).
      const cacheKey = buildExportCacheKey({
        traceArtifactKey: traceArtifact.key,
        runNumber,
        schema,
        xpath: `${resolvedXpath}::budget=${budgetPolicy}:${budget.maxBytes}:${budget.maxRows}`,
        xctraceVersion,
      })

      const cached = yield* Effect.either(getArtifact(sessionId, cacheKey))

      if (Either.isRight(cached)) {
        const stillExists = yield* Effect.promise(() => fileExists(cached.right.absolutePath))

        if (stillExists) {
          emitProgress("perf.export", `Reusing the cached ${schema} export (xctrace was not rerun).`)

          const stats = yield* Effect.tryPromise({
            try: async () => {
              const content = await readFile(cached.right.absolutePath, "utf8")
              return {
                bytesWritten: Buffer.byteLength(content, "utf8"),
                rowCount: (content.match(/<row>/g) ?? []).length,
              }
            },
            catch: (error) =>
              new EnvironmentError({
                code: "perf-read-cached-export",
                reason: error instanceof Error ? error.message : String(error),
                nextStep: "Inspect the cached export artifact and retry the request.",
                details: [],
              }),
          })

          // Durable flag: label suffix, not English summary wording.
          const truncatedFromCache =
            cached.right.label.endsWith("-export-truncated")
            || cached.right.summary.includes("truncated prefix")

          return {
            kind: "exported",
            artifact: cached.right,
            xpath: resolvedXpath,
            cacheHit: true,
            rowCount: stats.rowCount,
            bytesWritten: stats.bytesWritten,
            truncated: truncatedFromCache,
          } satisfies SchemaExportOutcome
        }
      }

      const tracesDirectory = dirname(traceArtifact.absolutePath)
      const exportPath = join(tracesDirectory, `${cacheKey}.xml`)
      emitProgress(
        "perf.export",
        `Exporting ${schema} rows (budget ${budget.maxRows} rows / ${formatBytes(budget.maxBytes)}, policy ${budgetPolicy}).`,
      )

      const wantsTruncate = budgetPolicy === "truncate" || budgetPolicy === "truncate-or-skip"
      const fileBudgetPolicy: Exclude<ExportBudgetPolicy, "skip" | "truncate-or-skip"> =
        wantsTruncate ? "truncate" : "fail"

      const exportOutcome = yield* Effect.tryPromise({
        try: async (signal) => {
          try {
            const result = await commandRunner.exportToFile({
              command: "xcrun",
              commandArgs: ["xctrace", "export", "--input", traceArtifact.absolutePath, "--xpath", resolvedXpath],
              timeoutMs: defaultCommandOverheadMs,
              outputPath: exportPath,
              budget,
              budgetPolicy: fileBudgetPolicy,
              signal,
            })

            return { kind: "exported" as const, result }
          } catch (error) {
            if (error instanceof ExportBudgetExceededError) {
              if (budgetPolicy === "skip") {
                await cleanupOutputFile(exportPath)
                return { kind: "skipped-budget" as const, error }
              }

              if (wantsTruncate) {
                const partial = await tryKeepPartialExport({
                  outputPath: exportPath,
                  budgetError: error,
                  stderr: "",
                  maxBytes: budget.maxBytes,
                })
                if (partial) {
                  return { kind: "exported" as const, result: partial }
                }
                // Optional tables must not kill the whole analyze when salvage fails.
                if (budgetPolicy === "truncate-or-skip") {
                  await cleanupOutputFile(exportPath)
                  return { kind: "skipped-budget" as const, error }
                }
              }
            }

            throw error
          }
        },
        catch: (error) =>
          error instanceof ChildProcessError
            ? error
            : error instanceof ExportBudgetExceededError
              ? buildExportBudgetError({ templateName: schema, schema, error })
              : new EnvironmentError({
                  code: "perf-export-schema",
                  reason: error instanceof Error ? error.message : String(error),
                  nextStep: `Inspect the TOC export and retry the ${schema} export.`,
                  details: [],
                }),
      })

      if (exportOutcome.kind === "skipped-budget") {
        const budgetLabel = exportOutcome.error.kind === "bytes"
          ? formatBytes(exportOutcome.error.limit)
          : `${exportOutcome.error.limit} rows`
        emitProgress("perf.export", `Skipping optional ${schema} export after it exceeded the ${budgetLabel} budget.`)
        return { kind: "skipped-budget", error: exportOutcome.error } satisfies SchemaExportOutcome
      }

      let exportResult = exportOutcome.result

      // Final parse-size gate. Prefer clamping (for truncate/skip policies) over
      // failing the whole analyze when a dense optional table blows past the
      // agent memory ceiling — required tables already truncate above.
      const parseBudgetBytes = Math.min(budget.maxBytes, maxExportFileSizeBytes)
      try {
        const stats = statSync(exportPath)
        if (stats.size > parseBudgetBytes) {
          if (budgetPolicy === "fail") {
            yield* Effect.promise(() => cleanupOutputFile(exportPath))
            return yield* Effect.fail(
              new EnvironmentError({
                code: "perf-export-file-too-large",
                reason: `${schema} export file (${formatBytes(stats.size)}) exceeds the ${formatBytes(parseBudgetBytes)} parse limit.`,
                nextStep: "Reduce the requested window or inspect the saved .trace directly for full data.",
                details: [`schema: ${schema}`, `file: ${exportPath}`, `size: ${stats.size}`],
              }),
            )
          }

          const clamped = yield* Effect.promise(() =>
            clampExportFileToBudget({ outputPath: exportPath, maxBytes: parseBudgetBytes }),
          )

          if (!clamped) {
            yield* Effect.promise(() => cleanupOutputFile(exportPath))
            if (budgetPolicy === "skip" || budgetPolicy === "truncate-or-skip") {
              emitProgress(
                "perf.export",
                `Skipping optional ${schema} export after it exceeded the ${formatBytes(parseBudgetBytes)} parse limit with no salvageable rows.`,
              )
              return {
                kind: "skipped-budget",
                error: new ExportBudgetExceededError({
                  kind: "bytes",
                  limit: parseBudgetBytes,
                  observed: stats.size,
                }),
              } satisfies SchemaExportOutcome
            }

            return yield* Effect.fail(
              new EnvironmentError({
                code: "perf-export-file-too-large",
                reason: `${schema} export file (${formatBytes(stats.size)}) exceeds the ${formatBytes(parseBudgetBytes)} parse limit and could not be truncated to complete rows.`,
                nextStep: "Reduce the requested window or inspect the saved .trace directly for full data.",
                details: [`schema: ${schema}`, `file: ${exportPath}`, `size: ${stats.size}`],
              }),
            )
          }

          exportResult = {
            ...exportResult,
            bytesWritten: clamped.bytesWritten,
            rowCount: clamped.rowCount,
            truncated: true,
          }
        }
      } catch {
        // File stat failed; let downstream readFile fail with a better error
      }

      if (exportResult.truncated) {
        emitProgress(
          "perf.export",
          `Kept a truncated ${schema} prefix (${exportResult.rowCount} rows, ${formatBytes(exportResult.bytesWritten)}) after hitting the export budget.`,
        )
      }

      const artifact = yield* dependencies.artifactStore.registerArtifact(
        sessionId,
        createArtifactRecord({
          artifactRoot,
          key: cacheKey,
          label: exportResult.truncated ? `${schema}-export-truncated` : `${schema}-export`,
          kind: "xml",
          absolutePath: exportPath,
          summary: exportResult.truncated
            ? `${schema} export truncated prefix (${exportResult.rowCount} rows, ${formatBytes(exportResult.bytesWritten)}).`
            : `${schema} export (${exportResult.rowCount} rows, ${formatBytes(exportResult.bytesWritten)}).`,
        }),
      )

      return {
        kind: "exported",
        artifact,
        xpath: resolvedXpath,
        cacheHit: false,
        rowCount: exportResult.rowCount,
        bytesWritten: exportResult.bytesWritten,
        truncated: exportResult.truncated,
      } satisfies SchemaExportOutcome
    })

  const exportSchema = ({ sessionId, artifactKey, schema, xpath, emitProgress }: {
    readonly sessionId: string
    readonly artifactKey: string
    readonly schema: string
    readonly xpath?: string
    readonly emitProgress: (stage: string, message: string) => void
  }) =>
    Effect.gen(function* () {
      const context = yield* resolveTraceAnalysisContext({
        sessionId,
        artifactKey,
        emitProgress,
        progressStage: "perf.export",
        capabilitySlug: "export",
      })

      if (context.availableSchemas.size > 0 && xpath === undefined && !context.availableSchemas.has(schema)) {
        return yield* new UserInputError({
          code: "perf-export-schema-missing",
          reason: `${artifactKey}'s TOC did not expose the ${schema} schema.`,
          nextStep: "Inspect the saved TOC export and request a schema it advertises, or pass an explicit --xpath.",
          details: [...context.availableSchemas].sort(),
        })
      }

      // Explicit `perf export` always fails closed on budget — never silent skip
      // and never silent truncate (callers asked for the full schema).
      const outcome = yield* exportSchemaWithCache({
        sessionId,
        artifactRoot: context.artifactRoot,
        traceArtifact: context.traceArtifact,
        runNumber: context.runNumber,
        schema,
        xpath,
        budget: resolveExportBudgetForSchema(schema),
        xctraceVersion: context.xctraceVersion,
        emitProgress,
        budgetPolicy: "fail",
      })

      if (outcome.kind === "skipped-budget") {
        return yield* Effect.fail(buildExportBudgetError({ templateName: schema, schema, error: outcome.error }))
      }

      return {
        sessionId,
        artifactKey,
        schema,
        xpath: outcome.xpath,
        runNumber: context.runNumber,
        xctraceVersion: context.xctraceVersion,
        exportedAt: nowIso(),
        cacheHit: outcome.cacheHit,
        rowCount: outcome.rowCount,
        bytesWritten: outcome.bytesWritten,
        artifacts: {
          trace: context.traceArtifact,
          toc: context.tocArtifact,
          export: outcome.artifact,
        },
      } satisfies typeof PerfExportResult.Type
    })

  const analyzeTrace = ({ sessionId, artifactKey, analyzer, emitProgress }: {
    readonly sessionId: string
    readonly artifactKey: string
    readonly analyzer: PerfAnalyzerName
    readonly emitProgress: (stage: string, message: string) => void
  }) =>
    Effect.gen(function* () {
      const context = yield* resolveTraceAnalysisContext({
        sessionId,
        artifactKey,
        emitProgress,
        progressStage: "perf.analyze",
        capabilitySlug: "analyze",
      })
      const spec = templateSpecs[analyzer]
      const tocAdvertisesSchemas = context.availableSchemas.size > 0
      const parsedTables: Record<string, ParsedPerfTable> = {}
      const exportArtifacts: Array<ArtifactRecord> = []
      const truncationDiagnoses: Array<PerfDiagnosis> = []

      for (const exportSpec of spec.exportSchemas) {
        if (tocAdvertisesSchemas && !context.availableSchemas.has(exportSpec.schema)) {
          if (exportSpec.required) {
            return yield* new EnvironmentError({
              code: "perf-export-schema-missing",
              reason: `${spec.displayName} analysis needs the ${exportSpec.schema} schema, but ${artifactKey}'s TOC did not expose it.`,
              nextStep: "Inspect the saved TOC export and align Probe's supported schema contract before retrying.",
              details: [...context.availableSchemas].sort(),
            })
          }

          continue
        }

        // Required: truncate under budget (fail only if salvage yields nothing).
        // Optional: truncate when possible; skip on unsalvageable overrun so a
        // fat encoder/counter table cannot kill metal analyze after GPU intervals land.
        const outcome = yield* exportSchemaWithCache({
          sessionId,
          artifactRoot: context.artifactRoot,
          traceArtifact: context.traceArtifact,
          runNumber: context.runNumber,
          schema: exportSpec.schema,
          budget: exportSpec.budget,
          xctraceVersion: context.xctraceVersion,
          emitProgress,
          budgetPolicy: exportSpec.required === true ? "truncate" : "truncate-or-skip",
        })

        if (outcome.kind === "skipped-budget") {
          continue
        }

        if (exportSpec.required !== true && outcome.rowCount === 0) {
          continue
        }

        exportArtifacts.push(outcome.artifact)

        if (outcome.truncated) {
          truncationDiagnoses.push({
            code: "perf-export-truncated",
            severity: "warning",
            summary: `Analysis used a budget-capped prefix of ${exportSpec.schema} (${outcome.rowCount} rows, ${formatBytes(outcome.bytesWritten)}).`,
            details: [
              `Budget: ${exportSpec.budget.maxRows} rows / ${formatBytes(exportSpec.budget.maxBytes)}.`,
              "Metrics describe the exported prefix only, not necessarily the full recording window.",
              "Re-record with a shorter --time-limit for full-window coverage under budget, or open the .trace in Instruments for the full capture.",
            ],
            wall: false,
          })
        }

        const exportXml = yield* Effect.tryPromise({
          try: () => readFile(outcome.artifact.absolutePath, "utf8"),
          catch: (error) =>
            new EnvironmentError({
              code: "perf-read-schema-export",
              reason: error instanceof Error ? error.message : String(error),
              nextStep: `Inspect the saved ${exportSpec.schema} export XML and retry the analyze command.`,
              details: [],
            }),
        })

        parsedTables[exportSpec.schema] = yield* Effect.try({
          try: () => parsePerfTableExport(exportXml),
          catch: (error) =>
            new EnvironmentError({
              code: "perf-parse-export",
              reason: error instanceof Error ? error.message : String(error),
              nextStep: `Inspect the saved ${exportSpec.schema} export XML and retry the analyze command.`,
              details: [],
            }),
        })
      }

      if (analyzer === "system-trace" && context.targetProcessId === undefined) {
        return yield* new EnvironmentError({
          code: "perf-analyze-missing-target-pid",
          reason: `${artifactKey} has no recorded target-process metadata, which the System Trace analyzer needs to filter thread/cpu rows to the app.`,
          nextStep: "Re-record this trace with `probe perf record --template system-trace` and retry; recordings persist target-pid metadata for later lazy analysis.",
          details: [],
        })
      }

      const requiredSchema = spec.exportSchemas.find((exportSpec) => exportSpec.required)?.schema
      if (requiredSchema !== undefined && parsedTables[requiredSchema] === undefined) {
        return yield* new EnvironmentError({
          code: "perf-analyze-required-export-missing",
          reason: `${spec.displayName} analysis needs ${requiredSchema} rows, but the export produced none under the current budget.`,
          nextStep: "Re-record a shorter window, or inspect the raw .trace in Instruments.",
          details: [],
        })
      }

      let analysis = yield* Effect.try({
        try: () => spec.analyze(parsedTables, context.targetProcessId ?? -1),
        catch: (error) =>
          new EnvironmentError({
            code: "perf-analyze-export-contract",
            reason: error instanceof Error ? error.message : String(error),
            nextStep: "Inspect the saved schema exports and align Probe's supported xctrace contract before retrying.",
            details: spec.exportSchemas.map((exportSpec) => exportSpec.schema),
          }),
      })

      // Optional atos enrichment for time-profiler leaf PCs when the operator
      // exports PROBE_PERF_BINARY / PROBE_ATOS_BINARY to the matching .app or dSYM.
      if (analyzer === "time-profiler") {
        const binaryPath = resolveAtosBinaryPath()
        const leafPcs = leafPcsFromTimeProfilerSummary(analysis.summary)
        if (binaryPath && leafPcs.length > 0) {
          emitProgress("perf.analyze", `Symbolicating ${leafPcs.length} leaf PC(s) with atos against ${binaryPath}.`)
          const symbols = yield* Effect.tryPromise({
            try: () =>
              symbolicateAddressesWithAtos({
                binaryPath,
                addresses: leafPcs,
              }),
            catch: (error) =>
              new EnvironmentError({
                code: "perf-atos-symbolicate",
                reason: error instanceof Error ? error.message : String(error),
                nextStep:
                  "Set PROBE_PERF_BINARY to the target .app executable or dSYM, or omit it to keep raw leaf PCs.",
                details: [binaryPath],
              }),
          }).pipe(
            Effect.catchAll((error) => {
              // Symbolication is best-effort — never fail the whole analyze.
              emitProgress(
                "perf.analyze",
                `atos symbolication skipped: ${error instanceof EnvironmentError ? error.reason : String(error)}`,
              )
              return Effect.succeed(new Map<string, string>())
            }),
          )
          if (symbols.size > 0) {
            analysis = applyCallstackSymbols(analysis, symbols)
          }
        }
      }

      return {
        sessionId,
        artifactKey,
        analyzer,
        analyzedAt: nowIso(),
        xctraceVersion: context.xctraceVersion,
        summary: analysis.summary,
        diagnoses: [...truncationDiagnoses, ...analysis.diagnoses],
        artifacts: {
          trace: context.traceArtifact,
          toc: context.tocArtifact,
          exports: exportArtifacts,
        },
      } satisfies typeof PerfAnalyzeResult.Type
    })

  return PerfService.of({
    record,
    recordAroundFlow,
    summarizeBySignpost,
    exportSchema,
    analyzeTrace,
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
