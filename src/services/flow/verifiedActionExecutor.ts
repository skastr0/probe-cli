import type { Effect } from "effect"
import { flowV2StepToSessionAction, isFlowV2SessionActionStep, type FlowV2Step } from "../../domain/flow-v2"
import type { SessionAction } from "../../domain/action"
import type { EnvironmentError, SessionNotFoundError, UnsupportedCapabilityError, UserInputError } from "../../domain/errors"
import type { ActionExecutionOutcome } from "../sessionShared"
import type { FlowExecutorDeps } from "./flowExecutorDeps"

/**
 * PRB-073: extracted from `runFlow`'s else-branch. The "verified action"
 * lane — a step executed through the shared, snapshot-verified
 * `executeSessionAction` path (host snapshot before/after, semantic
 * resolution, retries) rather than the fast direct-runner lane.
 */
export const toSessionAction = (step: FlowV2Step): SessionAction => {
  if (isFlowV2SessionActionStep(step)) {
    return flowV2StepToSessionAction(step)
  }

  throw new Error(`Expected a flow session-action step, received ${step.kind}.`)
}

export const executeVerifiedActionStep = (args: {
  readonly sessionId: string
  readonly step: FlowV2Step
  readonly deps: FlowExecutorDeps
}): Effect.Effect<ActionExecutionOutcome, SessionNotFoundError | UserInputError | UnsupportedCapabilityError | EnvironmentError> =>
  args.deps.executeSessionAction({
    sessionId: args.sessionId,
    action: toSessionAction(args.step),
    recordAction: false,
  })
