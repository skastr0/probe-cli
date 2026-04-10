# Probe

Probe is a daemon-first, agent-first iOS runtime controller.

This repository now includes the first real control-plane slice: a Bun + TypeScript + Effect daemon, a thin Unix-socket RPC client, artifact-aware session storage, and a fixture-backed simulator vertical slice built on the existing ProbeRunner/ProbeFixture artifacts.

## What exists today

- executable host-side control plane under `src/`
- single shared Effect `ManagedRuntime`
- daemon entrypoint at `probe serve`
- thin client commands for `session open`, `session health`, `session close`, and `drill`
- typed local RPC protocol over a Unix domain socket
- session registry with TTL cleanup and session artifact roots under `~/.probe/sessions/<session-id>/`
- real simulator vertical slice built on `ios/ProbeFixture/` and `ios/ProbeRunner/`
- daemon-backed `perf record` for `time-profiler`, `system-trace`, and `metal-system-trace`
- tracked `.agents/` lifecycle folders outside `sdlc/`

## What does **not** exist yet

- arbitrary target-app bundle ids beyond `dev.probe.fixture`
- real-device session control
- LLDB bridge
- broad Instruments coverage beyond the first bounded perf slice
- a final production runner transport beyond the current honest file-mailbox + mixed-stdout seam

Those surfaces still need the follow-on work items and research packs before the product expands beyond the initial vertical slice.

## Quickstart

```bash
bun install
bun run typecheck
bun run test
bun run probe -- doctor
```

## Commands

### `bun run probe -- doctor`

Reports the current workspace scaffold, output-threshold defaults, reserved artifact root, and capability readiness.

### `bun run probe -- doctor --json`

Same as above, but JSON.

### `bun run probe -- serve`

Starts the long-lived daemon on the local Unix socket and keeps session state in one shared runtime.

### `bun run probe -- session open --json`

Opens the first real simulator session through the daemon. The current vertical slice targets the fixture bundle id `dev.probe.fixture` and reuses the current ProbeRunner transport seam honestly.

### `bun run probe -- session health --session-id <id> --json`

Asks the daemon to ping the live runner and report the latest session health.

### `bun run probe -- drill --session-id <id> --artifact xcodebuild-session-log --lines 1:40`

Drills into a stored artifact without dumping the whole file inline.

### `bun run probe -- perf record --session-id <id> --template time-profiler --time-limit 3s --json`

Records one bounded Instruments trace through the daemon, stores the raw `.trace` plus TOC/schema exports under the session `traces/` directory, and returns a compact summary with artifact paths.

Current perf contract:

- supported templates: `time-profiler`, `system-trace`, `metal-system-trace`
- `system-trace` is intentionally narrower: max 10s recording, 2 MiB / 8k rows per table export budget because the supported summary is target-attributed scheduling only
- Probe reports the post-record session state in the result so a trace can succeed without pretending the runner session stayed healthy; check `result.session.state` and `result.diagnoses` for `perf-session-*-after-record` warnings
- Export files are size-checked before parsing to prevent memory amplification (8 MiB cap); exceeding this fails with `perf-export-file-too-large`
- Network-on-Simulator, full reconstructed Time Profiler call stacks, and per-shader GPU attribution are still explicit walls

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

The `ios/` tree now contains the real fixture/runner artifacts used by the simulator vertical slice. The runner transport is still the current honest contract, not the final production contract.
