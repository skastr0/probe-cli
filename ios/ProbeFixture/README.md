# ProbeFixture

ProbeFixture is a deliberately small UIKit harness app for Probe runner spikes.

It is **not** a production app. It exists so Probe can validate attach, inspect, and control flows against a known surface with stable accessibility identifiers.

## Fixture surface

The app starts in a deterministic state and exposes:

- a form (`UITextField`, apply button, status label)
- snapshot benchmark profiles (`Base`, `Medium`, `Large`) that expand the UI tree with repeatable generated sections
- mode and toggle controls (`UISegmentedControl`, `UISwitch`)
- a selectable list (`UITableView`)
- a log surface (`UITextView`)
- a tiny navigation hop to a detail view
- a couple of awkward shapes for runner checks (disabled control, offscreen button in a scroll view)

## Accessibility identifier examples

- `fixture.form.input`
- `fixture.form.applyButton`
- `fixture.status.label`
- `fixture.mode.segmentedControl`
- `fixture.state.toggle`
- `fixture.list.table`
- `fixture.logs.textView`
- `fixture.navigation.detailButton`
- `fixture.problem.offscreenButton`
- `fixture.snapshot.profile.control`
- `fixture.snapshot.profile.statusLabel`

## Snapshot benchmark profiles

The fixture now includes a generated benchmark surface so Probe can measure large AX trees against repeatable UIKit content instead of ad hoc screenshots.

- `Base`: the original small harness shape
- `Medium`: adds `3` generated sections with `12` benchmark cards total
- `Large`: adds `6` generated sections with `48` benchmark cards total

Each generated card contains nested stack views plus repeated labels, buttons, switches, text fields, and segmented controls so the runner can measure:

- raw `XCUIElementSnapshot.dictionaryRepresentation` size
- Probe-candidate full / pruned / collapsed / interactive-only views
- output-size reduction across the same real UI tree

## Simulator validation harness

Run the repeatable build/install/launch flow with:

```bash
./ios/ProbeFixture/scripts/validate-simulator.sh
```

Optional overrides:

- `PROBE_FIXTURE_SIMULATOR_UDID=<udid>` to pin a specific simulator
- `PROBE_FIXTURE_DERIVED_DATA_PATH=<path>` to choose the build output folder

The harness follows the current research guidance:

- resolve a concrete simulator UDID rather than relying on `booted`
- boot via `simctl bootstatus -b`
- build with `xcodebuild`
- install and launch with `simctl`

## Suggested runner validation flow

Once runner attach/control spikes are wired up, the smallest honest command path is:

1. attach to `dev.probe.fixture`
2. snapshot the root view and resolve the stable identifiers above
3. type into `fixture.form.input`
4. tap `fixture.form.applyButton`
5. select one `fixture.list.item.*` row
6. tap `fixture.navigation.detailButton`
7. pop back from `fixture.detail.popButton`
8. scroll until `fixture.problem.offscreenButton` is hittable, then tap it

That sequence covers snapshot, typing, tap, list selection, navigation, and offscreen interaction without pretending the fixture is more than a harness.

## Validation matrix

| Flow | Mode | Status | Notes |
| --- | --- | --- | --- |
| Build app target | Automated | Supported | `xcodebuild` against the shared `ProbeFixture` scheme |
| Boot simulator | Automated | Supported | `simctl bootstatus -b <udid>` |
| Install + launch on Simulator | Automated | Supported | `simctl install` + `simctl launch` |
| Manual UI interaction on Simulator | Manual | Supported | Tap buttons, edit text, select rows, scroll to offscreen button, open detail |
| Real-device build/install | Manual | Not yet verified here | Project is standard UIKit, but signing/provisioning is intentionally left to the local developer environment |
| Runner attach/control validation | Manual / future automated | Pending later spikes | This fixture is the target surface for the runner work; it does not implement the runner itself |

## Notes

- Research packs used: `knowledge/xcuitest-runner/` and `knowledge/simctl-xcodebuild-session-control/`.
- The app stays intentionally small so later runner spikes validate Probe behavior rather than fixture complexity.
