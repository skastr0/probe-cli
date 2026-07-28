# Live-device fair try — 2026-07-28

**Host:** Guilherme’s Mac · **Device:** iPhone 13 Pro (`iPhone (2)`, CoreDevice `00008110-0006293936C0401E`) · **Team:** `4452968868`  
**Probe:** local main (LOOP wave) · **Daemon:** single `probe serve`  
**Script:** `scripts/live-device-fair-try.ts` · artifacts under this directory

## Verdict

| Surface | Result |
|---|---|
| Fixture open (device, fixture install, runner ready) | **pass** |
| `agentView` on snapshot | **pass** (23 interactive, identifiers present) |
| CLI `actions[]` form batch (type + apply) | **pass** (`verdict: passed`) |
| Sparse multiTap ×5 | **pass** (evidence captures=0; `finalizationMs: 0`) |
| multiTap + `success:end` → `uiDelta` | **pass** (kind `changed`, 12 highlights, 12 interactive) |
| `recording export --format flow-v2` | **pass** (semantic form steps) |
| `session run` exported flow | **pass** |
| Ripple open + snapshot | **pass** (landed on paywall) |
| Ripple best-effort tap “Begin My Free Week” | **pass** (runner-direct by label/ref) |
| Full Ripple onboarding E2E | **not claimed** (paywall / no stable identifiers) |

**LOOP floor on real hardware: green for fixture fly path.**  
**Real-app E2E product sentence: still yellow** (Ripple is paywall-first, label-only controls).

---

## Fixture

**Session:** `e90a7244-9932-49e2-bf97-45260a9f3d04`

### agentView (sample)

Identifiers available for durable targeting: `fixture.form.input`, `fixture.form.applyButton`, `fixture.navigation.detailButton`, list cells, etc. Labels alone (`Reset`, `Base`, …) still appear without ids — agents should prefer identifiers.

### Batch form

`type` → `fixture.form.input` + `tap` → `fixture.form.applyButton` via CLI `actions[]` → one fast sequence. **Verdict: passed.**

### multiTap timings (device)

| Run | policy | handledMs | resolutionMs | waitMs | interactionMs | finalizationMs | evidenceMs |
|---|---|---:|---:|---:|---:|---:|---:|
| ×5 cold-ish | `success:none` | 10534 | 478 | **6540** | **3513** | **0** | **0** |
| ×3 warmer | `success:end` | 3341 | 512 | **773** | **2053** | **0** | 529 (post snap) |

**Interpretation**

- Host AX tax on sparse path: **gone** (`captures: []`, `evidenceMs: 0`).
- `finalizationMs: 0` confirms app.label skip on hot path.
- Interaction ~700ms/tap-ish for 5 taps (3513/5 ≈ 703ms) — XCUI floor, not host thrash.
- Cold `waitMs` 6.5s matches prior auto-scroll-until-hittable cold cost; warm multiTap wait drops to ~0.8s.
- `uiDelta` only when evidence paid for a post snapshot — sparse stays null (honest).

### Export → re-run

- Exported **2** recorded form actions as `session-flow/v2` (semantic targets, `execution:fast`, sparse policy).
- Path: session `recordings/…-fixture-live-fly.flow-v2.json`
- Re-run: **passed** (2 steps, 0 retries).

Note: export summary counted the form batch path; multiTap was executed after and may sit in script-v1 with preferredRef — form path is the durable CI story.

---

## Ripple (`com.skastr0.ripple`)

**Session:** `28aca3de-7c75-49ff-a557-43a673f4342c`  
**First screen:** paywall (`statusLabel: Ripple`)

### agentView

8 interactive controls, **all `identifier: null`**, label-driven:

- Yearly / Monthly plan buttons  
- **Begin My Free Week**  
- Restore purchases · Terms · Privacy · Support  
- Close paywall  

### Best-effort action

Tapped **Begin My Free Week** via runner-direct (`@e42` + label fallback).  
`handledMs ≈ 1400`, sparse evidence (0 captures).  
After-tap snapshot still showed **8** interactive (paywall or system purchase sheet still foreground — did not claim deeper onboarding).

### Real-app takeaway

Probe can **open** a production app, **snapshot**, and **act** on labels. Without accessibility identifiers, export-as-CI-flow stays weak (label/ref only), and autonomous multi-screen walks need app cooperation or more fragile selectors. This is an app/contract issue, not a daemon open failure.

---

## What this proves about the LOOP wave

| Claim | Live receipt |
|---|---|
| Sparse CLI fly path works on device | multiTap evidence empty; batch passed |
| agentView is useful on device | fixture ids + Ripple labels both surfaced |
| uiDelta works when policy pays for post snap | multiTap `success:end` → real remaps/highlights |
| record → flow-v2 → re-run | form path green on same session |
| Daemon + signing + fixture install | two ready sessions, team `4452968868` |

## What it does **not** prove

- Sub-1s multiTap (XCUI floor remains)  
- Ripple end-to-end onboarding / breathing scene  
- Investigate time-profiler on this run (not exercised)  
- Ambient SessionRegistry unit test debt (unrelated)

## How to re-run

```bash
bun run probe -- serve   # one daemon
bun run scripts/live-device-fair-try.ts --phase all
# or --phase fixture | ripple
```

Env overrides: `PROBE_DEVICE_ID`, `PROBE_TEAM_ID`, `PROBE_RIPPLE_BUNDLE`.
