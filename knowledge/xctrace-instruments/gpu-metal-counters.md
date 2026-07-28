# GPU / Metal Counters for Probe (agent tooling)

Updated: 2026-07-28

Scope: pragmatic ship checklist for first-class counter summary on iOS device
traces. Extends `schema-inventory.md` / `api-notes.md`; does not re-derive the
full xctrace surface.

Legend: **Observed** = Probe-owned TOC/export/code; **Apple** = official docs /
WWDC; **Inference** = Probe product guidance.

---

## 1. TOC schemas that carry counter / shader data

From a real Metal System Trace TOC
(`fixture-metal-system-trace.toc.xml`, Xcode 26 / xctrace 26):

### Primary value carriers (export these)

| Schema | Role | Probe status |
| --- | --- | --- |
| `gpu-counter-value` | Point / sample counter values | **Wired** optional export in `metal-system-trace` analyzer |
| `metal-gpu-counter-intervals` | Counter values as intervals over time | **Wired** optional; fallback if `gpu-counter-value` empty |
| `metal-shader-profiler-intervals` | Shader profiler interval rows (Shader Timeline) | TOC-present; **not** first-class analyzer yet |
| `metal-shader-profiler-shader-list` | Shader inventory for profiler | TOC-present; not first-class |
| `gpu-shader-profiler-sample` | Low-level shader profiler samples | TOC-present; not first-class |
| `gpu-shader-profiler-interval` | Shader profiler intervals (GPU-side naming) | TOC-present; not first-class |

### Metadata / config (usually not summarized as metrics)

| Schema | Role | TOC signal when counters off |
| --- | --- | --- |
| `gpu-counter-info` | Counter device/profile metadata | `shader-profiler="0" counter-profile="0" counter-device="0"` |
| `metal-gpu-counter-profile` | Selected Metal counter profile | same `shader-profiler="0" counter-profile="0"` |
| `gpu-performance-state-info` / `gpu-performance-state-intervals` | Induced/actual GPU perf state | always useful for honesty |
| `device-gpu-info` / `metal-gpu-info` | Device GPU identity | context only |

### Always useful non-counter Metal schemas (shader/3D summary baseline)

| Schema | Role |
| --- | --- |
| `metal-gpu-intervals` | GPU work timing by channel (required for MST analyze) |
| `metal-application-encoders-list` | Encoder heat / labels |
| `metal-driver-event-intervals` | Driver stalls / wire-memory class events |
| `device-thermal-state-intervals` | Thermal (in Ripple template) |
| `potential-hangs` / `hang-risks` | Hang lane (in Ripple template) |
| `displayed-surfaces-interval` / `displayed-surfaces-per-second` | Present / surface cadence |

**Observed hard fact:** schemas can appear in TOC with **zero rows**. Ripple
60s MST analyze exported `gpu-counter-value` (0 rows, 872 B) and
`metal-gpu-counter-intervals` (0 rows, 1.5 KiB) while intervals populated.
Source: `knowledge/ripple-qa-perf-2026-07-28/50-metal-analyze-60s.json`.

---

## 2. Counter Set null / Shader Timeline disabled

### What it looks like

TOC `summary/intruments-recording-settings` for instrument **Metal Application**:

```xml
<key name="GPU">
  <value>Counter Set: (null)</value>
  <value>Shader Timeline: Disabled</value>
  <value>Induced GPU Performance State: Default</value>
</key>
```

And on counter tables:

```xml
<table shader-profiler="0" counter-profile="0" schema="gpu-counter-info" counter-device="0"/>
<table shader-profiler="0" counter-profile="0" schema="metal-gpu-counter-profile" counter-device="0"/>
```

Source: `fixture-metal-system-trace.toc.xml` lines 29–37, 152–153, 192–193.

### Why

**Apple:** By default Instruments does **not** collect performance counters data
for Metal System Trace. You must set a Counter Set in Recording Options.
Source: [Analyzing the performance of your Metal app](https://developer.apple.com/documentation/xcode/analyzing-the-performance-of-your-metal-app/)
(“Include performance limiter or utilization counters”).

**Apple (WWDC20 10603):** In Metal Application recording options, select a set
such as **Performance Limiters** under **GPU Counter Set**, and optionally
enable **Shader Timeline**.

**Inference:** `(null)` means “no set baked into this recording configuration.”
TOC still lists counter schemas (empty shell); exports stay empty.

### How to enable (GUI → custom template → CLI)

1. Open **Instruments.app** on a machine that can see the **physical iOS device**
   (counter sets are GPU/family-specific; Simulator often cannot fill hardware
   counter rows the same way).
2. Choose **Metal System Trace** (or open the existing **Ripple Scene Profiler**
   template).
3. **Click-and-hold Record → Recording Options** (or select **Metal Application**
   instrument → Recording Options).
4. Under **GPU / Counter Set**, pick a non-null set. Pragmatic first pick:
   - **Performance Limiters** — always look first (WWDC20 10603)
   - Then as needed: **Occupancy**, memory/bandwidth-oriented sets if offered
     for that GPU family, high-utilization style sets
5. Enable **Shader Timeline** if per-shader timeline / shader-profiler tables
   are required (extra cost/density).
6. **File → Save as Template…** →
   `~/Library/Application Support/Instruments/Templates/` or
   `templates/instruments/*.tracetemplate`.
7. Record via path, not ambiguous name:

```bash
xcrun xctrace record \
  --template "/absolute/path/to/Ripple Scene Profiler.tracetemplate" \
  --device <UDID> \
  --attach <pid> \
  --time-limit 15s \
  --output /tmp/ripple.trace \
  --no-prompt
```

Probe:

```bash
probe perf record \
  --session-id <sid> \
  --custom-template "templates/instruments/Ripple Scene Profiler.tracetemplate" \
  --time-limit 15s \
  --output-json
```

### Post-record honesty checks

| Check | Pass signal |
| --- | --- |
| TOC settings | `Counter Set:` not `(null)`; Shader Timeline Enabled if expected |
| TOC attrs | `counter-profile` / `shader-profiler` not stuck at `0` when set was selected |
| Export | `gpu-counter-value` and/or `metal-gpu-counter-intervals` **rowCount > 0** |
| Analyze | diagnosis `metal-gpu-counters-present` instead of `metal-gpu-counters-required` |

**Wall if still empty after a non-null Counter Set:** device/GPU family does not
expose that set over the Instruments counter path for this iOS/Xcode combo, or
the workload never submitted Metal work. Report as wall; do not invent numbers.

---

## 3. What Probe should summarize for shader / 3D apps

### Tier A — ship first (already mostly there)

From timing/encoder path (works even with counters null):

1. **GPU interval timing** — avg/max duration, CPU→GPU latency, channel mix
   (`metal-gpu-intervals`)
2. **Encoder heat** — top labels by total/avg duration
   (`metal-application-encoders-list`)
3. **Driver friction** — event count / types / max duration
   (`metal-driver-event-intervals`)
4. **FPS honesty** — estimate only when frame grouping reliable; else withhold
5. **Counter presence gate** — wall `metal-gpu-counters-required` when no rows

### Tier B — first-class counter summary (when rows exist)

Parse `gpu-counter-value` **preferred**, else `metal-gpu-counter-intervals`.

**Mnemonics to accept (flexible; exports vary by template/Xcode):**

| Intent | Mnemonics to try |
| --- | --- |
| Counter identity | `counter-name`, `name`, `metric`, `label`, `gpu-counter-name` |
| Numeric value | `value`, `counter-value`, `duration` (last only for interval-shaped) |
| Time base | `start`, `time`, `timestamp` |
| Scope join | `encoder-id`, `cmdbuffer-id`, `frame-number`, `channel-name`, `process` |

**Summary shape (agent-compact):**

```text
gpu_counters:
  rowCount
  counterNames: top-N histogram
  byName[name]: { count, avg, max, p95? }
  matchedThemes:
    limiters: names matching /limiter|utilization|alu|fs|vs|cs/i
    occupancy: /occupancy|thread.?occup/i
    bandwidth: /bandwidth|bytes|memory|gmem|dram|l1|l2|cache/i
  topHot: top 5 by max or avg (label + value)
```

**Thematic priorities for 3D/shader apps** (Apple guidance, not a fixed name
list — counter strings are GPU-family-specific):

1. **Performance limiters / utilization** — first question: what is the GPU
   waiting on? (ALU/FS/VS/CS-ish util, memory, etc.)
2. **Occupancy** — low occupancy ⇒ latency hiding / register / workgroup issues
3. **Memory / bandwidth** — GMEM/DRAM/cache pressure for bandwidth-bound scenes
4. Optional: HSR / pixel backend / ray-tracing counters when device exposes them

Do **not** hardcode Apple internal counter IDs. Match display names case-
insensitively and surface raw names in the histogram when no theme matches.

### Tier C — deferred (not required for first ship)

| Schema | Why later |
| --- | --- |
| `metal-shader-profiler-*` / `gpu-shader-profiler-*` | Needs Shader Timeline on; denser XML; symbol/join work |
| Runtime `MTLCounterSampleBuffer` API | App instrumentation path, not xctrace |
| Metal Debugger GPU capture | Xcode GUI, not daemon CLI |

---

## 4. Custom template recording contract

### xctrace

```bash
xcrun xctrace record --template <path-or-name> ...
```

- **Observed:** `--template` accepts filesystem paths to `.tracetemplate`.
- **Observed:** user templates live under
  `~/Library/Application Support/Instruments/Templates/`.
- **Observed:** name collision standard vs user → exit 30; **always pass path**.
- Repo template:
  `templates/instruments/Ripple Scene Profiler.tracetemplate`
  (Metal System Trace + Metal Counters + Hangs + Thermal + Displayed Surfaces).

### Probe

```bash
probe perf record --session-id <sid> \
  --custom-template <path.tracetemplate> \
  --time-limit 15s
# then
probe perf analyze --session-id <sid> \
  --artifact <trace-key> \
  --analyzer metal-system-trace
```

- Custom templates: TOC catalog only at record; analyze uses built-in
  `metal-system-trace` when schemas match, else `perf export --schema …`.
- Prefer **15s** windows for dense Metal agent budgets; longer captures truncate
  on `metal-gpu-intervals` (16 MiB / 50k rows).

### Recommended export list for a counters-enabled metal analyze

**Required**

1. `metal-gpu-intervals`

**Optional (attempt; skip if absent/empty/budget)**

2. `metal-application-encoders-list`
3. `metal-driver-event-intervals`
4. `gpu-counter-value`
5. `metal-gpu-counter-intervals`

**Second-pass / drill only**

6. `metal-shader-profiler-intervals`
7. `metal-shader-profiler-shader-list`
8. `gpu-shader-profiler-sample` / `gpu-shader-profiler-interval`
9. `device-thermal-state-intervals`
10. `potential-hangs` / `hang-risks`

Already matches `PerfService` analyzer `metal-system-trace` for 1–5.

---

## 5. Ship checklist — first-class counter summary

### Capture

- [ ] Ship / document `Ripple Scene Profiler.tracetemplate` path
- [ ] Document GUI: Counter Set ≠ null, Shader Timeline on when shader tables needed
- [ ] Prefer **device** over Simulator for counter rows
- [ ] Default agent window **15s**; metal hard cap 120s

### Detect emptiness honestly

- [ ] Parse TOC `Counter Set: (null)` / `Shader Timeline: Disabled`
- [ ] Treat TOC schema presence ≠ data presence
- [ ] Keep wall `metal-gpu-counters-required` when both counter schemas 0 rows
- [ ] Emit `metal-gpu-counters-present` only when rowCount > 0

### Parse / summarize

- [ ] Flexible mnemonics (table in §3)
- [ ] Top counter names + avg/max
- [ ] Theme buckets: limiters / occupancy / bandwidth via name match
- [ ] Do not claim per-shader cycles without non-empty counter **or** shader-profiler rows

### Product copy

- [ ] “Counters require a preconfigured `.tracetemplate` with a non-null Counter Set”
- [ ] “Standard Metal System Trace often records Counter Set (null)”
- [ ] “Encoder timing is available without counters; cycle attribution is not”

### Validation gate (real device)

- [ ] Record with Ripple template on physical device under GPU load
- [ ] Confirm TOC Counter Set non-null
- [ ] Confirm `gpu-counter-value` or `metal-gpu-counter-intervals` rows > 0
- [ ] Fixture a non-empty counter XML under `src/test-fixtures/perf/` once captured
- [ ] Unit test: non-empty counters → `metal-gpu-counters-present` + theme metrics

### Explicit non-goals (v1)

- Full shader call-site graph
- Metal Debugger capture automation
- Inventing occupancy/ALU numbers when exports empty
- Simulator-as-proof of hardware counters

---

## 6. Current Probe code map

| Piece | Location |
| --- | --- |
| Analyzer schemas + budgets | `src/services/PerfService.ts` → `metal-system-trace` |
| Counter summary + wall | `src/domain/perf.ts` → `buildMetalGpuCounterSummary`, `analyzeMetalSystemTraceTables` |
| Template README | `templates/instruments/README.md` |
| Empty-counter real export | `knowledge/ripple-qa-perf-2026-07-28/50-metal-analyze-60s.json` |
| Null counter-set TOC | `knowledge/xctrace-instruments/fixture-metal-system-trace.toc.xml` |

---

## 7. Sources (short)

- Apple: [Analyzing the performance of your Metal app](https://developer.apple.com/documentation/xcode/analyzing-the-performance-of-your-metal-app/) — Counter Set via Recording Options; default is off
- Apple: WWDC20 10603 — Performance Limiters first; enable Shader Timeline; limiters / occupancy / bandwidth themes
- Apple: WWDC tech talk 111374 — occupancy counters on newer GPUs (M3/A17 Pro class)
- Apple: [GPU counters and counter sample buffers](https://developer.apple.com/documentation/metal/gpu-counters-and-counter-sample-buffers) — runtime MTL path (separate from Instruments)
- Local: `xcrun xctrace list instruments` includes `Metal GPU Counters`
- Local fixtures listed above
