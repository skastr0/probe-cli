# Ripple QA — full record → analyze loop (2026-07-28)

## What was fixed (Probe product)

`perf record` could capture dense 60s Metal/CPU traces that `perf analyze`
could not open: required schema exports hit hard stream budgets and failed the
whole analysis (`perf-export-size-budget`).

Product fix in `src/services/PerfService.ts`:

1. **Required schemas truncate** under budget instead of fail-closed — keep a
   prefix of complete `<row>`s, analyze it, diagnose `perf-export-truncated`.
2. **Budget clamp** after export so agent memory never loads unbounded XML
   (belt-and-suspenders when stream kill is late).
3. **Raised budgets** for dense real-app windows:
   - `time-sample`: 12 MiB / 50k rows (full 60s CPU on this capture)
   - `metal-gpu-intervals`: 16 MiB / 50k rows (prefix of ~151 MiB full table)
   - `metal-driver-event-intervals`: 8 MiB
   - `metal-application-encoders-list`: 24 MiB
   - parse cap: 32 MiB
4. Explicit `perf export` still **fails closed** on budget (no silent truncate).

## Evidence — in-session 60s traces (pid 1654 Ripple, Stop Dusk)

| template | artifact | analyze |
|---|---|---|
| metal-system-trace | `…05-49-19-569Z-metal-system-trace` | ok, truncated GPU prefix |
| time-profiler | `…05-52-40-123Z-time-profiler` | ok, full sample window |

### Metal (budget-capped prefix)

- **17 174** GPU intervals in 16.0 MiB prefix (~full table was 151 MiB / 163k rows)
- Channels: Fragment 4915, Vertex 2690, channel-0 8423
- Avg GPU duration **177 µs**, max **8.56 ms**
- Avg CPU→GPU latency **1.93 ms**, max **10.76 ms**
- FPS **withheld** (`metal-fps-withheld`) — unreliable frame grouping (compositor mix)
- Encoder hotspots: **Blit Command 0** (1.71 ms avg, 1.28 s total) then
  **RipplePass_abstractHushAuroraScene** (93.98 µs avg, 137 ms total)
- Wall: per-shader GPU counters need a custom GPU Counters template

### Time Profiler (full under budget)

- **29 404** samples / 18 threads / 6 cores / **60.82 s** window
- Almost all Running; timer-fired samples dominate
- Call-stack reconstruction still a known wall (raw export kept)

## Artifacts

- `50-metal-analyze-60s.json`
- `51-cpu-analyze-60s.json`
- Raw `.trace` under `~/.probe/sessions/07afc2e8-…/traces/`

## Harness note

Daemon restart drops live session registry. Offline rehydrate harness:
`scripts/analyze-existing-traces.ts` (registers persisted trace keys + live xctrace).
