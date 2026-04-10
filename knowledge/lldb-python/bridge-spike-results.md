# LLDB Python bridge spike results

Date: 2026-04-10

Evidence artifact: `knowledge/lldb-python/bridge-spike-results.json`

## Scope

This spike validated a minimal long-lived Python LLDB bridge that accepts JSON commands on stdin and emits JSON responses on stdout.

The live target in this run was a small signed macOS C fixture (`src/spikes/lldb-python-bridge/target.c`), not the iOS Simulator fixture app. That kept the proof honest while avoiding any claim that the iOS attach path is already settled.

## What worked

- **Bridge bootstrap**
  - The bridge resolved LLDB's Python module path dynamically and ran under Xcode's Python executable.
  - Ready frame evidence in `bridge-spike-results.json` shows:
    - `pythonExecutable: /Applications/Xcode.app/Contents/Developer/usr/bin/python3`
    - `lldbPythonPath: /Applications/Xcode.app/Contents/SharedFrameworks/LLDB.framework/Resources/Python`
    - `asyncMode: false`
- **Attach**
  - `attach` stopped the live target and returned structured process/thread/frame data.
  - The first successful attach captured `probe_bridge_leaf_wait -> probe_bridge_middle_frame -> main` in the backtrace.
- **Backtrace**
  - `backtrace` returned structured frames without CLI scraping.
  - Evidence: `backtraceFunctions` contains `probe_bridge_leaf_wait`, `probe_bridge_middle_frame`, and `main`.
- **Variable inspection**
  - `vars` returned locals and globals from the selected frame.
  - Evidence includes `counter = 7`, `derived = 21`, `label = "probe-lldb-target"`, `probe_last_signal = 0`, `probe_keep_running = 1`.
- **Expression evaluation**
  - `eval` returned a structured result for `counter + derived`.
  - Evidence: `evalValue = 28`.
- **Long-lived bridge reuse**
  - The same bridge process stayed alive across handshake, attach, backtrace, vars, eval, continue, signal stop, crash stop, exit, reattach, second backtrace, and detach.
  - Evidence artifact shows the same `bridgePid` across all commands.

## Crash, restart, signal, and session behavior

- **Initial attach stop**
  - LLDB attach stopped the process with `SIGSTOP` before inspection.
  - This is visible in the first attach response: `stopDescription: signal SIGSTOP`.
- **Signal handling**
  - After `continue`, sending `SIGUSR1` caused LLDB to stop the process again with `signal SIGUSR1`.
  - The bridge remained usable after that stop.
  - Current implication: signals surface as explicit debugger stops by default; Probe should not assume user signals pass through silently.
- **Crash handling**
  - After another `continue`, sending `SIGABRT` produced a stopped state with `signal SIGABRT`.
  - A subsequent `continue` transitioned the process to `state: exited`.
  - Current implication: a fatal signal is a two-step observation in this synchronous bridge shape — first a stop on the fatal signal, then an exited state after the next continue.
- **Restart / reattach**
  - After the first target exited, the same bridge attached successfully to a newly launched target PID and produced a fresh backtrace.
  - Current implication: bridge reuse across sequential target lifetimes is viable, but it is a reattach flow, not automatic process resurrection.
- **Long-lived sessions**
  - This spike proves one long-lived bridge process can survive repeated request/response cycles and sequential reattachment.
  - It does **not** yet prove unsolicited event streaming, concurrent sessions, or iOS-specific coexistence with the runner and `xctrace`.

## Hard walls and caveats

- **Unsigned or hardened targets are a real attach wall on macOS.**
  - Before signing the fixture binary with `com.apple.security.get-task-allow`, attach attempts failed with:
    - `this is a non-interactive debug session, cannot get permission to debug processes`
  - The spike only became attachable after ad-hoc signing the debuggee with the entitlement plist in `src/spikes/lldb-python-bridge/debuggee-entitlements.plist`.
- **`xcrun python3` alone was not enough on this host.**
  - Importing `lldb` required LLDB's Python path from `lldb -P`.
  - The bridge now resolves that path explicitly at startup.
- **This is not yet an iOS attach proof.**
  - The validated target was a local macOS process. Simulator and device attach behavior remain separate follow-up work.
- **This bridge is synchronous.**
  - `SetAsync(False)` keeps the spike simple, but it means `continue` blocks until the process stops or exits.
  - A richer Probe bridge will likely need an event thread for long-lived session telemetry.

## Architectural implication

The structured LLDB bridge shape is viable for Probe, but the validated contract is currently:

- one long-lived Python bridge process
- explicit JSON request/response frames
- direct `SB*` data extraction for attach/backtrace/vars/eval
- synchronous stop-driven control
- explicit host/environment guardrails around LLDB Python bootstrap and macOS attach permissions

Probe should treat debugger attachability as a reported capability, not an assumption. The next debugger slice should preserve this JSON boundary while adding capability/error reporting for entitlement failures and later validating the iOS Simulator / device attach path separately.
