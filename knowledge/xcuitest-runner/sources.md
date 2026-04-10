# XCUITest Runner Sources

Updated: 2026-04-09

## Primary Apple documentation

- `XCUIApplication`
  - https://developer.apple.com/documentation/xcuiautomation/xcuiapplication
  - https://developer.apple.com/documentation/xcuiautomation/xcuiapplication/activate()
  - https://developer.apple.com/documentation/xcuiautomation/xcuiapplication/launch()
  - https://developer.apple.com/documentation/xcuiautomation/xcuiapplication/launcharguments
  - https://developer.apple.com/documentation/xcuiautomation/xcuiapplication/state-swift.enum
  - https://developer.apple.com/documentation/xcuiautomation/xcuiapplication/resetauthorizationstatus(for:)
- `XCUIElement`
  - https://developer.apple.com/documentation/xcuiautomation/xcuielement
  - https://developer.apple.com/documentation/xcuiautomation/xcuielement/waitforexistence(timeout:)
  - https://developer.apple.com/documentation/xcuiautomation/xcuielement/exists
  - https://developer.apple.com/documentation/xcuiautomation/xcuielement/ishittable
  - https://developer.apple.com/documentation/xcuiautomation/xcuielement/debugdescription
- XCUI hierarchy and attribute APIs
  - https://developer.apple.com/documentation/xcuiautomation/xcuielementattributes
  - https://developer.apple.com/documentation/xcuiautomation/xcuielementsnapshot
  - https://developer.apple.com/documentation/xcuiautomation/xcuielementsnapshotproviding
- Screenshots
  - https://developer.apple.com/documentation/xcuiautomation/xcuiscreen
  - https://developer.apple.com/documentation/xcuiautomation/xcuiscreenshot
- XCTest lifecycle and attachments
  - https://developer.apple.com/documentation/xctest/defining-test-cases-and-test-methods
  - https://developer.apple.com/documentation/xctest/set-up-and-tear-down-state-in-your-tests
  - https://developer.apple.com/documentation/xctest/handling-ui-interruptions
  - https://developer.apple.com/documentation/xctest/xctattachment
  - https://developer.apple.com/documentation/xctest/adding-attachments-to-tests-activities-and-issues

## Apple workflow / CLI references

- Technical Note TN2339: Building from the Command Line with Xcode FAQ
  - https://developer.apple.com/library/archive/technotes/tn2339/_index.html
- Configuring your Xcode Cloud workflow’s actions
  - https://developer.apple.com/documentation/xcode/configuring-your-xcode-cloud-workflow-s-actions

## Apple videos / transcripts used as primary supporting sources

- Handle interruptions and alerts in UI tests (WWDC20)
  - https://developer.apple.com/videos/play/wwdc2020/10220/
  - Used for Apple-stated guidance on expected alerts vs interruption monitors, implicit interruption handling, and the note that `resetAuthorizationStatus(for:)` may terminate the app process.
- Record, replay, and review: UI automation with Xcode (WWDC25)
  - https://developer.apple.com/videos/play/wwdc2025/344/
  - Used for Apple-stated query-selection and accessibility-identifier guidance that affects Probe ref stability.

## Source quality notes

- All links above are Apple-operated docs, technotes, or WWDC transcripts.
- Observed facts in this pack are drawn directly from these sources.
- Probe-specific recommendations are kept separate in `integration-notes.md` as inferred guidance.
