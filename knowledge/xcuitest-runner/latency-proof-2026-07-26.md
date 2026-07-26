# Real-device action latency proof (2026-07-26)

Session: `e18476d2-813f-415a-97a7-0d0b04884a4a`  
Device: iPhone 13 Pro, Xcode 26.6, Probe runner with phase timings  
Evidence: `probe session action --output-json` after plumbing
`handledMs` / `resolutionMs` / `waitMs` / `interactionMs` / `finalizationMs` / `hostRttMs`.

## Decomposition (measured)

```
wall clock
  = CLI process + daemon RPC outside transport   (~250ms fixed)
  + hostRttMs                                    (HTTP to runner over device tunnel)
      = handledMs (runner total)
          = resolutionMs  (locator → element/coordinate)
          + waitMs        (existence + auto-scroll-until-hittable)
          + interactionMs (the actual taps/type/gestures)
          + finalizationMs (response bookkeeping)
      + ~10–15ms transport wrap
```

## Point multiTap (no AX, no scroll) — the pure tap cost

| Action | wall | handled | hostRtt | res | wait | **interact** | fin |
|---|---:|---:|---:|---:|---:|---:|---:|
| point tap ×1 | 1240 | 974 | 988 | 0 | 0 | **775** | 198 |
| point multiTap ×5 delay 0 | 4316 | 4054 | 4069 | 0 | 0 | **3853** | 200 |
| point multiTap ×5 delay 40 | 4592 | 4335 | 4345 | 0 | 0 | **4131** | 204 |
| 5 separate point taps (5 RPCs) | 6307 | — | — | — | — | — | — |

**Implication:** each `XCUICoordinate.tap()` on this device costs **~770ms**.  
Five discrete taps ≈ **3.85s of pure XCUI tap latency**, independent of Probe host logic.

`interTapDelayMs: 40` only adds ~280ms (4131 − 3853). It is **not** the 5s problem.

## Semantic multiTap (identifier + auto-scroll)

| Action | wall | handled | res | wait | interact | fin |
|---|---:|---:|---:|---:|---:|---:|
| semantic tap ×1 (cold scroll) | 8091 | 7826 | 515 | **6520** | 578 | 211 |
| semantic multiTap ×5 delay 0 | 5033 | 4767 | 489 | 755 | **3309** | 211 |
| semantic multiTap ×5 delay 40 | 5256 | 4993 | 499 | 779 | **3495** | 217 |

Cold first-hit auto-scroll can cost **~6.5s** (`waitMs`). Once the target is near the viewport, wait drops to ~0.75s.

## Where the 5 seconds go (warm multiTap)

For warm semantic multiTap delay40 (~5.3s wall):

| Bucket | ms | % of wall |
|---|---:|---:|
| XCUI discrete taps (`interactionMs`) | ~3500 | **~66%** |
| existence/hittable/scroll (`waitMs`) | ~780 | ~15% |
| identifier resolve (`resolutionMs`) | ~500 | ~9% |
| response finalization (`finalizationMs`) | ~210 | ~4% |
| CLI process + daemon outside HTTP | ~250 | ~5% |
| HTTP wrap beyond runner | ~12 | ~0% |

**Host snapshot tax is gone** on this path (`evidence.captures = []`, `evidenceMs = 0`).

## Why sub-1s multiTap is currently impossible with this stack

Target: wall ≤ 1000ms for 5 taps.

Budget if we keep XCUI `tap()` at ~770ms/tap:

```
5 × 770ms = 3850ms  > 1000ms
```

Even with zero wait, zero resolve, zero finalization, zero CLI overhead, **five XCUI coordinate taps alone exceed 1s by ~4×**.

So the next order-of-magnitude win must change **how taps are injected**, not more host optimizations:

1. Faster injection than `XCUICoordinate.tap()` (HID/IOHIDEvent, private event stream, or a different XCTest API if discrete multi-tap can be preserved).
2. Or accept fewer/cheaper gestures for agent “fly” mode when the app’s recognizer allows it.

## Follow-ups already shipped after this measurement

- Surface phase timings on session action results (`feat(session): surface runner phase timings…`).
- Skip `app.label` finalization on `uiAction` / `uiActionBatch` (~200ms tax; `perf(runner): skip app.label finalization…`).
- Still need: re-measure after finalization skip; investigate faster tap injection.

## Method notes

- Device tunnel RTT itself is small: `hostRtt − handled ≈ 10–15ms`.
- CLI fixed cost ~250ms is process spawn of `probe` per invocation (new Bun process), not the long-lived daemon.
- Daemon is connected; the 5s is not “daemon cold start.”
