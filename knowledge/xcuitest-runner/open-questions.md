# XCUITest Runner Open Questions

Updated: 2026-04-09

## Open validation questions

1. **Attach semantics to an already-running target**
   - **Simulator:** validated on 2026-04-09 for `ios/ProbeFixture/`; `XCUIApplication(bundleIdentifier:)` attached to the pre-launched app, snapshot/tap/type succeeded, and the launched pid remained alive through the spike.
   - **Real device:** still open. The local validation so far does not establish whether device-side runner signing, focus behavior, and lifecycle rules match Simulator closely enough.

2. **Long-lived runner feasibility**
   - **Simulator:** validated on 2026-04-10 with `ios/ProbeRunner/scripts/validate-lifecycle.sh`; one long-lived test method stayed alive across five externally-driven commands (`ping`, `applyInput`, `snapshot`, `ping`, `shutdown`) and exited cleanly on shutdown.
   - **Still open:** the same lifecycle on real devices, and whether the eventual production transport can be a true bidirectional stdio bridge instead of a file-backed mailbox.

3. **Snapshot schema stability**
   - `XCUIElementSnapshot.dictionaryRepresentation` is hierarchical, but this pack does not yet establish which keys are stable enough across OS/Xcode versions for Probe’s compact JSON protocol.

4. **Attachment availability during live runs**
   - Apple documents how attachments are created and retained, but this pack does not yet prove how quickly CLI-driven runs make them readable to external tooling before test completion.

5. **Simulator vs real-device differences**
   - The reviewed docs are largely API-level and do not yet settle whether the same runner lifecycle, attach behavior, and artifact access model behave identically on real devices.

6. **Transport choice for runner ↔ host communication**
   - **Closed for Simulator:** the current honest contract is a simulator-scoped bootstrap manifest plus file-backed ingress and stdout JSONL mixed-log egress.
   - The 2026-04-10 closure pass proved that the runner can read a per-session control directory from `/tmp/probe-runner-bootstrap/<SIMULATOR_UDID>.json` and emit ready/response frames that survive the real `xcodebuild` boundary.
   - The same pass also kept the hard wall explicit: host → runner stdin delivery through `xcodebuild` still timed out, so Probe should not claim a bidirectional stdio bridge here.
   - Still open:
      - a clean real-device equivalent for the shared file-ingress seam
      - whether a future cleaner egress path can replace mixed-log stdout without losing the current public-tooling honesty

## Immediate risks for later Probe items

- Probe could overfit to `launch()` and accidentally destroy target-app continuity when a foreground/resume operation was intended.
- Probe could treat `debugDescription` or attachment retention as stable integration surfaces even though Apple positions them as debugging/testing conveniences.
- Probe could assume teardown always runs and lose runner-side cleanup or artifact flushes on crash paths.
