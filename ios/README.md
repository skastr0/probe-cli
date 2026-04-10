# iOS components

- `ios/ProbeFixture/` now contains the minimal UIKit fixture app used to validate Probe runner attach/control work.
- `ios/ProbeRunner/` now contains the minimal XCUITest attach/control spike used to validate Probe's pre-launched-app control promise.

The fixture stays intentionally small and honest:

- it builds with standard Xcode tooling
- it installs on Simulator with `simctl`
- it exposes stable accessibility identifiers and a few common UI shapes
- it exists to support Probe validation, not product polish
