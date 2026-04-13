# OSLog, simctl, and media open questions

Last updated: 2026-04-13

## Observed facts
- Sampled local `log stream --help` does **not** show a device-selection flag.
- Sampled local `devicectl` help exposes diagnostics and device-management subcommands, but does **not** list a dedicated live log-streaming command or Simulator-style media-capture command.
- Apple's public device-log docs route users to **Console.app**, **Xcode Devices and Simulators**, and **sysdiagnose**-style diagnostics rather than to a documented `devicectl logs ...` flow.
- Local `xcrun simctl io <udid> recordVideo` help explicitly says it writes a **QuickTime movie** and emits `Recording started` after the first frame is processed.
- On the local simulator runtime, `simctl io recordVideo` wrote a QuickTime container even when the destination filename used an `.mp4` extension; remuxing that output with `ffmpeg` produced a true MP4 container (`file` reported `ISO Media, MP4 Base Media`).
- On a mostly static simulator screen, `simctl io recordVideo` finalized a one-frame movie (`ffprobe`: `nb_frames=1`, `duration≈0.066667s`) even when left running for several seconds before `SIGINT`.
- When the simulator display visibly changed during capture (tested by toggling `simctl ui ... appearance dark/light`), `simctl io recordVideo` emitted many frames and a multi-second movie (`63` frames over `6.93s` in one local repro).

## Open questions / risks
1. **Public CLI for connected-device live logs**  
   Is there any documented public CLI path for live log streaming from a connected iPhone/iPad/tvOS/visionOS device that Probe can rely on, or is Console/Xcode the effective public boundary today?

2. **Real-device media capture surface**  
   Is there any documented public CLI for generic real-device screenshots or screen recordings outside of Simulator-specific `simctl io` and special-case tooling such as visionOS capture workflows?

3. **`recordVideo` duration semantics on static screens**  
   Local behavior suggests simulator-native recording can be display-update-driven rather than wall-clock-driven: static screens may collapse to a one-frame movie until something repaints. Probe should decide whether to accept that, pad/remux to the requested duration, or fall back to a screenshot-loop contract when duration fidelity matters more than native capture.

4. **Binary stdout ergonomics**  
   `simctl io screenshot -` can stream binary image data to stdout, but Probe should validate whether that path is reliable and worth supporting versus always materializing an artifact file.

5. **Runtime/version drift**  
   `simctl` and `devicectl` behavior can shift with Xcode releases. Future implementation work should re-check local help on the build host rather than assuming this pack is timeless.
