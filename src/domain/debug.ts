import { Schema } from "effect"
import { DrillResult, NullableString } from "./output"

const NullableNumber = Schema.Union(Schema.Number, Schema.Null)
const NullableBoolean = Schema.Union(Schema.Boolean, Schema.Null)

const SessionDebuggerTargetScope = Schema.Literal("session-app", "external-host-process")

export const DebugAttachTargetScope = Schema.Literal("external-host-process")
export type DebugAttachTargetScope = typeof DebugAttachTargetScope.Type

export const DebuggerAttachState = Schema.Literal(
  "not-attached",
  "attached",
  "detached",
  "failed",
)
export type DebuggerAttachState = typeof DebuggerAttachState.Type

export const SessionCoordination = Schema.Struct({
  runnerActionsBlocked: Schema.Boolean,
  runnerActionPolicy: Schema.Literal("normal", "blocked-by-debugger-stop"),
  reason: NullableString,
})
export type SessionCoordination = typeof SessionCoordination.Type

export const SessionDebuggerDetails = Schema.Struct({
  attachState: DebuggerAttachState,
  targetScope: Schema.Union(SessionDebuggerTargetScope, Schema.Null),
  bridgePid: NullableNumber,
  bridgeStartedAt: NullableString,
  bridgeExitedAt: NullableString,
  pythonExecutable: NullableString,
  lldbPythonPath: NullableString,
  lldbVersion: NullableString,
  attachedPid: NullableNumber,
  processState: NullableString,
  stopId: NullableNumber,
  stopReason: NullableString,
  stopDescription: NullableString,
  lastCommand: NullableString,
  lastCommandOk: NullableBoolean,
  lastUpdatedAt: NullableString,
  frameLogArtifactKey: NullableString,
  stderrArtifactKey: NullableString,
})
export type SessionDebuggerDetails = typeof SessionDebuggerDetails.Type

export const DebugBreakpointLocation = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("function"),
    functionName: Schema.String,
  }),
  Schema.Struct({
    kind: Schema.Literal("file-line"),
    file: Schema.String,
    line: Schema.Number,
  }),
)
export type DebugBreakpointLocation = typeof DebugBreakpointLocation.Type

export const DebugCommandName = Schema.Literal(
  "attach",
  "backtrace",
  "vars",
  "eval",
  "continue",
  "detach",
  "breakpoint-set",
  "breakpoint-clear",
)
export type DebugCommandName = typeof DebugCommandName.Type

export const DebugAttachCommand = Schema.Struct({
  command: Schema.Literal("attach"),
  targetScope: DebugAttachTargetScope,
  pid: NullableNumber,
})
export type DebugAttachCommand = typeof DebugAttachCommand.Type

export const DebugBacktraceCommand = Schema.Struct({
  command: Schema.Literal("backtrace"),
  threadIndexId: NullableNumber,
  frameLimit: Schema.Number,
})
export type DebugBacktraceCommand = typeof DebugBacktraceCommand.Type

export const DebugVarsCommand = Schema.Struct({
  command: Schema.Literal("vars"),
  threadIndexId: NullableNumber,
  frameIndex: NullableNumber,
})
export type DebugVarsCommand = typeof DebugVarsCommand.Type

export const DebugEvalCommand = Schema.Struct({
  command: Schema.Literal("eval"),
  expression: Schema.String,
  threadIndexId: NullableNumber,
  frameIndex: NullableNumber,
  timeoutMs: Schema.Number,
})
export type DebugEvalCommand = typeof DebugEvalCommand.Type

export const DebugContinueCommand = Schema.Struct({
  command: Schema.Literal("continue"),
})
export type DebugContinueCommand = typeof DebugContinueCommand.Type

export const DebugDetachCommand = Schema.Struct({
  command: Schema.Literal("detach"),
})
export type DebugDetachCommand = typeof DebugDetachCommand.Type

export const DebugBreakpointSetCommand = Schema.Struct({
  command: Schema.Literal("breakpoint-set"),
  location: DebugBreakpointLocation,
})
export type DebugBreakpointSetCommand = typeof DebugBreakpointSetCommand.Type

export const DebugBreakpointClearCommand = Schema.Struct({
  command: Schema.Literal("breakpoint-clear"),
  breakpointId: Schema.Number,
})
export type DebugBreakpointClearCommand = typeof DebugBreakpointClearCommand.Type

export const DebugCommandInput = Schema.Union(
  DebugAttachCommand,
  DebugBacktraceCommand,
  DebugVarsCommand,
  DebugEvalCommand,
  DebugContinueCommand,
  DebugDetachCommand,
  DebugBreakpointSetCommand,
  DebugBreakpointClearCommand,
)
export type DebugCommandInput = typeof DebugCommandInput.Type

export const DebugCommandResult = Schema.Struct({
  sessionId: Schema.String,
  command: DebugCommandName,
  summary: Schema.String,
  output: DrillResult,
  debugger: SessionDebuggerDetails,
  coordination: SessionCoordination,
})
export type DebugCommandResult = typeof DebugCommandResult.Type
