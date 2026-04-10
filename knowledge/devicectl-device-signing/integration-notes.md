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
