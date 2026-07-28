import { Schema } from "effect"
import { ArtifactRecord } from "./output"
import { BoundedFlowV2ResultSchema, SessionFlowResultSchema } from "./flow-v2"
import { SessionHealthCheck, SessionPhase } from "./session"

const perfTemplateValues = [
  "time-profiler",
  "system-trace",
  "metal-system-trace",
  "hangs",
  "swift-concurrency",
  "logging",
] as const

export const PerfTemplate = Schema.Literal(...perfTemplateValues)
export type PerfTemplate = typeof PerfTemplate.Type

export interface CustomTemplateRef {
  readonly path: string
  readonly name: string
}

export const PerfRecordTemplateKind = Schema.Union(PerfTemplate, Schema.Literal("custom"))
export type PerfRecordTemplateKind = typeof PerfRecordTemplateKind.Type

export const perfTemplateChoices = [...perfTemplateValues]
export const perfTemplateChoiceText = perfTemplateChoices.join("|")

const defaultPerfTimeLimits: Record<PerfTemplate, string> = {
  "time-profiler": "3s",
  "system-trace": "3s",
  "metal-system-trace": "60s",
  "hangs": "3s",
  "swift-concurrency": "3s",
  logging: "3s",
}

export const defaultPerfTimeLimitForTemplate = (template: PerfTemplate): string => defaultPerfTimeLimits[template]

export const PerfDiagnosisSeverity = Schema.Literal("info", "warning")
export type PerfDiagnosisSeverity = typeof PerfDiagnosisSeverity.Type

export const PerfMetric = Schema.Struct({
  label: Schema.String,
  value: Schema.String,
})
export type PerfMetric = typeof PerfMetric.Type

export const PerfSummary = Schema.Struct({
  headline: Schema.String,
  metrics: Schema.Array(PerfMetric),
})
export type PerfSummary = typeof PerfSummary.Type

export const PerfDiagnosis = Schema.Struct({
  code: Schema.String,
  severity: PerfDiagnosisSeverity,
  summary: Schema.String,
  details: Schema.Array(Schema.String),
  wall: Schema.Boolean,
})
export type PerfDiagnosis = typeof PerfDiagnosis.Type

// PRB-097: record() is trace-first -- it launches zero schema-export
// subprocesses. `artifacts` only ever holds the trace bundle and its TOC;
// the "forty exports" a custom template used to produce eagerly are gone.
export const PerfArtifacts = Schema.Struct({
  trace: ArtifactRecord,
  toc: ArtifactRecord,
})
export type PerfArtifacts = typeof PerfArtifacts.Type

// PRB-097: the compact schema catalog record() returns instead of eagerly
// exporting every schema the TOC advertises. One entry per schema name; no
// row/byte data (that requires an export, which is the lazy `perf.export`/
// `perf.analyze` capability's job, not record()'s).
export const PerfSchemaCatalogEntry = Schema.Struct({
  schema: Schema.String,
})
export type PerfSchemaCatalogEntry = typeof PerfSchemaCatalogEntry.Type

export const PerfSessionOutcome = Schema.Struct({
  state: SessionPhase,
  healthCheck: SessionHealthCheck,
})
export type PerfSessionOutcome = typeof PerfSessionOutcome.Type

export const PerfRecordResult = Schema.Struct({
  sessionId: Schema.String,
  template: PerfRecordTemplateKind,
  templateName: Schema.String,
  customTemplatePath: Schema.optional(Schema.String),
  timeLimit: Schema.String,
  recordedAt: Schema.String,
  xctraceVersion: Schema.String,
  session: PerfSessionOutcome,
  summary: PerfSummary,
  diagnoses: Schema.Array(PerfDiagnosis),
  schemas: Schema.Array(PerfSchemaCatalogEntry),
  artifacts: PerfArtifacts,
})
export type PerfRecordResult = typeof PerfRecordResult.Type

export const PerfAroundFlowArtifacts = Schema.Struct({
  trace: ArtifactRecord,
  toc: ArtifactRecord,
})
export type PerfAroundFlowArtifacts = typeof PerfAroundFlowArtifacts.Type

export const PerfAroundFlowResult = Schema.Struct({
  sessionId: Schema.String,
  template: PerfTemplate,
  templateName: Schema.String,
  recordedAt: Schema.String,
  xctraceVersion: Schema.String,
  session: PerfSessionOutcome,
  flow: SessionFlowResultSchema,
  diagnoses: Schema.Array(PerfDiagnosis),
  artifacts: PerfAroundFlowArtifacts,
})
export type PerfAroundFlowResult = typeof PerfAroundFlowResult.Type

// PRB-094: `PerfAroundFlowResult` above is `PerfService.recordAroundFlow`'s
// *internal* return shape -- it embeds the same unbounded `flow` (a full
// `SessionFlowResult`, `executedSteps`/`artifacts`/`warnings` inline) that
// `SessionRegistry.runFlow` returns, since `PerfService` needs the whole
// flow result to build `diagnoses` from it. Only the outermost RPC response
// (built in `ProbeKernel.ts`'s `perf.around` handler, the one place this
// result actually gets serialized to a caller) swaps embedded `flow` for its
// bounded-collection form via the same `bindFlowResultForWire` step
// `session.run` already uses -- otherwise a 10k-step flow run under
// `perf.around` would inline every step and blow past the generic
// 4 KiB / 100 line inline budget the same way an unbounded `session.run`
// response would.
export const BoundedPerfAroundFlowResult = Schema.Struct({
  ...PerfAroundFlowResult.fields,
  flow: BoundedFlowV2ResultSchema,
})
export type BoundedPerfAroundFlowResult = typeof BoundedPerfAroundFlowResult.Type

export const PerfSummaryGroupBy = Schema.Literal("signpost")
export type PerfSummaryGroupBy = typeof PerfSummaryGroupBy.Type

export const PerfSignpostGroup = Schema.Struct({
  intervalName: Schema.String,
  count: Schema.Number,
  minDurationNs: Schema.Number,
  maxDurationNs: Schema.Number,
  avgDurationNs: Schema.Number,
  wallTimeNs: Schema.Number,
})
export type PerfSignpostGroup = typeof PerfSignpostGroup.Type

export const PerfSignpostSummaryArtifacts = Schema.Struct({
  trace: ArtifactRecord,
  toc: ArtifactRecord,
  export: ArtifactRecord,
})
export type PerfSignpostSummaryArtifacts = typeof PerfSignpostSummaryArtifacts.Type

export const PerfSignpostSummaryResult = Schema.Struct({
  sessionId: Schema.String,
  artifactKey: Schema.String,
  groupBy: PerfSummaryGroupBy,
  generatedAt: Schema.String,
  xctraceVersion: Schema.String,
  totalIntervals: Schema.Number,
  groups: Schema.Array(PerfSignpostGroup),
  artifacts: PerfSignpostSummaryArtifacts,
})
export type PerfSignpostSummaryResult = typeof PerfSignpostSummaryResult.Type

// PRB-097: `perf.export` -- one requested schema/XPath derivative, exported
// on demand from an already-recorded trace, cached by trace identity + run
// number + schema + XPath + xctrace version. Never inlines raw XML; the
// export always lands as a durable ArtifactRecord.
export const PerfExportArtifacts = Schema.Struct({
  trace: ArtifactRecord,
  toc: ArtifactRecord,
  export: ArtifactRecord,
})
export type PerfExportArtifacts = typeof PerfExportArtifacts.Type

export const PerfExportResult = Schema.Struct({
  sessionId: Schema.String,
  artifactKey: Schema.String,
  schema: Schema.String,
  xpath: Schema.String,
  runNumber: Schema.String,
  xctraceVersion: Schema.String,
  exportedAt: Schema.String,
  cacheHit: Schema.Boolean,
  rowCount: Schema.Number,
  bytesWritten: Schema.Number,
  artifacts: PerfExportArtifacts,
})
export type PerfExportResult = typeof PerfExportResult.Type

// PRB-097: `perf.analyze` -- lazily exports (and caches) only the schemas a
// single named built-in analyzer needs, then runs that analyzer's existing
// math. Custom templates have no built-in analyzer, so `analyzer` is scoped
// to the six built-in templates -- the same set `perf.record --template`
// accepts.
export const PerfAnalyzerName = PerfTemplate
export type PerfAnalyzerName = typeof PerfAnalyzerName.Type

export const PerfAnalyzeArtifacts = Schema.Struct({
  trace: ArtifactRecord,
  toc: ArtifactRecord,
  exports: Schema.Array(ArtifactRecord),
})
export type PerfAnalyzeArtifacts = typeof PerfAnalyzeArtifacts.Type

export const PerfAnalyzeResult = Schema.Struct({
  sessionId: Schema.String,
  artifactKey: Schema.String,
  analyzer: PerfAnalyzerName,
  analyzedAt: Schema.String,
  xctraceVersion: Schema.String,
  summary: PerfSummary,
  diagnoses: Schema.Array(PerfDiagnosis),
  artifacts: PerfAnalyzeArtifacts,
})
export type PerfAnalyzeResult = typeof PerfAnalyzeResult.Type

export interface ParsedPerfCell {
  readonly raw: string | null
  readonly display: string | null
}

export interface ParsedPerfTable {
  readonly schema: string
  readonly mnemonics: ReadonlyArray<string>
  readonly rows: ReadonlyArray<Record<string, ParsedPerfCell | null>>
}

type PerfRow = Record<string, ParsedPerfCell | null>

const childElementPattern = /<([a-zA-Z0-9-]+)([^>]*)>([\s\S]*?)<\/\1>|<([a-zA-Z0-9-]+)([^>]*)\/>/g
const attributePattern = /([a-zA-Z0-9-]+)="([^"]*)"/g

const parseAttributes = (raw: string): Record<string, string> => {
  const attributes: Record<string, string> = {}

  for (const match of raw.matchAll(attributePattern)) {
    const [, key, value] = match

    if (key && value !== undefined) {
      attributes[key] = value
    }
  }

  return attributes
}

const parseSchemaMnemonics = (schemaFragment: string): ReadonlyArray<string> =>
  [...schemaFragment.matchAll(/<mnemonic>(.*?)<\/mnemonic>/g)]
    .map((match) => match[1]?.trim() ?? "")
    .filter((mnemonic) => mnemonic.length > 0)

const readStructuredRaw = (tagName: string, inner: string): string | null => {
  switch (tagName) {
    case "process":
      return inner.match(/<pid[^>]*>([^<]+)<\/pid>/)?.[1]?.trim() ?? null
    case "thread":
      return (
        inner.match(/<process[^>]*>[\s\S]*?<pid[^>]*>([^<]+)<\/pid>[\s\S]*?<\/process>/)?.[1]?.trim()
        ?? inner.match(/<tid[^>]*>([^<]+)<\/tid>/)?.[1]?.trim()
        ?? null
      )
    case "kperf-bt": {
      // Prefer the leaf PC from nested <text-address>, then the full PC chain.
      // These are unsymbolicated addresses — still agent-actionable as hot-leaf ids.
      const leaf = inner.match(/<text-address\b[^>]*>([^<]+)<\/text-address>/)?.[1]?.trim()
      if (leaf) {
        return leaf
      }
      const chain = inner.match(/<text-addresses\b[^>]*>([^<]+)<\/text-addresses>/)?.[1]?.trim()
      return chain && chain.length > 0 ? chain.split(/\s+/)[0] ?? null : null
    }
    default:
      return null
  }
}

/** Normalize a leaf callstack identity from either raw PC or Instruments fmt text. */
const leafCallstackIdentity = (row: PerfRow, mnemonic: string): string | null => {
  const raw = readRaw(row, mnemonic)
  if (raw && /^\d+$/.test(raw)) {
    const asHex = `0x${BigInt(raw).toString(16)}`
    return asHex
  }
  if (raw && /^0x[0-9a-fA-F]+$/i.test(raw)) {
    return raw.toLowerCase()
  }
  const display = readDisplay(row, mnemonic)
  if (!display) {
    return null
  }
  const pcMatch = display.match(/PC:(0x[0-9a-fA-F]+)/i)
  if (pcMatch?.[1]) {
    return pcMatch[1].toLowerCase()
  }
  // Fall back to the full display when Instruments already symbolicated something useful.
  const compact = display.trim()
  return compact.length > 0 ? compact : null
}

const isMainThreadLabel = (thread: string): boolean => /main\s*thread/i.test(thread)

const buildCell = (
  tagName: string,
  attributes: Record<string, string>,
  inner: string,
  refs: Map<string, ParsedPerfCell>,
): ParsedPerfCell | null => {
  if (tagName === "sentinel") {
    return null
  }

  if (attributes.ref) {
    const referenced = refs.get(attributes.ref)

    if (referenced) {
      return referenced
    }

    return {
      raw: null,
      display: attributes.fmt ?? null,
    }
  }

  const hasNestedTags = inner.includes("<")
  const raw = hasNestedTags
    ? readStructuredRaw(tagName, inner)
    : (inner.trim().length > 0 ? inner.trim() : null)
  const cell: ParsedPerfCell = {
    raw,
    display: attributes.fmt ?? raw,
  }

  if (attributes.id) {
    refs.set(attributes.id, cell)
  }

  return cell
}

export const parsePerfTableExport = (xml: string): ParsedPerfTable => {
  const schemaMatch = xml.match(/<schema\b([^>]*)>([\s\S]*?)<\/schema>/)

  if (!schemaMatch) {
    throw new Error("Missing schema block in xctrace export output.")
  }

  const schemaAttributes = schemaMatch[1] ?? ""
  const schema = parseAttributes(schemaAttributes).name?.trim()
  const schemaBody = schemaMatch[2] ?? ""

  if (!schema) {
    throw new Error("Missing schema name in xctrace export output.")
  }

  const mnemonics = parseSchemaMnemonics(schemaBody)
  const refs = new Map<string, ParsedPerfCell>()
  const rows: Array<PerfRow> = []

  for (const rowMatch of xml.matchAll(/<row>([\s\S]*?)<\/row>/g)) {
    const rowBody = rowMatch[1] ?? ""
    const values = [...rowBody.matchAll(childElementPattern)].map((match) => {
      const tagName = match[1] ?? match[4] ?? ""
      const attributes = parseAttributes(match[2] ?? match[5] ?? "")
      const inner = match[3] ?? ""
      return buildCell(tagName, attributes, inner, refs)
    })

    const row: PerfRow = {}

    mnemonics.forEach((mnemonic, index) => {
      row[mnemonic] = values[index] ?? null
    })

    rows.push(row)
  }

  return {
    schema,
    mnemonics,
    rows,
  }
}

// PRB-098: exported so the cross-channel evidence-correlation module
// (perf-evidence.ts) can read the same generic table cells these
// single-channel analyzers already read, instead of re-parsing rows itself.
export const readRaw = (row: PerfRow, mnemonic: string): string | null => row[mnemonic]?.raw ?? null

export const readDisplay = (row: PerfRow, mnemonic: string): string | null =>
  row[mnemonic]?.display ?? row[mnemonic]?.raw ?? null

export const readNumber = (row: PerfRow, mnemonic: string): number | null => {
  const raw = readRaw(row, mnemonic)

  if (!raw) {
    return null
  }

  const value = Number(raw)
  return Number.isFinite(value) ? value : null
}

const readLabel = (row: PerfRow, mnemonics: ReadonlyArray<string>): string | null => {
  for (const mnemonic of mnemonics) {
    const value = readDisplay(row, mnemonic) ?? readRaw(row, mnemonic)

    if (value && value.trim().length > 0) {
      return value.trim()
    }
  }

  return null
}

const averageOf = (values: ReadonlyArray<number>): number | null =>
  values.length === 0 ? null : values.reduce((total, value) => total + value, 0) / values.length

const countBy = (values: ReadonlyArray<string>): ReadonlyArray<readonly [string, number]> =>
  [...values.reduce((counts, value) => counts.set(value, (counts.get(value) ?? 0) + 1), new Map<string, number>()).entries()].sort(
    (left, right) => right[1] - left[1] || left[0].localeCompare(right[0]),
  )

const summarizeCounts = (
  values: ReadonlyArray<string>,
  limit = 3,
  emptyValue = "none",
): string => {
  const counts = countBy(values)

  if (counts.length === 0) {
    return emptyValue
  }

  return counts
    .slice(0, limit)
    .map(([label, count]) => `${label} (${count})`)
    .join(", ")
}

const uniqueCount = (values: ReadonlyArray<string>): number => new Set(values).size

export const assertSchemaContract = (args: {
  readonly table: ParsedPerfTable
  readonly schema: string
  readonly requiredMnemonics: ReadonlyArray<string>
}): void => {
  if (args.table.schema !== args.schema) {
    throw new Error(`Expected xctrace schema ${args.schema}, received ${args.table.schema}.`)
  }

  const missing = args.requiredMnemonics.filter((mnemonic) => !args.table.mnemonics.includes(mnemonic))

  if (missing.length > 0) {
    throw new Error(`xctrace schema ${args.schema} is missing required columns: ${missing.join(", ")}.`)
  }
}

export const formatNanoseconds = (value: number | null): string => {
  if (value === null || !Number.isFinite(value)) {
    return "n/a"
  }

  if (value >= 1_000_000_000) {
    return `${(value / 1_000_000_000).toFixed(2)} s`
  }

  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(2)} ms`
  }

  if (value >= 1_000) {
    return `${(value / 1_000).toFixed(2)} µs`
  }

  return `${value.toFixed(0)} ns`
}

const formatRatio = (value: number): string => `${(value * 100).toFixed(1)}%`

const formatFramesPerSecond = (value: number | null): string => {
  if (value === null || !Number.isFinite(value) || value <= 0) {
    return "n/a"
  }

  return `${value.toFixed(1)} fps`
}

const formatCount = (value: number, singular: string, plural = `${singular}s`): string => `${value} ${value === 1 ? singular : plural}`

const compactText = (value: string | null, maxLength = 160): string | null => {
  if (!value) {
    return null
  }

  const compact = value.replace(/\s+/g, " ").trim()

  if (compact.length === 0) {
    return null
  }

  return compact.length > maxLength
    ? `${compact.slice(0, maxLength - 1).trimEnd()}…`
    : compact
}

const warningDiagnosis = (code: string, summary: string, details: ReadonlyArray<string>): PerfDiagnosis => ({
  code,
  severity: "warning",
  summary,
  details: [...details],
  wall: false,
})

const infoDiagnosis = (code: string, summary: string, details: ReadonlyArray<string>): PerfDiagnosis => ({
  code,
  severity: "info",
  summary,
  details: [...details],
  wall: false,
})

const wallDiagnosis = (code: string, summary: string, details: ReadonlyArray<string>): PerfDiagnosis => ({
  code,
  severity: "info",
  summary,
  details: [...details],
  wall: true,
})

export const summarizeSignpostIntervalsTable = (table: ParsedPerfTable): ReadonlyArray<PerfSignpostGroup> => {
  assertSchemaContract({
    table,
    schema: "os-signpost-interval",
    requiredMnemonics: ["name", "duration"],
  })

  const aggregates = new Map<string, { count: number; min: number; max: number; total: number }>()

  for (const row of table.rows) {
    const intervalName = readDisplay(row, "name") ?? readRaw(row, "name")
    const duration = readNumber(row, "duration")

    if (!intervalName || duration === null) {
      continue
    }

    const existing = aggregates.get(intervalName)

    if (existing) {
      existing.count += 1
      existing.min = Math.min(existing.min, duration)
      existing.max = Math.max(existing.max, duration)
      existing.total += duration
      continue
    }

    aggregates.set(intervalName, {
      count: 1,
      min: duration,
      max: duration,
      total: duration,
    })
  }

  return [...aggregates.entries()]
    .map(([intervalName, aggregate]) => ({
      intervalName,
      count: aggregate.count,
      minDurationNs: aggregate.min,
      maxDurationNs: aggregate.max,
      avgDurationNs: aggregate.total / aggregate.count,
      wallTimeNs: aggregate.total,
    }))
    .sort((left, right) => right.wallTimeNs - left.wallTimeNs || left.intervalName.localeCompare(right.intervalName))
}

export const analyzeSignpostIntervalTable = (table: ParsedPerfTable): {
  readonly summary: PerfSummary
  readonly diagnoses: ReadonlyArray<PerfDiagnosis>
} => {
  const groups = summarizeSignpostIntervalsTable(table)
  const totalIntervals = groups.reduce((total, group) => total + group.count, 0)
  const totalWallTimeNs = groups.reduce((total, group) => total + group.wallTimeNs, 0)
  const averageDurationNs = totalIntervals === 0 ? null : totalWallTimeNs / totalIntervals
  const topGroup = groups[0] ?? null
  const diagnoses: Array<PerfDiagnosis> = []

  if (totalIntervals === 0) {
    diagnoses.push(
      warningDiagnosis(
        "logging-no-signpost-intervals",
        "The recording did not export any signpost interval rows.",
        ["Verify the app emits os_signpost / OSSignposter intervals during the recorded flow, then retry the capture."],
      ),
    )
  }

  return {
    summary: {
      headline:
        totalIntervals === 0
          ? "No signpost intervals were exported."
          : topGroup
            ? `Observed ${totalIntervals} signpost intervals across ${groups.length} interval name(s); ${topGroup.intervalName} dominated the wall time.`
            : `Observed ${totalIntervals} signpost intervals across ${groups.length} interval name(s).`,
      metrics: [
        { label: "Signpost intervals", value: String(totalIntervals) },
        { label: "Interval groups", value: String(groups.length) },
        { label: "Avg duration", value: formatNanoseconds(averageDurationNs) },
        { label: "Total wall time", value: formatNanoseconds(totalWallTimeNs === 0 ? null : totalWallTimeNs) },
        { label: "Top interval", value: topGroup ? `${topGroup.intervalName} (${topGroup.count}, ${formatNanoseconds(topGroup.wallTimeNs)})` : "none" },
      ],
    },
    diagnoses,
  }
}

export const analyzeTimeProfilerTable = (table: ParsedPerfTable): {
  readonly summary: PerfSummary
  readonly diagnoses: ReadonlyArray<PerfDiagnosis>
} => {
  assertSchemaContract({
    table,
    schema: "time-sample",
    requiredMnemonics: ["time", "thread", "core-index", "thread-state", "sample-type"],
  })

  const sampleCount = table.rows.length
  const threads = table.rows.map((row) => readDisplay(row, "thread")).filter((value): value is string => value !== null)
  const cores = table.rows.map((row) => readDisplay(row, "core-index")).filter((value): value is string => value !== null)
  const states = table.rows.map((row) => readDisplay(row, "thread-state")).filter((value): value is string => value !== null)
  const sampleKinds = table.rows.map((row) => readDisplay(row, "sample-type")).filter((value): value is string => value !== null)
  const timestamps = table.rows.map((row) => readNumber(row, "time")).filter((value): value is number => value !== null)
  const windowNs = timestamps.length > 1 ? Math.max(...timestamps) - Math.min(...timestamps) : null
  const stateCounts = new Map(countBy(states))
  const blockedCount = stateCounts.get("Blocked") ?? 0
  const topCore = countBy(cores)[0] ?? null
  const diagnoses: Array<PerfDiagnosis> = []

  // Prefer user stacks; fall back to kernel when user column is absent/sentinel.
  const hasUserStackMnemonic = table.mnemonics.includes("cp-user-callstack")
  const hasKernelStackMnemonic = table.mnemonics.includes("cp-kernel-callstack")
  const leafStacks = table.rows
    .map((row) => {
      if (hasUserStackMnemonic) {
        const user = leafCallstackIdentity(row, "cp-user-callstack")
        if (user) {
          return user
        }
      }
      if (hasKernelStackMnemonic) {
        return leafCallstackIdentity(row, "cp-kernel-callstack")
      }
      return null
    })
    .filter((value): value is string => value !== null)
  const topLeaves = countBy(leafStacks).slice(0, 5)
  const topThreads = countBy(threads).slice(0, 5)
  const mainThreadSamples = threads.filter(isMainThreadLabel).length
  const mainThreadShare = sampleCount > 0 ? mainThreadSamples / sampleCount : 0

  if (sampleCount === 0) {
    diagnoses.push(
      warningDiagnosis(
        "time-profiler-no-rows",
        "Time Profiler exported no sample rows for the requested interval.",
        ["Drive more target workload, or increase the time limit before trusting CPU conclusions."],
      ),
    )
  }

  if (sampleCount > 0 && blockedCount / sampleCount >= 0.5) {
    diagnoses.push(
      warningDiagnosis(
        "time-profiler-mostly-blocked",
        "Most exported CPU samples captured blocked threads instead of runnable work.",
        [
          `${blockedCount} of ${sampleCount} samples were blocked (${formatRatio(blockedCount / sampleCount)}).`,
          "This usually means the trace window was too idle to support hot-code diagnosis.",
        ],
      ),
    )
  }

  if (topCore && sampleCount >= 20 && topCore[1] / sampleCount >= 0.7) {
    diagnoses.push(
      warningDiagnosis(
        "time-profiler-core-hotspot",
        "Recorded samples concentrated on a single observed core.",
        [`${topCore[0]} accounted for ${topCore[1]} of ${sampleCount} samples (${formatRatio(topCore[1] / sampleCount)}).`],
      ),
    )
  }

  if (topLeaves.length > 0) {
    diagnoses.push(
      infoDiagnosis(
        "time-profiler-top-leaves",
        `Top leaf callstack PCs: ${topLeaves.map(([leaf, count]) => `${leaf} (${count})`).join(", ")}.`,
        [
          "These are unsymbolicated program counters from cp-user-callstack (or kernel fallback).",
          "Symbolicate with atos/dsymutil against the matching app binary for function names, or open the .trace in Instruments.",
          "Leaf PC heat is still enough to diff before/after and spot regressions.",
        ],
      ),
    )
  }

  if (sampleCount > 0 && mainThreadShare >= 0.4) {
    diagnoses.push(
      warningDiagnosis(
        "time-profiler-main-thread-heavy",
        `Main thread carried ${formatRatio(mainThreadShare)} of exported samples (${mainThreadSamples} of ${sampleCount}).`,
        [
          "High main-thread sample share often means UI/jank risk — move work off Main Thread or reduce per-frame main work.",
          topLeaves[0] ? `Hottest leaf PC overall: ${topLeaves[0][0]} (${topLeaves[0][1]} samples).` : "No leaf PC extracted from callstack columns.",
        ],
      ),
    )
  }

  if (leafStacks.length === 0 && sampleCount > 0) {
    diagnoses.push(
      wallDiagnosis(
        "time-profiler-callstack-wall",
        "Time Profiler samples exported, but no user/kernel callstack cells were present to attribute leaf PCs.",
        [
          "Confirm the TOC advertises cp-user-callstack / cp-kernel-callstack and that the export was not truncated before stack columns.",
          "Open the raw .trace in Instruments if stacks are visible there but missing from the XML export.",
        ],
      ),
    )
  } else if (leafStacks.length > 0) {
    diagnoses.push(
      infoDiagnosis(
        "time-profiler-symbolication-note",
        "Leaf callstack PCs are interpreted; human-readable symbol names still need binary symbolication.",
        [
          "Probe does not yet run atos against the target .app/dSYM automatically.",
          "Pass the matching binary to atos, or open the .trace in Instruments for symbolicated heavy stacks.",
        ],
      ),
    )
  }

  const topLeafSummary = topLeaves.length === 0
    ? "none"
    : topLeaves.map(([leaf, count]) => `${leaf}×${count}`).join(", ")
  const topThreadSummary = topThreads.length === 0
    ? "none"
    : topThreads.map(([thread, count]) => `${thread.split(" (")[0] ?? thread}×${count}`).join(", ")

  return {
    summary: {
      headline:
        sampleCount === 0
          ? "No Time Profiler samples were exported."
          : topLeaves[0]
            ? `Collected ${sampleCount} CPU samples across ${uniqueCount(threads)} threads; hottest leaf ${topLeaves[0][0]} (${topLeaves[0][1]} samples).`
            : `Collected ${sampleCount} CPU samples across ${uniqueCount(threads)} threads.`,
      metrics: [
        { label: "Samples", value: String(sampleCount) },
        { label: "Threads", value: String(uniqueCount(threads)) },
        { label: "Observed cores", value: cores.length === 0 ? "none" : String(uniqueCount(cores)) },
        { label: "States", value: summarizeCounts(states) },
        { label: "Sample kinds", value: summarizeCounts(sampleKinds) },
        { label: "Sample window", value: formatNanoseconds(windowNs) },
        { label: "Main thread share", value: sampleCount === 0 ? "n/a" : formatRatio(mainThreadShare) },
        { label: "Top leaf PCs", value: topLeafSummary },
        { label: "Top threads", value: topThreadSummary },
        { label: "Stacks attributed", value: String(leafStacks.length) },
      ],
    },
    diagnoses,
  }
}

const matchesTargetProcess = (
  row: PerfRow,
  targetPid: number,
): boolean => {
  const pid = String(targetPid)
  const processPattern = new RegExp(`\\(${pid}\\)`)
  const threadPattern = new RegExp(`pid:\\s*${pid}\\)`)

  if (readRaw(row, "process") === pid || readRaw(row, "thread") === pid) {
    return true
  }

  return [readDisplay(row, "process"), readDisplay(row, "thread")].some((value) =>
    value ? processPattern.test(value) || threadPattern.test(value) : false,
  )
}

export const analyzeSystemTraceTables = (args: {
  readonly threadStateTable: ParsedPerfTable
  readonly cpuStateTable?: ParsedPerfTable
  readonly targetPid: number
}): {
  readonly summary: PerfSummary
  readonly diagnoses: ReadonlyArray<PerfDiagnosis>
} => {
  assertSchemaContract({
    table: args.threadStateTable,
    schema: "thread-state",
    requiredMnemonics: ["thread", "state", "process", "cputime", "waittime"],
  })
  if (args.cpuStateTable) {
    assertSchemaContract({
      table: args.cpuStateTable,
      schema: "cpu-state",
      requiredMnemonics: ["cpu", "state", "process", "thread"],
    })
  }

  const targetThreadRows = args.threadStateTable.rows.filter((row) => matchesTargetProcess(row, args.targetPid))
  const targetCpuRows = args.cpuStateTable
    ? args.cpuStateTable.rows.filter((row) => matchesTargetProcess(row, args.targetPid))
    : []
  const threadStates = targetThreadRows
    .map((row) => readDisplay(row, "state"))
    .filter((value): value is string => value !== null)
  const totalCpuNs = targetThreadRows.reduce((total, row) => total + (readNumber(row, "cputime") ?? 0), 0)
  const totalWaitNs = targetThreadRows.reduce((total, row) => total + (readNumber(row, "waittime") ?? 0), 0)
  const busyCores = targetCpuRows
    .filter((row) => readDisplay(row, "state") !== "Idle")
    .map((row) => readDisplay(row, "cpu"))
    .filter((value): value is string => value !== null)
  const diagnoses: Array<PerfDiagnosis> = []

  if (targetThreadRows.length === 0) {
    diagnoses.push(
      warningDiagnosis(
        "system-trace-no-target-thread-rows",
        "System Trace did not export any thread-state rows tied back to the target pid.",
        [
          `Probe filtered thread intervals to pid ${args.targetPid} so unrelated system activity does not masquerade as app behavior.`,
          "Inspect the saved .trace bundle if you need the broader system-wide view.",
        ],
      ),
    )
  }

  if (targetThreadRows.length > 0 && totalWaitNs > totalCpuNs * 2) {
    diagnoses.push(
      warningDiagnosis(
        "system-trace-wait-heavy",
        "Target thread intervals spent much more time waiting than running.",
        [
          `Running time: ${formatNanoseconds(totalCpuNs)}.`,
          `Wait time: ${formatNanoseconds(totalWaitNs)}.`,
        ],
      ),
    )
  }

  const blockedCount = threadStates.filter((state) => state === "Blocked").length

  if (targetThreadRows.length > 0 && blockedCount / targetThreadRows.length >= 0.5) {
    diagnoses.push(
      warningDiagnosis(
        "system-trace-blocked-heavy",
        "Blocked intervals dominated the target thread-state export.",
        [`Blocked accounted for ${blockedCount} of ${targetThreadRows.length} target intervals (${formatRatio(blockedCount / targetThreadRows.length)}).`],
      ),
    )
  }

  diagnoses.push(
    wallDiagnosis(
      "system-trace-attribution-wall",
      "Probe's first System Trace summary only uses rows that still carry the target pid; unattributed system-wide intervals remain outside the supported summary contract.",
      ["Inspect the saved .trace bundle when you need system-wide scheduler attribution beyond the filtered target rows."],
    ),
  )

  if (args.cpuStateTable && args.cpuStateTable.rows.length > 20_000) {
    diagnoses.push(
      infoDiagnosis(
        "system-trace-large-cpu-state",
        "The cpu-state export contained a large number of device-wide rows.",
        [
          `${args.cpuStateTable.rows.length} cpu-state rows were exported. xctrace exports are device-wide and cannot be scoped to a single process at export time.`,
          "Probe filters to target process rows for analysis, but the full export must be budgeted for the entire device.",
          "Inspect the saved .trace bundle if you need the unfiltered device-wide view.",
        ],
      ),
    )
  }

  return {
    summary: {
      headline:
        targetThreadRows.length === 0 && targetCpuRows.length === 0
          ? `No target-attributed System Trace rows were exported for pid ${args.targetPid}.`
          : `Observed ${targetThreadRows.length} target thread intervals and ${targetCpuRows.length} target CPU intervals for pid ${args.targetPid}.`,
      metrics: [
        { label: "Target thread intervals", value: String(targetThreadRows.length) },
        { label: "Target CPU intervals", value: String(targetCpuRows.length) },
        { label: "Thread states", value: summarizeCounts(threadStates) },
        { label: "Running time", value: formatNanoseconds(totalCpuNs) },
        { label: "Wait time", value: formatNanoseconds(totalWaitNs) },
        { label: "Busy cores", value: busyCores.length === 0 ? "none" : String(uniqueCount(busyCores)) },
      ],
    },
    diagnoses,
  }
}

const sixtyFpsFrameBudgetNs = 16_667_000
const longRunningSwiftTaskThresholdNs = 100_000_000

interface MetalFrameEstimate {
  readonly frameId: string
  readonly duration: number
}

/** Thresholds for detecting unreliable frame grouping in GPU interval exports. */
const unreliableFrameAverageNs = 100_000_000 // 100 ms — real apps rarely run below 10 fps
const unreliableFrameSpanNs = 500_000_000 // 500 ms — single frame spanning half a second signals mixed ownership

interface MetalEncoderAggregate {
  readonly label: string
  readonly encoderCount: number
  readonly commandBufferCount: number
  readonly totalDuration: number
  readonly averageDuration: number
}

const isAppRenderGpuChannel = (channel: string | null): boolean => {
  if (!channel) {
    return false
  }
  // Prefer channels that describe app render work. Numeric / empty / compositor-ish
  // labels are excluded so frame spans are less likely to mix system intervals.
  const normalized = channel.trim().toLowerCase()
  if (normalized.length === 0) {
    return false
  }
  if (/^\d+$/.test(normalized)) {
    return false
  }
  if (normalized.includes("compositor") || normalized.includes("backboard") || normalized.includes("springboard")) {
    return false
  }
  return (
    normalized.includes("fragment")
    || normalized.includes("vertex")
    || normalized.includes("compute")
    || normalized.includes("render")
    || normalized.includes("tile")
  )
}

const buildMetalFrameEstimates = (
  rows: ReadonlyArray<PerfRow>,
  options?: { readonly appRenderChannelsOnly?: boolean },
): {
  readonly estimates: ReadonlyArray<MetalFrameEstimate>
  readonly reliable: boolean
  readonly channelFilter: "all" | "app-render"
} => {
  const frames = new Map<string, { minStart: number; maxEnd: number }>()
  const appRenderChannelsOnly = options?.appRenderChannelsOnly === true

  for (const row of rows) {
    if (appRenderChannelsOnly) {
      const channel = readDisplay(row, "channel-name") ?? readRaw(row, "channel-name")
      if (!isAppRenderGpuChannel(channel)) {
        continue
      }
    }

    const frameId = readDisplay(row, "frame-number") ?? readRaw(row, "frame-number")
    const start = readNumber(row, "start")
    const duration = readNumber(row, "duration")

    if (frameId === null || start === null || duration === null) {
      continue
    }

    const existing = frames.get(frameId)
    const end = start + duration

    if (existing) {
      existing.minStart = Math.min(existing.minStart, start)
      existing.maxEnd = Math.max(existing.maxEnd, end)
      continue
    }

    frames.set(frameId, { minStart: start, maxEnd: end })
  }

  const estimates = [...frames.entries()]
    .map(([frameId, bounds]) => ({
      frameId,
      duration: bounds.maxEnd - bounds.minStart,
    }))
    .sort((left, right) => left.frameId.localeCompare(right.frameId, undefined, { numeric: true }))

  if (estimates.length === 0) {
    return {
      estimates,
      reliable: true,
      channelFilter: appRenderChannelsOnly ? "app-render" : "all",
    }
  }

  const averageFrameDuration = estimates.reduce((total, frame) => total + frame.duration, 0) / estimates.length
  const hasExtremeOutlier = estimates.some((frame) => frame.duration > unreliableFrameSpanNs)

  const reliable = averageFrameDuration < unreliableFrameAverageNs && !hasExtremeOutlier

  return {
    estimates,
    reliable,
    channelFilter: appRenderChannelsOnly ? "app-render" : "all",
  }
}

const pickBestMetalFrameEstimates = (rows: ReadonlyArray<PerfRow>) => {
  const appRender = buildMetalFrameEstimates(rows, { appRenderChannelsOnly: true })
  if (appRender.estimates.length > 0 && appRender.reliable) {
    return appRender
  }

  const allChannels = buildMetalFrameEstimates(rows, { appRenderChannelsOnly: false })
  if (allChannels.estimates.length > 0 && allChannels.reliable) {
    return allChannels
  }

  // Prefer the denser unreliable set for diagnostics (still withheld for FPS).
  if (appRender.estimates.length >= allChannels.estimates.length && appRender.estimates.length > 0) {
    return appRender
  }
  return allChannels
}

const buildMetalGpuCounterSummary = (table: ParsedPerfTable | undefined) => {
  if (!table || table.rows.length === 0) {
    return null
  }

  // GPU counter exports vary by template; stay mnemonic-flexible.
  const counterNames = table.rows
    .map((row) =>
      readLabel(row, ["counter-name", "name", "metric", "label", "gpu-counter-name"])
      ?? readDisplay(row, "counter-name")
      ?? readDisplay(row, "name"),
    )
    .filter((value): value is string => value !== null)
  const values = table.rows
    .map((row) => readNumber(row, "value") ?? readNumber(row, "counter-value") ?? readNumber(row, "duration"))
    .filter((value): value is number => value !== null)

  return {
    rowCount: table.rows.length,
    counterNames: summarizeCounts(counterNames),
    averageValue: averageOf(values),
    maxValue: values.length === 0 ? null : Math.max(...values),
  }
}

const buildMetalEncoderAggregates = (table: ParsedPerfTable | undefined): ReadonlyArray<MetalEncoderAggregate> => {
  if (!table) {
    return []
  }

  assertSchemaContract({
    table,
    schema: "metal-application-encoders-list",
    requiredMnemonics: ["duration", "encoder-label", "cmdbuffer-id", "encoder-id"],
  })

  const aggregates = new Map<string, { duration: number; encoderCount: number; commandBuffers: Set<string> }>()

  for (const row of table.rows) {
    const label = readLabel(row, [
      "encoder-label",
      "encoder-label-indexed",
      "cmdbuffer-label",
      "cmdbuffer-label-indexed",
      "event-type",
    ]) ?? (readRaw(row, "encoder-id") ? `Encoder ${readRaw(row, "encoder-id")}` : null)
    const duration = readNumber(row, "duration")

    if (!label || duration === null) {
      continue
    }

    const commandBufferId = readRaw(row, "cmdbuffer-id") ?? readDisplay(row, "cmdbuffer-id") ?? "unknown"
    const existing = aggregates.get(label)

    if (existing) {
      existing.duration += duration
      existing.encoderCount += 1
      existing.commandBuffers.add(commandBufferId)
      continue
    }

    aggregates.set(label, {
      duration,
      encoderCount: 1,
      commandBuffers: new Set([commandBufferId]),
    })
  }

  return [...aggregates.entries()]
    .map(([label, aggregate]) => ({
      label,
      encoderCount: aggregate.encoderCount,
      commandBufferCount: aggregate.commandBuffers.size,
      totalDuration: aggregate.duration,
      averageDuration: aggregate.duration / aggregate.encoderCount,
    }))
    .sort((left, right) => right.totalDuration - left.totalDuration || left.label.localeCompare(right.label))
}

const summarizeEncoderAggregates = (aggregates: ReadonlyArray<MetalEncoderAggregate>, limit = 3): string => {
  if (aggregates.length === 0) {
    return "none"
  }

  return aggregates
    .slice(0, limit)
    .map((aggregate) => `${aggregate.label} (${formatCount(aggregate.commandBufferCount, "command buffer")}, ${formatNanoseconds(aggregate.totalDuration)} total, ${formatNanoseconds(aggregate.averageDuration)} avg)`)
    .join(", ")
}

const buildMetalDriverSummary = (table: ParsedPerfTable | undefined) => {
  if (!table) {
    return {
      eventCount: 0,
      averageDuration: null as number | null,
      maxDuration: null as number | null,
      eventTypes: [] as ReadonlyArray<string>,
    }
  }

  assertSchemaContract({
    table,
    schema: "metal-driver-event-intervals",
    requiredMnemonics: ["duration", "event-type", "event-label"],
  })

  const durations = table.rows.map((row) => readNumber(row, "duration")).filter((value): value is number => value !== null)
  const eventTypes = table.rows
    .map((row) => readLabel(row, ["event-label", "event-type"]))
    .filter((value): value is string => value !== null)

  return {
    eventCount: table.rows.length,
    averageDuration: averageOf(durations),
    maxDuration: durations.length === 0 ? null : Math.max(...durations),
    eventTypes,
  }
}

export const analyzeMetalSystemTraceTables = (args: {
  readonly gpuIntervalsTable: ParsedPerfTable
  readonly driverEventTable?: ParsedPerfTable
  readonly encoderListTable?: ParsedPerfTable
  readonly gpuCounterTable?: ParsedPerfTable
}): {
  readonly summary: PerfSummary
  readonly diagnoses: ReadonlyArray<PerfDiagnosis>
} => {
  assertSchemaContract({
    table: args.gpuIntervalsTable,
    schema: "metal-gpu-intervals",
    requiredMnemonics: ["start", "duration", "channel-name", "frame-number", "start-latency", "state"],
  })

  const rows = args.gpuIntervalsTable.rows
  const durations = rows.map((row) => readNumber(row, "duration")).filter((value): value is number => value !== null)
  const latencies = rows.map((row) => readNumber(row, "start-latency")).filter((value): value is number => value !== null)
  const states = rows.map((row) => readDisplay(row, "state")).filter((value): value is string => value !== null)
  const channels = rows.map((row) => readDisplay(row, "channel-name")).filter((value): value is string => value !== null)
  const maxDuration = durations.length === 0 ? null : Math.max(...durations)
  const maxLatency = latencies.length === 0 ? null : Math.max(...latencies)
  const averageDuration = averageOf(durations)
  const averageLatency = averageOf(latencies)
  const {
    estimates: frameEstimates,
    reliable: frameEstimatesReliable,
    channelFilter: frameChannelFilter,
  } = pickBestMetalFrameEstimates(rows)
  const gpuCounterSummary = buildMetalGpuCounterSummary(args.gpuCounterTable)
  const frameDurations = frameEstimates.map((frame) => frame.duration)
  const averageFrameDuration = averageOf(frameDurations)
  const maxFrameDuration = frameDurations.length === 0 ? null : Math.max(...frameDurations)
  const encoderAggregates = buildMetalEncoderAggregates(args.encoderListTable)
  const topEncoder = encoderAggregates[0] ?? null
  const driverSummary = buildMetalDriverSummary(args.driverEventTable)
  const diagnoses: Array<PerfDiagnosis> = []

  // FPS estimation: only compute and display when frame grouping is reliable.
  // Unreliable grouping produces fabricated frame rates from mixed-process/compositor noise.
  const estimatedFrameDuration = frameEstimatesReliable
    ? (averageFrameDuration ?? averageDuration)
    : averageDuration
  const averageFps = frameEstimatesReliable && estimatedFrameDuration !== null && estimatedFrameDuration > 0
    ? 1_000_000_000 / estimatedFrameDuration
    : null
  const framesOverBudget = frameEstimatesReliable
    ? frameDurations.filter((duration) => duration > sixtyFpsFrameBudgetNs).length
    : 0
  const estimatedFpsText = frameEstimatesReliable
    ? formatFramesPerSecond(averageFps)
    : "withheld (unreliable grouping)"
  const frameBudgetSummary = frameEstimatesReliable && frameEstimates.length > 0
    ? `${formatFramesPerSecond(averageFps)} average; ${framesOverBudget} of ${frameEstimates.length} frames exceeded ${formatNanoseconds(sixtyFpsFrameBudgetNs)}`
    : null

  if (rows.length === 0) {
    diagnoses.push(
      warningDiagnosis(
        "metal-no-rows",
        "Metal System Trace exported no GPU interval rows for the requested interval.",
        ["Drive a GPU-heavy workload before trusting GPU timing conclusions."],
      ),
    )
  }

  if (!frameEstimatesReliable && frameEstimates.length > 0) {
    diagnoses.push(
      warningDiagnosis(
        "metal-fps-withheld",
        "Frame-rate estimation was withheld because the GPU interval export showed unreliable frame grouping.",
        [
          `Channel filter used: ${frameChannelFilter}.`,
          `Average exported frame span: ${formatNanoseconds(averageFrameDuration)}.`,
          `Max exported frame span: ${formatNanoseconds(maxFrameDuration)}.`,
          "This typically happens when the GPU interval table mixes target-app and compositor/system intervals under the same frame IDs, producing inflated frame spans.",
          "Per-interval GPU timing and encoder breakdown remain trustworthy. The encoder export is usually the more reliable attribution seam.",
        ],
      ),
    )
  } else if (frameEstimatesReliable && frameEstimates.length > 0 && frameChannelFilter === "app-render") {
    diagnoses.push(
      infoDiagnosis(
        "metal-fps-app-render-channels",
        "Estimated FPS from Fragment/Vertex/Compute/Render channel intervals only (compositor-ish channels excluded).",
        [
          `${frameEstimates.length} frames contributed to the estimate.`,
          `Average frame span: ${formatNanoseconds(averageFrameDuration)}.`,
        ],
      ),
    )
  }

  if (gpuCounterSummary) {
    diagnoses.push(
      infoDiagnosis(
        "metal-gpu-counters-present",
        `GPU counter export present (${gpuCounterSummary.rowCount} rows).`,
        [
          `Counters: ${gpuCounterSummary.counterNames}.`,
          gpuCounterSummary.averageValue !== null
            ? `Average numeric value: ${gpuCounterSummary.averageValue}.`
            : "No numeric counter values decoded from the export mnemonics Probe understands.",
        ],
      ),
    )
  }

  if (frameEstimatesReliable && maxDuration !== null && maxDuration > sixtyFpsFrameBudgetNs) {
    diagnoses.push(
      warningDiagnosis(
        "metal-frame-budget-duration",
        "At least one exported GPU interval exceeded a 60 FPS frame budget.",
        [`Max GPU duration: ${formatNanoseconds(maxDuration)}.`],
      ),
    )
  }

  if (frameEstimatesReliable && maxLatency !== null && maxLatency > sixtyFpsFrameBudgetNs) {
    diagnoses.push(
      warningDiagnosis(
        "metal-frame-budget-latency",
        "CPU-to-GPU start latency exceeded a 60 FPS frame budget.",
        [`Max CPU→GPU latency: ${formatNanoseconds(maxLatency)}.`],
      ),
    )
  }

  if (frameEstimatesReliable && frameEstimates.length > 0 && framesOverBudget > 0) {
    diagnoses.push(
      warningDiagnosis(
        "metal-frame-budget-fps",
        "Estimated GPU frame spans missed a 60 FPS budget.",
        [
          `${framesOverBudget} of ${frameEstimates.length} frames exceeded ${formatNanoseconds(sixtyFpsFrameBudgetNs)}.`,
          `Estimated average frame rate: ${formatFramesPerSecond(averageFps)}.`,
        ],
      ),
    )
  }

  if (topEncoder) {
    diagnoses.push(
      infoDiagnosis(
        "metal-encoder-breakdown",
        `${topEncoder.label} dominated the exported encoder timing.`,
        [
          `Average encoder duration: ${formatNanoseconds(topEncoder.averageDuration)}.`,
          `Total encoder duration: ${formatNanoseconds(topEncoder.totalDuration)} across ${topEncoder.encoderCount} encoders and ${topEncoder.commandBufferCount} command buffers.`,
        ],
      ),
    )
  }

  if (!gpuCounterSummary) {
    diagnoses.push(
      wallDiagnosis(
        "metal-gpu-counters-required",
        "Per-shader GPU cycle attribution needs a counter-enabled template (e.g. custom Metal System Trace with Metal Counters, or `Ripple Scene Profiler.tracetemplate`).",
        [
          topEncoder
            ? `Top encoder in this export: ${topEncoder.label} (${formatNanoseconds(topEncoder.averageDuration)} avg).`
            : "This recording did not export encoder rows, so Probe cannot isolate individual encoder hotspots from the current trace alone.",
          "Record with --custom-template pointing at a counters-enabled .tracetemplate, then re-run analyze; Probe will summarize gpu-counter-* rows when present.",
        ],
      ),
    )
  }

  return {
    summary: {
      headline:
        rows.length === 0
          ? "No Metal GPU intervals were exported."
          : topEncoder && frameBudgetSummary
            ? `Observed ${rows.length} Metal GPU intervals; ${frameBudgetSummary}; ${topEncoder.label} dominated the encoder timing.`
            : topEncoder && !frameEstimatesReliable && frameEstimates.length > 0
              ? `Observed ${rows.length} Metal GPU intervals (FPS withheld — unreliable frame grouping); ${topEncoder.label} dominated the encoder timing.`
              : !topEncoder && !frameEstimatesReliable && frameEstimates.length > 0
                ? `Observed ${rows.length} Metal GPU intervals (FPS withheld — unreliable frame grouping) across ${uniqueCount(channels)} channels.`
                : topEncoder
                  ? `Observed ${rows.length} Metal GPU intervals; ${topEncoder.label} dominated the encoder timing.`
                  : frameBudgetSummary
                    ? `Observed ${rows.length} Metal GPU intervals; ${frameBudgetSummary}.`
                    : `Observed ${rows.length} Metal GPU intervals across ${uniqueCount(channels)} channels.`,
      metrics: [
        { label: "GPU intervals", value: String(rows.length) },
        { label: "Channels", value: summarizeCounts(channels) },
        { label: "States", value: summarizeCounts(states) },
        { label: "Avg duration", value: formatNanoseconds(averageDuration) },
        { label: "Max duration", value: formatNanoseconds(maxDuration) },
        { label: "Avg CPU→GPU latency", value: formatNanoseconds(averageLatency) },
        { label: "Max CPU→GPU latency", value: formatNanoseconds(maxLatency) },
        { label: "Estimated FPS", value: estimatedFpsText },
        { label: "FPS channel filter", value: frameChannelFilter },
        { label: "Frames over 60 FPS budget", value: frameEstimates.length === 0 ? "n/a" : frameEstimatesReliable ? `${framesOverBudget}/${frameEstimates.length}` : "withheld" },
        { label: "Avg frame span", value: formatNanoseconds(averageFrameDuration) },
        { label: "Max frame span", value: formatNanoseconds(maxFrameDuration) },
        { label: "Driver events", value: String(driverSummary.eventCount) },
        { label: "Driver event types", value: summarizeCounts(driverSummary.eventTypes) },
        { label: "Avg driver event duration", value: formatNanoseconds(driverSummary.averageDuration) },
        { label: "Per-encoder summary", value: summarizeEncoderAggregates(encoderAggregates) },
        {
          label: "GPU counters",
          value: gpuCounterSummary
            ? `${gpuCounterSummary.rowCount} rows; ${gpuCounterSummary.counterNames}`
            : "none exported",
        },
      ],
    },
    diagnoses,
  }
}

export const analyzeMetalSystemTraceTable = (table: ParsedPerfTable): {
  readonly summary: PerfSummary
  readonly diagnoses: ReadonlyArray<PerfDiagnosis>
} => analyzeMetalSystemTraceTables({ gpuIntervalsTable: table })

const readThreadKeys = (row: PerfRow): ReadonlySet<string> =>
  new Set(
    [
      readDisplay(row, "thread"),
      readRaw(row, "thread"),
    ].filter((value): value is string => value !== null && value.trim().length > 0),
  )

const findThreadMatchedHangRisk = (args: {
  readonly hangRow?: PerfRow | null
  readonly hangRiskTable?: ParsedPerfTable
}): PerfRow | null => {
  if (!args.hangRiskTable || !args.hangRow) {
    return null
  }

  assertSchemaContract({
    table: args.hangRiskTable,
    schema: "hang-risks",
    requiredMnemonics: ["time", "process", "message", "severity", "event-type", "backtrace", "thread"],
  })

  const hangThreadKeys = readThreadKeys(args.hangRow)

  if (hangThreadKeys.size === 0) {
    return null
  }

  return args.hangRiskTable.rows.find((row) => {
    const riskThreadKeys = readThreadKeys(row)
    return [...riskThreadKeys].some((key) => hangThreadKeys.has(key))
  }) ?? null
}

export const analyzeHangsTables = (args: {
  readonly hangTable: ParsedPerfTable
  readonly hangRiskTable?: ParsedPerfTable
}): {
  readonly summary: PerfSummary
  readonly diagnoses: ReadonlyArray<PerfDiagnosis>
} => {
  assertSchemaContract({
    table: args.hangTable,
    schema: "potential-hangs",
    requiredMnemonics: ["start", "duration", "hang-type", "thread", "process"],
  })

  if (args.hangRiskTable) {
    assertSchemaContract({
      table: args.hangRiskTable,
      schema: "hang-risks",
      requiredMnemonics: ["time", "process", "message", "severity", "event-type", "backtrace", "thread"],
    })
  }

  const hangRows = args.hangTable.rows
  const hangDurations = hangRows.map((row) => readNumber(row, "duration")).filter((value): value is number => value !== null)
  const hangTypes = hangRows.map((row) => readDisplay(row, "hang-type")).filter((value): value is string => value !== null)
  const threads = hangRows.map((row) => readDisplay(row, "thread")).filter((value): value is string => value !== null)
  const averageDuration = averageOf(hangDurations)
  const maxDuration = hangDurations.length === 0 ? null : Math.max(...hangDurations)
  const longestHangRow = hangRows.reduce<PerfRow | null>((longest, row) => {
    const longestDuration = longest ? readNumber(longest, "duration") ?? -1 : -1
    const currentDuration = readNumber(row, "duration") ?? -1
    return currentDuration > longestDuration ? row : longest
  }, null)
  const matchedRiskRow = findThreadMatchedHangRisk({
    hangRow: longestHangRow,
    hangRiskTable: args.hangRiskTable,
  })
  const longestHangThread = longestHangRow ? readDisplay(longestHangRow, "thread") ?? readRaw(longestHangRow, "thread") : null
  const matchedBacktrace = compactText(matchedRiskRow ? readDisplay(matchedRiskRow, "backtrace") ?? readRaw(matchedRiskRow, "backtrace") : null)
  const matchedRiskMessage = compactText(matchedRiskRow ? readDisplay(matchedRiskRow, "message") ?? readRaw(matchedRiskRow, "message") : null)
  const hangRiskSeverities = args.hangRiskTable
    ? args.hangRiskTable.rows.map((row) => readDisplay(row, "severity")).filter((value): value is string => value !== null)
    : []
  const diagnoses: Array<PerfDiagnosis> = []

  if (hangRows.length === 0) {
    diagnoses.push(
      warningDiagnosis(
        "hangs-no-events",
        "The recording did not export any potential hang rows.",
        ["This interval may have been too short or too idle to trigger the current hang threshold."],
      ),
    )
  }

  if (longestHangRow && maxDuration !== null) {
    const details = [
      `Hang type: ${readDisplay(longestHangRow, "hang-type") ?? "unknown"}.`,
      `Thread: ${longestHangThread ?? "unknown"}.`,
    ]

    if (matchedRiskMessage) {
      details.push(`Risk message: ${matchedRiskMessage}.`)
    }

    if (matchedBacktrace) {
      details.push(`Call stack hint: ${matchedBacktrace}.`)
    }

    diagnoses.push(
      warningDiagnosis(
        "hangs-longest-event",
        `Longest exported hang lasted ${formatNanoseconds(maxDuration)}.`,
        details,
      ),
    )
  }

  return {
    summary: {
      headline:
        hangRows.length === 0
          ? "No hang events were exported."
          : `Detected ${hangRows.length} hang events across ${uniqueCount(threads)} threads.`,
      metrics: [
        { label: "Hang events", value: String(hangRows.length) },
        { label: "Hang types", value: summarizeCounts(hangTypes) },
        { label: "Affected threads", value: threads.length === 0 ? "none" : String(uniqueCount(threads)) },
        { label: "Avg duration", value: formatNanoseconds(averageDuration) },
        { label: "Max duration", value: formatNanoseconds(maxDuration) },
        { label: "Hang-risk severities", value: summarizeCounts(hangRiskSeverities) },
        { label: "Call stack hints", value: matchedBacktrace ? "available" : "none" },
      ],
    },
    diagnoses,
  }
}

interface SwiftTaskStateRow {
  readonly task: string
  readonly start: number | null
  readonly state: string
  readonly thread: string | null
}

const buildSwiftTaskStateRows = (table: ParsedPerfTable): ReadonlyArray<SwiftTaskStateRow> => {
  assertSchemaContract({
    table,
    schema: "swift-task-state",
    requiredMnemonics: ["start", "duration", "task", "state", "process", "thread"],
  })

  return table.rows
    .map((row) => {
      const task = readDisplay(row, "task") ?? readRaw(row, "task")
      const state = readDisplay(row, "state") ?? readRaw(row, "state")

      if (!task || !state) {
        return null
      }

      return {
        task,
        start: readNumber(row, "start"),
        state,
        thread: readDisplay(row, "thread") ?? readRaw(row, "thread"),
      } satisfies SwiftTaskStateRow
    })
    .filter((row): row is SwiftTaskStateRow => row !== null)
}

export const analyzeSwiftConcurrencyTables = (args: {
  readonly taskStateTable: ParsedPerfTable
  readonly taskLifetimeTable: ParsedPerfTable
  readonly actorExecutionTable?: ParsedPerfTable
}): {
  readonly summary: PerfSummary
  readonly diagnoses: ReadonlyArray<PerfDiagnosis>
} => {
  assertSchemaContract({
    table: args.taskLifetimeTable,
    schema: "swift-task-lifetime",
    requiredMnemonics: ["start", "duration", "task"],
  })

  const stateRows = buildSwiftTaskStateRows(args.taskStateTable)
  const lifetimeRows = args.taskLifetimeTable.rows
  const lifetimeDurations = lifetimeRows.map((row) => readNumber(row, "duration")).filter((value): value is number => value !== null)
  const lifetimeTaskIds = lifetimeRows
    .map((row) => readDisplay(row, "task") ?? readRaw(row, "task"))
    .filter((value): value is string => value !== null)
  const allTaskIds = new Set<string>([
    ...lifetimeTaskIds,
    ...stateRows.map((row) => row.task),
  ])
  const states = stateRows.map((row) => row.state)
  const taskTransitions: Array<string> = []
  const createdTasks = new Set<string>()
  const terminatedTasks = new Set<string>()

  for (const stateRow of stateRows) {
    if (/create/i.test(stateRow.state)) {
      createdTasks.add(stateRow.task)
    }

    if (/(complete|cancel|finish|terminate|destroy)/i.test(stateRow.state)) {
      terminatedTasks.add(stateRow.task)
    }
  }

  const stateRowsByTask = new Map<string, Array<SwiftTaskStateRow>>()

  for (const row of stateRows) {
    const rows = stateRowsByTask.get(row.task) ?? []
    rows.push(row)
    stateRowsByTask.set(row.task, rows)
  }

  for (const rows of stateRowsByTask.values()) {
    rows.sort((left, right) => (left.start ?? 0) - (right.start ?? 0))

    for (let index = 1; index < rows.length; index += 1) {
      const previous = rows[index - 1]
      const current = rows[index]

      if (previous && current && previous.state !== current.state) {
        taskTransitions.push(`${previous.state} → ${current.state}`)
      }
    }
  }

  const createdCount = createdTasks.size > 0 ? createdTasks.size : allTaskIds.size
  const terminatedCount = terminatedTasks.size > 0 ? terminatedTasks.size : uniqueCount(lifetimeTaskIds)
  const averageLifetime = averageOf(lifetimeDurations)
  const maxLifetime = lifetimeDurations.length === 0 ? null : Math.max(...lifetimeDurations)
  const longRunningTasks = lifetimeRows
    .map((row) => ({
      task: readDisplay(row, "task") ?? readRaw(row, "task") ?? "unknown",
      duration: readNumber(row, "duration"),
    }))
    .filter((row): row is { readonly task: string; readonly duration: number } => row.duration !== null && row.duration > longRunningSwiftTaskThresholdNs)
    .sort((left, right) => right.duration - left.duration)

  const actorRows = args.actorExecutionTable?.rows ?? []
  const actorDurations = actorRows.map((row) => readNumber(row, "duration")).filter((value): value is number => value !== null)
  const actorNames = actorRows
    .map((row) => readDisplay(row, "actor") ?? readRaw(row, "actor"))
    .filter((value): value is string => value !== null)

  if (args.actorExecutionTable) {
    assertSchemaContract({
      table: args.actorExecutionTable,
      schema: "swift-actor-execution",
      requiredMnemonics: ["start", "duration", "actor", "task", "thread"],
    })
  }

  const diagnoses: Array<PerfDiagnosis> = []

  if (stateRows.length === 0 && lifetimeRows.length === 0) {
    diagnoses.push(
      warningDiagnosis(
        "swift-concurrency-no-rows",
        "Swift Concurrency exported no task lifetime or task state rows for the requested interval.",
        ["Drive async or actor-backed workload before trusting concurrency conclusions."],
      ),
    )
  }

  if (longRunningTasks.length > 0) {
    diagnoses.push(
      warningDiagnosis(
        "swift-concurrency-long-running-tasks",
        `Some Swift tasks stayed alive longer than ${formatNanoseconds(longRunningSwiftTaskThresholdNs)}.`,
        longRunningTasks.slice(0, 3).map((task) => `${task.task}: ${formatNanoseconds(task.duration)}`),
      ),
    )
  }

  return {
    summary: {
      headline:
        allTaskIds.size === 0
          ? "No Swift Concurrency task rows were exported."
          : `Observed ${allTaskIds.size} Swift tasks with ${stateRows.length} task-state intervals.`,
      metrics: [
        { label: "Task creations", value: String(createdCount) },
        { label: "Task terminations", value: String(terminatedCount) },
        { label: "Task states", value: summarizeCounts(states) },
        { label: "State transitions", value: summarizeCounts(taskTransitions, 4) },
        { label: "Avg task lifetime", value: formatNanoseconds(averageLifetime) },
        { label: "Max task lifetime", value: formatNanoseconds(maxLifetime) },
        { label: "Long-running tasks (>100 ms)", value: String(longRunningTasks.length) },
        { label: "Actor executions", value: String(actorRows.length) },
        { label: "Actors", value: summarizeCounts(actorNames) },
        { label: "Avg actor execution", value: formatNanoseconds(averageOf(actorDurations)) },
      ],
    },
    diagnoses,
  }
}
