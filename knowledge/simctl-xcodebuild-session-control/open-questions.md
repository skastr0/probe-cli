# simctl + xcodebuild session control open questions

Updated: 2026-04-09

## Open validation questions

1. **Does Probe need Simulator.app to be visibly attached for all intended flows?**
   - Apple’s current docs and the reviewed `simctl` help clearly support CLI control, and WWDC19 notes that Simulator.app attaches automatically if open.
   - The reviewed sources do **not** explicitly state whether Probe’s full intended workflow always works headlessly, especially once `xcodebuild test-without-building` and the XCUITest runner are involved.

2. **What is the cleanest readiness signal after `bootstatus -b` for Probe’s session model?**
   - Apple documents `bootstatus` as the boot-completion primitive.
   - The reviewed sources do not establish whether Probe should treat `bootstatus` success alone as sufficient, or whether it should also validate app launch / test-destination availability before declaring a session `ready`.

3. **How much should Probe rely on `simctl launch` versus runner-managed launch semantics?**
   - `simctl launch` is clearly documented for host-side app start and relaunch.
   - `knowledge/xcuitest-runner/` separately documents `XCUIApplication.launch()` and `activate()` semantics.
   - The exact boundary between host-side launch control and runner-side launch control still needs a deliberate contract.

4. **What is the most reliable `test-without-building` entrypoint for Probe: scheme or `.xctestrun`?**
   - Apple supports both.
   - The reviewed sources do not answer which path is operationally better for a long-lived daemon that wants stable session reuse, artifact paths, and minimal rebuild churn.

5. **How should Probe expose permission mutation safely?**
   - Apple warns that `simctl privacy` can terminate the running app and that bypassing normal permission request flows can mask bugs.
   - Probe likely still wants deterministic permission setup for testing, but the caller contract and capability reporting need explicit design.

6. **What daemon packaging models preserve simulator visibility?**
   - Apple documents a failure mode for non-root LaunchDaemons / different-user invocation.
   - The reviewed sources do not settle whether a per-user LaunchAgent, login item, ordinary foreground daemon, or other packaging shape is the best supported long-lived hosting model for Probe.

7. **What minimum Xcode version should Probe support?**
   - The reviewed release notes capture historical testing and path quirks.
   - Probe still needs a product decision on whether it targets only current Xcode versions or offers a broader compatibility window.

## Immediate risks for later Probe items

- Probe could accidentally use the `booted` alias and bind a session to the wrong simulator once multiple simulators are active.
- Probe could expose permission-reset commands without surfacing that the target app may be terminated.
- Probe could rely on implicit `xcodebuild` artifact locations instead of passing explicit paths into the session artifact root.
- Probe could daemonize in a way that loses access to simulator state because the process runs as the wrong user or in the wrong service context.
