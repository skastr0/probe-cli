# Runner transport spike

Updated: 2026-04-10

This note keeps the transport evidence in two layers:

1. a **same-host benchmark** comparing stdout JSONL and Unix socket in a direct child-process seam
2. a **real XCUITest boundary probe** validating what survives the actual `xcodebuild test-without-building` path

Artifacts:

- simplified benchmark harness: `bun run transport-spike`
- simplified benchmark results: `knowledge/xcuitest-runner/transport-spike-results.json`
- real-boundary probe: `./ios/ProbeRunner/scripts/validate-transport-boundary.sh`
- real-boundary results: `knowledge/xcuitest-runner/transport-boundary-spike-results.json`
- chosen contract: `knowledge/xcuitest-runner/transport-contract.md`

## 1. Same-host benchmark

Measured on the local Bun/TypeScript spike (`2026-04-10T00:20:48.518Z`):

| Transport | Startup avg | RTT avg | RTT p95 | Recovery avg | Reliability |
| --- | ---: | ---: | ---: | ---: | --- |
| stdout JSONL | 25.615 ms | 0.038 ms | 0.089 ms | 19.600 ms | 500/500 pings, 15/15 restarts |
| Unix socket | 24.088 ms | 0.032 ms | 0.075 ms | 25.643 ms | 500/500 pings, 15/15 restarts |

What this proves:

- both transport prototypes are reliable in a direct host-child seam
- both are negligible relative to UI automation latency
- stdout JSONL keeps the simpler recovery model even when socket RTT is slightly lower

What it does **not** prove:

- actual behavior at the `xcodebuild`-launched XCUITest runner boundary
- host → runner stdin delivery through `xcodebuild`
- that Unix sockets are a justified production choice for Probe's runner seam

## 2. Real XCUITest boundary probe

Measured on 2026-04-10 with `./ios/ProbeRunner/scripts/validate-transport-boundary.sh`:

- bootstrap manifest path: `/tmp/probe-runner-bootstrap/4015AB8A-185C-4334-8019-EBDE113852E5.json`
- selected contract reported by the runner: `probe.runner.transport/hybrid-v1`
- ingress: `file-mailbox`
- egress: `stdout-jsonl-mixed-log`
- bootstrap source observed in the runner: `simulator-bootstrap-manifest`
- stdout `ready` reached the host `195 ms` before the file-backed `ready.json`
- stdin probe status: `timeout`

Response timing across one successful session (`ping`, `ping`, `snapshot`, `ping`, `shutdown`):

| Observation path | Avg RTT | Min | Max |
| --- | ---: | ---: | ---: |
| file-backed response mirror | 856.6 ms | 184 ms | 1303 ms |
| stdout-observed frame | 983.0 ms | 308 ms | 1425 ms |
| stdout minus file | 126.4 ms | 122 ms | 134 ms |

What this proves:

- structured runner frames survive the real `xcodebuild` boundary as mixed stdout log lines
- the host can demultiplex ready and response frames from surrounding XCTest / `xcodebuild` output
- a simulator-scoped bootstrap manifest can carry a per-session control directory into the runner without relying on shell env propagation
- file-backed ingress plus stdout-framed egress is a real, working boundary contract on Simulator

What it does **not** prove:

- a clean dedicated JSONL stdout pipe with no surrounding log noise
- host → runner stdin delivery through `xcodebuild`
- a clean real-device equivalent for the shared file-ingress path

## 3. Final decision posture

- **Chosen now:** simulator bootstrap manifest + file-backed ingress + stdout JSONL egress
- **Rejected now:** pure bidirectional stdio through `xcodebuild`
- **Deferred:** Unix socket or another cleaner transport until a real-boundary improvement is actually proven

See `knowledge/xcuitest-runner/transport-contract.md` for the shipping contract and caveats.
