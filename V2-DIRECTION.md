# Probe V2 Direction

Status: draft

This document captures the current research findings and a proposed V2 product direction for Probe.

It is intended to answer three questions:

1. What have we learned from Probe itself, from `agent-device`, and from the Apple/Xcode ecosystem?
2. What are the V2 table stakes Probe needs so it does not lose on basic agent usability?
3. What is the deeper, sharper direction that keeps Probe differentiated as an iOS-focused, local, power-user tool?

This is a product-direction document, not a work item. The SDLC folders remain the source of truth for implementation sequencing.

---

## 1. Executive summary

Probe should not become a smaller `agent-device`.

Probe V2 should become:

> **the local iOS validation and observability workbench for agents and power users**

That means:

- keep the product **iOS-only**
- keep the product **local-first**
- keep the product **artifact-first**
- keep the API surface **small and typed**
- raise the floor on agent ergonomics with **multi-step execution, waits/asserts, retries, unified selectors, logs workflow, and replay polish**
- add purpose-built **validation lanes** for recurring, expensive-to-break iOS seams:
  - accessibility
  - commerce / subscriptions / paywalls
  - performance / signposts / Metal
  - later: HealthKit, Watch connectivity, and similar Apple-native integrations

The winning pattern for Probe V2 is:

- **doctor** = configuration, prerequisites, and environment checks
- **validate** = execute the critical scenario end-to-end
- **drill** = inspect the evidence and artifacts after the fact

This pattern is narrower than a general mobile automation product, but much stronger for local iOS development workflows.

---

## 2. Research findings

## 2.1 What Probe already does well

From `README.md`, `ARCHITECTURE.md`, the current service layout, and completed work items, Probe already has strong product DNA in these areas:

### A. Honest Apple/Xcode seam handling

Probe treats Apple tooling as explicit integration boundaries:

- `simctl`
- `devicectl`
- `xcodebuild`
- `xctrace`
- `lldb`
- `log`

This is a real differentiator. Probe is not pretending these tools are stable magic. It is modeling them directly.

### B. Artifact-first output model

Probe already has the right instinct:

- small outputs inline
- large outputs offloaded to artifacts
- later inspection through `drill`

This is excellent for agents and power users.

### C. iOS-specific depth

Probe already has meaningful iOS depth that general automation tools usually do not prioritize:

- explicit real-device preflight
- bounded `xctrace` template support
- session artifact roots
- capability reporting
- explicit known walls
- real attention to result bundles, traces, and runner lifecycles

### D. Daemon-first local control plane

Probe’s daemon/session model is not an implementation detail. It is part of the product. That gives it a stronger base for persistent session state, artifact ownership, and long-lived bridges.

---

## 2.2 What `agent-device` does better today

The comparison with `agent-device` shows that it often exceeds Probe in **breadth, ergonomics, and polish as an automation tool**, even though Probe is stronger in some iOS-specific diagnostic areas.

### The main strengths to learn from

#### 1. Multi-step execution is first-class

`agent-device` has a JSON `batch` flow for multi-command execution. Probe still feels more single-action/file-centric.

#### 2. Wait/assert flows are normal, not special

`agent-device` makes it easy to write robust agent loops by having built-in waiting and assertion patterns.

#### 3. Selector ergonomics are consistent

`agent-device` uses a unified selector model across commands, which reduces orchestration overhead.

#### 4. Replay/test workflows are more polished

Probe already has recording and replay, but `agent-device` has stronger end-user ergonomics around replay/test execution.

#### 5. Day-to-day logs workflow is better packaged

`agent-device` has clearer logs UX for start/stop/path/mark/doctor flows.

### What Probe should *not* copy

Probe should not copy:

- Android support
- desktop/Linux scope
- remote/cloud-first complexity
- giant command sprawl
- stringly `command + positionals + flags` as the canonical API

Probe should borrow the ergonomics, not the scope.

---

## 2.3 What the Apple/Xcode ecosystem suggests

The broader Apple/Xcode research points to a higher-level opportunity:

### The next level is not “more tap commands”

The next level is using Apple-native surfaces to answer questions like:

- **Is this screen good?**
- **Why did this fail?**
- **What happened between interaction A and rendering B?**
- **Are protected resources and standard integrations wired correctly?**
- **Can I capture the exact evidence bundle I need before the state changes?**

### High-signal surfaces already identified

#### Accessibility audit APIs

Apple’s accessibility audit surface is an obvious opportunity. It upgrades Probe from “can drive UI” to “can judge UI quality.”

#### `.xcresult` + `xcresulttool`

Probe already stores result bundles. Turning them into structured explanations is high leverage.

#### `os_signpost` / signpost-aware performance flows

These allow Probe to tell users not just that an interaction happened, but what the app did in time around it.

#### StoreKit testing + sandbox + TestFlight

Apple explicitly provides different commerce test environments for local deterministic testing and end-to-end sandbox validation.

#### Diagnostic bundle capture

`simctl diagnose`, `devicectl diagnose`, and related evidence paths are extremely well-aligned with Probe’s artifact-first model.

---

## 2.4 Product insight from the commerce discussion

The conversation around paywalls and subscriptions surfaced an important product truth:

> Many expensive iOS bugs are not pure UI bugs. They are **integration seam** bugs.

Examples:

- StoreKit products not loading
- App Store Connect product state blocking sandbox visibility
- RevenueCat offerings configured but not wired correctly
- entitlement unlocks not surviving relaunch or restore
- HealthKit auth flows not persisting correctly
- Watch connectivity present but nonfunctional

These are perfect Probe targets because they are:

- common
- expensive to break
- partly local, partly external
- hard for agents to reason about without explicit tools

This pushes Probe toward **purpose-built validation lanes** rather than generalized command growth.

---

## 3. Product boundaries for V2

Probe V2 should stay inside these boundaries.

## 3.1 In scope

- iOS simulators and iOS devices
- local, developer-owned machine workflows
- daemon-backed session state
- typed JSON contracts for agent use
- artifact-first evidence capture
- Apple/Xcode-native diagnostics and validation
- purpose-built validation lanes for recurring iOS seams

## 3.2 Explicitly out of scope

- Android support
- macOS desktop automation as a co-equal product surface
- cloud tenancy and lease management as a primary V2 theme
- broad remote daemon productization as a V2 requirement
- becoming a generic CI platform
- becoming a general cross-platform e2e runner

## 3.3 Design constraints

### The API must stay small

Probe should add power by making a few nouns deeper, not by creating dozens of top-level commands.

### The canonical machine interface must stay typed

The primary agent contract should be structured JSON, not shell-like strings.

### Large outputs must stay artifact-backed

Validation, audit, result, and trace commands should return compact summaries plus artifact paths.

### Honesty beats fake certainty

Probe should report:

- verified green
- structurally correct but unverified yellow
- deterministic blockers in red
- unknown / externally gated gray

It should not promise “absolutely no problems” when Apple-side state or server-side behavior cannot be proven from local evidence.

---

## 4. V2 product model

Probe V2 should organize work around **lanes**.

Each lane is a recurring iOS integration seam with a stable pattern:

### 1. doctor

Preflight, configuration, and structural checks.

### 2. validate

Execute the critical runtime scenario and report structured verdicts.

### 3. drill

Inspect the resulting evidence: logs, traces, snapshots, result bundles, exported reports.

This gives Probe a coherent identity:

- not just “do commands”
- not just “run tests”
- but **validate, observe, and explain**

---

## 5. Proposed concise command surface

Probe V2 should keep the top-level surface small.

## 5.1 Top-level nouns

```text
probe doctor ...
probe session ...
probe validate ...
probe perf ...
probe drill ...
```

That is sufficient.

The V2 direction does **not** need new top-level nouns for every domain.

---

## 5.2 `probe doctor`

Purpose:

- environment readiness
- host toolchain checks
- capture diagnostics bundles
- lane-specific preflight

Examples:

```bash
probe doctor
probe doctor --json
probe doctor commerce --bundle-id com.example.app --provider revenuecat --json
probe doctor health --bundle-id com.example.app --json
probe doctor capture --target simulator --session-id <id>
probe doctor capture --target device --session-id <id> --kind sysdiagnose
```

### Doctor subcommands and lane flavors

- `probe doctor` — current workspace + host readiness
- `probe doctor commerce` — commerce/paywall/subscription preflight
- `probe doctor health` — HealthKit capability/authorization surface preflight
- `probe doctor watch` — watch pairing/connectivity/build surface preflight
- `probe doctor capture` — simulator/device diagnostics bundle capture

---

## 5.3 `probe session`

Purpose:

- session lifecycle
- direct control
- multi-step execution
- replay
- logs
- snapshots
- result inspection

Examples:

```bash
probe session open --target simulator --bundle-id com.example.app
probe session list --json
probe session show --session-id <id> --json
probe session run --session-id <id> --file flow.json --json
probe session replay --session-id <id> --file recording.json --json
probe session logs mark --session-id <id> --label before-submit
probe session result summary --session-id <id> --json
```

### Proposed `session` additions

- `list`
- `show`
- `run`
- `result summary`
- `result attachments`
- `logs mark`

---

## 5.4 `probe validate`

Purpose:

- execute domain-aware validations
- report verdicts
- collect evidence bundles

Examples:

```bash
probe validate accessibility --session-id <id> --json
probe validate commerce --session-id <id> --mode local-storekit --plan commerce-smoke.json --json
probe validate commerce --session-id <id> --mode sandbox --provider revenuecat --json
probe validate health --session-id <id> --json
probe validate watch --session-id <id> --json
```

### Important property

`validate` is not a generic test runner.

It is a lane-oriented executor with stable, domain-aware checks.

---

## 5.5 `probe perf`

Purpose:

- continue bounded template-driven `xctrace` support
- add signpost-aware and action-scoped performance flows

Examples:

```bash
probe perf record --session-id <id> --template time-profiler --time-limit 5s --json
probe perf around --session-id <id> --file flow.json --template logging --json
probe perf summarize --session-id <id> --artifact trace-123 --group-by signpost --json
```

### Proposed additions

- `around` — record around a bounded action or flow
- `summarize` — lane-specific or signpost-specific summaries from trace artifacts

---

## 5.6 `probe drill`

Purpose:

- inspect logs, snapshots, traces, XML, JSON, result bundles, and related derived artifacts

Examples:

```bash
probe drill --session-id <id> --artifact runner-log --lines 1:40
probe drill --session-id <id> --artifact trace-export --xpath '...'
probe drill --session-id <id> --artifact result-bundle --xcresult summary --json
```

`drill` remains the universal evidence reader.

---

## 6. V2 table stakes

These are the things Probe needs so it does not lose on basic agent usability.

## 6.1 First-class multi-step execution

### Why

Probe must stop forcing agents to stitch together one action at a time with excessive orchestration overhead.

### Direction

Add `probe session run` with a typed multi-step contract.

### CLI shape

```bash
probe session run --session-id <id> --file flow.json
probe session run --session-id <id> --stdin
```

### Contract shape

```json
{
  "contract": "probe.session-flow/v1",
  "steps": [
    { "kind": "wait", "selector": { "kind": "semantic", "label": "Continue", "role": "button" }, "timeoutMs": 3000 },
    { "kind": "tap", "selector": { "kind": "ref", "ref": "@e12", "fallback": { "kind": "semantic", "label": "Continue", "role": "button" } } },
    { "kind": "screenshot", "label": "after-continue" }
  ]
}
```

### Output shape

Every run should produce:

- overall verdict
- executed steps
- failed step if any
- retries performed
- artifacts created
- final snapshot reference if relevant
- warnings and next steps

---

## 6.2 Unified selectors

### Why

Selectors must work the same way across:

- tap
- type
- scroll
- wait
- assert
- replay
- validation lanes

### Canonical selector kinds

#### 1. `ref`

Stable reference from a prior snapshot.

```json
{
  "kind": "ref",
  "ref": "@e12",
  "fallback": {
    "kind": "semantic",
    "label": "Continue",
    "role": "button"
  }
}
```

#### 2. `semantic`

Machine-readable semantic selector.

```json
{
  "kind": "semantic",
  "role": "button",
  "label": "Continue",
  "identifier": null,
  "value": null,
  "placeholder": null,
  "section": null,
  "interactive": true,
  "state": {
    "disabled": false,
    "selected": null,
    "focused": null
  }
}
```

#### 3. `point`

Explicit coordinate fallback for power users.

```json
{
  "kind": "point",
  "x": 120,
  "y": 240,
  "coordinateSpace": "interaction-root"
}
```

#### 4. `absence`

Useful for asserts and waits.

```json
{
  "kind": "absence",
  "selector": {
    "kind": "semantic",
    "label": "Loading"
  }
}
```

### Rules

- `ref` is preferred when available
- semantic fallback is the standard drift-recovery path
- `point` is explicit and power-user-oriented, not the preferred agent path
- selectors must be serializable and replay-safe
- ambiguous selectors fail closed unless the action explicitly allows multiple results

---

## 6.3 Built-in retries

### Why

Agents should not have to reinvent transient retry logic around every action.

### Retry policy shape

```json
{
  "maxAttempts": 3,
  "backoffMs": 250,
  "refreshSnapshotBetweenAttempts": true,
  "retryOn": [
    "not-found",
    "not-hittable",
    "runner-timeout",
    "transient-transport"
  ]
}
```

### Retry defaults

- `tap`, `type`, `scroll`, `wait` get lane-appropriate defaults
- domain-specific steps can override or disable retry
- every retry should be visible in the result report
- replay results must distinguish:
  - no retry needed
  - retry succeeded
  - semantic fallback succeeded
  - retry exhausted

---

## 6.4 Wait and assert are table stakes

Probe must make these first-class in both session flows and validation lanes.

### Wait kinds

- `wait` by selector
- `wait` by text
- `wait` by absence
- `wait` by duration

### Assert kinds

- `exists`
- `visible`
- `hidden`
- `text`
- `enabled`
- `selected`
- `focused`
- `interactive`
- lane-specific assertions such as `entitlement-active`

---

## 6.5 Better logs workflow

Probe should package logs more clearly without bloating the surface.

### Proposed additions

```bash
probe session logs --session-id <id> --source runner --lines 80
probe session logs mark --session-id <id> --label before-submit
probe session logs capture --session-id <id> --seconds 3
probe session logs doctor --session-id <id>
```

### Notes

- `mark` is extremely useful for reproduction loops
- `capture` should produce a small bounded artifact for inspection
- `doctor` should explain what log sources are actually available on simulator vs device

---

## 6.6 Session introspection

Add:

```bash
probe session list
probe session show --session-id <id>
```

This is table stakes for a daemon-first tool.

---

## 6.7 Better replay and result workflows

Probe already has strong ingredients here. V2 should make them more usable.

### Additions

- clearer replay result reports
- better retry/fallback summaries
- `session result summary`
- `session result attachments`
- drillable `.xcresult` outputs

---

## 7. Proposed step kinds for `probe session run`

The step vocabulary should stay small and typed.

## 7.1 Core step kinds

### `snapshot`

Capture and persist a snapshot.

```json
{ "kind": "snapshot", "output": "auto" }
```

### `wait`

Wait for a selector, text, or absence.

```json
{
  "kind": "wait",
  "selector": { "kind": "semantic", "label": "Continue", "role": "button" },
  "timeoutMs": 3000
}
```

### `assert`

Assert a selector state.

```json
{
  "kind": "assert",
  "selector": { "kind": "semantic", "label": "Continue", "role": "button" },
  "expectation": { "exists": true, "interactive": true }
}
```

### `tap`

```json
{ "kind": "tap", "selector": { "kind": "ref", "ref": "@e12" } }
```

### `press`

```json
{ "kind": "press", "selector": { "kind": "semantic", "label": "Menu" }, "durationMs": 800 }
```

### `type`

```json
{
  "kind": "type",
  "selector": { "kind": "semantic", "placeholder": "Email" },
  "text": "person@example.com",
  "replace": true
}
```

### `scroll`

```json
{
  "kind": "scroll",
  "selector": { "kind": "semantic", "label": "Plans" },
  "direction": "down",
  "steps": 2
}
```

### `screenshot`

```json
{ "kind": "screenshot", "label": "after-submit" }
```

### `video`

```json
{ "kind": "video", "durationMs": 5000 }
```

### `logMark`

```json
{ "kind": "logMark", "label": "before-purchase" }
```

### `sleep`

```json
{ "kind": "sleep", "durationMs": 500 }
```

---

## 7.2 Lane-specific step families

The core flow should stay small.

Domain lanes can add prefixed step families.

Examples:

- `commerce.loadProducts`
- `commerce.purchase`
- `commerce.restore`
- `commerce.assertEntitlement`
- `permissions.grant`
- `permissions.reset`
- `health.requestAuthorization`
- `health.assertRead`
- `watch.assertCompanionReachable`

That allows Probe to add domain depth without polluting the general session step vocabulary.

---

## 8. Result and evidence contract

Every significant Probe V2 action should return structured evidence.

## 8.1 Standard verdict states

- `verified` — directly confirmed by execution or artifact evidence
- `configured` — structurally present but not runtime-proven in this run
- `blocked` — deterministic prerequisite or runtime failure
- `unknown` — not enough evidence or the surface is externally gated

## 8.2 Standard result packet shape

```json
{
  "contract": "probe.validation-result/v1",
  "lane": "commerce",
  "status": "blocked",
  "summary": "Offerings failed to load from StoreKit in sandbox mode.",
  "checks": [],
  "artifacts": [],
  "warnings": [],
  "nextSteps": []
}
```

## 8.3 Evidence expectations

Every `validate` flow should try to produce:

- screenshots when the UI matters
- bounded logs or log markers
- snapshots when selectors or screen state matter
- result bundles where available
- traces when performance or timing matters
- a compact human-readable summary plus machine-readable JSON

---

## 9. Lane direction: accessibility

Accessibility should be one of the first V2 lanes.

## 9.1 Why

- it is common
- it is high-value
- it is Apple-native
- it is not just “can tap” but “is this screen acceptable”

## 9.2 Commands

```bash
probe validate accessibility --session-id <id> --json
probe validate accessibility --session-id <id> --scope current-screen --json
```

## 9.3 What it should report

- issue category
- severity
- affected element ref or semantic target
- human-readable explanation
- screenshot and snapshot references
- summary verdict for the screen

## 9.4 Stretch direction

Longer term, this can become the audit lane for:

- contrast/readability
- hittability
- missing labels
- duplicate controls
- incorrect traits/roles

---

## 10. Lane direction: commerce

Commerce is one of the strongest V2 opportunities.

## 10.1 Why commerce belongs in Probe

Commerce bugs are:

- common
- expensive
- easy to regress
- often integration-driven rather than pure UI-driven

Examples:

- products do not load
- offerings do not map correctly
- purchase sheet does not appear
- purchase succeeds but entitlement does not unlock
- restore breaks after app update
- local StoreKit mode is configured incorrectly
- sandbox mode is blocked by Apple-side state or App Store Connect state

This is exactly the kind of recurring seam where a local iOS power-user tool can add huge value.

---

## 10.2 Commerce command surface

### Doctor

```bash
probe doctor commerce --bundle-id com.example.app --json
probe doctor commerce --bundle-id com.example.app --provider revenuecat --json
```

### Validate

```bash
probe validate commerce --session-id <id> --mode local-storekit --config MyApp.storekit --json
probe validate commerce --session-id <id> --mode sandbox --json
probe validate commerce --session-id <id> --mode sandbox --provider revenuecat --json
```

### Drill

```bash
probe drill --session-id <id> --artifact commerce-report --json
```

---

## 10.3 Commerce modes

### A. `local-storekit`

Purpose:

- deterministic local validation
- no production charges
- fast iteration
- forced failure and lifecycle scenarios

This mode should eventually be backed by StoreKit local testing surfaces rather than a fragile dependence on manual Xcode UI setup.

### B. `sandbox`

Purpose:

- real App Store-signed receipts/JWS
- end-to-end app-to-server validation
- realistic pre-release confidence

This is the release-gate lane for apps with real subscriptions.

### C. `testflight` (later)

Purpose:

- final beta-validation environment
- useful for slower-cycle release gating

This should be later than local-storekit and sandbox.

---

## 10.4 What `doctor commerce` should check

The report should be evidence-based and grouped.

### A. Local app/build checks

- bundle id matches expected target
- StoreKit capability and expected commerce configuration are present where inspectable
- app build flavor/environment points to the expected backend settings where inspectable
- local `.storekit` config exists when local-storekit mode is requested

### B. App Store Connect checks

- app exists for bundle id
- product identifiers exist
- subscription group exists
- products are attached correctly
- product states are sane for the intended environment
- obvious blockers are surfaced honestly

### C. RevenueCat checks (optional provider-aware mode)

- RevenueCat app exists
- offerings exist
- package → product ID mapping is valid
- entitlements exist and map correctly
- Apple IAP / issuer setup is present if required
- local StoreKit test certificate and offer keys are present when relevant

### D. Device/test-environment checks

- sandbox account presence for sandbox mode where inspectable
- right target device mode for requested validation path
- any mode incompatibility is surfaced clearly

### E. Result model

Each check returns:

- `verified`
- `configured`
- `blocked`
- `unknown`

Probe should never claim a false universal green.

---

## 10.5 What `validate commerce` should do

At minimum, a commerce smoke should be able to verify:

1. paywall or purchase entrypoint opens
2. products/offering load
3. purchase sheet appears or purchase can be initiated
4. purchase completes
5. entitlement unlocks
6. relaunch preserves entitlement
7. restore flow works

### Example plan

```json
{
  "contract": "probe.commerce-plan/v1",
  "productId": "com.example.pro.monthly",
  "expectedEntitlement": "pro",
  "steps": [
    { "kind": "commerce.openPaywall" },
    { "kind": "commerce.assertProductVisible", "productId": "com.example.pro.monthly" },
    { "kind": "commerce.purchase", "productId": "com.example.pro.monthly" },
    { "kind": "commerce.assertEntitlement", "entitlement": "pro", "state": "active" },
    { "kind": "commerce.relaunchApp" },
    { "kind": "commerce.assertEntitlement", "entitlement": "pro", "state": "active" },
    { "kind": "commerce.restore" },
    { "kind": "commerce.assertEntitlement", "entitlement": "pro", "state": "active" }
  ]
}
```

---

## 10.6 Commerce-specific step kinds

### Basic universal commerce steps

- `commerce.openPaywall`
- `commerce.assertProductVisible`
- `commerce.purchase`
- `commerce.restore`
- `commerce.assertEntitlement`
- `commerce.assertOfferingsLoaded`
- `commerce.relaunchApp`

### Local-storekit enhanced steps

- `commerce.clearTransactions`
- `commerce.setTimeRate`
- `commerce.forceFailure`
- `commerce.enableAskToBuy`
- `commerce.approveAskToBuy`
- `commerce.declineAskToBuy`
- `commerce.refundTransaction`
- `commerce.expireSubscription`
- `commerce.disableAutoRenew`

These are exactly the kinds of deterministic test controls that make a local power tool valuable.

---

## 10.7 RevenueCat-aware validation

RevenueCat should be an optional provider-aware layer, not the universal core.

### Why

Probe should stay StoreKit-native first.

But RevenueCat-aware validation is valuable because many apps use it and the wiring mistakes are common.

### RevenueCat-aware checks can include

- expected offering id exists
- expected package references the intended product id
- entitlement mapping is present
- local StoreKit certificate is uploaded when using local StoreKit testing
- offer key setup is present for subscription offers
- Apple IAP key / issuer are configured where required

### RevenueCat-aware runtime checks can include

- offerings load and expected package is selected
- purchase results in expected entitlement state
- restore results in expected entitlement state
- relaunch still reflects entitlement state

### Important honesty rule

Probe should report:

- what was directly verified from app behavior
- what was structurally verified from provider config
- what remains externally gated or unknown

---

## 10.8 What commerce adds beyond “opening the app”

This must remain explicit because it is the main value proposition.

Opening the app tells you:

- launch worked
- some UI appeared

Commerce validation tells you whether:

- products loaded
- paywall state is correct
- purchase initiation works
- purchase completion works
- restore works
- entitlement unlock works
- relaunch preserves unlock
- mode-specific blockers are present
- the app/provider/store integration is structurally sane

That is a much more meaningful release-confidence signal.

---

## 11. Lane direction: performance and graphics

Probe already has a strong base here.

V2 should deepen it in ways that matter for real iOS development.

## 11.1 Core direction

- keep bounded template-driven `xctrace`
- keep artifact-first export model
- add signpost-aware summaries
- add action-scoped profiling flows
- keep Metal and GPU analysis as a premium iOS-native capability

## 11.2 Examples

```bash
probe perf around --session-id <id> --file checkout-flow.json --template logging --json
probe perf around --session-id <id> --file shader-scene.json --template metal-system-trace --json
probe perf summarize --session-id <id> --artifact trace-123 --group-by signpost --json
```

## 11.3 Longer-term opportunity

This is one of the strongest Probe wedges for graphics-heavy and SwiftUI-heavy apps:

- signpost intervals
- hangs
- concurrency
- Metal encoders
- GPU interval budgets
- frame hitch evidence

---

## 12. Lane direction: results and evidence

Probe should treat `.xcresult` as a first-class artifact surface.

## 12.1 Commands

```bash
probe session result summary --session-id <id> --json
probe session result attachments --session-id <id> --json
probe session result compare --left a.xcresult --right b.xcresult --json
```

## 12.2 Why this matters

This lets Probe explain:

- what test actually failed
- which attachments exist
- what issues were emitted
- what logs and coverage are available

That is a major step up from raw runner output.

---

## 13. Future lane candidates

These should be considered only after table stakes and first V2 lanes are strong.

## 13.1 HealthKit

### Why it is a good Probe lane candidate

- common enough in health/wellness apps
- repeated authorization/read/write flows
- expensive to break
- hard to validate repeatedly by hand

### Potential direction

```bash
probe doctor health --bundle-id com.example.app --json
probe validate health --session-id <id> --json
```

Potential checks:

- capability present
- authorization request works
- expected types can be read/written in test mode where possible
- evidence bundle on failure

## 13.2 Watch connectivity

### Why it may be worth a lane later

- standard-ish integration seam for apps with watch support
- repeated install/pair/connect/message issues

### Potential direction

```bash
probe doctor watch --bundle-id com.example.app --json
probe validate watch --session-id <id> --json
```

Potential checks:

- pair state
- companion app presence
- session activation state
- message reachability
- basic transfer success

These are promising but should follow commerce/accessibility/perf.

---

## 14. V2 sequencing recommendation

## 14.1 P0 — table stakes and structure

1. `probe session run`
2. unified selectors
3. built-in retries
4. waits and asserts as first-class flow steps
5. `session list` and `session show`
6. `logs mark` and better logs packaging
7. replay/result report polish

## 14.2 P1 — first validation lanes

1. `validate accessibility`
2. `.xcresult` and result-bundle introspection
3. `doctor commerce`
4. `validate commerce` in local-storekit mode
5. `validate commerce` in sandbox mode

## 14.3 P2 — deeper observability lanes

1. signpost-aware `perf around`
2. commerce provider-aware checks (RevenueCat mode)
3. diagnostic bundle capture polish
4. initial HealthKit lane

## 14.4 P3 — later domain lanes

1. Watch validation
2. broader protected-resource integration support
3. more specialized graphics/perf workflows

---

## 15. Anti-patterns to avoid in V2

### 1. Becoming a smaller `agent-device`

Do not win by breadth. Win by iOS-native depth and evidence.

### 2. Command sprawl

Do not add a top-level noun for every new idea.

### 3. Stringly machine contracts

Do not make `command + positionals + flags` the canonical Probe API.

### 4. Fake certainty

Do not claim global green when only some checks were directly verified.

### 5. Shallow domain lanes

Do not ship lots of tiny half-supported verticals. Add only the lanes that are common, expensive to break, and observable enough to matter.

### 6. Scope dilution into cloud/tenancy before the local product is undeniable

The local power-user story should become obviously strong before Probe spends energy on broad remote orchestration productization.

---

## 16. Product thesis for V2

If Probe V2 succeeds, people should be able to give it to an agent and have the agent answer:

- can I open and control the app?
- is the current UI acceptable and accessible?
- what exactly failed?
- what evidence proves that?
- did this interaction regress performance?
- is the subscription/paywall system structurally wired and runtime-valid?
- what exact next step should the developer take?

That is a stronger category than “mobile automation CLI.”

It is:

> **an iOS validation and observability workbench for agents and power users**

That is the V2 direction.
