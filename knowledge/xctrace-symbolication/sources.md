# Time-sample leaf PC → symbol sources

Updated: 2026-07-28

## Existing packs reused

- `knowledge/xctrace-instruments/` — export surface, TOC/XPath, `time-sample` / `kperf-bt`, open Q on full stacks
- `src/domain/perf.ts` — leaf PC extraction from `cp-user-callstack` / `cp-kernel-callstack`
- `src/test-fixtures/perf/time-profiler.time-sample.xml` — concrete `kperf-bt` shape with decimal PCs + `fmt="PC:0x…"`

## Local / primary Apple tooling

- `man atos` (via public Xcode man mirror) — `atos -o <binary|dSYM> -arch <arch> -l <load-address> [-f addrs.txt] <addr…>`
- `man xctrace` — `export --toc|--xpath|--har`, `symbolicate --dsym`, examples for `/processes` image export
- Probe empirical TOC: `knowledge/xctrace-instruments/fixture-time-profiler.toc.xml`
  - Simulator process path is host-readable: `…/CoreSimulator/Devices/<udid>/data/Containers/Bundle/Application/…/App.app/Binary`

## Apple docs

- [Adding identifiable symbol names to a crash report](https://developer.apple.com/documentation/xcode/adding-identifiable-symbol-names-to-a-crash-report) — atos with dSYM + load address
- [Investigating memory access crashes](https://developer.apple.com/documentation/xcode/investigating-memory-access-crashes) — worked `atos -arch arm64 -o ….dSYM/…/DWARF/… -l <load> <pc>`
- [Symbolication: Beyond the basics (WWDC21)](https://developer.apple.com/videos/play/wwdc2021/10211/) — load address vs linker address, ASLR slide, `atos -l` / `-i`
- [Address Backtrace Engineering Type](https://help.apple.com/instruments/developer/mac/current/#/dev15401019) — compressed vs extended backtrace display
- [Xcode command-line tool reference](https://developer.apple.com/documentation/xcode/xcode-command-line-tool-reference) — xctrace as supported CLI for record/export/symbolicate

## Forums / community (hypothesis until revalidated)

- [Export full callstack/backtrace with xctrace export](https://developer.apple.com/forums/thread/708957) — older wall on full stacks; community claim Xcode 14.3+ `time-profile` improves names
- Ben Romano [Instruments → Gecko / symbolication walkthrough](https://benromano.com/blog) — load addr via dyld kdebug pre-14.3; post-14.3 claimed `<frame name="…">` in export; notes atos cost when scanning many dSYMs

## Man-page export shapes (observed from `xctrace.1`)

```text
# UUID, binary path, load address, arch — all images in run 1
xctrace export input.trace --xpath '/trace-toc/run[@number="1"]/processes'

# Same, filtered to one process name
xctrace export input.trace --xpath '/trace-toc/run[@number="1"]/processes/process[@name="my-process-name"]'

# Symbolicate the .trace itself (Instruments-oriented)
xctrace symbolicate --input input.trace --dsym /path/to.dSYM
xctrace symbolicate --input input.trace   # best-effort dSYM search
```
