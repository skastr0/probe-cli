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
7. Probe records the trace, exports TOC and all discovered schemas, persists artifacts under the session root
8. No built-in Probe analysis — use `probe drill` to inspect individual schema exports
