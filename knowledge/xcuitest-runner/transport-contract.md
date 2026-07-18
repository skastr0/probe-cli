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

### The GET/artifact path had the same shape (PRB-101)

`downloadRunnerHttpArtifact` (`src/services/RealDeviceHarness.ts`) — the
real-device video artifact manifest/frame `GET /artifact` download used by
`materializeDeviceRunnerVideoArtifacts` — is a separate code path from
`RunnerTransportClient` (a raw `fetch` loop, not routed through the command
transport client above), and it carried the identical pre-PRB-081 defect
shape: `perEndpointTimeoutMs` divided `runnerArtifactDownloadTimeoutMs`
evenly across every candidate URL up front (floored at 1s), so a candidate
late in the list only ever got its pre-carved slice regardless of how fast
earlier candidates failed, and a long enough candidate list could push the
floor past the intended total budget. PRB-101 gives it the same fix as
`RunnerTransportClient`: one absolute deadline computed once, each attempt
gets whatever remains. See `RealDeviceHarness.test.ts`'s "downloadRunnerHttpArtifact
(PRB-101 absolute deadline)" for the contract test.

## Replay-safety contract (PRB-089)

PRB-081 made a mutation's ambiguous transport failure stop instead of
falling through to another candidate; it did not make redelivering that
same mutation safe. PRB-089 closes that gap: **at-most-once mutation
execution within one live runner epoch**, with duplicate deliveries
replaying the original terminal result instead of re-running the action.

### Guarantee boundary

- Scoped to **one live runner epoch** — the runner process's own lifetime.
  A crash or restart mints a fresh epoch; nothing is claimed across that
  boundary. "Runner loss after dispatch without a durable result" is
  reported as **explicit indeterminate**, never as success and never as a
  claim that the mutation definitely did not run.
- Explicitly excluded (see the glyph's Exclusions): persistence across a
  runner restart, automatic replay under a new epoch, distributed
  exactly-once claims, and general HTTP caching.

### Wire contract

- `RunnerReadyFrameSchema` / the Swift `LifecycleReadyFrame` now carry
  `runnerEpoch: string` — a fresh UUID minted once per
  `attachForLifecycleLoop` call (i.e. once per live runner process/attach).
- `RunnerCommandFrameSchema` / `LifecycleCommandFrame` now carry
  `epoch: string`; the host always echoes back the epoch from the ready
  frame it attached to.
- `RunnerResponseFrameSchema` / `LifecycleResponseFrame` now carry
  `epoch: string` (the runner's *current* epoch — reported even on a
  rejected command) and `replayStatus`, one of:
  - `"executed"` — ran for the first time this epoch.
  - `"cached-replay"` — a duplicate of an already-cached sequence; the
    stored terminal result was returned verbatim (`recordedAt`,
    `handledMs`, `payload`, `statusLabel`, `ok`, `error` all byte-identical
    to the original execution) with only `replayStatus` relabeled. That
    field-level identity is the receipt that no second execution happened.
  - `"result-expired"` — the sequence is at or below the executed
    high-water mark but its cache entry was evicted; the runner refuses to
    re-execute a mutation whose original result it can no longer prove.
  - `"epoch-mismatch"` — the command's epoch does not match the runner's
    current one; rejected before execution.
  - `"sequence-gap"` — the command's sequence skips more than one past the
    executed high-water mark; rejected before execution rather than risk
    out-of-order mutation.

### Runner-side mechanism (`RunnerReplayCoordinator`, AttachControlSpikeUITests.swift)

One instance per live runner process, holding exactly two pieces of state:
a bounded (64-entry, FIFO-evicted) terminal-result cache keyed by sequence
number, and the executed high-water mark. `disposition(for:)` runs
*before* `handleLifecycleCommand`, on the same `@MainActor`-serialized HTTP
path as execution itself — every action handler in `handleLifecycleCommand`
runs to completion without an `await`, so a second delivery for a sequence
still executing cannot itself begin running until the first has already
recorded its terminal result. That serialization is what makes "duplicate
in-flight command coalesces onto the first execution" true without any
separate in-flight bookkeeping: it degenerates to a cache hit by
construction, not a race the coordinator has to referee.

A failed execution attempt (a thrown `handleLifecycleCommand` error) is
cached exactly like a successful one — a doomed mutation's first *attempt*
already ran (with whatever side effects that implies), so a redelivery must
never try it again.

### Host-side mechanism (`SessionController` + `SessionRegistry.sendRunnerCommand`)

`SessionController.allocateSequence()` (PRB-083) allocates a command's
identity exactly once; PRB-089 makes `sendRunnerCommand` *reuse* that one
sequence number across every permitted redelivery attempt, instead of
allocating a fresh one per retry. Only an **ambiguous**
`RunnerTransportError` (`sent-no-response` / `invalid-response` — the
runner may already have executed the command) is retryable, bounded to 100
attempts with a small backoff; an unambiguous `not-sent` failure (nothing
reached the runner) keeps its prior single-attempt behavior, and `ping`
is excluded entirely (it already retries safely *inside*
`RunnerTransportClient`'s one absolute deadline). Exhausting the
redelivery budget while every failure stayed ambiguous reports a typed
`session-runner-<action>-indeterminate` `EnvironmentError` carrying the
command's sequence, epoch, and last delivery phase — the glyph's "runner
crash after dispatch cannot produce success" case.

### Verification

- `RunnerTransportClient.test.ts`, `runnerProtocol.test.ts`,
  `SimulatorHarness.test.ts`: wire-contract coverage for the new
  `epoch`/`replayStatus` fields.
- `SessionRegistry.test.ts`: "redelivers an ambiguous mutation failure and
  reuses the same command sequence", "does not redeliver an unambiguous
  (not-sent) mutation failure", "gives up after exhausting mutation
  redelivery and reports a typed indeterminate failure" — the host-side
  redelivery policy against a fake harness, deterministic and fast.
- `AttachControlSpikeUITests.testCommandLoopReplaySafety` — the real
  Simulator/XCUITest boundary proof, run against the actual HTTP command
  server: a fresh execute; 100 identical redeliveries returning the
  byte-identical cached result; a fault-injection-shaped
  execute-then-redeliver of a real `applyInput` mutation (one status-label
  change, not two); an epoch-mismatch rejection; a sequence-gap rejection —
  both leaving app state untouched; and (added in the PRB-089 review-fix
  pass) a cache-eviction case that drives 63 additional executed sequences
  through the real server to push the 64-entry FIFO cache past capacity,
  evicting the very first sequence, then redelivers that identity and
  asserts the runner returns typed `result-expired` (`ok: false`) rather
  than silently re-executing it, with app state unchanged. Passed against
  `iPhone 16 Pro` / iOS 18.0 on 2026-07-17 (`test-without-building
  -only-testing:ProbeRunnerUITests/AttachControlSpikeUITests/testCommandLoopReplaySafety`)
  — this was the pre-existing coverage before the eviction step was added;
  see "Not yet covered" for the status of re-running the full test
  (including the new eviction step) in this review pass.
- `src/investigations/rpc-daemon-defects/scenarios/ambiguousMutationDelivery.ts`
  is owned by this glyph (wave-1 handoff note) and is now green: it proved
  the daemon RPC client silently accepted a sequence gap in progress
  events; `src/rpc/client.ts`'s `sendRequest` now tracks the last-seen
  event sequence per request and fails the request
  (`EnvironmentError` code `rpc-progress-sequence-gap`) the moment a later
  event skips ahead, instead of forwarding it to `onEvent` and letting the
  request resolve as if nothing were missing. This is a distinct transport
  (the Unix-socket daemon RPC protocol, not the runner HTTP command
  protocol) but the same shape of defect — an unvalidated `sequence` field
  — so the fix lives at its own layer, not folded into
  `RunnerReplayCoordinator`.

### Not yet covered

- A **physical device** run of `testCommandLoopReplaySafety` — this host
  has two connected devices visible to `devicectl` but no
  `DEVELOPMENT_TEAM` configured, so device-signed XCUITest execution
  cannot be exercised here. The device HTTP command path (`RealDeviceHarness.ts`)
  threads `epoch` identically to the simulator path (same
  `runRunnerTransportSend` call, same `ready.runnerEpoch` source), so the
  wire contract is shared; only the on-device *execution* of
  `RunnerReplayCoordinator` remains unverified against real hardware.
- Before this review-fix pass, `testCommandLoopReplaySafety` never drove
  enough distinct executed sequences to cross the terminal-result cache's
  64-entry FIFO bound, so the `result-expired` rejection
  (`RunnerReplayCoordinator.disposition(for:)`, the `sequence <=
  executedHighWaterMark` branch) and the eviction itself
  (`evictIfNeeded`) were verified by code review only, never exercised
  live. A step forcing eviction and asserting the typed rejection was
  added to `driveReplaySafetyScenario` in this pass. It could not be
  re-run live in this review environment: two genuine attempts to execute
  `testCommandLoopReplaySafety` against `iPhone 16 Pro` / iOS 18.0 both
  failed before reaching the eviction step (or any step), at
  `attachForLifecycleLoop`'s bootstrap-manifest read —
  `resolveLifecycleControlDirectory` reports the manifest at
  `/tmp/probe-runner-bootstrap/<udid>.json` as missing even though
  `FileManager.fileExists` sees it and the host shell confirms it exists
  and is readable (Xcode 26.6, `xcodebuild` 26.6/17F113 on this host). The
  identical failure reproduces on the pre-existing, unmodified
  `testCommandLoopLifecycle` via `validate-lifecycle.sh`, so this is not a
  regression from this pass's diff — it is this host's current
  Simulator/XCUITest toolchain no longer honoring cross-process
  filesystem reads under `/tmp` for the UI test runner process the way the
  2026-07-17 "Passed" receipt above assumes. A second attempt tried the
  code's built-in bypass (`PROBE_BOOTSTRAP_JSON` env var, normally the
  device-bootstrap path) via `xcodebuild`'s `TEST_RUNNER_`-prefixed
  build-setting override; the override did not appear in the generated
  `.xctestrun`'s `EnvironmentVariables`, so the test still fell through to
  the same file-read path and failed the same way. The new eviction step
  therefore stayed unexercised live in this pass — real-boundary coverage
  for `#6`/`#11` is code-reviewed and typechecked only, not yet Simulator-run.
- **Working third injection path found (2026-07-18, PRB-092 review-fix
  pass).** Both bypasses above still fail on this exact host
  (Xcode 26.6/17F113): a fresh attempt reproduced the same raw-file ENOENT
  (`testUIActionBatchAtTheHTTPBoundaryIsOneRPCWithReplaySafeRedelivery` run
  directly via `-project`/`-scheme` against a freshly-written
  `/tmp/probe-runner-bootstrap/<udid>.json`). What *did* work: editing the
  `.xctestrun` file `build-for-testing` already generates — not the
  `TEST_RUNNER_` command-line override, which never reaches it — and adding
  `PROBE_BOOTSTRAP_JSON` directly to `ProbeRunnerUITests.EnvironmentVariables`
  in that plist, then invoking `xcodebuild test-without-building -xctestrun
  <path>` (in place of `-project`/`-scheme`). Two pitfalls to avoid when
  writing that key: (1) `/usr/libexec/PlistBuddy -c "Add ... string
  \"<json>\""` mangles embedded double quotes and silently corrupts the JSON
  (`JSONDecoder` then fails with "isn't in the correct format") — write the
  plist with Python's `plistlib` (load, mutate the dict, dump) instead; (2)
  the env-var branch of `resolveLifecycleControlDirectory` decodes into the
  same `LifecycleBootstrapConfig` as the file-based branches, so the payload
  needs every required field the shell-script bootstrap writers omit —
  `targetBundleId` in particular is not written by
  `validate-lifecycle.sh`'s `write_bootstrap_json` (it predates PRB-092's
  arbitrary-target-app support) — and, for this specific test,
  `ingressTransport` must be `"http-post"`, not the file-mailbox scripts'
  `"file-mailbox"`, or `validateLifecycleBootstrapConfig` rejects it. With
  both fixed, `testUIActionBatchAtTheHTTPBoundaryIsOneRPCWithReplaySafeRedelivery`
  ran and passed end to end (see
  `knowledge/xcuitest-runner/integration-notes.md`'s "PRB-092" section for
  the receipt). This does not retroactively prove the still-unexercised
  `testCommandLoopReplaySafety` eviction step above ran — that step was not
  re-attempted in this pass — but it is a genuine, reproducible third
  bootstrap-injection path for any future spike blocked the same way.
- **Consolidated into a reusable, tested script (2026-07-18, PRB-102).** The
  three scattered mentions above (this file, `open-questions.md` question 6,
  and `integration-notes.md`'s PRB-092 section) are now one script:
  `ios/ProbeRunner/scripts/validate-lifecycle-xctestrun-bootstrap.sh`. It
  reproduces the ENOENT defect's root cause fresh on this exact host
  (Xcode 26.6/17F113) via the unmodified, pre-existing
  `validate-lifecycle.sh` (`testCommandLoopLifecycle`, same
  "could not be decoded ... couldn't be read because it is missing" error
  against a bootstrap manifest the host shell confirms exists), then applies
  the injection fix and runs `testCommandLoopReplaySafety` --
  this glyph's own named acceptance target -- twice against a booted
  iPhone 17 Pro (iOS 26.4):
  - **The ENOENT defect itself is gone on both runs.** The ready frame
    printed `"bootstrapPath":"env:PROBE_BOOTSTRAP_JSON"` (not a file path) on
    both attempts -- the runner never touched
    `/tmp/probe-runner-bootstrap/<udid>.json` at all, so the intermittent
    cross-process file-read race has no path left to occur on. Both runs got
    from cold start through attach, HTTP command-server bring-up, and 3 of
    `driveReplaySafetyScenario`'s 6 steps (fresh execute, 100 cached
    redeliveries, a real `applyInput` mutation) before failing --
    dramatically further than the prior two attempts, both of which failed
    at the bootstrap read before test logic ever began.
  - **A second, distinct defect surfaced once the ENOENT blocker cleared,
    and stayed out of this glyph's scope.** Both runs failed identically at
    the same assertion
    (`AttachControlSpikeUITests.swift:769`,
    `XCTAssertEqual failed: ("ProbeFixture") is not equal to ("Input applied:
    probe-replay-safety")`) -- reading `app.staticTexts["fixture.status.label"].label`
    after the `applyInput` mutation returned the app's own bundle/product
    name instead of the expected status text, on both attempts, in the same
    place. This is deterministic on this host/iOS combination, not a flake,
    and it is a *different* failure mode than the ENOENT defect this script
    was built to fix -- it never reproduced the bootstrap-read error at all.
    Root-causing it (a stale/wrong element resolution after the "Reset"
    button interaction, or a status-label update race, are both plausible
    but unconfirmed) is unstarted; it needs its own investigation and is not
    something this glyph's acceptance criterion asked for. Filed here rather
    than chased inline.
  - **Net effect on this glyph's acceptance criterion:** "PRB-089's live
    simulator replay receipt can run" is **partial**, not met. The
    bootstrap-JSON ENOENT blocker this criterion names is root-caused and
    has a working, reusable, tested fix -- `testCommandLoopReplaySafety` now
    *runs* past it, twice, reproducibly. It does not yet *pass* end to end
    on this host, but for a reason this glyph did not ask to fix.

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
- A relaunched runner mints a fresh `runnerEpoch` (PRB-089); the old epoch's
  terminal-result cache is gone with the process. There is no attempt to
  carry replay safety across this boundary — see "Replay-safety contract"
  above.
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
