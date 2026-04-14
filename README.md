# Probe CLI

Probe is a daemon-first, agent-first iOS runtime controller for macOS. It provides reliable, token-efficient control of running iOS apps on Simulator or real device through a local daemon and thin CLI client.

Probe does not own builds, signing, or provisioning of the target app. The app must already be built and installed (except for Probe's own fixture app on Simulator, which it builds automatically).

## Product Vision

Probe is becoming **the local iOS validation and observability workbench for agents and power users**:

- **iOS-only** — focused exclusively on iOS simulators and devices
- **Local-first** — runs on your development machine, no cloud tenancy required
- **Artifact-first** — compact summaries with large evidence offloaded to inspectable artifacts
- **Typed contracts** — structured JSON over shell-like strings for agent use
- **Validation lanes** — purpose-built checks for recurring, expensive-to-break iOS seams:
  - accessibility audits
  - commerce / subscriptions / paywalls
  - performance / signposts / Metal

The pattern is: **doctor** (preflight) → **validate** (execute) → **drill** (inspect evidence).

## Architecture at a Glance

Probe runs as a long-lived daemon (`probe serve`) that speaks RPC over a Unix domain socket. The CLI commands are thin clients that send requests to the daemon. Everything is session-scoped: you open a session against a target app, do your work, then close it.

```
CLI commands  -->  Unix socket  -->  Daemon  -->  XCUITest Runner  -->  Target App
                                       |
                                       +--> Instruments (xctrace / perf)
                                       +--> simctl / devicectl
                                       +--> log stream / oslog
                                       +--> Artifact storage (~/.probe/sessions/)
```

## Prerequisites

- macOS with Xcode installed
- Bun runtime
- `ffmpeg` (optional, for stitching video frames into MP4)
- For real devices: paired device with Developer Mode enabled, signed app installed

## Quick Start

```bash
cd /path/to/probe-cli

# Check environment readiness
probe doctor --json

# Start the daemon (keep running in background or separate terminal)
probe serve &

# Open a session (fixture app on simulator)
probe session open --json
# Returns health including sessionId, state, capabilities, artifacts

# Do your QA work (screenshots, actions, snapshots, flows, etc.)
probe session screenshot --session-id <id> --json
probe session snapshot --session-id <id> --json

# Close when done
probe session close --session-id <id> --json
```

When running from the source repo, prefix commands with `bun run probe --`:
```bash
bun run probe -- serve
bun run probe -- session open --json
```

## Command Surface

### Control plane

| Command | Purpose |
|---------|---------|
| `probe doctor [--json]` | Workspace, daemon, and capability readiness |
| `probe doctor accessibility --session-id <id>` | Accessibility readiness of the target app |
| `probe doctor commerce --bundle-id <id> [--mode <m>] [--config <p>] [--provider revenuecat]` | StoreKit / commerce readiness |
| `probe doctor capture --target simulator\|device --session-id <id> [--kind sysdiagnose]` | Capture a diagnostic bundle (sysdiagnose on device) |
| `probe serve` | Start the daemon |
| `probe validate accessibility --session-id <id> [--scope current-screen]` | Accessibility checks on current screen |
| `probe validate commerce --session-id <id> --mode <m> [--plan <p>] [--provider revenuecat]` | Commerce validation; `local-storekit` requires `--plan` |

### Session lifecycle

| Command | Purpose |
|---------|---------|
| `probe session list` | List active sessions |
| `probe session open [--target simulator\|device] [--bundle-id <id>] [--simulator-udid <udid>] [--device-id <id>]` | Open a session |
| `probe session show --session-id <id>` | Full session health + artifacts |
| `probe session health --session-id <id>` | Ping the runner and return current health |
| `probe session close --session-id <id>` | Close and free resources |

### Observation

| Command | Purpose |
|---------|---------|
| `probe session snapshot --session-id <id> [--output auto\|inline\|artifact]` | Capture accessibility tree |
| `probe session screenshot --session-id <id> [--label <name>] [--output auto\|inline\|artifact]` | Capture PNG |
| `probe session video --session-id <id> --duration <dur>` | Record video clip (MP4 when `ffmpeg` available) |
| `probe session logs --session-id <id> [--source <s>] [--lines 80] [--match <text>] [--seconds 2] [--predicate <expr>] [--process <n>] [--subsystem <n>] [--category <n>] [--output <m>]` | Read logs from a source |
| `probe session logs mark --session-id <id> --label <label>` | Drop a named marker into the log stream |
| `probe session logs capture --session-id <id> [--seconds 3]` | Capture a fixed-duration log window artifact |
| `probe session logs doctor --session-id <id>` | Report which log sources are available |

### Interaction

| Command | Purpose |
|---------|---------|
| `probe session action --session-id <id> (--file <action.json> \| --json <action-json>)` | Perform a single UI action |
| `probe session run --session-id <id> (--file <flow.json> \| --stdin)` | Run a multi-step flow (`probe.session-flow/v1`) |
| `probe session recording export --session-id <id> [--label <name>]` | Export recorded actions as a replay script |
| `probe session replay --session-id <id> --file <recording.json>` | Replay a recording with retries + semantic fallback |
| `probe session result summary --session-id <id>` | Aggregate session result summary artifact |
| `probe session result attachments --session-id <id>` | List artifacts attached to the session result |

### Performance

| Command | Purpose |
|---------|---------|
| `probe perf record --session-id <id> --template <t> [--time-limit <dur>]` | Record a bounded Instruments trace |
| `probe perf around --session-id <id> --file <flow.json> --template <t>` | Record a trace while running a flow |
| `probe perf summarize --session-id <id> --artifact <trace-key> --group-by signpost` | Aggregate signpost intervals from a trace |

### Artifact drill

| Command | Purpose |
|---------|---------|
| `probe drill --session-id <id> --artifact <key> --lines <start:end> [--match <text>]` | Text window with optional grep |
| `probe drill ... --json-pointer <ptr>` | JSON drill by pointer |
| `probe drill ... --xpath <expr>` | XML drill by XPath |
| `probe drill ... --xcresult summary` | xcresult test summary |
| `probe drill ... --xcresult attachments [--attachment-id <id>]` | List or fetch xcresult attachments |
| All drill variants | Support `--output auto\|inline\|artifact` |

Most commands accept `--json` to emit JSON. When writing against Probe from a script, always pass `--json` — the text format is for humans.

## Session Lifecycle

Every interaction with a target app happens inside a session. Sessions have phases:

| Phase | Meaning |
|-------|---------|
| `opening` | Allocating resources, launching runner |
| `ready` | Healthy, accepts work |
| `degraded` | Open but some resources unavailable |
| `closing` | Cleanup in progress |
| `closed` | Done, resources freed |
| `failed` | Could not satisfy contract |

A session owns exactly one target app on one target device. Always close sessions when done — they have a TTL (default 15 min) but explicit cleanup is better.

### Opening Sessions

**Simulator with fixture app** (self-test, no app needed):
```bash
probe session open --json
```

**Simulator with your app** (must already be running):
```bash
probe session open --target simulator --bundle-id com.example.myapp --json
# Optionally pin to a specific simulator UDID:
probe session open --target simulator --bundle-id com.example.myapp --simulator-udid <udid> --json
```

**Real device** (must be paired, Developer Mode on, app installed):
```bash
probe session open --target device --bundle-id com.example.myapp --device-id <device-id> --json
```

Omitting `--bundle-id` on simulator uses Probe's built-in fixture app in `build-and-install` mode. Passing `--bundle-id` switches to `attach-to-running` mode — you're responsible for launching the app first.

### Inspecting Sessions

```bash
probe session list --json                      # all active sessions
probe session show --session-id <id> --json      # full health snapshot
probe session health --session-id <id> --json    # ping runner for fresh health
```

## Core Capabilities

### 1. Accessibility Snapshots

Snapshots capture the full accessibility tree of the running app. This is the foundation for all UI interaction — every node gets a stable ref (`@e1`, `@e2`, ...) that you use to target actions.

```bash
probe session snapshot --session-id <id> --output auto --json
```

`--output` controls inline body (`inline`), artifact-only (`artifact`), or size-based (`auto`, default).

Returns:
- `snapshotId` — unique identifier for this snapshot
- `metrics` — node count, interactive count, weak-identity count, max depth
- `diff` — changes since previous snapshot (added/removed/updated/remapped)
- `preview.nodes` — list of nodes with ref, type, identifier, label, value, state
- `artifact` — path to full snapshot JSON on disk

**Snapshot nodes look like this:**
```json
{
  "ref": "@e5",
  "type": "button",
  "identifier": "login-button",
  "label": "Log In",
  "value": null,
  "interactive": true,
  "state": { "disabled": false, "selected": false, "focused": false }
}
```

### 2. Screenshots

```bash
probe session screenshot --session-id <id> --label "after-login" --output auto --json
```

- `--label` names the screenshot for organization
- `--output auto|inline|artifact` controls inline base64 vs artifact-only
- Stored under `~/.probe/sessions/<id>/screenshots/`

### 3. Video Recording

```bash
probe session video --session-id <id> --duration 5s --json
```

- Duration supports units: `5s`, `500ms`, up to 120 seconds max
- With `ffmpeg` available, frames are stitched into MP4; otherwise a frame-sequence artifact
- Stored under `~/.probe/sessions/<id>/video/`

### 4. Single UI Actions

```bash
# From a file
probe session action --session-id <id> --file action.json --json

# Inline JSON payload (no temp file needed)
probe session action --session-id <id> \
  --json '{ "kind": "tap", "target": { "kind": "ref", "ref": "@e5", "fallback": null } }'
```

The `--json` flag is overloaded on `session action`: when its next token is not another flag, it is taken as inline JSON input; when bare, it requests JSON output. Use `--input-json <payload>` and `--output-json` to disambiguate in scripts.

**Supported action kinds:** `tap`, `press`, `swipe`, `type`, `scroll`, `wait`, `assert`, `screenshot`, `video`

See `actions-reference.md` for full schemas: selectors (ref / semantic / point / absence), assertion expectations, retry policy, and the recording contract.

### 5. Multi-Step Flows (`session run`)

Flows are the preferred way to execute a deterministic sequence of steps in one RPC. The daemon validates the whole script before running, continues on soft failures when asked, and returns a single structured result.

```bash
probe session run --session-id <id> --file flow.json --json
# or stream via stdin
cat flow.json | probe session run --session-id <id> --stdin --json
```

Flow contract: `probe.session-flow/v1`. Step kinds: `snapshot`, `tap`, `press`, `swipe`, `type`, `scroll`, `wait`, `assert`, `screenshot`, `video`, `logMark`, `sleep`. Any step may set `continueOnError: true` to keep the flow running when that step fails.

See `flows-reference.md` for the flow schema, step shapes, and worked examples.

### 6. Recording and Replay

Probe records every UI action during a session.

```bash
# Export the current session's recording
probe session recording export --session-id <id> --label "checkout-flow" --json

# Replay a recording in a new session
probe session replay --session-id <id> --file recording.json --json
```

Recording contract: `probe.action-recording/script-v1`. Replay produces a `probe.action-replay/report-v1` with per-step attempts, outcomes (`no-retry`, `retry-succeeded`, `semantic-fallback`, `retry-exhausted`), and a final `succeeded` or `failed` status. Default 3 retry attempts per step (configurable via `PROBE_REPLAY_ATTEMPTS`).

### 7. Logs

Probe can read from several live log sources. Pick with `--source`:

| Source | Content |
|--------|---------|
| `runner` (default) | XCUITest runner log (actions, events) |
| `build` | xcodebuild / build output |
| `wrapper` | Daemon-side runner wrapper log |
| `stdout` | Mixed stdout from the runner |
| `simulator` | Simulator-level `oslog` / `log stream` output |

Common patterns:

```bash
# Last 200 runner lines, filtered
probe session logs --session-id <id> --lines 200 --match "error" --json

# Simulator oslog window with predicate / process / subsystem / category filters
probe session logs --session-id <id> --source simulator --seconds 5 \
  --predicate 'eventMessage CONTAINS "payment"' --process MyApp \
  --subsystem com.myapp --category payments --json

# Mark a moment in the stream before a risky action
probe session logs mark --session-id <id> --label "before-submit" --json

# Capture a 3-second window as a standalone artifact
probe session logs capture --session-id <id> --seconds 3 --json

# Report which sources are currently available (and why)
probe session logs doctor --session-id <id> --json
```

### 8. Accessibility and Commerce Validation

Probe ships opinionated doctors and validators for two common quality lanes.

**Accessibility**
```bash
probe doctor accessibility --session-id <id> --json
probe validate accessibility --session-id <id> --scope current-screen --json
```
Reports interactive elements analyzed, categorized issues with severity, and evidence artifacts (snapshot + screenshot + report).

**Commerce (StoreKit / RevenueCat)**
```bash
probe doctor commerce --bundle-id com.example.myapp --mode local-storekit --config store.storekit --json
probe validate commerce --session-id <id> --mode local-storekit --plan plan.json --json
probe validate commerce --session-id <id> --mode sandbox --provider revenuecat --json
```
Modes:
- `local-storekit` — uses a local `.storekit` config; `--plan <commerce-plan.json>` is required
- `sandbox` — App Store Sandbox accounts
- `testflight` — TestFlight build, real Apple ID

`--provider revenuecat` opts into RevenueCat-specific checks.

### 9. Performance Profiling

```bash
probe perf record --session-id <id> --template time-profiler --json
probe perf record --session-id <id> --template system-trace --time-limit 5s --json

# Record a trace while driving a flow
probe perf around --session-id <id> --file flow.json --template time-profiler --json

# Aggregate signpost intervals from an existing trace
probe perf summarize --session-id <id> --artifact <trace-key> --group-by signpost --json
```

**Available templates:**

| Template | Default Duration | Use Case |
|----------|-----------------|---------|
| `time-profiler` | 3s | CPU hotspots, call stacks |
| `system-trace` | 3s (max 10s) | Scheduling, thread states |
| `metal-system-trace` | 60s | GPU workload, Metal performance |
| `hangs` | 3s | Main thread hangs |
| `swift-concurrency` | 3s | Task / actor scheduling |
| `logging` | 3s | `os_log` / signpost capture |

Results include a compact summary headline, key metrics, diagnoses (info / warning / wall), artifact paths (raw `.trace`, TOC, exports), and the post-record session state — a trace can succeed even if the runner degrades. Export files are capped at 8 MiB; exceeding this fails with `perf-export-file-too-large`.

### 10. Artifact Inspection (Drill)

```bash
# Text artifacts — line range
probe drill --session-id <id> --artifact snapshot-1 --lines 1:40

# Text artifacts — pattern matching
probe drill --session-id <id> --artifact runner-log --match "error"

# JSON artifacts — pointer
probe drill --session-id <id> --artifact snapshot-1 --json-pointer /nodes/0

# XML artifacts — xpath
probe drill --session-id <id> --artifact perf-toc --xpath "//table[@name='time-sample']"

# xcresult bundles
probe drill --session-id <id> --artifact session-xcresult --xcresult summary --json
probe drill --session-id <id> --artifact session-xcresult --xcresult attachments --json
probe drill --session-id <id> --artifact session-xcresult --xcresult attachments \
  --attachment-id <id> --output artifact
```

All drill variants accept `--output auto|inline|artifact`. xcresult drills default to `inline` when combined with `--json`.

### 11. Session Result Artifacts

After a flow or manual exploration, aggregate artifacts for handoff:

```bash
probe session result summary --session-id <id> --json
probe session result attachments --session-id <id> --json
```

## Element Selection Strategy

Probe supports four selector kinds (see `actions-reference.md`):

- **`ref`** — fast, per-snapshot, optional semantic fallback
- **`semantic`** — durable across UI changes, can be ambiguous
- **`point`** — raw `x` / `y` coordinates (use sparingly)
- **`absence`** — wrap another selector with `negate` to assert absence

**Best practice — ref with semantic fallback:**
```json
{
  "kind": "ref",
  "ref": "@e5",
  "fallback": {
    "kind": "semantic",
    "identifier": "login-button",
    "label": null, "value": null, "placeholder": null,
    "type": "button", "section": null, "interactive": true
  }
}
```

Recording export produces this pattern automatically.

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PROBE_SESSION_TTL_MS` | 900000 (15 min) | Session time-to-live |
| `PROBE_REPLAY_ATTEMPTS` | 3 | Retry count per replay step |
| `PROBE_RPC_TIMEOUT_MS` | 600000 (10 min) | RPC timeout |
| `PROBE_ARTIFACT_RETENTION_MS` | 7 days | Artifact retention period |

## Source Layout

```
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

## Validation

Run the canonical product validation script:

```bash
# Simulator with fixture app
bun run scripts/validate-product-flow.ts --target simulator

# Simulator with your app
bun run scripts/validate-product-flow.ts --target simulator --bundle-id com.example.myapp

# Real device
bun run scripts/validate-product-flow.ts --target device --bundle-id com.example.myapp --device-id <device-id>
```

The script starts `probe serve`, opens a session, sends a ping, captures a snapshot, performs a UI action, records a 5-second Time Profiler trace, lists artifacts, closes the session, stops the daemon, and prints a timed pass/fail summary.

## Supporting References

- `actions-reference.md` — full action and selector schemas, `wait` conditions, assertion expectations, retry policy, recording/replay contracts
- `flows-reference.md` — `probe.session-flow/v1` schema, step kinds, `continueOnError`, worked examples
- `recipes.md` — end-to-end QA recipes (login, form validation, commerce, accessibility, perf-around-flow, etc.)
- `troubleshooting.md` — session won't open, stale refs, log sources unavailable, daemon socket conflicts, perf walls
- `V2-DIRECTION.md` — product vision and roadmap for the validation and observability workbench

---

**Probe**: local iOS validation and observability for agents and power users.
