# xctrace + Instruments integration notes

Accessed: 2026-04-10

Legend:

- **Observed** = directly supported by a cited source.
- **Inference** = derived for Probe from the observed sources.

## Scope split for this pack

- **Observed:** Probe architecture treats `xctrace` as a tooling-plane integration boundary and expects trace exports to flow through the artifact-first output model. Sources: `ARCHITECTURE.md`, `AGENTS.md`.
- **Inference:** This pack should stay focused on the `xctrace` / Instruments seam itself:
  - CLI capability discovery
  - template and instrument selection
  - export / schema inspection
  - version-specific caveats
  - artifact and extractor implications for Probe

## Probe-oriented guidance

### 1. Device targeting and session safety

- **Observed:** `xctrace record` defaults to the host device when `--device` is omitted. Source: `xcrun xctrace help record`, `man xctrace`.
- **Observed:** Current `list devices` output includes both the host Mac and simulator targets. Source: `xcrun xctrace list devices`.
- **Inference:** Probe should always resolve and persist one explicit device identifier for profiling work instead of relying on the host-default behavior.
- **Inference:** For a daemon-owned session, `xctrace` recording should take a concrete UDID or an already-resolved target name from session state, not a caller-supplied free-form device string on every command.

### 2. Template handling and capability reporting

- **Observed:** Template availability is discoverable at runtime via `xcrun xctrace list templates`, and instrument availability is discoverable via `xcrun xctrace list instruments`. Sources: `xcrun xctrace list templates`, `xcrun xctrace list instruments`.
- **Observed:** Instruments Help says template configurations can be saved. Source: _Instruments Overview_.
- **Observed:** Some templates, especially `CPU Counters`, need GUI-side preconfiguration before CLI recording yields useful data. Source: Apple Developer Forums thread 705565.
- **Inference:** Probe should expose template/instrument capability discovery from the live toolchain instead of hard-coding a fixed support matrix.
- **Inference:** Probe should treat custom saved templates as a first-class capability surface because some useful recordings are only practical through custom templates.
- **Inference:** Probe should distinguish between:
  - bundled template available
  - custom template available
  - template exportability validated

  rather than collapsing all of those into a single “supported” flag.

### 3. Export workflow and artifact policy

- **Observed:** Apple’s documented export discovery flow is `xctrace export --toc` followed by narrower `--xpath` selection. Sources: `xcrun xctrace help export`, `man xctrace`, Apple Developer Forums thread 700733.
- **Observed:** Apple’s man page examples scope exports by run number, for example `run[@number="1"]`. Source: `man xctrace`.
- **Observed:** The architecture requires summary + artifact for large outputs and a later drill step rather than flooding stdout. Source: `ARCHITECTURE.md`.
- **Inference:** Probe should treat the `.trace` bundle as the canonical raw artifact, then layer these secondary derivatives on top:
  1. TOC export
  2. schema-specific XML export
  3. optional HAR export for HTTP traces

- **Inference:** Probe should never print large raw XML exports inline by default. It should write them into the session artifact root and return a compact summary plus artifact path.
- **Inference:** Probe’s future extractor layer should be TOC-first and schema-name-based, because Apple’s own GUI-to-CLI mapping guidance uses schema names exposed by the Inspector.
- **Inference:** Probe’s first supported export contract should stay explicitly budgeted. Streaming schema XML directly to artifact files and enforcing per-export byte/row caps is safer than buffering unbounded `xctrace export` output in memory, especially for `System Trace` where the current supported summary is still narrow.

### 4. Schema and backtrace handling

- **Observed:** Backtrace XML can contain compressed textual summaries while the full symbolicated backtrace is only described for extended views in Apple Help. Source: _Address Backtrace Engineering Type_.
- **Observed:** A public Apple-engineer answer does not provide a direct workaround for full-backtrace export in older `time-sample` exports. Source: Apple Developer Forums thread 708957.
- **Inference:** Probe should not promise full reconstructed stacks from every Time Profiler export until the exact schema and Xcode-version behavior is validated on Probe-owned sample traces.
- **Inference:** If Probe needs machine-usable call stacks, the safe implementation path is:
  1. keep the original `.trace`
  2. export only the relevant table(s)
  3. symbolicate if needed
  4. run version-aware parsing over the exported XML

### 5. Version-aware caveats and conflicts

- **Observed:** Apple’s forum answers from 2020 say Leaks / Allocations / VM Tracker were not exportable, while Xcode 13 release notes later say export support was added. Sources: Apple Developer Forums threads 661295 and 664347; _Xcode 13 Release Notes_.
- **Observed:** Xcode 26.4 adds `xctrace import --append-run`, but the current local Xcode 26.3 help does not expose it. Sources: _Xcode 26.4 Release Notes_, `xcrun xctrace help import`.
- **Observed:** Local help/man output contains inconsistencies (`--device` vs `--device-name`; `list devices` docs vs actual host-inclusive output; incorrect man-page prose in the export section). Sources: `xcrun xctrace help record`, `xcrun xctrace list devices`, `man xctrace`.
- **Inference:** Probe should treat `xctrace` support as **Xcode-version-dependent** and report the detected local Xcode / `xctrace` version in profiling capability output.
- **Inference:** Probe should prefer runtime validation and targeted smoke traces over assuming that a forum-era caveat or release-note feature is universally true across all supported Xcode versions.

### 6. Practical implementation implications for Probe

- **Inference:** A minimal reliable profiling contract for Probe should likely be:
  - discover templates/instruments from the installed toolchain
  - record using explicit template + explicit device
  - store `.trace` under the session artifact root
  - export TOC on demand
  - export schema-selected XML or HAR on demand
  - surface unsupported / version-dependent templates honestly

- **Inference:** For the current product slice, `System Trace` should keep a smaller recording-window cap than lighter templates and fail honest when schema exports outrun Probe’s current XML budgets instead of pretending every successful `.trace` also implies an affordable supported summary.

- **Inference:** Good first validation targets for Probe are likely:
  - `Time Profiler`
  - `Metal System Trace`
  - `Network` / `HTTP Traffic`
  - `Logging` / `os_signpost`
  - `Swift Concurrency`

  because they align with the architecture’s intended CPU / GPU / scheduling / network / signpost profiling surfaces.

- **Inference:** `CPU Counters`, `Allocations`, `Leaks`, and other historically caveated templates should be treated as secondary capability work until Probe validates them against the current Xcode version with reproducible sample traces.

## 7. Empirical findings from ProbeFixture schema mapping spike

- **Observed:** On Xcode 26.3 against the existing ProbeFixture Simulator path, these templates recorded successfully and exported stable TOCs: `Time Profiler`, `Metal System Trace`, `Swift Concurrency`, `Logging`, and `System Trace`. Source: `knowledge/xctrace-instruments/schema-spike-results.json`.
- **Observed:** The first durable extractor targets with populated rows on the current sample set are:
  - `time-sample`
  - `thread-state`
  - `cpu-state`
  - `metal-gpu-intervals`

  Source: `knowledge/xctrace-instruments/schema-spike-results.json`, `knowledge/xctrace-instruments/schema-inventory.md`.
- **Observed:** Several useful schemas are discoverable but workload-dependent on the current fixture run, including `swift-task-*`, `swift-actor-*`, `os-log`, `os-signpost`, `runloop-events`, and some richer Metal driver views. Source: `knowledge/xctrace-instruments/schema-spike-results.json`.
- **Observed:** `xctrace record --template "Network"` fails on the Simulator with `Recording of 'Network Connections' is not supported in the Simulator.` The failed trace still exposes CFNetwork schema names and HAR-capable TOC metadata, but not usable network rows. Source: `knowledge/xctrace-instruments/schema-spike-results.json`, `knowledge/xctrace-instruments/fixture-network.toc.xml`.
- **Inference:** Probe should report template support at two levels:
  1. schema visible in TOC
  2. rows observed in the current workload / target mode

  because Simulator success alone does not mean a metric family is populated.

### 5. Custom Instruments template workflow

- **Observed:** `xctrace record --template` accepts both template names and filesystem paths. Source: `xcrun xctrace help record`.
- **Observed:** User-created templates are stored as `.tracetemplate` files (NSKeyedArchiver binary plists) under `~/Library/Application Support/Instruments/Templates/`. Source: empirical verification on macOS.
- **Observed:** `xctrace list templates` discovers user templates in a separate `== User Templates ==` section. Source: `xcrun xctrace list templates`.
- **Observed:** Name collisions between standard and user templates produce exit code 30 ("Provided template parameter is ambiguous"). Source: empirical verification.
- **Observed:** CPU Counters template works without GUI preconfiguration in Guided mode with "CPU Bottlenecks" defaults. Source: empirical recording on macOS.
- **Inference:** Probe should use path-based resolution (`--custom-template /path/to/file.tracetemplate`) exclusively to avoid name collision errors.
- **Inference:** TOC-first export discovery works generically for any template, including custom ones. No special schema handling needed.

### 7b. Live simulator validation of the target-process lease path (PRB-096, 2026-07-17)

- **Observed:** ran a real end-to-end `probe session open` (attach-to-running, `dev.probe.fixture`) plus `probe perf record --template time-profiler --time-limit 3s` against a booted simulator (iPhone 17 Pro, iOS 26.4) on the implementation host. The target-process identity check correctly resolved and attached to the live pid ("Attaching to: ProbeFixture (21643)"), and `xctrace record` genuinely wrote a populated `.trace` bundle (`Trace1.run/RunIssues.storedata`) to the session artifact root.
- **Observed:** on this host, that same `xctrace record` process then stalled during its own finalization for several minutes after the 3s recording window closed (CPU time stayed near-zero while wall-clock elapsed climbed past 4 minutes) -- a live reproduction of the exact class of caveat this pack already tracks under "Version-aware caveats and conflicts": xctrace behavior varies by host/Xcode state in ways beyond Probe's control. This is an `xctrace`-side stall, not a Probe defect.
- **Observed:** Probe's own `AppleProcessSupervisor` timeout (`timeLimitMs + recordingOverheadMs` = 243,000 ms for this template) correctly killed the stalled process and surfaced a typed `command-timeout` `ChildProcessError` instead of hanging the daemon forever. The session's own `state` stayed `ready` afterward (PRB-096 AC 7: a profiler failure degrades only the trace lane, never the UI lane), and `probe session close` still tore the session down cleanly on the first try.
- **Inference:** this run is genuine evidence the PRB-096 code path executes correctly against a real Simulator (lease acquisition, fresh pid-identity verification, `xctrace record` invocation, bounded timeout/kill, UI-lane isolation on failure) but is **not** evidence of a *successful* raw capture completing within budget on this host -- the gate this pack's PRB-096 glyph asked to prove ("disable runner HTTP while app lives, raw capture succeeds") stays partial pending a host/Xcode environment where `xctrace` itself finalizes promptly.

### 7c. CoreSimulator reset bounded attempt (PRB-102, 2026-07-18)

The glyph's HOST item authorized one bounded, non-destructive attempt at a
user-level CoreSimulator reset (`xcrun simctl shutdown all`; `killall -9
com.apple.CoreSimulator.CoreSimulatorService` -- no `sudo`, no reboot) to see
whether it clears the finalize stall documented in 7b above, plus one
bounded (max 10 min) 5s `xctrace record` on either side. Both receipts below
are from this pass, same host, same day, `xcrun xctrace` under Xcode 26.6.

- **Before receipt:** a fresh `xctrace record --template "Time Profiler"
  --attach <live ProbeFixture pid> --time-limit 5s` against a simulator that
  was already booted from earlier in this session printed only `Starting
  recording ... Time limit: 5.0 s` and never progressed further. Killed after
  a bounded ~100s wall-clock wait (well short of the historical
  345-731s+ range this pack already documents, deliberately -- this was a
  fresh confirmation the defect still reproduces today, not a full
  re-measurement). CPU time for the `xctrace` process over that window: ~2s
  out of ~100s wall -- the same near-zero-CPU-while-wall-clock-climbs
  signature as every prior stall observation in this pack.
- **Reset performed:** `xcrun simctl shutdown all` (stopped all 3 then-booted
  simulators) followed immediately by `killall -9
  com.apple.CoreSimulator.CoreSimulatorService`. The service restarts on
  demand, as documented; no `sudo`, no reboot, no other destructive action.
- **After receipt:** a freshly booted simulator (same device, cold-booted
  post-reset) and a freshly relaunched `ProbeFixture` process. The very
  first `xctrace record --attach <pid>` attempt immediately after boot
  failed fast with `Cannot find process for provided pid` (exit 21) even
  though the host's own `ps`/`launchctl list` confirmed that exact pid was
  alive at that moment -- plausibly CoreSimulatorService's own device/process
  index not yet warm immediately after a forced restart; not the finalize
  stall this attempt was testing for. A second attempt against the same
  (still live) pid a few seconds later did start recording, ran past the 5s
  window, and then reproduced the identical finalize stall: `Starting
  recording ... Time limit: 5.0 s` with no further output, near-zero CPU
  time (`0:00.01`-`0:05.7` CPU across the whole run), killed at the
  authorized ~10-minute bound (~573s wall-clock, from `2026-07-18T06:50:07Z`
  to `2026-07-18T06:59:40Z`) still stuck in the same phase, never producing
  a completed `.trace` bundle.
- **Verdict: the CoreSimulator reset did not clear the stall.** Both the
  before and after attempts reproduce the identical symptom (near-zero CPU,
  no output past the "Starting recording" line, requires an external kill)
  on this exact host/Xcode combination (26.6/17F113). This is consistent
  with 7b's existing inference that the stall is `xctrace`-side host/Xcode
  state, not something a CoreSimulator service restart reaches -- the
  service was never a live suspect distinct from `xctrace`/Instruments
  itself, and this pass confirms restarting it changes nothing observable.
- **Remaining remediation is the human's, per the glyph's own bound:** the
  next non-destructive lever this pack has not yet tried is a host reboot
  (out of scope for an agent session) or an Xcode/Instruments
  reinstall-and-first-launch pass (`xcodebuild -runFirstLaunch
  -checkForNewerComponents`, itself unlikely to touch `xctrace`'s recording
  finalize path specifically but the next reasonable non-reboot step). No
  further code-side workaround is possible from Probe's side: this is the
  same `AppleProcessSupervisor`-bounded-timeout-and-typed-failure path 7b
  already validated as the correct *handling* of the stall, not a fix for
  the stall itself.

### 8. Target-process lease, decoupled from XCUITest runner health (PRB-096, 2026-07-17)

- **Observed:** `xctrace record --attach <pid> --device <deviceId>` only needs the target app's process id and device identifier -- it never talks to Probe's own XCUITest runner wrapper at all. The runner-coupled preflight (`getSessionHealth`'s `wrapperRunning`/`ready|degraded` gate), the runner keepalive fiber during the recording, and the post-record runner health refresh that used to wrap raw `perf record` were all Probe-side policy, not an xctrace requirement.
- **Decision:** raw `perf record` (`PerfService.record`, `src/services/PerfService.ts`) now gates on a **target-process lease** (`SessionRegistry.beginTraceLease` / `TraceLeaseHandle`, `src/services/SessionRegistry.ts`) -- device, live target pid, bundle, artifact root -- plus a fresh, pre-spawn liveness/identity check immediately before `xctrace record` spawns (`src/services/TargetProcessIdentity.ts`: `ps -p <pid> -o pid=,comm=` for a simulator target, `xcrun devicectl device info processes --filter "processIdentifier == <pid>"` for a device target). Runner health (`wrapperRunning`, `ready`/`degraded` state) is no longer part of the raw record gate; a degraded/failed runner wrapper with a still-live target pid records successfully.
- **Decision:** session health now exposes the trace lane independently via the frozen `SessionResourceState` contract (`resources.trace`: not-requested/starting/ready/degraded/stopping/stopped/failed, already modeled in `src/domain/session.ts` and ARCHITECTURE.md's resource-state contract) instead of borrowing the runner lane's state. A profiler failure moves only `resources.trace`; it never touches `resources.runner` or the derived session `state`.
- **Decision:** `perf around` (`recordAroundFlow`, bounded-flow recording) keeps its existing runner-health gate at the *start* of the recording, because the bounded flow inside it genuinely needs a working runner -- only the raw path relaxed that gate. Its post-flow session-health refresh (needed to report UI/runner state after the flow) is fail-soft: a UI/runner failure there degrades the reported outcome instead of discarding the already-completed trace and its registered artifacts.
- **Inference:** a session close, TTL expiry, runner exit, or daemon shutdown interrupts and joins an active raw trace lease through the same `AppleProcessSupervisor` TERM -> grace -> KILL ladder every other owned child process already uses (`AbortSignal.any([effectSignal, lease.signal])` combined into every `xctrace`/`ps`/`devicectl` invocation inside the lease), instead of orphaning a multi-minute recording when its owning session goes away mid-capture.

#### Path from Instruments.app to Probe recording

1. Open Instruments.app
2. Choose a template or configure custom recording options (e.g., GPU Counters with specific counters)
3. File → Save As Template...
4. Save to the default location (automatically goes to `~/Library/Application Support/Instruments/Templates/`)
5. Note the `.tracetemplate` file path
6. Use with Probe: `probe perf record --custom-template /path/to/MyTemplate.tracetemplate --session-id <id>`
7. **(PRB-097, superseding the eager step this section used to describe.)** Probe records the trace, exports only the TOC, and returns a compact schema catalog (schema names, no per-schema export) -- persisting just the `.trace` bundle and the TOC XML as artifacts under the session root, with zero schema-export subprocesses.
8. No built-in Probe analysis for custom templates. Pull an individual schema on demand with `probe perf export --artifact <trace-key> --schema <schema-name>` (cached by trace + run + schema + XPath + xctrace version), or inspect it further with `probe drill`.

### 9. Trace-first, lazy export/analyze (PRB-097, 2026-07-17)

- **Decision:** `perf record` (`PerfService.record`) stops after the trace + TOC export. It parses the TOC's advertised schema names into a compact catalog (`schemas: [{ schema }]`) and returns; it no longer loops over every schema, exports it, parses it, or runs any analyzer. This applies uniformly to built-in templates and custom templates alike -- there is no compatibility eager path for either.
- **Decision:** two new lazy capabilities replace the eager loop: `perf.export` (one requested schema, or an explicit `--xpath` override, exported on demand) and `perf.analyze` (runs one named built-in analyzer -- `time-profiler` / `system-trace` / `metal-system-trace` / `hangs` / `swift-concurrency` / `logging` -- exporting only the schemas that analyzer's existing, unchanged math needs). Both resolve their target trace from an already-registered trace artifact key, not a live trace lease.
- **Decision:** the TOC itself is still read at export/analyze time, but from the sibling TOC artifact record() already wrote to disk (`${baseName}-toc`, derived from the trace artifact's own key) -- no `xctrace export --toc` subprocess runs a second time unless that sibling artifact or its file is missing, in which case it self-heals by re-deriving the TOC once.
- **Decision:** export caching keys on trace identity (the trace artifact's own key, unique per recording) + run number + schema + XPath + xctrace version (`buildExportCacheKey`, `src/services/PerfService.ts`). A cache hit is verified against the file still existing on disk (not just an index entry) before being trusted, and never reruns `xctrace export`; a miss exports, budget-guards via the existing `ExportBudgetTransform`/`ExportBudget` machinery, and registers the result under the deterministic cache key so the next identical request is a hit.
- **Decision:** `perf.export`'s single explicit schema request always fails closed on a budget overrun (never silently skipped); `perf.analyze`'s per-analyzer schemas keep the original required/optional split -- an optional schema exceeding budget is skipped (partial analysis), a required one fails the whole analyze call.
- **Decision:** cancellation and partial-output cleanup are inherited, not reimplemented -- every lazy export still routes through `runCommandToFile`/`AppleProcessSupervisor` (`src/services/PerfService.ts`, `src/services/AppleProcessSupervisor.ts`), which already (a) removes the partial output file on budget-exceeded/cancelled/timed-out exports (`cleanupOutputFile`, `runCommandToFile`'s catch paths) and (b) TERM -> grace -> KILLs the whole process group, with existing fault tests (`AppleProcessSupervisor.test.ts`: "descendant fault test", "run() cancels via AbortSignal") already proving zero surviving descendants within the 2s bound generically for every command this file spawns, export included. A completed, already-registered trace/TOC is untouched by a later analysis's cancellation because nothing in the export/analyze path ever deletes or mutates the trace/TOC artifacts themselves.
- **Observed (this host, standalone `xcrun xctrace` timing, bypassing Probe's daemon -- see below for why):** against a trivial long-lived target process (`/bin/sh` busy-loop) and the `Time Profiler` template:
  - `xctrace record --time-limit 5s` : ~29.5s wall (the ~24.5s beyond the 5s window is xctrace's own save/finalize step, already tracked above under "Version-aware caveats").
  - `xctrace export --toc` on the resulting trace: ~2.2s wall, TOC advertised 23 schemas (`time-sample`, `thread-state` not present without System Trace, `os-log`, `os-signpost`, `kdebug`, `hang-risks`, etc.).
  - `xctrace export --xpath '.../table[@schema="time-sample"]'` (single schema, 3,048 rows, ~915 KB): ~2.1-2.2s wall, both on a fresh export and a rerun (raw `xcrun xctrace export` has no cache of its own -- Probe's export cache is what turns the second call into a filesystem read instead of a second ~2.2s subprocess).
  - `SIGTERM` to an in-flight `xctrace record --time-limit 30s` at the 3s mark: the process exited within ~1s of the signal (measured wall time from `kill` to `wait` returning: 10 ms for the signal to be delivered and acknowledged by the shell; the process itself was gone from `ps` within the next ~1s poll), leaving an empty `Trace1.run` directory under the target `--output` path and no surviving `xctrace`/`xcrun` process -- consistent with the "children + descendants gone within 2s" bound `AppleProcessSupervisor`'s TERM -> grace -> KILL ladder targets (this ad hoc measurement used a raw `kill -TERM`, not the supervisor itself, but xctrace exits promptly on SIGTERM on this host without needing the grace/KILL escalation at all).
  - Based on these numbers, record()'s new zero-export path (TOC export only, ~2.2s, plus sub-millisecond in-process bookkeeping) should land the p95 gate (terminal response within 5s of xctrace exit) comfortably.
- **Blocked (this host, live daemon+simulator round trip):** attempting the full ten-pinned-30s-run p95 benchmark through the real daemon (`probe serve` + `probe session open --target simulator` + ten `probe perf record --time-limit 30s` calls) failed before a single recording started -- `session open` and even a plain `session health` on a freshly opened, `ready`-per-`session list` session both returned a client-side `rpc-client-transport-closed` error (the daemon-side socket closed mid-request) on two independent attempts (a stale daemon and a fully fresh `probe serve` + fresh session). This reproduced identically on a clean daemon, so it is not this glyph's session-state corruption. `ps` at the time of the second failure showed a **second, independent Tower worker actively building/running XCUITest against a separate booted Simulator device on the same host** (`PRB-092`'s worktree, `xcodebuild ... -scheme ProbeRunner ... test-without-building`) -- concurrent multi-agent Simulator/Xcode/CoreSimulator contention on a shared host is the most likely cause, not a code defect in `perf.record`'s session-open path (which this glyph's diff does not touch: `SessionRegistry.ts`, `SessionController.ts`, and `ios/` are unmodified by PRB-097). The p95 gate stays **partial**: the dominant cost component (TOC export) is directly measured above and comfortably clears the 5s budget, but the actual RPC round trip through the live daemon was not exercised end-to-end in this session.
