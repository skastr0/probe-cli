import { readFile } from "node:fs/promises"
import { Effect, Schema } from "effect"
import {
  type AccessibilityScope,
  type AccessibilityValidationReport,
} from "../../domain/accessibility"
import {
  decodeCommerceValidationPlan,
  type CommerceDoctorReport,
  type CommerceProvider,
  type CommerceValidationMode,
  type CommerceValidationPlan,
  type CommerceValidationReport,
} from "../../domain/commerce"
import { UserInputError } from "../../domain/errors"
import { AccessibilityService } from "../../services/AccessibilityService"
import { CommerceService } from "../../services/CommerceService"
import { hasMachineJsonOutput, readOptionalJsonInput } from "../json"
import { invalidOption, optionalOption, requireOption, unknownSubcommand } from "../options"

const ValidateAccessibilityPayload = Schema.Struct({
  sessionId: Schema.String,
  scope: Schema.optional(Schema.Literal("current-screen")),
})

const ValidateCommercePayload = Schema.Struct({
  sessionId: Schema.String,
  mode: Schema.Literal("local-storekit", "sandbox", "testflight"),
  provider: Schema.optional(Schema.Union(Schema.Literal("revenuecat"), Schema.Null)),
  plan: Schema.optional(Schema.Union(Schema.Unknown, Schema.Null)),
})

const decodeValidateAccessibilityPayload = Schema.decodeUnknownSync(ValidateAccessibilityPayload)
const decodeValidateCommercePayload = Schema.decodeUnknownSync(ValidateCommercePayload)

const parseCommerceMode = (args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const mode = yield* requireOption(args, "--mode")

    if (mode === "local-storekit" || mode === "sandbox" || mode === "testflight") {
      return mode satisfies CommerceValidationMode
    }

    return yield* invalidOption(
      "--mode",
      `invalid value ${mode}; expected local-storekit, sandbox, or testflight.`,
      "Provide --mode local-storekit|sandbox|testflight and retry the command.",
    )
  })

const parseCommerceProvider = (args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const provider = yield* optionalOption(args, "--provider")

    if (provider === null) {
      return null
    }

    if (provider === "revenuecat") {
      return provider satisfies CommerceProvider
    }

    return yield* invalidOption(
      "--provider",
      `invalid value ${provider}; expected revenuecat.`,
      "Provide --provider revenuecat and retry the command.",
    )
  })

const readCommercePlanFile = (path: string) =>
  Effect.gen(function* () {
    const raw = yield* Effect.tryPromise({
      try: () => readFile(path, "utf8"),
      catch: (error) =>
        new UserInputError({
          code: "commerce-plan-read",
          reason: `Could not read commerce plan file ${path}: ${error instanceof Error ? error.message : String(error)}.`,
          nextStep: "Verify the commerce plan path and retry the command.",
          details: [],
        }),
    })

    return yield* Effect.try({
      try: () => decodeCommerceValidationPlan(JSON.parse(raw) as unknown),
      catch: (error) =>
        new UserInputError({
          code: "commerce-plan-parse",
          reason: `Could not parse commerce plan file ${path}: ${error instanceof Error ? error.message : String(error)}.`,
          nextStep: "Validate the commerce plan JSON shape and retry the command.",
          details: [],
        }),
    })
  })

const decodeCommercePlanPayload = (value: unknown) =>
  Effect.try({
    try: () => decodeCommerceValidationPlan(value),
    catch: (error) =>
      new UserInputError({
        code: "commerce-plan-payload-parse",
        reason: `Could not parse commerce plan payload: ${error instanceof Error ? error.message : String(error)}.`,
        nextStep: "Validate the commerce plan JSON shape and retry the command.",
        details: [],
      }),
  })

const formatDoctorLikeReport = (report: Pick<CommerceDoctorReport, "summary" | "verdict" | "timingFacts" | "warnings">): Array<string> => [
  report.summary,
  `verdict: ${report.verdict}`,
  ...(report.timingFacts.length > 0 ? ["", "timing facts:", ...report.timingFacts.map((fact) => `- ${fact}`)] : []),
  ...(report.warnings.length > 0 ? ["", "warnings:", ...report.warnings.map((warning) => `- ${warning}`)] : []),
]

const formatValidationReport = (report: CommerceValidationReport): string => [
  ...formatDoctorLikeReport(report),
  `mode: ${report.mode}`,
  `session id: ${report.sessionId}`,
  `environment: ${report.environment.authority} (${report.environment.authoritative ? "authoritative" : "non-authoritative"})`,
  `artifact: ${report.reportArtifact?.absolutePath ?? "n/a"}`,
  "",
  "steps:",
  ...(report.executedSteps.length > 0
    ? report.executedSteps.flatMap((step) => [
        `- ${step.index}. ${step.kind} [${step.verdict}${step.stub ? "/stub" : ""}] (${step.boundary}) ${step.summary}`,
        ...step.details.map((detail) => `  - ${detail}`),
      ])
    : ["- none"]),
].join("\n")

const parseAccessibilityScope = (args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const scope = yield* optionalOption(args, "--scope")

    if (scope === null) {
      return "current-screen" satisfies AccessibilityScope
    }

    if (scope === "current-screen") {
      return "current-screen" satisfies AccessibilityScope
    }

    return yield* invalidOption(
      "--scope",
      `invalid value ${scope}; expected current-screen.`,
      "Provide --scope current-screen and retry the command.",
    )
  })

const formatAccessibilityValidationReport = (report: AccessibilityValidationReport): string => [
  report.summary,
  `verdict: ${report.verdict}`,
  `scope: ${report.scope}`,
  `session id: ${report.sessionId}`,
  `analyzed interactive elements: ${report.analyzedElementCount}`,
  `issue count: ${report.issueCount}`,
  `snapshot: ${report.evidence.snapshotArtifact.absolutePath}`,
  `screenshot: ${report.evidence.screenshotArtifact.absolutePath}`,
  `report artifact: ${report.evidence.reportArtifact?.absolutePath ?? "n/a"}`,
  "",
  "issues:",
  ...(report.issues.length > 0
    ? report.issues.flatMap((issue) => [
        `- [${issue.severity}] ${issue.category} ${issue.elementRef} (${issue.elementType})`,
        `  ${issue.explanation}`,
      ])
    : ["- none"]),
  ...(report.warnings.length > 0 ? ["", "warnings:", ...report.warnings.map((warning) => `- ${warning}`)] : []),
].join("\n")

export const runValidateCommand = (args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const [subcommand, ...rest] = args

    switch (subcommand) {
      case "accessibility": {
        const payload = yield* readOptionalJsonInput(rest, "validate accessibility payload", decodeValidateAccessibilityPayload)
        const sessionId = payload?.sessionId ?? (yield* requireOption(rest, "--session-id"))
        const scope = payload?.scope ?? (yield* parseAccessibilityScope(rest))
        const asJson = hasMachineJsonOutput(rest)
        const accessibility = yield* AccessibilityService
        const report = yield* accessibility.validate({
          sessionId,
          scope: scope as AccessibilityScope,
        })

        yield* Effect.sync(() => {
          console.log(asJson ? JSON.stringify(report, null, 2) : formatAccessibilityValidationReport(report))
        })
        return
      }

      case "commerce": {
        const payload = yield* readOptionalJsonInput(rest, "validate commerce payload", decodeValidateCommercePayload)
        const sessionId = payload?.sessionId ?? (yield* requireOption(rest, "--session-id"))
        const mode = payload?.mode ?? (yield* parseCommerceMode(rest))
        const provider = payload === null ? yield* parseCommerceProvider(rest) : payload.provider ?? null
        const planPath = payload === null ? yield* optionalOption(rest, "--plan") : null
        const asJson = hasMachineJsonOutput(rest)

        if (mode === "local-storekit" && planPath === null && (payload?.plan ?? null) === null) {
          return yield* invalidOption(
            "--plan",
            "local-storekit mode requires a commerce plan payload.",
            "Provide --input-json with a plan field or --plan <commerce-plan.json> and retry the command.",
          )
        }

        const plan = payload !== null
          ? payload.plan === undefined || payload.plan === null
            ? null
            : yield* decodeCommercePlanPayload(payload.plan)
          : planPath === null
            ? null
            : yield* readCommercePlanFile(planPath)
        const commerce = yield* CommerceService
        const report = yield* commerce.validate({
          sessionId,
          mode,
          provider,
          plan,
        })

        yield* Effect.sync(() => {
          console.log(asJson ? JSON.stringify(report, null, 2) : formatValidationReport(report))
        })
        return
      }

      default:
        return yield* unknownSubcommand("validate", subcommand)
    }
  })

export type { CommerceValidationPlan }
