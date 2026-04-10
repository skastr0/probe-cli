# simctl + xcodebuild session control API notes

Accessed: 2026-04-09

Legend:

- **Observed** = directly supported by a cited source.
- **Inference** = derived for Probe and called out as such.

## 1. `simctl` device targeting and discovery

- **Observed:** `simctl` subcommands that take a `<device>` argument accept either a device UDID or the special `booted` selector. If multiple devices are booted, `simctl` “will choose one of them.” Source: `xcrun simctl help`.
- **Observed:** `simctl list` can emit machine-readable JSON with `-j | --json`. It can filter to `devices`, `devicetypes`, `runtimes`, or `pairs`, and supports a search term or the special `available` search term. Source: `xcrun simctl help list`.
- **Observed:** WWDC19 explicitly recommends JSON output for automation: “the list command also has a json flag… a machine-readable json file that you can use for automation purposes.” Source: WWDC19 _Getting the Most Out of Simulator_.
- **Observed:** WWDC19 recommends using full identifiers for automation and scripting rather than relying on shorter human-oriented names. Source: WWDC19 _Getting the Most Out of Simulator_.

## 2. `simctl` boot and shutdown lifecycle

- **Observed:** `simctl boot <device>` boots a device or device pair. It supports:
  - `--arch=<arch>`
  - `--disabledJob=<job>`
  - `--enabledJob=<job>`
  - `--checked-allocations`

  Source: `xcrun simctl help boot`.

- **Observed:** `simctl bootstatus <device>` “prints boot status information until the device finishes booting.” It can be called safely before a boot attempt. It supports:
  - `-b` boot if not already booted
  - `-c` continuously monitor across boot/shutdown cycles
  - `-d` print data-migration info

  Source: `xcrun simctl help bootstatus`.

- **Observed:** `simctl shutdown <device> | all` shuts down a specific simulator or all running simulators. Source: `xcrun simctl help shutdown`.
- **Observed:** WWDC19 describes `boot`, `shutdown`, `delete`, and `clone` as normal command-line lifecycle surfaces for simulator automation. Source: WWDC19 _Getting the Most Out of Simulator_.

## 3. `simctl` app and session control surfaces

- **Observed:** `simctl launch <device> <bundle-id>` can:
  - wait for debugger (`-w` / `--wait-for-debugger`)
  - choose an architecture (`--arch`)
  - connect app stdio to the terminal (`--console`, `--console-pty`)
  - redirect stdout/stderr to files (`--stdout`, `--stderr`)
  - kill an existing running instance first (`--terminate-running-process`)
  - enable checked allocations (`--checked-allocations`)

  Source: `xcrun simctl help launch`.

- **Observed:** `simctl terminate <device> <bundle-id>` terminates an application by bundle identifier. Source: `xcrun simctl help terminate`.
- **Observed:** `simctl openurl <device> <URL>` opens a URL in a device. Source: `xcrun simctl help openurl`.
- **Observed:** `simctl privacy <device> <action> <service> [<bundle-id>]` supports `grant`, `revoke`, and `reset`, and some permission changes “will terminate the application if running.” Apple also warns that using this command to bypass normal permission-request requirements “can mask bugs.” Source: `xcrun simctl help privacy`.
- **Observed:** `simctl spawn <device> <path> [args...]` executes a process inside the simulated environment. Source: `xcrun simctl help spawn`.
- **Observed:** For `boot`, `launch`, and `spawn`, environment variables can be injected into the simulated environment by setting them in the caller with a `SIMCTL_CHILD_` prefix. Sources: `xcrun simctl help boot`, `xcrun simctl help launch`, `xcrun simctl help spawn`.
- **Observed:** `simctl io <device> screenshot <file>` and `recordVideo <file|url>` are first-class simulator IO operations. Source: `xcrun simctl help io`.

## 4. Simulator environment model from Apple’s WWDC guidance

- **Observed:** Apple describes each simulator as “essentially a separate userspace” with its own:
  - `launchd`
  - daemons
  - frameworks
  - applications

  and as isolated from both macOS userspace and other running simulators. Source: WWDC19 _Getting the Most Out of Simulator_.

- **Observed:** WWDC19 also says simulators share the same filesystem but have separate Home directories, notification domains, URL sessions, and Mach bootstraps. Source: WWDC19 _Getting the Most Out of Simulator_.
- **Observed:** Apple positions `spawn` as the mechanism for running tools inside that simulated environment, including examples with `defaults` and `log stream`. Source: WWDC19 _Getting the Most Out of Simulator_.
- **Observed:** Apple positions `diagnose` as a way to collect logs and system state for automated failure capture. Source: WWDC19 _Getting the Most Out of Simulator_.

## 5. `xcodebuild` test execution model relevant to Probe

- **Observed:** TN2339 documents three related testing actions:
  - `xcodebuild test`
  - `xcodebuild build-for-testing`
  - `xcodebuild test-without-building`

  Source: TN2339.

- **Observed:** `build-for-testing` generates an `.xctestrun` file in DerivedData. Source: TN2339.
- **Observed:** `test-without-building` requires either:
  - a scheme (`-scheme ...`) and a destination, or
  - an `.xctestrun` file (`-xctestrun ...`) and a destination

  Source: TN2339.

- **Observed:** TN2339 documents that `test-without-building` supports `-only-testing:` and `-skip-testing:` filters in both the scheme-based and `.xctestrun`-based forms. Source: TN2339.
- **Observed:** Xcode Cloud’s current docs describe a test action as a two-phase flow:
  1. `xcodebuild build-for-testing`
  2. `xcodebuild test-without-building`

  Source: _Configuring your Xcode Cloud workflow’s actions_.

## 6. Destination selection and concurrency surfaces

- **Observed:** `xcodebuild -destination` takes a comma-separated set of `key=value` pairs describing the destination. Source: `xcodebuild -help`.
- **Observed:** `xcodebuild -destination-timeout <seconds>` exists to wait while searching for a destination. Source: `xcodebuild -help`.
- **Observed:** `xcodebuild -showdestinations` exists to list destinations. Source: `xcodebuild -help`.
- **Observed:** TN2339 documents that iOS Simulator / tvOS Simulator destination specifiers support:
  - `platform`
  - `name`
  - `id`
  - `OS`

  and that `OS` is optional. Source: TN2339.

- **Observed:** TN2339 documents that multiple destinations can be specified by repeating `-destination`. Source: TN2339.
- **Observed:** Current `xcodebuild -help` exposes test concurrency controls including:
  - `-maximum-concurrent-test-device-destinations`
  - `-maximum-concurrent-test-simulator-destinations`
  - `-parallel-testing-enabled`
  - `-parallel-testing-worker-count`
  - `-maximum-parallel-testing-workers`

  Source: `xcodebuild -help`.

## 7. Result bundles, streams, and test artifacts

- **Observed:** `xcodebuild -resultBundlePath <path>` specifies the directory where a result bundle describing what occurred will be placed. Source: `xcodebuild -help`.
- **Observed:** `xcodebuild -resultStreamPath <path>` specifies the file where a result stream will be written, and “the file must already exist.” Source: `xcodebuild -help`.
- **Observed:** Current help reports `-resultBundleVersion 3` as the default result bundle version. Source: `xcodebuild -help`.
- **Observed:** Apple’s current testing docs state that when tests are run with `xcodebuild` in Terminal, the command outputs an Xcode Test Results (`.xcresults`) bundle containing session results, code coverage (if enabled), and other logs. Source: _Running tests and interpreting results_.
- **Observed:** Xcode Cloud docs state that after a test action completes, test products and the result bundle are made available as artifacts. Source: _Configuring your Xcode Cloud workflow’s actions_.

## 8. Version-specific caveats worth preserving

- **Observed:** Xcode 12.2 release notes document that simulators “may not be available” when tools like `simctl` or `xcodebuild` are run from a non-root LaunchDaemon, or as a different user (for example via `sudo` or `launchctl`). Source: Xcode 12.2 Release Notes.
- **Observed:** Xcode 16.1 release notes document a resolved issue where screen recordings and `.xcresult` bundles could fail when a scheme name or `.xcresult` path contained spaces. Source: Xcode 16.1 Release Notes.
