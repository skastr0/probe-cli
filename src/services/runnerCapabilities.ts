import { Effect } from "effect"
import { UnsupportedCapabilityError } from "../domain/errors"
import { isLiveRunnerDetails, type SessionRunnerDetails } from "../domain/session"
import type { RunnerAction, RunnerCapability } from "./runnerProtocol"

// PRB-072: one reusable registry mapping every capability-gated runner action
// to what the production Swift ready frame actually implements today. This
// exists because the host previously modeled uiActionBatch as a capability
// while the production command switch in AttachControlSpikeUITests.swift
// only implements uiAction — the registry is the single place that truth
// lives, instead of scattered assumptions across the host and fake harnesses.
export interface RunnerCapabilityRegistryEntry {
  readonly capability: RunnerCapability
  readonly gatedAction: RunnerAction
  readonly implementedInSwift: boolean
  readonly missingCapabilityErrorCode: string
  readonly evidence: string
}

export const RUNNER_CAPABILITY_REGISTRY: ReadonlyArray<RunnerCapabilityRegistryEntry> = [
  {
    capability: "uiAction",
    gatedAction: "uiAction",
    implementedInSwift: true,
    missingCapabilityErrorCode: "session-runner-capability-ui-action",
    evidence: "ios/ProbeRunner/AttachControlSpikeUITests.swift handleLifecycleCommand implements case \"uiAction\".",
  },
  {
    capability: "uiActionBatch",
    gatedAction: "uiActionBatch",
    implementedInSwift: true,
    missingCapabilityErrorCode: "session-runner-capability-ui-action-batch",
    evidence:
      "PRB-092: ios/ProbeRunner/AttachControlSpikeUITests.swift handleLifecycleCommand now has "
      + "case \"uiActionBatch\" — decodes RunnerUIActionBatchPayload, executes children in order via "
      + "performRunnerUIActionBatch, stops at the first failure, and reports completed count/failed index/"
      + "kind/per-child timing/total timing even on partial failure. Boundary-tested against a live "
      + "Simulator session (iPhone 17 Pro, iOS 26.5) — see "
      + "testUIActionBatchExecutesChildrenInOrderAndStopsAtFirstFailure, "
      + "testUIActionBatchMultiTapChildRecognizesFiveTapsThroughOneDomainSchema, and "
      + "testUIActionBatchAtTheHTTPBoundaryIsOneRPCWithReplaySafeRedelivery, plus "
      + "knowledge/xcuitest-runner/integration-notes.md's \"PRB-092\" section for the measured receipt.",
  },
]

const registryByCapability = new Map(
  RUNNER_CAPABILITY_REGISTRY.map((entry) => [entry.capability, entry] as const),
)

if (registryByCapability.size !== RUNNER_CAPABILITY_REGISTRY.length) {
  throw new Error(
    "Duplicate capability entries in RUNNER_CAPABILITY_REGISTRY; every gated runner command must have exactly one entry.",
  )
}

/** Looks up the one registry entry for a gated capability, or throws — a missing entry is a programmer error, not a runtime user error. */
export const runnerCapabilityRegistryEntry = (capability: RunnerCapability): RunnerCapabilityRegistryEntry => {
  const entry = registryByCapability.get(capability)

  if (entry === undefined) {
    throw new Error(
      `No RUNNER_CAPABILITY_REGISTRY entry for capability "${capability}". `
        + "Every gated runner command must register exactly one entry before it can be required.",
    )
  }

  return entry
}

export const formatAdvertisedCapabilities = (advertised: ReadonlyArray<RunnerCapability>): string =>
  advertised.length === 0 ? "none" : advertised.join(", ")

/**
 * PRB-072: resolves the capability set a runner ready frame advertises.
 * A missing `capabilities` field is never upgraded to an assumed default —
 * a runner that does not say what it supports is treated as supporting
 * nothing, so gated commands fail closed instead of trusting an old or
 * partial binary. Used by SimulatorHarness/RealDeviceHarness when parsing
 * the ready frame, and by requireRunnerCapability below when reading it
 * back off session health.
 */
export const resolveAdvertisedCapabilities = (
  ready: { readonly capabilities?: ReadonlyArray<RunnerCapability> },
): ReadonlyArray<RunnerCapability> => ready.capabilities ?? []

/** Same fail-closed resolution as resolveAdvertisedCapabilities, read from a session's live health snapshot. */
export const advertisedRunnerCapabilities = (
  runner: SessionRunnerDetails,
): ReadonlyArray<RunnerCapability> =>
  isLiveRunnerDetails(runner) ? resolveAdvertisedCapabilities(runner) : []

/**
 * PRB-072: the single reusable gate every executor calls before sending a
 * capability-gated runner command. Generic over the caller's own session
 * record type so it stays decoupled from SessionRegistry's internal
 * ActiveSessionRecord union — any executor supplies its own runner-backed
 * type guard and gets the narrowed record back on success.
 *
 * Fails closed with a typed UnsupportedCapabilityError in two cases: the
 * session has no live runner transport at all, or the runner is live but
 * does not advertise the required capability. Both branches name the
 * required capability and the runner's actual advertised set so the error
 * is actionable without re-deriving state.
 */
export const requireRunnerCapability = <Rec, RunnerBackedRec extends Rec>(args: {
  readonly record: Rec
  readonly isRunnerBacked: (record: Rec) => record is RunnerBackedRec
  readonly advertised: (record: RunnerBackedRec) => ReadonlyArray<RunnerCapability>
  readonly capability: RunnerCapability
  readonly capabilityTag: string
  readonly usageDescription: string
  readonly notRunnerBacked: {
    readonly code: string
    readonly reason: string
    readonly nextStep: string
  }
  readonly missingCapabilityNextStep: string
}): Effect.Effect<RunnerBackedRec, UnsupportedCapabilityError> =>
  Effect.gen(function* () {
    const entry = runnerCapabilityRegistryEntry(args.capability)

    if (!args.isRunnerBacked(args.record)) {
      return yield* new UnsupportedCapabilityError({
        code: args.notRunnerBacked.code,
        capability: args.capabilityTag,
        reason: args.notRunnerBacked.reason,
        nextStep: args.notRunnerBacked.nextStep,
        details: [],
        wall: false,
      })
    }

    const advertised = args.advertised(args.record)

    if (!advertised.includes(args.capability)) {
      return yield* new UnsupportedCapabilityError({
        code: entry.missingCapabilityErrorCode,
        capability: args.capabilityTag,
        reason: `The connected runner does not advertise ${args.capability} support required for ${args.usageDescription}.`,
        nextStep: args.missingCapabilityNextStep,
        details: [
          `required capability: ${args.capability}`,
          `runner capabilities: ${formatAdvertisedCapabilities(advertised)}`,
        ],
        wall: false,
      })
    }

    return args.record
  })
