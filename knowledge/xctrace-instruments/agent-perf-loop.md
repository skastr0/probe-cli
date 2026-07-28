# Agent perf loop — Probe first-class interpretation

Updated: 2026-07-28

## Product sentence

Probe records xctrace traces on live apps and returns **agent-actionable**
summaries: display FPS, encoder heat, leaf callstack PCs (optionally
symbolicated), GPU counters when the template enables them — without requiring
Instruments UI for the default loop.

## Capture recipes

### Metal + display FPS (built-in template)

```bash
probe perf record --session-id $SID --template metal-system-trace --time-limit 15s
probe perf analyze --session-id $SID --artifact <metal-trace-key> --analyzer metal-system-trace
```

Analyze exposes separate metrics:
- **Display surface FPS** from `displayed-surfaces-per-second` (preferred for present rate)
- **GPU frame-span FPS** only when frame-ids exist and grouping is reliable

Never invents FPS from average GPU interval duration.

### Time Profiler + leaf heat

```bash
probe perf record --session-id $SID --template time-profiler --time-limit 15s
probe perf analyze --session-id $SID --artifact <cpu-trace-key> --analyzer time-profiler
# optional symbols:
PROBE_PERF_BINARY=/path/to/Ripple.app/Ripple probe perf analyze ...
```

### Counters / shader (custom template)

```bash
probe perf record --session-id $SID \
  --custom-template templates/instruments/Ripple\ Scene\ Profiler.tracetemplate \
  --time-limit 15s
```

Requires Instruments Recording Options → Metal Application → **GPU Counter Set**
saved into the template (not null). If Counter Set is null, schemas exist but
rows are empty — Probe emits `metal-gpu-counters-required`.

## Capability matrix

| Need | Schema / path | Analyzer status |
|---|---|---|
| Display FPS | `displayed-surfaces-per-second` | first-class |
| GPU work / latency | `metal-gpu-intervals` | first-class |
| Encoder heat | `metal-application-encoders-list` | first-class (truncate under budget) |
| Leaf CPU heat | `time-sample` callstacks | first-class (PCs) |
| Symbol names | atos + `PROBE_PERF_BINARY` | optional best-effort |
| GPU counters | `gpu-counter-value` / intervals | first-class when rows exist |
| Shader timeline | shader-profiler schemas | drill / future |

## Dense captures

60s Metal GPU interval tables can be 100+ MiB. Analyze keeps a budget-capped
prefix and diagnoses `perf-export-truncated`. Prefer **15s** windows for agent
iteration.

## Research packs

- `fps-frame-budget-from-export.md`
- `gpu-metal-counters.md`
- `knowledge/xctrace-symbolication/` (if present)
- `templates/instruments/README.md`
