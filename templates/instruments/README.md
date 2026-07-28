# Instruments templates for Probe

## `Ripple Scene Profiler.tracetemplate`

Saved from Instruments.app (Apr 2025). Based on **Metal System Trace** with extra
instrumentation useful for shader / 3D apps:

- Metal System Trace (GPU intervals, encoder hierarchy, channel activity)
- Metal Counters (when the device supports the selected counter set)
- Hangs summary
- Thermal state
- Displayed surfaces

### Record with Probe

```bash
probe perf record \
  --session-id <sid> \
  --custom-template "templates/instruments/Ripple Scene Profiler.tracetemplate" \
  --time-limit 15s \
  --output-json
```

Then:

```bash
probe perf analyze --session-id <sid> --artifact <trace-key> --analyzer metal-system-trace --output-json
```

`metal-system-trace` analyze will pull `metal-gpu-intervals` (required) plus optional
encoder/driver/gpu-counter schemas when the TOC advertises them.

### Notes

- Counter sets can show as `(null)` / Shader Timeline disabled on some device
  configurations — then GPU counter schemas exist in the TOC but export empty rows.
- Prefer **15s** windows for agent analyze budgets on dense Metal scenes; longer
  captures still analyze via budget-capped prefixes.
