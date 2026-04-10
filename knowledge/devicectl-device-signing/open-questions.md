# open questions and risks

Last updated: 2026-04-10

## Open questions

### 1. What is the canonical Probe runner execution path on real devices?

- Observed facts:
  - XCUITest runner behavior is well documented through XCTest / XCUIAutomation and `xcodebuild` test actions.
  - `devicectl` install / launch flows are documented for `.app` bundles.
- Unknown:
  - whether Probe should standardize on `xcodebuild build-for-testing` + `test-without-building`
  - or whether there is a better documented hybrid flow for a reusable on-device runner

### 2. What signing / team constraints apply to a reusable Probe UI-test runner?

- Observed facts:
  - UI tests can interact with multiple installed apps.
  - development signing still requires certificates, registered devices, and profiles.
- Unknown:
  - how far a Probe-owned runner can go when the target app belongs to a different team / bundle setup
  - whether some later design will require the runner to be built inside the target app's workspace rather than as a generic standalone Probe asset

### 3. What artifact contract should later work items assume?

- Candidate shapes:
  - signed `.app` bundle for direct `devicectl device install app`
  - `xctestrun` + built products for `test-without-building`
  - XCTestProducts archive via `-testProductsPath`
- Later implementation work should pick one canonical artifact contract before coding daemon flows.

### 4. What `devicectl` JSON schemas should Probe treat as stable enough to model?

- Observed facts:
  - Apple says file-based JSON output is the supported machine interface.
- Unknown:
  - exact JSON shapes for `list devices`, `list preferredDDI`, `device info ddiServices`, `device install app`, and `device process launch` across supported Xcode versions

### 5. How much of pairing / Wi-Fi readiness can Probe observe directly?

- Apple docs say Xcode can continue using Wi-Fi with IPv6 after successful pairing.
- Later work should determine whether Probe needs explicit wired-only guidance for initial setup and how to represent Wi-Fi readiness vs paired-but-not-routable states.

## Risks

- **Documentation gap risk:** `devicectl` is partly documented through local help and forum clarifications rather than a rich standalone web reference.
- **Compatibility risk:** DDI / CoreDevice mismatches can break real-device flows even when the device is physically connected.
- **Support-window risk:** `devicectl` support begins at iOS 17+, so older physical devices need a different handling path.
- **Artifact-shape risk:** Xcode docs use `.ipa` for some install flows while `devicectl` documents `.app` installation; later code must avoid conflating those shapes.
- **Boundary creep risk:** it will be tempting for Probe to paper over signing / provisioning issues; the current architecture explicitly says not to own that layer.
