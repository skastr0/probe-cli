import { Schema } from "effect"
import { BoundedCollectionSchema, type BoundedCollection } from "./bounded"
import { EvidencePolicyInputSchema, resolveEvidencePolicy, type EvidencePolicy, type EvidencePolicyInput } from "./evidence"
import { isBatchSequencePlannedStep, isFastSinglePlannedStep, planFlowExecution } from "./flow-planner"
import { decodeSessionFlowContract, type SessionFlowContract } from "./flow-v2"
import { PerfTemplate } from "./perf"
import {
  compareEvidenceReports,
  PerfEvidenceComparison,
  PerfEvidenceFinding,
  PerfEvidenceReport,
  type PerfEvidenceComparison as PerfEvidenceComparisonType,
  type PerfEvidenceFinding as PerfEvidenceFindingType,
  type PerfEvidenceReport as PerfEvidenceReportType,
} from "./perf-evidence"
import { RunnerCapabilityFlag } from "./session"

// PRB-099: "Ship Probe Investigate Performance and Before-After Proof". This
// module is the pure domain core of the `probe investigate` command orbit --
// recipe decode/validation, execution planning, the durable stage/event
// vocabulary, and terminal-report assembly. No I/O, no `Date.now()`, no
// process/session access: every impure concern (talking to the daemon,
// persisting durable state, sleeping for cooldowns) lives one layer up in
// services/investigation/*. This mirrors domain/flow-v2.ts + domain/flow-planner.ts
// (pure contract + pure planner) and domain/perf-evidence.ts (pure correlation
// engine, wired to a CLI/RPC surface only by its consumer) -- this glyph's
// job, per the wave-4 handoff note on PRB-099, is exactly that wiring, done
// here at the domain layer first so the service/CLI layers stay thin.

// ---------------------------------------------------------------------------
// Recipe
// ---------------------------------------------------------------------------

export const InvestigationTargetRef = Schema.Struct({
  sessionId: Schema.String,
})
export type InvestigationTargetRef = typeof InvestigationTargetRef.Type

// A capture spec names exactly one of a built-in preset template or a custom
// `.tracetemplate` path -- the same either/or PRB-097's `perf record` already
// enforces at the CLI option level (--template vs --custom-template), lifted
// into the recipe schema itself so an investigation recipe cannot express an
// ambiguous or dual capture request.
// A preset capture fuses with the measured flow through the existing
// `perf.around` RPC (PerfService's `recordAroundFlow`), which already times
// the recording to the flow's own template-derived cap. `perf.around` has
// no custom-template counterpart yet (PRB-097 shipped lazy custom-template
// export for `perf record` only), so a custom capture instead records
// concurrently with the measured flow via two already-existing RPCs
// (`perf.record` + `session.run` run side by side) -- see
// `investigationExecutorDepsLive.ts`'s header for why this is the
// deliberately looser of the two fusion lanes, and why `timeLimit` (which a
// preset capture never needs -- `perf.around` derives its own) must be
// supplied explicitly here: the recording has to outlast the measured flow.
export const InvestigationCaptureSpec = Schema.Union(
  Schema.Struct({ kind: Schema.Literal("preset"), template: PerfTemplate }),
  Schema.Struct({ kind: Schema.Literal("custom"), customTemplatePath: Schema.String, timeLimit: Schema.optional(Schema.String) }),
)
export type InvestigationCaptureSpec = typeof InvestigationCaptureSpec.Type

export const InvestigationCooldownGate = Schema.Struct({
  // Minimum quiet time between repetitions, letting a thermal/CPU spike from
  // repetition N settle before repetition N+1 starts -- "cooldown gate" in
  // the AC. Zero is a legal (if inadvisable) value; validated non-negative
  // by `validateInvestigationRecipeDomain` below.
  minIntervalMs: Schema.Number,
})
export type InvestigationCooldownGate = typeof InvestigationCooldownGate.Type

// A baseline is either a prior durable investigation's persisted report (the
// common case: "compare this run against investigation X") or an inline
// PerfEvidenceReport payload (the fixture/CI case: a frozen recorded
// baseline shipped alongside the recipe, no live prior run required).
export const InvestigationBaseline = Schema.Union(
  Schema.Struct({ kind: Schema.Literal("investigation"), investigationId: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("report"), report: PerfEvidenceReport }),
)
export type InvestigationBaseline = typeof InvestigationBaseline.Type

// `setup`/`warmup`/`measuredFlow` are `Schema.Unknown` here rather than
// `SessionFlowContractSchema` -- the same envelope-vs-final-shape split
// `perf.ts`'s `PerfAroundPayload.flow: Schema.Unknown` already uses for
// exactly this reason: `SessionFlowContractSchema` (`FlowV2ContractSchema`)
// is the *strict*, already-normalized shape (every step fully expanded --
// `target` resolved, `condition`/`text` defaulted, etc.). A recipe author
// writes the same convenient shorthand a bare flow file can use (e.g. a
// `wait` step with only `timeoutMs`, no `target`/`condition`/`text`), which
// only `decodeSessionFlowContract` (via `normalizeFlowV2ContractInput`)
// knows how to expand. Decoding straight against the strict schema at this
// struct's top level would reject that shorthand before normalization ever
// ran -- `decodeInvestigationRecipe` below does the two decode passes in
// the right order instead.
export const InvestigationRecipeEnvelope = Schema.Struct({
  target: InvestigationTargetRef,
  setup: Schema.optional(Schema.Unknown),
  warmup: Schema.optional(Schema.Unknown),
  measuredFlow: Schema.Unknown,
  capture: InvestigationCaptureSpec,
  repetitions: Schema.Number,
  cooldown: InvestigationCooldownGate,
  evidencePolicy: Schema.optional(EvidencePolicyInputSchema),
  baseline: Schema.optional(InvestigationBaseline),
})

// The final, fully-normalized recipe shape every other function in this
// module and `InvestigationController` operates on -- `measuredFlow` (and
// `setup`/`warmup` when present) are always a decoded `SessionFlowContract`
// here, never the raw envelope's `unknown`. Hand-written rather than
// derived from a schema's `.Type` for the same reason `PerfAroundPayload`
// splits its envelope from its final `{ sessionId, template, flow }` shape:
// the schema that can *decode* the field (`Schema.Unknown`, permissive) is
// deliberately looser than the type every *consumer* of a decoded recipe
// should see (`SessionFlowContract`, precise).
export interface InvestigationRecipe {
  readonly target: InvestigationTargetRef
  readonly setup?: SessionFlowContract
  readonly warmup?: SessionFlowContract
  readonly measuredFlow: SessionFlowContract
  readonly capture: InvestigationCaptureSpec
  readonly repetitions: number
  readonly cooldown: InvestigationCooldownGate
  readonly evidencePolicy?: EvidencePolicyInput
  readonly baseline?: InvestigationBaseline
}

const decodeInvestigationRecipeEnvelopeSync = Schema.decodeUnknownSync(InvestigationRecipeEnvelope)

// Sync-throwing decode, matching `decodeSessionFlowContract`'s convention
// (domain/flow-v2.ts): callers (services/CLI) wrap this in `Effect.try` at
// the boundary, same as every other recipe/payload decode in this codebase.
// `measuredFlow` is decoded through `decodeSessionFlowContract` rather than
// the bare schema so its own contract-version failure-closed behavior (see
// that function's header) applies uniformly inside a recipe, not just at
// the top-level `session run` command.
export const decodeInvestigationRecipe = (value: unknown): InvestigationRecipe => {
  const decoded = decodeInvestigationRecipeEnvelopeSync(value)

  return {
    ...decoded,
    setup: decoded.setup !== undefined ? decodeSessionFlowContract(decoded.setup) : undefined,
    warmup: decoded.warmup !== undefined ? decodeSessionFlowContract(decoded.warmup) : undefined,
    measuredFlow: decodeSessionFlowContract(decoded.measuredFlow),
  }
}

// AC: "validate decodes schema/domain constraints without side effects."
// Schema decode alone (above) only proves *shape*; this proves the domain
// constraints a well-shaped-but-nonsensical recipe could still violate.
// Pure string-or-null, exactly like `validateSessionFlowContract` --  no
// exceptions, no I/O, so `investigate validate` can report every violation
// found rather than stopping at the first `throw`.
export const validateInvestigationRecipeDomain = (recipe: InvestigationRecipe): ReadonlyArray<string> => {
  const violations: Array<string> = []

  if (!Number.isInteger(recipe.repetitions) || recipe.repetitions < 1) {
    violations.push(`repetitions must be a positive integer; received ${recipe.repetitions}.`)
  }

  if (!Number.isFinite(recipe.cooldown.minIntervalMs) || recipe.cooldown.minIntervalMs < 0) {
    violations.push(`cooldown.minIntervalMs must be a non-negative number; received ${recipe.cooldown.minIntervalMs}.`)
  }

  if (recipe.measuredFlow.steps.length === 0) {
    violations.push("measuredFlow must declare at least one step -- an investigation always measures a concrete flow, never an empty one.")
  }

  if (recipe.capture.kind === "custom" && recipe.capture.customTemplatePath.trim().length === 0) {
    violations.push("capture.customTemplatePath must be a non-empty path when capture.kind is \"custom\".")
  }

  if (recipe.target.sessionId.trim().length === 0) {
    violations.push("target.sessionId must be non-empty.")
  }

  return violations
}

export interface InvestigationValidation {
  readonly ok: boolean
  readonly violations: ReadonlyArray<string>
}

/** Combines schema decode + domain validation into the one report `investigate validate` returns. Never throws. */
export const validateInvestigationRecipe = (value: unknown): InvestigationValidation => {
  let recipe: InvestigationRecipe

  try {
    recipe = decodeInvestigationRecipe(value)
  } catch (error) {
    return {
      ok: false,
      violations: [error instanceof Error ? error.message : String(error)],
    }
  }

  const violations = validateInvestigationRecipeDomain(recipe)
  return { ok: violations.length === 0, violations }
}

// ---------------------------------------------------------------------------
// Recipe digest
// ---------------------------------------------------------------------------

// Opaque, deterministic, non-cryptographic digest (FNV-1a over the recipe's
// canonical JSON) -- exactly the role `PerfEvidenceProvenance.recipeHash`
// already documents ("this module only compares them for equality"). Object
// key order is normalized first so two structurally-identical recipes never
// hash differently because of JSON.stringify's insertion-order dependence.
const canonicalize = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(canonicalize)
  }

  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>
    return Object.keys(record)
      .sort()
      .reduce<Record<string, unknown>>((accumulator, key) => {
        accumulator[key] = canonicalize(record[key])
        return accumulator
      }, {})
  }

  return value
}

export const fnv1aHex = (input: string): string => {
  let hash = 0x811c9dc5

  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }

  return (hash >>> 0).toString(16).padStart(8, "0")
}

export const investigationRecipeHash = (recipe: InvestigationRecipe): string =>
  fnv1aHex(JSON.stringify(canonicalize(recipe)))

// ---------------------------------------------------------------------------
// Execution plan
// ---------------------------------------------------------------------------

export const InvestigationStageName = Schema.Literal(
  "preflight",
  "setup",
  "warmup",
  "capture",
  "analyze",
  "compare",
  "report",
)
export type InvestigationStageName = typeof InvestigationStageName.Type

// AC: "Stable stages are preflight, setup, warmup, capture, analyze,
// compare, report as versioned events." `setup`/`warmup` are only present
// when the recipe declares them; `compare` is only present when a baseline
// was declared. The other five stages are unconditional -- this is the
// "normalized execution plan" `investigate plan` returns, computed once,
// never re-derived mid-run so a running investigation's declared line can
// never silently grow or shrink.
const requiredFlowCapabilities = (flow: SessionFlowContract | undefined): ReadonlyArray<typeof RunnerCapabilityFlag.Type> => {
  if (!flow) {
    return []
  }

  const capabilities = new Set<typeof RunnerCapabilityFlag.Type>()

  for (const plannedStep of planFlowExecution(flow).steps) {
    if (isBatchSequencePlannedStep(plannedStep)) {
      capabilities.add("uiActionBatch")
      continue
    }

    if (isFastSinglePlannedStep(plannedStep) && plannedStep.step.kind !== "wait") {
      capabilities.add("uiAction")
    }
  }

  return [...capabilities]
}

export interface InvestigationExecutionPlan {
  readonly recipeHash: string
  readonly stages: ReadonlyArray<InvestigationStageName>
  readonly repetitions: number
  readonly cooldownMs: number
  readonly captureDescription: string
  readonly requiredRunnerCapabilities: ReadonlyArray<typeof RunnerCapabilityFlag.Type>
  readonly evidencePolicy: EvidencePolicy
  readonly comparisonRequested: boolean
}

/** Pure: decode + validate + normalize. Throws on decode failure; returns a plan otherwise (domain violations are the caller's job to check via `validateInvestigationRecipeDomain` first). */
export const planInvestigation = (recipe: InvestigationRecipe): InvestigationExecutionPlan => {
  const stages: Array<InvestigationStageName> = ["preflight"]

  if (recipe.setup) {
    stages.push("setup")
  }

  if (recipe.warmup) {
    stages.push("warmup")
  }

  stages.push("capture", "analyze")

  if (recipe.baseline) {
    stages.push("compare")
  }

  stages.push("report")

  const requiredRunnerCapabilities = [
    ...new Set([
      ...requiredFlowCapabilities(recipe.setup),
      ...requiredFlowCapabilities(recipe.warmup),
      ...requiredFlowCapabilities(recipe.measuredFlow),
    ]),
  ]

  return {
    recipeHash: investigationRecipeHash(recipe),
    stages,
    repetitions: recipe.repetitions,
    cooldownMs: recipe.cooldown.minIntervalMs,
    captureDescription: recipe.capture.kind === "preset"
      ? `preset:${recipe.capture.template}`
      : `custom:${recipe.capture.customTemplatePath}`,
    requiredRunnerCapabilities,
    evidencePolicy: resolveEvidencePolicy(recipe.evidencePolicy),
    comparisonRequested: recipe.baseline !== undefined,
  }
}

// ---------------------------------------------------------------------------
// Durable run state -- status, events
// ---------------------------------------------------------------------------

export const InvestigationStatus = Schema.Literal("pending", "running", "completed", "failed", "cancelled")
export type InvestigationStatus = typeof InvestigationStatus.Type

export const InvestigationEventType = Schema.Literal(
  "stage-started",
  "stage-completed",
  "stage-failed",
  "cancel-requested",
  "cancelled",
)
export type InvestigationEventType = typeof InvestigationEventType.Type

// Versioned so a future incompatible reshaping of the event envelope can be
// detected by a reader instead of silently misread -- same idiom as
// `BOUNDED_COLLECTION_CONTRACT_VERSION` (domain/bounded.ts).
export const INVESTIGATION_EVENT_CONTRACT_VERSION = 1 as const

export const InvestigationEvent = Schema.Struct({
  contractVersion: Schema.Literal(INVESTIGATION_EVENT_CONTRACT_VERSION),
  sequence: Schema.Number,
  stage: InvestigationStageName,
  type: InvestigationEventType,
  message: Schema.String,
  timestamp: Schema.String,
})
export type InvestigationEvent = typeof InvestigationEvent.Type

export const buildInvestigationEvent = (args: {
  readonly sequence: number
  readonly stage: InvestigationStageName
  readonly type: InvestigationEventType
  readonly message: string
  readonly timestamp: string
}): InvestigationEvent => ({
  contractVersion: INVESTIGATION_EVENT_CONTRACT_VERSION,
  ...args,
})

// ---------------------------------------------------------------------------
// Findings, walls, report
// ---------------------------------------------------------------------------

// A "wall" is an explicit, named limitation the investigation hit rather
// than silently working around or omitting -- generalizes `PerfDiagnosis`'s
// `wall: true` flag (domain/perf.ts) to the whole investigation (recorder
// conflicts, missing signing, an unstable host capture) as well as
// per-repetition perf walls.
export const InvestigationWall = Schema.Struct({
  code: Schema.String,
  summary: Schema.String,
  details: Schema.Array(Schema.String),
})
export type InvestigationWall = typeof InvestigationWall.Type

export const InvestigationComparisonVerdict = Schema.Literal(
  "not-requested",
  "not-comparable",
  "improved",
  "regressed",
  "unchanged",
)
export type InvestigationComparisonVerdict = typeof InvestigationComparisonVerdict.Type

// AC: "Without baseline result is diagnosis; with compatible baseline it is
// before/after proof under PRB-098." `overallVerdict` is the top-level
// vocabulary the terminal report speaks; `comparison` (when present) carries
// PRB-098's own richer per-metric verdict beneath it.
export const InvestigationOverallVerdict = Schema.Literal("diagnosis", "before-after-proof")
export type InvestigationOverallVerdict = typeof InvestigationOverallVerdict.Type

// The relative-delta threshold below which a metric is "unchanged" rather
// than improved/regressed -- keeps normal run-to-run noise from reading as
// a verdict. 5% mirrors the tolerance already implicit in this repo's perf
// wall thresholds (domain/perf.ts); not a physical constant, just the one
// number both `deriveComparisonVerdict` and its test agree on.
export const DEFAULT_REGRESSION_THRESHOLD = 0.05

/**
 * Turns PRB-098's per-metric `PerfEvidenceComparison` into the single
 * top-level verdict word the terminal report needs. A comparison is
 * "regressed" if ANY metric's candidate median moved unfavorably (higher
 * duration/count) beyond the threshold, "improved" if none regressed and at
 * least one improved beyond threshold, else "unchanged". Non-comparable
 * provenance always wins (mismatched device/OS/template/recipe makes any
 * verdict meaningless, per PRB-098's own `comparable` gate).
 */
export const deriveComparisonVerdict = (
  comparison: PerfEvidenceComparisonType,
  threshold: number = DEFAULT_REGRESSION_THRESHOLD,
): InvestigationComparisonVerdict => {
  if (!comparison.comparable) {
    return "not-comparable"
  }

  let anyRegressed = false
  let anyImproved = false

  for (const metric of comparison.metrics) {
    if (metric.relativeDelta === null) {
      continue
    }

    if (metric.relativeDelta > threshold) {
      anyRegressed = true
    } else if (metric.relativeDelta < -threshold) {
      anyImproved = true
    }
  }

  if (anyRegressed) {
    return "regressed"
  }

  if (anyImproved) {
    return "improved"
  }

  return "unchanged"
}

/**
 * Identifies which metric key(s) drove a "regressed" verdict, ranked by
 * relative delta descending -- the "identifies the planted channel and
 * phase" half of the ProbeFixture planted-regression AC. A metric key is
 * already channel-scoped (e.g. "gpu-interval-duration-ns", domain/
 * perf-evidence.ts `buildMetricSeries`), so no separate phase-attribution
 * step is needed: the key itself names the regressed channel.
 */
export const identifyRegressedMetrics = (
  comparison: PerfEvidenceComparisonType,
  threshold: number = DEFAULT_REGRESSION_THRESHOLD,
): ReadonlyArray<{ readonly key: string; readonly relativeDelta: number }> =>
  comparison.metrics
    .filter((metric): metric is typeof metric & { relativeDelta: number } => metric.relativeDelta !== null && metric.relativeDelta > threshold)
    .map((metric) => ({ key: metric.key, relativeDelta: metric.relativeDelta }))
    .sort((left, right) => right.relativeDelta - left.relativeDelta)

export const InvestigationReport = Schema.Struct({
  investigationId: Schema.String,
  recipeHash: Schema.String,
  status: InvestigationStatus,
  overallVerdict: InvestigationOverallVerdict,
  confidence: Schema.Literal("high", "medium", "low"),
  findings: BoundedCollectionSchema(PerfEvidenceFinding),
  walls: Schema.Array(InvestigationWall),
  comparison: Schema.Union(PerfEvidenceComparison, Schema.Null),
  comparisonVerdict: InvestigationComparisonVerdict,
  repetitionReportKeys: Schema.Array(Schema.String),
  generatedAt: Schema.String,
})
export type InvestigationReport = typeof InvestigationReport.Type

export const overallFindingsConfidence = (findings: ReadonlyArray<PerfEvidenceFindingType>): "high" | "medium" | "low" => {
  if (findings.length === 0) {
    return "low"
  }

  if (findings.some((finding) => finding.confidence === "low")) {
    return "low"
  }

  if (findings.some((finding) => finding.confidence === "medium")) {
    return "medium"
  }

  return "high"
}

const findingRank: Record<PerfEvidenceFindingType["confidence"], number> = { high: 0, medium: 1, low: 2 }

/**
 * Pure merge + re-rank step, split out from bounding/persistence (which
 * needs `ArtifactStore`, an Effect, and is the caller's job -- see
 * `services/InvestigationController.ts`'s `runReportStage`, which calls
 * this, then `bindBoundedCollection` (services/boundedCollections.ts) for
 * the real, persisted-on-overflow `BoundedCollection`, then
 * `assembleInvestigationReport` below with the already-bounded result).
 * Splitting these three steps is what lets "typed drill refs" (AC) be a
 * genuine persisted-artifact handle instead of a hardcoded `null`.
 */
export const mergeAndRankFindings = (
  repetitionFindings: ReadonlyArray<ReadonlyArray<PerfEvidenceFindingType>>,
): ReadonlyArray<PerfEvidenceFindingType> =>
  repetitionFindings
    .flat()
    .sort((left, right) => findingRank[left.confidence] - findingRank[right.confidence] || left.id.localeCompare(right.id))

/**
 * Assembles the bounded terminal report (AC: "Terminal JSON contains
 * bounded ranked findings, confidence, walls, comparison verdict, and typed
 * drill refs; bulk evidence stays artifacts"). Takes an already-merged,
 * already-bounded `findings` collection (see `mergeAndRankFindings` +
 * `bindBoundedCollection` above) rather than computing it itself -- this
 * function's only job is assembling the final envelope around it.
 */
export const assembleInvestigationReport = (args: {
  readonly investigationId: string
  readonly recipeHash: string
  readonly status: InvestigationStatus
  readonly findings: BoundedCollection<PerfEvidenceFindingType>
  readonly confidence: "high" | "medium" | "low"
  readonly walls: ReadonlyArray<InvestigationWall>
  readonly comparison: PerfEvidenceComparisonType | null
  readonly repetitionReportKeys: ReadonlyArray<string>
  readonly generatedAt: string
}): InvestigationReport => {
  const comparisonVerdict: InvestigationComparisonVerdict = args.comparison
    ? deriveComparisonVerdict(args.comparison)
    : "not-requested"

  return {
    investigationId: args.investigationId,
    recipeHash: args.recipeHash,
    status: args.status,
    overallVerdict: args.comparison ? "before-after-proof" : "diagnosis",
    confidence: args.confidence,
    findings: args.findings,
    walls: args.walls,
    comparison: args.comparison,
    comparisonVerdict,
    repetitionReportKeys: args.repetitionReportKeys,
    generatedAt: args.generatedAt,
  }
}

// ---------------------------------------------------------------------------
// Cross-repetition merge
// ---------------------------------------------------------------------------

/**
 * Pools every repetition's `PerfEvidenceReport` into the one report the
 * `compare` stage/command needs (`compareEvidenceReports` takes exactly two
 * single reports). Provenance/phases/channels are taken from the first
 * repetition -- every repetition of one investigation already runs the
 * identical frozen recipe/policy/target (AC #3), so they never legitimately
 * differ; metric series are merged by key, concatenating every repetition's
 * samples so a baseline-vs-candidate comparison sees the full pooled
 * distribution rather than just repetition 1's. Findings are flattened and
 * re-ranked the same way `assembleInvestigationReport` ranks them.
 */
export const mergeInvestigationEvidenceReports = (
  reports: ReadonlyArray<PerfEvidenceReportType>,
): PerfEvidenceReportType => {
  if (reports.length === 0) {
    throw new Error("mergeInvestigationEvidenceReports: at least one repetition report is required.")
  }

  const first = reports[0] as PerfEvidenceReportType

  const metricKeys = [...new Set(reports.flatMap((report) => report.metrics.map((series) => series.key)))].sort()
  const metrics = metricKeys.map((key) => ({
    key,
    unit: "ns" as const,
    samples: reports.flatMap((report) => report.metrics.find((series) => series.key === key)?.samples ?? []),
  }))

  const findings = reports
    .flatMap((report) => report.findings)
    .sort((left, right) => findingRank[left.confidence] - findingRank[right.confidence] || left.id.localeCompare(right.id))

  return {
    provenance: first.provenance,
    phases: first.phases,
    channels: first.channels,
    metrics,
    findings,
  }
}

export { compareEvidenceReports }
export type { PerfEvidenceComparisonType, PerfEvidenceReportType }
