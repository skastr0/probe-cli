# XCUITest runner transport contract

Updated: 2026-04-10

## Chosen contract Probe can ship now

Scope: **Simulator-only** `xcodebuild test-without-building` sessions.

- **Bootstrap/config seam:** a simulator-scoped manifest at `/tmp/probe-runner-bootstrap/<SIMULATOR_UDID>.json`
- **Host → runner ingress:** atomic JSON command files in a per-session control directory
- **Runner → host egress:** structured JSON frames parsed out of the mixed `xcodebuild` / XCTest stdout stream
- **Canonical host response path in the local runtime:** stdout `ready` / `response` frames
- **Diagnostic mirrors kept only for validation scripts:** `ready.json` and `response-*.json` files in the control directory

This is the cheapest honest contract because it uses only seams that are now proven at the real XCUITest boundary.

## Why this is the current choice

1. The real-boundary stdin probe still times out, so Probe cannot honestly claim a clean bidirectional stdio bridge through `xcodebuild`.
2. Structured stdout frames do survive the real boundary and are practical to demultiplex from surrounding log noise.
3. File-backed command ingress is already stable on Simulator and no longer needs ad hoc shell env injection once the bootstrap manifest carries the per-session control directory.
4. The extra stdout observation cost is small relative to UI automation costs.

## Evidence summary

### Real-boundary measurements

Measured on 2026-04-10 with `./ios/ProbeRunner/scripts/validate-transport-boundary.sh`:

| Option | Real-boundary status | Measured response path | Avg host RTT | Notes |
| --- | --- | --- | ---: | --- |
| Bidirectional stdio through `xcodebuild` | **Rejected** | stdin probe | n/a | runner reported `status: timeout`; no usable host→runner stdin path was observed |
| File mailbox both directions | **Viable baseline** | file-ready / file-response mirrors | `856.6 ms` | simplest control path, but host observability is polling-based and not streaming |
| File-mailbox ingress + stdout JSONL egress | **Chosen** | mixed-log stdout frames | `983.0 ms` | host gets push-style ready/response events; stdout adds `126.4 ms` avg over file mirrors |

Additional ready-path evidence from the same run:

- stdout `ready` reached the host `195 ms` before the file-backed `ready.json`
- the bootstrap manifest was observed in the runner as `bootstrapSource: simulator-bootstrap-manifest`
- the runner used a session-specific control directory under `/tmp/probe-runner-runtime-control.*`

### Same-host comparison that still matters

Measured with `bun run transport-spike`:

- stdout JSONL: startup `25.615 ms`, RTT `0.038 ms`, recovery `19.600 ms`
- Unix socket: startup `24.088 ms`, RTT `0.032 ms`, recovery `25.643 ms`

This keeps Unix socket in the “possible later alternative” bucket, but not the current choice, because the real XCUITest boundary still only proves stdout egress and file ingress.

## Recovery model

- One runner session owns one bootstrap manifest and one per-session control directory.
- Host recovery means:
  1. stop the current `xcodebuild` test session
  2. allocate a fresh control directory
  3. rewrite the bootstrap manifest
  4. relaunch the runner and wait for a new `ready` frame
- Commands remain correlated by sequence number across the file mailbox and stdout frames.

## Caveats

- Stdout is still a **mixed log stream**, not a dedicated pipe.
- The bootstrap manifest depends on Simulator-shared host filesystem access under `/tmp`.
- No clean real-device equivalent for the shared file-ingress seam is proven yet.
- The spike still writes file mirrors for measurement and debugging because the lifecycle and boundary validation scripts compare them against stdout; `SimulatorHarness` / `SessionRegistry` treat stdout as canonical egress.

## Swappability requirement

Keep runner semantics independent from the transport details.

Future work may replace:

- the bootstrap manifest
- the file-backed ingress path
- the mixed-log stdout egress parser

without changing the higher-level runner command/response model.
