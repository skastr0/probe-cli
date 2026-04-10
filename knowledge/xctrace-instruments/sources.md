# xctrace + Instruments sources

Updated: 2026-04-10

## Existing adjacent packs checked first

- `knowledge/README.md`
  - Used for pack shape and the requirement to separate observed facts from inferred guidance.
- `knowledge/lldb-python/open-questions.md`
  - Already notes unresolved coexistence risk between LLDB, the runner, and future `xctrace` work.
- No existing `knowledge/xctrace*` or `knowledge/*instruments*` pack was present.

## Local primary sources observed against the current toolchain

- Local Xcode version
  - `xcodebuild -version`
  - Observed value: `Xcode 26.3` (`Build version 17C529`)
- Local `xctrace` version
  - `xcrun xctrace version`
  - Observed value: `xctrace version 26.0 (17C529)`
- Local command help
  - `xcrun xctrace help`
  - `xcrun xctrace help record`
  - `xcrun xctrace help import`
  - `xcrun xctrace help export`
  - `xcrun xctrace help remodel`
  - `xcrun xctrace help symbolicate`
  - `xcrun xctrace help list`
- Local capability discovery
  - `xcrun xctrace list devices`
  - `xcrun xctrace list templates`
  - `xcrun xctrace list instruments`
- Local man page
  - `man xctrace`

## Empirical local trace sources added by the schema-mapping spike

- Existing fixture/simulator path reused
  - `./ios/ProbeFixture/scripts/validate-simulator.sh`
  - Followed by explicit `simctl launch` to capture the live fixture pid for `xctrace record --attach`
- Local recorded sample traces against `dev.probe.fixture` on the iPhone 17 Pro Simulator
  - `xcrun xctrace record --template "Time Profiler" --device <UDID> --attach <pid> --time-limit 5s --output <trace> --no-prompt`
  - `xcrun xctrace record --template "Metal System Trace" --device <UDID> --attach <pid> --time-limit 5s --output <trace> --no-prompt`
  - `xcrun xctrace record --template "Swift Concurrency" --device <UDID> --attach <pid> --time-limit 5s --output <trace> --no-prompt`
  - `xcrun xctrace record --template "Logging" --device <UDID> --attach <pid> --time-limit 5s --output <trace> --no-prompt`
  - `xcrun xctrace record --template "System Trace" --device <UDID> --attach <pid> --time-limit 5s --output <trace> --no-prompt`
  - `xcrun xctrace record --template "Network" --device <UDID> --attach <pid> --time-limit 5s --output <trace> --no-prompt`
- Local export steps used for schema discovery
  - `xcrun xctrace export --input <trace> --toc`
  - `xcrun xctrace export --input <trace> --xpath '/trace-toc/run[@number="1"]/data/table[@schema="<schema-name>"]'`
- Durable repo artifacts from that empirical run
  - `knowledge/xctrace-instruments/schema-spike-results.json`
  - `knowledge/xctrace-instruments/schema-inventory.md`
  - `knowledge/xctrace-instruments/fixture-*.toc.xml`
  - `knowledge/xctrace-instruments/record-schema-spike.py`

## Apple documentation and Apple-hosted primary supporting sources

- Xcode command-line tool reference
  - https://developer.apple.com/documentation/xcode/xcode-command-line-tool-reference
  - Used as the current Apple entry point that positions `xctrace` as the supported CLI for `.trace` management and points to `man xctrace` for details.
- Profiling apps using Instruments
  - https://developer.apple.com/tutorials/instruments
  - Used for Apple’s current high-level Instruments learning hub and links to related performance-analysis docs.
- Recording Performance Data
  - https://developer.apple.com/documentation/os/recording-performance-data
  - Used for Apple’s current signpost + Blank template workflow and for the expectation that Instruments tables can be reviewed after recording.
- Instruments Overview
  - https://help.apple.com/instruments/mac/current/#/dev7b09c84f5
  - Used for Apple Help statements that Instruments is a separate app, can profile simulator or physical devices, and can save instrument configurations as templates.
- Instruments Help hub
  - https://help.apple.com/instruments/mac/current/
  - Used as the current Apple Help entry point for GUI-side workflows.
- Instruments Developer Help: Address Backtrace Engineering Type
  - https://help.apple.com/instruments/developer/mac/current/#/dev15401019
  - Used for Apple Help wording about compressed versus extended backtrace display and the encoded `backtrace` structure.
- Foundation `XMLNode.xPath`
  - https://developer.apple.com/documentation/foundation/xmlnode/xpath
  - Used as Apple’s XPath reference point for Probe-side XML querying and extractor implementation.

## Apple Developer Forums threads with engineer answers

- Instruments: Retrieving the xpath of a timeline
  - https://developer.apple.com/forums/thread/700733
  - Used for the Apple-engineer workflow that maps GUI Inspector tables to `xctrace export --toc` schema names and `--xpath` selections.
- Cannot get CPU profile via xctrace
  - https://developer.apple.com/forums/thread/705565
  - Used for the Apple-engineer caveat that `CPU Counters` must be preconfigured and saved as a custom template before useful CLI recording.
- xctrace(xcode-beta) export, sample schema needed for help
  - https://developer.apple.com/forums/thread/661295
  - Used for the Apple-engineer statement that older `xctrace export` did not support Leaks / Allocations because of different recording technology.
- Export Allocations and other instruments with `xcrun xctrace export --xpath`
  - https://developer.apple.com/forums/thread/664347
  - Used for the Apple-engineer confirmation of the older limitation, plus a later community follow-up showing newer XPath shapes for Allocations / Leaks.
- Export full callstack/backtrace with `xctrace export`
  - https://developer.apple.com/forums/thread/708957
  - Used for the unresolved full-backtrace export caveat and later community claim that schema choice changed in newer Xcode.

## Release notes used for version-specific capability changes

- Xcode 13 Release Notes
  - https://developer.apple.com/documentation/xcode-release-notes/xcode-13-release-notes
  - Used for the Apple-documented addition of `xctrace export` table data for Allocations / Leaks / VM Tracker, `--har` export support, and removal of the old `instruments` CLI.
- Xcode 26 Release Notes
  - https://developer.apple.com/documentation/xcode-release-notes/xcode-26-release-notes
  - Used for the Apple-documented addition of `xctrace record --run-name` and `.trace` container attachment behavior.
- Xcode 26.4 Release Notes
  - https://developer.apple.com/documentation/xcode-release-notes/xcode-26_4-release-notes
  - Used for the Apple-documented `Import As Run…` workflow and `xctrace import --append-run` support.

## Source quality notes

- Installed `xctrace` help, `list` output, and the local man page are treated as the primary source for the **current machine’s exact command surface**.
- Apple docs and Apple Help are treated as the primary source for **workflow shape, product framing, and GUI behavior**.
- Apple Developer Forums posts from Apple engineers are treated as **high-signal caveat clarifications**, but some are version-specific and may be superseded by later release notes.
- Community follow-ups inside forum threads are useful for hypothesis generation, but Probe should treat them as lower-confidence until validated on the target Xcode version.
