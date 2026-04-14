# xctrace + Instruments open questions

Updated: 2026-04-10

## Open validation questions

1. **What remains after the initial schema-mapping closure on Xcode 26.3?**
   - The initial Simulator-backed spike closed the first pass for `Time Profiler`, `Metal System Trace`, `Swift Concurrency`, `Logging`, and `System Trace`, with durable TOCs and schema excerpts saved under `knowledge/xctrace-instruments/`.
   - Remaining work is no longer “does any schema exist?” but rather:
     - which schemas are populated under richer workloads
     - which surfaces differ on real devices
     - which metric families deserve first-class Probe extractors

2. **How reliable is `xctrace record --attach` for already-running iOS simulator and real-device app processes?**
   - The command surface supports attach by pid or name.
   - Forum evidence shows some attach / record combinations can hang or destabilize collection, especially with `CPU Counters`.

3. **What is the exact schema/query Probe should use for full call-stack export on current Xcode versions?**
   - Apple Help documents compressed vs extended backtrace display.
   - The reviewed sources do not settle whether full stack reconstruction should come from `time-profile`, `time-sample`, another schema, or an alternate post-processing path.

4. **What is the current export shape for Allocations / Leaks / VM Tracker on Xcode 26.3?**
   - Older Apple-engineer forum answers say they were unsupported.
   - Xcode 13 release notes say table export support was added.
   - A later community forum reply suggests `tracks/track/details/detail` XPath shapes.
   - Probe still needs direct validation on current traces.

5. ~~**How should Probe provision or discover custom templates that require GUI preconfiguration?**~~ **RESOLVED (2026-04-14)**
   - `xctrace record --template` accepts filesystem paths directly — no template registration needed.
   - User templates are `.tracetemplate` files at `~/Library/Application Support/Instruments/Templates/`.
   - CPU Counters works without GUI preconfiguration in Guided mode. GUI setup only needed for specific counter selections.
   - Probe exposes `--custom-template <path>` as a separate CLI flag. TOC-first discovery handles export schemas generically.
   - Path collision between standard and user template names produces exit 30 — Probe uses path-based resolution exclusively.

6. **Should Probe rely on import workflows as part of the first profiling slice?**
   - `xctrace import` exists now, and Xcode 26.4 adds `--append-run`.
   - The current local toolchain does not yet expose `--append-run`, so multi-run import workflows are version-sensitive.

7. **What output contract should Probe expose for schema exports versus HAR exports?**
   - `xctrace export` supports both XML and HAR depending on trace contents.
   - The current Simulator spike showed HAR-related schema names in a failed Network trace, but it did not produce a usable HAR artifact because Network Connections are unsupported on Simulator.
   - Probe still needs a command-level contract for when to return XML-derived summaries, HAR artifacts, or only raw `.trace` references.

## Immediate risks for later Probe items

- Probe could accidentally record the host Mac instead of the intended iOS target if it omits `--device`.
- Probe could assume every visible template is safely automatable when some require GUI preconfiguration or have version-specific export quirks.
- Probe could over-promise stable schema names or full backtrace reconstruction before validating the actual exported XML on current Xcode versions.
- Probe could misread older forum limitations as still-current behavior, or misread newer release-note features as available on older local Xcode builds.
- Probe could treat local help/man wording as perfectly consistent even though the current toolchain already shows several documentation mismatches.
- Probe could treat Simulator-only schema visibility as equivalent to end-to-end availability, especially for Network and other hardware- or target-dependent instruments.
