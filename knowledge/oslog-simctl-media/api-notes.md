# OSLog, simctl, and media API notes

Last updated: 2026-04-09

## Observed facts

### Unified logging surfaces
- Apple documents that the unified log system stores log messages in a **binary compressed format**, so you can't read or parse the log files directly; you need tools such as Console, the `log` CLI, Xcode, or OSLog APIs.
- Apple documents that unified logging is available on **iOS 10+, macOS 10.12+, tvOS 10+, and watchOS 3+**.
- Apple documents that `Logger` / `OSLog` should use **subsystem** and **category** strings so later filtering is manageable.
- Apple documents the default storage behavior by log level:

| Log level | Persisted to disk | Source note |
| --- | --- | --- |
| Debug | No | Development-only verbosity |
| Info | Only when collected with the `log` tool | Helpful but not essential |
| Notice (default) | Yes, up to storage limit | Essential troubleshooting info |
| Error | Yes, up to storage limit | Execution errors |
| Fault | Yes, up to storage limit | Faults and bugs |

- Apple documents privacy controls for dynamic values in log messages, including explicit `public`, `private`, and hash-based masking.

### `log stream` local command surface
- `/usr/bin/log stream --help` exposes these relevant options:
  - `--level default|info|debug`
  - `--predicate <predicate>`
  - `--process <pid>|<process>`
  - `--user <uid>|<user>`
  - `--source`
  - `--style default|syslog|json|ndjson|compact`
  - `--timeout <num>[m|h|d]`
  - `--type activity|log|trace`
  - `--ignore-dropped`
- `/usr/bin/log help predicates` lists predicate fields that include:
  - `subsystem`
  - `category`
  - `process`
  - `processIdentifier`
  - `composedMessage`
  - `logType`
  - `type`
- `/usr/bin/log help shorthand` documents shorter query fields including `message`, `process`, `pid`, `subsystem`, `category`, and `type`.
- Apple documents that, while debugging on macOS, `log config` can raise subsystem logging, for example:

```bash
sudo log config --mode "level:debug" --subsystem com.your_company.your_subsystem_name
```

### Simulator screenshots and recordings
- Apple documents that Simulator GUI screenshots are captured at the **full resolution of the simulated device**, regardless of the display resolution of the Mac.
- Apple documents current GUI flows:
  - **Screenshot:** `File > Save Screen`
  - **Video:** `File > Record Screen` / `File > Stop Recording`
- Apple documents that GUI screenshots and recordings save to the **Desktop** by default, and holding **Option** while choosing the menu item lets the user pick a save location.

### `simctl io` local command surface
- `xcrun simctl help io` exposes these operations:
  - `enumerate [--poll]`
  - `poll`
  - `recordVideo [--codec=<codec>] [--display=<display>] [--mask=<policy>] [--force] <file or url>`
  - `screenshot [--type=<type>] [--display=<display>] [--mask=<policy>] <file or url>`
- `recordVideo` help documents:
  - codec values: `h264` or `hevc` (default `hevc`)
  - display values: `internal` or `external` on iOS; only `external` on tvOS; only `internal` on watchOS
  - mask policies:
    - `ignored`
    - `alpha` (**not supported**, retained for compatibility, rendered black)
    - `black`
  - `--force` overwrites an existing output file
  - simctl writes **`Recording started` to stderr** once the first frame has been processed
  - recording stops on **SIGINT / Control-C**
  - simctl exits only after in-flight frames are processed and the video file is finalized
- `screenshot` help documents:
  - image types: `png` (default), `tiff`, `bmp`, `gif`, `jpeg`
  - display values: `internal` / `external` with the same platform constraints noted above
  - mask policies: `ignored`, `alpha`, `black`
  - output target can be a **file or URL**, and `-` means **stdout**

### Device-side log access and diagnostics
- Apple documents that for issues that aren't crashes, you should inspect the device's **console log**.
- Apple documents the supported access path for device console logs:
  1. connect the device to the Mac
  2. open **Console.app**
  3. select the device in the sidebar
  4. reproduce the issue and inspect logs around the event time
- Apple Support documents that Console can view logs for connected **iPhone, iPad, Apple Watch, and Apple TV** devices.
- Apple documents that for watchOS issues you should install the **logging profile** on the paired iPhone before connecting it to the Mac.
- Apple documents that device crash reports and device logs can also be transferred to the Mac and viewed from Xcode's **Devices and Simulators** window.
- `xcrun devicectl help device` currently lists subcommands such as `copy`, `info`, `install`, `notification`, `orientation`, `process`, `reboot`, `sysdiagnose`, and `uninstall`.
- `xcrun devicectl help device sysdiagnose` documents a public CLI path to gather a device **sysdiagnose**, including `--gather-full-logs`.

## Inference
- The most filter-friendly Probe log contract will come from consistent use of **subsystem** and **category**, because both Apple docs and `log` predicate help expose them as first-class fields.
- `log stream --style json` and especially `--style ndjson` look like the most Probe-friendly host-side output shapes because they reduce parsing ambiguity.
- `simctl io recordVideo` should be treated as a long-lived subprocess with an explicit readiness moment (`Recording started`) rather than as a fire-and-forget command.
