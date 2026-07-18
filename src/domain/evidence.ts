import { Schema } from "effect"

/**
 * PRB-093: the one canonical evidence policy shared by direct actions, flows
 * (verified + fast + batch sequences), replay, perf-around, and investigation
 * recipes. Before this glyph each of those lanes had its own implicit
 * behavior: verified mutations always captured a pre- and a post-mutation
 * snapshot, fast mutations captured nothing on success but one snapshot on
 * failure, and `sequence` steps exposed a separate "none"/"end" checkpoint
 * vocabulary. This module is the single source of truth for the policy
 * shape, its default, and the pure success/failure capture decisions every
 * lane now asks the same two questions of.
 *
 * Success evidence has three levels:
 *   - "none"   -- zero discretionary snapshots. A selector that requires a
 *                 snapshot to resolve at all (a bare ref/semantic target with
 *                 no cached snapshot yet) still captures one, but that
 *                 capture is tagged "resolution", not "policy-pre"/"policy-post" --
 *                 it is reported explicitly rather than silently folded into
 *                 the "zero" the caller asked for.
 *   - "end"    -- exactly one post-mutation (or post-sequence) snapshot.
 *   - "around" -- exactly one pre-mutation and one post-mutation snapshot,
 *                 both forced fresh regardless of any cached snapshot --
 *                 "around" is the explicit request for maximum before/after
 *                 evidence, so it never trusts a possibly-stale cache.
 *
 * Failure evidence has two levels: "none" (no failure capture attempted) and
 * "snapshot" (best-effort single snapshot after a failed mutation -- see
 * `planFailureEvidence`). A failure capture can never replace or mask the
 * original mutation failure; it is reported as additional evidence only.
 */
export const SuccessEvidencePolicySchema = Schema.Literal("none", "end", "around")
export type SuccessEvidencePolicy = typeof SuccessEvidencePolicySchema.Type

export const FailureEvidencePolicySchema = Schema.Literal("none", "snapshot")
export type FailureEvidencePolicy = typeof FailureEvidencePolicySchema.Type

/** Permissive input shape -- callers specify only the half of the policy they want to override. */
export const EvidencePolicyInputSchema = Schema.Struct({
  success: Schema.optional(SuccessEvidencePolicySchema),
  failure: Schema.optional(FailureEvidencePolicySchema),
})
export type EvidencePolicyInput = typeof EvidencePolicyInputSchema.Type

/** The resolved (fully-populated) policy every executor actually decides against. */
export const EvidencePolicySchema = Schema.Struct({
  success: SuccessEvidencePolicySchema,
  failure: FailureEvidencePolicySchema,
})
export type EvidencePolicy = typeof EvidencePolicySchema.Type

// The default mutation policy (acceptance criterion #2): success=end,
// failure=snapshot. This is what every mutation-capable lane falls back to
// when a caller omits `evidencePolicy` entirely.
export const defaultMutationEvidencePolicy: EvidencePolicy = {
  success: "end",
  failure: "snapshot",
}

export const resolveEvidencePolicy = (input?: EvidencePolicyInput | null): EvidencePolicy => ({
  success: input?.success ?? defaultMutationEvidencePolicy.success,
  failure: input?.failure ?? defaultMutationEvidencePolicy.failure,
})

// "explicit" tags a capture from a command whose entire job is to capture
// (session snapshot, flow snapshot/screenshot/video steps) -- those commands
// are unaffected by evidence policy (acceptance criterion #11) and always
// report this reason rather than a policy-driven one.
export const EvidenceCaptureReasonSchema = Schema.Literal(
  "resolution",
  "policy-pre",
  "policy-post",
  "policy-failure",
  "explicit",
)
export type EvidenceCaptureReason = typeof EvidenceCaptureReasonSchema.Type

export const EvidenceCaptureSchema = Schema.Struct({
  reason: EvidenceCaptureReasonSchema,
  phase: Schema.Literal("pre", "post"),
  snapshotId: Schema.String,
  ms: Schema.Number,
})
export type EvidenceCapture = typeof EvidenceCaptureSchema.Type

export const EvidenceReportSchema = Schema.Struct({
  requested: EvidencePolicySchema,
  captures: Schema.Array(EvidenceCaptureSchema),
  evidenceMs: Schema.Number,
})
export type EvidenceReport = typeof EvidenceReportSchema.Type

export const emptyEvidenceReport = (requested: EvidencePolicy): EvidenceReport => ({
  requested,
  captures: [],
  evidenceMs: 0,
})

/** Builds a report from a requested policy and the captures actually taken (in order). */
export const buildEvidenceReport = (
  requested: EvidencePolicy,
  captures: ReadonlyArray<EvidenceCapture>,
): EvidenceReport => ({
  requested,
  captures: [...captures],
  evidenceMs: captures.reduce((sum, capture) => sum + capture.ms, 0),
})

/**
 * The success-evidence decision, independent of *how* a resolution snapshot
 * is obtained (host-resolved verified lane vs on-device fast/batch lane) --
 * every lane asks this one question and gets back what capture work its
 * policy requires:
 *
 *   - `forcedFreshPre` -- "around" always forces a fresh pre-mutation
 *     capture, ignoring any cached snapshot; this is the only policy that
 *     ever forces a pre capture for evidence's own sake.
 *   - `needsPost` -- "end" and "around" both require exactly one
 *     post-mutation capture; "none" requires zero.
 */
export interface SuccessEvidencePlan {
  readonly forcedFreshPre: boolean
  readonly needsPost: boolean
}

export const planSuccessEvidence = (policy: SuccessEvidencePolicy): SuccessEvidencePlan => ({
  forcedFreshPre: policy === "around",
  needsPost: policy === "end" || policy === "around",
})

/** Failure evidence is best-effort and additive only -- see module doc. */
export const shouldCaptureFailureEvidence = (policy: FailureEvidencePolicy): boolean => policy === "snapshot"
