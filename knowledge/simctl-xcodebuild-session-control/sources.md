# simctl + xcodebuild session control sources

Updated: 2026-04-09

## Existing adjacent packs checked first

- `knowledge/xcuitest-runner/`
  - Already captures runner-side XCTest lifecycle, attachments, and some `build-for-testing` / `test-without-building` notes.
  - This pack complements it with **host-side Simulator discovery, boot/session control, and CLI execution caveats** so later Probe work can reuse one simulator-control seam instead of rediscovering it.

## Local primary sources observed against the current toolchain

- Local Xcode version
  - `xcodebuild -version`
  - Observed value: `Xcode 26.3` (`Build version 17C529`)
- `simctl` command help
  - `xcrun simctl help`
  - `xcrun simctl help list`
  - `xcrun simctl help boot`
  - `xcrun simctl help bootstatus`
  - `xcrun simctl help shutdown`
  - `xcrun simctl help launch`
  - `xcrun simctl help terminate`
  - `xcrun simctl help openurl`
  - `xcrun simctl help privacy`
  - `xcrun simctl help spawn`
  - `xcrun simctl help io`
- `xcodebuild` command help
  - `xcodebuild -help`

## Apple documentation and primary supporting sources

- Technical Note TN2339: Building from the Command Line with Xcode FAQ
  - https://developer.apple.com/library/archive/technotes/tn2339/_index.html
  - Used for Apple-authored examples of `build-for-testing`, `test-without-building`, `.xctestrun`, and destination specifiers.
- Running tests and interpreting results
  - https://developer.apple.com/documentation/xcode/running-tests-and-interpreting-results
  - Used for current Apple documentation that `xcodebuild` test runs emit `.xcresults` bundles with logs and coverage.
- Configuring your Xcode Cloud workflow’s actions
  - https://developer.apple.com/documentation/xcode/configuring-your-xcode-cloud-workflow-s-actions
  - Used as a current Apple confirmation that testing runs in two phases: `build-for-testing` then `test-without-building`.
- Running your app in Simulator or on a device
  - https://developer.apple.com/documentation/xcode/running-your-app-in-simulator-or-on-a-device
  - Used for current Apple framing of Simulator as the standard run destination surface and for runtime/platform-support notes.
- WWDC19: Getting the Most Out of Simulator
  - https://developer.apple.com/videos/play/wwdc2019/418/
  - Used for Apple-stated guidance on `simctl`, JSON output for automation, simulator isolation model, and lifecycle/diagnostic commands.
- Xcode 12.2 Release Notes
  - https://developer.apple.com/documentation/xcode-release-notes/xcode-12_2-release-notes
  - Used for the Apple-documented caveat that `simctl` / `xcodebuild` may not see simulators when run from a non-root LaunchDaemon or as a different user.
- Xcode 16.1 Release Notes
  - https://developer.apple.com/documentation/xcode-release-notes/xcode-16_1-release-notes
  - Used for the resolved issue around UI-test screen recordings and `.xcresult` bundle paths containing spaces.

## Source quality notes

- Command help text from the installed Xcode toolchain is treated as a **primary source** for exact CLI flags and option wording.
- Apple docs and WWDC transcripts are treated as **primary product documentation** for higher-level workflow behavior.
- TN2339 is archived and older, so this pack uses it for exact command examples but cross-checks current behavior with:
  - current `xcodebuild -help`
  - Xcode Cloud docs
  - current test-results docs
- Release notes are used only for **version-specific caveats**, not as the main contract for command behavior.
