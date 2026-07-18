import { Effect, Schema } from "effect"
import { UserInputError } from "../../domain/errors"
import type {
  InvestigationExecutionPlan,
  InvestigationValidation,
  PerfEvidenceComparisonType,
} from "../../domain/investigation"
import { InvestigationController, type InvestigationInspection } from "../../services/InvestigationController"
import { hasMachineJsonOutput, readOptionalJsonInput } from "../json"
import { optionalOption, requireOption } from "../options"

// PRB-099: `probe investigate` -- validate -> plan -> run -> inspect/wait/
// events/cancel -> compare, one JSON recipe driving the whole orbit. Mirrors
// `perf.ts`/`drill.ts`'s CLI idiom (payload via --input-json, formatted text
// by default, `--output-json` for the machine envelope) rather than
// inventing a new one.

const RunEnvelope = Schema.Struct({
  recipe: Schema.optional(Schema.Unknown),
  resumeId: Schema.optional(Schema.String),
})
const decodeRunEnvelopeSync = Schema.decodeUnknownSync(RunEnvelope)

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null

// Mirrors `perf.ts`'s `decodePerfAroundPayload`: a payload that already has
// a `recipe` or `resumeId` key is the run envelope; anything else is a bare
// recipe (the common case -- `--file investigation.json` with no wrapper).
const decodeRunPayload = (value: unknown): { readonly recipe?: unknown; readonly resumeId?: string } =>
  isRecord(value) && ("recipe" in value || "resumeId" in value)
    ? decodeRunEnvelopeSync(value)
    : { recipe: value }

const IdPayload = Schema.Struct({ investigationId: Schema.String })
const decodeIdPayload = Schema.decodeUnknownSync(IdPayload)

const ComparePayload = Schema.Struct({ baselineId: Schema.String, candidateId: Schema.String })
const decodeComparePayload = Schema.decodeUnknownSync(ComparePayload)

const formatValidation = (validation: InvestigationValidation): string =>
  [
    `ok: ${validation.ok}`,
    "",
    "violations:",
    ...(validation.violations.length > 0 ? validation.violations.map((violation) => `- ${violation}`) : ["- none"]),
  ].join("\n")

const formatPlan = (plan: InvestigationExecutionPlan): string =>
  [
    `recipe hash: ${plan.recipeHash}`,
    `stages: ${plan.stages.join(" -> ")}`,
    `repetitions: ${plan.repetitions}`,
    `cooldown: ${plan.cooldownMs}ms`,
    `capture: ${plan.captureDescription}`,
    `evidence policy: success=${plan.evidencePolicy.success} failure=${plan.evidencePolicy.failure}`,
    `required runner capabilities: ${plan.requiredRunnerCapabilities.length > 0 ? plan.requiredRunnerCapabilities.join(", ") : "none"}`,
    `comparison requested: ${plan.comparisonRequested}`,
  ].join("\n")

const formatInspection = (inspection: InvestigationInspection): string => {
  const lines = [
    `investigation: ${inspection.investigationId}`,
    `status: ${inspection.status}`,
    `current stage: ${inspection.currentStage ?? "none"}`,
    `stages: ${inspection.stages.join(" -> ")}`,
    `cancel requested: ${inspection.cancelRequested}`,
  ]

  if (inspection.failureReason) {
    lines.push(`failure reason: ${inspection.failureReason}`)
  }

  if (inspection.report) {
    lines.push(
      "",
      `overall verdict: ${inspection.report.overallVerdict}`,
      `confidence: ${inspection.report.confidence}`,
      `comparison verdict: ${inspection.report.comparisonVerdict}`,
      "",
      `findings (${inspection.report.findings.shown.length} of ${inspection.report.findings.total}${
        inspection.report.findings.omitted > 0 ? `, ${inspection.report.findings.omitted} omitted` : ""
      }):`,
      ...(inspection.report.findings.shown.length > 0
        ? inspection.report.findings.shown.map((finding) => `- [${finding.confidence}/${finding.kind}] ${finding.summary}`)
        : ["- none"]),
      "",
      "walls:",
      ...(inspection.report.walls.length > 0 ? inspection.report.walls.map((wall) => `- [${wall.code}] ${wall.summary}`) : ["- none"]),
    )
  }

  return lines.join("\n")
}

const formatComparison = (comparison: PerfEvidenceComparisonType): string =>
  [
    `comparable: ${comparison.comparable}`,
    ...(comparison.reason ? [`reason: ${comparison.reason}`] : []),
    `app build changed: ${comparison.appBuildChanged}`,
    "",
    "metrics:",
    ...(comparison.metrics.length > 0
      ? comparison.metrics.map((metric) =>
          `- ${metric.key}: baseline median=${metric.baselineMedian ?? "n/a"} candidate median=${metric.candidateMedian ?? "n/a"} relative delta=${
            metric.relativeDelta === null ? "n/a" : `${(metric.relativeDelta * 100).toFixed(1)}%`
          }`)
      : ["- none"]),
  ].join("\n")

export const runInvestigateCommand = (args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const [subcommand, ...rest] = args
    const asJson = hasMachineJsonOutput(rest)
    const controller = yield* InvestigationController

    switch (subcommand) {
      case "validate": {
        const payload = yield* readOptionalJsonInput(rest, "investigate validate payload", (value) => value)
        const recipeInput = payload ?? (yield* Effect.gen(function* () {
          return yield* new UserInputError({
            code: "missing-option",
            reason: "Missing investigation recipe payload.",
            nextStep: "Provide --input-json, --file, or --stdin with the investigation recipe JSON.",
            details: [],
          })
        }))
        const validation = yield* controller.validate(recipeInput)

        yield* Effect.sync(() => {
          console.log(asJson ? JSON.stringify(validation, null, 2) : formatValidation(validation))
          if (!validation.ok) {
            process.exitCode = 1
          }
        })
        return
      }

      case "plan": {
        const payload = yield* readOptionalJsonInput(rest, "investigate plan payload", (value) => value)
        const recipeInput = payload ?? (yield* new UserInputError({
          code: "missing-option",
          reason: "Missing investigation recipe payload.",
          nextStep: "Provide --input-json, --file, or --stdin with the investigation recipe JSON.",
          details: [],
        }))
        const plan = yield* controller.plan(recipeInput)

        yield* Effect.sync(() => {
          console.log(asJson ? JSON.stringify(plan, null, 2) : formatPlan(plan))
        })
        return
      }

      case "run": {
        const payload = yield* readOptionalJsonInput(rest, "investigate run payload", decodeRunPayload)
        const resumeId = payload?.resumeId ?? (yield* optionalOption(rest, "--resume-id")) ?? null
        const inspection = resumeId
          ? yield* controller.run({ resumeId })
          : yield* controller.run({ recipeInput: payload?.recipe })

        yield* Effect.sync(() => {
          console.log(asJson ? JSON.stringify(inspection, null, 2) : formatInspection(inspection))
        })
        return
      }

      case "inspect": {
        const payload = yield* readOptionalJsonInput(rest, "investigate inspect payload", decodeIdPayload, undefined, {
          allowFile: false,
          allowStdin: false,
        })
        const investigationId = payload?.investigationId ?? (yield* requireOption(rest, "--investigation-id"))
        const inspection = yield* controller.inspect(investigationId)

        yield* Effect.sync(() => {
          console.log(asJson ? JSON.stringify(inspection, null, 2) : formatInspection(inspection))
        })
        return
      }

      case "events": {
        const payload = yield* readOptionalJsonInput(rest, "investigate events payload", decodeIdPayload, undefined, {
          allowFile: false,
          allowStdin: false,
        })
        const investigationId = payload?.investigationId ?? (yield* requireOption(rest, "--investigation-id"))
        const events = yield* controller.events(investigationId)

        yield* Effect.sync(() => {
          if (asJson) {
            console.log(JSON.stringify(events, null, 2))
            return
          }

          console.log(events.shown.length > 0
            ? events.shown.map((event) => `[${event.sequence}] ${event.stage} ${event.type}: ${event.message}`).join("\n")
            : "no events")
        })
        return
      }

      case "cancel": {
        const payload = yield* readOptionalJsonInput(rest, "investigate cancel payload", decodeIdPayload, undefined, {
          allowFile: false,
          allowStdin: false,
        })
        const investigationId = payload?.investigationId ?? (yield* requireOption(rest, "--investigation-id"))
        const inspection = yield* controller.cancel(investigationId)

        yield* Effect.sync(() => {
          console.log(asJson ? JSON.stringify(inspection, null, 2) : formatInspection(inspection))
        })
        return
      }

      case "wait": {
        const investigationId = yield* requireOption(rest, "--investigation-id")
        const timeoutMsOption = yield* optionalOption(rest, "--timeout-ms")
        const timeoutMs = timeoutMsOption ? Number(timeoutMsOption) : 60_000
        const inspection = yield* controller.waitFor(investigationId, { timeoutMs })

        yield* Effect.sync(() => {
          console.log(asJson ? JSON.stringify(inspection, null, 2) : formatInspection(inspection))
        })
        return
      }

      case "compare": {
        const payload = yield* readOptionalJsonInput(rest, "investigate compare payload", decodeComparePayload, undefined, {
          allowFile: false,
          allowStdin: false,
        })
        const baselineId = payload?.baselineId ?? (yield* requireOption(rest, "--baseline-id"))
        const candidateId = payload?.candidateId ?? (yield* requireOption(rest, "--candidate-id"))
        const comparison = yield* controller.compare({ baselineId, candidateId })

        yield* Effect.sync(() => {
          console.log(asJson ? JSON.stringify(comparison, null, 2) : formatComparison(comparison))
        })
        return
      }

      default:
        return yield* new UserInputError({
          code: "unknown-investigate-subcommand",
          reason: `Unknown investigate subcommand: ${subcommand ?? "<missing>"}.`,
          nextStep: "Run `probe investigate validate|plan|run|inspect|events|cancel|wait|compare`.",
          details: [],
        })
    }
  })
