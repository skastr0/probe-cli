# LLDB Python bridge API notes

Scope: APIs Probe is most likely to rely on for a structured LLDB bridge.

## Observed facts

### `SBDebugger`

- `SBDebugger.Initialize()` should be called before other LLDB API usage in standalone scripts; the documented standalone flow is `Initialize() -> Create() -> work -> Destroy(debugger) -> Terminate()`. [`D14`, `D2`]
- `SBDebugger.Create()` can source init files, and the API also exposes `SkipLLDBInitFiles` / `SkipAppInitFiles` to suppress them. [`D2`, `S6`]
- `SBDebugger.SetAsync(False)` makes launch/step/continue calls block until the process stops; the standalone docs explicitly say that async mode requires the client to handle process events itself. [`D14`, `D2`, `S2`]
- `SBDebugger` exposes a listener (`GetListener()`), a broadcaster (`GetBroadcaster()`), warning/error/progress broadcast bits, and `GetSetting()` / `GetBuildConfiguration()` helpers that return `SBStructuredData`. [`D2`]

### `SBTarget`

- `SBTarget.AttachToProcessWithID` and `SBTarget.AttachToProcessWithName` accept an optional `SBListener`; if the listener is invalid, the debugger's listener receives process events instead. [`D3`]
- `AttachToProcessWithName(..., wait_for=True, ...)` is a first-class attach mode in the SB API. [`D3`]
- `SBTarget` broadcasts breakpoint, module, symbol, watchpoint, and new-target-created events. [`D3`]
- `SBTarget` has a globally unique ID (`GetGloballyUniqueID()`), which upstream `lldb-dap` uses to reconnect new sessions to an already-existing target. [`D3`, `S6`]

### `SBProcess`

- `SBProcess` broadcasts state-changed, stdout, stderr, interrupt, profile-data, and structured-data events. [`D4`]
- `SBProcess` exposes static helpers such as `EventIsProcessEvent`, `GetStateFromEvent`, `GetProcessFromEvent`, `GetRestartedFromEvent`, and `GetStructuredDataFromEvent`. [`D4`]
- `GetThreadAtIndex()` returns the thread at the current stop, and the docs say this index is only valid for the current stop; for persistent identity, clients should use thread ID or index ID. [`D4`]
- `GetStopID()` increases when the process executes; expression stops can optionally be counted via `include_expression_stops=True`. [`D4`]
- `GetStopEventForStopID()` is documented as not fully implemented and only tracks the stop event for the last natural stop ID. [`D4`]
- `Destroy()` kills the process and shuts down monitoring threads; `Kill()` is documented as equivalent. [`D4`]

### `SBThread`

- `SBThread` exposes both a system-style thread ID (`GetThreadID`) and a monotonically increasing index ID (`GetIndexID`). The docs say the index ID is not reused during the process lifetime. [`D5`]
- `SBThread` exposes stop-reason APIs (`GetStopReason`, `GetStopDescription`, `GetStopReasonDataAtIndex`, `GetStopReasonDataCount`) plus extended backtrace helpers. [`D5`]
- `GetStopReasonExtendedInfoAsJSON()` emits stop-reason extended information as JSON, but the docs say this is currently used only for instrumentation plug-ins. [`D5`]
- `SafeToCallFunctions()` exists specifically so clients can check whether inferior function calls are safe at the current stop. [`D5`]
- The `Suspend()` documentation explicitly says LLDB currently supports process-centric debugging, not thread-centric debugging. [`D5`]

### `SBFrame`

- `SBFrame` exposes direct variable lookup (`FindVariable`, `FindValue`, `GetVariables`, `GetValueForVariablePath`) as well as expression evaluation (`EvaluateExpression`). [`D6`]
- The docs distinguish `GetValueForVariablePath()` from `EvaluateExpression()`: variable-path results continue to track the current value as execution progresses in the current frame, while expression results are constant copies at evaluation time. [`D6`]
- `GetFunctionName()` is explicitly documented as the right API when inlined frames are possible; `SBFunction`/`SBSymbol` alone are not enough. [`D6`]
- `SBFrame` can report artificial, hidden, synthetic, and inlined frames. [`D6`]

### `SBExpressionOptions`

- Expression evaluation has explicit controls for timeout, one-thread timeout, stop-other-threads, try-all-threads, trap-exceptions, unwind-on-error, ignore-breakpoints, suppress-persistent-result, and allow-JIT. [`D11`]
- The docs warn not to set `SetTrapExceptions(False)` unless the called function traps its own exceptions. [`D11`]
- If `TryAllThreads` is enabled and the expression does not complete within the timeout, LLDB may resume all threads for the same timeout window. [`D11`]

### `SBCommandInterpreter` and `SBCommandReturnObject`

- `SBCommandInterpreter.HandleCommand()` accepts a command string plus `SBCommandReturnObject`, and an overload also accepts `SBExecutionContext`. [`D7`]
- `ResolveCommand()` expands aliases and abbreviations without executing the command. [`D7`]
- `GetTranscript()` returns structured command transcript entries, but only if `interpreter.save-transcript` is enabled. [`D7`]
- `InterruptCommand()` and `WasInterrupted()` exist for long-running command execution. [`D7`]
- `SBCommandReturnObject` captures output, error, status, values, and structured error data; it is also file-like (`write`, `flush`). [`D8`, `D12`]

### `SBListener`, `SBEvent`, `SBStructuredData`

- `SBListener` supports blocking waits, broadcaster-specific waits, type-filtered waits, and start/stop listening APIs. [`D9`]
- `SBEvent` examples in the docs show a dedicated listener thread waiting for process state changes while the main thread continues/kills the process. [`D18`]
- `SBStructuredData` supports dictionary/array traversal and JSON import/export. [`D10`]

## Inference for Probe

- Prefer `SB*` APIs as the primary data plane and build Probe's JSON from those objects; use command-interpreter text only as a fallback path for LLDB capabilities that lack good SB coverage. [`D4`, `D6`, `D7`, `D13`]
- Use stable thread identifiers (`GetThreadID()` or `GetIndexID()`) instead of per-stop ordinal indexes. Treat frame references as stop-scoped, because frame position and contents can change between stops. [`D4`, `D5`, `D6`]
- Put explicit `SBExpressionOptions` defaults behind Probe commands rather than relying on LLDB defaults; timeouts, exception trapping, and thread-resume behavior are too important to leave implicit. [`D11`]
- Where LLDB already returns `SBStructuredData`, preserve that structure instead of converting through lossy strings. [`D2`, `D4`, `D8`, `D10`]
