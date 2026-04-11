# Probe Architecture

Status: draft

This document captures the current intended architecture for Probe so that future work items, research packs, and delegated implementation all share the same system shape.

Work items remain the SDLC source of truth for lifecycle state and acceptance criteria. This file is the durable architecture reference that explains the whole system, the main design bets, the hard walls, and the expected implementation direction.

## 1. Product Intent

Probe is a lightweight, daemon-first, agent-first iOS runtime controller that gives coding agents reliable, token-efficient access to a running iOS app on Simulator or real devices.

### Core philosophy

- The general case assumes the app is already built and installed; Probe's fixture app is the explicit simulator self-test exception for `build-and-install` mode.
- Probe does not own builds, signing, or provisioning of the target app.
- Prefer public Apple and Xcode surfaces.
- Be explicit about hard walls rather than pretending unsupported capabilities exist.
- Optimize for token efficiency through compact JSON, stable refs, diffs, summaries, and artifact offload.
- Treat the daemon and session model as first-class, not as an afterthought.

## 2. System Summary

Probe has two major halves:

1. **Host side**: a TypeScript + Effect daemon and thin CLI client.
2. **Target-side / subprocess bridges**: a small XCUITest runner and a persistent LLDB Python bridge.

Probe coordinates Apple utilities such as:

- `simctl`
- `devicectl`
- `xcodebuild`
- `xctrace`
- `lldb`
- `log`

These utilities are treated as integration boundaries with explicit contracts, research packs, and typed capability/error reporting.

## 3. Architectural Decisions

### 3.1 Daemon-first

Probe should be daemon-first.

- `probe serve` runs the long-lived kernel.
- user-facing `probe <command>` invocations should behave mostly like thin clients speaking to the daemon.
- session state, subprocess lifecycles, artifact paths, and stable refs live in the daemon.

Reason: session continuity, stable references, and long-lived subprocesses are central to the product.

### 3.2 One session = one device + one app

A Probe session represents exactly one app on one device target.

- one Simulator or real device
- one target bundle id / launched app process
- one artifact root
- one session state object

This keeps reasoning simple and avoids hidden cross-device coupling.

### 3.3 Public APIs only

Probe should prefer:

- XCUITest APIs for accessibility tree access and touch injection
- official Apple CLIs for device control, tracing, and logs
- LLDB's supported scripting bridge

Probe should not depend on private Accessibility Inspector protocols or undocumented device channels as a primary strategy.

### 3.4 Artifact-first large output model

Large results should not flood stdout.

- small result: inline JSON
- large result: summary + file path
- later inspection: `probe drill`

This is a core product feature, not a nice-to-have formatting choice.

### 3.5 Effect-native runtime model

The host should use one root Effect runtime per daemon process, but it should not treat `ManagedRuntime` as the daemon's internal orchestration primitive.

- `probe serve` should ultimately launch a layer-shaped daemon with `NodeRuntime.runMain(Layer.launch(ProbeDaemonLive))`.
- daemon-owned services should live in shared layers.
- session-owned resources should live in child scoped services opened by the session registry.
- request-local resources should use `Effect.acquireRelease` or other local scoped effects.
- `ManagedRuntime` is reserved for boundary use such as tests, adapter callbacks, or embedding Effect into non-Effect code.

Avoid per-command `Effect.provide(...)` trees that recreate stateful services and fragment process-local state.

## 4. Why the Runner Exists

There is no host-side public API for reading an iOS app's accessibility tree or injecting touch events into a running iOS app.

Key constraints:

- macOS accessibility APIs do not introspect guest iOS apps.
- `simctl` and `devicectl` do not provide general tap/swipe/tree-inspection commands.
- Accessibility Inspector uses private protocols that are not an acceptable product foundation.

Therefore Probe uses a small XCUITest runner as the on-device bridge.

The runner:

- attaches to the target app using public XCUI APIs
- walks the UI hierarchy
- performs actions such as tap, swipe, and type
- can capture screenshots
- speaks a small structured protocol back to the host

## 5. System Planes

The planes are distinct, but they are not peers from an ownership perspective. The control plane owns daemon lifecycle and session scopes. Bridge resources are session children. Tool wrappers are infrastructure services. Artifact and output services are shared daemon services used by every other plane.

The canonical top-level service map is:

| Plane | Canonical services | Lifetime | Ownership rule |
| --- | --- | --- | --- |
| Control | `ProbeDaemon`, `RpcServer`, `ProbeKernel`, `SessionRegistry`, `CapabilityService` | daemon | Owns socket lifecycle, session creation, shutdown, and health reporting. |
| Bridge | `RunnerBridgeFactory`, `LldbBridgeFactory`, session `RunnerBridge`, session `LldbBridge` | shared factories + session instances | Factories are daemon services; live bridge processes belong to a session scope. |
| Tooling | `Simctl`, `Devicectl`, `Xcodebuild`, `Xctrace`, `OsLog` wrappers | daemon services with request/session operations | Wrappers expose typed operations; they do not own session policy by themselves. |
| Artifact / output | `ArtifactStore`, `OutputPolicy`, `DrillService`, retention worker | daemon | Owns stable artifact paths, offload policy, drill reads, and cleanup policy. |

### 5.1 Control plane

Owns:

- daemon lifecycle
- session registry
- RPC server / client contract
- startup / shutdown / TTL cleanup
- capability reporting

Expected internal shape:

- `ProbeDaemon` is the root launched service for `probe serve`.
- `RpcServer` only terminates transport concerns; it should not contain business logic.
- `ProbeKernel` is the domain facade used by CLI / RPC handlers.
- `SessionRegistry` is the only service allowed to open and close session scopes.

Expected transport:

- local Unix domain socket

### 5.2 Bridge plane

Owns long-lived structured subprocess bridges:

- XCUITest runner bridge
- LLDB Python bridge

Ownership rule:

- bridge factories are daemon-scoped
- live bridge instances are session-scoped
- requests may use a bridge, but callers do not own the underlying process handle or cleanup

Current validated runner boundary contract:

- simulator-scoped bootstrap manifest under `/tmp/probe-runner-bootstrap/<SIMULATOR_UDID>.json`
- real-device bootstrap manifest under `/tmp/probe-runner-bootstrap/device-<DEVICE_UDID>.json`
- file-backed command ingress into a per-session control directory
- JSON line response/event egress parsed from the mixed `xcodebuild` / XCTest stdout stream
- host runtime treats stdout ready/response frames as canonical egress; `ready.json` and `response-*.json` remain validation-only mirrors for spike scripts
- typed request / response envelopes with correlation ids or sequence ids for in-flight work

Design requirement:

- keep the runner transport behind a swappable seam so a cleaner future egress path can replace the current boundary mechanics without rewriting runner semantics

### 5.3 Tooling plane

Owns integration wrappers over Apple utilities:

- `simctl`
- `devicectl`
- `xcodebuild`
- `xctrace`
- `log`

Short-lived commands can be wrapped as Effect command services.

Long-lived or streaming subprocesses should be modeled as scoped resources.

Tool wrappers should stay policy-light: they expose typed capabilities and structured errors, while session policy stays in control-plane or session services.

### 5.4 Artifact and output plane

Owns:

- artifact store layout
- output thresholding
- summary generation
- `drill` extraction
- retention / cleanup

This plane decides when to offload, where artifacts live, and how later follow-up reads stay token-efficient. It should not depend on command-specific formatting hidden in callers.

## 6. Host Runtime Model

The host runtime should be organized by ownership boundary rather than by command names.

### 6.1 Daemon-scoped services

- `ProbeDaemon`
- `RpcServer`
- `ProbeKernel`
- `SessionRegistry`
- `CapabilityService`
- `ArtifactStore`
- `OutputPolicy`
- Apple tool wrapper services (`Simctl`, `Devicectl`, `Xcodebuild`, `Xctrace`, `OsLog`)

These services live for the lifetime of the daemon process.

### 6.2 Session-scoped services

- `SessionHandle` / `SessionContext`
- `RunnerBridge`
- `LldbBridge`
- `LogsStream`
- `TraceRecorder`

These services are created and finalized by `SessionRegistry`. They are never process-global singletons.

### 6.3 Request-scoped operations

- one-off Apple CLI invocations
- artifact drill reads
- snapshot transforms / diffing
- export and summary work that does not need to outlive the request

These stay local to one effect and must not leak child-process ownership out of their scope.

### Effect guidance

- launch the daemon with `NodeRuntime.runMain(Layer.launch(...))`
- prefer `Effect.Service` / typed tags for services
- use `Layer.scoped` for process-backed resources
- use `Effect.acquireRelease` when resource ownership is local
- use `SessionRegistry` to open child scopes instead of storing raw process handles in ad hoc global maps
- use `Deferred` for readiness handshakes
- use `SubscriptionRef` for observable session state
- use `FiberMap` or similar keyed coordination for active sessions and background tasks
- treat the current `src/runtime.ts` scaffold as a bootstrap placeholder, not as the final `probe serve` architecture

## 7. Session Model

Each session should own:

- session id
- target device identity
- target app identity
- current capability set
- artifact root path
- session state stream
- optional child resource states for runner, debugger, logs, and trace

### Session open modes

Probe currently exposes these open shapes:

| Target | Mode | Meaning |
| --- | --- | --- |
| Simulator | `build-and-install` | Build, install, and launch the Probe fixture app before attaching the runner. This is the default self-test path when `--bundle-id` is omitted or resolves to the fixture bundle id. |
| Simulator | `attach-to-running` | Attach the runner to an already-running installed app identified by bundle id. |
| Device | attach-to-running | Verify the requested app is installed, launch it with public device tooling, and attach the runner. Probe does not own arbitrary target-app signing or provisioning. |

Optional scoped children may include:

- runner process / bridge
- LLDB bridge
- log stream collector
- active `xctrace` recording

### Session phase contract

| Phase | Meaning | Notes |
| --- | --- | --- |
| `opening` | The registry is creating the session scope and allocating the artifact root. | Requests other than status / open polling should be rejected. |
| `ready` | The session can accept work. Optional child resources may still be inactive. | This is the healthy steady state. |
| `degraded` | The session remains open but one or more optional resources are unavailable or unhealthy. | Commands that need the broken resource must fail explicitly. |
| `closing` | The daemon has started cleanup and no new mutating work should be accepted. | Existing child resources are draining or being interrupted. |
| `closed` | Cleanup completed and the live scope is gone. | Registry may retain tombstone metadata briefly, but not live handles. |
| `failed` | The session can no longer satisfy its contract. | The daemon must transition toward cleanup and surface a failure summary. |

### Resource state contract

Each optional child resource should expose a state in this family:

- `not-requested`
- `starting`
- `ready`
- `degraded`
- `stopping`
- `stopped`
- `failed`

The session phase and resource states are related but not identical. For example, a session may be `ready` while its LLDB bridge is `not-requested`, or a session may be `degraded` because logs or tracing failed while the runner still works.

### Resource ownership rules

| Resource | Start trigger | Lifetime owner | Cleanup owner | Notes |
| --- | --- | --- | --- | --- |
| Runner bridge | Session open or first automation request, depending on later implementation choice | session scope | `SessionRegistry` | At most one live runner bridge per session. |
| LLDB bridge | Explicit debug attach request | session scope after attach succeeds | `SessionRegistry` with `DebugService` helpers | Optional; failure should degrade the session rather than corrupt unrelated features. |
| Log collector | Explicit stream/start request or future default-capture policy | session scope once started | `SessionRegistry` with `LogsService` helpers | Callers subscribe to data; they do not own the collector process. |
| `xctrace` recorder | Explicit recording request | session scope while the recording is active | `SessionRegistry` with `PerfService` helpers | Initial architecture assumes at most one active trace recording per session. |

### Session invariants

- a session owns exactly one target app on one target device
- artifact paths are stable for the lifetime of the session
- session state transitions are explicit
- subprocess cleanup is owned by the daemon, not by the caller
- request handlers may trigger child resources, but they never become the lifecycle owner of those resources
- child-resource failures degrade the session explicitly; they do not silently disappear

### Current session contract freeze boundary

`src/domain/session.ts` freezes the generic session lifecycle/state surface with `SessionPhase`, `SessionResourceState`, `SessionTarget`, and `ProbeSessionState`.

The current `session.open` / `session.health` payload is intentionally narrower: it extends that base with runner-backed simulator and live real-device transport/liveness details (`RunnerTransportContract`, `RunnerSessionDetails`, `SessionHealthCheck`) because the current vertical slice only has the runner bridge implemented. Future LLDB, log, or trace-specific health payloads should extend `ProbeSessionState` as sibling details rather than pushing runner-only fields into the generic session state.

## 8. Output Strategy

Probe uses a tiered output model.

### 8.1 Inline

Use for small payloads such as:

- action acknowledgements
- compact snapshots of simple screens
- short log excerpts
- small expression evaluation results

### 8.2 Summary + file

Use for large payloads such as:

- large AX trees
- full backtraces
- large logs
- `.trace` exports
- binary analysis outputs

Return:

- concise structured summary
- artifact file path

### 8.3 Drill

Use follow-up queries to inspect offloaded artifacts without loading the full file.

Expected drill shapes:

- JSON / XML selection
- table or row extraction for trace exports
- line ranges and match context for text logs

### Default threshold

The initial plan assumes roughly:

- ~4 KB or ~100 lines as the default inline threshold

The threshold must remain configurable and overridable per command.

## 9. Capability Areas

### 9.1 Device and session management

Goal:

- list devices
- boot Simulator targets
- open sessions
- manage permissions
- reconnect where possible

Primary Apple surfaces:

- `simctl`
- `devicectl`

Probe adds:

- unified device abstraction
- session ids
- artifact roots
- daemon-owned lifecycle management

### 9.2 UI automation and state inspection

Goal:

- compact AX tree snapshots
- stable refs like `@e1`, `@e2`
- semantic actions without coordinate dependence
- runner-backed screenshots and short videos on simulator and device
- diffing and stale-ref remediation

Primary surface:

- XCUITest runner using `XCUIApplication`, `XCUIElement`, and `XCUIScreen`

### 9.3 Performance profiling and analysis

Goal:

- record and export Instruments traces
- summarize CPU, GPU, audio, and scheduling behavior
- surface actionable findings instead of raw dumps only

Current bounded template set:

- `time-profiler`
- `system-trace`
- `metal-system-trace` with extended driver / encoder exports when present and within budget
- `hangs`
- `swift-concurrency`

Primary surfaces:

- `xctrace record`
- `xctrace export --toc`
- `xctrace export --xpath`

Important constraint:

- Probe can extract encoder-level and pipeline-level timing from Metal traces, but not true per-shader GPU attribution.

### 9.4 Deep debugging and binary inspection

Goal:

- attach LLDB
- inspect frames and variables
- evaluate expressions
- manage breakpoints
- inspect symbols and selected disassembly

Primary surfaces:

- LLDB Python bridge
- `nm`
- `otool`
- `codesign`

### 9.5 Logging and artifacts

Goal:

- structured log streaming and filtering
- screenshots and recordings
- persistent session artifact bundles

Primary surfaces:

- `log stream`
- `simctl io`
- runner screenshots and videos

### 9.6 Recording and replay

Goal:

- capture exploratory sessions as replayable scripts
- replay via semantic selectors
- embed assertions and performance checks where useful

This is built on top of the runner and snapshot model rather than a separate Apple tool.

## 10. Artifact Layout

All session outputs should live under:

```text
~/.probe/sessions/<session-id>/
```

Suggested subfolders:

- `snapshots/`
- `traces/`
- `screenshots/`
- `video/`
- `logs/`
- `debug/`
- `replays/`

Design requirement:

- file formats should stay debuggable on disk
- offload should optimize token use, not rely on opaque binary compression

## 11. Suggested Source Tree

An initial repository shape could be:

```text
src/
  cli/
    main.ts
    commands/
  rpc/
    protocol.ts
    server.ts
    client.ts
  domain/
    device.ts
    session.ts
    snapshot.ts
    action.ts
    artifact.ts
    output.ts
    errors.ts
  services/
    ProbeKernel.ts
    SessionRegistry.ts
    RunnerService.ts
    PerfService.ts
    DebugService.ts
    LogsService.ts
    ArtifactStore.ts
    OutputPolicy.ts
  infra/
    apple/
      Simctl.ts
      Devicectl.ts
      Xcodebuild.ts
      Xctrace.ts
      OsLog.ts
    bridge/
      JsonLineProcess.ts
      RunnerBridge.ts
      LldbBridge.ts
    fs/
      LocalArtifactStore.ts
  runtime.ts

ios/
  ProbeRunner/
```

The exact file list is still a guideline, not yet a frozen contract.

The directory names and ownership boundaries above are now the canonical host seam map for phase-1 and phase-2 work. Individual files may split or merge, but new work should not invent parallel directories or alternate service boundaries without first updating this document.

## 12. Knowledge and Research Workflow

Probe should not integrate with Apple or third-party utilities from memory alone.

Rules:

- check `knowledge/` first
- reuse or extend an existing research pack when possible
- create a new pack only when the seam is not already covered
- prefer official docs and primary sources
- capture best practices, caveats, and relevant APIs
- cite the pack used in work item notes and later implementation work

Expected reusable pack areas already identified:

- `effect-cli-daemon`
- `xcuitest-runner`
- `xctrace-instruments`
- `lldb-python`
- `devicectl-device-signing`
- `simctl-xcodebuild-session-control`
- `oslog-simctl-media`

## 13. Open Questions

These remain live and should be answered through spikes and research.

1. **Runner lifecycle model**
   - Can a single XCUITest test case remain alive as a command server across multiple requests?

2. **XCUIApplication attach semantics**
   - Can the runner reliably attach to an already-launched app on Simulator and real devices without relaunching it?

3. **`xctrace export` schema shape**
   - What tables and columns are available per Instruments template?

4. **Real-device runner signing independence**
   - How independent can the Probe runner be from the target app's signing and team setup?

5. **Runner ↔ host communication transport**
   - **Closed for Simulator:** use a bootstrap manifest plus file-backed ingress and stdout JSONL mixed-log egress.
   - **Still open:** what replaces the shared-file ingress seam on real devices, and whether mixed-log stdout can later be replaced by a cleaner public-tooling egress path.

6. **`devicectl` reliability on the current macOS/Xcode stack**
   - Is retry/fallback logic mandatory for production use?

7. **LLDB Python bridge stability over long sessions**
   - Are there gotchas around crashes, signal handling, and target restarts?

8. **AX tree fidelity for 3D / custom-rendered content**
   - Will Metal, SceneKit, SpriteKit, or RealityKit apps expose sufficient accessibility structure?

9. **Tool coexistence**
   - Can runner, `xctrace`, and LLDB operate concurrently without destabilizing the target session?

10. **Large AX tree latency**
   - Are full snapshots fast enough, or should Probe default to more selective views?

## 14. Known Walls

These are currently known product limits imposed by public Apple tooling.

1. **Per-shader GPU time attribution**
   - Not available through `xctrace` CLI export.
   - True per-shader attribution requires Xcode GUI Metal debugging.

2. **Metal GPU frame capture**
   - There is no equivalent fully supported CLI workflow for the Xcode GPU frame debugger experience.

3. **Some GUI-only Instruments analyses**
   - Certain higher-level analyses exist only in Xcode GUI views.

4. **Real-device clipboard parity**
   - Simulator has stronger CLI support than real devices.

5. **Real-device network conditioning parity**
   - Real-device network throttling lacks a clean CLI path comparable to Simulator workflows.

6. **Real-device runner transport parity**
   - The current live device path reuses the same bootstrap-manifest + file-mailbox + mixed-stdout seam as Simulator.
   - That path is validated, but it is still not the final cleaner transport end state.

Probe should state these walls explicitly in command output where relevant.

## 15. Delivery Strategy

Recommended sequence:

### Phase 0: research and feasibility

- research packs for Effect/CLI, XCUITest, `xctrace`, LLDB, device signing, and logs/media
- runner lifecycle spike
- XCUI attach spike
- runner transport spike
- `xctrace` schema mapping spike
- LLDB bridge spike
- device signing and `devicectl` spike
- coexistence spike
- large AX tree performance spike

### Phase 1: daemon skeleton

- daemon kernel
- RPC protocol
- session registry
- artifact store base
- output policy

### Phase 2: Simulator vertical slice

- session open
- runner handshake
- basic snapshot
- session health

### Phase 3: core interaction surface

- snapshot diffing
- stable refs
- actions
- screenshots
- logs

### Phase 4: replay and validation

- recording
- replay
- fixture app / harness
- regression contracts

### Phase 5: performance and debugging

- `xctrace` record / export / summaries
- LLDB attach / eval / vars / backtrace

### Phase 6: real-device support and operability

- device sessions
- reconnect / cleanup / diagnostics
- capability reporting

## 16. Delegation Guidance

Work items alone are not enough for larger delegated implementation.

For meaningful delegation, a subagent should usually have:

1. the active work item
2. this architecture document
3. the relevant `knowledge/<topic>/` pack
4. explicit instruction to load the `effect` skill for CLI/daemon work

Why this matters:

- work items capture acceptance and sequence
- research packs capture external evidence and best practices
- this file captures the whole-system shape and design intent

Together they provide a much better handoff surface than any one of them alone.

## 17. Current Recommendation

The current architecture can be summarized as:

> Probe is a daemon-hosted Effect kernel supervising scoped device/app sessions, with structured runner and debugger bridges, explicit capability and error reporting, and a first-class artifact/output subsystem designed for agent token efficiency. Today the validated XCUITest runner seam is bootstrap-manifest file ingress plus stdout JSONL egress on simulator and current live real-device sessions, kept behind a swappable transport boundary.
