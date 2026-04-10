# xctrace + Instruments API notes

Accessed: 2026-04-09

Legend:

- **Observed** = directly supported by a cited source.
- **Inference** = derived for Probe and called out as such.

## 1. Core command surface

- **Observed:** Apple’s Xcode command-line tool reference positions `xctrace` as the supported CLI to “record, import, export and symbolicate Instruments .trace files” and directs users to `man xctrace` for details. Source: _Xcode command-line tool reference_.
- **Observed:** The installed `xctrace` exposes these top-level commands:
  - `record`
  - `import`
  - `export`
  - `remodel`
  - `symbolicate`
  - `list [devices|templates|instruments]`
  - `version`

  Source: `xcrun xctrace help`.

- **Observed:** Xcode 13 release notes say the deprecated `instruments` CLI was removed and `xctrace` is the replacement. Source: _Xcode 13 Release Notes_.

## 2. Recording options and target selection

- **Observed:** `xctrace record` supports:
  - `--output <path>`
  - `--append-run`
  - `--run-name <name>`
  - `--template <path|name>`
  - `--device <name|UDID>`
  - `--instrument <name>`
  - `--time-limit <time[ms|s|m|h]>`
  - `--window <duration[ms|s|m]>`
  - `--package <file>`
  - `--all-processes`
  - `--attach <pid|name>`
  - `--launch -- command [arguments]`
  - `--target-stdin <name>`
  - `--target-stdout <name>`
  - `--env <VAR=value>`
  - `--notify-tracing-started <name>`
  - `--no-prompt`

  Source: `xcrun xctrace help record`, `man xctrace`.

- **Observed:** If no output path is specified, `xctrace record` creates a uniquely named `.trace` file in the current directory. If the output path is a directory, it creates a unique file inside it. If the path already exists as a `.trace`, `--append-run` is required and the existing trace’s template is reused. Source: `xcrun xctrace help record`, `man xctrace`.
- **Observed:** If `--device` is omitted, recording defaults to the host device. Source: `xcrun xctrace help record`, `man xctrace`.
- **Observed:** `--window` configures windowed / ring-buffer recording where older events are dropped to make room for newer ones. Source: `man xctrace`.
- **Observed:** Stream redirection and environment-variable injection apply to launched processes, not general attach mode. Source: `xcrun xctrace help record`.
- **Observed:** `--run-name` is present in the local toolchain, and Xcode 26 release notes say run naming was added for `xctrace record`. Sources: `xcrun xctrace help record`, _Xcode 26 Release Notes_.

## 3. Device discovery behavior

- **Observed:** `xcrun xctrace list devices` on the current machine emits both a host Mac entry and simulator entries. Source: `xcrun xctrace list devices`.
- **Observed:** The local man page says `list devices` lists “non-host devices,” which conflicts with the current tool output that includes the host Mac. Sources: `man xctrace`, `xcrun xctrace list devices`.
- **Observed:** The local current output shape is grouped under:
  - `== Devices ==`
  - `== Simulators ==`

  Source: `xcrun xctrace list devices`.

## 4. Template and instrument discovery

- **Observed:** `xcrun xctrace list templates` currently reports these standard templates:
  - `Activity Monitor`
  - `Allocations`
  - `Animation Hitches`
  - `App Launch`
  - `Audio System Trace`
  - `CPU Counters`
  - `CPU Profiler`
  - `Core ML`
  - `Data Persistence`
  - `File Activity`
  - `Game Memory`
  - `Game Performance`
  - `Game Performance Overview`
  - `Leaks`
  - `Logging`
  - `Metal System Trace`
  - `Network`
  - `Power Profiler`
  - `Processor Trace`
  - `RealityKit Trace`
  - `Swift Concurrency`
  - `SwiftUI`
  - `System Trace`
  - `Tailspin`
  - `Time Profiler`

  Source: `xcrun xctrace list templates`.

- **Observed:** `xcrun xctrace list instruments` exposes a broader set of current recording building blocks including `HTTP Traffic`, `Points of Interest`, `os_log`, `os_signpost`, `GPU`, `Time Profiler`, `Swift Actors`, `Swift Tasks`, `Metal GPU Counters`, `Thread State Trace`, `Runloops`, `Hitches`, `Hangs`, `VM Tracker`, and `Virtual Memory Trace`. Source: `xcrun xctrace list instruments`.
- **Observed:** A template name passed to `--template` must be either:
  - bundled with Instruments.app
  - bundled in an installed Instruments package
  - installed into Instruments’ Application Support directory

  Source: `man xctrace`.

- **Observed:** `--instrument <name>` can be used during `record` and `import` to add an instrument to the configuration. Source: `xcrun xctrace help record`, `xcrun xctrace help import`, `man xctrace`.
- **Observed:** Instruments Help says instrument configurations can be saved as templates. Source: _Instruments Overview_.

## 5. Export modes, TOC structure, and XPath selection

- **Observed:** `xctrace export` supports three export selectors in the current toolchain:
  - `--toc`
  - `--xpath <expression>`
  - `--har`

  Source: `xcrun xctrace help export`, `man xctrace`.

- **Observed:** `--toc` exports the trace table of contents and is the documented discovery step for exportable entities. Source: `xcrun xctrace help export`, `man xctrace`.
- **Observed:** `--xpath` runs an XPath query against the TOC and exports the selected entities as XML. Source: `xcrun xctrace help export`, `man xctrace`.
- **Observed:** `--har` exports an HTTP Archive when the trace run contains the HTTP Traffic instrument. Sources: `xcrun xctrace help export`, `man xctrace`, _Xcode 13 Release Notes_.
- **Observed:** Apple’s local man page examples show these stable query shapes:
  - `/trace-toc/run[@number="1"]/data/table[@schema="my-table-schema"]`
  - `/trace-toc/run[@number="1"]/processes`
  - `/trace-toc/run[@number="1"]/processes/process[@name="my-process-name"]`

  Source: `man xctrace`.

- **Observed:** An Apple engineer says the Instruments GUI path `Document -> Inspector` exposes the same schema names shown in `xctrace export --toc`, and those schema names can be used directly in `--xpath`. Source: Apple Developer Forums thread 700733.
- **Observed:** The same Apple engineer example maps Metal “Wire Memory” GUI data to the `metal-driver-event-intervals` table and exports it with:

  ```text
  /trace-toc/run[@number="1"]/data/table[@schema="metal-driver-event-intervals"]
  ```

  Source: Apple Developer Forums thread 700733.

- **Observed:** Apple Help’s backtrace engineering-type page says the `backtrace` field is structured, encoded from process + fragment values, and “typically shows a compressed format” while “extended views” show the full symbolicated backtrace. Source: _Address Backtrace Engineering Type_.
- **Observed:** There is an inconsistency between the installed local help and man page: `xcrun xctrace help export` correctly describes export behavior, while the `man xctrace` section header text for `export` appears to repeat the recording description before listing the correct export flags. Sources: `xcrun xctrace help export`, `man xctrace`.

## 6. Import, remodel, and symbolication surfaces

- **Observed:** `xctrace import` creates a `.trace` from a supported input file and can optionally apply a template, instruments, and a temporary Instruments package. Source: `xcrun xctrace help import`, `man xctrace`.
- **Observed:** Some importable file types have a default template, and Apple warns that the default template for a given import-file UTI may change between releases. Source: `xcrun xctrace help import`.
- **Observed:** The installed man page examples show `.logarchive` and `.ktrace` as importable source formats. Source: `man xctrace`.
- **Observed:** Apple engineer guidance also names `.sample` as an importable format. Source: Apple Developer Forums thread 705565.
- **Observed:** `xctrace remodel` regenerates a trace using currently installed modelers and can load a temporary package for the operation. Source: `xcrun xctrace help remodel`, `man xctrace`.
- **Observed:** `xctrace symbolicate` can use a specific dSYM path or recursively search a directory of dSYMs; without `--dsym`, it makes a best effort to locate relevant dSYMs. Source: `xcrun xctrace help symbolicate`, `man xctrace`.

## 7. Version-specific export and import behavior

- **Observed:** Xcode 13 release notes say trace table export was added for Allocations, Leaks, and VM Tracker, and that `xctrace export --toc` would reflect this. Source: _Xcode 13 Release Notes_.
- **Observed:** Xcode 13 release notes say HTTP data can be exported as HAR via `xctrace` using the `--har` flag. Source: _Xcode 13 Release Notes_.
- **Observed:** Xcode 26.4 release notes say imported files can be added into the same trace document as separate runs via `File -> Import As Run…`, and that `xctrace import --append-run` was added for CLI parity. Source: _Xcode 26.4 Release Notes_.
- **Observed:** The local installed `xcrun xctrace help import` for Xcode 26.3 does **not** include `--append-run`, so this capability is newer than the currently installed toolchain. Sources: `xcrun xctrace help import`, _Xcode 26.4 Release Notes_.

## 8. Known template and export caveats

- **Observed:** Apple engineer guidance says `CPU Counters` does not record useful events by default and must be preconfigured in Instruments.app, then saved as a custom template before CLI use. Source: Apple Developer Forums thread 705565.
- **Observed:** The same thread contains a later Apple-engineer request for feedback plus `sample xctrace` and sysdiagnose artifacts when `CPU Counters` hangs, which means the hang case was not resolved in-thread. Source: Apple Developer Forums thread 705565.
- **Observed:** Older Apple-engineer forum answers (2020) said Leaks / Allocations / VM Tracker could not be exported because they used a different recording technology. Sources: Apple Developer Forums threads 661295 and 664347.
- **Observed:** Those older forum answers are at least partially version-bound, because Xcode 13 release notes later say Allocations / Leaks / VM Tracker table export was added. Source: _Xcode 13 Release Notes_.
- **Observed:** A later community follow-up in thread 664347 claims newer traces can export Allocations and Leaks through:
  - `/trace-toc/run[@number="1"]/tracks/track[@name="Allocations"]/details/detail[@name="Allocations List"]`
  - `/trace-toc/run[@number="1"]/tracks/track[@name="Leaks"]/details/detail[@name="Leaks"]`

  Source: Apple Developer Forums thread 664347 (community reply; not Apple-authored).

- **Observed:** A later community follow-up in thread 708957 claims Xcode 14.3 exported fuller call stacks when querying `time-profile` instead of `time-sample`. Source: Apple Developer Forums thread 708957 (community reply; not Apple-authored).
- **Observed:** The local `record` help lists `--device <name|UDID>`, but its own examples still use `--device-name`, which is a documentation inconsistency worth treating cautiously in automation docs. Source: `xcrun xctrace help record`.
