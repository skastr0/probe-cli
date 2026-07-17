# OSLog, simctl, and media integration notes

Last updated: 2026-04-14

## Observed facts
- Apple positions the unified logging seam as a mix of **live tools** (Console, `log stream`, Xcode) and **after-the-fact diagnostics** (crash reports, jetsam reports, transferred device logs).
- Apple positions Simulator media capture as both a GUI workflow and a CLI workflow, with current user docs focused on GUI capture and local `simctl` help exposing the lower-level CLI options.
- Local `simctl io` help includes lifecycle details that are especially important for automation:
  - recordings are asynchronous
  - readiness is signaled on stderr
  - stopping is signal-driven
  - output finalization happens after stop is requested
- Local 2026-04-14 session artifacts showed that `simctl io recordVideo` can preserve a very high frame cadence when Probe copy-remuxes the resulting QuickTime file (`ffprobe` on Probe artifacts showed ~111fps for a 5s clip and ~124fps / 2483 frames for a 20s clip).
- Apple's device-log docs point to **Console.app** and **Xcode Devices and Simulators** for connected-device access, while sampled local `devicectl` help exposes **sysdiagnose** capture but not a dedicated live log-streaming subcommand.

## Inference

### Host-side log collection
- Probe should prefer `log stream --style ndjson` (or `json`) for daemon-managed host log capture because the local CLI already exposes structured styles.
- Probe should make **subsystem/category** part of its logging contract for any host-side components it owns, because those fields map directly to Apple filtering surfaces.
- Probe can use `log config` during local debugging or development tooling, but it should not assume this is safe or available in every runtime context because Apple documents it as a macOS debugging workflow that requires elevated privileges.

### Simulator media capture
- Probe should model `simctl io screenshot` as a short-lived artifact command and `simctl io recordVideo` as a scoped session child with explicit start/stop control.
- Probe should favor artifact-file outputs for screenshots and recordings, even though `screenshot -` can write to stdout, because the project's architecture is artifact-first and binary stdout payloads are a poor fit for token-efficient command replies.
- If Probe needs to know that recording actually began before returning success, it should wait for the documented `Recording started` stderr message.
- Probe should delivery-normalize simulator recordings before returning MP4 artifacts, but it should normalize to the **captured simulator frame rate** rather than a hard-coded playback rate. Copy-remuxing the simulator QuickTime output preserves the raw high frame cadence and can produce visibly slow playback in consumers that cannot present the encoded frame rate; probing the source rate and re-encoding to that rate preserves fidelity without forcing an arbitrary cap.

### PRB-085 review-fix validation (2026-07-17)

- **Observed, real hardware (booted `iPhone 16 Pro` simulator):** the
  "readiness is signaled on stderr" / "wait for `Recording started`" guidance
  above is now the actual implementation, not just a recommendation --
  `SimulatorHarness.recordSimulatorVideoWithSimctl` (via a new generic
  `startMarkedRecording` helper in `src/services/SimulatorHarness.ts`) spawns
  `xcrun simctl io <udid> recordVideo` through the process supervisor,
  watches stderr for the exact `Recording started` marker via a streaming
  hook, times the requested duration from that marker (not from spawn), and
  requests a graceful SIGINT stop. Verified end-to-end against the real
  binary: marker detected, video produced (non-empty `.mov`), process exited
  0, zero orphaned `simctl` process afterward (`ps aux` clean immediately).
- **Confirms:** "stopping is signal-driven" (SIGINT, not SIGTERM first --
  the supervisor's `stop(signal)` gives a non-SIGTERM signal a full,
  uncontested grace window before escalating, so SIGINT is not raced against
  an immediate SIGTERM) and "output finalization happens after stop is
  requested" (the process is awaited to full exit, not just signaled, before
  the artifact is trusted).
- **Not re-validated this pass:** the frame-rate/fidelity findings above
  (high frame cadence preservation, ffmpeg remux/normalize behavior) --
  those live in `SessionRegistry.ts`'s video-artifact pipeline (now
  policy-extracted into `VideoCapturePolicy.ts`, a separate PRB-085 change),
  not in the `simctl` invocation itself, and were unaffected by this pass.

### Connected-device limitations
- Based on the sampled public sources, Probe should treat **connected-device live log streaming** as a capability that may require a GUI-side Apple tool rather than a stable public CLI surface.
- Based on the sampled public sources, Probe should treat **device sysdiagnose** as a fallback diagnostic artifact path, not as a substitute for structured live log streaming.
- Based on sampled local `devicectl` help, Probe should not assume there is a public general-purpose CLI for real-device screenshots or video recording analogous to `simctl io`.
