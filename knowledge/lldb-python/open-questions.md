# LLDB Python bridge open questions

## Observed gaps still not settled by the sources

- The official docs show both supported host models — importing the `lldb` Python module directly and extending the `lldb` CLI with Python — but they do not settle which model is more reliable inside Probe's macOS/Xcode runtime. [`D12`, `D14`, `D16`]
- The sources document attach-by-name, wait-for, restart handling, and new-target-created events, but they do not answer how these behave for Probe's exact iOS attach path across Simulator vs real-device sessions. [`D3`, `D17`, `S4`, `S6`]
- The sources expose expression-safety knobs, but they do not prescribe the right default policy for an agent-first debugger bridge that should be useful without surprising side effects. [`D11`]
- `SBProcess` exposes structured-data events, but the official docs used here do not describe when Apple/iOS debugging flows actually emit them for Probe-relevant scenarios. [`D4`, `D10`]

## Risks for later Probe work

- **Python environment mismatch risk:** Xcode's LLDB can fail in subtle ways if Probe launches it under the wrong Python distribution on macOS. [`D16`]
- **Init-file nondeterminism risk:** user or repo `.lldbinit` behavior can alter command availability, settings, and session startup unless Probe opts out or fully owns initialization. [`D2`, `S6`]
- **Restart/reattach ambiguity risk:** long-lived sessions can observe exit events that should not be interpreted as terminal shutdown during restart flows. [`S4`]
- **Thread/frame identity risk:** per-stop thread indexes and frame indexes are not durable enough to use as long-lived IDs without extra scoping. [`D4`, `D5`, `D6`]
- **Expression-side-effect risk:** enabling the wrong expression options can resume extra threads, ignore breakpoints, or hide exceptions in ways that are hard for agents to reason about. [`D11`]
- **Coexistence risk:** this pack does not yet validate LLDB coexistence with Probe's runner and `xctrace` plans in the same app/device session. [`L1`]

## Recommended follow-up questions

1. Which bridge host should Probe standardize on first: Python-imported LLDB module or `lldb` subprocess with imported script?
2. Should Probe disable all init files by default and offer an explicit opt-in override?
3. What exact JSON envelope should Probe emit for stop-state snapshots, thread inventory, frame lists, and evaluation results?
4. What `SBExpressionOptions` defaults are acceptable for `eval`, `variables`, and breakpoint-condition style requests?
5. What event subset is mandatory for MVP: process lifecycle only, or also modules, thread exits, stdout/stderr, and diagnostics?
6. Can LLDB, the XCUITest runner, and `xctrace` coexist on the same target without destabilizing attach/debug state?

## Suggested validation order

1. Environment bootstrap + import/launch proof on the intended Xcode toolchain.
2. Minimal attach + event loop proof with typed JSONL events.
3. Variable/frame inspection proof using `SBProcess` / `SBThread` / `SBFrame` only.
4. Expression-evaluation safety matrix.
5. Restart/coexistence spike with other Probe session planes.
