# Investigation recipe examples for `probe investigate`

Run any example with:

```bash
probe investigate validate --file docs/examples/investigations/<example>.json --output-json
probe investigate plan     --file docs/examples/investigations/<example>.json --output-json
probe investigate run      --file docs/examples/investigations/<example>.json --output-json
```

## Examples

- `ripple-onboarding-to-breathing-scene.json` -- PRB-099 AC#9 attempt receipt (see below): a real-device recipe for the ripple app's onboarding-to-breathing-scene flow, 20 repetitions, `time-profiler` preset capture, 5s cooldown gate.

## `ripple-onboarding-to-breathing-scene.json` -- status and gap (PRB-099 AC#9)

AC#9 asks for "ripple onboarding-to-breathing-scene recipe completes 20/20 captures on iPhone 13 Pro without reopen/settings/paywall detours." That live-device run is environmentally blocked on this host: there is no `DEVELOPMENT_TEAM` signing configured, so no real-device session can even open (`probe session open --target device`), which is also the precondition for capturing a live accessibility snapshot of ripple's actual onboarding screens.

This file is the non-environmental half of that AC -- the recipe artifact itself, so there is a concrete deliverable to re-run the moment signing is available, rather than nothing:

- `target.sessionId` is a placeholder (`<real-device-session-id>`) -- fill in a real device session id from `probe session open --target device --bundle-id com.skastr0.ripple`.
- `repetitions: 20` matches the AC's "20/20 captures."
- `capture: { kind: "preset", template: "time-profiler" }` and `cooldown.minIntervalMs: 5000` are reasonable defaults for a UI-navigation investigation; adjust once a real run's timing is known.
- `measuredFlow.steps` are **deliberately placeholder duration-only `wait` steps**, not real onboarding navigation. Signing is also required to capture a live accessibility snapshot of ripple's actual onboarding screens (`probe session snapshot`), so this session could not honestly author real `tap`/`assert` steps against ripple's UI either -- inventing plausible-looking accessibility refs for a real app with no live snapshot to verify them against would be a fabricated artifact, not a genuine one.

To complete this recipe once signing is available:

1. `probe session open --target device --bundle-id com.skastr0.ripple` -- resolve a real session id.
2. `probe session snapshot --session-id <id>` -- capture the real onboarding UI tree through to the breathing scene.
3. Replace the four placeholder `wait` steps above with the real `tap`/`assert` steps the snapshot reveals for each onboarding screen, ending on a step that confirms the breathing scene is reached.
4. `probe investigate validate` / `plan` / `run --file docs/examples/investigations/ripple-onboarding-to-breathing-scene.json --output-json`, repeating the run 20 times (or wrapping it in a loop) to confirm 20/20 completes without a reopen/settings/paywall detour.

This file is schema/domain-valid today (see `src/domain/investigation.examples.test.ts`), so its shape is a genuine, checked artifact -- only the measured flow's concrete UI steps remain gated on device signing.
