import { Schema } from "effect"
import { ArtifactRecord } from "./output"
import { SessionHealthCheck, SessionPhase } from "./session"

export const PerfTemplate = Schema.Literal("time-profiler", "system-trace", "metal-system-trace")
export type PerfTemplate = typeof PerfTemplate.Type

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

export const PerfArtifacts = Schema.Struct({
  trace: ArtifactRecord,
  toc: ArtifactRecord,
  exports: Schema.Array(ArtifactRecord),
})
export type PerfArtifacts = typeof PerfArtifacts.Type

export const PerfSessionOutcome = Schema.Struct({
  state: SessionPhase,
  healthCheck: SessionHealthCheck,
})
export type PerfSessionOutcome = typeof PerfSessionOutcome.Type

export const PerfRecordResult = Schema.Struct({
  sessionId: Schema.String,
  template: PerfTemplate,
  templateName: Schema.String,
  timeLimit: Schema.String,
  recordedAt: Schema.String,
  xctraceVersion: Schema.String,
  session: PerfSessionOutcome,
  summary: PerfSummary,
  diagnoses: Schema.Array(PerfDiagnosis),
  artifacts: PerfArtifacts,
})
export type PerfRecordResult = typeof PerfRecordResult.Type

export interface ParsedPerfCell {
  readonly raw: string | null
  readonly display: string | null
}

export interface ParsedPerfTable {
  readonly schema: string
  readonly mnemonics: ReadonlyArray<string>
  readonly rows: ReadonlyArray<Record<string, ParsedPerfCell | null>>
}

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
    default:
      return null
  }
}

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
  const schemaMatch = xml.match(/<schema name="([^"]+)">([\s\S]*?)<\/schema>/)

  if (!schemaMatch) {
    throw new Error("Missing schema block in xctrace export output.")
  }

  const schema = schemaMatch[1]?.trim()
  const schemaBody = schemaMatch[2] ?? ""

  if (!schema) {
    throw new Error("Missing schema name in xctrace export output.")
  }

  const mnemonics = parseSchemaMnemonics(schemaBody)
  const refs = new Map<string, ParsedPerfCell>()
  const rows: Array<Record<string, ParsedPerfCell | null>> = []

  for (const rowMatch of xml.matchAll(/<row>([\s\S]*?)<\/row>/g)) {
    const rowBody = rowMatch[1] ?? ""
    const values = [...rowBody.matchAll(childElementPattern)].map((match) => {
      const tagName = match[1] ?? match[4] ?? ""
      const attributes = parseAttributes(match[2] ?? match[5] ?? "")
      const inner = match[3] ?? ""
      return buildCell(tagName, attributes, inner, refs)
    })

    const row: Record<string, ParsedPerfCell | null> = {}

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

const readRaw = (row: Record<string, ParsedPerfCell | null>, mnemonic: string): string | null =>
  row[mnemonic]?.raw ?? null

const readDisplay = (row: Record<string, ParsedPerfCell | null>, mnemonic: string): string | null =>
  row[mnemonic]?.display ?? row[mnemonic]?.raw ?? null

const readNumber = (row: Record<string, ParsedPerfCell | null>, mnemonic: string): number | null => {
  const raw = readRaw(row, mnemonic)

  if (!raw) {
    return null
  }

  const value = Number(raw)
  return Number.isFinite(value) ? value : null
}

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

const assertSchemaContract = (args: {
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

const warningDiagnosis = (code: string, summary: string, details: ReadonlyArray<string>): PerfDiagnosis => ({
  code,
  severity: "warning",
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

  diagnoses.push(
    wallDiagnosis(
      "time-profiler-callstack-wall",
      "Probe keeps the raw sample exports, but full reconstructed call stacks are not yet a stable supported contract.",
      [
        "Use the saved .trace bundle and exported sample XML for deeper inspection when stack fidelity matters.",
      ],
    ),
  )

  return {
    summary: {
      headline:
        sampleCount === 0
          ? "No Time Profiler samples were exported."
          : `Collected ${sampleCount} CPU samples across ${uniqueCount(threads)} threads.`,
      metrics: [
        { label: "Samples", value: String(sampleCount) },
        { label: "Threads", value: String(uniqueCount(threads)) },
        { label: "Observed cores", value: cores.length === 0 ? "none" : String(uniqueCount(cores)) },
        { label: "Thread states", value: summarizeCounts(states) },
        { label: "Sample kinds", value: summarizeCounts(sampleKinds) },
        { label: "Sample window", value: formatNanoseconds(windowNs) },
      ],
    },
    diagnoses,
  }
}

const matchesTargetProcess = (
  row: Record<string, ParsedPerfCell | null>,
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
  readonly cpuStateTable: ParsedPerfTable
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
  assertSchemaContract({
    table: args.cpuStateTable,
    schema: "cpu-state",
    requiredMnemonics: ["cpu", "state", "process", "thread"],
  })

  const targetThreadRows = args.threadStateTable.rows.filter((row) => matchesTargetProcess(row, args.targetPid))
  const targetCpuRows = args.cpuStateTable.rows.filter((row) => matchesTargetProcess(row, args.targetPid))
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
      [
        "Keep the raw .trace and exported XML around when you need to inspect broader kernel or simulator scheduling behavior.",
      ],
    ),
  )

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

export const analyzeMetalSystemTraceTable = (table: ParsedPerfTable): {
  readonly summary: PerfSummary
  readonly diagnoses: ReadonlyArray<PerfDiagnosis>
} => {
  assertSchemaContract({
    table,
    schema: "metal-gpu-intervals",
    requiredMnemonics: ["duration", "channel-name", "start-latency", "state"],
  })

  const rows = table.rows
  const durations = rows.map((row) => readNumber(row, "duration")).filter((value): value is number => value !== null)
  const latencies = rows.map((row) => readNumber(row, "start-latency")).filter((value): value is number => value !== null)
  const states = rows.map((row) => readDisplay(row, "state")).filter((value): value is string => value !== null)
  const channels = rows.map((row) => readDisplay(row, "channel-name")).filter((value): value is string => value !== null)
  const maxDuration = durations.length === 0 ? null : Math.max(...durations)
  const maxLatency = latencies.length === 0 ? null : Math.max(...latencies)
  const averageDuration = durations.length === 0 ? null : durations.reduce((total, value) => total + value, 0) / durations.length
  const averageLatency = latencies.length === 0 ? null : latencies.reduce((total, value) => total + value, 0) / latencies.length
  const diagnoses: Array<PerfDiagnosis> = []

  if (rows.length === 0) {
    diagnoses.push(
      warningDiagnosis(
        "metal-no-rows",
        "Metal System Trace exported no GPU interval rows for the requested interval.",
        ["Drive a GPU-heavy workload before trusting GPU timing conclusions."],
      ),
    )
  }

  if (maxDuration !== null && maxDuration > sixtyFpsFrameBudgetNs) {
    diagnoses.push(
      warningDiagnosis(
        "metal-frame-budget-duration",
        "At least one exported GPU interval exceeded a 60 FPS frame budget.",
        [`Max GPU duration: ${formatNanoseconds(maxDuration)}.`],
      ),
    )
  }

  if (maxLatency !== null && maxLatency > sixtyFpsFrameBudgetNs) {
    diagnoses.push(
      warningDiagnosis(
        "metal-frame-budget-latency",
        "CPU-to-GPU start latency exceeded a 60 FPS frame budget.",
        [`Max CPU→GPU latency: ${formatNanoseconds(maxLatency)}.`],
      ),
    )
  }

  diagnoses.push(
    wallDiagnosis(
      "metal-per-shader-wall",
      "Probe can summarize encoder and command-buffer timing from Metal traces, but true per-shader GPU attribution is still outside the supported contract.",
      ["Use the saved .trace bundle for deeper Instruments inspection when shader attribution matters."],
    ),
  )

  return {
    summary: {
      headline:
        rows.length === 0
          ? "No Metal GPU intervals were exported."
          : `Observed ${rows.length} Metal GPU intervals across ${uniqueCount(channels)} channels.`,
      metrics: [
        { label: "GPU intervals", value: String(rows.length) },
        { label: "Channels", value: summarizeCounts(channels) },
        { label: "States", value: summarizeCounts(states) },
        { label: "Avg duration", value: formatNanoseconds(averageDuration) },
        { label: "Max duration", value: formatNanoseconds(maxDuration) },
        { label: "Avg CPU→GPU latency", value: formatNanoseconds(averageLatency) },
        { label: "Max CPU→GPU latency", value: formatNanoseconds(maxLatency) },
      ],
    },
    diagnoses,
  }
}
