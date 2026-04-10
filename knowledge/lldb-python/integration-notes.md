# LLDB Python bridge integration notes

Scope: structured bridging patterns and long-lived session caveats relevant to Probe's debugger bridge.

## Probe framing from local docs

- Probe's architecture expects a persistent LLDB Python bridge in the bridge plane, with typed JSONL envelopes, one app/device per session, artifact-first output, and explicit capability reporting. [`L1`]

## Observed facts

### Structured command and scripting patterns

- LLDB custom commands can be implemented as Python functions, Python classes, or `lldb.ParsedCommand` subclasses. Parsed commands get typed options/arguments and completion support; raw commands receive the unparsed trailing string. [`D12`, `S1`]
- The current recommended callback shape includes `SBExecutionContext` (`debugger, command|args_array, exe_ctx, result, ...`). The older callback form without `exe_ctx` is explicitly documented as strongly discouraged because it only works against the currently selected target/process/thread/frame and can behave incorrectly in stop-hooks, breakpoint callbacks, and similar contexts. [`D12`]
- `SBCommandReturnObject` and `SBStream` can be treated as file-like objects, so Python command code can `print(..., file=result)` rather than writing directly to stdout. [`D12`, `D8`]
- The script-driven debugging tutorial demonstrates using `SBFrame.FindVariable`, `SBValue.GetChildMemberWithName`, `SBValue.GetSummary`, and process/thread APIs directly from Python, instead of scraping the CLI. [`D13`, `S3`]

### Standalone / embedded execution models

- The standalone scripting guide says LLDB's Python module path can be discovered with `lldb -P`, and on macOS the Python module comes from `LLDB.framework`. [`D14`]
- The documented standalone flow explicitly creates the debugger in Python, sets async mode, creates a target, and uses `SBProcess` / `SBThread` / `SBFrame` objects directly. [`D14`, `S2`]
- The docs also make clear that synchronous mode (`SetAsync(False)`) is the simplification path; if you do not use it, you must handle process events yourself. [`D14`, `D2`]

### Python environment caveats on macOS/Xcode

- LLDB must be used with a matching Python version and distribution; the caveats doc says mixing an LLDB built against one Python distribution with another interpreter distribution is unsupported. [`D16`]
- For Xcode/macOS specifically, the official guidance is to use `xcrun python3` / `xcrun pip3` or `/usr/bin/python3` / `/usr/bin/pip3` so the interpreter matches the LLDB bundle shipping with Xcode. [`D16`]

### Long-lived structured-session patterns from `lldb-dap`

- `lldb-dap` is the official LLDB structured protocol surface for IDEs and editors; it is explicitly described as a command-line tool implementing the Debug Adapter Protocol. [`D17`, `S6`]
- The `lldb-dap` docs expose a debug-console split between variable/expression evaluation and command evaluation, with an escape prefix to force command mode. [`D17`]
- `lldb-dap` also exposes a server mode that reuses a background adapter process between sessions to cache symbols and improve startup performance. [`D17`]
- `EventHelper.cpp` runs a dedicated event thread, takes the debugger listener, blocks in `listener.WaitForEvent(UINT32_MAX, event)`, and dispatches process, target, breakpoint, thread, and diagnostic events into structured protocol events. [`S4`]
- The same file translates LLDB state changes into explicit events like `process`, `stopped`, `continued`, `thread`, `module`, `memory`, `exited`, and `terminated`, and forwards stdout/stderr as separate output categories. [`S4`]
- `DAPSessionManager.cpp` shares an event thread per debugger instance and routes events back to the owning DAP session by target. [`S5`]
- `DAP.cpp` initializes debugger I/O using pipes, starts event threads, destroys the debugger at session end, and supports reconnecting to an existing debugger/target pair by IDs for multi-session target handoff. [`S6`, `S7`]
- `OutputRedirector.cpp` uses pipes plus a forwarding thread to transform LLDB stdout/stderr into callback-delivered output. [`S7`]

### Long-lived session caveats surfaced by the official sources

- `lldb-dap` contains explicit restart handling: an exit event for an old or invalid PID during restart should not automatically terminate the session. [`S4`]
- `SBProcess.GetStopEventForStopID()` is not a complete event-history mechanism. [`D4`]
- `SBThread.Suspend()` docs say LLDB is still process-centric, so per-thread control semantics have limitations. [`D5`]
- Init files can materially change debugger behavior unless they are explicitly skipped or controlled. [`D2`, `S6`]
- Python interpreter/distribution mismatch is a real operational risk on macOS/Xcode installations. [`D16`]

## Inference for Probe

### Recommended bridge shape

- Use a long-lived bridge process with explicit request/response/event envelopes, following the same broad pattern as `lldb-dap`: one event loop for LLDB state, separate request handling, and JSON-native translation at the bridge boundary. [`L1`, `D17`, `S4`, `S5`, `S6`]
- Prefer direct `SB*` access for durable data (`process`, `threads`, `frames`, `variables`, `module changes`, `stop reasons`) and reserve `SBCommandInterpreter` for configuration commands, init hooks, or SB API gaps. [`D6`, `D7`, `D12`, `D13`]
- Avoid relying on LLDB's selected thread/frame in bridge commands; always flow an explicit execution context or reconstruct it from stable IDs. [`D12`, `D4`, `D5`]

### Session ownership and lifecycle

- The low-coupling default for Probe is one debugger instance per Probe session, because Probe already models one app/device per session and LLDB's state is inherently sessionful. [`L1`, `D2`, `S6`]
- Reusing a debugger across sessions is possible, but upstream only adds the extra routing complexity because `lldb-dap` must support target handoff and child sessions. Probe should only copy that pattern if a concrete requirement appears. [`S5`, `S6`]
- Disable or explicitly control init-file sourcing so the Probe bridge is deterministic across hosts. [`D2`, `S6`]

### Data and ref strategy

- Treat process state as event-sourced: cache process state, stop ID, thread set, selected focus thread, and module events, then refresh frame/variable data per stop. [`S4`, `D4`, `D5`, `D6`]
- Thread refs can be stable for a process lifetime (`threadId` or `indexId`), but frame refs should be treated as stop-scoped and derived from `{stopId, threadRef, frameIndex}` rather than assumed durable forever. [`D4`, `D5`, `D6`]

### Expression and evaluation guardrails

- Put explicit safety defaults on expression evaluation: timeout, unwind-on-error, trap-exceptions, and a deliberate choice about whether breakpoints and other threads are allowed to run. [`D11`]
- Surface evaluation policy in Probe responses, because LLDB's expression options can materially affect side effects, latency, and thread behavior. [`D11`]

### Output handling

- Treat LLDB stdout/stderr as telemetry or artifacts, not as the canonical response format. Canonical responses should come from Probe-owned JSON built from SB objects. [`S4`, `S7`, `L1`]

## Suggested next validation spikes

1. Verify the chosen runtime model on the target Probe host: importing `lldb` from the Xcode-supplied Python environment vs driving `lldb` as a scripted subprocess. [`D14`, `D16`]
2. Validate attach/restart behavior for the target iOS debugging path and record which LLDB events actually fire across app relaunches. [`D3`, `D4`, `S4`]
3. Prototype a minimal event-thread bridge that emits JSONL `process-state`, `stop`, `continued`, and `thread-exited` events without parsing any LLDB CLI text. [`S4`, `S5`, `S6`]
