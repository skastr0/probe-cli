# integration notes for Probe real-device work

Last updated: 2026-04-10

## Observed facts

### Probe architecture constraints

- `ARCHITECTURE.md` says Probe does **not** own builds, signing, or provisioning of the target app.
- The same architecture document says real-device support should prefer public Apple / Xcode surfaces and be explicit about hard walls.

### Pairing and Developer Mode prerequisites

- Apple documents pairing with Xcode as the path that makes a device available as a run destination.
- During pairing, the device must trust the Mac.
- Apple documents Developer Mode as required to run locally installed apps in iOS, iPadOS, watchOS, and visionOS.
- Apple documents that Developer Mode is relevant both for build-and-run from Xcode and for installing an `.ipa` with Apple Configurator.
- Apple documents that first-time pairing can require waiting while Xcode copies shared cache symbols or resolves compatibility issues.

### DDI / CoreDevice behavior

- Apple Developer Tools engineering staff stated that with iOS 17+, Apple uses a new CoreDevice stack and one DDI per platform rather than per OS release.
- The same thread states that copying `DeviceSupport` files between Xcode versions was never supported.
- Apple docs and local help both expose supported maintenance flows:
  - `xcodebuild -runFirstLaunch -checkForNewerComponents`
  - `xcrun devicectl manage ddis update`
  - `xcrun devicectl list preferredDDI`
  - `xcrun devicectl device info ddiServices`
- Apple DTS guidance shows DDI mismatch symptoms such as "connected (no DDI)" or failure to find a DDI with compatible CoreDevice content.

### `devicectl` support window

- An Apple DTS reply explicitly says `devicectl` supports iOS 17+ devices.
- Apple's current Xcode support matrix separately documents broad on-device debugging support by Xcode version.
- These two sources together imply that older devices may still be usable in Xcode while `devicectl` itself is not the correct automation surface for them.

### Runner and UI automation behavior

- Apple documents XCTest + XCUIAutomation as the public UI automation path in Xcode.
- Apple documents that UI tests interact with UI controls rather than calling app code directly.
- Apple documents that UI tests typically launch the app under test with `XCUIApplication().launch()`.
- Apple documents that one UI test can interact with **multiple installed apps** on the device or Simulator.
- Apple documents a build/execute split for tests via `xcodebuild build-for-testing` and `test-without-building`.

### Signing and provisioning behavior

- Apple documents that manual development signing requires:
  - an App ID
  - one or more development certificates
  - one or more registered devices
  - a development provisioning profile
- Apple documents that automatic signing can register connected devices for you.
- Apple documents that `xcodebuild -allowProvisioningUpdates` and `-allowProvisioningDeviceRegistration` can participate in profile and device management when allowed.
- Apple documents separate registered-device distribution flows for exported `.ipa` artifacts.

## Inferences for Probe

### Canonical boundary for Probe

- Probe should keep its current architectural boundary: it may consume signed artifacts and public tooling, but it should not silently become a signing / provisioning manager.
- Real-device setup errors should be surfaced as explicit prerequisite failures rather than retried with opaque magic.

### Suggested Probe preflight checks

- active Xcode selected (`xcode-select -p` / `xcodebuild -version`)
- device is paired / trusted
- Developer Mode enabled on device
- device OS is in the `devicectl` support window when using `devicectl`
- usable DDI available on host
- DDI services mountable on the device
- runner artifact already built and signed

### Suggested deployment split

- **Target app under test:** outside Probe ownership; developer or existing build system provides it.
- **Probe runner artifact:** likely produced externally through Xcode / `xcodebuild` and then reused by Probe.
- **Probe runtime operations:** install, inspect, launch, terminate, and query via documented tools (`devicectl`, `xcodebuild`, LLDB) once prerequisites are satisfied.

### Most plausible documented runner path today

- For a true XCUITest-based runner, the most documented path is to build it through Xcode / `xcodebuild`, then execute it via `test` or `test-without-building` using generated test products / `xctestrun` metadata.
- `devicectl` looks well-suited for app install / launch / state inspection, but the captured docs do **not** document direct execution of an XCUITest bundle through `devicectl` alone.

### Important Probe-facing hard walls

- `devicectl` is not the right fallback for iOS 16-era devices.
- DDI mismatches are a first-class failure mode.
- Xcode / CoreDevice updates can change device compatibility without the old `DeviceSupport` copying escape hatch.
- Any plan that assumes Probe can locally re-sign arbitrary target apps or runner artifacts is outside the documented boundary captured here.

### Local host spike observations (2026-04-10)

- `./ios/ProbeRunner/scripts/validate-real-device-signing-and-devicectl.sh` produced a durable summary at `knowledge/devicectl-device-signing/host-validation-results.json`.
- On this host, `xcodebuild build-for-testing -destination "generic/platform=iOS"` currently fails for both `ProbeFixture` and `ProbeRunnerUITests` with `Signing for "..." requires a development team`, which matches the empty `DEVELOPMENT_TEAM` values in the project file.
- The same `build-for-testing` command succeeds with `CODE_SIGNING_ALLOWED=NO`, which proves the current Probe app + runner sources compile for `iphoneos` and emit the expected `.app`, `.xctest`, and `.xctestrun` products.
- `codesign --verify --deep --strict` still fails on the unsigned `ProbeFixture.app` and `ProbeRunnerUITests.xctest`, so those artifacts are not deployable to a physical device as produced by the unsigned path.
- `xcrun devicectl list preferredDDI --json-output ...` succeeds on this host and reports a usable iOS DDI under `/Library/Developer/DeveloperDiskImages/iOS_DDI/`.
- `xcrun devicectl list devices --json-output ...` currently reports zero connected devices on this host, so `manage pair`, `device info ddiServices`, `device info apps`, `device install app`, and `device process launch` remain host-surface validations only until real hardware is connected.

## PRB-095: signing precedence + signed runner build cache (2026-07-17)

Closes the gap this pack's earlier "Important Probe-facing hard walls" section
implicitly left open: signing input was daemon-environment-only, and every
real-device open re-ran `build-for-testing` unconditionally (see PRB-095's
Problem statement -- `RealDeviceHarness.ts:2099`/`2115` in the pre-fix
implementation).

### Signing input precedence (resolved client-side, not daemon-side)

- The Probe daemon is long-lived; the CLI/client process that issues a
  `session open` command is short-lived and holds the command-scoped
  environment. Resolving the team in the daemon (the pre-fix behavior) meant
  a freshly-exported `PROBE_DEVELOPMENT_TEAM` never reached an
  already-running daemon.
- Fix: `DeviceSigningConfig.resolveDevelopmentTeamFromHost` resolves
  **explicit session-open payload > persisted `~/.probe/config.json` >
  `PROBE_DEVELOPMENT_TEAM`** inside `DaemonClient.openSession` (client-side),
  and only the resolved (non-secret) team id crosses the session-open RPC.
  `RealDeviceHarness.performPreflight` no longer reads `process.env` at all.
- Verified end-to-end on this host (real daemon, real `devicectl`, no
  `PROBE_DEVELOPMENT_TEAM` exported): `session open --target device` with no
  `--team-id` returned `"No signing team is configured for the real-device
  runner build."` alongside the live devicectl device-selection issue ("Found
  2 connected real devices") in the same preflight report -- proving the
  environment is genuinely read fresh per command, not from a stale daemon
  snapshot.

### Signed runner build cache (`RunnerBuildCache`)

- Cache key: `sha256` over `{ runtimeAssetHash, runnerSourceHash (content
  hash of ios/ProbeFixture + ios/ProbeRunner + project.pbxproj),
  xcodeVersion, sdkVersion, platform, arch, developmentTeam, signingIdentity,
  profileIdentity, buildSettingsHash }`. `signingIdentity`/`profileIdentity`
  stay pinned to `"automatic"` in the key today because Xcode's
  `-allowProvisioningUpdates` path chooses the concrete identity/profile, and
  Probe's session-open contract only carries a team id (not an explicit
  identity override) -- the *discovered* concrete values are recorded as
  cache-entry metadata and drive revalidation instead.
- Publish is atomic: build into `<key>.building-<pid>-<token>/`, verify
  (products exist, `codesign --verify --deep --strict`, embedded profile
  decodes with a UUID + future `ExpirationDate`), write `entry.json`, then
  `rename()` onto the final `<key>/` directory. A failed/interrupted build
  never reaches the rename, so it never becomes a lookup hit.
- Hit revalidation re-checks product existence, both apps' code signatures,
  and the *stored* profile expiry against `now()` -- not a fresh
  `verifyProduct` re-derivation of expiry, since the embedded profile file
  itself does not change between opens for an unchanged cache entry.
- Concurrent opens for one key coalesce via an in-process `Map<key,
  Promise<outcome>>` (module-level in `RunnerBuildCache.ts`), scoped to one
  daemon process. Cross-process publish races are a best-effort fallback
  (`rename` losing to `ENOTEMPTY`/`EEXIST` re-reads the winner's
  `entry.json`) rather than a coalescing guarantee -- Probe runs one daemon
  per project, so this is a defensive backstop, not the primary mechanism.
- Measured on this host with fakes (`RunnerBuildCache.test.ts`, 11 cases):
  first open for a key = 1 build, next 10 opens for the same key = 0 builds;
  concurrent opens for one key = 1 build; a failed build leaves zero
  `.building-*` directories behind; an expired stored profile or a tampered
  signature both invalidate and force a rebuild with a recorded
  `invalidationReason`.
- Measured for real on this host (real Xcode 26.6, real
  `ios/ProbeFixture`/`ios/ProbeRunner`, real `codesign`/`security`, a real
  paired-but-locked iPhone, an Xcode-known "Apple Development" identity with
  no signed-in account for its team): a live `session open --target device
  --team-id 3WQ8B23QHR` ran a real `xcodebuild build-for-testing`, produced a
  real cache key (`015928f9178a887fd68c8529`), and failed with the real
  Xcode error `No profiles for 'dev.probe.fixture'/'...xctrunner' were
  found` -- Probe's existing `inferBuildForTestingNextStep` correctly matched
  the `/No profiles for /i` pattern and surfaced the "ensure Xcode can create
  or download development provisioning profiles" next step. After the
  failure, `~/.probe/runner/device/signed-cache/<key>/` did not exist and no
  `.building-*` temp directory was left behind, confirming the
  never-publish-on-failure guarantee on real hardware, not just against
  fakes. `codesign`/`security`/`verifySignedRealDeviceProduct` were also
  exercised for real against a locally ad-hoc-signed fixture bundle (no team
  required) in `RealDeviceHarness.processHelpers.test.ts`.
- **Not measured on this host** (glyph stays open pending a human-run pass):
  a full cold-open + ten-warm-open cycle against physical hardware, and the
  "cache-hit preflight adds at most one second" latency budget -- both
  require a working `DEVELOPMENT_TEAM`/signed-in Apple Developer account,
  which this host does not have. The `RunnerBuildCache.test.ts` timing-free
  hit/miss-count assertions are the closest coverage available without one.

### Local host spike observations, updated

- `xcrun devicectl list devices --json-output ...` now reports 2 connected
  real devices on this host (an Apple Watch, `unavailable`, and a paired
  iPhone) -- the earlier "zero connected devices" note above is stale for
  this host as of 2026-07-17; device-selection and DDI-services logic were
  exercised for real against the iPhone (DDI-services failed with
  `kAMDMobileImageMounterDeviceLocked`, a device-lock-screen state, not a
  Probe defect).

### Local host spike observations (2026-07-17, PRB-096)

- The implementation host now has connected devices visible to `devicectl` (`xcrun devicectl list devices`): an Apple Watch (`unavailable`) and an iPhone reported `available (paired)` in the table view but `disconnected` in the JSON `connectionProperties.tunnelState` field for this run -- the two views can disagree moment-to-moment; treat the JSON field as authoritative for automation.
- `xcrun devicectl device info processes --device <id> --json-output <path>` is a documented CoreDevice subcommand ("List currently running processes on the device") and supports `--filter` with an `NSPredicate`-style expression (e.g. `processIdentifier == 123`), matching the `devicectl list ... --filter` pattern already used elsewhere in this codebase.
- Exercising it against the connected iPhone on this host fails before producing any JSON: `ERROR: The developer disk image could not be mounted on this device. ... Error mounting image: kAMDMobileImageMounterDeviceLocked: The device is locked.` This is a **DDI-mount / device-lock blocker**, not a `devicectl` capability gap and not a Probe defect -- it matches this pack's existing DDI-mismatch hard-wall category, just triggered by "device locked" rather than a DDI version mismatch. Unlocking the device (and, separately, a signed `DEVELOPMENT_TEAM` for any command that also needs to launch/attach an app) are host-environment prerequisites this pack already documents as out of Probe's ownership.
- Consequence for PRB-096: real-device target-process identity verification (`TargetProcessIdentity.ts`'s `devicectl device info processes` path) is implemented and structurally consistent with the `{info, result: {...}}` JSON envelope confirmed for `devicectl list devices`, but is **unexercised against a real success case** on this host -- it fails closed (typed pre-spawn error, no xctrace spawn) on the DDI/lock blocker above, which is the correct behavior for an unverifiable device, not a false positive. Simulator-target identity verification (`ps -p <pid> -o pid=,comm=`) *was* exercised against a real, live `ProbeFixture.app` process on a booted simulator on this host and works as designed.

### Local host spike observations (2026-07-18, PRB-092)

- PRB-092's device-gated acceptance criteria (the 20/20 Ripple five-tap-unlock gate on the connected iPhone 13 Pro, and the physical-device half of "real Swift Simulator and physical-device boundary tests replace fake-only proof") require a `uiActionBatch`/`multiTap` XCUITest run on that device. One bounded attempt was made per the glyph's PHYSICAL-DEVICE gate instruction: `xcodebuild -project ios/ProbeFixture/ProbeFixture.xcodeproj -scheme ProbeRunner -destination "id=<device>" build-for-testing`, both against the `devicectl`-reported identifier (`9FE1EE68-650B-590A-B131-48E1575FBE5A`) and the `xcodebuild`-resolved identifier for the same physical iPhone (`00008110-0006293936C0401E`, name "iPhone (2)").
- Both attempts failed identically and immediately, before any signing step: `xcodebuild: error: Timed out waiting for all destinations matching the provided destination specifier to become available`, with the destination itself reporting `error:The developer disk image could not be mounted on this device.` — the same DDI-mount hard-wall category this pack already documents above (PRB-096's `kAMDMobileImageMounterDeviceLocked` entry), this time surfaced at the `xcodebuild` destination-resolution step rather than inside a `devicectl device info` subcommand.
- This host also has no `DEVELOPMENT_TEAM` set (`security find-identity -v -p codesigning` lists only a Developer ID / iPhone Distribution / Apple Development identity, none selected as an active team) — so even past the DDI-mount blocker, the build would still need a signing team before it could produce a runnable `.xctestrun`.
- Consequence for PRB-092: the Ripple 20/20 gate and the physical-device boundary-test acceptance criterion stay **partial** — implemented and Simulator-boundary-tested (see this glyph's Swift test suite and knowledge/xcuitest-runner/integration-notes.md's "PRB-092" section), but not exercised against real hardware on this host. Unlocking the paired device and providing a signed `DEVELOPMENT_TEAM` are the same host-environment prerequisites this pack already lists below, unchanged by this glyph.

### User-setup, retry, and fallback requirements

- User setup for the real-device path currently means:
  - select the intended Xcode with `xcode-select`
  - pair and trust the device in Xcode
  - enable Developer Mode on the device
  - use an iOS 17+ device when the flow depends on `devicectl`
  - provide signing/team settings that can sign **both** `ProbeFixture` and `ProbeRunnerUITests`
- Retry guidance should stay explicit:
  - rerun `devicectl list devices` and `device info ddiServices` after pairing, trust, or Developer Mode changes
  - rerun `xcodebuild -runFirstLaunch -checkForNewerComponents` and `xcrun devicectl manage ddis update` before retrying after DDI mismatch symptoms
  - retry install / launch only after a signed build exists; Probe should not mask missing-team or unsigned-artifact failures with opaque retries
- Fallback guidance should also stay explicit:
  - if no device is connected, stop at host-side validation and keep the real-device path in a degraded / blocked state
  - if the device falls outside the `devicectl` support window, keep using Simulator or surface a different Xcode-managed path explicitly
  - if signed runner artifacts are unavailable, require externally built and signed artifacts rather than expanding Probe into a provisioning manager
