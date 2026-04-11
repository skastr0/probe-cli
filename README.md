# Probe

Probe is a daemon-first, agent-first iOS runtime controller.

This repository now includes a real control-plane slice: a Bun + TypeScript + Effect daemon, a thin Unix-socket RPC client, artifact-aware session storage, simulator and device session flows built on the existing ProbeRunner/ProbeFixture artifacts, and a validation harness for exercising the product end to end.

## What exists today

- executable host-side control plane under `src/`
- single shared Effect `ManagedRuntime`
- daemon entrypoint at `probe serve`
- thin client commands for `session open`, `session health`, `session snapshot`, `session action`, `session screenshot`, `session video`, `session close`, `perf record`, and `drill`
- typed local RPC protocol over a Unix domain socket
- session registry with TTL cleanup and session artifact roots under `~/.probe/sessions/<session-id>/`
- simulator sessions in two modes: ProbeFixture `build-and-install` and arbitrary-app `attach-to-running`
- live real-device runner sessions for installed apps through explicit CoreDevice/DDI/signing preflight
- runner-backed screenshots and video capture on both simulator and device
- daemon-backed `perf record` for `time-profiler`, `system-trace`, `metal-system-trace`, `hangs`, and `swift-concurrency`
- tracked `.agents/` lifecycle folders outside `sdlc/`

## What does **not** exist yet

- daemon-owned persistent live device log capture
- simulator-app and real-device LLDB attach/eval inside Probe sessions
- broad Instruments coverage beyond the current bounded templates and extractors
- a final production runner transport beyond the current honest file-mailbox + mixed-stdout seam

Those surfaces still need the follow-on work items and research packs before the product expands beyond the initial vertical slice.

## Quickstart

```bash
bun install
bun run typecheck
bun run test
bun run probe -- doctor
bun run scripts/validate-product-flow.ts --target simulator
```

## Commands

### `bun run probe -- doctor`

Reports the current workspace scaffold, output-threshold defaults, reserved artifact root, and capability readiness.

### `bun run probe -- doctor --json`

Same as above, but JSON.

### `bun run probe -- serve`

Starts the long-lived daemon on the local Unix socket and keeps session state in one shared runtime.

### `bun run probe -- session open --json`

Opens a daemon-backed session.

- simulator + no `--bundle-id`: build/install the Probe fixture app and attach the runner
- simulator + `--bundle-id <id>`: attach to an already-running installed app
- device + `--bundle-id <id>`: verify real-device prerequisites, launch the installed app, and attach the runner

The transport seam is still the honest bootstrap-manifest + file-mailbox + mixed-stdout contract.

### `bun run probe -- session screenshot --session-id <id> --json`

Captures a runner-side PNG artifact for the active session. The same runner-backed screenshot path works on both simulator and device sessions.

### `bun run probe -- session video --session-id <id> --duration 5s --json`

Captures a runner-side video artifact for the active session. Probe stitches frame output into MP4 when `ffmpeg` is available and otherwise keeps the frame-sequence artifact.

### `bun run probe -- session health --session-id <id> --json`

Asks the daemon to ping the live runner and report the latest session health.

### `bun run probe -- drill --session-id <id> --artifact xcodebuild-session-log --lines 1:40`

Drills into a stored artifact without dumping the whole file inline.

### `bun run probe -- perf record --session-id <id> --template time-profiler --time-limit 3s --json`

Records one bounded Instruments trace through the daemon, stores the raw `.trace` plus TOC/schema exports under the session `traces/` directory, and returns a compact summary with artifact paths.

Current perf contract:

- supported templates: `time-profiler`, `system-trace`, `metal-system-trace`, `hangs`, `swift-concurrency`
- `system-trace` is intentionally narrower: max 10s recording, 2 MiB / 8k rows per table export budget because the supported summary is target-attributed scheduling only
- `metal-system-trace` now keeps the bounded `metal-gpu-intervals` summary path and exports extended driver/encoder tables when they are present and stay within budget
- `hangs` and `swift-concurrency` stay on the same honest contract: return row-proven summaries when the exported schemas are populated, fail closed when they are not
- Probe reports the post-record session state in the result so a trace can succeed without pretending the runner session stayed healthy; check `result.session.state` and `result.diagnoses` for `perf-session-*-after-record` warnings
- Export files are size-checked before parsing to prevent memory amplification (8 MiB cap); exceeding this fails with `perf-export-file-too-large`
- Network-on-Simulator, full reconstructed Time Profiler call stacks, and per-shader GPU attribution are still explicit walls

## Validation script

`scripts/validate-product-flow.ts` is the canonical local product check.

```bash
bun run scripts/validate-product-flow.ts --target simulator
bun run scripts/validate-product-flow.ts --target simulator --bundle-id com.example.notes
bun run scripts/validate-product-flow.ts --target device --bundle-id com.example.notes --device-id <device-id>
```

The script starts `probe serve`, opens a session, sends a ping, captures a snapshot, performs a UI action, records a 5-second Time Profiler trace, lists artifacts, closes the session, stops the daemon, and prints a timed pass/fail summary.

## Source layout

```text
src/
  cli/
    commands/
  domain/
  services/
  runtime.ts

ios/
  ProbeFixture/
  ProbeRunner/
```

The shape is still smaller than the full architecture sketch in `ARCHITECTURE.md`, but it now implements the control-plane seam instead of only reserving it.

## iOS scaffold note

The `ios/` tree now contains the real fixture/runner artifacts used by Probe's simulator self-test path and the shared runner control surface for live device sessions. The runner transport is still the current honest contract, not the final production contract.
