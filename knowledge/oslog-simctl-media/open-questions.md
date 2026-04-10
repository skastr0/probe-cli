# OSLog, simctl, and media open questions

Last updated: 2026-04-09

## Observed facts
- Sampled local `log stream --help` does **not** show a device-selection flag.
- Sampled local `devicectl` help exposes diagnostics and device-management subcommands, but does **not** list a dedicated live log-streaming command or Simulator-style media-capture command.
- Apple's public device-log docs route users to **Console.app**, **Xcode Devices and Simulators**, and **sysdiagnose**-style diagnostics rather than to a documented `devicectl logs ...` flow.

## Open questions / risks
1. **Public CLI for connected-device live logs**  
   Is there any documented public CLI path for live log streaming from a connected iPhone/iPad/tvOS/visionOS device that Probe can rely on, or is Console/Xcode the effective public boundary today?

2. **Real-device media capture surface**  
   Is there any documented public CLI for generic real-device screenshots or screen recordings outside of Simulator-specific `simctl io` and special-case tooling such as visionOS capture workflows?

3. **`recordVideo` container guarantees**  
   Local help says `recordVideo` writes a QuickTime movie, while Apple examples commonly use filenames like `video.mp4`. Probe should validate actual container/extension behavior before locking file-extension policy.

4. **Binary stdout ergonomics**  
   `simctl io screenshot -` can stream binary image data to stdout, but Probe should validate whether that path is reliable and worth supporting versus always materializing an artifact file.

5. **Runtime/version drift**  
   `simctl` and `devicectl` behavior can shift with Xcode releases. Future implementation work should re-check local help on the build host rather than assuming this pack is timeless.
