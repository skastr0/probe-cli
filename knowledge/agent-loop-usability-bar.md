# Agent loop usability bar

## Product sentence

An agent walks an iOS app end-to-end with Apple-native proof (Instruments,
accessibility, logs, xcresult) and can export the path as durable tests
(`probe.session-flow/v2` flows and investigate recipes).

Everything that does not serve that sentence fights for existence.

## Minimum usability bar

The loop is usable when an agent can, without ceremony:

1. **Open one long-lived session** on Simulator or device (`probe session open`)
   against a single daemon (`probe serve`).
2. **Navigate with sparse evidence by default** on fly paths:
   - CLI `session action` with `actions: [...]` → one fast `sequence` with
     `evidencePolicy.success: "none"` (no host snapshots between mutations).
   - Explicit `sequence` / `multiTap` for multi-step and multi-tap gestures.
3. **Snapshot only when lost** (`session snapshot`), then prefer semantic
   identifiers — not labels, ordinals, or points.
4. **Fail closed on recovery**: typed errors name the next step; re-snapshot
   after `target-not-found`; reopen when the fixture is stale.
5. **Compose nav + perf** via `probe investigate` recipes (measured flow under a
   preset Instruments capture).
6. **Keep golden flows schema-valid in CI**: every file under
   `docs/examples/flows/` and `docs/examples/investigations/` is
   glob-discovered and domain-validated in tests.

Doctor → validate → drill remains the observation pattern for evidence-heavy
lanes; fly paths stay sparse until proof is requested.

## Probe-native vocabulary

| Term | Meaning |
|------|---------|
| `probe.session-flow/v2` | Canonical multi-step flow contract |
| `sequence` | Runner-batched fast mutations (`uiActionBatch`) |
| `evidencePolicy` | `success: none \| end \| around`, `failure: none \| snapshot` |
| `multiTap` | One resolve, N taps, no host snapshots between taps |
| `doctor` / `validate` / `drill` | Preflight → execute → inspect evidence |
| `investigate` | Recipe: setup?/warmup?/measuredFlow + capture + repetitions + cooldown |

## Honest positioning

Probe may lag general mobile-automation polish (install/signing ownership,
cross-platform surfaces, pure UI-driver ergonomics). It must win on **iOS
depth**: Instruments-backed investigate, commerce / StoreKit lanes,
accessibility audits, artifact-first evidence, and exportable flows that re-run
as tests.

Agents should prefer Probe-native batching and evidence policy over inventing
scroll schemas or one-CLI-call-per-tap loops.

## Playbooks and golden paths

- Navigation fly path: [`docs/examples/flows/agent-navigation.md`](../docs/examples/flows/agent-navigation.md)
- Flow examples (verified / fast / sequence): [`docs/examples/flows/README.md`](../docs/examples/flows/README.md)
- Investigate recipes (fixture golden + real-app placeholder):
  [`docs/examples/investigations/README.md`](../docs/examples/investigations/README.md)
- Local golden compose (form apply + time-profiler):
  [`docs/examples/investigations/fixture-form-apply-time-profiler.json`](../docs/examples/investigations/fixture-form-apply-time-profiler.json)
