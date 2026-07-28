# FPS / frame budget from Metal System Trace XML export (no Instruments UI)

Updated: 2026-07-28

## Product sentence

Estimate **honest** frame-rate and frame-budget signals from `xctrace export` XML for Metal System Trace, without fabricating 60 fps when frame grouping is mixed with compositor noise.

## Observed TOC surface (Metal System Trace)

Validated on Probe fixtures and Ripple live captures (`fixture-metal-system-trace.toc.xml`, `knowledge/ripple-qa-perf-2026-07-28/*-metal*.json`). Schemas present in TOC:

| Schema | TOC attrs | Role for FPS / budget |
| --- | --- | --- |
| `displayed-surfaces-per-second` | none | Display-side presentation rate time series (name = FPS instrument) |
| `displayed-surfaces-interval` | `target-pid="SINGLE"` | Target-scoped surface-on-display intervals |
| `display-vsyncs-interval` | none | Hardware vsync period → **frame budget**, not app FPS |
| `display-surface-swap` | none | Surface swap events (present cadence) |
| `display-surface-queue` | none | Queue depth / backlog between app and display |
| `display-events-interval` | none | Display pipeline event intervals |
| `display-compositor-interval` | `target-pid="SINGLE"` | Target compositor work |
| `display-compositor-events-interval` | none | Compositor event stream |
| `ca-client-present-request` | none | App CA present *requests* (submit cadence) |
| `ca-client-presented-handler` | none | Present completion callbacks |
| `ca-client-buffer-wait-interval` | none | App wait-for-drawable stalls |
| `device-display-info` | none | Display metadata (refresh capability) |
| `metal-command-buffer-frame-assignment` | none | Explicit command-buffer ↔ frame mapping |
| `metal-known-compositor-process` | none | Compositor pid labels (helps filter, not FPS) |
| `metal-gpu-intervals` | `target-pid="SINGLE"` | GPU channel intervals + `frame-number` (current Probe path) |

**Gap:** schema-spike exported mnemonics only for `metal-gpu-intervals` / driver / encoders. Display/CA schemas are TOC-confirmed but **column mnemonics are not yet spiked**. Before hard-coding parsers, run one export of each preferred schema against a real animated Metal capture and save excerpts under this pack.

## Official Apple guidance (primary)

### Metal System Trace Display track

Apple: [Analyzing the performance of your Metal app](https://developer.apple.com/documentation/xcode/analyzing-the-performance-of-your-metal-app/)

- Metal System Trace records **Metal Application**, **GPU**, and **Display** tracks.
- Display records **display and vertical synchronization events**.
- UI investigation pattern: hover a **display instance** → read **duration** → count **skipped vsyncs** under it.
- Example: 50 ms display instance ≫ neighbors → treat as **stutter** (delayed frame delivery), not “GPU busy.”
- For ~60 Hz, vsync spacing is ~16.67 ms; ProMotion can show much shorter vsync spacing (Apple notes ~4 ms class intervals on capable displays).

Implication for Probe: **on-screen FPS and hitches are Display-track concepts**. GPU interval duration alone is work-time, not presentation rate.

### Hitches (preferred UX metric over raw FPS for UI)

Apple: [Understanding hitches in your app](https://developer.apple.com/documentation/xcode/understanding-hitches-in-your-app); Tech Talk [Explore UI animation hitches and the render loop](https://developer.apple.com/videos/play/tech-talks/10855/)

- Hitch = delayed frame delivery vs the next possible vsync.
- Preferred metric: **hitch time ratio** = total hitch ms / interval duration → **ms/s**.
- Organizer-style bands (approx.): ≤10 ms/s good; ≤25 warning; ≤50 critical; >50 urgent.
- Tech Talk targets: under ~5 ms/s mostly unnoticeable; 5–10 noticeable; >10 severe.
- Idle vsyncs (no commits) do **not** count as hitches — bare FPS over a quiet interval is misleading.

Implication: for scroll/UI, Animation Hitches / hitch ms/s beats “estimated 60 fps.” For continuous Metal games, display present rate is the right FPS.

### Do not hardcode 60 Hz

Apple: [Optimize for variable refresh rate displays](https://developer.apple.com/videos/play/wwdc2021/10147/), CADisplayLink docs

- Query display rate at runtime; ProMotion, Low Power Mode, Accessibility “Limit Frame Rate” change cadence.
- Frame budget = actual vsync period (or CADisplayLink duration), not a constant 16.67 ms.
- Probe’s analyzer currently hardcodes `sixtyFpsFrameBudgetNs = 16_667_000` for budget diagnostics — acceptable as a **labeled 60 Hz reference**, dishonest if presented as the device’s measured budget when vsync export exists.

### metalperftrace (adjacent CLI, WWDC 2026)

Apple video notes: `metalperftrace overview` / `--json` aggregates Metal session metrics from traces (incl. performance HUD-class numbers). Separate from `xctrace export` XML. Worth evaluating later as an optional high-level path; not a substitute for schema-honest Probe contracts.

## Current Probe behavior (ground truth)

Code: `src/domain/perf.ts` → `buildMetalFrameEstimates` / `pickBestMetalFrameEstimates` / `analyzeMetalSystemTraceTables`.

1. Group `metal-gpu-intervals` by `frame-number`.
2. Frame span = max(end) − min(start) across intervals sharing that id.
3. Prefer **app-render channels only**: name contains fragment|vertex|compute|render|tile; drop pure digits, empty, compositor/backboard/springboard.
4. Reliability gate: average span < 100 ms **and** no span > 500 ms.
5. If unreliable → **Estimated FPS = withheld** (`metal-fps-withheld`); encoder/GPU timing still reported.
6. If reliable → FPS = 1e9 / average frame span; budget checks vs hardcoded 16.67 ms.

### Real Ripple 60s metal analyze (`50-metal-analyze-60s.json`)

- Channels: `0 (8423), Fragment (4915), Vertex (2690)`.
- Avg frame span 14.13 ms, **max 3.74 s** → FPS withheld (correct).
- Filter reported `all` — app-render path did not produce a *reliable* denser set (outlier spans remain).
- Max single GPU interval 8.56 ms (under 16.67 ms) while frame spans still unusable — proves **GPU interval ≠ display frame**.

### Fixture gotcha

`src/test-fixtures/perf/metal-system-trace.metal-gpu-intervals.xml` rows include **WindowServer** process and often **missing `frame-number`** (`<sentinel/>`). Channel names include Blit/Compute without Fragment. TOC marks `metal-gpu-intervals` as `target-pid="SINGLE"` on modern exports, but mixed/system rows still appear in practice / older fixtures.

## Ranked extractable FPS / budget signals

Reliability = how safe it is to emit a number agents will treat as “app FPS,” without Instruments UI.

| Rank | Signal | Schema(s) | Math | Reliability | Honesty label for Probe |
| ---: | --- | --- | --- | --- | --- |
| 1 | **Displayed surfaces FPS** | `displayed-surfaces-per-second` | Mean/median of rate column(s) when rows > 0 | **Highest** when populated — instrument is literally present-rate | `Displayed surfaces FPS` · source schema named |
| 2 | **Surface present interval FPS** | `displayed-surfaces-interval` (+ optional `display-surface-swap`) | 1e9 / mean(duration) of successive target-scoped surface intervals; or count(swaps)/window | **High** when `target-pid` scoped and rows dense | `Presented surface FPS (interval)` |
| 3 | **Display vsync period (budget)** | `display-vsyncs-interval` | median(duration) → budget ns; optional Hz = 1e9/period | **High for budget**; **not app FPS** | `Display refresh budget` / `Vsync period` — never “Estimated FPS” |
| 4 | **CA present submit rate** | `ca-client-present-request` | count / wall, or 1e9 / mean inter-arrival | **Medium** — app tried to present; may ≠ on screen | `CA present request rate` |
| 5 | **CA presented handler rate** | `ca-client-presented-handler` | same as above on completion events | **Medium** — closer to completed presents | `CA presented rate` |
| 6 | **Command-buffer frame assignment** | `metal-command-buffer-frame-assignment` | group CB timing by assigned frame id | **Medium** — better grouping than raw GPU frame-number when populated | `Assigned-frame GPU estimate` (secondary) |
| 7 | **GPU frame-span estimate** (current) | `metal-gpu-intervals` | current span-by-`frame-number` + reliability gate | **Low–medium**; often withheld on real mixed traces | `Estimated GPU frame-span FPS` + withhold |
| 8 | **GPU work vs budget only** | `metal-gpu-intervals` duration / start-latency | max/avg duration vs vsync budget; **no FPS** | **High honesty** for GPU pressure | `Max GPU interval` / `CPU→GPU latency` (already present) |
| 9 | **Hardcoded 60 fps** | — | invent 16.67 ms rate | **Forbidden** | never |

### What is *not* a good primary FPS source

- Average GPU interval duration (can be ≪ frame while still locked to 60 Hz, or busy while display freezes).
- Channel occupancy / encoder heat (attribution, not rate).
- Counting unique `frame-number` values without time base (IDs can restart / glue).

## Is filtering Fragment / Vertex sound?

| Claim | Verdict |
| --- | --- |
| Reduces compositor / WindowServer noise in frame spans | **Partially yes** — exclude compositor/backboard/springboard and pure-numeric channel labels |
| Sufficient alone for trustworthy FPS | **No** — real Ripple still hits 3.74 s max span; reliability gate must remain |
| Safe to drop channel `"0"` | **Heuristic only** — `"0"` dominated Ripple capture (8423 rows); may drop real work if device labels channels numerically |
| Safe to require Fragment\|Vertex only | **No** — compute-only / blit-only / tile-only pipelines undercounted; Probe already includes compute/render/tile |
| Prefer app-render, fall back all, withhold if either fails reliability | **Current Probe policy is sound** |

**Rule:** Fragment/Vertex(/Compute/Render/Tile) filter is a **span-cleaning heuristic**, not a display FPS definition.

## Hitch / frame-interval computation (for later)

When implementing hitch-like diagnostics from export (optional, not required for minimal FPS fix):

1. Obtain vsync timestamps from `display-vsyncs-interval` (start + duration).
2. Obtain presentation timestamps from `displayed-surfaces-interval` / swap / CA presented.
3. Hitch time ≈ presentation delay past next eligible vsync (Apple’s render-loop model).
4. Hitch ratio = Σ hitch_ms / window_s → ms/s.
5. Prefer reporting **hitch ms/s** for UI; **present FPS** for continuous Metal.

Do not invent hitch rows if only GPU intervals are present.

## Minimal honest Probe analyzer addition

Scope: extend `metal-system-trace` analyzer only; no new template required (schemas already in stock Metal System Trace TOC). Custom `Ripple Scene Profiler.tracetemplate` already lists Displayed Surfaces.

### 1. Optional exports (not required — empty OK)

In `PerfService` `metal-system-trace.exportSchemas`, add (budget-small):

```text
displayed-surfaces-per-second   maxRows ~4k, maxBytes ~2 MiB
display-vsyncs-interval         maxRows ~20k, maxBytes ~4 MiB
displayed-surfaces-interval     maxRows ~10k, maxBytes ~4 MiB   # target-pid scoped when TOC says so
```

Optional second wave: `ca-client-present-request`, `display-surface-swap`.

### 2. Analyze precedence (emit distinct metrics)

```text
if displayed-surfaces-per-second has parseable rate rows:
  metric "Displayed surfaces FPS" = aggregate(rate)
  diagnosis info metal-fps-from-displayed-surfaces
elif displayed-surfaces-interval has ≥ N successive intervals:
  metric "Presented surface FPS" = 1e9 / mean(duration)  # only if mean in [~2ms, ~200ms]
  diagnosis info metal-fps-from-surface-intervals
else:
  metric "Displayed surfaces FPS" = "none exported"   # not "60"

if display-vsyncs-interval has durations:
  budgetNs = median(duration)
  metric "Display refresh budget" = format(budgetNs) + " (~X Hz)"
else:
  budgetNs = 16_667_000
  metric "Display refresh budget" = "assumed 16.67 ms (60 Hz reference)"  # labeled assumption

# existing path, renamed for honesty:
metric "Estimated GPU frame-span FPS" = current pickBestMetalFrameEstimates
  | "withheld (unreliable grouping)" | "n/a"
use budgetNs (not hardcoded name) in frame-budget diagnoses when emitting GPU estimates
never set Estimated FPS from budget alone
```

### 3. Reliability invariants (must hold)

- No path may output a bare `"60 fps"` / `"60.0 fps"` from empty display tables or failed grouping.
- Withheld remains the default when only noisy `metal-gpu-intervals` exist (Ripple case).
- Display-side FPS and GPU frame-span FPS are **separate metrics** — never merge into one silent number.
- If display schemas export empty (idle fixture), report `none exported`, keep GPU interval stats.
- Hard wall only if someone claims per-shader FPS without counters — not for missing display tables.

### 4. Pre-implementation spike (one session)

```bash
xcrun xctrace export --input <metal.trace> --xpath \
  '/trace-toc/run[@number="1"]/data/table[@schema="displayed-surfaces-per-second"]'
# repeat: display-vsyncs-interval, displayed-surfaces-interval, ca-client-present-request
```

Save schema mnemonics + 5–10 sample rows into this pack (`fixture-display-*.xml`) before locking `requiredMnemonics`.

### 5. Tests

Extend `perf.metal-honesty.test.ts`:

- Display rate present → `Displayed surfaces FPS` numeric; GPU path may still withhold.
- Display empty + noisy GPU frames → no fabricated FPS.
- Vsync median 8.33 ms → budget uses ~120 Hz reference for “over budget” counts.
- Well-behaved GPU-only still reports GPU frame-span FPS under the renamed label.

## Anti-patterns

- ❌ Inferring FPS from max GPU duration alone.
- ❌ Treating withheld → “probably 60.”
- ❌ Filtering only Fragment/Vertex and claiming display FPS.
- ❌ Hardcoding ProMotion as 120 without vsync evidence.
- ❌ Relaying Instruments UI screenshots as CLI contract.

## Status

| Item | Status |
| --- | --- |
| TOC presence of display/CA schemas | **Observed** |
| Official Display-track / hitch guidance | **Documented** (Apple URLs above) |
| Probe GPU frame-span + withhold | **Implemented** |
| Display schema column mnemonics from real export | **Open** — spike required |
| Analyzer wiring for display FPS | **Not implemented** — design above |
| metalperftrace integration | **Out of scope** for minimal addition |
