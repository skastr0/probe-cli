import type { FlowContract, FlowSessionActionStep, FlowStep } from "./action"
import {
  isFlowV2Contract,
  isFlowV2SessionActionStep,
  resolveFlowExecutionProfile,
  type FlowSequenceStep,
  type FlowV2Contract,
  type FlowV2SessionActionStep,
  type FlowV2Step,
  type SessionFlowContract,
} from "./flow-v2"

export type PlannableFlowStep = FlowStep | FlowV2Step
export type PlannableFlowSessionActionStep = FlowSessionActionStep | FlowV2SessionActionStep

export type PlannedStep =
  | { readonly kind: "verified"; readonly step: PlannableFlowStep; readonly index: number }
  | { readonly kind: "fast-single"; readonly step: PlannableFlowSessionActionStep; readonly index: number }
  | { readonly kind: "batch-sequence"; readonly step: FlowSequenceStep; readonly index: number }
  | { readonly kind: "checkpoint"; readonly step: PlannableFlowStep; readonly index: number }
  | { readonly kind: "evidence"; readonly step: PlannableFlowStep; readonly index: number }

export type ExecutionPlan = {
  readonly steps: ReadonlyArray<PlannedStep>
}

const isCheckpointStep = (step: PlannableFlowStep): boolean =>
  step.kind === "snapshot" || step.kind === "assert"

const isEvidenceStep = (step: PlannableFlowStep): boolean =>
  step.kind === "screenshot" || step.kind === "video"

const planFlowV1Step = (step: FlowStep, index: number): PlannedStep => {
  if (isCheckpointStep(step)) {
    return { kind: "checkpoint", step, index }
  }

  if (isEvidenceStep(step)) {
    return { kind: "evidence", step, index }
  }

  return { kind: "verified", step, index }
}

const planFlowV2Step = (flow: FlowV2Contract, step: FlowV2Step, index: number): PlannedStep => {
  if (step.kind === "sequence") {
    return { kind: "batch-sequence", step, index }
  }

  if (isCheckpointStep(step)) {
    return { kind: "checkpoint", step, index }
  }

  if (isEvidenceStep(step)) {
    return { kind: "evidence", step, index }
  }

  const executionProfile = resolveFlowExecutionProfile(flow.execution, step.execution)

  if (executionProfile === "fast" && isFlowV2SessionActionStep(step)) {
    return { kind: "fast-single", step, index }
  }

  return { kind: "verified", step, index }
}

export const planFlowExecution = (flow: SessionFlowContract): ExecutionPlan => ({
  steps: isFlowV2Contract(flow)
    ? flow.steps.map((step, index) => planFlowV2Step(flow, step, index + 1))
    : flow.steps.map((step, index) => planFlowV1Step(step, index + 1)),
})

export const isVerifiedPlannedStep = (
  step: PlannedStep,
): step is Extract<PlannedStep, { readonly kind: "verified" }> => step.kind === "verified"

export const isFastSinglePlannedStep = (
  step: PlannedStep,
): step is Extract<PlannedStep, { readonly kind: "fast-single" }> => step.kind === "fast-single"

export const isBatchSequencePlannedStep = (
  step: PlannedStep,
): step is Extract<PlannedStep, { readonly kind: "batch-sequence" }> => step.kind === "batch-sequence"

export const isCheckpointPlannedStep = (
  step: PlannedStep,
): step is Extract<PlannedStep, { readonly kind: "checkpoint" }> => step.kind === "checkpoint"

export const isEvidencePlannedStep = (
  step: PlannedStep,
): step is Extract<PlannedStep, { readonly kind: "evidence" }> => step.kind === "evidence"
