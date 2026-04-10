# devicectl device signing research sources

Last updated: 2026-04-10

## Scope

This pack covers public Apple surfaces and local tool help relevant to Probe's real-device work:

- `devicectl` command surface
- CoreDevice / DDI behavior
- real-device pairing and Developer Mode prerequisites
- XCUITest runner deployment paths
- signing / provisioning flows that Probe must not silently own

## Official Apple documentation

### Command-line and device tooling

1. [Xcode command-line tool reference](https://developer.apple.com/documentation/xcode/xcode-command-line-tool-reference)
   - Apple doc that names `devicectl`, `simctl`, and `xcodebuild` as Xcode-shipped tools.
   - Calls out `xcrun devicectl help` and `man xcodebuild` as the documentation entry points.

2. [Downloading and installing additional Xcode components](https://developer.apple.com/documentation/xcode/downloading-and-installing-additional-xcode-components)
   - Official Xcode component / platform support workflow.
   - Documents `xcodebuild -runFirstLaunch -checkForNewerComponents`, `-downloadPlatform`, and `-importPlatform`.

3. [Pairing your devices with Xcode](https://developer.apple.com/documentation/xcode/pairing-your-devices-with-xcode)
   - Official pairing flow, trust prompts, and run-destination readiness notes.

4. [Enabling Developer Mode on a device](https://developer.apple.com/documentation/xcode/enabling-developer-mode-on-a-device)
   - Official prerequisite for running locally installed / development-signed software on device.

5. [Xcode support matrix](https://developer.apple.com/support/xcode/)
   - Official Xcode/device support compatibility table.

### Testing and runner behavior

6. [Testing](https://developer.apple.com/documentation/xcode/testing)
   - Documents XCTest + XCUIAutomation as the UI testing path in Xcode.

7. [Adding tests to your Xcode project](https://developer.apple.com/documentation/xcode/adding-tests-to-your-xcode-project)
   - Documents UI test targets, `XCTestCase`, and `XCUIApplication().launch()` patterns.

8. [Running tests and interpreting results](https://developer.apple.com/documentation/xcode/running-tests-and-interpreting-results)
   - Documents `xcodebuild test` and `.xcresult` output.

9. [XCUIAutomation](https://developer.apple.com/documentation/xcuiautomation)
   - Official capability surface for UI automation, screenshots, element snapshots, and device simulation.

10. [Recording UI automation for testing](https://developer.apple.com/documentation/xcuiautomation/recording-ui-automation-for-testing)
    - Official statement that one UI test can interact with multiple installed apps on a device or Simulator.

### Signing and provisioning

11. [Distributing your app to registered devices](https://developer.apple.com/documentation/xcode/distributing-your-app-to-registered-devices)
    - Official registered-device distribution flow, automatic signing guidance, and Xcode installation flow for `.ipa` artifacts.

12. [Register a single device](https://developer.apple.com/help/account/devices/register-a-single-device/)
    - Official account-level device registration steps.

13. [Create a development provisioning profile](https://developer.apple.com/help/account/provisioning-profiles/create-a-development-provisioning-profile/)
    - Official manual development-signing prerequisites.

14. [Certificates](https://developer.apple.com/support/certificates/)
    - Official certificate handling guidance and certificate sensitivity warnings.

## Apple forum / staff primary sources

15. [Missing iOS 17 device support files](https://developer.apple.com/forums/thread/730947)
    - Apple staff + Developer Tools Engineer explanation of the CoreDevice shift.
    - Key quote: with iOS 17+, Apple uses a new CoreDevice stack with one DDI per platform, not per OS release.

16. [iOS device not showing in devicectl list](https://developer.apple.com/forums/thread/772724)
    - DTS clarification that `devicectl` supports iOS 17+ devices.

17. [Not able to connect iPad with Xcode](https://developer.apple.com/forums/thread/782137)
    - DTS troubleshooting guidance for DDI mismatch using `devicectl manage ddis update`, `list preferredDDI`, and `device info ddiServices`.

## Local tool help and host observations

18. `xcrun devicectl help`
19. `xcrun devicectl list --help`
20. `xcrun devicectl device --help`
21. `xcrun devicectl manage --help`
22. `xcrun devicectl help list preferredDDI`
23. `xcrun devicectl help manage ddis update`
24. `xcrun devicectl help manage pair`
25. `xcrun devicectl help device install app`
26. `xcrun devicectl help device process launch`
27. `xcrun devicectl help device info ddiServices`
28. `xcrun devicectl help device info apps`
29. `xcrun devicectl list preferredDDI`
30. `man xcodebuild` (filtered for `build-for-testing`, `test-without-building`, `-xctestrun`, `-allowProvisioningUpdates`, `-allowProvisioningDeviceRegistration`)
31. `xcodebuild -help`
32. `xcodebuild -version`
33. `xcode-select -p`

## Notes on source quality

- Prefer the Apple docs above for normative behavior.
- Use forum threads only for gaps where Apple staff clarified CoreDevice / `devicectl` behavior not captured well in docs.
- Use local help output as the authoritative source for the currently installed Xcode command surface on this host.
