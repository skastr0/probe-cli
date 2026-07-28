# Probe interpretation upgrade (2026-07-28)

## Goal

Close the agent perf loop: capture is already rich; Probe now **interprets** more of what is already in the `.trace`.

## Not blocked on

| Capability | Capture | Was missing | Now |
|---|---|---|---|
| Leaf callstacks | `time-sample` PCs | Analyzer ignored stacks | Top leaf PCs, main-thread share, top threads |
| FPS | gpu interval frames | Withheld only | App-render channel filter attempt; still honest withhold when unreliable |
| GPU counters | custom template | Not wired | Optional `gpu-counter-value` / `metal-gpu-counter-intervals` |
| Encoder heat | metal encoders | OK | Truncate optional schemas so dense scenes keep a prefix |

## Still not fully automatic

- **Symbol names** from leaf PCs (needs atos + matching .app/dSYM) — note, not capture wall
- **FPS** when frame IDs mix compositor — honesty wall remains
- **Counter numbers** when device records Counter Set null / Shader Timeline disabled — re-record with `templates/instruments/Ripple Scene Profiler.tracetemplate`

## Template found

`~/Library/Application Support/Instruments/Templates/Ripple Scene Profiler.tracetemplate`  
copied to `templates/instruments/Ripple Scene Profiler.tracetemplate`

Metal System Trace + Metal Counters + Hangs + Thermal + Displayed Surfaces.

## Real re-analyze (in-session 60s CPU)

- Hottest leaf: `0x1e51f8df8` ×997
- Main thread share: **23.5%**
- Stacks attributed: 36120 / 36400 samples
