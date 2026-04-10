import { Schema } from "effect"

const NullableString = Schema.Union(Schema.String, Schema.Null)
const NullableNumber = Schema.Union(Schema.Number, Schema.Null)
const OptionalNullableString = Schema.Union(Schema.String, Schema.Null, Schema.Undefined)
const OptionalNullableNumber = Schema.Union(Schema.Number, Schema.Null, Schema.Undefined)

export const LldbBridgeCommandSchema = Schema.Literal(
  "handshake",
  "attach",
  "backtrace",
  "vars",
  "eval",
  "continue",
  "detach",
  "breakpoint-set",
  "breakpoint-clear",
  "shutdown",
)
export type LldbBridgeCommand = typeof LldbBridgeCommandSchema.Type

export const LldbBridgeReadyFrameSchema = Schema.Struct({
  kind: Schema.Literal("ready"),
  bridgePid: Schema.Number,
  pythonExecutable: Schema.String,
  lldbPythonPath: Schema.String,
  lldbVersion: Schema.String,
  initFilesSkipped: Schema.Boolean,
  asyncMode: Schema.Boolean,
})
export type LldbBridgeReadyFrame = typeof LldbBridgeReadyFrameSchema.Type

export const LldbLineEntrySchema = Schema.Struct({
  file: NullableString,
  line: Schema.Number,
  column: Schema.Number,
})
export type LldbLineEntry = typeof LldbLineEntrySchema.Type

export interface LldbValue {
  readonly name: string | null | undefined
  readonly type: string | null | undefined
  readonly value: string | null | undefined
  readonly summary: string | null | undefined
  readonly numChildren: number | null | undefined
  readonly valueText: string | null | undefined
  readonly error: string | null | undefined
  readonly children: ReadonlyArray<LldbValue> | undefined
}

export const LldbValueSchema: Schema.Schema<LldbValue> = Schema.suspend(() =>
  Schema.Struct({
    name: OptionalNullableString,
    type: OptionalNullableString,
    value: OptionalNullableString,
    summary: OptionalNullableString,
    numChildren: OptionalNullableNumber,
    valueText: OptionalNullableString,
    error: OptionalNullableString,
    children: Schema.Union(Schema.Array(LldbValueSchema), Schema.Undefined),
  }),
)

export const LldbFrameSchema = Schema.Struct({
  frameId: Schema.Number,
  pc: OptionalNullableNumber,
  function: OptionalNullableString,
  displayFunction: OptionalNullableString,
  module: OptionalNullableString,
  lineEntry: Schema.Union(LldbLineEntrySchema, Schema.Null, Schema.Undefined),
  isArtificial: Schema.Boolean,
  isHidden: Schema.Boolean,
  isInlined: Schema.Boolean,
})
export type LldbFrame = typeof LldbFrameSchema.Type

export const LldbThreadSchema = Schema.Struct({
  threadId: Schema.Number,
  indexId: Schema.Number,
  name: OptionalNullableString,
  queue: OptionalNullableString,
  stopReason: Schema.String,
  stopDescription: OptionalNullableString,
  frames: Schema.Array(LldbFrameSchema),
})
export type LldbThread = typeof LldbThreadSchema.Type

export const LldbSelectedThreadSchema = Schema.Struct({
  threadId: Schema.Number,
  indexId: Schema.Number,
  stopReason: Schema.String,
  stopDescription: OptionalNullableString,
})
export type LldbSelectedThread = typeof LldbSelectedThreadSchema.Type

export const LldbProcessSchema = Schema.Struct({
  pid: Schema.Number,
  state: Schema.String,
  stopId: OptionalNullableNumber,
  numThreads: Schema.Union(Schema.Number, Schema.Undefined),
  selectedThread: Schema.Union(LldbSelectedThreadSchema, Schema.Null, Schema.Undefined),
  threads: Schema.Union(Schema.Array(LldbThreadSchema), Schema.Undefined),
})
export type LldbProcess = typeof LldbProcessSchema.Type

export const LldbBreakpointLocationSchema = Schema.Struct({
  id: Schema.Number,
  enabled: Schema.Boolean,
  loadAddress: Schema.Number,
  lineEntry: Schema.Union(LldbLineEntrySchema, Schema.Null, Schema.Undefined),
})
export type LldbBreakpointLocation = typeof LldbBreakpointLocationSchema.Type

export const LldbBreakpointSchema = Schema.Struct({
  breakpointId: Schema.Number,
  enabled: Schema.Boolean,
  isOneShot: Schema.Boolean,
  numLocations: Schema.Number,
  numResolvedLocations: Schema.Number,
  hitCount: Schema.Number,
  locations: Schema.Array(LldbBreakpointLocationSchema),
})
export type LldbBreakpoint = typeof LldbBreakpointSchema.Type

export const LldbEvalOptionsSchema = Schema.Struct({
  timeoutMs: Schema.Number,
  tryAllThreads: Schema.Boolean,
  trapExceptions: Schema.Boolean,
  unwindOnError: Schema.Boolean,
  ignoreBreakpoints: Schema.Boolean,
  stopOthers: Schema.Boolean,
  suppressPersistentResult: Schema.Boolean,
})
export type LldbEvalOptions = typeof LldbEvalOptionsSchema.Type

export const LldbHandshakeRequestSchema = Schema.Struct({
  id: Schema.String,
  command: Schema.Literal("handshake"),
})
export type LldbHandshakeRequest = typeof LldbHandshakeRequestSchema.Type

export const LldbAttachRequestSchema = Schema.Struct({
  id: Schema.String,
  command: Schema.Literal("attach"),
  pid: Schema.Number,
})
export type LldbAttachRequest = typeof LldbAttachRequestSchema.Type

export const LldbBacktraceRequestSchema = Schema.Struct({
  id: Schema.String,
  command: Schema.Literal("backtrace"),
  threadIndexId: OptionalNullableNumber,
  frameLimit: Schema.Number,
})
export type LldbBacktraceRequest = typeof LldbBacktraceRequestSchema.Type

export const LldbVarsRequestSchema = Schema.Struct({
  id: Schema.String,
  command: Schema.Literal("vars"),
  threadIndexId: OptionalNullableNumber,
  frameIndex: OptionalNullableNumber,
})
export type LldbVarsRequest = typeof LldbVarsRequestSchema.Type

export const LldbEvalRequestSchema = Schema.Struct({
  id: Schema.String,
  command: Schema.Literal("eval"),
  expression: Schema.String,
  threadIndexId: OptionalNullableNumber,
  frameIndex: OptionalNullableNumber,
  timeoutMs: Schema.Number,
})
export type LldbEvalRequest = typeof LldbEvalRequestSchema.Type

export const LldbContinueRequestSchema = Schema.Struct({
  id: Schema.String,
  command: Schema.Literal("continue"),
})
export type LldbContinueRequest = typeof LldbContinueRequestSchema.Type

export const LldbDetachRequestSchema = Schema.Struct({
  id: Schema.String,
  command: Schema.Literal("detach"),
})
export type LldbDetachRequest = typeof LldbDetachRequestSchema.Type

export const LldbBreakpointSetFunctionRequestSchema = Schema.Struct({
  id: Schema.String,
  command: Schema.Literal("breakpoint-set"),
  locationKind: Schema.Literal("function"),
  functionName: Schema.String,
})
export type LldbBreakpointSetFunctionRequest = typeof LldbBreakpointSetFunctionRequestSchema.Type

export const LldbBreakpointSetFileLineRequestSchema = Schema.Struct({
  id: Schema.String,
  command: Schema.Literal("breakpoint-set"),
  locationKind: Schema.Literal("file-line"),
  file: Schema.String,
  line: Schema.Number,
})
export type LldbBreakpointSetFileLineRequest = typeof LldbBreakpointSetFileLineRequestSchema.Type

export const LldbBreakpointSetRequestSchema = Schema.Union(
  LldbBreakpointSetFunctionRequestSchema,
  LldbBreakpointSetFileLineRequestSchema,
)
export type LldbBreakpointSetRequest = typeof LldbBreakpointSetRequestSchema.Type

export const LldbBreakpointClearRequestSchema = Schema.Struct({
  id: Schema.String,
  command: Schema.Literal("breakpoint-clear"),
  breakpointId: Schema.Number,
})
export type LldbBreakpointClearRequest = typeof LldbBreakpointClearRequestSchema.Type

export const LldbShutdownRequestSchema = Schema.Struct({
  id: Schema.String,
  command: Schema.Literal("shutdown"),
})
export type LldbShutdownRequest = typeof LldbShutdownRequestSchema.Type

export const LldbBridgeRequestSchema = Schema.Union(
  LldbHandshakeRequestSchema,
  LldbAttachRequestSchema,
  LldbBacktraceRequestSchema,
  LldbVarsRequestSchema,
  LldbEvalRequestSchema,
  LldbContinueRequestSchema,
  LldbDetachRequestSchema,
  LldbBreakpointSetRequestSchema,
  LldbBreakpointClearRequestSchema,
  LldbShutdownRequestSchema,
)
export type LldbBridgeRequest = typeof LldbBridgeRequestSchema.Type

const LldbResponseBase = {
  kind: Schema.Literal("response"),
  id: NullableString,
  ok: Schema.Literal(true),
}

export const LldbHandshakeResponseSchema = Schema.Struct({
  ...LldbResponseBase,
  command: Schema.Literal("handshake"),
  bridgePid: Schema.Number,
  pythonExecutable: Schema.String,
  lldbPythonPath: Schema.String,
  lldbVersion: Schema.String,
})

export const LldbAttachResponseSchema = Schema.Struct({
  ...LldbResponseBase,
  command: Schema.Literal("attach"),
  process: LldbProcessSchema,
})

export const LldbBacktraceResponseSchema = Schema.Struct({
  ...LldbResponseBase,
  command: Schema.Literal("backtrace"),
  process: LldbProcessSchema,
  thread: LldbThreadSchema,
})

export const LldbVarsResponseSchema = Schema.Struct({
  ...LldbResponseBase,
  command: Schema.Literal("vars"),
  process: LldbProcessSchema,
  frame: LldbFrameSchema,
  variables: Schema.Array(LldbValueSchema),
})

export const LldbEvalResponseSchema = Schema.Struct({
  ...LldbResponseBase,
  command: Schema.Literal("eval"),
  process: LldbProcessSchema,
  frame: LldbFrameSchema,
  expression: Schema.String,
  result: LldbValueSchema,
  options: LldbEvalOptionsSchema,
})

export const LldbContinueResponseSchema = Schema.Struct({
  ...LldbResponseBase,
  command: Schema.Literal("continue"),
  process: LldbProcessSchema,
})

export const LldbDetachResponseSchema = Schema.Struct({
  ...LldbResponseBase,
  command: Schema.Literal("detach"),
  pid: Schema.Number,
  state: Schema.String,
})

export const LldbBreakpointSetResponseSchema = Schema.Struct({
  ...LldbResponseBase,
  command: Schema.Literal("breakpoint-set"),
  process: LldbProcessSchema,
  breakpoint: LldbBreakpointSchema,
})

export const LldbBreakpointClearResponseSchema = Schema.Struct({
  ...LldbResponseBase,
  command: Schema.Literal("breakpoint-clear"),
  process: LldbProcessSchema,
  breakpointId: Schema.Number,
  cleared: Schema.Boolean,
})

export const LldbShutdownResponseSchema = Schema.Struct({
  ...LldbResponseBase,
  command: Schema.Literal("shutdown"),
  state: Schema.Literal("shutting-down"),
})

export const LldbErrorResponseSchema = Schema.Struct({
  kind: Schema.Literal("response"),
  id: NullableString,
  command: LldbBridgeCommandSchema,
  ok: Schema.Literal(false),
  error: Schema.String,
})

export const LldbBridgeResponseFrameSchema = Schema.Union(
  LldbHandshakeResponseSchema,
  LldbAttachResponseSchema,
  LldbBacktraceResponseSchema,
  LldbVarsResponseSchema,
  LldbEvalResponseSchema,
  LldbContinueResponseSchema,
  LldbDetachResponseSchema,
  LldbBreakpointSetResponseSchema,
  LldbBreakpointClearResponseSchema,
  LldbShutdownResponseSchema,
  LldbErrorResponseSchema,
)
export type LldbBridgeResponseFrame = typeof LldbBridgeResponseFrameSchema.Type

export const LldbBridgeFrameSchema = Schema.Union(LldbBridgeReadyFrameSchema, LldbBridgeResponseFrameSchema)
export type LldbBridgeFrame = typeof LldbBridgeFrameSchema.Type

const decodeLldbBridgeRequestSync = Schema.decodeUnknownSync(LldbBridgeRequestSchema)
const decodeLldbBridgeFrameSync = Schema.decodeUnknownSync(LldbBridgeFrameSchema)

const decodeWithLabel = <T>(label: string, decode: (value: unknown) => T, value: unknown): T => {
  try {
    return decode(value)
  } catch (error) {
    throw new Error(`Invalid ${label}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

export const decodeLldbBridgeRequest = (value: unknown): LldbBridgeRequest =>
  decodeWithLabel("LLDB bridge request", decodeLldbBridgeRequestSync, value)

export const decodeLldbBridgeFrame = (value: unknown): LldbBridgeFrame =>
  decodeWithLabel("LLDB bridge frame", decodeLldbBridgeFrameSync, value)

export const decodeLldbBridgeFrameLine = (line: string): LldbBridgeFrame =>
  decodeLldbBridgeFrame(JSON.parse(line) as unknown)

export const encodeLldbBridgeRequestLine = (value: LldbBridgeRequest): string =>
  `${JSON.stringify(decodeLldbBridgeRequest(value))}\n`
