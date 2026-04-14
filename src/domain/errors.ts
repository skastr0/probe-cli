import { Schema } from "effect"

const NullableNumber = Schema.Union(Schema.Number, Schema.Null)

export const DeviceInterruptionSignal = Schema.Literal(
  "device-locked",
  "passcode-required",
  "trust-required",
  "developer-mode-required",
  "target-foreground-blocked",
)
export type DeviceInterruptionSignal = typeof DeviceInterruptionSignal.Type

export class CapabilityNotReadyError extends Schema.TaggedError<CapabilityNotReadyError>()(
  "CapabilityNotReadyError",
  {
    capability: Schema.String,
    reason: Schema.String,
    nextStep: Schema.String,
  },
) {}

export class UserInputError extends Schema.TaggedError<UserInputError>()("UserInputError", {
  code: Schema.String,
  reason: Schema.String,
  nextStep: Schema.String,
  details: Schema.Array(Schema.String),
}) {}

export class EnvironmentError extends Schema.TaggedError<EnvironmentError>()(
  "EnvironmentError",
  {
    code: Schema.String,
    reason: Schema.String,
    nextStep: Schema.String,
    details: Schema.Array(Schema.String),
  },
) {}

export class DeviceInterruptionError extends Schema.TaggedError<DeviceInterruptionError>()(
  "DeviceInterruptionError",
  {
    code: Schema.String,
    signal: DeviceInterruptionSignal,
    reason: Schema.String,
    nextStep: Schema.String,
    details: Schema.Array(Schema.String),
  },
) {}

export class UnsupportedCapabilityError extends Schema.TaggedError<UnsupportedCapabilityError>()(
  "UnsupportedCapabilityError",
  {
    code: Schema.String,
    capability: Schema.String,
    reason: Schema.String,
    nextStep: Schema.String,
    details: Schema.Array(Schema.String),
    wall: Schema.Boolean,
  },
) {}

export class ChildProcessError extends Schema.TaggedError<ChildProcessError>()(
  "ChildProcessError",
  {
    code: Schema.String,
    command: Schema.String,
    reason: Schema.String,
    nextStep: Schema.String,
    exitCode: NullableNumber,
    stderrExcerpt: Schema.String,
  },
) {}

export class DaemonNotRunningError extends Schema.TaggedError<DaemonNotRunningError>()(
  "DaemonNotRunningError",
  {
    socketPath: Schema.String,
    reason: Schema.String,
    nextStep: Schema.String,
  },
) {}

export class ProtocolMismatchError extends Schema.TaggedError<ProtocolMismatchError>()(
  "ProtocolMismatchError",
  {
    expectedVersion: Schema.String,
    receivedVersion: Schema.String,
    nextStep: Schema.String,
  },
) {}

export class SessionConflictError extends Schema.TaggedError<SessionConflictError>()(
  "SessionConflictError",
  {
    reason: Schema.String,
    nextStep: Schema.String,
  },
) {}

export class SessionNotFoundError extends Schema.TaggedError<SessionNotFoundError>()(
  "SessionNotFoundError",
  {
    sessionId: Schema.String,
    nextStep: Schema.String,
  },
) {}

export class ArtifactNotFoundError extends Schema.TaggedError<ArtifactNotFoundError>()(
  "ArtifactNotFoundError",
  {
    sessionId: Schema.String,
    artifactKey: Schema.String,
    nextStep: Schema.String,
  },
) {}

export type ProbeError =
  | CapabilityNotReadyError
  | UserInputError
  | EnvironmentError
  | DeviceInterruptionError
  | UnsupportedCapabilityError
  | ChildProcessError
  | DaemonNotRunningError
  | ProtocolMismatchError
  | SessionConflictError
  | SessionNotFoundError
  | ArtifactNotFoundError

export interface ProbeFailurePayload {
  readonly code: string
  readonly category:
    | "user"
    | "environment"
    | "unsupported"
    | "child-process"
    | "daemon"
    | "protocol"
    | "conflict"
    | "not-found"
  readonly reason: string
  readonly nextStep: string
  readonly details: ReadonlyArray<string>
  readonly capability: string | null
  readonly expectedVersion: string | null
  readonly receivedVersion: string | null
  readonly command: string | null
  readonly exitCode: number | null
  readonly sessionId: string | null
  readonly artifactKey: string | null
  readonly wall: boolean
}

export const isProbeError = (value: unknown): value is ProbeError => {
  if (typeof value !== "object" || value === null || !("_tag" in value)) {
    return false
  }

  const tag = value._tag

  return (
    tag === "CapabilityNotReadyError"
    || tag === "UserInputError"
    || tag === "EnvironmentError"
    || tag === "DeviceInterruptionError"
    || tag === "UnsupportedCapabilityError"
    || tag === "ChildProcessError"
    || tag === "DaemonNotRunningError"
    || tag === "ProtocolMismatchError"
    || tag === "SessionConflictError"
    || tag === "SessionNotFoundError"
    || tag === "ArtifactNotFoundError"
  )
}

export const toFailurePayload = (error: ProbeError): ProbeFailurePayload => {
  switch (error._tag) {
    case "CapabilityNotReadyError":
      return {
        code: "capability-not-ready",
        category: "unsupported",
        reason: `${error.capability}: ${error.reason}`,
        nextStep: error.nextStep,
        details: [],
        capability: error.capability,
        expectedVersion: null,
        receivedVersion: null,
        command: null,
        exitCode: null,
        sessionId: null,
        artifactKey: null,
        wall: true,
      }

    case "UserInputError":
      return {
        code: error.code,
        category: "user",
        reason: error.reason,
        nextStep: error.nextStep,
        details: [...error.details],
        capability: null,
        expectedVersion: null,
        receivedVersion: null,
        command: null,
        exitCode: null,
        sessionId: null,
        artifactKey: null,
        wall: false,
      }

    case "EnvironmentError":
      return {
        code: error.code,
        category: "environment",
        reason: error.reason,
        nextStep: error.nextStep,
        details: [...error.details],
        capability: null,
        expectedVersion: null,
        receivedVersion: null,
        command: null,
        exitCode: null,
        sessionId: null,
        artifactKey: null,
        wall: false,
      }

    case "DeviceInterruptionError":
      return {
        code: error.code,
        category: "environment",
        reason: error.reason,
        nextStep: error.nextStep,
        details: [...error.details],
        capability: null,
        expectedVersion: null,
        receivedVersion: null,
        command: null,
        exitCode: null,
        sessionId: null,
        artifactKey: null,
        wall: false,
      }

    case "UnsupportedCapabilityError":
      return {
        code: error.code,
        category: "unsupported",
        reason: error.reason,
        nextStep: error.nextStep,
        details: [...error.details],
        capability: error.capability,
        expectedVersion: null,
        receivedVersion: null,
        command: null,
        exitCode: null,
        sessionId: null,
        artifactKey: null,
        wall: error.wall,
      }

    case "ChildProcessError":
      return {
        code: error.code,
        category: "child-process",
        reason: error.reason,
        nextStep: error.nextStep,
        details: error.stderrExcerpt.length === 0 ? [] : [error.stderrExcerpt],
        capability: null,
        expectedVersion: null,
        receivedVersion: null,
        command: error.command,
        exitCode: error.exitCode,
        sessionId: null,
        artifactKey: null,
        wall: false,
      }

    case "DaemonNotRunningError":
      return {
        code: "daemon-not-running",
        category: "daemon",
        reason: error.reason,
        nextStep: error.nextStep,
        details: [`socket: ${error.socketPath}`],
        capability: null,
        expectedVersion: null,
        receivedVersion: null,
        command: null,
        exitCode: null,
        sessionId: null,
        artifactKey: null,
        wall: false,
      }

    case "ProtocolMismatchError":
      return {
        code: "protocol-mismatch",
        category: "protocol",
        reason: `Expected protocol ${error.expectedVersion} but received ${error.receivedVersion}.`,
        nextStep: error.nextStep,
        details: [],
        capability: null,
        expectedVersion: error.expectedVersion,
        receivedVersion: error.receivedVersion,
        command: null,
        exitCode: null,
        sessionId: null,
        artifactKey: null,
        wall: false,
      }

    case "SessionConflictError":
      return {
        code: "session-conflict",
        category: "conflict",
        reason: error.reason,
        nextStep: error.nextStep,
        details: [],
        capability: null,
        expectedVersion: null,
        receivedVersion: null,
        command: null,
        exitCode: null,
        sessionId: null,
        artifactKey: null,
        wall: false,
      }

    case "SessionNotFoundError":
      return {
        code: "session-not-found",
        category: "not-found",
        reason: `Session ${error.sessionId} was not found.`,
        nextStep: error.nextStep,
        details: [],
        capability: null,
        expectedVersion: null,
        receivedVersion: null,
        command: null,
        exitCode: null,
        sessionId: error.sessionId,
        artifactKey: null,
        wall: false,
      }

    case "ArtifactNotFoundError":
      return {
        code: "artifact-not-found",
        category: "not-found",
        reason: `Artifact ${error.artifactKey} was not found for session ${error.sessionId}.`,
        nextStep: error.nextStep,
        details: [],
        capability: null,
        expectedVersion: null,
        receivedVersion: null,
        command: null,
        exitCode: null,
        sessionId: error.sessionId,
        artifactKey: error.artifactKey,
        wall: false,
      }
  }
}

export const formatProbeError = (error: ProbeError): string => {
  const failure = toFailurePayload(error)
  const detailLines = failure.details.map((detail) => `detail: ${detail}`)

  return [
    `${failure.code}: ${failure.reason}`,
    `next step: ${failure.nextStep}`,
    ...detailLines,
  ].join("\n")
}
