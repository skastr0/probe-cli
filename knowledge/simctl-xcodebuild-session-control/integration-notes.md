# simctl + xcodebuild session control integration notes

Accessed: 2026-04-09

Legend:

- **Observed** = directly supported by a cited source.
- **Inference** = derived for Probe from the observed sources.

## Scope split against adjacent knowledge packs

- **Observed:** `knowledge/xcuitest-runner/` already covers runner-side XCTest lifecycle and UI-test semantics.
- **Inference:** Keep this pack focused on **host-side simulator control and CLI execution**:
  - simulator discovery
  - boot / shutdown / readiness
  - app launch / termination / permissions
  - `xcodebuild test-without-building` invocation shape
  - result-bundle handling

## Probe-oriented guidance

### 1. Device identity and session opening

- **Inference:** Probe should resolve a simulator once with `simctl list --json`, choose a concrete UDID, and store that UDID in session state.
- **Inference:** Probe should avoid the `booted` alias for daemon-owned operations because Apple explicitly says that if multiple simulators are booted, `simctl` will pick one of them.
- **Inference:** A good open-session primitive is:
  1. discover / validate the target UDID with `simctl list --json`
  2. call `simctl bootstatus -b <udid>`
  3. treat success as the readiness gate for later session steps

- **Observed:** Apple says `bootstatus` is safe to call before attempting boot and can boot the device with `-b`. Source: `xcrun simctl help bootstatus`.

### 2. Session-safe app control

- **Inference:** Probe should treat these as distinct host-side operations:
  - **launch / relaunch** = `simctl launch`
  - **terminate** = `simctl terminate`
  - **open deep link** = `simctl openurl`
  - **permission mutation** = `simctl privacy`

- **Inference:** `simctl launch --terminate-running-process` is the cleanest host-side primitive when Probe wants an explicit fresh app process.
- **Inference:** Probe should treat `simctl privacy` as potentially disruptive session control because Apple says some permission changes terminate the app if it is running.
- **Inference:** Any permission-grant or permission-reset operation should update session state as if an app restart may be required.

### 3. Host-side environment and diagnostics

- **Inference:** If Probe needs host-controlled launch environment overrides for simulator processes, the documented path is `SIMCTL_CHILD_*` environment variables rather than shell-specific ad hoc tricks.
- **Inference:** `simctl launch --stdout`, `--stderr`, `--console`, and `--console-pty` are useful as diagnostic fallbacks, but they should remain secondary to Probe’s primary artifact/logging model.
- **Inference:** `simctl diagnose` is a good failure-artifact escalation step for simulator-control bugs and CI flakiness because Apple positions it for automated failure capture.

### 4. `xcodebuild` runner invocation shape

- **Inference:** Probe’s runner-related session execution should default to the same split Apple documents in both TN2339 and Xcode Cloud:
  - prepare test products with `build-for-testing`
  - execute them with `test-without-building`

- **Inference:** For a Probe session, prefer one explicit simulator destination:

  ```text
  -destination 'platform=iOS Simulator,id=<UDID>'
  ```

  This aligns with Probe’s architecture invariant of one session = one device + one app.

- **Inference:** Scheme-based `test-without-building` is the simplest path when Probe is running within a known workspace/project context.
- **Inference:** `.xctestrun`-based `test-without-building` is the better seam when Probe wants to decouple execution from the build step, cache test products, or resume from previously prepared artifacts.

### 5. Result-bundle and artifact policy

- **Observed:** `xcodebuild` supports explicit result-bundle and result-stream paths. Sources: `xcodebuild -help`, _Running tests and interpreting results_.
- **Inference:** Probe should always pass an explicit `-resultBundlePath` into its per-session artifact root so `.xcresults` paths are stable and drillable.
- **Inference:** Probe should only use `-resultStreamPath` when it has a concrete consumer and can pre-create the file, because Apple’s help says the file must already exist.
- **Inference:** The `.xcresults` bundle should be treated as a first-class artifact alongside any summarized inline response.

### 6. Operational constraints for a daemon-first Probe

- **Observed:** Xcode 12.2 release notes warn that simulators may not be available when `simctl` / `xcodebuild` are run from a non-root LaunchDaemon or as a different user (for example with `sudo` or `launchctl`). Source: Xcode 12.2 Release Notes.
- **Inference:** Probe’s daemon should run in the interactive user context that owns the Simulator state, not through `sudo` or a cross-user service wrapper.
- **Inference:** Any future LaunchAgent / login-item packaging work should validate simulator visibility explicitly instead of assuming shell behavior carries over.

### 7. Version floor guidance

- **Observed:** Xcode 16.1 fixed a path-with-spaces issue involving UI-test screen recordings and `.xcresult` paths. Source: Xcode 16.1 Release Notes.
- **Inference:** If Probe needs to support older Xcode versions, it should define a minimum-supported Xcode version and keep artifact paths conservative until compatibility is proven.
- **Inference:** If Probe only targets current Xcode versions, this release-note item is mostly a historical compatibility note rather than a blocker.
