import { Schema } from "effect"
import {
  analyzeMetalSystemTraceTables,
  analyzeSignpostIntervalTable,
  analyzeTimeProfilerTable,
  assertSchemaContract,
  formatNanoseconds,
  readDisplay,
  readNumber,
  readRaw,
  type ParsedPerfTable,
} from "./perf"

// PRB-098: correlate CPU, main-thread, GPU, signpost, hang, and thermal
// evidence into one deterministic report. This module stays pure/domain --
// every function below takes already-parsed `ParsedPerfTable`s (the same
// shape `parsePerfTableExport` in perf.ts produces) plus caller-resolved
// provenance strings, and returns a plain value. No I/O, no `Date.now()`,
// no randomness -- the only non-deterministic field in the whole report is
// `provenance.generatedAt`, which the caller supplies rather than this
// module computing it. That is what "deterministic modulo generated
// timestamps" (AC) means in practice: call `buildEvidenceReport` twice with
// identical tables and the same `generatedAt`, and the two reports are
// `Schema.equivalence`-equal.
//
// Research-first gate for the thermal channel:
// `knowledge/xctrace-instruments/thermal-state-findings.md` records the
// official-source + empirical findings this module's thermal handling is
// built from (schema columns, state values, the `is-induced` column, and
// why no safe CLI-scriptable ramp/recovery method exists today).

// ---------------------------------------------------------------------------
// Provenance
// ---------------------------------------------------------------------------

export const PerfEvidenceDeviceProvenance = Schema.Struct({
  name: Schema.String,
  udid: Schema.String,
  osVersion: Schema.String,
})
export type PerfEvidenceDeviceProvenance = typeof PerfEvidenceDeviceProvenance.Type

export const PerfEvidenceProcessIdentity = Schema.Struct({
  name: Schema.String,
  pid: Schema.Number,
})
export type PerfEvidenceProcessIdentity = typeof PerfEvidenceProcessIdentity.Type

// AC: "Report records recipe hash, app build, process identity, device/OS,
// Xcode/xctrace, template digest ... and refs." `recipeHash` and
// `templateDigest` are opaque caller-supplied digests (e.g. a sha1 of the
// recipe/template file content) -- this module only compares them for
// equality, it never computes or interprets them.
export const PerfEvidenceProvenance = Schema.Struct({
  recipeHash: Schema.String,
  appBuild: Schema.String,
  processIdentity: PerfEvidenceProcessIdentity,
  device: PerfEvidenceDeviceProvenance,
  xcodeVersion: Schema.String,
  xctraceVersion: Schema.String,
  templateDigest: Schema.String,
  generatedAt: Schema.String,
})
export type PerfEvidenceProvenance = typeof PerfEvidenceProvenance.Type

// ---------------------------------------------------------------------------
// Channels
// ---------------------------------------------------------------------------

// AC: "Known channels are CPU samples, main-thread runnable/blocked/hang,
// Metal GPU/encoder, signposts, and thermal-state intervals." Probe's own
// xctrace schemas split "main-thread runnable/blocked" (`thread-state`) from
// "hang" (`potential-hangs`) into two exportable tables, so this module
// tracks them as two channels for precision while the AC's grouping is
// still satisfied narratively (both describe main-thread activity state).
const perfEvidenceChannelValues = [
  "cpu-samples",
  "main-thread-state",
  "hangs",
  "gpu-intervals",
  "signposts",
  "thermal-state",
] as const

export const PerfEvidenceChannelName = Schema.Literal(...perfEvidenceChannelValues)
export type PerfEvidenceChannelName = typeof PerfEvidenceChannelName.Type

export const PerfEvidenceChannelAvailability = Schema.Struct({
  channel: PerfEvidenceChannelName,
  status: Schema.Literal("available", "unavailable"),
  reason: Schema.optional(Schema.String),
  rowCount: Schema.Number,
})
export type PerfEvidenceChannelAvailability = typeof PerfEvidenceChannelAvailability.Type

// AC: "Missing/empty thermal table reports unavailable, never nominal." This
// generalizes to every channel: a channel is only ever "available" when its
// table exists AND exported at least one row. Absence and emptiness both
// collapse to "unavailable" with a reason -- there is no default/nominal
// value this function can return instead.
export const evaluateChannelAvailability = (args: {
  readonly channel: PerfEvidenceChannelName
  readonly table: ParsedPerfTable | undefined
  readonly unavailableReason?: string
}): PerfEvidenceChannelAvailability => {
  if (!args.table) {
    return {
      channel: args.channel,
      status: "unavailable",
      reason: args.unavailableReason ?? `${args.channel} was not captured in this recording.`,
      rowCount: 0,
    }
  }

  if (args.table.rows.length === 0) {
    return {
      channel: args.channel,
      status: "unavailable",
      reason: `${args.channel} table was present but exported zero rows.`,
      rowCount: 0,
    }
  }

  return {
    channel: args.channel,
    status: "available",
    rowCount: args.table.rows.length,
  }
}

// ---------------------------------------------------------------------------
// Thermal channel (device-thermal-state-intervals)
// ---------------------------------------------------------------------------

// Columns validated empirically against a real xctrace export in
// knowledge/xctrace-instruments/thermal-state-findings.md §1.
const thermalRequiredMnemonics = ["start", "duration", "end", "thermal-state", "track-label", "is-induced"]

export const PerfEvidenceThermalInterval = Schema.Struct({
  startNs: Schema.Number,
  endNs: Schema.Number,
  durationNs: Schema.Number,
  // Opaque display text, passed through verbatim -- never inferred or
  // defaulted. See thermal-state-findings.md §2: the observed values are
  // Nominal/Fair/Serious/Critical, but this module treats the string as
  // whatever xctrace reports, unrecognized values included.
  thermalState: Schema.String,
  trackLabel: Schema.optional(Schema.String),
  // See thermal-state-findings.md §3: Apple's own schema distinguishes a
  // GUI-simulated ("induced") reading from a naturally observed one. Probe
  // surfaces this verbatim rather than collapsing it away, since an induced
  // interval is not equivalent evidence to a naturally observed one.
  isInduced: Schema.Boolean,
})
export type PerfEvidenceThermalInterval = typeof PerfEvidenceThermalInterval.Type

export const buildThermalChannel = (table: ParsedPerfTable | undefined): {
  readonly availability: PerfEvidenceChannelAvailability
  readonly intervals: ReadonlyArray<PerfEvidenceThermalInterval>
} => {
  const availability = evaluateChannelAvailability({ channel: "thermal-state", table })

  if (availability.status === "unavailable" || !table) {
    return { availability, intervals: [] }
  }

  assertSchemaContract({
    table,
    schema: "device-thermal-state-intervals",
    requiredMnemonics: thermalRequiredMnemonics,
  })

  const buildInterval = (row: (typeof table.rows)[number]): PerfEvidenceThermalInterval | null => {
    const startNs = readNumber(row, "start")
    const durationNs = readNumber(row, "duration")
    const endNs = readNumber(row, "end")
    const thermalState = readDisplay(row, "thermal-state") ?? readRaw(row, "thermal-state")

    if (startNs === null || durationNs === null || thermalState === null) {
      return null
    }

    return {
      startNs,
      endNs: endNs ?? startNs + durationNs,
      durationNs,
      thermalState,
      trackLabel: readDisplay(row, "track-label") ?? undefined,
      isInduced: (readRaw(row, "is-induced") ?? "0") !== "0",
    }
  }

  const intervals = table.rows
    .map(buildInterval)
    .filter((interval): interval is PerfEvidenceThermalInterval => interval !== null)

  return { availability, intervals }
}

// ---------------------------------------------------------------------------
// Phase windows
// ---------------------------------------------------------------------------

// AC: "Signposts anchor phases when present; host action intervals are
// labeled lower-confidence fallback."
export const PerfEvidencePhaseAnchor = Schema.Literal("signpost", "host-action-fallback")
export type PerfEvidencePhaseAnchor = typeof PerfEvidencePhaseAnchor.Type

export const PerfEvidencePhaseWindow = Schema.Struct({
  label: Schema.String,
  startNs: Schema.Number,
  endNs: Schema.Number,
  anchor: PerfEvidencePhaseAnchor,
  confidence: Schema.Literal("high", "low"),
})
export type PerfEvidencePhaseWindow = typeof PerfEvidencePhaseWindow.Type

export interface PerfEvidenceHostActionInterval {
  readonly label: string
  readonly startNs: number
  readonly endNs: number
}

export const buildPhaseWindows = (args: {
  readonly signpostTable?: ParsedPerfTable
  readonly hostActionIntervals?: ReadonlyArray<PerfEvidenceHostActionInterval>
}): ReadonlyArray<PerfEvidencePhaseWindow> => {
  if (args.signpostTable && args.signpostTable.rows.length > 0) {
    assertSchemaContract({
      table: args.signpostTable,
      schema: "os-signpost-interval",
      requiredMnemonics: ["name", "start", "duration"],
    })

    const buildSignpostPhase = (row: (typeof args.signpostTable.rows)[number]): PerfEvidencePhaseWindow | null => {
      const label = readDisplay(row, "name") ?? readRaw(row, "name")
      const startNs = readNumber(row, "start")
      const durationNs = readNumber(row, "duration")

      if (!label || startNs === null || durationNs === null) {
        return null
      }

      return {
        label,
        startNs,
        endNs: startNs + durationNs,
        anchor: "signpost",
        confidence: "high",
      }
    }

    const phases = args.signpostTable.rows
      .map(buildSignpostPhase)
      .filter((phase): phase is PerfEvidencePhaseWindow => phase !== null)

    return [...phases].sort((left, right) => left.startNs - right.startNs)
  }

  const fallbackPhases = (args.hostActionIntervals ?? []).map((interval) => ({
    label: interval.label,
    startNs: interval.startNs,
    endNs: interval.endNs,
    anchor: "host-action-fallback" as const,
    confidence: "low" as const,
  } satisfies PerfEvidencePhaseWindow))

  return [...fallbackPhases].sort((left, right) => left.startNs - right.startNs)
}

// ---------------------------------------------------------------------------
// Findings
// ---------------------------------------------------------------------------

export const PerfEvidenceFindingKind = Schema.Literal("observation", "inference")
export type PerfEvidenceFindingKind = typeof PerfEvidenceFindingKind.Type

export const PerfEvidenceConfidence = Schema.Literal("high", "medium", "low")
export type PerfEvidenceConfidence = typeof PerfEvidenceConfidence.Type

export const PerfEvidenceSourcePointer = Schema.Struct({
  schema: Schema.String,
  rowSelector: Schema.String,
})
export type PerfEvidenceSourcePointer = typeof PerfEvidenceSourcePointer.Type

// AC: "No causal root-cause claim is emitted from temporal correlation
// alone." Enforced structurally, not by convention: there is no field on
// this schema an author could use to assert causality. `basis` records what
// evidence was correlated to produce the finding; it is never a "because"
// clause about mechanism.
// AC: "Every finding ... carries window, source artifact/row selector, and
// confidence." Enforced structurally like the no-causation rule above:
// `windowLabel` is required, not optional, so a finding cannot be
// constructed without one. A hang/phase inference's window is the phase it
// overlaps; a whole-recording rollup's window is the real span its own
// source rows cover (see `wholeRecordingWindowLabel` below) -- never an
// omitted or fabricated value.
export const PerfEvidenceFinding = Schema.Struct({
  id: Schema.String,
  kind: PerfEvidenceFindingKind,
  summary: Schema.String,
  windowLabel: Schema.String,
  source: PerfEvidenceSourcePointer,
  confidence: PerfEvidenceConfidence,
  basis: Schema.Array(Schema.String),
})
export type PerfEvidenceFinding = typeof PerfEvidenceFinding.Type

const confidenceRank: Record<PerfEvidenceConfidence, number> = { high: 0, medium: 1, low: 2 }

const rankFindings = (findings: ReadonlyArray<PerfEvidenceFinding>): ReadonlyArray<PerfEvidenceFinding> =>
  [...findings].sort((left, right) => confidenceRank[left.confidence] - confidenceRank[right.confidence] || left.id.localeCompare(right.id))

const observationFinding = (args: {
  readonly id: string
  readonly schema: string
  readonly headline: string
  readonly rowSelector: string
  readonly confidence: PerfEvidenceConfidence
  readonly basis: ReadonlyArray<string>
  readonly windowLabel: string
}): PerfEvidenceFinding => ({
  id: args.id,
  kind: "observation",
  summary: args.headline,
  windowLabel: args.windowLabel,
  source: { schema: args.schema, rowSelector: args.rowSelector },
  confidence: args.confidence,
  basis: [...args.basis],
})

const allRowsSelector = (rowCount: number): string => `row[0..${Math.max(rowCount - 1, 0)}]`

// ---------------------------------------------------------------------------
// Whole-recording windows for rollup findings
// ---------------------------------------------------------------------------

// A channel rollup finding (one per channel, summarizing every row rather
// than one phase) is not anchored to a single phase window, but it does have
// a real window: the span its own source rows actually cover. This section
// computes that span from the same cells the rollup's headline was built
// from, so the "window" on these findings is read evidence, never an
// omitted field or a fabricated placeholder.
interface PerfEvidenceTimeSpan {
  readonly startNs: number
  readonly endNs: number
}

// Interval-shaped rows (thread-state, metal-gpu-intervals, os-signpost-
// interval, device-thermal-state-intervals): each row covers [start,
// start+duration].
const intervalSpans = (
  table: ParsedPerfTable,
  startMnemonic: string,
  durationMnemonic: string,
): ReadonlyArray<PerfEvidenceTimeSpan> =>
  table.rows
    .map((row): PerfEvidenceTimeSpan | null => {
      const startNs = readNumber(row, startMnemonic)
      const durationNs = readNumber(row, durationMnemonic)
      return startNs === null || durationNs === null ? null : { startNs, endNs: startNs + durationNs }
    })
    .filter((span): span is PerfEvidenceTimeSpan => span !== null)

// Instant-shaped rows (time-sample): each row is a single point in time, not
// an interval, so start and end collapse to the same instant.
const instantSpans = (table: ParsedPerfTable, instantMnemonic: string): ReadonlyArray<PerfEvidenceTimeSpan> =>
  table.rows
    .map((row): PerfEvidenceTimeSpan | null => {
      const atNs = readNumber(row, instantMnemonic)
      return atNs === null ? null : { startNs: atNs, endNs: atNs }
    })
    .filter((span): span is PerfEvidenceTimeSpan => span !== null)

// This is a valid-but-unusual state, not an impossible one: a channel's
// required-mnemonic contract (asserted elsewhere) does not always cover its
// start/duration columns, so a row can legitimately fail to yield a
// timestamp. The fallback discloses that rather than fabricating a span --
// matching the file's "unavailable, never nominal" thermal precedent.
const wholeRecordingWindowLabel = (spans: ReadonlyArray<PerfEvidenceTimeSpan>): string => {
  if (spans.length === 0) {
    return "full-recording (window unavailable: rows carried no readable timestamp)"
  }

  const startNs = Math.min(...spans.map((span) => span.startNs))
  const endNs = Math.max(...spans.map((span) => span.endNs))

  return `full-recording (${formatNanoseconds(startNs)} - ${formatNanoseconds(endNs)})`
}

const intervalsOverlap = (aStart: number, aEnd: number, bStart: number, bEnd: number): boolean => aStart < bEnd && bStart < aEnd

// The one cross-channel correlation this module ships: a hang interval that
// temporally overlaps a phase window. This is deliberately an `"inference"`
// finding, not an `"observation"` -- it is derived from correlating two
// channels rather than reading one -- and its summary text explicitly
// disclaims causation, matching the AC.
const buildHangPhaseInferences = (args: {
  readonly hangs?: ParsedPerfTable
  readonly phases: ReadonlyArray<PerfEvidencePhaseWindow>
}): ReadonlyArray<PerfEvidenceFinding> => {
  if (!args.hangs || args.hangs.rows.length === 0) {
    return []
  }

  const findings: Array<PerfEvidenceFinding> = []

  args.hangs.rows.forEach((row, rowIndex) => {
    const startNs = readNumber(row, "start")
    const durationNs = readNumber(row, "duration")

    if (startNs === null || durationNs === null) {
      return
    }

    const endNs = startNs + durationNs

    for (const phase of args.phases) {
      if (!intervalsOverlap(startNs, endNs, phase.startNs, phase.endNs)) {
        continue
      }

      findings.push({
        id: `hang-phase-overlap-${rowIndex}-${phase.label}`,
        kind: "inference",
        summary:
          `A ${formatNanoseconds(durationNs)} hang temporally overlaps phase "${phase.label}". `
          + "This is a temporal correlation only, not a causal claim.",
        windowLabel: phase.label,
        source: { schema: "potential-hangs", rowSelector: `row[${rowIndex}]` },
        confidence: phase.confidence === "high" ? "medium" : "low",
        basis: [
          "potential-hangs interval rows",
          `phase window "${phase.label}" (${phase.anchor})`,
        ],
      })
    }
  })

  return findings
}

const buildThermalFinding = (
  thermal: ReturnType<typeof buildThermalChannel>,
): PerfEvidenceFinding | null => {
  if (thermal.availability.status !== "available" || thermal.intervals.length === 0) {
    return null
  }

  const distinctStatesInOrder = [...new Set(thermal.intervals.map((interval) => interval.thermalState))]
  const anyInduced = thermal.intervals.some((interval) => interval.isInduced)

  return observationFinding({
    id: "thermal-state-observed",
    schema: "device-thermal-state-intervals",
    headline: anyInduced
      ? `Observed thermal state(s) ${distinctStatesInOrder.join(" -> ")} (includes at least one Instruments-simulated/induced interval).`
      : `Observed thermal state(s) ${distinctStatesInOrder.join(" -> ")}.`,
    rowSelector: allRowsSelector(thermal.intervals.length),
    confidence: anyInduced ? "low" : "high",
    basis: ["device-thermal-state-intervals interval rows"],
    windowLabel: wholeRecordingWindowLabel(
      thermal.intervals.map((interval) => ({ startNs: interval.startNs, endNs: interval.endNs })),
    ),
  })
}

const buildMainThreadStateFinding = (table: ParsedPerfTable | undefined): PerfEvidenceFinding | null => {
  if (!table || table.rows.length === 0) {
    return null
  }

  assertSchemaContract({
    table,
    schema: "thread-state",
    requiredMnemonics: ["thread", "state", "process", "cputime", "waittime"],
  })

  const states = table.rows
    .map((row) => readDisplay(row, "state") ?? readRaw(row, "state"))
    .filter((value): value is string => value !== null)
  const blockedCount = states.filter((state) => state === "Blocked").length

  return observationFinding({
    id: "main-thread-state-summary",
    schema: "thread-state",
    headline: states.length === 0
      ? "No thread-state rows were exported."
      : `Observed ${states.length} thread-state intervals; ${blockedCount} blocked (${((blockedCount / states.length) * 100).toFixed(1)}%).`,
    rowSelector: allRowsSelector(table.rows.length),
    confidence: "high",
    basis: ["thread-state rows"],
    windowLabel: wholeRecordingWindowLabel(intervalSpans(table, "start", "duration")),
  })
}

export interface PerfEvidenceChannelTables {
  readonly cpuSamples?: ParsedPerfTable // schema: time-sample
  readonly mainThreadState?: ParsedPerfTable // schema: thread-state
  readonly hangs?: ParsedPerfTable // schema: potential-hangs
  readonly gpuIntervals?: ParsedPerfTable // schema: metal-gpu-intervals
  readonly signposts?: ParsedPerfTable // schema: os-signpost-interval
  readonly thermalState?: ParsedPerfTable // schema: device-thermal-state-intervals
}

const buildFindings = (args: {
  readonly tables: PerfEvidenceChannelTables
  readonly thermal: ReturnType<typeof buildThermalChannel>
  readonly phases: ReadonlyArray<PerfEvidencePhaseWindow>
}): ReadonlyArray<PerfEvidenceFinding> => {
  const findings: Array<PerfEvidenceFinding> = []

  if (args.tables.cpuSamples && args.tables.cpuSamples.rows.length > 0) {
    const { summary } = analyzeTimeProfilerTable(args.tables.cpuSamples)
    findings.push(observationFinding({
      id: "cpu-samples-summary",
      schema: "time-sample",
      headline: summary.headline,
      rowSelector: allRowsSelector(args.tables.cpuSamples.rows.length),
      confidence: "high",
      basis: ["time-sample rows"],
      windowLabel: wholeRecordingWindowLabel(instantSpans(args.tables.cpuSamples, "time")),
    }))
  }

  const mainThreadFinding = buildMainThreadStateFinding(args.tables.mainThreadState)
  if (mainThreadFinding) {
    findings.push(mainThreadFinding)
  }

  if (args.tables.gpuIntervals && args.tables.gpuIntervals.rows.length > 0) {
    const { summary } = analyzeMetalSystemTraceTables({ gpuIntervalsTable: args.tables.gpuIntervals })
    findings.push(observationFinding({
      id: "gpu-intervals-summary",
      schema: "metal-gpu-intervals",
      headline: summary.headline,
      rowSelector: allRowsSelector(args.tables.gpuIntervals.rows.length),
      confidence: "high",
      basis: ["metal-gpu-intervals rows"],
      windowLabel: wholeRecordingWindowLabel(intervalSpans(args.tables.gpuIntervals, "start", "duration")),
    }))
  }

  if (args.tables.signposts && args.tables.signposts.rows.length > 0) {
    const { summary } = analyzeSignpostIntervalTable(args.tables.signposts)
    findings.push(observationFinding({
      id: "signposts-summary",
      schema: "os-signpost-interval",
      headline: summary.headline,
      rowSelector: allRowsSelector(args.tables.signposts.rows.length),
      confidence: "high",
      basis: ["os-signpost-interval rows"],
      windowLabel: wholeRecordingWindowLabel(intervalSpans(args.tables.signposts, "start", "duration")),
    }))
  }

  const thermalFinding = buildThermalFinding(args.thermal)
  if (thermalFinding) {
    findings.push(thermalFinding)
  }

  findings.push(...buildHangPhaseInferences({ hangs: args.tables.hangs, phases: args.phases }))

  return rankFindings(findings)
}

// ---------------------------------------------------------------------------
// Metric series (raw numeric samples, used for comparison)
// ---------------------------------------------------------------------------

export const PerfEvidenceMetricSeries = Schema.Struct({
  key: Schema.String,
  unit: Schema.Literal("ns"),
  samples: Schema.Array(Schema.Number),
})
export type PerfEvidenceMetricSeries = typeof PerfEvidenceMetricSeries.Type

const numericColumn = (table: ParsedPerfTable | undefined, mnemonic: string): ReadonlyArray<number> =>
  (table?.rows ?? [])
    .map((row) => readNumber(row, mnemonic))
    .filter((value): value is number => value !== null)

const buildMetricSeries = (tables: PerfEvidenceChannelTables): ReadonlyArray<PerfEvidenceMetricSeries> => {
  const series: Array<PerfEvidenceMetricSeries> = []
  const push = (key: string, samples: ReadonlyArray<number>): void => {
    if (samples.length > 0) {
      series.push({ key, unit: "ns", samples })
    }
  }

  push("gpu-interval-duration-ns", numericColumn(tables.gpuIntervals, "duration"))
  push("hang-duration-ns", numericColumn(tables.hangs, "duration"))
  push("main-thread-cpu-ns", numericColumn(tables.mainThreadState, "cputime"))
  push("main-thread-wait-ns", numericColumn(tables.mainThreadState, "waittime"))
  push("thermal-interval-duration-ns", numericColumn(tables.thermalState, "duration"))

  return series.sort((left, right) => left.key.localeCompare(right.key))
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

export const PerfEvidenceReport = Schema.Struct({
  provenance: PerfEvidenceProvenance,
  phases: Schema.Array(PerfEvidencePhaseWindow),
  channels: Schema.Array(PerfEvidenceChannelAvailability),
  metrics: Schema.Array(PerfEvidenceMetricSeries),
  findings: Schema.Array(PerfEvidenceFinding),
})
export type PerfEvidenceReport = typeof PerfEvidenceReport.Type

export const buildEvidenceReport = (args: {
  readonly provenance: PerfEvidenceProvenance
  readonly tables: PerfEvidenceChannelTables
  readonly hostActionIntervals?: ReadonlyArray<PerfEvidenceHostActionInterval>
}): PerfEvidenceReport => {
  const thermal = buildThermalChannel(args.tables.thermalState)

  const channels: ReadonlyArray<PerfEvidenceChannelAvailability> = [
    evaluateChannelAvailability({ channel: "cpu-samples", table: args.tables.cpuSamples }),
    evaluateChannelAvailability({ channel: "main-thread-state", table: args.tables.mainThreadState }),
    evaluateChannelAvailability({ channel: "hangs", table: args.tables.hangs }),
    evaluateChannelAvailability({ channel: "gpu-intervals", table: args.tables.gpuIntervals }),
    evaluateChannelAvailability({ channel: "signposts", table: args.tables.signposts }),
    thermal.availability,
  ]

  const phases = buildPhaseWindows({
    signpostTable: args.tables.signposts,
    hostActionIntervals: args.hostActionIntervals,
  })

  return {
    provenance: args.provenance,
    phases,
    channels,
    metrics: buildMetricSeries(args.tables),
    findings: buildFindings({ tables: args.tables, thermal, phases }),
  }
}

// ---------------------------------------------------------------------------
// Comparison
// ---------------------------------------------------------------------------

export const PerfEvidenceComparisonMetric = Schema.Struct({
  key: Schema.String,
  unit: Schema.Literal("ns"),
  baselineSamples: Schema.Array(Schema.Number),
  candidateSamples: Schema.Array(Schema.Number),
  baselineMedian: Schema.NullOr(Schema.Number),
  candidateMedian: Schema.NullOr(Schema.Number),
  baselineP95: Schema.NullOr(Schema.Number),
  candidateP95: Schema.NullOr(Schema.Number),
  absoluteDelta: Schema.NullOr(Schema.Number),
  relativeDelta: Schema.NullOr(Schema.Number),
  baselineCount: Schema.Number,
  candidateCount: Schema.Number,
})
export type PerfEvidenceComparisonMetric = typeof PerfEvidenceComparisonMetric.Type

export const PerfEvidenceComparison = Schema.Struct({
  comparable: Schema.Boolean,
  reason: Schema.optional(Schema.String),
  provenanceDiff: Schema.Array(Schema.String),
  appBuildChanged: Schema.Boolean,
  metrics: Schema.Array(PerfEvidenceComparisonMetric),
})
export type PerfEvidenceComparison = typeof PerfEvidenceComparison.Type

const median = (samples: ReadonlyArray<number>): number | null => {
  if (samples.length === 0) {
    return null
  }

  const sorted = [...samples].sort((left, right) => left - right)
  const mid = Math.floor(sorted.length / 2)

  return sorted.length % 2 === 0
    ? ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2
    : sorted[mid] ?? null
}

const percentile95 = (sortedAscending: ReadonlyArray<number>): number | null => {
  if (sortedAscending.length === 0) {
    return null
  }

  const index = Math.min(sortedAscending.length - 1, Math.floor(0.95 * (sortedAscending.length - 1)))

  return sortedAscending[index] ?? null
}

// AC: "Comparison requires matching device, OS, Xcode/xctrace, template
// digest, and recipe digest; app build is compared variable." App build is
// deliberately excluded from `provenanceDiff` -- it is the one field this
// function expects to differ between a baseline and a candidate.
export const compareEvidenceReports = (
  baseline: PerfEvidenceReport,
  candidate: PerfEvidenceReport,
): PerfEvidenceComparison => {
  const provenanceDiff: Array<string> = []

  if (baseline.provenance.device.udid !== candidate.provenance.device.udid) {
    provenanceDiff.push(`device udid differs: ${baseline.provenance.device.udid} vs ${candidate.provenance.device.udid}`)
  }
  if (baseline.provenance.device.osVersion !== candidate.provenance.device.osVersion) {
    provenanceDiff.push(`OS version differs: ${baseline.provenance.device.osVersion} vs ${candidate.provenance.device.osVersion}`)
  }
  if (baseline.provenance.xcodeVersion !== candidate.provenance.xcodeVersion) {
    provenanceDiff.push(`Xcode version differs: ${baseline.provenance.xcodeVersion} vs ${candidate.provenance.xcodeVersion}`)
  }
  if (baseline.provenance.xctraceVersion !== candidate.provenance.xctraceVersion) {
    provenanceDiff.push(`xctrace version differs: ${baseline.provenance.xctraceVersion} vs ${candidate.provenance.xctraceVersion}`)
  }
  if (baseline.provenance.templateDigest !== candidate.provenance.templateDigest) {
    provenanceDiff.push(`template digest differs: ${baseline.provenance.templateDigest} vs ${candidate.provenance.templateDigest}`)
  }
  if (baseline.provenance.recipeHash !== candidate.provenance.recipeHash) {
    provenanceDiff.push(`recipe hash differs: ${baseline.provenance.recipeHash} vs ${candidate.provenance.recipeHash}`)
  }

  const appBuildChanged = baseline.provenance.appBuild !== candidate.provenance.appBuild

  if (provenanceDiff.length > 0) {
    return {
      comparable: false,
      reason: `Provenance mismatch beyond app build: ${provenanceDiff.join("; ")}.`,
      provenanceDiff,
      appBuildChanged,
      metrics: [],
    }
  }

  const keys = new Set<string>([
    ...baseline.metrics.map((series) => series.key),
    ...candidate.metrics.map((series) => series.key),
  ])

  const metrics = [...keys].sort().map((key) => {
    const baselineSamples = baseline.metrics.find((series) => series.key === key)?.samples ?? []
    const candidateSamples = candidate.metrics.find((series) => series.key === key)?.samples ?? []
    const baselineMedian = median(baselineSamples)
    const candidateMedian = median(candidateSamples)
    const absoluteDelta = baselineMedian !== null && candidateMedian !== null ? candidateMedian - baselineMedian : null
    const relativeDelta = absoluteDelta !== null && baselineMedian !== null && baselineMedian !== 0
      ? absoluteDelta / baselineMedian
      : null

    return {
      key,
      unit: "ns" as const,
      baselineSamples,
      candidateSamples,
      baselineMedian,
      candidateMedian,
      baselineP95: percentile95([...baselineSamples].sort((left, right) => left - right)),
      candidateP95: percentile95([...candidateSamples].sort((left, right) => left - right)),
      absoluteDelta,
      relativeDelta,
      baselineCount: baselineSamples.length,
      candidateCount: candidateSamples.length,
    } satisfies PerfEvidenceComparisonMetric
  })

  return {
    comparable: true,
    provenanceDiff: [],
    appBuildChanged,
    metrics,
  }
}
