# OSLog, simctl, and media sources

Last updated: 2026-04-09

## Observed facts

### Local environment for command-help captures
- macOS 26.3.1 (`25D2128`)
- Xcode 26.3 (`17C529`)

### Official Apple documentation
1. **Viewing Log Messages**  
   <https://developer.apple.com/documentation/os/viewing-log-messages>  
   Used for the official overview of unified log retrieval surfaces.

2. **Generating Log Messages from Your Code**  
   <https://developer.apple.com/documentation/os/generating-log-messages-from-your-code>  
   Used for subsystem/category guidance, log-level persistence, and privacy controls.

3. **Customizing Logging Behavior While Debugging**  
   <https://developer.apple.com/documentation/os/customizing-logging-behavior-while-debugging>  
   Used for `log config` guidance and subsystem/category override behavior.

4. **Logging**  
   <https://developer.apple.com/documentation/os/logging>  
   Used for the high-level unified logging model and supported platform scope.

5. **Capturing screenshots and videos from Simulator**  
   <https://developer.apple.com/documentation/xcode/capturing-screenshots-and-videos-from-simulator>  
   Used for current Simulator screenshot/video behavior and file-save flow.

6. **Diagnosing issues using crash reports and device logs**  
   <https://developer.apple.com/documentation/xcode/diagnosing-issues-using-crash-reports-and-device-logs>  
   Used for official device-console-log positioning and privacy reminder.

7. **Acquiring crash reports and diagnostic logs**  
   <https://developer.apple.com/documentation/xcode/acquiring-crash-reports-and-diagnostic-logs>  
   Used for concrete steps to access device console logs and transfer device diagnostics.

8. **View log messages in Console on Mac**  
   <https://support.apple.com/guide/console/log-messages-cnsl1012/mac>  
   Used for Console.app behavior with connected devices.

### Local command help
- `/usr/bin/log help`
- `/usr/bin/log stream --help`
- `/usr/bin/log help predicates`
- `/usr/bin/log help shorthand`
- `xcrun simctl help io`
- `xcrun devicectl help`
- `xcrun devicectl help device`
- `xcrun devicectl help device sysdiagnose`
- `xcrun devicectl help diagnose`

## Inference
- Current implementation work should treat the Apple docs above plus local command help as the primary source set for Probe's logging/media integration seam.
- `devicectl` help is especially useful as a negative signal: it documents the current public CLI surface that was locally available during this research pass.
