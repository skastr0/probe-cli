# LLDB Python bridge sources

Scope: reusable sources for Probe's LLDB Python bridge research pack.

## Local Probe context

- `L1` `ARCHITECTURE.md` — Probe expects a daemon-first, long-lived LLDB Python bridge with typed JSONL boundaries and explicit session ownership.
- `L2` `AGENTS.md` — Research must prefer official docs, reuse `knowledge/`, and document Apple/Xcode utility caveats rather than integrating from memory.
- `L3` `knowledge/README.md` — Knowledge packs should separate observed facts from inferred guidance.

## Official LLDB docs

- `D1` https://lldb.llvm.org/python_api.html — LLDB Python API index and class inventory.
- `D2` https://lldb.llvm.org/python_api/lldb.SBDebugger.html — debugger lifecycle, async mode, listener/broadcaster, settings, initialization/termination.
- `D3` https://lldb.llvm.org/python_api/lldb.SBTarget.html — target lifecycle, attach APIs, target events, breakpoint creation, target IDs.
- `D4` https://lldb.llvm.org/python_api/lldb.SBProcess.html — process lifecycle, event helpers, stop IDs, stdout/stderr, structured data events.
- `D5` https://lldb.llvm.org/python_api/lldb.SBThread.html — thread identity, stop reasons, stepping, safety checks, process-centric caveats.
- `D6` https://lldb.llvm.org/python_api/lldb.SBFrame.html — frame inspection, variable APIs, expression evaluation, inlined/artificial frame details.
- `D7` https://lldb.llvm.org/python_api/lldb.SBCommandInterpreter.html — command execution, transcripts, interruptibility, command resolution.
- `D8` https://lldb.llvm.org/python_api/lldb.SBCommandReturnObject.html — command result capture, output/error access, structured error data.
- `D9` https://lldb.llvm.org/python_api/lldb.SBListener.html — listener registration, event filtering, wait/peek APIs.
- `D10` https://lldb.llvm.org/python_api/lldb.SBStructuredData.html — structured data get/set/JSON conversion APIs.
- `D11` https://lldb.llvm.org/python_api/lldb.SBExpressionOptions.html — expression timeout, trap, unwind, stop-other-thread, JIT, breakpoint behavior.
- `D12` https://lldb.llvm.org/use/tutorials/writing-custom-commands.html — raw vs parsed commands, `SBExecutionContext`, command result handling.
- `D13` https://lldb.llvm.org/use/tutorials/script-driven-debugging.html — direct `SB*` manipulation from Python without parsing CLI output.
- `D14` https://lldb.llvm.org/use/tutorials/implementing-standalone-scripts.html — standalone `lldb` Python module setup, `lldb -P`, `Initialize/Create/Destroy/Terminate` flow.
- `D15` https://lldb.llvm.org/resources/sbapi.html — SB API stability and lifetime guarantees.
- `D16` https://lldb.llvm.org/resources/caveats.html — Python distribution/version caveats, especially on macOS/Xcode.
- `D17` https://lldb.llvm.org/use/lldbdap.html — official structured protocol guidance via `lldb-dap`.
- `D18` https://lldb.llvm.org/python_api/lldb.SBEvent.html — event examples and event metadata helpers.

## Official upstream source / primary implementations

- `S1` https://raw.githubusercontent.com/llvm/llvm-project/main/lldb/examples/python/cmdtemplate.py — parsed command example using `SBExecutionContext` and `SBCommandReturnObject`.
- `S2` https://raw.githubusercontent.com/llvm/llvm-project/main/lldb/examples/python/disasm.py — standalone LLDB scripting example using `SBDebugger`, `SBProcess`, `SBThread`, `SBFrame`.
- `S3` https://raw.githubusercontent.com/llvm/llvm-project/main/lldb/examples/scripting/tree_utils.py — direct `SBValue` traversal example used from script-driven debugging.
- `S4` https://raw.githubusercontent.com/llvm/llvm-project/main/lldb/tools/lldb-dap/EventHelper.cpp — event-thread and event-to-structured-message translation.
- `S5` https://raw.githubusercontent.com/llvm/llvm-project/main/lldb/tools/lldb-dap/DAPSessionManager.cpp — shared event-thread/session routing by debugger/target.
- `S6` https://raw.githubusercontent.com/llvm/llvm-project/main/lldb/tools/lldb-dap/DAP.cpp — debugger initialization, transport loop, session lifecycle, source-init handling.
- `S7` https://raw.githubusercontent.com/llvm/llvm-project/main/lldb/tools/lldb-dap/OutputRedirector.cpp — stdout/stderr piping into callback-driven structured output.

## Source quality notes

- `D*` entries are official LLDB documentation pages.
- `S*` entries are official LLVM upstream source files.
- Probe guidance in the other files distinguishes direct observations from conclusions drawn from combining these sources.
