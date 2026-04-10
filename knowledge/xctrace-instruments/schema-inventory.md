# Probe xctrace schema inventory

Updated: 2026-04-10

## Scope

This spike recorded real `xctrace` samples against the existing `ProbeFixture` Simulator path, exported each trace TOC, and captured durable schema excerpts for the first Probe-relevant template set.

Companion artifacts:

- `knowledge/xctrace-instruments/schema-spike-results.json`
- `knowledge/xctrace-instruments/fixture-time-profiler.toc.xml`
- `knowledge/xctrace-instruments/fixture-metal-system-trace.toc.xml`
- `knowledge/xctrace-instruments/fixture-swift-concurrency.toc.xml`
- `knowledge/xctrace-instruments/fixture-logging.toc.xml`
- `knowledge/xctrace-instruments/fixture-system-trace.toc.xml`
- `knowledge/xctrace-instruments/fixture-network.toc.xml`

## Environment

- Xcode: `26.3 (17C529)`
- `xctrace`: `26.0 (17C529)`
- Target: `iPhone 17 Pro` Simulator (`4015AB8A-185C-4334-8019-EBDE113852E5`)
- Fixture bundle id: `dev.probe.fixture`

## Initial template set and observed export surface

| Template | Record result | TOC tables | Representative schema queries | Notes |
| --- | --- | ---: | --- | --- |
| `Time Profiler` | success | 32 | `time-sample`, `time-profile` | `time-sample` exported rows; `time-profile` schema was present but the current replay did not produce row data. |
| `Metal System Trace` | success | 106 | `metal-gpu-intervals`, `metal-driver-event-intervals`, `metal-application-encoders-list` | `metal-gpu-intervals` exported rows; the other sampled Metal schemas were present but empty in this idle fixture run. |
| `Swift Concurrency` | success | 30 | `swift-task-lifetime`, `swift-task-state`, `swift-actor-execution` | Schemas exported cleanly, but the fixture emitted no Swift concurrency rows. |
| `Logging` | success | 7 | `os-log`, `os-signpost` | Schema-only export in this fixture run; no rows were emitted. |
| `System Trace` | success | 49 | `thread-state`, `cpu-state`, `runloop-events` | `thread-state` and `cpu-state` exported rows; `runloop-events` was schema-only in this run. |
| `Network` | **simulator hard wall** | 33 | `com-apple-cfnetwork-transaction-intervals`, `network-connection-detected` | `xctrace record` reported `Network Connections` is not supported in the Simulator. The failed trace still exposed schema names and HAR-capable TOC metadata. |

## Stable query patterns validated on real samples

All of these worked against the recorded `.trace` artifacts:

- `/trace-toc/run[@number="1"]/data/table[@schema="time-sample"]`
- `/trace-toc/run[@number="1"]/data/table[@schema="time-profile"]`
- `/trace-toc/run[@number="1"]/data/table[@schema="metal-gpu-intervals"]`
- `/trace-toc/run[@number="1"]/data/table[@schema="metal-driver-event-intervals"]`
- `/trace-toc/run[@number="1"]/data/table[@schema="swift-task-state"]`
- `/trace-toc/run[@number="1"]/data/table[@schema="os-log"]`
- `/trace-toc/run[@number="1"]/data/table[@schema="thread-state"]`
- `/trace-toc/run[@number="1"]/data/table[@schema="cpu-state"]`
- `/trace-toc/run[@number="1"]/data/table[@schema="com-apple-cfnetwork-transaction-intervals"]`

## Desired metrics: extractable vs unavailable

### Extractable now from the current sample set

| Desired metric | Extracted from | Evidence |
| --- | --- | --- |
| CPU sample timestamps | `time-sample.time` | `schema-spike-results.json` → `Time Profiler` → `time-sample` |
| CPU thread + core + state | `time-sample.thread`, `time-sample.core-index`, `time-sample.thread-state` | same |
| CPU sample backtrace ids | `time-sample.cp-kernel-callstack`, `time-sample.cp-user-callstack` | same |
| Scheduling / runnable-vs-blocked intervals | `thread-state.state`, `thread-state.duration`, `thread-state.cputime`, `thread-state.waittime` | `System Trace` → `thread-state` |
| Core occupancy / running thread attribution | `cpu-state.cpu`, `cpu-state.state`, `cpu-state.process`, `cpu-state.thread` | `System Trace` → `cpu-state` |
| GPU execution timing | `metal-gpu-intervals.start`, `metal-gpu-intervals.duration`, `metal-gpu-intervals.start-latency` | `Metal System Trace` → `metal-gpu-intervals` |
| GPU channel / frame / command-buffer ids | `metal-gpu-intervals.channel-name`, `frame-number`, `cmdbuffer-id`, `encoder-id`, `gpu-submission-id` | same |

### Exportable schema, but empty in the current fixture trace

| Desired metric family | Schema evidence | Why it stayed empty here |
| --- | --- | --- |
| Swift task lifetime / task state / actor execution | `swift-task-lifetime`, `swift-task-state`, `swift-actor-execution` | The fixture does not use `async` / `await` workloads. |
| App `os_log` / signpost streams | `os-log`, `os-signpost` | The fixture does not emit custom logs or signposts in the sampled interval. |
| Runloop event rows | `runloop-events` | Schema exported, but the sampled interval did not return rows for this idle fixture run. |
| Aggregated Time Profiler view | `time-profile` | Schema exported, but the current replay did not return weighted aggregate rows. |
| Metal driver / encoder-list rows | `metal-driver-event-intervals`, `metal-application-encoders-list` | Schema exported, but the idle fixture run did not surface rows for these views even though `metal-gpu-intervals` did. |

### Currently unavailable / hard walls

| Desired metric | Status | Evidence |
| --- | --- | --- |
| Network connection metrics on the existing Simulator path | unavailable on Simulator | `xctrace record` failed with `Recording of 'Network Connections' is not supported in the Simulator.` |
| HAR export from a real Network trace on Simulator | unavailable on Simulator | The failed Network run exposed HAR-capable TOC metadata but could not record network rows on Simulator. |
| True per-shader GPU attribution | unavailable from the current validated Probe path | The architecture constraint still holds: Probe can surface pipeline / command-buffer timing, not true per-shader attribution. |
| Full, Probe-safe reconstructed call stacks as a stable contract | still unvalidated | Current exports expose `backtrace` / `kperf-bt` style fields, but this spike did not prove a version-stable full-stack reconstruction contract. |
| Audio-system metrics | not covered by this spike | No `Audio System Trace` sample was recorded yet, so audio remains unavailable to Probe's first extractor contract. |

## Practical extractor implications

- Prefer TOC-first discovery and schema-name-based XPath selection.
- Treat `time-sample`, `thread-state`, `cpu-state`, and `metal-gpu-intervals` as the first honest Probe extractor targets on the current Simulator workflow.
- Treat `Swift Concurrency`, `Logging`, and several richer Metal views as schema-known but workload-dependent: Probe should report them as available schemas, not guaranteed populated metrics.
- Treat `Network` as a simulator hard wall and require a real-device or alternate validation path before promising HTTP metrics.
