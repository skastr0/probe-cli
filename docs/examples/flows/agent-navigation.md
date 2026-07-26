# Agent navigation playbook

Probe is fast when agents use **identifier selectors + batching + multiTap**, and
slow/frustrating when they invent scroll schemas or thrash on stale screens.

## Session open (device)

```bash
probe session open --target device --team-id <TEAM> --output-json
# Fixture is the default bundle id (dev.probe.fixture). Probe installs the
# fixture .app built for this session so the device never keeps a stale copy.
```

## Navigation loop

1. **Snapshot once** when you do not know what is on screen:
   `probe session snapshot --session-id <id> --output-json`
2. Prefer **semantic identifiers** from the snapshot (`fixture.form.applyButton`),
   not labels, ordinals, or points.
3. **Tap / type / multiTap by identifier.** The runner auto-scrolls until the
   target is hittable (bounded). You usually do **not** need a separate scroll.
4. For multi-step UI, prefer **one flow with `sequence`** over many CLI calls:
   one RPC, one runner batch, no host snapshots between children when
   `evidencePolicy.success` is `"none"`.
5. For multi-tap gestures (passcodes, unlocks), use **`multiTap`** (one
   resolution, N taps, no host snapshots between taps).

## Fast multiTap

```json
{
  "sessionId": "<id>",
  "action": {
    "kind": "multiTap",
    "target": {
      "kind": "semantic",
      "identifier": "fixture.gesture.multiTapTarget",
      "label": null,
      "value": null,
      "placeholder": null,
      "type": null,
      "section": null,
      "interactive": true
    },
    "tapCount": 5,
    "interTapDelayMs": 40,
    "evidencePolicy": { "success": "none", "failure": "none" }
  }
}
```

```bash
probe session action --input-json '<payload above>' --output-json
```

## Fast form batch (type + apply)

```json
{
  "sessionId": "<id>",
  "flow": {
    "contract": "probe.session-flow/v2",
    "steps": [
      {
        "kind": "sequence",
        "execution": "fast",
        "evidencePolicy": { "success": "none" },
        "actions": [
          {
            "kind": "type",
            "target": {
              "kind": "semantic",
              "identifier": "fixture.form.input",
              "label": null,
              "value": null,
              "placeholder": null,
              "type": "textField",
              "section": null,
              "interactive": true
            },
            "text": "hello",
            "replace": true
          },
          {
            "kind": "tap",
            "target": {
              "kind": "semantic",
              "identifier": "fixture.form.applyButton",
              "label": null,
              "value": null,
              "placeholder": null,
              "type": "button",
              "section": null,
              "interactive": true
            }
          }
        ]
      }
    ]
  }
}
```

```bash
probe session run --input-json '<payload above>' --output-json
```

## Explicit scroll (only when needed)

Scroll requires a **target** (the element you gesture on), a **direction**, and
**steps** (positive int). `amount: "small"|"medium"|"large"` is accepted as
1|3|6.

```json
{
  "kind": "scroll",
  "target": {
    "kind": "semantic",
    "identifier": "fixture.form.sectionLabel",
    "label": null,
    "value": null,
    "placeholder": null,
    "type": null,
    "section": null,
    "interactive": false
  },
  "direction": "down",
  "steps": 3
}
```

## What makes agents slow

| Pattern | Cost |
|---|---|
| One CLI `session action` per tap | Host RPC + daemon + runner per tap |
| Snapshot between every mutation | Extra AX capture each time |
| Wrong scroll schema | Opaque decode errors, zero progress |
| Stale device fixture | Identifiers “missing” forever |
| Five separate taps for a multi-tap gesture | Misses recognizer windows; 5× RPCs |

## What is fast

| Pattern | Why |
|---|---|
| `multiTap` | 1 resolve, N taps, 1 RPC |
| `sequence` + `execution:"fast"` + `evidencePolicy.success:"none"` | Runner `uiActionBatch` |
| Identifier-first selectors | No AX enumeration on the runner |
| Auto-scroll-until-hittable | No scroll recipe for offscreen targets |

## Failure recovery

- **`session-action-target-not-found`**: snapshot again; identifier may be wrong
  or the app is on another screen.
- **`not hittable` after auto-scroll**: element may be covered, disabled, or
  outside any scrollable container — snapshot frames help.
- **Device fixture looks old**: close the session and reopen (Probe reinstalls
  `dev.probe.fixture` from the session’s build products).

## Agent CLI fly path notes

- **`session action` with `actions: [...]`** is the preferred multi-mutation CLI
  shape. Probe wraps the array as one `probe.session-flow/v2` `sequence` with
  `execution: "fast"` and **injects sparse evidence automatically**
  (`evidencePolicy: { success: "none", failure: "snapshot" }`) so the runner can
  batch without host snapshots between children. Prefer this over N separate
  `session action` calls.
- **Single `session action` mutations** that omit `evidencePolicy` also get the
  same sparse CLI inject. Explicit `end`/`around` still pass through. This is
  **CLI-only** — raw RPC `session.action` and hand-written `session run` flows
  still resolve omit→`success:end` (domain PRB-093 / investigate default).
- **Export a session recording as a durable flow** for CI re-run:

  ```bash
  probe session recording export --session-id <id> --format flow-v2
  ```

  Prefer semantic identifiers while recording. Export **fails closed** if a step
  only has an ephemeral `preferredRef` (no semantic/point fallback) — re-record
  with identifiers, or use `--format script` + `session replay`. On convert
  failure the script-v1 artifact is already written; the error names its path.
- **Replay wait honesty:** `session replay` supports **duration** waits only.
  Selector waits (`match`/`text`/`absence`) should be expressed in a flow-v2
  file and re-run via `session run`, not script replay.
- **Nav + perf compose** (fixture golden): fill `target.sessionId` in
  [`docs/examples/investigations/fixture-form-apply-time-profiler.json`](../investigations/fixture-form-apply-time-profiler.json)
  and run `probe investigate validate|plan|run --file …`. See
  [`docs/examples/investigations/README.md`](../investigations/README.md).
