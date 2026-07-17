# XCUITest runner transport contract

Updated: 2026-07-17 (PRB-081)

## Current production seam

Scope: `xcodebuild test-without-building` sessions on **Simulator and real device**.

- **Bootstrap/config seam:** a host-local manifest under `/tmp/probe-runner-bootstrap/`
  - simulator: `/tmp/probe-runner-bootstrap/<SIMULATOR_UDID>.json`
  - device: `/tmp/probe-runner-bootstrap/device-<UDID>.json`
- **Host → runner ingress:** HTTP `POST` to the runner's `/command` endpoint
  (`RUNNER_HTTP_COMMAND_INGRESS = "http-post"` in `src/services/runnerProtocol.ts`).
  The bootstrap manifest carries the port; a real-device session also resolves a
  device tunnel IP and tries it before falling back to `127.0.0.1`
  (`buildRunnerHttpCommandUrls` in `src/services/RealDeviceHarness.ts`).
- **Runner → host egress, readiness/diagnostics:** structured JSON frames parsed out
  of the mixed `xcodebuild` / XCTest stdout stream (unchanged from the original
  file-mailbox-era design below). The `ready` frame is still observed this way;
  `SimulatorHarness` / `RealDeviceHarness` treat stdout as canonical for it.
- **Runner → host egress, command responses:** the HTTP response body to the
  `/command` POST, decoded as a `RunnerResponseFrame`
  (`decodeRunnerResponseFrame` in `src/services/runnerProtocol.ts`).
- **Command transport client:** `RunnerTransportClient`
  (`src/services/RunnerTransportClient.ts`) owns HTTP encode/decode, candidate
  endpoint iteration, the deadline, and typed delivery outcomes for every
  command send. Both harnesses call it through `runRunnerTransportSend`; there
  is exactly one implementation, not one per harness.

This supersedes the file-mailbox description that used to head this document.
The file-mailbox ingress (`command-*.json` files written to a control
directory, consumed via `stdout-response-*.json` mirrors) is still present in
`RealDeviceHarness.ts` as a defensive branch, but it is unreachable in
practice: `assertReadyTransportContract` rejects any ready frame whose
`bootstrapSource` is not `device-bootstrap-manifest` before a live session's
`sendCommand` closure is even constructed, so the HTTP branch always runs for
a session that got this far. `SimulatorHarness` never had a file-mailbox
command path at all — its sessions have always sent commands over HTTP.

## RunnerTransportClient contract (PRB-081)

Before PRB-081, both harnesses had their own copy of `sendRunnerHttpCommand`.
The real-device copy divided the total command timeout equally across
candidate endpoints and retried a fresh candidate after each per-candidate
timeout — for a 20s budget and two candidates, that is ~10s per candidate. An
action that took about 10.86s to complete on the runner (the incident that
opened this glyph) could time out on the first candidate right as its
response was about to arrive, and the fallback would then dispatch the same
mutation again on the second candidate.

`RunnerTransportClient` fixes the behavior, not just the duplication:

- **One absolute deadline.** The deadline is computed once, at the start of
  `send()`, from `resolveRunnerCommandTimeoutMs`. It is never divided across
  candidates; each attempt gets whatever remains of the same deadline. The
  contract test `RunnerTransportClient.test.ts` proves a fake 10.86s action
  succeeds inside a single 20s budget with two candidate endpoints, one of
  them unreachable.
- **Typed delivery outcomes.** A send either succeeds with a
  `RunnerDeliveryOutcome` (`kind: "runner-response"`, carrying the decoded
  frame) or fails with a `RunnerTransportError` whose `code` is one of:
  - `not-sent` — the request never reached the runner (e.g. connection
    refused). Unambiguous; safe to try the next candidate even for a
    mutation, since nothing executed.
  - `sent-no-response` — the request was dispatched but no response arrived
    before the deadline. Ambiguous: the runner may have executed it.
  - `invalid-response` — a response arrived but did not decode as a
    `RunnerResponseFrame`. Ambiguous for the same reason: the runner replied,
    so it almost certainly ran the command.
  `RunnerTransportError` also carries `endpoint`, `attemptedEndpoints`,
  `phase`, `elapsedMs`, `remainingDeadlineMs`, and `ambiguous`. It
  deliberately does not carry a session-level `nextStep` — that translation
  happens where each harness catches it, not in the transport layer.
- **Mutations never fall through after an ambiguous outcome.** By default
  (`idempotent` unset/false), a `sent-no-response` or `invalid-response`
  result stops the call immediately; no other candidate is tried. Only
  `not-sent` advances to the next candidate.
- **`ping` opts into idempotent retry.** Both harnesses pass
  `idempotent: action === "ping"` to `runRunnerTransportSend`. With
  `idempotent: true`, an ambiguous `sent-no-response` may be retried — with a
  short per-attempt timeout and a small backoff — against the remaining
  deadline and candidates, since re-pinging is safe.
- **Interruption.** Effect's own timeout/interruption machinery drives the
  deadline (`Effect.timeoutFail` racing an `Effect.tryPromise` whose `try`
  receives Effect's `AbortSignal`), so there is no hand-rolled
  `setTimeout`/`clearTimeout`/`AbortController` bookkeeping left in either
  harness. Interrupting the effect (fiber interruption or the deadline
  elapsing) aborts the fetch and lets Effect release its own timer; the
  fiber unblocks promptly rather than waiting on the network call. One
  runtime caveat verified while writing the contract tests: this Bun version
  does not reliably surface an aborted `POST`-with-body to the remote peer
  (the client-side promise rejects with `AbortError`, but the server may
  never observe an aborted/closed connection). That is a characteristic of
  the HTTP client on this runtime, present identically before PRB-081, not
  something this client's Effect wiring can control from the caller's side —
  see the "Effect interruption unblocks the caller promptly..." test for what
  is actually proven.
- **Contract tests prove simulator/device parity.** The same decode path is
  exercised once for a single-endpoint (simulator-shaped) call and once for a
  two-endpoint (device-shaped) call in `RunnerTransportClient.test.ts`.

## Historical evidence (superseded)

The measurements below are retained for provenance. They record why HTTP
command ingress replaced an earlier file-mailbox design; they no longer
describe current behavior for command dispatch (see above).

### Real-boundary measurements

Measured on 2026-04-10 with `./ios/ProbeRunner/scripts/validate-transport-boundary.sh`:

| Option | Real-boundary status | Measured response path | Avg host RTT | Notes |
| --- | --- | --- | ---: | --- |
| Bidirectional stdio through `xcodebuild` | **Rejected** | stdin probe | n/a | runner reported `status: timeout`; no usable host→runner stdin path was observed |
| File mailbox both directions | **Viable baseline** | file-ready / file-response mirrors | `856.6 ms` | simplest control path, but host observability is polling-based and not streaming |
| File-mailbox ingress + stdout JSONL egress | **Superseded by HTTP ingress** | mixed-log stdout frames | `983.0 ms` | host gets push-style ready/response events; stdout adds `126.4 ms` avg over file mirrors |

Additional ready-path evidence from the same run:

- stdout `ready` reached the host `195 ms` before the file-backed `ready.json`
- the bootstrap manifest was observed in the runner as `bootstrapSource: simulator-bootstrap-manifest`
- the runner used a session-specific control directory under `/tmp/probe-runner-runtime-control.*`

### Same-host comparison that still matters

Measured with `bun run transport-spike`:

- stdout JSONL: startup `25.615 ms`, RTT `0.038 ms`, recovery `19.600 ms`
- Unix socket: startup `24.088 ms`, RTT `0.032 ms`, recovery `25.643 ms`

This keeps Unix socket in the "possible later alternative" bucket for the
`ready`/diagnostics stdout path; command dispatch itself moved to HTTP POST
(see above), which real-boundary testing later proved viable for both
Simulator and device.

## Recovery model

- One runner session owns one bootstrap manifest and one per-session control directory.
- Host recovery means:
  1. stop the current `xcodebuild` test session
  2. allocate a fresh control directory
  3. rewrite the bootstrap manifest
  4. relaunch the runner and wait for a new `ready` frame
- Commands remain correlated by sequence number in the `RunnerCommandFrame` /
  `RunnerResponseFrame` pair, regardless of which egress path carried a given
  frame.

## Caveats

- Stdout is still a **mixed log stream**, not a dedicated pipe, for the
  `ready` frame and diagnostics.
- The bootstrap manifest depends on host-local filesystem access under `/tmp`
  (simulator) or an injected environment variable (device); the runner
  resolves it differently on Simulator vs device.
- A real-device session tries the device tunnel IP before `127.0.0.1`;
  `RunnerTransportClient` treats a refused connection on the tunnel IP as
  `not-sent` and moves on to the loopback candidate without spending the
  deadline on it (see the RunnerTransportClient contract above).

## Swappability requirement

Keep runner semantics independent from the transport details.

Future work may replace:

- the bootstrap manifest
- the HTTP command ingress
- the mixed-log stdout egress parser used for the `ready` frame

without changing the higher-level runner command/response model.
