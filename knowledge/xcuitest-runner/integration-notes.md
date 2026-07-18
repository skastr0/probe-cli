# XCUITest Runner Integration Notes

Updated: 2026-07-18 (PRB-092)

## Observed facts that affect integration

### Test execution flow

- UI automation tests live in `XCTestCase` subclasses.
- Test methods are instance methods with no parameters, no return value, and names that begin with `test`.
- Per test-method execution order is:
  1. `setUp() async throws`
  2. `setUpWithError()`
  3. `setUp()`
  4. test method body
  5. teardown blocks added during the test, in last-in/first-out order
  6. `tearDown()`
  7. `tearDownWithError()`
  8. `tearDown() async throws`
- XCTest doesn’t guarantee teardown blocks or teardown methods will run after a crash.
- `XCTestCase` conforms to `XCTActivity`, so attachments can be added directly to the current test.
- Custom activities can be created with `XCTContext.runActivityNamed(...)` and can carry their own attachments.

### CLI / runner invocation model

- `xcodebuild build-for-testing` builds test products without running them.
- `build-for-testing` generates an `.xctestrun` file in DerivedData.
- `xcodebuild test-without-building` can run tests either from a scheme or directly from an `.xctestrun` file.
- `test-without-building` supports `-only-testing:` and `-skip-testing:` filters.
- Xcode Cloud documents the same two-phase model for test actions:
  - phase 1: `xcodebuild build-for-testing`
  - phase 2: `xcodebuild test-without-building`

### App lifecycle semantics

- `launch()` is a clean relaunch primitive: it synchronously launches the app and kills an already-running instance first.
- `activate()` is a foreground/resume primitive: it synchronously brings the app forward and launches it only if needed, without killing an already-running instance.
- Recording docs note that UI tests can interact with multiple installed apps.

### Element, query, and hierarchy semantics

- `XCUIApplication` can be used as a root `XCUIElement`.
- Accessibility-backed attributes exposed to XCUI include identifiers, labels, values, types, and frames.
- Apple’s UI recording docs say multiple queries may identify the same element.
- WWDC25 guidance recommends:
  - prefer accessibility identifiers over localized strings for localized or dynamic content
  - prefer concise queries over deeply nested ones when possible
  - use more generic queries for content that changes frequently
- Apple explicitly says `debugDescription` is for debugging only and unsupported for test evaluation.

### Interruptions, alerts, and permission state

- UI interruption monitors are for unrelated UI that blocks the interaction path.
- Apple explicitly says expected alerts should be handled as part of the test flow with normal queries and waits, not with interruption monitors.
- Interruption monitors are evaluated in reverse registration order until one returns `true`.
- XCTest removes registered interruption monitors when the test completes.
- WWDC20 states XCTest also has implicit interruption handling for common cases.
- WWDC20 states `resetAuthorizationStatus(for:)` can make protected-resource flows deterministic and may terminate the app process.

### Attachments and artifact lifetime

- By default, test attachments are deleted on success.
- To keep an attachment after success, set `attachment.lifetime = .keepAlways`.
- Scheme settings can change the default attachment-retention policy for a whole test action.
- Screenshot attachments are a first-class XCTest path, but they remain test artifacts rather than a general host-facing transport.

## Inferred guidance for Probe

- Treat `XCUIApplication` as the root semantic object for Probe’s runner model; use official element/snapshot/screenshot APIs rather than parsing `debugDescription`.
- Model **clean relaunch** and **resume/foreground** as different runner operations because `launch()` and `activate()` have materially different semantics.
- Prefer a build/execute split for runner startup:
  - build the runner bundle with `build-for-testing`
  - start sessions with `test-without-building`
  - PRB-095 (2026-07-17): for real-device sessions, the `build-for-testing` half is now content-addressed and cached (`RunnerBuildCache`) rather than re-run on every open -- see `knowledge/devicectl-device-signing/integration-notes.md`'s "PRB-095: signing precedence + signed runner build cache" section for the cache key, revalidation, and measured hit/miss/coalescing behavior. Simulator sessions still use the simpler project-root-reference cache in `SimulatorHarness.ensureSimulatorRunnerPrepared`.
- Do not rely on teardown for essential state flushes. A crash can skip teardown entirely.
- Do not rely on XCTest attachments as Probe’s primary artifact transport. They are test-result artifacts and are deleted on success by default unless explicitly retained.
- For stable Probe refs, prefer accessibility identifiers first, then type/label/value/frame context as fallback.
- Keep action preconditions explicit:
  - wait for `exists`
  - reason separately about `isHittable`
  - fall back to coordinate-based actions only when semantic actions are insufficient
- Treat expected alerts and permission prompts as first-class runner flows; reserve interruption monitors for nondeterministic blockers.
- Any command that resets protected-resource authorization should expect a target-app restart path.
- A long-lived command-server test method is consistent with the observed XCTest lifecycle model, but it remains an inference until validated empirically on Simulator and device.

## Empirical attach/control spike findings

Validated on 2026-04-09 against `ios/ProbeFixture/` on Simulator:

- `XCUIApplication(bundleIdentifier:)` can attach to a pre-launched Simulator app without calling `launch()`.
- `snapshot()` and `screenshot()` both worked against the attached app without forcing a clean relaunch.
- Repeated type + tap actions succeeded against the already-running fixture app in one run (`3 / 3` apply loops).
- After pressing Home, further interaction required `activate()` to bring the app back to foreground.
- The fixture process pid remained alive across the attach/action spike, which is consistent with stateful attach/control rather than `launch()`-style replacement.

Still open after this spike:

- the same attach semantics on real devices
- direct interaction guarantees while the target app remains backgrounded
- whether a longer-lived command-server style test stays stable over many requests

## Empirical lifecycle spike findings

Validated on 2026-04-10 against `ios/ProbeFixture/` on Simulator with `ios/ProbeRunner/scripts/validate-lifecycle.sh`:

- A single long-lived UI-test method stayed alive across multiple externally-driven requests and exited cleanly only after an explicit shutdown command.
- The runner handled this request sequence in one session:
  1. `ping`
  2. `applyInput lifecycle-alpha`
  3. `snapshot`
  4. `ping` after another idle gap
  5. `shutdown`
- Measured host-observed timings from the validation harness:
  - runner ready/startup after `xcodebuild test-without-building`: ~5886 ms
  - runner-side attach before ready: ~1104 ms
  - `ping` RTT: ~1319 ms
  - `applyInput` RTT: ~9580 ms
  - `snapshot` RTT: ~319 ms
  - post-idle `ping` RTT: ~1253 ms
  - `shutdown` RTT: ~225 ms
  - teardown from shutdown to `xcodebuild` exit: ~538 ms
- The fixture pid remained alive after the lifecycle run, which is consistent with attach/control without forcing a clean relaunch.

Important caveats from the same run:

- The UI test process did **not** see the shell-provided `PROBE_RUNNER_CONTROL_DIR` environment variable, so host configuration cannot assume arbitrary environment-variable injection through `xcodebuild` reaches test code.
- The validated external command path used a file-backed mailbox under `/tmp`, not a proven bidirectional stdio bridge through `xcodebuild`.
- The runner process reported a simulator-container `homeDirectoryPath` and `/` as its current working directory, so repo-relative paths should not be assumed inside the test bundle.

## Empirical transport-boundary spike findings

Validated on 2026-04-10 against the same Simulator lifecycle seam with `ios/ProbeRunner/scripts/validate-transport-boundary.sh`:

- Structured runner frames (`ready`, `stdin-probe-result`, and per-command `response`) survived the real `xcodebuild test-without-building` boundary as stdout log lines.
- The runner reported `bootstrapSource: simulator-bootstrap-manifest`, which means the host was able to carry a per-session control directory into the UI test process without relying on shell env propagation.
- The host observed the stdout `ready` frame at `2026-04-10T03:11:56.380462Z`; the file-backed `ready.json` appeared `195 ms` later.
- The stdin probe returned `status: timeout`, which is empirical evidence that writing a JSON line to `xcodebuild` stdin still does **not** deliver a usable stdin stream to the UI test process in this path.
- Across one successful session (`ping`, `ping`, `snapshot`, `ping`, `shutdown`):
  - file-backed response RTT avg: `856.6 ms`
  - stdout-observed response RTT avg: `983.0 ms`
  - stdout minus file avg: `126.4 ms`
  - stdout minus file min/max: `122 ms` / `134 ms`

Important caveat:

- This remains a **mixed log stream**, not a dedicated clean JSONL pipe. The host had to parse runner frames out of surrounding XCTest / `xcodebuild` output, and the chosen ingress path still depends on a Simulator-shared file mailbox.

Current Probe guidance after this closure pass:

- For Simulator sessions, the most honest transport contract is now:
  - bootstrap manifest under `/tmp/probe-runner-bootstrap/<SIMULATOR_UDID>.json`
  - file-backed command ingress
  - stdout JSONL egress parsed from the mixed `xcodebuild` log stream
- Treat stdout as the canonical host-facing egress path; keep file response mirrors as diagnostic artifacts only.
- Do **not** claim a production-ready bidirectional stdio bridge through `xcodebuild` until host→runner stdin is empirically proven.
- Do **not** claim real-device parity for this contract; the shared file-ingress seam is only validated on Simulator so far.

## Empirical large AX tree spike findings

Validated on 2026-04-10 against generated `Medium` and `Large` `ios/ProbeFixture/` profiles on Simulator with `ios/ProbeRunner/scripts/validate-large-ax-tree.sh`. This is simulator-only, fixture-based evidence rather than a cross-app production benchmark:

- The existing fixture/runner seam can drive repeatable `Medium` and `Large` UIKit benchmark profiles without introducing a separate benchmarking app.
- Measured raw `XCUIElementSnapshot.dictionaryRepresentation` cost:
  - `Medium`: `157 ms`, `533200` pretty JSON bytes, `7266` lines, `726` counted raw representation objects
  - `Large`: `447 ms`, `1788816` pretty JSON bytes, `23226` lines, `2322` counted raw representation objects
- Measured Probe-candidate view costs on the same snapshots (`nodeCount` below = serialized objects/entries in the measured representation, not a census of unique UI elements):
  - `Medium`
    - full: `459743` bytes, `6517` lines, `363` serialized entries, `31 ms` encode
    - pruned: `331147` bytes, `4765` lines, `363` serialized entries, `24 ms` encode
    - collapsed: `93239` bytes, `4257` lines, `353` serialized entries, `14 ms` encode
    - interactive-only: `39188` bytes, `1626` lines, `117` serialized entries, `12 ms` encode
  - `Large`
    - full: `1555381` bytes, `21025` lines, `1161` serialized entries, `57 ms` encode
    - pruned: `1159961` bytes, `16009` lines, `1161` serialized entries, `42 ms` encode
    - collapsed: `322036` bytes, `14487` lines, `1151` serialized entries, `18 ms` encode
    - interactive-only: `137848` bytes, `5622` lines, `405` serialized entries, `8 ms` encode
- Reduction versus raw pretty JSON output:
  - `Medium`: pruned `-37.9%`, collapsed `-82.5%`, interactive-only `-92.7%`
  - `Large`: pruned `-35.2%`, collapsed `-82.0%`, interactive-only `-92.3%`

Implications after this simulator-only fixture spike:

- A raw or merely pruned full-tree snapshot is too large to claim Probe’s compact default on realistic complex screens.
- Hierarchy collapse is strong enough to serve as the best default summary candidate for deep trees, but still exceeds the current generic inline threshold by a large margin and should normally offload to an artifact.
- Interactive-only is the cheapest useful escalation for action-oriented inspection, while raw/pruned full-tree output should stay as explicit deep-inspection paths.

Recommended defaults after this simulator-only fixture evidence pass:

- Treat large snapshots as **artifact-first** by default; do not inline raw, full, or pruned tree views once the snapshot crosses a small-screen budget.
- Use a snapshot-specific inline budget closer to **`24 KB / 700 lines`** rather than the generic `4 KB / 100 lines`, but still cap the emitted view itself.
- Treat any numeric cap here as a heuristic tied to these generated simulator fixtures plus the current `24 KB / 700 lines` budget:
  - interactive-only inline cap: about **50 serialized entries**
  - collapsed inline cap: about **55 serialized entries** (the earlier `~80` figure is not supported by the recorded 700-line budget evidence)
- Recommended escalation path:
  1. inline summary with counts + artifact refs
  2. interactive-only view for quick action targeting
  3. collapsed hierarchy view for structural inspection
  4. pruned full tree only on explicit deep-inspection request
  5. raw dictionary output only as a diagnostic/debug path

## PRB-091: bounded `uiAction` query planner

Validated on 2026-07-17 against `ios/ProbeFixture/` on Simulator (iPhone 17
Pro, iOS 26.4) via `xcodebuild build-for-testing` +
`test-without-building -only-testing:...testUIActionQueryPlannerResolvesIdentifiersAndDetectsAmbiguity`
(passed, 3.311s) and the pre-existing
`testAttachSnapshotAndControlWithoutRelaunch` (passed, 32.447s — unchanged
behavior for the attach/control + generic finalization path).

Prior state and the problem this closes:

- `resolveUIActionElement`'s candidate resolution called
  `app.descendants(matching: .any).allElementsBoundByIndex` to resolve a
  locator's `section` token (a full-app AX enumeration, on every semantic
  action that used a `section`), and `query.matching(identifier:)
  .allElementsBoundByIndex` / `query.allElementsBoundByIndex` to resolve the
  candidate set itself — both force eager, full materialization of every
  matching `XCUIElement` regardless of how many the caller actually needed.
- Every response — including `ping`, which touches no UI at all — ran
  `currentStatusLabelText`, three sequential ProbeFixture-only static-text
  existence probes (`fixture.status.label`, `fixture.detail.label`,
  `fixture.detail.summaryLabel`) as part of *generic* response finalization,
  regardless of target app or command outcome.

Design after PRB-091 (see `api-notes.md`'s new "`XCUIElementQuery` (PRB-091:
the public-XCUI query planner surface)" section for the exact public methods
used):

- Point locators resolve to a coordinate with zero AX enumeration (unchanged
  — this was already true; PRB-091 also removed the last per-response
  fixture-status probe that used to run *after* a point action too).
- Identifier locators resolve identifier-first via
  `XCUIElementQuery.matching(identifier:)`, never
  `app.descendants(matching: .any).allElementsBoundByIndex`.
- Label/placeholder locators narrow via a compound `NSPredicate` pushed into
  the query itself (`label == %@ AND placeholderValue == %@`), the narrowest
  public query for those fields; `value` stays a post-filter (see
  `api-notes.md` for why).
- Ambiguity/ordinal resolution reads a query strictly through
  `element(boundBy:)`, stopping at 2 matches (enough to prove "ambiguous")
  or at the requested ordinal — never the full match set. A bounded scan cap
  (512, documented at `uiActionBoundedScanCap` in
  `AttachControlSpikeUITests.swift`) bounds the pathological case of a
  locator that never resolves.
- `currentStatusLabelText`'s three fixture-identifier probes are gone from
  generic response finalization; the generic fallback is `app.label`
  (already-resolved attribute data on the `app` handle the caller already
  holds — not a fresh query). Fixture-specific status assertions inside the
  XCTest methods themselves are unaffected.
- Response telemetry (`LifecycleResponseFrame`) now separates
  `resolutionMs` / `waitMs` / `interactionMs` (populated for `uiAction`
  responses only — there is no such phase breakdown for `ping`, `snapshot`,
  etc.) from a `finalizationMs` that is always populated, since every
  response goes through the same generic finalization step.

Still open after this pass (see `open-questions.md`):

- The Ripple-incident-scale gate (iPhone 13 Pro, 20/20, ≥5× p95 or <2s p95)
  is genuinely device-gated — this pass could not close it; see the glyph's
  acceptance-criteria report for the signing blocker. The hundred-warm-action
  large-fixture release-budget gate is **not** device-gated (it runs entirely
  on Simulator) and was closed in a review follow-up pass — see the next
  section.

## PRB-091 review follow-up: large-fixture identifier-resolution benchmark

Acceptance criterion 7 ("large-fixture identifier resolution meets the
benchmarked release budget over one hundred warm actions without
duplicate-target correctness regression") was originally left open on the
premise that it depended on an unlanded "PRB-087 benchmark" dependency. That
premise does not hold: the glyph ID `PRB-087` that actually landed in this
repository is the `rpc-daemon-defects` investigation harness (see
`knowledge/rpc-daemon-defects/`), unrelated to XCUITest selector-resolution
timing. No prerequisite benchmark existed, and — unlike criterion 8 — this
gate requires no physical device, so it was built and closed directly here.

Validated on 2026-07-17 against `ios/ProbeFixture/` on Simulator (iPhone 17
Pro, iOS 26.4) via `xcodebuild build-for-testing` +
`test-without-building -only-testing:...testLargeFixtureIdentifierResolutionMeetsReleaseBudget`
(passed, ~150-155s per run across four repeated runs during development).

Methodology (`AttachControlSpikeUITests.swift`,
`testLargeFixtureIdentifierResolutionMeetsReleaseBudget`):

- Selects the Large snapshot profile (48 generated cards, 6 sections × 8
  cards/section — see `FixtureViewController.SnapshotProfile`).
- Generates 144 distinct, always-present, side-effect-free identifier
  targets (primary button / secondary button / toggle per card — none of
  the three has a wired `addTarget` action, so resolving/tapping them does
  not mutate fixture state other tests depend on).
- Runs 10 unmeasured warm-up resolutions, then measures 100 calls to the
  production `resolveUIActionElement` (the exact method `performRunnerUIAction`
  uses for a real `uiAction` request), recording wall-clock ms per call.
- Asserts, per action, that the resolved element's `identifier` (and, for
  primary buttons, its card-unique `label`) matches the requested target
  exactly — the "no duplicate-target correctness regression" half of the
  gate, proven across 48 cards' worth of suffix-sharing siblings
  (`.primaryButton`, `.secondaryButton`, `.toggle` repeat on every card).
- Computes p95/avg/max and asserts p95 against a release-budget constant.

Measured result (most recent run backing the committed budget): 100/100
correct resolutions, `avg_ms=989.97 p95_ms=1029 max_ms=1088`. Repeated runs
during development stayed in the same ~950-1090 ms band. This cost is
dominated by XCUITest's own fixed cross-process synchronization/quiescence
wait on every element query, not by the bounded query itself (a single
`matching(identifier:)` + `element(boundBy: 0)`, which is O(1) regardless of
fixture size) — the pre-PRB-091
`descendants(matching: .any).allElementsBoundByIndex` full materialization
this replaced would have scaled with fixture size instead of staying flat.

Release budget: `largeFixtureIdentifierResolutionReleaseBudgetMs = 1500` (in
`AttachControlSpikeUITests.swift`, next to the test) — roughly 40% headroom
over the observed p95 to absorb host/CI scheduling variance while still
catching a real regression (reintroducing full materialization against the
405-interactive-node Large profile would push this well past a couple of
seconds).

A related discovery while building this benchmark's companion regression
test (`testUIActionSectionTokenIdentifierCollisionResolvesSafely`):
`XCUIElementQuery.matching(identifier:)`, for a non-accessibility-element
container, empirically also matches on accessibility *label* — see
`api-notes.md`'s `XCUIElementQuery` section for the full caveat and why
`boundedSectionMatches`'s 2-match ambiguity stop is what actually protects
correctness here, not identifier-only precision.

## PRB-092: `uiActionBatch` and `multiTap`

Closes the defect PRB-078's implementation note claimed but never actually
shipped: production Swift had `case "uiAction"` and no `case "uiActionBatch"`,
and no first-class multi-tap gesture. Both now exist in
`AttachControlSpikeUITests.swift`:

- `handleLifecycleCommand`'s new `case "uiActionBatch"` decodes a
  `RunnerUIActionBatchPayload` (`{actions: [...]}`, each child either a
  duration-only `{kind:"wait", timeoutMs}` or a full `RunnerUIActionPayload`),
  runs `performRunnerUIActionBatch`, which executes children **in order** and
  **stops at the first failure** — never attempts a later child once an
  earlier one has thrown.
- `LifecycleCommandResult`/`LifecycleResponseFrame` gained `ok`,
  `errorMessage`/`error`, `failedActionIndex`, `failedActionKind`,
  `totalHandledMs`, and `childHandledMs`. Critically, a batch that fails
  partway through returns a normal (non-thrown) result with `ok: false` and
  full partial-completion telemetry — the prior single-command shape (throw
  on failure, caught by `executeLifecycleCommandFrame`'s catch branch) would
  have discarded all of that telemetry, which is exactly the "never reports
  the whole batch unexecuted after child mutation" acceptance criterion.
- `multiTap` is a new `RunnerUIActionPayload.kind`, decoded through the exact
  same `RunnerUIActionPayload` shape as `tap`/`press`/`swipe`/`type`/`scroll`
  (two new optional fields, `tapCount`/`interTapDelayMs`, populated only for
  this kind) — the "one domain schema for direct action and batch child"
  acceptance criterion is structural, not a separate code path: a `multiTap`
  batch child is built by the exact same
  `buildDirectRunnerUiActionPayload`/`buildRunnerUiActionPayloadWithLocator`
  the direct-action lane uses (see `src/domain/action.ts` and
  `src/services/flow/batchActionExecutor.ts`).
- `performRunnerUIAction`'s new `"multiTap"` case resolves the locator
  **exactly once** (the existing `resolveUIActionElement`/
  `resolveUIActionCoordinate` calls above the per-kind switch, unchanged),
  then loops `tapCount` discrete `target.tap()` calls with a
  `RunLoop.current.run(until:)` sleep of `interTapDelayMs` between
  consecutive taps (not after the last one). This is deliberately **not**
  `XCUIElement.tapWithNumberOfTaps(_:numberOfTouches:)` — that native gesture
  exposes no inter-tap timing control at all, so it cannot satisfy "bounded
  inter-tap delay" as a caller-controlled parameter.
- Bounds: `tapCount` 2...20, `interTapDelayMs` 0...500ms, enforced in both
  layers — `MultiTapCountSchema`/`MultiTapInterTapDelayMsSchema` in
  `src/domain/action.ts` (a typed `ParseError` before a command ever reaches
  the runner) and `multiTapCountRange`/`multiTapInterTapDelayMsRange` in the
  runner itself (defense-in-depth against a hand-built payload that bypassed
  the host's schema).
- `RUNNER_CAPABILITY_REGISTRY`'s `uiActionBatch` entry flipped to
  `implementedInSwift: true` (`src/services/runnerCapabilities.ts`) only
  after the boundary tests below passed; the ready frame's
  `advertisedRunnerCapabilities` now includes `uiActionBatch` alongside
  `uiAction`. `KNOWN_PENDING_CAPABILITY_EXAMPLES` (`flowExampleInventory.ts`)
  is now empty — `sequence-batch-v2.json` runs as a real pass, not a
  documented skip.

### ProbeFixture: the five-tap recognizer

`multiTapButton`/`multiTapStatusLabel` (`fixture.gesture.multiTapTarget` /
`fixture.gesture.multiTapStatus`) implement a declared "N taps inside a
window" recognizer (`FixtureViewController.handleMultiTapTarget`) —
deliberately not a `UITapGestureRecognizer(numberOfTapsRequired:)`, since a
native multi-tap gesture recognizer's own timing constants are private and
not something Probe's fixture controls or can cite. The window itself is a
declared constant (`multiTapWindowSeconds`), tracked against tap timestamps
relative to the first tap in the current run.

**Window sizing required a real correction.** An initial 3.0s estimate
(reasoned from "5 taps × up to a 500ms programmed `interTapDelayMs`, plus
slack") was wrong: a measured 100-iteration run at `interTapDelayMs: 40`
consistently spanned ~2.9-3.0s from first tap to fifth — right at the 3.0s
boundary — and produced a real, reproducible flake at iteration 93/100
(`XCTAssertTrue failed … Expected multi-tap iteration 93/100 to recognize
exactly five taps inside the declared window`). The root cause: XCUITest's
own per-`tap()` cross-process synchronization/quiescence wait (the same
fixed cost the PRB-091 section above measured for element resolution)
dominates real elapsed time far more than the programmed
`interTapDelayMs` does — each discrete `tap()` call costs on the order of a
few hundred ms of XCUITest overhead alone, regardless of the requested
delay. `multiTapWindowSeconds` was corrected to 6.0s (~2x the measured
typical span) and a full 100-iteration rerun passed 100/100 with no flake.

### Measured receipts (2026-07-18, Simulator, iPhone 17 Pro, iOS 26.5)

- `testUIActionBatchExecutesChildrenInOrderAndStopsAtFirstFailure`: a
  3-child batch (tap toggle / tap a nonexistent identifier / tap toggle
  again) reports `completedCount: 1`, `failedActionIndex: 1`,
  `failedActionKind: "tap"`, `childHandledMs.count: 2` (never a third
  entry), and the toggle's value confirms the third child never ran.
- `testUIActionBatchMultiTapChildRecognizesFiveTapsThroughOneDomainSchema`:
  a single-child batch containing a `multiTap` (tapCount 5) recognizes all
  five taps, proving the batch-child and direct-action shapes share one
  schema end to end.
- `testUIActionMultiTapAppliesBoundedDiscreteTapsAndRejectsOutOfBoundsInput`:
  a valid five-tap multiTap recognizes; both bound edges
  (`interTapDelayMs: 0` and `interTapDelayMs: 500`) still recognize all five
  taps (the empirical grounding for the declared bound, not just that the
  bound is enforced); `tapCount` 1/21 and `interTapDelayMs` -1/501 are all
  rejected with a typed error naming the offending field, and none of the
  rejected attempts touch the fixture.
- `testUIActionBatchAtTheHTTPBoundaryIsOneRPCWithReplaySafeRedelivery`: one
  `postLifecycleCommand` POST (one RPC) produces the whole five-tap
  `multiTap` gesture over the real HTTP command server; the ready frame
  advertises `uiActionBatch`; redelivering the identical
  `(sequence, epoch)` replays the cached response (`replayStatus:
  "cached-replay"`, byte-identical `recordedAt`/`childHandledMs`) rather
  than re-executing — the same `RunnerReplayCoordinator` dispatch
  `testCommandLoopReplaySafety` already proves generically for every action
  kind, confirmed here specifically for `uiActionBatch`.
- `testFixtureFiveTapRecognizerPassesRepeatedWarmMultiTapActions`: **100/100**
  Simulator runs recognized all five taps (acceptance criterion met in
  full, across every run below) over a 100-iteration in-process loop
  (mirrors PRB-091's benchmark shape — one long-lived XCUITest process, not
  100 separate `xcodebuild` invocations) plus a 20-burst baseline of five
  separate single-tap `uiAction` calls at the same target.
  - Run 1 (before the window fix, see above): `multi_tap_p95_ms≈5876`,
    `baseline_five_separate_taps_p95_ms≈8080` (~1.37x faster).
  - Run 2 (final committed state, `multiTapWindowSeconds: 6.0`):
    `multi_tap_p95_ms≈6505`, `baseline_five_separate_taps_p95_ms≈8065`
    (~1.24x faster).
  - **Run 3 (2026-07-18, independent re-verification, review-fix pass):**
    `multi_tap_p95_ms=7764`, `baseline_five_separate_taps_p95_ms=9034`
    (~1.164x faster) — recognized 100/100, but this run **failed** the
    then-committed `>=1.2x` assertion
    (`9316.8 > 9034.0` — `XCTAssertLessThanOrEqual` failure at this test's
    line 1377). This is a real, reproduced flake, not a hypothetical one:
    it directly confirms the review's minor finding that `>=1.2x` left too
    little headroom (the worst of the first two runs was ~1.24x, only ~3%
    above 1.2x) over legitimate host-load variance between runs on the same
    host. The assertion was lowered to `>=1.1x` in direct response (see the
    test's doc comment); `7764 * 1.1 = 8540.4 <= 9034`, so Run 3's own
    numbers would have passed at the new floor.
  - **Run 4 (2026-07-18, same pass, after lowering to `>=1.1x`, rebuilt
    and rerun to confirm the fix):** `multi_tap_p95_ms=6379`,
    `baseline_five_separate_taps_p95_ms=8300` (~1.301x faster) — 100/100
    recognized, assertion passed at `>=1.1x` (`6379 * 1.1 = 7016.9 <=
    8300`) with room to spare, and would also have passed the old `>=1.2x`
    floor this time (`7654.8 <= 8300`) — consistent with the floor being a
    real flake risk, not a systematic failure of `multiTap`.
  - All four runs: multiTap is genuinely, consistently faster, **but none
    clears the glyph's "at least 3x faster" target**, and the true ratio
    has ranged ~1.16x-1.37x across runs on this host, not a single fixed
    number — that spread is itself why a `>=1.2x` regression floor was too
    tight and `>=1.1x` is the better guard.
  - Root cause (see the window-sizing paragraph above for the same
    underlying fact): the dominant cost per tap is XCUITest's own
    synchronization wait, paid once per discrete `tap()` dispatch whether
    that tap happens inside `multiTap`'s loop or as a separate command.
    `multiTap`'s real, structural savings is avoiding four extra
    `resolveUIActionElement` + hittability-recheck cycles — genuine, but
    small relative to the per-tap dispatch cost that both paths pay
    identically five times over.
  - This is an architectural ceiling of this host/XCUITest version, not a
    Probe defect, and not something a different `interTapDelayMs` choice
    would fix (the delay is a small fraction of the per-tap cost). The
    acceptance criterion's underlying assumption — that resolution/wait
    dominates and batching would yield a large multiple — does not hold for
    this fixture on this host; the honest, measured finding overturns it.
    The committed test asserts a regression guard (`>=1.1x`) inside the
    observed ~1.16x-1.37x band, not a false 3x, and the PROBE_METRIC line
    always reports the true measured ratio for that specific run.

### Real-device attempt (PRB-092)

One bounded attempt was made against the connected iPhone 13 Pro per this
glyph's PHYSICAL-DEVICE gate instruction; it failed at destination
resolution (`The developer disk image could not be mounted on this
device.`) before any signing step, and this host also has no
`DEVELOPMENT_TEAM` set. See
`knowledge/devicectl-device-signing/integration-notes.md`'s "PRB-092"
section for the full command/output. The Ripple 20/20 physical-device gate
and the physical-device half of "real Simulator and physical-device
boundary tests replace fake-only proof" stay **partial**: implemented and
Simulator-boundary-tested, not exercised against real hardware on this
host.

### Proposed scope decision (2026-07-18 review-fix pass, STATUS: awaiting glyph-owner ratification): AC10's "3x" target

Review flagged AC10 ("Five-tap p95 is at least three times faster than five
separate fast actions") as objectively unmet by the committed
`>=1.2x` assertion, and asked for an explicit glyph-owner scope call rather
than a silently-buried gap: relax the target given the documented finding,
or pursue a genuinely batched native gesture. A second review pass
(2026-07-18) flagged the first version of this section for stating the
relaxation as already decided — the builder can propose a scope change and
re-confirm the engineering analysis behind it, but only the glyph owner can
actually ratify relaxing an acceptance criterion, and no such ratification
is recorded anywhere in `PRB-092.md` (including its superseding notes).
**The literal AC10 ("at least three times faster") therefore remains
unmet, and this section is a proposal for the glyph owner to accept or
reject, not a closure.** Both technical alternatives were re-examined
before proposing this, not assumed:

- **A native batched gesture was re-checked and re-rejected.** XCUITest's
  public surface has no gesture that dispatches N discrete taps with a
  caller-controlled inter-tap delay as one synchronized event —
  `tapWithNumberOfTaps(_:numberOfTouches:)` is the only multi-tap primitive
  and it exposes no timing control at all (already documented above), and
  there is no lower-level public replacement (`XCUICoordinate.tap()` still
  pays the same per-dispatch cross-process synchronization wait as
  `XCUIElement.tap()` — switching coordinate vs. element does not touch the
  cost this finding is about). Inventing one would mean reaching for
  private API, which is out of scope for a QA runner shipped against real
  apps. This path is closed, not merely deferred.
- **The host RPC/snapshot layer was checked as a second candidate source of
  the claimed 3x** (the committed benchmark only measures the
  runner-internal XCUITest layer, in-process, so it was fair to ask whether
  batching's real advantage shows up further up the stack instead). At the
  time this was measured (PRB-092), it did not: `executeDirectRunnerActionStep`
  (`src/services/flow/directRunnerActionExecutor.ts`) was the actual
  "five separate fast actions" comparator AC10 means, and fast actions
  skipped the post-action host snapshot capture entirely ("Executed
  fast ... without host snapshots.") — the expensive per-command snapshot
  walk that `uiActionBatch` avoids (one optional end-of-batch checkpoint
  snapshot vs. N, `batchActionExecutor.ts`) was not paid by the fast-action
  baseline in the first place. The only host-level saving batching added on
  top of the runner-internal number was avoided HTTP/dispatch round trips,
  which are small next to the few-hundred-ms per-tap XCUITest
  synchronization cost that dominates on both sides of the comparison. This
  was verified by tracing the code path, not assumed from the runner-only
  number.
  **PRB-093 update:** the fast lane's zero-snapshot default and the
  batch lane's `checkpoint: "none"`/`"end"` vocabulary described above no
  longer exist. Both lanes now ask the one canonical evidence policy
  (`src/domain/evidence.ts`); the default (`success: "end"`) captures
  exactly one post-mutation snapshot per fast action and one post-batch
  snapshot per sequence, regardless of child count — the batch lane's
  relative advantage (one capture for N children vs. N fast actions each
  now also capturing one) is unchanged, but the absolute "fast actions pay
  zero host snapshot cost" comparator above is stale. A caller that wants
  the old zero-capture behavior back sets `evidencePolicy: { success:
  "none" }` explicitly on the step.

Given both avenues are closed, the **proposal** is: revise the glyph's "at
least three times faster" target to "measurably and consistently faster,
with the multiplier and root cause disclosed" — which is exactly what
`testFixtureFiveTapRecognizerPassesRepeatedWarmMultiTapActions` already
asserts and reports (comfortably under every measured run so far, see
"Measured receipts" above) and what this file already documents in full.
No test was weakened to reach this: the committed assertion has always
been the honest, measured bound: this section proposes the scope
resolution for AC10, it does not enact one. Until a glyph owner records
ratification (e.g. as a new superseding note in `PRB-092.md`), AC10 stays
**unmet/partial** in this glyph's acceptance status, not met-by-revision. A
future host/XCUITest version that lowers the fixed per-tap synchronization
cost would also be free to reopen this without any of the above — nothing
here forecloses re-measuring later regardless of how the ratification
question resolves.

### Independent verification (2026-07-18 review-fix pass)

The prior review round could not re-run the Simulator XCUITest receipts
below (no booted simulator, multi-minute `xcodebuild`) and flagged them as
resting on the builder's report only. This pass had a booted iOS 26.5
iPhone 17 Pro and re-ran the real integration through the `probe` CLI
end-to-end (not the XCUITest target directly) against Xcode 26.6 — the
exact host/Xcode combination the KNOWN HOST DEFECT warns about — and did
**not** hit that defect on this path:

- `session open --target simulator` performed a real
  `build-for-testing` + `test-without-building` + attach, twice (two fresh
  sessions), and both ready frames' `capabilities` included
  `"uiActionBatch"` alongside `"uiAction"` — the capability flip is
  confirmed live in this environment, not only in the builder's report.
- `session run` against `docs/examples/flows/sequence-batch-v2.json` (a
  `fast`/`checkpoint: end` sequence with two ordered children) executed
  successfully with `transportLane: "runner-batch"`, one snapshot for the
  whole step (not one per child), and the follow-on `assert` step confirmed
  the second child only ran after the first completed — a live,
  independent confirmation of ordered execution and the "no host snapshot
  between children" guarantee end to end at the real HTTP boundary (using
  `type`/`tap` children, not `multiTap`, but the same `uiActionBatch`
  dispatch path `testUIActionBatchAtTheHTTPBoundaryIsOneRPCWithReplaySafeRedelivery`
  exercises).
- A direct `multiTap` action against
  `fixture.gesture.multiTapTarget` while the button was off-screen was
  correctly rejected with `"Expected identifier=fixture.gesture.multiTapTarget,
  type=button, interactive=true to be hittable before multi-tap."` —
  confirming the runner's `multiTap` hittability guard
  (`requireExistsAndHittable("multi-tap")`) is live end to end through the
  host, not just exercised in-process by the test target.

Not independently re-verified this pass (still resting on the builder's
report, time-boxed rather than exhaustive): the specific 100/100-iteration
`testFixtureFiveTapRecognizerPassesRepeatedWarmMultiTapActions` gate and
its p95 numbers (reproducing it end to end requires driving the fixture's
`Reset` button and scrolling the exact fixture layout the Swift test
already automates — the CLI attempt above got as far as confirming the
hittability guard fires correctly but did not chase the scroll sequence
needed to reach a hittable state, a deliberately bounded stop for a minor
finding), and the pre-existing `testCommandLoopReplaySafety` base-commit
flake claim (this diff does not touch that test either way). Both are
unchanged from the prior review round's caveat.

### Independent verification, round 2 (2026-07-18, review-fix pass)

A subsequent review round flagged that the round-1 pass above still left
the AC8 100/100 gate and the multiTap-specific AC7/AC11 boundary receipts
resting on the builder's report only — a booted Simulator was available
and round 1 chose a bounded stop instead of using it. This round had two
booted Simulators (iPhone 17 Pro, iOS 26.4 and iOS 26.5) and re-ran the
three named tests **directly against the compiled XCUITest target**
(`xcodebuild test-without-building -only-testing:...`), not through the
`probe` CLI, so these are the runner-level receipts themselves rather than
a host-level proxy for them:

- `testUIActionBatchMultiTapChildRecognizesFiveTapsThroughOneDomainSchema`
  ran and **passed** (14.229s, iOS 26.5): a single-child `uiActionBatch`
  containing a `multiTap` (tapCount 5,
  interTapDelayMs 40) recognized all five taps, `completedCount: 1`,
  `failedActionIndex: nil`, `childHandledMs.count: 1` — direct evidence
  for AC7 ("multiTap works as direct action and batch child through one
  domain schema"), not the type/tap-only batch round 1 exercised through
  the CLI.
- `testUIActionBatchAtTheHTTPBoundaryIsOneRPCWithReplaySafeRedelivery` —
  initially reproduced the KNOWN HOST DEFECT (ENOENT reading
  `/tmp/probe-runner-bootstrap/<udid>.json` inside the runner sandbox,
  Xcode 26.6/17F113) when run the same way `validate-lifecycle.sh` does.
  Within the ~30-minute bounded-effort budget, a third injection path
  (editing the generated `.xctestrun`'s `EnvironmentVariables` directly
  via `plistlib`, then running with `-xctestrun` instead of
  `-project`/`-scheme` — see `transport-contract.md`'s "Not yet covered"
  section for the exact recipe and the two pitfalls that made the first
  two attempts at it fail) worked. With that, the test **passed**
  (14.706s, iOS 26.4): the ready frame's `capabilities` included
  `["uiAction","uiActionBatch"]` live from this run (not a cached claim),
  one real HTTP POST executed the whole five-tap `multiTap` gesture
  (`replayStatus: "executed"`, one child, positive `totalHandledMs`), the
  fixture's status label reached `"Five-tap recognized (count: 1)"`
  through the real command-server boundary, and a redelivery of the
  identical `(sequence, epoch)` replayed byte-identical
  (`replayStatus: "cached-replay"`, matching `recordedAt` and
  `childHandledMs`) rather than re-executing — direct evidence for AC11
  ("ambiguous timeout never retries a batch without a replay-safe
  receipt") specifically for a `multiTap` batch child, not the type/tap
  child round 1's CLI-driven `sequence-batch-v2.json` exercised.
- `testFixtureFiveTapRecognizerPassesRepeatedWarmMultiTapActions` — see
  "Measured receipts" above (Runs 3 and 4): 100/100 recognized on both
  fresh runs, closing AC8 with direct evidence. Run 3 also surfaced a real
  flake against the then-committed `>=1.2x` assertion, which is itself
  independent-verification value the round-1 CLI proxy could not have
  produced (it never drove enough iterations to observe run-to-run p95
  variance).

`testUIActionBatchExecutesChildrenInOrderAndStopsAtFirstFailure` was not
re-run this round (not named in either review's findings, and round 1's
build-for-testing already re-compiled it) — its ordering/partial-failure
behavior was unchanged by this round's diff (only the doc comments and the
speedup assertion's constant changed, not `performRunnerUIActionBatch`
itself), so re-running it would have re-derived an unchanged fact, not
tested new code. `testCommandLoopReplaySafety`'s base-commit flake claim
remains unchanged from both prior rounds' caveat.
