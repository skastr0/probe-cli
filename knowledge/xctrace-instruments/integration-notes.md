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
