# XCUITest Runner API Notes

Updated: 2026-04-09

## Observed facts

### `XCUIApplication`

- `XCUIApplication` is `@MainActor`, inherits from `XCUIElement`, and conforms to snapshot, screenshot, and query-provider protocols.
- `init()` creates a proxy for the target application configured in the UI test target.
- `init(bundleIdentifier:)` and `init(url:)` create proxies for a specific installed app or app URL.
- `launch()` is synchronous. When it returns, the app is ready to handle user events.
- If the app is already running, `launch()` terminates the existing instance before starting a clean one.
- `launchArguments` is mutable. Changes made after launch do not affect the current launch session; they apply on the next launch.
- `activate()` is synchronous, launches the app if needed, and does **not** terminate an already-running instance.
- Apple states that if the app was previously launched via `launch()`, `activate()` reuses the original launch arguments and environment variables.
- `state` exposes UI-test-visible app states including `unknown`, `notRunning`, `runningBackgroundSuspended`, `runningBackground`, and `runningForeground`.
- `wait(for:timeout:)` waits for a specific `XCUIApplication.State`.
- `resetAuthorizationStatus(for:)` exists for protected-resource permission state resets.

### `XCUIElement`

- `XCUIElement` is the base interaction type for taps, swipes, presses, typing, picker/slider adjustment, and coordinate generation.
- `exists` means the element is present in the current UI hierarchy.
- Apple explicitly notes that `exists` does not imply `isHittable`.
- `isHittable` is true only when the element exists and the system can compute a hit point at its current location.
- Apple notes `isHittable` is false for offscreen or obscured elements, even when an interaction method may be able to scroll the element into view.
- `waitForExistence(timeout:)`, `waitForNonExistence(timeout:)`, and `wait(for:toEqual:timeout:)` are the built-in wait primitives.
- `children(matching:)` returns direct-child queries; `descendants(matching:)` returns descendant queries.
- `coordinate(withNormalizedOffset:)` creates an `XCUICoordinate` relative to the element.
- `debugDescription` may include attributes, descendants, and query information, but Apple says to use it for debugging only and not depend on it in test logic.

### `XCUIElementAttributes` and `XCUIElementSnapshot`

- `XCUIElementAttributes` exposes accessibility-backed identity and state including:
  - `identifier`
  - `elementType`
  - `value`
  - `placeholderValue`
  - `title`
  - `label`
  - `hasFocus`
  - `isEnabled`
  - `isSelected`
  - `frame`
  - horizontal and vertical size class
- Apple states these attributes are accessibility-exposed data available during query matching.
- `XCUIElementSnapshot` extends `XCUIElementAttributes` with:
  - `children`
  - `dictionaryRepresentation`
- `dictionaryRepresentation` is hierarchical and includes the element’s attributes plus descendants.

### `XCUIScreen` and screenshots

- `XCUIScreen.main` returns the current device’s main screen.
- `XCUIScreen.screens` returns the device’s active screens.
- `screenshot()` is provided through `XCUIScreenshotProviding` and works for both `XCUIScreen` and `XCUIElement`.
- `XCUIScreenshot` captures UI state at the moment the screenshot is taken.
- `XCUIScreenshot` exposes both a platform-native image object and `pngRepresentation`.

### `XCTAttachment`

- `XCTAttachment` can be created from data, files, directories, strings, images, screenshots, plist objects, and secure-codable objects.
- Screenshot attachments can be created directly from `XCUIScreenshot`.
- Attachment metadata includes `name`, `uniformTypeIdentifier`, and `userInfo`.
- Attachment retention is governed by `XCTAttachment.Lifetime`.

### `XCUIElementQuery` (PRB-091: the public-XCUI query planner surface)

Every method below is public API used by Probe's `uiAction` selector resolver
(`ios/ProbeRunner/AttachControlSpikeUITests.swift`: `narrowedUIActionQuery`,
`boundedMatchingElements`, `boundedSectionMatches`). No private/undocumented
API is used anywhere in that path.

- `XCUIElement.descendants(matching:)` returns an `XCUIElementQuery` scoped
  to a specific `XCUIElement.ElementType` (or `.any`). This is the query
  root — it does not itself materialize or enumerate anything.
- `XCUIElementQuery.matching(identifier:)` narrows a query to elements whose
  `identifier` equals the given string. This is Apple's own typed identifier
  predicate and is the narrowest public query available for a strong
  locator — Probe applies it first, before any weaker field, for every
  identifier-bearing locator.
- `XCUIElementQuery.matching(_:NSPredicate)` narrows a query with an
  arbitrary predicate. Probe uses this to push `label ==` / `placeholderValue
  ==` narrowing into the query itself (a compound `AND` predicate when both
  are present) rather than materializing every element of the given type and
  filtering client-side.
- `XCUIElementQuery.element(boundBy:)` returns a single `XCUIElement` proxy
  for the match at a specific index, evaluated lazily. Probe's bounded
  scanner (`boundedMatchingElements`) reads a query exclusively through this
  method — `index = 0, 1, 2, ...` — checking `.exists` at each step and
  stopping the moment it has proven what it needs (zero vs one vs "more than
  one", or the requested ordinal). This is the mechanism that satisfies
  "materializes only enough matches to distinguish zero, one, or many": there
  is no public API to ask a query for a bounded/lazy match count directly, so
  index-bounded `element(boundBy:)` probing is the correct public substitute
  for `.allElementsBoundByIndex` (which forces full, eager materialization of
  every match as an `XCUIElement`).
- `XCUIElementQuery.count` was considered and rejected for ambiguity
  detection: it still requires evaluating the query to completion to produce
  an exact number, so it is no cheaper than `.allElementsBoundByIndex.count`
  for the "is this ambiguous" question the planner actually needs answered.
  `element(boundBy:)` existence probing is strictly narrower for that
  question.
- `XCUIApplication` itself is a valid `XCUIElement` for locator resolution
  (the `type: "application"` locator matches `app` directly with zero query
  work — the cheapest possible resolution path).

Value-field caveat: `XCUIElementAttributes.value` is `Any?` (String,
NSNumber, ...). Probe's host-side value normalization (`normalizedValue`:
NSNumber → `stringValue`, arbitrary `Any` → `String(describing:)`) has no
faithful `NSPredicate` equivalent, so `value` locator matching stays a
Swift-side post-filter over the bounded candidate set rather than a query
predicate — never a reason to widen the query back to `.any` unfiltered.
