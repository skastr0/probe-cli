# XCUITest Runner Integration Notes

Updated: 2026-04-09

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
