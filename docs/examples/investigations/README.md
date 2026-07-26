# Investigation recipe examples for `probe investigate`

Recipes are the unit of work for the investigate orbit:

```bash
probe investigate validate --file docs/examples/investigations/<example>.json --output-json
probe investigate plan     --file docs/examples/investigations/<example>.json --output-json
probe investigate run      --file docs/examples/investigations/<example>.json --output-json
```

Every `*.json` in this directory is glob-discovered and domain-validated by
`src/domain/investigation.examples.test.ts`.

## Recipe shape

| Field | Required | Role |
|-------|----------|------|
| `target.sessionId` | yes | Existing session to measure against |
| `setup` | no | Optional `probe.session-flow/v2` navigation before measurement |
| `warmup` | no | Optional flow run once before the first measured repetition |
| `measuredFlow` | yes | The `probe.session-flow/v2` under Instruments capture |
| `capture` | yes | `{ kind: "preset", template }` or `{ kind: "custom", customTemplatePath, timeLimit? }` |
| `repetitions` | yes | Positive integer of capture loops |
| `cooldown` | yes | `{ minIntervalMs }` quiet time between repetitions |
| `evidencePolicy` | no | Investigation-level evidence override |
| `baseline` | no | Prior investigation id or inline report for before/after compare |

## Examples

### `fixture-form-apply-time-profiler.json` — local golden compose

Simulator-friendly **nav + perf** recipe against ProbeFixture:

- `measuredFlow`: fast `sequence` that types into `fixture.form.input` and taps
  `fixture.form.applyButton` with `evidencePolicy.success: "none"` (sparse on the
  mutation batch; Instruments is the proof channel)
- `capture`: `time-profiler` preset
- `repetitions: 1`, `cooldown.minIntervalMs: 1000`

Fill `target.sessionId` from `probe session open` (fixture default on Simulator).
This is the portable golden path for agents composing navigation with a perf
capture without real-device signing.

### `ripple-onboarding-to-breathing-scene.json` — real-app placeholder

PRB-099 AC#9 attempt receipt: real-device recipe for ripple's
onboarding-to-breathing-scene flow, 20 repetitions, `time-profiler`, 5s cooldown.

Environmentally blocked without device signing / `DEVELOPMENT_TEAM`:

- `target.sessionId` is a placeholder (`<real-device-session-id>`)
- `measuredFlow` uses duration-only `wait` steps, not real UI navigation — signing
  is required both to open a device session and to snapshot ripple's accessibility
  tree before honest `tap`/`assert` steps can be authored

To complete once signing is available:

1. `probe session open --target device --bundle-id com.skastr0.ripple`
2. `probe session snapshot --session-id <id>` through onboarding to the breathing scene
3. Replace the placeholder waits with real navigation steps
4. `probe investigate validate|plan|run --file docs/examples/investigations/ripple-onboarding-to-breathing-scene.json --output-json`

## Related

- Flow shapes used inside recipes: [`docs/examples/flows/`](../flows/)
- Agent navigation playbook: [`docs/examples/flows/agent-navigation.md`](../flows/agent-navigation.md)
- Usability bar for the agent loop: [`knowledge/agent-loop-usability-bar.md`](../../../knowledge/agent-loop-usability-bar.md)
