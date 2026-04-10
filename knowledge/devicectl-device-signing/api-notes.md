# devicectl and xcodebuild API notes

Last updated: 2026-04-10

## Observed facts

### `devicectl` top-level contract

- `devicectl` describes itself as a "Core Device command line utility" for interacting with devices connected to the host.
- Apple's local help explicitly states that JSON output written to a user-provided file is the **only supported interface** for scripts and programs to consume command output.
- Top-level subcommands are:
  - `device`
  - `diagnose`
  - `list`
  - `manage`

### Device discovery and DDI commands

- `devicectl list devices` lists devices CoreDevice knows about.
- `devicectl list preferredDDI` reports the DDI CoreDevice would use for a platform, and if no usable DDI exists it still returns the best unusable match.
- `devicectl manage ddis update` updates DDIs in `/Library/Developer/DeveloperDiskImages`.
  - By default it considers DDIs from the selected Xcode and `/Library/Developer/CoreDevice/CandidateDDIs`.
  - It can `--clean` the host DDI directory before repopulating it.
- `devicectl device info ddiServices` reports DDI-service metadata for a device.
  - Default behavior is `--auto-mount-ddis`, which checks whether the mounted DDI is current and updates it before fetching metadata.

### Pairing and install / launch commands

- `devicectl manage pair --device <...>` attempts to pair with a discovered device.
- `devicectl device install app --device <...> <path>` installs an **app bundle with a `.app` extension**.
- `devicectl device uninstall app --device <...> <bundle-id>` removes an installed app.
- `devicectl device process launch --device <...> <bundle-identifier-or-path>` launches a remote app.
  - It accepts either a bundle identifier or path.
  - It supports `--start-stopped`, `--terminate-existing`, `--console`, `--payload-url`, and foreground activation control.
  - Environment variables can be passed as a JSON dictionary or via caller environment variables prefixed with `DEVICECTL_CHILD_`.
- `devicectl device info apps` lists installed apps and defaults to developer apps unless additional include flags are used.

### Diagnostics

- `devicectl diagnose` gathers diagnostics from the host and from connected devices that have a mounted DDI.
- Local help explicitly references collecting preferred DDI information and CoreDevice diagnostics for bug reports.

### `xcodebuild` test and signing surface

- `build-for-testing` builds the target plus associated tests and produces an `xctestrun` file in the build root.
- `test-without-building` runs compiled bundles.
  - With `-scheme`, it looks for bundles in the build root.
  - With `-xctestrun`, it uses bundle paths specified in that file.
  - The man page states that this path requires project binaries and **does not require project source code**.
- `-testProductsPath` can be used with `build-for-testing` and `test-without-building` to emit or reuse XCTestProducts archives.
- `-allowProvisioningUpdates` allows `xcodebuild` to communicate with Apple Developer services.
  - For automatically signed targets, it can create and update profiles, app IDs, and certificates.
  - For manually signed targets, it can download missing or updated provisioning profiles.
- `-allowProvisioningDeviceRegistration` allows `xcodebuild` to register the destination device if necessary, but only when `-allowProvisioningUpdates` is also passed.

### Local host observations on this machine

- `xcodebuild -version` reports:
  - `Xcode 26.3`
  - `Build version 17C529`
- `xcode-select -p` reports the active developer directory as `/Applications/Xcode.app/Contents/Developer`.
- `xcrun devicectl list preferredDDI` on this host reports:
  - `Host CoreDevice version: 506.7`
  - usable DDIs for `iOS`, `tvOS`, `watchOS`, and `xrOS`
  - DDI location pattern `file:///Library/Developer/DeveloperDiskImages/<platform>_DDI/`
  - `contentIsCompatible: true`
  - `isUsable: true`
  - `variant: external`
  - no DDI found for `macOS`

## Inferences for Probe

- Probe should treat `devicectl` JSON-file output as the stable machine interface and avoid scraping human-readable stdout.
- Probe can use `devicectl` for install / launch / query flows, but only after pairing, Developer Mode, and DDI compatibility are satisfied.
- If later Probe work wants to install a helper directly with `devicectl`, the artifact shape must be a signed `.app` bundle rather than an `.ipa`.
- A documented real-device test-runner path exists through `xcodebuild build-for-testing` + `test-without-building`, which is more directly aligned with XCUITest than trying to infer an undocumented direct-launch path for test bundles.
