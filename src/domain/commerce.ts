import { Schema } from "effect"
import { FlowContractSchema, FlowResultSchema, FlowStepSchema, validateFlowContract, type FlowContract } from "./action"
import { ArtifactRecord, NullableString } from "./output"
import type { SessionHealth } from "./session"

const OptionalNullableString = Schema.optional(NullableString)
const OptionalContinueOnError = Schema.optional(Schema.Boolean)
const PositiveIntegerSchema = Schema.Number.pipe(Schema.int(), Schema.greaterThan(0))

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null

const nowIso = (): string => new Date().toISOString()

export const CommerceVerdict = Schema.Literal("verified", "configured", "blocked", "unknown")
export type CommerceVerdict = typeof CommerceVerdict.Type

export const CommerceProvider = Schema.Literal("revenuecat")
export type CommerceProvider = typeof CommerceProvider.Type

export const CommerceBoundary = Schema.Literal(
  "app-binary",
  "revenuecat-catalog",
  "apple-storekit",
  "runtime-environment",
)
export type CommerceBoundary = typeof CommerceBoundary.Type

export const CommerceVerification = Schema.Literal(
  "directly-verified",
  "structurally-verified",
  "externally-gated",
)
export type CommerceVerification = typeof CommerceVerification.Type

export const CommerceValidationMode = Schema.Literal("local-storekit", "sandbox", "testflight")
export type CommerceValidationMode = typeof CommerceValidationMode.Type

export const EnvironmentAuthority = Schema.Literal(
  "local-storekit-simulated",
  "simulator-untrusted",
  "sandbox-authoritative",
  "testflight-authoritative",
  "unknown",
)
export type EnvironmentAuthority = typeof EnvironmentAuthority.Type

export const CommerceCheckSource = Schema.Literal(
  "workspace",
  "app-store-connect",
  "revenuecat",
  "storekit",
  "session",
)
export type CommerceCheckSource = typeof CommerceCheckSource.Type

export const CommerceCheckSchema = Schema.Struct({
  key: Schema.String,
  source: CommerceCheckSource,
  boundary: CommerceBoundary,
  verification: CommerceVerification,
  verdict: CommerceVerdict,
  stub: Schema.Boolean,
  summary: Schema.String,
  details: Schema.Array(Schema.String),
})
export type CommerceCheck = typeof CommerceCheckSchema.Type

export const CommerceDoctorReportSchema = Schema.Struct({
  contract: Schema.Literal("probe.commerce-doctor/report-v1"),
  generatedAt: Schema.String,
  workspaceRoot: Schema.String,
  bundleId: Schema.String,
  mode: Schema.Union(CommerceValidationMode, Schema.Null),
  provider: Schema.Union(CommerceProvider, Schema.Null),
  summary: Schema.String,
  verdict: CommerceVerdict,
  timingFacts: Schema.Array(Schema.String),
  checks: Schema.Array(CommerceCheckSchema),
  warnings: Schema.Array(Schema.String),
})
export type CommerceDoctorReport = typeof CommerceDoctorReportSchema.Type

const EmbeddedFlowInputSchema = Schema.Union(
  FlowContractSchema,
  Schema.Struct({
    steps: Schema.Array(FlowStepSchema),
  }),
  Schema.Array(FlowStepSchema),
)

export const EmbeddedFlowContractSchema = Schema.transform(
  EmbeddedFlowInputSchema,
  FlowContractSchema,
  {
    strict: false,
    decode: (input) => {
      if (Array.isArray(input)) {
        return {
          contract: "probe.session-flow/v1" as const,
          steps: input,
        }
      }

      if (isRecord(input) && "contract" in input) {
        return input
      }

      return {
        contract: "probe.session-flow/v1" as const,
        steps: (input as { readonly steps: ReadonlyArray<unknown> }).steps,
      }
    },
    encode: (flow) => flow,
  },
)

export const CommerceEntitlementState = Schema.Literal("active", "inactive")
export type CommerceEntitlementState = typeof CommerceEntitlementState.Type

export const CommerceOpenPaywallStepSchema = Schema.Struct({
  kind: Schema.Literal("commerce.openPaywall"),
  flow: EmbeddedFlowContractSchema,
  continueOnError: OptionalContinueOnError,
})
export type CommerceOpenPaywallStep = typeof CommerceOpenPaywallStepSchema.Type

export const CommerceAssertProductVisibleStepSchema = Schema.Struct({
  kind: Schema.Literal("commerce.assertProductVisible"),
  productId: Schema.String,
  flow: EmbeddedFlowContractSchema,
  continueOnError: OptionalContinueOnError,
})
export type CommerceAssertProductVisibleStep = typeof CommerceAssertProductVisibleStepSchema.Type

export const CommerceLoadProductsStepSchema = Schema.Struct({
  kind: Schema.Literal("commerce.loadProducts"),
  flow: EmbeddedFlowContractSchema,
  continueOnError: OptionalContinueOnError,
})
export type CommerceLoadProductsStep = typeof CommerceLoadProductsStepSchema.Type

export const CommercePurchaseStepSchema = Schema.Struct({
  kind: Schema.Literal("commerce.purchase"),
  productId: OptionalNullableString,
  flow: EmbeddedFlowContractSchema,
  continueOnError: OptionalContinueOnError,
})
export type CommercePurchaseStep = typeof CommercePurchaseStepSchema.Type

export const CommerceRestoreStepSchema = Schema.Struct({
  kind: Schema.Literal("commerce.restore"),
  flow: EmbeddedFlowContractSchema,
  continueOnError: OptionalContinueOnError,
})
export type CommerceRestoreStep = typeof CommerceRestoreStepSchema.Type

export const CommerceAssertEntitlementStepSchema = Schema.Struct({
  kind: Schema.Literal("commerce.assertEntitlement"),
  entitlement: Schema.String,
  state: CommerceEntitlementState,
  flow: EmbeddedFlowContractSchema,
  continueOnError: OptionalContinueOnError,
})
export type CommerceAssertEntitlementStep = typeof CommerceAssertEntitlementStepSchema.Type

export const CommerceAssertOfferingsLoadedStepSchema = Schema.Struct({
  kind: Schema.Literal("commerce.assertOfferingsLoaded"),
  offeringId: OptionalNullableString,
  flow: EmbeddedFlowContractSchema,
  continueOnError: OptionalContinueOnError,
})
export type CommerceAssertOfferingsLoadedStep = typeof CommerceAssertOfferingsLoadedStepSchema.Type

export const CommerceRelaunchAppStepSchema = Schema.Struct({
  kind: Schema.Literal("commerce.relaunchApp"),
  flow: EmbeddedFlowContractSchema,
  continueOnError: OptionalContinueOnError,
})
export type CommerceRelaunchAppStep = typeof CommerceRelaunchAppStepSchema.Type

export const CommerceClearTransactionsStepSchema = Schema.Struct({
  kind: Schema.Literal("commerce.clearTransactions"),
  continueOnError: OptionalContinueOnError,
})
export type CommerceClearTransactionsStep = typeof CommerceClearTransactionsStepSchema.Type

export const CommerceForceFailureStepSchema = Schema.Struct({
  kind: Schema.Literal("commerce.forceFailure"),
  failure: Schema.String,
  continueOnError: OptionalContinueOnError,
})
export type CommerceForceFailureStep = typeof CommerceForceFailureStepSchema.Type

export const CommerceExpireSubscriptionStepSchema = Schema.Struct({
  kind: Schema.Literal("commerce.expireSubscription"),
  productId: OptionalNullableString,
  continueOnError: OptionalContinueOnError,
})
export type CommerceExpireSubscriptionStep = typeof CommerceExpireSubscriptionStepSchema.Type

export const CommerceDisableAutoRenewStepSchema = Schema.Struct({
  kind: Schema.Literal("commerce.disableAutoRenew"),
  productId: OptionalNullableString,
  continueOnError: OptionalContinueOnError,
})
export type CommerceDisableAutoRenewStep = typeof CommerceDisableAutoRenewStepSchema.Type

export const CommerceSetTimeRateStepSchema = Schema.Struct({
  kind: Schema.Literal("commerce.setTimeRate"),
  rate: Schema.String,
  continueOnError: OptionalContinueOnError,
})
export type CommerceSetTimeRateStep = typeof CommerceSetTimeRateStepSchema.Type

export const CommerceExecutableFlowStepSchema = Schema.Union(
  CommerceOpenPaywallStepSchema,
  CommerceAssertProductVisibleStepSchema,
  CommerceLoadProductsStepSchema,
  CommercePurchaseStepSchema,
  CommerceRestoreStepSchema,
  CommerceAssertEntitlementStepSchema,
  CommerceAssertOfferingsLoadedStepSchema,
  CommerceRelaunchAppStepSchema,
)
export type CommerceExecutableFlowStep = typeof CommerceExecutableFlowStepSchema.Type

export const CommerceStoreKitControlStepSchema = Schema.Union(
  CommerceClearTransactionsStepSchema,
  CommerceForceFailureStepSchema,
  CommerceExpireSubscriptionStepSchema,
  CommerceDisableAutoRenewStepSchema,
  CommerceSetTimeRateStepSchema,
)
export type CommerceStoreKitControlStep = typeof CommerceStoreKitControlStepSchema.Type

export const CommerceFlowStepSchema = Schema.Union(
  CommerceExecutableFlowStepSchema,
  CommerceStoreKitControlStepSchema,
)
export type CommerceFlowStep = typeof CommerceFlowStepSchema.Type

export const CommerceValidationPlanSchema = Schema.Struct({
  contract: Schema.Literal("probe.commerce-plan/v1"),
  productId: OptionalNullableString,
  expectedEntitlement: OptionalNullableString,
  steps: Schema.Array(CommerceFlowStepSchema),
})
export type CommerceValidationPlan = typeof CommerceValidationPlanSchema.Type

export const CommerceEnvironmentReportSchema = Schema.Struct({
  authority: EnvironmentAuthority,
  authoritative: Schema.Boolean,
  summary: Schema.String,
  warnings: Schema.Array(Schema.String),
})
export type CommerceEnvironmentReport = typeof CommerceEnvironmentReportSchema.Type

export const CommerceValidationStepResultSchema = Schema.Struct({
  index: PositiveIntegerSchema,
  kind: Schema.String,
  boundary: CommerceBoundary,
  verdict: CommerceVerdict,
  stub: Schema.Boolean,
  summary: Schema.String,
  details: Schema.Array(Schema.String),
  warnings: Schema.Array(Schema.String),
  flowResult: Schema.Union(FlowResultSchema, Schema.Null),
})
export type CommerceValidationStepResult = typeof CommerceValidationStepResultSchema.Type

export const CommerceValidationFailedStepSchema = Schema.Struct({
  index: PositiveIntegerSchema,
  kind: Schema.String,
  verdict: CommerceVerdict,
  summary: Schema.String,
})
export type CommerceValidationFailedStep = typeof CommerceValidationFailedStepSchema.Type

export const CommerceValidationReportSchema = Schema.Struct({
  contract: Schema.Literal("probe.commerce-validation/report-v1"),
  executedAt: Schema.String,
  sessionId: Schema.String,
  mode: CommerceValidationMode,
  provider: Schema.Union(CommerceProvider, Schema.Null),
  productId: NullableString,
  expectedEntitlement: NullableString,
  summary: Schema.String,
  verdict: CommerceVerdict,
  timingFacts: Schema.Array(Schema.String),
  environment: CommerceEnvironmentReportSchema,
  executedSteps: Schema.Array(CommerceValidationStepResultSchema),
  failedStep: Schema.Union(CommerceValidationFailedStepSchema, Schema.Null),
  warnings: Schema.Array(Schema.String),
  reportArtifact: Schema.Union(ArtifactRecord, Schema.Null),
})
export type CommerceValidationReport = typeof CommerceValidationReportSchema.Type

const normalizeEmbeddedFlowInput = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return {
      contract: "probe.session-flow/v1",
      steps: value,
    }
  }

  if (isRecord(value) && value.contract === undefined && Array.isArray(value.steps)) {
    return {
      contract: "probe.session-flow/v1",
      steps: value.steps,
    }
  }

  return value
}

const normalizeCommerceFlowStepInput = (value: unknown): unknown => {
  if (!isRecord(value)) {
    return value
  }

  if ("flow" in value) {
    return {
      ...value,
      flow: normalizeEmbeddedFlowInput(value.flow),
    }
  }

  return value
}

const normalizeCommercePlanInput = (value: unknown): unknown => {
  if (!isRecord(value)) {
    return value
  }

  return {
    ...value,
    steps: Array.isArray(value.steps)
      ? value.steps.map((step) => normalizeCommerceFlowStepInput(step))
      : value.steps,
  }
}

export const isCommerceExecutableStep = (step: CommerceFlowStep): step is CommerceExecutableFlowStep =>
  "flow" in step

export const isCommerceStoreKitControlStep = (step: CommerceFlowStep): step is CommerceStoreKitControlStep =>
  !isCommerceExecutableStep(step)

export const validateCommerceFlowStep = (step: CommerceFlowStep): string | null => {
  switch (step.kind) {
    case "commerce.assertProductVisible":
      return step.productId.trim().length > 0 ? null : "commerce.assertProductVisible requires a non-empty productId."
    case "commerce.assertEntitlement":
      return step.entitlement.trim().length > 0 ? null : "commerce.assertEntitlement requires a non-empty entitlement."
    case "commerce.forceFailure":
      return step.failure.trim().length > 0 ? null : "commerce.forceFailure requires a non-empty failure label."
    case "commerce.setTimeRate":
      return step.rate.trim().length > 0 ? null : "commerce.setTimeRate requires a non-empty rate string."
    default:
      if (isCommerceExecutableStep(step)) {
        return validateFlowContract(step.flow)
      }

      return null
  }
}

export const validateCommerceValidationPlan = (plan: CommerceValidationPlan): string | null => {
  if (plan.steps.length === 0) {
    return "Commerce validation plans require at least one step."
  }

  for (const [index, step] of plan.steps.entries()) {
    const validationError = validateCommerceFlowStep(step)

    if (validationError !== null) {
      return `Step ${index + 1}: ${validationError}`
    }
  }

  return null
}

export const decodeCommerceValidationPlan = (value: unknown): CommerceValidationPlan =>
  Schema.decodeUnknownSync(CommerceValidationPlanSchema)(normalizeCommercePlanInput(value))

export const rollupCommerceVerdict = (verdicts: ReadonlyArray<CommerceVerdict>): CommerceVerdict => {
  if (verdicts.some((verdict) => verdict === "blocked")) {
    return "blocked"
  }

  if (verdicts.length > 0 && verdicts.every((verdict) => verdict === "verified")) {
    return "verified"
  }

  if (verdicts.some((verdict) => verdict === "verified" || verdict === "configured")) {
    return "configured"
  }

  return "unknown"
}

const baseEnvironmentWarnings = {
  localStoreKit: [
    "Local StoreKit validates local StoreKit simulation only, not Apple-side sandbox/TestFlight availability.",
    "Simulator-backed purchase checks are useful for deterministic smoke, but they are not proof that App Store Connect or Paid Applications Agreement state is correct.",
  ],
  sandboxTiming: [
    "Apple sandbox renewal timing is compressed relative to production and can auto-renew up to 12 times.",
  ],
  testflightTiming: [
    "TestFlight auto-renewable subscriptions renew once per day, up to 6 renewals within 1 week.",
  ],
} as const

const revenueCatTimingFacts = [
  "RevenueCat CustomerInfo refreshes after roughly 5 minutes in foreground, after purchase/restore, and about every 25 hours in background.",
  "RevenueCat can keep previously-active entitlements unlocked for up to 3 days while offline.",
] as const

export const buildCommerceTimingFacts = (args: {
  readonly mode: CommerceValidationMode | null
  readonly provider: CommerceProvider | null
}): Array<string> => {
  const facts: Array<string> = []

  switch (args.mode) {
    case "sandbox":
      facts.push(...baseEnvironmentWarnings.sandboxTiming)
      break
    case "testflight":
      facts.push(...baseEnvironmentWarnings.testflightTiming)
      break
    default:
      break
  }

  if (args.provider === "revenuecat") {
    facts.push(...revenueCatTimingFacts)
  }

  return facts
}

export const buildCommerceEnvironmentReport = (args: {
  readonly mode: CommerceValidationMode
  readonly session: Pick<SessionHealth, "target" | "runner">
}): CommerceEnvironmentReport => {
  switch (args.mode) {
    case "local-storekit":
      return {
        authority: "local-storekit-simulated",
        authoritative: false,
        summary: args.session.target.platform === "simulator"
          ? "Local StoreKit is running against a simulator-backed session and validates local simulation only."
          : "Local StoreKit validates local StoreKit simulation only and is not authoritative for Apple-backed commerce behavior.",
        warnings: [...baseEnvironmentWarnings.localStoreKit],
      }
    case "sandbox":
      return args.session.target.platform === "device" && args.session.runner.kind === "real-device-live"
        ? {
            authority: "sandbox-authoritative",
            authoritative: true,
            summary: "Sandbox validation is running on a real-device live session, which is the authoritative Apple-backed pre-release lane.",
            warnings: [...baseEnvironmentWarnings.sandboxTiming],
          }
        : {
            authority: "simulator-untrusted",
            authoritative: false,
            summary: "Sandbox mode is not authoritative on simulator or preflight-only device sessions.",
            warnings: [
              "Sandbox validation requires a real-device live session before Probe can treat it as authoritative.",
              ...baseEnvironmentWarnings.sandboxTiming,
            ],
          }
    case "testflight":
      return args.session.target.platform === "device"
        ? {
            authority: "testflight-authoritative",
            authoritative: true,
            summary: "TestFlight is an authoritative Apple-backed validation lane for commerce behavior.",
            warnings: [...baseEnvironmentWarnings.testflightTiming],
          }
        : {
            authority: "simulator-untrusted",
            authoritative: false,
            summary: "TestFlight validation requires a real device; simulator sessions are not authoritative.",
            warnings: [
              "Simulator-backed validation is not equivalent to TestFlight for subscription behavior.",
              ...baseEnvironmentWarnings.testflightTiming,
            ],
          }
  }
}

export const buildCommerceDoctorReport = (args: {
  readonly workspaceRoot: string
  readonly bundleId: string
  readonly mode: CommerceValidationMode | null
  readonly provider: CommerceProvider | null
  readonly checks: ReadonlyArray<CommerceCheck>
  readonly timingFacts?: ReadonlyArray<string>
  readonly warnings?: ReadonlyArray<string>
}): CommerceDoctorReport => ({
  contract: "probe.commerce-doctor/report-v1",
  generatedAt: nowIso(),
  workspaceRoot: args.workspaceRoot,
  bundleId: args.bundleId,
  mode: args.mode,
  provider: args.provider,
  summary: `Commerce doctor recorded ${args.checks.length} check${args.checks.length === 1 ? "" : "s"} for ${args.bundleId}.`,
  verdict: rollupCommerceVerdict(args.checks.map((check) => check.verdict)),
  timingFacts: [...(args.timingFacts ?? buildCommerceTimingFacts({ mode: args.mode, provider: args.provider }))],
  checks: [...args.checks],
  warnings: [...(args.warnings ?? [])],
})

export const buildCommerceValidationReport = (args: {
  readonly sessionId: string
  readonly mode: CommerceValidationMode
  readonly provider: CommerceProvider | null
  readonly plan: CommerceValidationPlan | null
  readonly environment: CommerceEnvironmentReport
  readonly executedSteps: ReadonlyArray<CommerceValidationStepResult>
  readonly timingFacts?: ReadonlyArray<string>
  readonly warnings?: ReadonlyArray<string>
  readonly reportArtifact?: ArtifactRecord | null
}): CommerceValidationReport => {
  const failedStep = args.executedSteps.find((step) => step.verdict === "blocked") ?? null
  const stepVerdict = rollupCommerceVerdict(args.executedSteps.map((step) => step.verdict))
  const verdict = args.environment.authoritative
    ? stepVerdict
    : stepVerdict === "blocked"
      ? "blocked"
      : args.executedSteps.length > 0
        ? "configured"
        : "unknown"

  const stubCount = args.executedSteps.filter((step) => step.stub).length
  const warnings = [...args.environment.warnings, ...(args.warnings ?? [])]

  return {
    contract: "probe.commerce-validation/report-v1",
    executedAt: nowIso(),
    sessionId: args.sessionId,
    mode: args.mode,
    provider: args.provider,
    productId: args.plan?.productId ?? null,
    expectedEntitlement: args.plan?.expectedEntitlement ?? null,
    summary: args.executedSteps.length > 0
      ? `Commerce validation ran ${args.executedSteps.length} step${args.executedSteps.length === 1 ? "" : "s"} in ${args.mode} mode${stubCount > 0 ? ` with ${stubCount} stubbed control step${stubCount === 1 ? "" : "s"}` : ""}.`
      : `Commerce validation produced an environment-only report for ${args.mode} mode.`,
    verdict,
    timingFacts: [...(args.timingFacts ?? buildCommerceTimingFacts({ mode: args.mode, provider: args.provider }))],
    environment: args.environment,
    executedSteps: [...args.executedSteps],
    failedStep: failedStep
      ? {
          index: failedStep.index,
          kind: failedStep.kind,
          verdict: failedStep.verdict,
          summary: failedStep.summary,
        }
      : null,
    warnings,
    reportArtifact: args.reportArtifact ?? null,
  }
}

export type CommerceValidationExecutionStep = CommerceExecutableFlowStep | CommerceStoreKitControlStep
export type EmbeddedCommerceFlow = FlowContract
