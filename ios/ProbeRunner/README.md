# ProbeRunner attach/control spike

`ios/ProbeRunner/` now holds the smallest honest XCUITest spike for Probe's attach-without-relaunch promise.

## What is here

- `AttachControlSpikeUITests.swift`
  - attaches with `XCUIApplication(bundleIdentifier:)`
  - captures an accessibility snapshot with `snapshot()`
  - captures a screenshot with `screenshot()`
  - types and taps against the pre-launched fixture app
  - backgrounds the app, calls `activate()`, and verifies state survives
  - runs a lifecycle spike that waits in a command loop, handles multiple external requests, and exits on an explicit shutdown command
  - runs a transport-boundary spike that emits structured JSON frames to stdout and probes whether stdin reaches the UI test process through `xcodebuild`
  - runs a large-AX-tree spike that benchmarks medium and large generated fixture profiles and writes raw/pruned/collapsed/interactive-only snapshot artifacts
- `Info.plist`
  - bundle metadata for the UI test target
- `scripts/validate-attach-control.sh`
  - boots a concrete simulator
  - builds the app + UI test bundle with `build-for-testing`
  - installs + pre-launches `dev.probe.fixture`
  - runs the spike with `test-without-building`
- `scripts/validate-lifecycle.sh`
  - boots a concrete simulator
  - builds the app + UI test bundle with `build-for-testing`
  - installs + pre-launches `dev.probe.fixture`
  - starts the lifecycle spike with `test-without-building`
  - writes a simulator-scoped bootstrap manifest and drives the runner through a file-backed command mailbox to measure startup, steady-state request handling, and shutdown
- `scripts/validate-transport-boundary.sh`
  - boots a concrete simulator
  - builds the app + UI test bundle with `build-for-testing`
  - installs + pre-launches `dev.probe.fixture`
  - starts the transport-boundary spike with `test-without-building`
  - captures structured stdout frames from the mixed `xcodebuild` log stream
  - measures stdout-observed response timing against diagnostic file-response mirrors while keeping stdout as the canonical host egress
- `scripts/validate-large-ax-tree.sh`
  - boots a concrete simulator
  - builds the app + UI test bundle with `build-for-testing`
  - installs + pre-launches `dev.probe.fixture`
  - switches the fixture between generated `Medium` and `Large` snapshot profiles
  - captures raw `dictionaryRepresentation` output plus full / pruned / collapsed / interactive-only Probe-candidate views
  - writes a durable summary JSON and keeps per-profile snapshot artifacts in the control directory
- `scripts/validate-real-device-signing-and-devicectl.sh`
  - validates the host-side real-device preflight boundary without pretending a missing device or missing signing config is success
  - attempts a signed `build-for-testing` iPhoneOS build to expose real signing blockers explicitly
  - attempts an unsigned `build-for-testing` iPhoneOS build to prove whether the runner compiles for device architecture at all
  - captures `devicectl` help and JSON output for the essential Probe-facing commands
  - writes a durable summary to `knowledge/devicectl-device-signing/host-validation-results.json`
- `scripts/run-transport-boundary-session.py`
  - wraps `xcodebuild` so the harness can stream stdout, persist parsed JSON frames, and attempt a stdin probe without pretending stdin is proven

## Validation contract

This spike is intentionally narrow. It validates:

1. attach to an already-running Simulator app by bundle identifier
2. accessibility snapshot capture without calling `launch()`
3. tap + type actions without calling `launch()`
4. background → `activate()` lifecycle behavior without a clean relaunch

The lifecycle spike validates:

1. one long-lived XCUITest method can stay alive across multiple external requests on Simulator
2. the attached `XCUIApplication` handle stays usable after idle gaps and repeated commands
3. the runner can exit cleanly on an explicit shutdown request

It does **not** yet validate:

- long-lived command-server lifecycle on real devices
- host ↔ runner transport on real devices
- complete real-device signing and runtime behavior
- interaction while the target remains backgrounded

The current closure result for Simulator is:

- bootstrap/config via `/tmp/probe-runner-bootstrap/<SIMULATOR_UDID>.json`
- file-backed command ingress
- structured stdout JSONL egress parsed from the mixed `xcodebuild` log stream
- local runtime waits on stdout `ready` / `response` frames; `ready.json` and `response-*.json` remain only as validation mirrors for the spike scripts

It still does **not** prove:

- host → runner stdin delivery through `xcodebuild`
- a clean pure-JSON stdout channel without XCTest / `xcodebuild` noise around it
- a clean real-device equivalent for the shared file-ingress seam

## Run it

```bash
./ios/ProbeRunner/scripts/validate-attach-control.sh
```

Optional overrides:

- `PROBE_FIXTURE_SIMULATOR_UDID=<udid>`
- `PROBE_RUNNER_DERIVED_DATA_PATH=<path>`
- `PROBE_RUNNER_RESULT_BUNDLE_PATH=<path>`

The script prints `PROBE_METRIC ...` lines from the test so the attach/action timings are visible in CLI output.

Run the lifecycle spike with:

```bash
./ios/ProbeRunner/scripts/validate-lifecycle.sh
```

This script writes a summary JSON file to `<control-dir>/summary.json` and prints the chosen control directory before launch.

Run the transport-boundary spike with:

```bash
./ios/ProbeRunner/scripts/validate-transport-boundary.sh
```

This script writes a durable summary to `knowledge/xcuitest-runner/transport-boundary-spike-results.json`.

Run the large-AX-tree spike with:

```bash
./ios/ProbeRunner/scripts/validate-large-ax-tree.sh
```

Optional overrides:

- `PROBE_AX_TREE_DERIVED_DATA_PATH=<path>`
- `PROBE_AX_TREE_RESULT_BUNDLE_PATH=<path>`
- `PROBE_AX_TREE_CONTROL_DIR=<path>`
- `PROBE_AX_TREE_LOG_PATH=<path>`
- `PROBE_AX_TREE_SUMMARY_PATH=<path>`

The script keeps raw and transformed snapshot JSON artifacts under the chosen control directory and can copy the summary to `knowledge/xcuitest-runner/large-ax-tree-performance-spike-results.json`.

Run the real-device signing and `devicectl` spike with:

```bash
./ios/ProbeRunner/scripts/validate-real-device-signing-and-devicectl.sh
```

Optional overrides:

- `PROBE_REAL_DEVICE_SPIKE_ROOT=<path>`
- `PROBE_REAL_DEVICE_SUMMARY_PATH=<path>`
- `PROBE_REAL_DEVICE_IDENTIFIER=<device-id>`
- `PROBE_REAL_DEVICE_VALIDATE_INSTALL_AND_LAUNCH=1`

The script always emits an explicit overall outcome (`viable`, `partial`, or `blocked`). If no device is connected or no signing team is configured, it records that as a hard wall instead of pretending the real-device path passed.

## Empirical Simulator result

Observed on 2026-04-09 with Xcode 26.3 against an iPhone 17 Pro Simulator session:

- attach latency to the pre-launched fixture UI: ~1120 ms
- accessibility snapshot latency: ~48 ms
- screenshot capture succeeded (`164583` PNG bytes)
- repeated type + tap flow reliability in one run: `3 / 3`
- background → `activate()` latency: ~231 ms
- fixture pid stayed alive across the test run, which is consistent with attach/control without a clean relaunch

Current constraints from the spike:

- the pure attach path assumes the fixture is already launched before the test begins
- backgrounding the app requires `activate()` before continuing interaction
- direct interaction while the app remains backgrounded was not validated here
- real-device behavior is still unverified and should remain an explicit open question

## Empirical Simulator result: lifecycle spike

Observed on 2026-04-10 with Xcode 26.3 against the same iPhone 17 Pro Simulator session:

- runner ready/startup after `xcodebuild test-without-building`: ~5886 ms
- runner-side attach before ready: ~1104 ms
- command RTTs across one long-lived test method:
  - `ping`: ~1319 ms
  - `applyInput`: ~9580 ms
  - `snapshot`: ~319 ms
  - `ping` after another idle gap: ~1253 ms
- shutdown RTT: ~225 ms
- teardown to `xcodebuild` exit after shutdown: ~538 ms
- fixture pid stayed alive after the lifecycle spike

Important transport note from the same run:

- the runner instead resolved its control directory from a bootstrap manifest at `/tmp/probe-runner-bootstrap/<SIMULATOR_UDID>.json`, which is the current honest Simulator config seam

## Empirical Simulator result: transport-boundary spike

Observed on 2026-04-10 with `./ios/ProbeRunner/scripts/validate-transport-boundary.sh`:

- the runner emitted structured JSON frames that were visible in the host-side `xcodebuild` log stream
- the runner reported `bootstrapSource: simulator-bootstrap-manifest` and used a session-specific control directory under `/tmp/probe-runner-runtime-control.*`
- the stdout `ready` frame reached the host-observed parser at `03:11:56.380Z`; the file-backed `ready.json` was observed `195 ms` later by the polling harness
- the stdin probe timed out, so a JSON line written to `xcodebuild` stdin still did **not** reach the UI test process in this path
- command RTTs across the same session were close between the two observation paths:
  - file-backed response RTT avg: `856.6 ms`
  - stdout-observed response RTT avg: `983.0 ms`
  - stdout minus file avg: `126.4 ms`
- per-command stdout minus file deltas stayed within `122–134 ms` across `ping`, `snapshot`, and `shutdown`

Important caveat from the same run:

- the stdout channel is usable only as a **mixed log stream** right now, and the file-ingress seam remains Simulator-specific until a real-device equivalent is proven

## Empirical Simulator result: large AX tree spike

Observed on 2026-04-10 with `./ios/ProbeRunner/scripts/validate-large-ax-tree.sh` against the generated `Medium` and `Large` fixture profiles on Simulator. This is simulator-only, fixture-based evidence:

- raw medium snapshot: `157 ms`, `533200` pretty JSON bytes, `7266` lines
- raw large snapshot: `447 ms`, `1788816` pretty JSON bytes, `23226` lines
- medium reductions versus raw output:
  - pruned: `331147` bytes (`-37.9%`)
  - collapsed: `93239` bytes (`-82.5%`)
  - interactive-only: `39188` bytes (`-92.7%`)
- large reductions versus raw output:
  - pruned: `1159961` bytes (`-35.2%`)
  - collapsed: `322036` bytes (`-82.0%`)
  - interactive-only: `137848` bytes (`-92.3%`)
- the JSON artifact's `nodeCount` fields count serialized representation objects/entries, not a canonical count of unique accessibility elements

Current implication from the spike:

- raw and even fully-pruned tree output is too large to treat as an inline default for realistic complex screens
- hierarchy collapse is strong enough for a default summary view on large screens, but still too large for the existing generic `4 KB / 100 lines` inline policy
- interactive-only is the cheapest viable escalation path when the caller needs actionability before full structural fidelity
- any numeric inline cap from this run is heuristic; against the current `24 KB / 700 lines` budget the fixture data supports about `50` interactive entries and about `55` collapsed entries, not a looser `~80` collapsed cap
