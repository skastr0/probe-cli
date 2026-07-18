# device-thermal-state-intervals — thermal channel findings (PRB-098)

Accessed: 2026-07-18

Legend:

- **Observed** = directly supported by a cited source (Apple doc, Apple-hosted page, or a
  command actually executed on this host in this session).
- **Inference** = derived for Probe and called out as such.

This file is the research-first gate required before PRB-098 implements the thermal
channel: official-source findings plus empirical TOC/export inspection, so Probe never
implements thermal handling from assumption.

## 0. Environment this research ran against

- **Observed:** `xcodebuild -version` → `Xcode 26.6` / `Build version 17F113`. Source: local
  `xcodebuild -version`.
- **Observed:** `xcrun xctrace version` → `xctrace version 16.0 (17F113)`. Source: local
  `xcrun xctrace version`.
- **Observed:** `sw_vers` → `macOS 26.4.1` / `BuildVersion 25E253`. Source: local `sw_vers`.
- **Inference:** This is a *different, newer* Xcode build than `schema-inventory.md`'s
  `Xcode 26.3 (17C529)` spike. `xctrace version` reporting `16.0` while `xcodebuild -version`
  reports `26.6` is a real observed inconsistency between the two version strings on the
  same toolchain — do not assume `xctrace version`'s major number tracks the Xcode marketing
  version.

## 1. Schema shape — empirically validated on this host

- **Observed:** A host self-attach recording (`xcrun xctrace record --template "Time Profiler"
  --attach <pid-of-a-local-sleep-process> --time-limit 3s --no-prompt --output
  host-selftrace.trace`, run against the local Mac, not a Simulator or iOS device) produced a
  TOC containing:

  ```
  <table schema="device-thermal-state-intervals" documentation="Denotes the current thermal state of the device."/>
  ```

  Source: local command, TOC saved at
  `knowledge/xctrace-instruments/fixture-host-selftrace.toc.xml`.

- **Observed:** Exporting that table
  (`xcrun xctrace export --input host-selftrace.trace --xpath
  '/trace-toc/run[@number="1"]/data/table[@schema="device-thermal-state-intervals"]'`) returned
  a populated schema block plus one row for the whole 3 s recording window:

  ```
  <schema name="device-thermal-state-intervals" documentation="Denotes the current thermal state of the device.">
    <col><mnemonic>start</mnemonic><name>Start</name><engineering-type>start-time</engineering-type></col>
    <col><mnemonic>duration</mnemonic><name>Duration</name><engineering-type>duration</engineering-type></col>
    <col><mnemonic>end</mnemonic><name>End</name><engineering-type>start-time</engineering-type></col>
    <col><mnemonic>thermal-state</mnemonic><name>Thermal State</name><engineering-type>thermal-state</engineering-type></col>
    <col><mnemonic>track-label</mnemonic><name>Track</name><engineering-type>string</engineering-type></col>
    <col><mnemonic>is-induced</mnemonic><name>Is Induced</name><engineering-type>boolean</engineering-type></col>
    <col><mnemonic>narrative</mnemonic><name>Narrative</name><engineering-type>narrative</engineering-type></col>
  </schema>
  <row>
    <start-time fmt="00:00.000.000">0</start-time>
    <duration fmt="4.14 s">4135359048</duration>
    <start-time fmt="00:04.135.359">4135359048</start-time>
    <thermal-state fmt="Fair">Fair</thermal-state>
    <string fmt="Current">Current</string>
    <boolean fmt="No">0</boolean>
    <narrative fmt="Fair  thermal state">…</narrative>
  </row>
  ```

  Source: local command, saved at
  `knowledge/xctrace-instruments/fixture-host-selftrace.device-thermal-state-intervals.xml`.

- **Observed columns** (mnemonic / display name / engineering-type):
  - `start` / Start / `start-time`
  - `duration` / Duration / `duration`
  - `end` / End / `start-time` (an absolute timestamp, not a duration — same engineering-type
    as `start`)
  - `thermal-state` / Thermal State / `thermal-state` (a dedicated engineering type; the fmt
    string on this host was `Fair`)
  - `track-label` / Track / `string` (observed value `Current` on this single-track macOS
    host; **unvalidated** whether iOS devices expose multiple tracks, e.g. per-die or
    per-component)
  - `is-induced` / Is Induced / `boolean` (observed `No`/`0` for a naturally-occurring
    reading — see §3 for why this column exists)
  - `narrative` / Narrative / `narrative` (a composed human-readable sentence, references the
    `thermal-state` cell by `ref`)
- **Observed:** No `process`/`pid`/`target-pid` mnemonic or table attribute exists on this
  schema — matches `fixture-time-profiler.toc.xml`, `fixture-system-trace.toc.xml`, and
  `fixture-metal-system-trace.toc.xml` (from the earlier Simulator spike), where
  `<table schema="device-thermal-state-intervals"/>` carries no `target-pid` attribute unlike
  neighboring tables (`time-sample`, `thread-state`). **Inference:** this channel is
  device-wide, not scoped to Probe's target process — Probe must not filter or attribute it to
  a single app/pid the way `analyzeSystemTraceTables` does for `thread-state`/`cpu-state`.
- **Inference:** the "one row per unbroken interval of a single thermal state" shape means an
  idle/short recording legitimately yields **one row spanning the whole window**, not zero
  rows — zero rows is a *different* signal (the table/channel truly did not populate) from a
  single wide "nominal/fair" row. Probe's "missing/empty means unavailable, never nominal"
  rule must key off row *and table* presence, not off the specific thermal-state value found.

## 2. State values

- **Observed (Apple-hosted, archived Mac-focused power-efficiency guide, fetched this
  session):** `NSProcessInfoThermalState` defines four levels — `Nominal`, `Fair`, `Serious`,
  `Critical` — with per-level impact and recommended-action text. Source:
  https://developer.apple.com/library/archive/documentation/Performance/Conceptual/power_efficiency_guidelines_osx/RespondToThermalStateChanges.html
  (an archived macOS-oriented guide; the four state names match the public
  `ProcessInfo.ThermalState` Swift enum surface used across Apple platforms including iOS).
- **Observed (this host, this session):** the xctrace `thermal-state` cell's `fmt` value for a
  real reading was the string `Fair` — i.e. the exported display text uses the same
  capitalized state names as `ProcessInfo.ThermalState`, not numeric raw values, in the `fmt`
  attribute. The cell's raw text content was also `Fair` (not a numeric code) in this export.
- **Unvalidated:** whether `xctrace`'s raw (non-`fmt`) value is ever numeric on other
  toolchain versions, and whether iOS-device exports use the identical four state names.
  Probe's parser must treat `thermal-state` as an opaque display string and pass through
  whatever `Nominal`/`Fair`/`Serious`/`Critical` (or an unrecognized value) xctrace reports,
  never inferring or defaulting a state.

## 3. `is-induced` — Apple's own real/simulated distinction, and the CLI automation wall

- **Observed:** the schema carries a first-class `is-induced` boolean column. **Inference:**
  this exists because Apple's Xcode "Device Conditions" feature can *simulate* thermal state
  (safely, without physically heating the device) system-wide, and Instruments distinguishes
  an induced reading from a naturally observed one in the same table.
- **Observed (Apple-hosted, fetched this session):** Device Conditions / thermal-state
  simulation is invoked from Xcode's **Devices and Simulators** window (⇧⌘2 → Window →
  Devices and Simulators → **Device Conditions** section → **Start**), is described as
  system-wide once started, and ramps up over time rather than applying instantly. Source:
  https://bleepingswift.com/blog/simulating-device-conditions-in-xcode (community writeup;
  the GUI panel name and location match Apple's documented Xcode window, but this specific
  page is not an Apple-hosted primary source — treat as a corroborating secondary source, not
  the same confidence tier as the Apple `power_efficiency_guidelines_osx` page in §2).
- **Observed (this session, local toolchain):** neither `xcrun simctl help` nor
  `xcrun devicectl device --help` (nor any subcommand tree under `devicectl device`) exposes a
  thermal/condition-simulation verb on this Xcode 26.6 toolchain. Source: local
  `xcrun simctl help`, `xcrun devicectl --help`, `xcrun devicectl device --help`.
- **Conclusion (grounds the superseding research-first gate):** thermal-state simulation is a
  documented, Apple-supported, non-destructive mechanism — but it is **GUI-only** on the
  current toolchain. There is no `xcrun`/`simctl`/`devicectl`/`xctrace` verb that lets a
  headless CLI tool like Probe drive it. Probe cannot script a "safe reproducible public
  ramp/recovery method" for thermal state without embedding an Xcode GUI automation dependency
  that is out of scope for this glyph (and was excluded by the glyph's own Exclusions:
  "unsafe thermal induction"). This is the basis for shipping the thermal channel as typed
  **unavailable-by-construction for CLI-driven capture**, never fabricating a state.

## 4. Physical-device and Simulator capture attempts this session (durable capability wall)

- **Attempt 1 — physical device.** `xcrun devicectl device info details --device
  9FE1EE68-650B-590A-B131-48E1575FBE5A` (the paired "iPhone (2)", iPhone 13 Pro) returned
  `WARNING: Unable to retrieve complete information for this device. … Error: The operation
  couldn't be completed. (Network.NWError error 60 - Operation timed out)`. A subsequent
  `xcrun xctrace record --device 00008110-0006293936C0401E --template "System Trace"
  --all-processes --time-limit 5s --output …` reported `Timed out waiting for device to
  boot: iPhone (2) (26.5.2)`. **Result: physical device unreachable in this environment** —
  matches the task's stated "2 devices visible to devicectl but no reachable signing/session
  path on this host" constraint. No temperature was read, fabricated, or assumed.
- **Attempt 2 — Simulator, `--all-processes`.** `xcrun xctrace record --device <booted iPhone
  17 Pro simulator UDID> --template "System Trace" --all-processes --time-limit 3s
  --no-prompt --output …` did not complete within 20+ minutes of wall time in this sandboxed,
  windowless CLI session (process observed alive via `ps`, CPU time barely advancing) and was
  killed.
- **Attempt 3 — Simulator, `--attach <pid>`.** Same result: `xcrun xctrace record --device
  <same simulator> --template "System Trace" --attach <SpringBoard pid> --time-limit 3s
  --no-prompt --output …` also failed to reach "Reached specified time limit" within the
  observation window and was killed.
- **Control — host self-attach.** `xcrun xctrace record --template "Time Profiler" --attach
  <local sleep pid> --time-limit 3s --no-prompt --output …` (no `--device`, so it targets the
  host Mac, not a Simulator or iOS device) **completed normally** in a few seconds and
  produced the export used throughout §1–§3.
- **Inference:** the hang is specific to establishing an Instruments recording session
  *against a Simulator or paired iOS device* from this headless, windowless sandbox — likely
  because Simulator/device tracing needs a WindowServer-backed Instruments/DVT session that
  this environment does not provide, not a defect in `xctrace` itself (the host-attach control
  proves the binary and this session's permissions can complete a real recording end to end).
  This is a environment capability wall for *this sandbox*, not a Probe-code defect and not
  evidence about real end-user machines running Probe interactively.

## 5. Net finding for PRB-098's thermal channel

- Ship `device-thermal-state-intervals` as a **typed, real channel** in the evidence report
  schema (columns above), parsed generically through the existing `parsePerfTableExport` /
  `ParsedPerfTable` machinery — no thermal-specific XML parsing path needed, the generic
  parser already handles this schema shape (validated in §1).
- Table absent from TOC, or present but zero exported rows → channel status
  `"unavailable"` with a reason string. **Never** synthesize `"Nominal"` or any other state for
  an absent/empty table.
- Table present with ≥1 row → channel status `"available"`; surface each row's `thermal-state`
  display value, window (`start`/`end`), `track-label`, and `is-induced` verbatim, and let
  findings built on top of it flag `is-induced === true` observations as lower-trust/
  simulation-tainted rather than a naturally occurring thermal excursion.
- No safe, CLI-scriptable physical or simulated ramp/recovery method exists for Probe today
  (§3). Physical capture was attempted for a durable receipt (§4) and is blocked on
  environment/device reachability, not on missing implementation. This satisfies the
  glyph's superseding conditional gate: research established there is **no** safe reproducible
  method available to this CLI, so the physical/simulated thermal-ramp acceptance clause is
  unmet-by-design and the capability wall above is the required durable substitute.

## 6. Cross-references

- `knowledge/xctrace-instruments/fixture-host-selftrace.toc.xml` — full TOC from the host
  self-attach control recording.
- `knowledge/xctrace-instruments/fixture-host-selftrace.device-thermal-state-intervals.xml` —
  the real schema + row export analyzed in §1–§3.
- `knowledge/xctrace-instruments/schema-inventory.md` — the earlier Simulator-backed spike
  that first observed `device-thermal-state-intervals` in the TOC for `Time Profiler`,
  `System Trace`, and `Metal System Trace` (Xcode 26.3, 17C529) without exporting or
  populating it.
- `knowledge/xctrace-instruments/open-questions.md` — question 2 (attach reliability) is now
  partially answered for Simulator targets in a headless sandbox: see §4.
