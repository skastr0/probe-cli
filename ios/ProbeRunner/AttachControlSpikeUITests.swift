import Darwin
import Foundation
import Network
import XCTest

final class AttachControlSpikeUITests: XCTestCase {
  private let attachTimeout: TimeInterval = 10
  private let interactionTimeout: TimeInterval = 5
  private let defaultVideoDurationMs = 10_000
  private let maxVideoDurationMs = 120_000
  private let videoFrameInterval: TimeInterval = 0.1
  private let runnerBootstrapRootPath = "/tmp/probe-runner-bootstrap"
  private let runnerTransportContract = "probe.runner.transport/hybrid-v1"

  // PRB-072: the single source of truth for which capability flags this runner
  // advertises in its ready frame. This must track handleLifecycleCommand's action
  // switch exactly — one entry per capability-gated case that is actually
  // implemented below. Today that switch has `case "uiAction"` but no
  // `case "uiActionBatch"` (an unimplemented action falls through to the default
  // "Unsupported lifecycle action" throw), so uiActionBatch must not appear here.
  // The host never upgrades an absent or unlisted flag by assumption (see
  // requireRunnerCapability / RUNNER_CAPABILITY_REGISTRY in
  // src/services/runnerCapabilities.ts) — adding a new gated case here without also
  // implementing it in handleLifecycleCommand would make the host trust a capability
  // this binary cannot actually perform.
  private static let advertisedRunnerCapabilities: [String] = ["uiAction"]

  private struct LifecycleReadyFrame: Codable {
    let kind: String
    let attachLatencyMs: Int
    let bootstrapPath: String
    let bootstrapSource: String
    let capabilities: [String]
    let controlDirectoryPath: String
    let currentDirectoryPath: String
    let egressTransport: String
    let homeDirectoryPath: String
    let ingressTransport: String
    let initialStatusLabel: String
    let processIdentifier: Int32
    let recordedAt: String
    var runnerPort: Int?
    let runnerTransportContract: String
    let sessionIdentifier: String
    let simulatorUdid: String
    // PRB-089: fresh random identity for this one live runner process/attach.
    // Every command and response this runner sends for the rest of its life
    // carries this value — see `RunnerReplayCoordinator` below for what it
    // scopes.
    let runnerEpoch: String
  }

  private struct LifecycleCommandFrame: Codable {
    let action: String
    let payload: String?
    let sequence: Int
    // PRB-089: the epoch the host believes this runner is on. Never
    // trusted implicitly — see `RunnerReplayCoordinator.disposition(for:)`.
    let epoch: String
  }

  private struct LifecycleResponseFrame: Codable {
    let action: String
    let error: String?
    let handledMs: Int
    let inlinePayload: String?
    let inlinePayloadEncoding: String?
    let kind: String
    let ok: Bool
    let payload: String?
    let snapshotPayloadPath: String?
    let recordedAt: String
    let sequence: Int
    let snapshotNodeCount: Int?
    let statusLabel: String
    // PRB-091: `handledMs` stays the one total; these four are that total
    // broken into the phases a caller actually wants to reason about
    // independently (e.g. "resolution got slow" vs "the tap itself got
    // slow"). All four are nil for actions that don't go through
    // `performRunnerUIAction` (ping, snapshot, screenshot, recordVideo,
    // shutdown) — there is no resolution/wait/interaction phase to report
    // for those, and reporting a fabricated 0 would be less honest than
    // reporting nothing. `finalizationMs` is the exception: it is always
    // populated, since every response goes through the same generic
    // finalization step in `executeLifecycleCommandFrame`.
    let resolutionMs: Int?
    let waitMs: Int?
    let interactionMs: Int?
    let finalizationMs: Int
    // PRB-089: this runner's *current* epoch (always present, even on a
    // rejected/never-executed command) and how this particular response was
    // produced relative to the terminal-result cache and executed
    // high-water mark. See `RunnerReplayCoordinator.Disposition`.
    let epoch: String
    let replayStatus: String
  }

  private struct LifecycleCommandResult {
    let inlinePayload: String?
    let inlinePayloadEncoding: String?
    let payload: String?
    let snapshotPayloadPath: String?
    let snapshotNodeCount: Int?
    // PRB-091: populated only by the `uiAction` case — see
    // `LifecycleResponseFrame`'s matching fields for why these stay nil
    // elsewhere instead of a fabricated 0.
    var resolutionMs: Int? = nil
    var waitMs: Int? = nil
    var interactionMs: Int? = nil
  }

  private struct ParsedHTTPRequest {
    let method: String
    let target: String
    let body: Data
  }

  private struct LifecycleVideoCaptureManifest: Codable {
    let durationMs: Int
    let fps: Int
    let frameCount: Int
    let framesDirectoryPath: String
  }

  private struct RunnerUIActionLocator: Codable {
    let kind: String
    let identifier: String?
    let label: String?
    let value: String?
    let placeholder: String?
    let type: String?
    let section: String?
    let interactive: Bool?
    let ordinal: Int?
    let x: Double?
    let y: Double?
  }

  private struct RunnerUIActionPayload: Codable {
    let kind: String
    let locator: RunnerUIActionLocator
    let direction: String?
    let text: String?
    let replace: Bool?
    let steps: Int?
    let durationMs: Int?
  }

  private struct ResolvedUIActionCandidates {
    let matches: [XCUIElement]
    let sectionMatchCount: Int?
  }

  private enum LifecycleBootstrapSource: String {
    case simulatorBootstrapManifest = "simulator-bootstrap-manifest"
    case deviceBootstrapManifest = "device-bootstrap-manifest"
  }

  private struct LifecycleBootstrapConfig: Codable {
    let contractVersion: String
    let controlDirectoryPath: String
    let egressTransport: String
    let generatedAt: String
    let ingressTransport: String
    let sessionIdentifier: String
    let simulatorUdid: String
    let targetBundleId: String
  }

  private struct ResolvedLifecycleControlDirectory {
    let bootstrapPath: String
    let bootstrapSource: LifecycleBootstrapSource
    let config: LifecycleBootstrapConfig
    let controlDirectoryPath: String
  }

  private enum SnapshotBenchmarkProfile: String, CaseIterable {
    case medium
    case large

    var segmentTitle: String {
      switch self {
      case .medium:
        "Medium"
      case .large:
        "Large"
      }
    }

    var statusLabel: String {
      switch self {
      case .medium:
        "Snapshot profile ready: medium (12 generated cards)"
      case .large:
        "Snapshot profile ready: large (48 generated cards)"
      }
    }
  }

  private struct SnapshotBenchmarkSummary: Codable {
    let generatedAt: String
    let bootstrapPath: String
    let controlDirectoryPath: String
    let simulatorUdid: String
    let profiles: [SnapshotBenchmarkProfileSummary]
  }

  private struct SnapshotBenchmarkProfileSummary: Codable {
    let profile: String
    let attachLatencyMs: Int
    let profileStatusLabel: String
    let rawSnapshot: RawSnapshotMetrics
    let views: [SnapshotViewMetrics]
  }

  private struct RawSnapshotMetrics: Codable {
    let snapshotMs: Int
    let dictionaryEncodeMs: Int
    let nodeCount: Int
    let prettyBytes: Int
    let prettyLines: Int
    let compactBytes: Int
  }

  private struct SnapshotViewMetrics: Codable {
    let kind: String
    let transformMs: Int
    let encodeMs: Int
    let nodeCount: Int
    let interactiveNodeCount: Int
    let prettyBytes: Int
    let prettyLines: Int
    let compactBytes: Int
    let reductionVsRawPrettyBytesPct: Double
  }

  private struct SnapshotNodeState: Codable {
    let disabled: Bool?
    let selected: Bool?
    let focused: Bool?
  }

  private struct SnapshotFrame: Codable {
    let x: Int
    let y: Int
    let width: Int
    let height: Int
  }

  private struct SnapshotNode: Codable {
    let ref: String
    let type: String
    let identifier: String?
    let label: String?
    let value: String?
    let title: String?
    let placeholder: String?
    let frame: SnapshotFrame?
    let enabled: Bool
    let selected: Bool
    let focused: Bool
    let interactive: Bool
    let children: [SnapshotNode]
  }

  private struct PrunedSnapshotNode: Codable {
    let ref: String
    let type: String
    let identifier: String?
    let label: String?
    let value: String?
    let placeholder: String?
    let frame: SnapshotFrame?
    let state: SnapshotNodeState?
    let interactive: Bool?
    let children: [PrunedSnapshotNode]
  }

  private struct RunnerSnapshotNode: Codable {
    let type: String
    let identifier: String?
    let label: String?
    let value: String?
    let placeholder: String?
    let frame: SnapshotFrame?
    let state: SnapshotNodeState?
    let interactive: Bool
    let children: [RunnerSnapshotNode]
  }

  private struct RunnerSnapshotMetrics: Codable {
    let rawNodeCount: Int
    let prunedNodeCount: Int
    let interactiveNodeCount: Int
  }

  private struct RunnerSnapshotPayload: Codable {
    let capturedAt: String
    let statusLabel: String?
    let metrics: RunnerSnapshotMetrics
    let root: RunnerSnapshotNode
  }

  private struct FullSnapshotPayload: Codable {
    let profile: String
    let root: SnapshotNode
  }

  private struct PrunedSnapshotPayload: Codable {
    let profile: String
    let root: PrunedSnapshotNode
  }

  private struct CollapsedSnapshotNode: Codable {
    let ref: String
    let depth: Int
    let type: String
    let identifier: String?
    let label: String?
    let value: String?
    let placeholder: String?
    let frame: SnapshotFrame?
    let state: SnapshotNodeState?
    let interactive: Bool?
    let childCount: Int?
  }

  private struct CollapsedSnapshotPayload: Codable {
    let profile: String
    let nodes: [CollapsedSnapshotNode]
  }

  private struct InteractiveSnapshotNode: Codable {
    let ref: String
    let depth: Int
    let type: String
    let identifier: String?
    let label: String?
    let value: String?
    let placeholder: String?
    let frame: SnapshotFrame?
    let state: SnapshotNodeState?
    let section: String?
  }

  private struct InteractiveSnapshotPayload: Codable {
    let profile: String
    let nodes: [InteractiveSnapshotNode]
  }

  private struct EncodedPayload {
    let prettyData: Data
    let prettyLines: Int
    let compactData: Data
    let encodeMs: Int
  }

  private struct AttachedFixtureState {
    let app: XCUIApplication
    let attachLatencyMs: Int
  }

  override func setUpWithError() throws {
    continueAfterFailure = false
  }

  @MainActor
  func testAttachSnapshotAndControlWithoutRelaunch() throws {
    let defaultTestBundleIdentifier = "dev.probe.fixture"
    let app = XCUIApplication(bundleIdentifier: defaultTestBundleIdentifier)

    let attachStartedAt = Date()
    XCTAssertTrue(
      app.wait(for: .runningForeground, timeout: attachTimeout),
      "Fixture app must already be running in the foreground before ProbeRunner attaches."
    )

    let statusLabel = app.staticTexts["fixture.status.label"]
    XCTAssertTrue(
      statusLabel.waitForExistence(timeout: interactionTimeout),
      "Expected fixture status label to be reachable after attach."
    )

    let attachLatencyMs = milliseconds(since: attachStartedAt)

    let snapshotStartedAt = Date()
    let applicationSnapshot = try app.snapshot()
    let snapshotLatencyMs = milliseconds(since: snapshotStartedAt)
    let snapshotTree = applicationSnapshot.dictionaryRepresentation
    let snapshotNodeCount = Self.snapshotNodeCount(in: snapshotTree)

    XCTAssertTrue(Self.snapshotTree(snapshotTree, containsIdentifier: "fixture.form.input"))
    XCTAssertTrue(Self.snapshotTree(snapshotTree, containsIdentifier: "fixture.form.applyButton"))
    XCTAssertTrue(Self.snapshotTree(snapshotTree, containsIdentifier: "fixture.status.label"))
    XCTAssertTrue(Self.snapshotTree(snapshotTree, containsIdentifier: "fixture.navigation.detailButton"))

    let screenshot = app.screenshot()
    XCTAssertFalse(screenshot.pngRepresentation.isEmpty, "Expected a non-empty PNG screenshot.")

    let resetButton = app.buttons["Reset"]
    let inputField = app.textFields["fixture.form.input"]
    let applyButton = app.buttons["fixture.form.applyButton"]

    let typedInputs = ["probe-alpha", "probe-beta", "probe-gamma"]
    var actionSuccesses = 0

    for typedInput in typedInputs {
      XCTAssertTrue(resetButton.waitForExistence(timeout: interactionTimeout))
      resetButton.tap()

      XCTAssertTrue(
        waitForLabel(statusLabel, toEqual: "Ready for attach/control validation", timeout: interactionTimeout),
        "Expected fixture reset to restore the ready state."
      )

      XCTAssertTrue(inputField.waitForExistence(timeout: interactionTimeout))
      inputField.tap()
      inputField.typeText(typedInput)

      XCTAssertTrue(applyButton.waitForExistence(timeout: interactionTimeout))
      applyButton.tap()

      XCTAssertTrue(
        waitForLabel(statusLabel, toEqual: "Input applied: \(typedInput)", timeout: interactionTimeout),
        "Expected apply action to update the status label for \(typedInput)."
      )

      actionSuccesses += 1
    }

    XCUIDevice.shared.press(.home)

    let backgrounded = app.wait(for: .runningBackground, timeout: interactionTimeout)
      || app.wait(for: .runningBackgroundSuspended, timeout: interactionTimeout)
    XCTAssertTrue(backgrounded, "Expected the fixture app to leave foreground after pressing Home.")

    let backgroundState = Self.stateName(for: app.state)

    let reactivateStartedAt = Date()
    app.activate()
    XCTAssertTrue(
      app.wait(for: .runningForeground, timeout: interactionTimeout),
      "Expected activate() to bring the already-running fixture back to foreground."
    )
    let reactivateLatencyMs = milliseconds(since: reactivateStartedAt)

    XCTAssertTrue(
      waitForLabel(statusLabel, toEqual: "Input applied: probe-gamma", timeout: interactionTimeout),
      "Expected fixture state to survive background -> activate without a clean relaunch."
    )

    XCTAssertTrue(resetButton.waitForExistence(timeout: interactionTimeout))
    resetButton.tap()
    XCTAssertTrue(
      waitForLabel(statusLabel, toEqual: "Ready for attach/control validation", timeout: interactionTimeout),
      "Expected a post-activate tap to succeed without forcing a relaunch."
    )

    print(
      "PROBE_METRIC attach_latency_ms=\(attachLatencyMs) snapshot_latency_ms=\(snapshotLatencyMs) snapshot_nodes=\(snapshotNodeCount) screenshot_png_bytes=\(screenshot.pngRepresentation.count) action_successes=\(actionSuccesses) action_attempts=\(typedInputs.count) background_state=\(backgroundState) reactivate_latency_ms=\(reactivateLatencyMs)"
    )
  }

  @MainActor
  func testCommandLoopLifecycle() throws {
    let resolvedControlDirectory = try resolveLifecycleControlDirectory()
    let isDevice = resolvedControlDirectory.bootstrapSource == .deviceBootstrapManifest
    let controlDirectoryURL = isDevice
      ? deviceLifecycleControlDirectoryURL(sessionIdentifier: resolvedControlDirectory.config.sessionIdentifier)
      : URL(
          fileURLWithPath: resolvedControlDirectory.controlDirectoryPath,
          isDirectory: true,
        )
    try FileManager.default.createDirectory(at: controlDirectoryURL, withIntermediateDirectories: true)

    var lifecycleState = try attachForLifecycleLoop(
      resolvedControlDirectory: resolvedControlDirectory,
      controlDirectoryURL: controlDirectoryURL,
      foregroundFailureMessage: "Fixture app must already be running in the foreground before ProbeRunner enters its lifecycle loop.",
      statusLabelFailureMessage: "Expected fixture status label to exist before the lifecycle loop starts."
    )

    try runHTTPCommandLoop(
      lifecycleState: &lifecycleState,
      controlDirectoryURL: controlDirectoryURL,
      metricName: "lifecycle_ready"
    )
  }

  @MainActor
  func testCommandLoopTransportBoundary() throws {
    let resolvedControlDirectory = try resolveLifecycleControlDirectory()
    let isDevice = resolvedControlDirectory.bootstrapSource == .deviceBootstrapManifest

    let controlDirectoryURL = isDevice
      ? deviceLifecycleControlDirectoryURL(sessionIdentifier: resolvedControlDirectory.config.sessionIdentifier)
      : URL(
          fileURLWithPath: resolvedControlDirectory.controlDirectoryPath,
          isDirectory: true,
        )
    try FileManager.default.createDirectory(at: controlDirectoryURL, withIntermediateDirectories: true)

    var lifecycleState = try attachForLifecycleLoop(
      resolvedControlDirectory: resolvedControlDirectory,
      controlDirectoryURL: controlDirectoryURL,
      foregroundFailureMessage: "Fixture app must already be running in the foreground before ProbeRunner enters its transport-boundary loop.",
      statusLabelFailureMessage: "Expected fixture status label to exist before the transport-boundary loop starts."
    )

    try runHTTPCommandLoop(
      lifecycleState: &lifecycleState,
      controlDirectoryURL: controlDirectoryURL,
      metricName: "transport_boundary_ready"
    )
  }

  // PRB-089: the runner is its own client for this one. Everything the
  // glyph's guarantee boundary promises — a fresh epoch, a duplicate cached
  // command replaying instead of re-executing, a duplicate in-flight
  // command coalescing, an epoch mismatch and a sequence gap both being
  // rejected before execution, and the bounded terminal-result cache's
  // FIFO eviction correctly turning a redelivered-but-evicted identity into
  // a typed result-expired rejection instead of a silent re-execution — is
  // proven here against the *real* HTTP command server, at the real
  // Simulator/XCUITest boundary, not against a Node fake.
  @MainActor
  func testCommandLoopReplaySafety() throws {
    let resolvedControlDirectory = try resolveLifecycleControlDirectory()
    let isDevice = resolvedControlDirectory.bootstrapSource == .deviceBootstrapManifest

    let controlDirectoryURL = isDevice
      ? deviceLifecycleControlDirectoryURL(sessionIdentifier: resolvedControlDirectory.config.sessionIdentifier)
      : URL(
          fileURLWithPath: resolvedControlDirectory.controlDirectoryPath,
          isDirectory: true,
        )
    try FileManager.default.createDirectory(at: controlDirectoryURL, withIntermediateDirectories: true)

    var lifecycleState = try attachForLifecycleLoop(
      resolvedControlDirectory: resolvedControlDirectory,
      controlDirectoryURL: controlDirectoryURL,
      foregroundFailureMessage: "Fixture app must already be running in the foreground before ProbeRunner enters its replay-safety loop.",
      statusLabelFailureMessage: "Expected fixture status label to exist before the replay-safety loop starts."
    )

    let httpCommandServer = try startHTTPCommandServer(
      desiredPort: resolveRunnerPortFromEnvironment(),
      controlDirectoryURL: controlDirectoryURL,
      app: lifecycleState.app,
      statusLabel: lifecycleState.statusLabel,
      replayCoordinator: lifecycleState.replayCoordinator
    )
    lifecycleState.readyFrame.runnerPort = httpCommandServer.port
    try emitLifecycleReadyFrame(lifecycleState.readyFrame, controlDirectoryURL: controlDirectoryURL)

    let port = httpCommandServer.port
    let epoch = lifecycleState.readyFrame.runnerEpoch
    var driverError: Error?

    // The driver runs on the global concurrent queue — deliberately never a
    // `Task { @MainActor in ... }` — so it behaves exactly like the
    // external host process this runner is actually built to talk to, and
    // never contends with the connection-handling `Task`s that also need
    // the MainActor executor while this method blocks below in
    // `waitForShutdown()`. This mirrors every other command-loop test: the
    // commands always come from something other than the blocked test
    // method's own execution context.
    DispatchQueue.global(qos: .userInitiated).async {
      do {
        try Self.driveReplaySafetyScenario(port: port, epoch: epoch)
      } catch {
        driverError = error
      }
    }

    try httpCommandServer.waitForShutdown()

    if let driverError {
      throw driverError
    }
  }

  /// Drives the whole replay-safety proof over real HTTP against the
  /// already-listening runner. A plain (non-`@MainActor`) static function on
  /// purpose: nothing here may touch `app`/`statusLabel` directly — it only
  /// ever sees what the runner chooses to report back over the wire, same
  /// as any other client.
  private static func driveReplaySafetyScenario(port: Int, epoch: String) throws {
    guard let baseUrl = URL(string: "http://127.0.0.1:\(port)/command") else {
      throw NSError(
        domain: "ProbeRunnerReplaySafety",
        code: 1,
        userInfo: [NSLocalizedDescriptionKey: "Could not build a command URL for port \(port)."]
      )
    }

    // Mirrors the runner's own sentinel and update rule (see
    // `RunnerReplayCoordinator`): only a command that actually executes
    // advances this, so "the next valid sequence" stays correct across the
    // deliberately-rejected commands below.
    var executedHighWaterMark = 0
    func nextValidSequence() -> Int { executedHighWaterMark + 1 }

    func send(action: String, payload: String?, sequence: Int, epoch epochOverride: String) throws -> LifecycleResponseFrame {
      try postLifecycleCommand(to: baseUrl, sequence: sequence, action: action, payload: payload, epoch: epochOverride)
    }

    defer {
      // Best-effort, always-attempted shutdown: if an assertion above has
      // already thrown, the test method's `waitForShutdown()` would
      // otherwise block until XCTest's own (multi-hour) timeout instead of
      // reporting the real failure promptly.
      _ = try? send(action: "shutdown", payload: nil, sequence: nextValidSequence(), epoch: epoch)
    }

    // 1. A fresh command executes.
    let executedSequence = nextValidSequence()
    let firstPing = try send(action: "ping", payload: "replay-safety-1", sequence: executedSequence, epoch: epoch)
    XCTAssertTrue(firstPing.ok, "Expected the first ping delivery to execute.")
    XCTAssertEqual(firstPing.replayStatus, "executed")
    XCTAssertEqual(firstPing.epoch, epoch)
    executedHighWaterMark = executedSequence

    // 2. One hundred redeliveries of that exact (sequence, epoch) identity
    //    never re-execute it — every response replays the identical cached
    //    terminal result. There is no dedicated fixture mutation counter;
    //    response identity (`recordedAt`, byte-identical across all 100
    //    replays) is the receipt that only one execution ever happened.
    for attempt in 0..<100 {
      let replay = try send(action: "ping", payload: "replay-safety-1", sequence: executedSequence, epoch: epoch)
      XCTAssertTrue(replay.ok, "Redelivery #\(attempt) should still report ok.")
      XCTAssertEqual(replay.replayStatus, "cached-replay", "Redelivery #\(attempt) must not re-execute.")
      XCTAssertEqual(replay.recordedAt, firstPing.recordedAt, "Redelivery #\(attempt) must return the original execution's timestamp verbatim.")
      XCTAssertEqual(replay.payload, firstPing.payload)
    }

    // 3. Fault injection: execute a real mutation (one that changes visible
    //    app state), then redeliver the identical identity — modelling "the
    //    host executed the command, its first response was dropped, and it
    //    redelivered" — and observe exactly one mutation plus the cached
    //    result, never a second `applyInput`.
    let mutationSequence = nextValidSequence()
    let firstMutation = try send(action: "applyInput", payload: "probe-replay-safety", sequence: mutationSequence, epoch: epoch)
    XCTAssertTrue(firstMutation.ok)
    XCTAssertEqual(firstMutation.replayStatus, "executed")
    XCTAssertEqual(firstMutation.statusLabel, "Input applied: probe-replay-safety")
    executedHighWaterMark = mutationSequence

    let redeliveredMutation = try send(action: "applyInput", payload: "probe-replay-safety", sequence: mutationSequence, epoch: epoch)
    XCTAssertTrue(redeliveredMutation.ok)
    XCTAssertEqual(redeliveredMutation.replayStatus, "cached-replay")
    XCTAssertEqual(redeliveredMutation.recordedAt, firstMutation.recordedAt)
    XCTAssertEqual(redeliveredMutation.statusLabel, firstMutation.statusLabel)

    // 4. Epoch mismatch: a command carrying a stale epoch is rejected
    //    before it can execute, and does not consume the next valid
    //    sequence (nothing ran, so nothing advanced).
    let epochMismatch = try send(
      action: "applyInput",
      payload: "should-never-apply",
      sequence: nextValidSequence(),
      epoch: "\(epoch)-stale"
    )
    XCTAssertFalse(epochMismatch.ok)
    XCTAssertEqual(epochMismatch.replayStatus, "epoch-mismatch")
    XCTAssertEqual(epochMismatch.epoch, epoch, "The rejection still reports the runner's real (current) epoch.")
    XCTAssertEqual(epochMismatch.statusLabel, firstMutation.statusLabel, "A rejected epoch-mismatch command must never touch app state.")

    // 5. Sequence gap: skipping ahead of the executed high-water mark is
    //    also rejected before execution, and also does not consume the
    //    next valid sequence.
    let sequenceGap = try send(
      action: "applyInput",
      payload: "should-never-apply-either",
      sequence: nextValidSequence() + 5,
      epoch: epoch
    )
    XCTAssertFalse(sequenceGap.ok)
    XCTAssertEqual(sequenceGap.replayStatus, "sequence-gap")
    XCTAssertEqual(sequenceGap.statusLabel, firstMutation.statusLabel, "A rejected sequence-gap command must never touch app state.")

    // 6. Cache-eviction boundary, driven at the real Simulator/XCUITest
    //    HTTP boundary (not a Swift-unit test of `RunnerReplayCoordinator`
    //    in isolation): force the terminal-result cache past its
    //    `cacheCapacity`-entry FIFO bound so the oldest surviving entry —
    //    `executedSequence`, the very first ping from step 1 — is evicted,
    //    then redeliver that exact identity. This is the branch that stops
    //    a redelivered, executed-but-evicted command from silently
    //    re-running: the runner must tell "definitely executed once, but
    //    the cached result is gone" (result-expired) apart from "never
    //    seen before" (which would wrongly execute it a second time).
    let cacheCapacity = 64
    let evictedSequence = executedSequence
    let preEvictionStatusLabel = firstMutation.statusLabel

    // The cache already holds 2 live entries (`evictedSequence` and
    // `mutationSequence`, from steps 1 and 3). Execute `cacheCapacity - 1`
    // new, distinct, non-mutating pings (ping never touches app state — see
    // `handleLifecycleCommand`'s "ping" case) so the insertion-ordered
    // eviction list crosses `cacheCapacity` by exactly one entry, which
    // evicts only the single oldest one (`evictedSequence`) per the FIFO
    // discipline — never `mutationSequence` or any of the fill entries.
    for _ in 0..<(cacheCapacity - 1) {
      let fillSequence = nextValidSequence()
      let fillResponse = try send(action: "ping", payload: "replay-safety-fill", sequence: fillSequence, epoch: epoch)
      XCTAssertTrue(fillResponse.ok, "Expected fill ping \(fillSequence) to execute.")
      XCTAssertEqual(fillResponse.replayStatus, "executed")
      executedHighWaterMark = fillSequence
    }

    let evictedRedelivery = try send(
      action: "ping",
      payload: "replay-safety-1",
      sequence: evictedSequence,
      epoch: epoch
    )
    XCTAssertFalse(evictedRedelivery.ok, "A redelivered, executed-but-evicted sequence must never report ok.")
    XCTAssertEqual(evictedRedelivery.replayStatus, "result-expired")
    XCTAssertEqual(
      evictedRedelivery.statusLabel,
      preEvictionStatusLabel,
      "A rejected result-expired command must never touch app state."
    )
  }

  // PRB-091: contract coverage for the bounded public-XCUI query planner —
  // identifier-first resolution, bounded ambiguity detection, deterministic
  // ordinal resolution, and a clean no-match — driven straight through
  // `performRunnerUIAction`/`resolveUIActionElement` against the live
  // fixture, the same entry points a real `uiAction` command uses.
  @MainActor
  func testUIActionQueryPlannerResolvesIdentifiersAndDetectsAmbiguity() throws {
    let attached = try attachToFixture(
      foregroundFailureMessage: "Expected fixture app to be foreground before uiAction query planner checks.",
      statusLabelFailureMessage: "Expected fixture status label to exist before uiAction query planner checks."
    )
    let app = attached.app

    // A strong identifier locator resolves through the identifier-first
    // typed query with no ambiguity.
    let tapPayload = try JSONDecoder().decode(
      RunnerUIActionPayload.self,
      from: Data(#"{"kind":"tap","locator":{"kind":"semantic","identifier":"fixture.form.applyButton"}}"#.utf8)
    )
    let tapOutcome = try performRunnerUIAction(tapPayload, app: app)
    XCTAssertTrue(tapOutcome.summary.contains("tapped"), "Expected the identifier locator to resolve and tap.")
    XCTAssertGreaterThanOrEqual(tapOutcome.resolutionMs, 0)
    XCTAssertGreaterThanOrEqual(tapOutcome.waitMs, 0)
    XCTAssertGreaterThanOrEqual(tapOutcome.interactionMs, 0)

    // A weak `type: button` locator with no identifier/label matches many
    // buttons on the fixture screen (Reset, apply, snapshot profile
    // segments, ...). The bounded planner must still detect the ambiguity
    // without ever enumerating the full match set.
    let ambiguousPayload = try JSONDecoder().decode(
      RunnerUIActionPayload.self,
      from: Data(#"{"kind":"tap","locator":{"kind":"semantic","type":"button"}}"#.utf8)
    )
    XCTAssertThrowsError(try performRunnerUIAction(ambiguousPayload, app: app)) { error in
      let message = String(describing: error)
      XCTAssertTrue(message.contains("matched more than one element"), "Expected an ambiguity error, got: \(message)")
    }

    // The same weak locator with an explicit ordinal resolves
    // deterministically to the same element across repeated calls.
    let ordinalPayload = try JSONDecoder().decode(
      RunnerUIActionPayload.self,
      from: Data(#"{"kind":"tap","locator":{"kind":"semantic","type":"button","ordinal":1}}"#.utf8)
    )
    let firstOrdinalMatch = try resolveUIActionElement(locator: ordinalPayload.locator, app: app)
    let secondOrdinalMatch = try resolveUIActionElement(locator: ordinalPayload.locator, app: app)
    XCTAssertEqual(
      firstOrdinalMatch.identifier,
      secondOrdinalMatch.identifier,
      "Expected ordinal resolution to be deterministic across calls."
    )

    // An identifier absent from the fixture screen resolves to zero matches.
    let missingPayload = try JSONDecoder().decode(
      RunnerUIActionPayload.self,
      from: Data(#"{"kind":"tap","locator":{"kind":"semantic","identifier":"fixture.does.not.exist"}}"#.utf8)
    )
    XCTAssertThrowsError(try performRunnerUIAction(missingPayload, app: app)) { error in
      let message = String(describing: error)
      XCTAssertTrue(message.contains("No element matched"), "Expected a no-match error, got: \(message)")
    }
  }

  /// Synchronous (semaphore-bridged) HTTP POST to the runner's own
  /// `/command` endpoint. Kept separate from `receiveHTTPRequest`'s
  /// `NWConnection`-based server plumbing on purpose — this is the *client*
  /// side, modelling an ordinary external caller (like
  /// `RunnerTransportClient` on the host), not another runner-internal seam.
  private static func postLifecycleCommand(
    to url: URL,
    sequence: Int,
    action: String,
    payload: String?,
    epoch: String,
  ) throws -> LifecycleResponseFrame {
    let command = LifecycleCommandFrame(action: action, payload: payload, sequence: sequence, epoch: epoch)
    var request = URLRequest(url: url)
    request.httpMethod = "POST"
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.httpBody = try JSONEncoder().encode(command)

    let semaphore = DispatchSemaphore(value: 0)
    var result: Result<LifecycleResponseFrame, Error>?

    let task = URLSession.shared.dataTask(with: request) { data, _, error in
      defer { semaphore.signal() }

      if let error {
        result = .failure(error)
        return
      }

      guard let data else {
        result = .failure(NSError(
          domain: "ProbeRunnerReplaySafety",
          code: 2,
          userInfo: [NSLocalizedDescriptionKey: "Empty response body for \(action) sequence \(sequence)."]
        ))
        return
      }

      do {
        result = .success(try JSONDecoder().decode(LifecycleResponseFrame.self, from: data))
      } catch {
        result = .failure(error)
      }
    }
    task.resume()

    guard semaphore.wait(timeout: .now() + 20) == .success else {
      task.cancel()
      throw NSError(
        domain: "ProbeRunnerReplaySafety",
        code: 3,
        userInfo: [NSLocalizedDescriptionKey: "Timed out waiting for a response to \(action) sequence \(sequence)."]
      )
    }

    switch result {
    case .success(let frame):
      return frame
    case .failure(let error):
      throw error
    case .none:
      throw NSError(
        domain: "ProbeRunnerReplaySafety",
        code: 4,
        userInfo: [NSLocalizedDescriptionKey: "No result captured for \(action) sequence \(sequence)."]
      )
    }
  }

  @MainActor
  func testLargeAxTreePerformanceSpike() throws {
    let resolvedControlDirectory = try resolveLifecycleControlDirectory()
    let controlDirectoryURL = URL(
      fileURLWithPath: resolvedControlDirectory.controlDirectoryPath,
      isDirectory: true,
    )
    try FileManager.default.createDirectory(at: controlDirectoryURL, withIntermediateDirectories: true)

    let attachedFixture = try attachToFixture(
      foregroundFailureMessage: "Fixture app must already be running in the foreground before ProbeRunner benchmarks AX tree performance.",
      statusLabelFailureMessage: "Expected fixture status label to exist before ProbeRunner benchmarks AX tree performance."
    )

    let profileSummaries = try SnapshotBenchmarkProfile.allCases.map { profile in
      try benchmarkSnapshotProfile(
        profile,
        attachedFixture: attachedFixture,
        controlDirectoryURL: controlDirectoryURL
      )
    }

    let summary = SnapshotBenchmarkSummary(
      generatedAt: Self.iso8601Formatter.string(from: Date()),
      bootstrapPath: resolvedControlDirectory.bootstrapPath,
      controlDirectoryPath: controlDirectoryURL.path,
      simulatorUdid: resolvedControlDirectory.config.simulatorUdid,
      profiles: profileSummaries
    )

    try writeJSON(summary, to: controlDirectoryURL.appendingPathComponent("ax-tree-performance-summary.json"))
  }

  private struct LifecycleLoopState {
    let app: XCUIApplication
    var readyFrame: LifecycleReadyFrame
    let statusLabel: XCUIElement
    let replayCoordinator: RunnerReplayCoordinator
  }

  /// PRB-089: at-most-once mutation execution within one live runner epoch.
  ///
  /// One instance is created per `attachForLifecycleLoop` call — i.e. once
  /// per live runner process/attach, the same lifetime as `readyFrame`'s
  /// `runnerEpoch`. It owns the only two pieces of state the guarantee
  /// needs:
  ///  - a bounded terminal-result cache, keyed by command sequence number
  ///    (bounded so a long-lived runner cannot grow this without limit);
  ///  - the executed high-water mark, the greatest sequence number this
  ///    runner has ever executed, which is what lets it distinguish a
  ///    duplicate whose cache entry has since been evicted ("result
  ///    expired" — it definitely ran, but the original result is gone, so
  ///    it must never be silently re-executed) from a sequence it has
  ///    genuinely never seen.
  ///
  /// Every command this runner ever receives goes through
  /// `disposition(for:)` *before* `handleLifecycleCommand` runs, on the same
  /// `@MainActor`-serialized HTTP path as execution itself (see
  /// `receiveHTTPRequest`'s `Task { @MainActor in ... }` and
  /// `handleLifecycleCommand`, which never `await`s). That serialization is
  /// what makes "duplicate in-flight command coalesces onto the first
  /// execution" true without any separate in-flight bookkeeping here: two
  /// deliveries of the same sequence cannot both be *executing* at once
  /// (MainActor admits one job at a time), so the second one's call to
  /// `disposition(for:)` always runs either strictly before the first
  /// command has been dispatched (impossible — `disposition` and dispatch
  /// happen in the same synchronous call) or strictly after the first one
  /// has already recorded its terminal result, in which case the cache-hit
  /// branch below returns it instead of executing again.
  private final class RunnerReplayCoordinator {
    enum Disposition {
      /// Never seen before (or below the high-water mark's edge case does
      /// not apply): safe to execute.
      case execute
      /// Already executed and still cached: replay the identical result,
      /// verbatim, without executing again.
      case replay(LifecycleResponseFrame)
      /// Refuse to execute, and say exactly why. `replayStatus` is one of
      /// "epoch-mismatch", "sequence-gap", or "result-expired" — see
      /// `runnerProtocol.ts`'s `RunnerReplayStatusSchema` for the host-side
      /// contract these three values are part of.
      case reject(reason: String, replayStatus: String)
    }

    let epoch: String
    private let cacheCapacity: Int
    private var terminalCache: [Int: LifecycleResponseFrame] = [:]
    // Insertion-ordered keys, so eviction is FIFO (oldest sequence first) —
    // simplest bound that still favors the recent commands a redelivery is
    // actually likely to target.
    private var cacheEvictionOrder: [Int] = []
    // 0 is a safe "nothing executed yet" sentinel: real sequence numbers are
    // always >= 1 (SessionController.ts allocates them starting at 1), so
    // `sequence > executedHighWaterMark + 1` never misfires against it.
    private var executedHighWaterMark = 0

    init(epoch: String, cacheCapacity: Int = 64) {
      self.epoch = epoch
      self.cacheCapacity = cacheCapacity
    }

    func disposition(for command: LifecycleCommandFrame) -> Disposition {
      guard command.epoch == epoch else {
        return .reject(
          reason: "Command epoch \(command.epoch) does not match the runner's current epoch \(epoch).",
          replayStatus: "epoch-mismatch"
        )
      }

      if let cached = terminalCache[command.sequence] {
        // Relabel `replayStatus` to "cached-replay" on the way out — the
        // stored frame's own `replayStatus` is frozen at whatever it was
        // the moment it was first executed ("executed"), and that is
        // exactly the distinction a caller needs: every other field
        // (`recordedAt`, `handledMs`, `payload`, `statusLabel`, `ok`,
        // `error`, ...) stays byte-identical to the original execution —
        // that identity *is* the proof nothing ran a second time.
        return .replay(
          LifecycleResponseFrame(
            action: cached.action,
            error: cached.error,
            handledMs: cached.handledMs,
            inlinePayload: cached.inlinePayload,
            inlinePayloadEncoding: cached.inlinePayloadEncoding,
            kind: cached.kind,
            ok: cached.ok,
            payload: cached.payload,
            snapshotPayloadPath: cached.snapshotPayloadPath,
            recordedAt: cached.recordedAt,
            sequence: cached.sequence,
            snapshotNodeCount: cached.snapshotNodeCount,
            statusLabel: cached.statusLabel,
            resolutionMs: cached.resolutionMs,
            waitMs: cached.waitMs,
            interactionMs: cached.interactionMs,
            finalizationMs: cached.finalizationMs,
            epoch: cached.epoch,
            replayStatus: "cached-replay"
          )
        )
      }

      if command.sequence <= executedHighWaterMark {
        return .reject(
          reason: "Sequence \(command.sequence) was already executed but its cached result has since expired.",
          replayStatus: "result-expired"
        )
      }

      if command.sequence > executedHighWaterMark + 1 {
        return .reject(
          reason: "Sequence \(command.sequence) skips ahead of the executed high-water mark "
            + "\(executedHighWaterMark); at least one earlier sequence was never seen by this runner.",
          replayStatus: "sequence-gap"
        )
      }

      return .execute
    }

    /// Records a freshly-produced terminal result. Called exactly once per
    /// sequence, and only for a command `disposition(for:)` returned
    /// `.execute` for — whether `handleLifecycleCommand` itself succeeded or
    /// threw. A failed *attempt* still ran (with whatever side effects that
    /// implies), so it is exactly as much "already executed" as a
    /// successful one; caching it is what stops a redelivery from trying
    /// the same doomed mutation again.
    func recordExecuted(sequence: Int, response: LifecycleResponseFrame) {
      if terminalCache[sequence] == nil {
        cacheEvictionOrder.append(sequence)
      }

      terminalCache[sequence] = response
      executedHighWaterMark = max(executedHighWaterMark, sequence)
      evictIfNeeded()
    }

    private func evictIfNeeded() {
      while cacheEvictionOrder.count > cacheCapacity {
        let evicted = cacheEvictionOrder.removeFirst()
        terminalCache.removeValue(forKey: evicted)
      }
    }
  }

  @MainActor
  private func attachForLifecycleLoop(
    resolvedControlDirectory: ResolvedLifecycleControlDirectory,
    controlDirectoryURL: URL,
    foregroundFailureMessage: String,
    statusLabelFailureMessage: String,
  ) throws -> LifecycleLoopState {
    let app = XCUIApplication(bundleIdentifier: resolvedControlDirectory.config.targetBundleId)

    let attachStartedAt = Date()
    XCTAssertTrue(
      app.wait(for: .runningForeground, timeout: attachTimeout),
      foregroundFailureMessage
    )

    let attachLatencyMs = milliseconds(since: attachStartedAt)

    // The ProbeFixture app exposes a "fixture.status.label" element for validation.
    // Arbitrary target apps (e.g. on real-device sessions) will not have this element,
    // so we only assert its existence for the fixture bundle ID.
    let isFixtureApp = resolvedControlDirectory.config.targetBundleId == "dev.probe.fixture"
    let statusLabel = app.staticTexts["fixture.status.label"]
    // Only wait for the fixture status label on fixture apps.
    // Non-fixture apps won't have this element and the wait just wastes time.
    let statusLabelExists = isFixtureApp
      ? statusLabel.waitForExistence(timeout: interactionTimeout)
      : false

    if isFixtureApp {
      XCTAssertTrue(statusLabelExists, statusLabelFailureMessage)
    }

    // PRB-089: a fresh, unpredictable epoch every time this runner attaches.
    // UUID (not an incrementing counter) so nothing about a prior epoch —
    // including how many there have been — leaks into a redelivered
    // command's chance of colliding with the new one.
    let runnerEpoch = UUID().uuidString

    let readyFrame = LifecycleReadyFrame(
      kind: "ready",
      attachLatencyMs: attachLatencyMs,
      bootstrapPath: resolvedControlDirectory.bootstrapPath,
      bootstrapSource: resolvedControlDirectory.bootstrapSource.rawValue,
      capabilities: Self.advertisedRunnerCapabilities,
      controlDirectoryPath: controlDirectoryURL.path,
      currentDirectoryPath: FileManager.default.currentDirectoryPath,
      egressTransport: resolvedControlDirectory.config.egressTransport,
      homeDirectoryPath: NSHomeDirectory(),
      ingressTransport: resolvedControlDirectory.config.ingressTransport,
      initialStatusLabel: statusLabelExists ? statusLabel.label : "",
      processIdentifier: ProcessInfo.processInfo.processIdentifier,
      recordedAt: Self.iso8601Formatter.string(from: Date()),
      runnerPort: nil,
      runnerTransportContract: resolvedControlDirectory.config.contractVersion,
      sessionIdentifier: resolvedControlDirectory.config.sessionIdentifier,
      simulatorUdid: resolvedControlDirectory.config.simulatorUdid,
      runnerEpoch: runnerEpoch
    )

    return LifecycleLoopState(
      app: app,
      readyFrame: readyFrame,
      statusLabel: statusLabel,
      replayCoordinator: RunnerReplayCoordinator(epoch: runnerEpoch)
    )
  }

  private func emitLifecycleReadyFrame(_ readyFrame: LifecycleReadyFrame, controlDirectoryURL: URL) throws {
    // Keep a ready.json mirror for validation scripts; the runtime consumes stdout as canonical readiness.
    // On real device the sandbox may prevent writes, so tolerate failure.
    try? writeJSON(readyFrame, to: controlDirectoryURL.appendingPathComponent("ready.json"))
    try emitStdoutJSONLine(readyFrame)
  }

  @MainActor
  private func runHTTPCommandLoop(
    lifecycleState: inout LifecycleLoopState,
    controlDirectoryURL: URL,
    metricName: String,
  ) throws {
    let httpCommandServer = try startHTTPCommandServer(
      desiredPort: resolveRunnerPortFromEnvironment(),
      controlDirectoryURL: controlDirectoryURL,
      app: lifecycleState.app,
      statusLabel: lifecycleState.statusLabel,
      replayCoordinator: lifecycleState.replayCoordinator
    )
    lifecycleState.readyFrame.runnerPort = httpCommandServer.port

    try emitLifecycleReadyFrame(lifecycleState.readyFrame, controlDirectoryURL: controlDirectoryURL)

    print(
      "PROBE_METRIC \(metricName) attach_latency_ms=\(lifecycleState.readyFrame.attachLatencyMs) control_dir=\(controlDirectoryURL.path) pid=\(lifecycleState.readyFrame.processIdentifier) runner_port=\(httpCommandServer.port)"
    )

    try httpCommandServer.waitForShutdown()
  }

  private func resolveLifecycleControlDirectory() throws -> ResolvedLifecycleControlDirectory {
    if let bootstrapJson = ProcessInfo.processInfo.environment["PROBE_BOOTSTRAP_JSON"],
      !bootstrapJson.isEmpty,
      let bootstrapData = bootstrapJson.data(using: .utf8)
    {
      let bootstrapConfig: LifecycleBootstrapConfig
      do {
        bootstrapConfig = try JSONDecoder().decode(LifecycleBootstrapConfig.self, from: bootstrapData)
      } catch {
        throw lifecycleBootstrapError(
          "Bootstrap manifest env:PROBE_BOOTSTRAP_JSON could not be decoded: \(error.localizedDescription)"
        )
      }

      try validateLifecycleBootstrapConfig(
        bootstrapConfig,
        expectedBootstrapPath: "env:PROBE_BOOTSTRAP_JSON",
        expectedBootstrapIdentifier: bootstrapConfig.simulatorUdid
      )

      return ResolvedLifecycleControlDirectory(
        bootstrapPath: "env:PROBE_BOOTSTRAP_JSON",
        bootstrapSource: .deviceBootstrapManifest,
        config: bootstrapConfig,
        controlDirectoryPath: bootstrapConfig.controlDirectoryPath
      )
    }

    if let simulatorUdid = ProcessInfo.processInfo.environment["SIMULATOR_UDID"],
      !simulatorUdid.isEmpty
    {
      let bootstrapPath = "\(runnerBootstrapRootPath)/\(simulatorUdid).json"
      let bootstrapConfig = try loadLifecycleBootstrapConfig(at: bootstrapPath)

      try validateLifecycleBootstrapConfig(
        bootstrapConfig,
        expectedBootstrapPath: bootstrapPath,
        expectedBootstrapIdentifier: simulatorUdid
      )

      return ResolvedLifecycleControlDirectory(
        bootstrapPath: bootstrapPath,
        bootstrapSource: .simulatorBootstrapManifest,
        config: bootstrapConfig,
        controlDirectoryPath: bootstrapConfig.controlDirectoryPath
      )
    }

    let bootstrapRootURL = URL(fileURLWithPath: runnerBootstrapRootPath, isDirectory: true)
    let bootstrapEntries: [String]
    do {
      bootstrapEntries = try FileManager.default.contentsOfDirectory(atPath: bootstrapRootURL.path)
    } catch {
      throw lifecycleBootstrapError(
        "Neither SIMULATOR_UDID nor a device bootstrap manifest was available under \(runnerBootstrapRootPath): \(error.localizedDescription)"
      )
    }

    guard let deviceBootstrapFile = bootstrapEntries
      .filter({ $0.hasPrefix("device-") && $0.hasSuffix(".json") })
      .sorted()
      .last
    else {
      throw lifecycleBootstrapError(
        "SIMULATOR_UDID was not present, and no device bootstrap manifest matching device-*.json was found under \(runnerBootstrapRootPath)."
      )
    }

    let bootstrapPath = bootstrapRootURL.appendingPathComponent(deviceBootstrapFile).path
    let bootstrapConfig = try loadLifecycleBootstrapConfig(at: bootstrapPath)
    let expectedDeviceIdentifier = String(deviceBootstrapFile.dropFirst("device-".count).dropLast(".json".count))

    try validateLifecycleBootstrapConfig(
      bootstrapConfig,
      expectedBootstrapPath: bootstrapPath,
      expectedBootstrapIdentifier: expectedDeviceIdentifier
    )

    return ResolvedLifecycleControlDirectory(
      bootstrapPath: bootstrapPath,
      bootstrapSource: .deviceBootstrapManifest,
      config: bootstrapConfig,
      controlDirectoryPath: bootstrapConfig.controlDirectoryPath
    )
  }

  private func loadLifecycleBootstrapConfig(at bootstrapPath: String) throws -> LifecycleBootstrapConfig {
    guard FileManager.default.fileExists(atPath: bootstrapPath) else {
      throw lifecycleBootstrapError(
        "Expected bootstrap manifest at \(bootstrapPath), but it was missing."
      )
    }

    let bootstrapData = try Data(contentsOf: URL(fileURLWithPath: bootstrapPath))
    do {
      return try JSONDecoder().decode(LifecycleBootstrapConfig.self, from: bootstrapData)
    } catch {
      throw lifecycleBootstrapError(
        "Bootstrap manifest \(bootstrapPath) could not be decoded: \(error.localizedDescription)"
      )
    }
  }

  private func validateLifecycleBootstrapConfig(
    _ bootstrapConfig: LifecycleBootstrapConfig,
    expectedBootstrapPath: String,
    expectedBootstrapIdentifier: String,
  ) throws {
    guard bootstrapConfig.contractVersion == runnerTransportContract else {
      throw lifecycleBootstrapError(
        "Bootstrap manifest \(expectedBootstrapPath) declared contract \(bootstrapConfig.contractVersion), expected \(runnerTransportContract)."
      )
    }

    guard bootstrapConfig.simulatorUdid == expectedBootstrapIdentifier else {
      throw lifecycleBootstrapError(
        "Bootstrap manifest \(expectedBootstrapPath) declared bootstrap identifier \(bootstrapConfig.simulatorUdid), expected \(expectedBootstrapIdentifier)."
      )
    }

    guard !bootstrapConfig.controlDirectoryPath.isEmpty else {
      throw lifecycleBootstrapError(
        "Bootstrap manifest \(expectedBootstrapPath) did not declare a control directory path."
      )
    }

    guard !bootstrapConfig.targetBundleId.isEmpty else {
      throw lifecycleBootstrapError(
        "Bootstrap manifest \(expectedBootstrapPath) did not declare a target bundle ID."
      )
    }

    guard bootstrapConfig.ingressTransport == "http-post" else {
      throw lifecycleBootstrapError(
        "Bootstrap manifest \(expectedBootstrapPath) declared ingress \(bootstrapConfig.ingressTransport), expected http-post."
      )
    }

    guard bootstrapConfig.egressTransport == "stdout-jsonl-mixed-log" else {
      throw lifecycleBootstrapError(
        "Bootstrap manifest \(expectedBootstrapPath) declared egress \(bootstrapConfig.egressTransport), expected stdout-jsonl-mixed-log."
      )
    }

    guard !bootstrapConfig.sessionIdentifier.isEmpty else {
      throw lifecycleBootstrapError(
        "Bootstrap manifest \(expectedBootstrapPath) did not declare a session identifier."
      )
    }
  }

  private func lifecycleBootstrapError(_ message: String) -> NSError {
    NSError(
      domain: "ProbeRunnerLifecycle",
      code: 1,
      userInfo: [NSLocalizedDescriptionKey: message]
    )
  }

  private struct HTTPCommandServer {
    let port: Int
    let waitForShutdown: () throws -> Void
  }

  private func deviceLifecycleControlDirectoryURL(sessionIdentifier: String) -> URL {
    FileManager.default.temporaryDirectory.appendingPathComponent(
      "probe-runtime-\(sessionIdentifier)",
      isDirectory: true,
    )
  }

  private func resolveRunnerPortFromEnvironment() throws -> Int {
    let rawPort = ProcessInfo.processInfo.environment["PROBE_RUNNER_PORT"]?
      .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""

    guard !rawPort.isEmpty else {
      return 0
    }

    guard let port = Int(rawPort), (0...65535).contains(port) else {
      throw lifecycleBootstrapError("PROBE_RUNNER_PORT must be an integer between 0 and 65535, received \(rawPort).")
    }

    return port
  }

  @MainActor
  private func executeLifecycleCommandFrame(
    _ command: LifecycleCommandFrame,
    startedAt: Date,
    app: XCUIApplication,
    statusLabel: XCUIElement,
    controlDirectoryURL: URL,
    replayCoordinator: RunnerReplayCoordinator,
  ) -> LifecycleResponseFrame {
    // PRB-089: the replay decision is made *before* touching the app at
    // all. A `.replay` or `.reject` disposition returns without ever
    // calling `handleLifecycleCommand` — that is the "never re-execute"
    // half of the guarantee; `recordExecuted` below is the other half.
    switch replayCoordinator.disposition(for: command) {
    case .replay(let cached):
      return cached

    case .reject(let reason, let replayStatus):
      let finalizationStartedAt = Date()
      let statusLabelText = Self.genericResponseStatusLabel(app: app)
      return LifecycleResponseFrame(
        action: command.action,
        error: reason,
        handledMs: milliseconds(since: startedAt),
        inlinePayload: nil,
        inlinePayloadEncoding: nil,
        kind: "response",
        ok: false,
        payload: nil,
        snapshotPayloadPath: nil,
        recordedAt: Self.iso8601Formatter.string(from: Date()),
        sequence: command.sequence,
        snapshotNodeCount: nil,
        statusLabel: statusLabelText,
        resolutionMs: nil,
        waitMs: nil,
        interactionMs: nil,
        finalizationMs: milliseconds(since: finalizationStartedAt),
        epoch: replayCoordinator.epoch,
        replayStatus: replayStatus
      )

    case .execute:
      let response: LifecycleResponseFrame

      do {
        let result = try handleLifecycleCommand(
          command,
          app: app,
          statusLabel: statusLabel,
          controlDirectoryURL: controlDirectoryURL
        )
        let finalizationStartedAt = Date()
        let statusLabelText = Self.genericResponseStatusLabel(app: app)
        response = LifecycleResponseFrame(
          action: command.action,
          error: nil,
          handledMs: milliseconds(since: startedAt),
          inlinePayload: result.inlinePayload,
          inlinePayloadEncoding: result.inlinePayloadEncoding,
          kind: "response",
          ok: true,
          payload: result.payload,
          snapshotPayloadPath: result.snapshotPayloadPath,
          recordedAt: Self.iso8601Formatter.string(from: Date()),
          sequence: command.sequence,
          snapshotNodeCount: result.snapshotNodeCount,
          statusLabel: statusLabelText,
          resolutionMs: result.resolutionMs,
          waitMs: result.waitMs,
          interactionMs: result.interactionMs,
          finalizationMs: milliseconds(since: finalizationStartedAt),
          epoch: replayCoordinator.epoch,
          replayStatus: "executed"
        )
      } catch {
        let finalizationStartedAt = Date()
        let statusLabelText = Self.genericResponseStatusLabel(app: app)
        response = LifecycleResponseFrame(
          action: command.action,
          error: String(describing: error),
          handledMs: milliseconds(since: startedAt),
          inlinePayload: nil,
          inlinePayloadEncoding: nil,
          kind: "response",
          ok: false,
          payload: nil,
          snapshotPayloadPath: nil,
          recordedAt: Self.iso8601Formatter.string(from: Date()),
          sequence: command.sequence,
          snapshotNodeCount: nil,
          statusLabel: statusLabelText,
          resolutionMs: nil,
          waitMs: nil,
          interactionMs: nil,
          finalizationMs: milliseconds(since: finalizationStartedAt),
          epoch: replayCoordinator.epoch,
          replayStatus: "executed"
        )
      }

      // A failed attempt still ran (and may have left side effects), so it
      // is cached exactly like a successful one — never re-execute a
      // sequence just because its first attempt threw.
      replayCoordinator.recordExecuted(sequence: command.sequence, response: response)
      return response
    }
  }

  @MainActor
  private func startHTTPCommandServer(
    desiredPort: Int,
    controlDirectoryURL: URL,
    app: XCUIApplication,
    statusLabel: XCUIElement,
    replayCoordinator: RunnerReplayCoordinator,
  ) throws -> HTTPCommandServer {
    let listener = try makeHTTPListener(desiredPort: desiredPort)
    let queue = DispatchQueue(label: "probe.runner.http")
    let startupSemaphore = DispatchSemaphore(value: 0)
    let doneExpectation = expectation(description: "ProbeRunner HTTP command loop finished")
    var didSignalStartup = false
    var didFinish = false
    var startupError: Error?
    var actualPort: Int?
    let finishLoopIfNeeded = {
      guard !didFinish else {
        return
      }

      didFinish = true
      doneExpectation.fulfill()
    }

    listener.stateUpdateHandler = { state in
      switch state {
      case .ready:
        actualPort = listener.port.map { Int($0.rawValue) }
        if !didSignalStartup {
          didSignalStartup = true
          startupSemaphore.signal()
        }
      case .failed(let error):
        startupError = error
        if !didSignalStartup {
          didSignalStartup = true
          startupSemaphore.signal()
        }
        finishLoopIfNeeded()
      case .cancelled:
        finishLoopIfNeeded()
      default:
        break
      }
    }

    listener.newConnectionHandler = { [weak self] connection in
      connection.start(queue: queue)
      self?.receiveHTTPRequest(
        on: connection,
        buffer: Data(),
        controlDirectoryURL: controlDirectoryURL,
        app: app,
        statusLabel: statusLabel,
        replayCoordinator: replayCoordinator,
        onShutdown: {
          listener.cancel()
          finishLoopIfNeeded()
        }
      )
    }

    listener.start(queue: queue)

    guard startupSemaphore.wait(timeout: .now() + 10) == .success else {
      listener.cancel()
      throw lifecycleBootstrapError("The runner HTTP command listener did not become ready before the timeout.")
    }

    if let startupError {
      listener.cancel()
      throw startupError
    }

    guard let actualPort else {
      listener.cancel()
      throw lifecycleBootstrapError("The runner HTTP command listener did not report a bound port.")
    }

    return HTTPCommandServer(
      port: actualPort,
      waitForShutdown: {
        let waitResult = XCTWaiter.wait(for: [doneExpectation], timeout: 24 * 60 * 60)
        listener.cancel()

        if waitResult != .completed {
          throw self.lifecycleBootstrapError("The runner HTTP command listener ended with \(waitResult).")
        }
      }
    )
  }

  private func makeHTTPListener(desiredPort: Int) throws -> NWListener {
    if desiredPort > 0, let port = NWEndpoint.Port(rawValue: UInt16(desiredPort)) {
      return try NWListener(using: .tcp, on: port)
    }

    return try NWListener(using: .tcp)
  }

  private func receiveHTTPRequest(
    on connection: NWConnection,
    buffer: Data,
    controlDirectoryURL: URL,
    app: XCUIApplication,
    statusLabel: XCUIElement,
    replayCoordinator: RunnerReplayCoordinator,
    onShutdown: @escaping () -> Void,
  ) {
    connection.receive(minimumIncompleteLength: 1, maximumLength: 1024 * 1024) { [weak self] data, _, _, error in
      guard let self else {
        connection.cancel()
        return
      }

      if error != nil {
        connection.cancel()
        return
      }

      guard let data, !data.isEmpty else {
        connection.cancel()
        return
      }

      let combined = buffer + data
      guard let request = self.parseHTTPRequest(from: combined) else {
        self.receiveHTTPRequest(
          on: connection,
          buffer: combined,
          controlDirectoryURL: controlDirectoryURL,
          app: app,
          statusLabel: statusLabel,
          replayCoordinator: replayCoordinator,
          onShutdown: onShutdown,
        )
        return
      }

      Task { @MainActor in
        let response = self.handleHTTPRequest(
          request,
          controlDirectoryURL: controlDirectoryURL,
          app: app,
          statusLabel: statusLabel,
          replayCoordinator: replayCoordinator,
        )
        self.sendHTTPResponse(response.data, over: connection) {
          if response.shouldShutdown {
            onShutdown()
          }
        }
      }
    }
  }

  @MainActor
  private func handleHTTPRequest(
    _ request: ParsedHTTPRequest,
    controlDirectoryURL: URL,
    app: XCUIApplication,
    statusLabel: XCUIElement,
    replayCoordinator: RunnerReplayCoordinator,
  ) -> (data: Data, shouldShutdown: Bool) {
    switch request.method.uppercased() {
    case "POST":
      guard request.target == "/command" else {
        return (
          (try? encodeHTTPJSONResponse(status: 404, value: ["error": "Unsupported HTTP target \(request.target)"]))
            ?? Data("HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".utf8),
          false
        )
      }

      do {
        let command = try JSONDecoder().decode(LifecycleCommandFrame.self, from: request.body)
        let responseFrame = executeLifecycleCommandFrame(
          command,
          startedAt: Date(),
          app: app,
          statusLabel: statusLabel,
          controlDirectoryURL: controlDirectoryURL,
          replayCoordinator: replayCoordinator,
        )
        return (
          try encodeHTTPJSONResponse(status: 200, value: responseFrame),
          // PRB-089: a shutdown command rejected by the replay coordinator
          // (wrong epoch, a sequence gap, an expired cache entry) never
          // executed — `ok` is false — so it must not tear the listener
          // down. Gate on the actual outcome, not just the requested
          // action.
          command.action == "shutdown" && responseFrame.ok
        )
      } catch {
        return (
          (try? encodeHTTPJSONResponse(status: 400, value: ["error": String(describing: error)]))
            ?? Data("HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".utf8),
          false
        )
      }

    case "GET":
      do {
        let artifactData = try readHTTPArtifactData(
          target: request.target,
          controlDirectoryURL: controlDirectoryURL
        )
        return (
          try encodeHTTPBinaryResponse(
            status: 200,
            contentType: contentType(forArtifactTarget: request.target),
            body: artifactData
          ),
          false
        )
      } catch {
        return (
          (try? encodeHTTPJSONResponse(status: 404, value: ["error": String(describing: error)]))
            ?? Data("HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".utf8),
          false
        )
      }

    default:
      return (
        (try? encodeHTTPJSONResponse(status: 405, value: ["error": "Unsupported HTTP method \(request.method)"]))
          ?? Data("HTTP/1.1 405 Method Not Allowed\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".utf8),
        false
      )
    }
  }

  private func sendHTTPResponse(_ response: Data, over connection: NWConnection, afterSend: @escaping () -> Void) {
    connection.send(content: response, isComplete: true, completion: .contentProcessed { _ in
      connection.cancel()
      afterSend()
    })
  }

  private func parseHTTPRequest(from data: Data) -> ParsedHTTPRequest? {
    guard let headerEnd = data.range(of: Data("\r\n\r\n".utf8)) else {
      return nil
    }

    let headerData = data.subdata(in: 0..<headerEnd.lowerBound)
    let bodyStart = headerEnd.upperBound
    let headers = String(decoding: headerData, as: UTF8.self)
    let headerLines = headers.components(separatedBy: "\r\n")

    guard let requestLine = headerLines.first, !requestLine.isEmpty else {
      return nil
    }

    let requestParts = requestLine.split(separator: " ", maxSplits: 2).map(String.init)

    guard requestParts.count >= 2 else {
      return nil
    }

    let method = requestParts[0]
    let target = requestParts[1]
    let contentLength = extractHTTPContentLength(from: headers) ?? 0

    guard data.count >= bodyStart + contentLength else {
      return nil
    }

    let body = contentLength == 0
      ? Data()
      : data.subdata(in: bodyStart..<(bodyStart + contentLength))

    return ParsedHTTPRequest(
      method: method,
      target: target,
      body: body
    )
  }

  private func extractHTTPContentLength(from headers: String) -> Int? {
    for line in headers.components(separatedBy: "\r\n") where !line.isEmpty {
      let parts = line
        .split(separator: ":", maxSplits: 1)
        .map { $0.trimmingCharacters(in: .whitespaces) }

      if parts.count == 2 && parts[0].lowercased() == "content-length" {
        return Int(parts[1])
      }
    }

    return nil
  }

  private func encodeHTTPJSONResponse<T: Encodable>(status: Int, value: T) throws -> Data {
    let body = try JSONEncoder().encode(value)
    return encodeHTTPResponse(
      status: status,
      reason: status == 200 ? "OK" : "Error",
      contentType: "application/json",
      body: body
    )
  }

  private func encodeHTTPBinaryResponse(status: Int, contentType: String, body: Data) throws -> Data {
    encodeHTTPResponse(
      status: status,
      reason: status == 200 ? "OK" : "Error",
      contentType: contentType,
      body: body
    )
  }

  private func encodeHTTPResponse(status: Int, reason: String, contentType: String, body: Data) -> Data {
    let headers = [
      "HTTP/1.1 \(status) \(reason)",
      "Content-Type: \(contentType)",
      "Content-Length: \(body.count)",
      "Connection: close",
      "",
      "",
    ].joined(separator: "\r\n")

    var response = Data(headers.utf8)
    response.append(body)
    return response
  }

  private func readHTTPArtifactData(target: String, controlDirectoryURL: URL) throws -> Data {
    guard let components = URLComponents(string: "http://probe.local\(target)"),
      components.path == "/artifact",
      let requestedPath = components.queryItems?.first(where: { $0.name == "path" })?.value,
      !requestedPath.isEmpty
    else {
      throw lifecycleBootstrapError("Artifact requests must target /artifact?path=<absolute-path>.")
    }

    let controlRoot = controlDirectoryURL.path
    guard requestedPath == controlRoot || requestedPath.hasPrefix("\(controlRoot)/") else {
      throw lifecycleBootstrapError("Artifact request \(requestedPath) escaped the lifecycle control directory.")
    }

    let artifactURL = URL(fileURLWithPath: requestedPath)
    return try Data(contentsOf: artifactURL)
  }

  private func contentType(forArtifactTarget target: String) -> String {
    guard let components = URLComponents(string: "http://probe.local\(target)"),
      let requestedPath = components.queryItems?.first(where: { $0.name == "path" })?.value
    else {
      return "application/octet-stream"
    }

    if requestedPath.hasSuffix(".json") {
      return "application/json"
    }

    if requestedPath.hasSuffix(".png") {
      return "image/png"
    }

    return "application/octet-stream"
  }

  private func emitStdoutJSONLine<T: Encodable>(_ value: T) throws {
    let data = try JSONEncoder().encode(value)
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data([0x0A]))
  }

  private func waitForLabel(_ element: XCUIElement, toEqual label: String, timeout: TimeInterval) -> Bool {
    let predicate = NSPredicate(format: "label == %@", label)
    let expectation = XCTNSPredicateExpectation(predicate: predicate, object: element)
    return XCTWaiter().wait(for: [expectation], timeout: timeout) == .completed
  }

  @MainActor
  private func attachToFixture(
    foregroundFailureMessage: String,
    statusLabelFailureMessage: String,
  ) throws -> AttachedFixtureState {
    let defaultTestBundleIdentifier = "dev.probe.fixture"
    let app = XCUIApplication(bundleIdentifier: defaultTestBundleIdentifier)

    let attachStartedAt = Date()
    XCTAssertTrue(
      app.wait(for: .runningForeground, timeout: attachTimeout),
      foregroundFailureMessage
    )

    let statusLabel = app.staticTexts["fixture.status.label"]
    XCTAssertTrue(
      statusLabel.waitForExistence(timeout: interactionTimeout),
      statusLabelFailureMessage
    )

    return AttachedFixtureState(
      app: app,
      attachLatencyMs: milliseconds(since: attachStartedAt)
    )
  }

  @MainActor
  private func benchmarkSnapshotProfile(
    _ profile: SnapshotBenchmarkProfile,
    attachedFixture: AttachedFixtureState,
    controlDirectoryURL: URL,
  ) throws -> SnapshotBenchmarkProfileSummary {
    let profileStatusLabel = try selectSnapshotBenchmarkProfile(profile, app: attachedFixture.app)

    let snapshotStartedAt = Date()
    let snapshot = try attachedFixture.app.snapshot()
    let snapshotMs = milliseconds(since: snapshotStartedAt)

    let rawDictionary = snapshot.dictionaryRepresentation
    let dictionaryEncodeStartedAt = Date()
    let rawPrettyData = try Self.jsonData(rawDictionary, prettyPrinted: true)
    let rawCompactData = try Self.jsonData(rawDictionary, prettyPrinted: false)
    let dictionaryEncodeMs = milliseconds(since: dictionaryEncodeStartedAt)

    let rawSnapshotMetrics = RawSnapshotMetrics(
      snapshotMs: snapshotMs,
      dictionaryEncodeMs: dictionaryEncodeMs,
      nodeCount: Self.snapshotNodeCount(in: rawDictionary),
      prettyBytes: rawPrettyData.count,
      prettyLines: Self.lineCount(in: rawPrettyData),
      compactBytes: rawCompactData.count
    )

    let profileDirectoryURL = controlDirectoryURL.appendingPathComponent(profile.rawValue, isDirectory: true)
    try FileManager.default.createDirectory(at: profileDirectoryURL, withIntermediateDirectories: true)
    try rawPrettyData.write(to: profileDirectoryURL.appendingPathComponent("raw-dictionary.json"), options: .atomic)

    var nextRefIndex = 1
    let fullTransformStartedAt = Date()
    let fullRoot = Self.buildSnapshotNode(from: snapshot, refIndex: &nextRefIndex)
    let fullTransformMs = milliseconds(since: fullTransformStartedAt)
    let fullEncoded = try encodePayload(FullSnapshotPayload(profile: profile.rawValue, root: fullRoot))
    try fullEncoded.prettyData.write(to: profileDirectoryURL.appendingPathComponent("full.json"), options: .atomic)

    let prunedTransformStartedAt = Date()
    let prunedRoot = Self.pruneSnapshotNode(fullRoot)
    let prunedTransformMs = milliseconds(since: prunedTransformStartedAt)
    let prunedEncoded = try encodePayload(PrunedSnapshotPayload(profile: profile.rawValue, root: prunedRoot))
    try prunedEncoded.prettyData.write(to: profileDirectoryURL.appendingPathComponent("pruned.json"), options: .atomic)

    let collapsedTransformStartedAt = Date()
    var collapsedNodes: [CollapsedSnapshotNode] = []
    Self.collectCollapsedNodes(from: prunedRoot, depth: 0, into: &collapsedNodes)
    let collapsedTransformMs = milliseconds(since: collapsedTransformStartedAt)
    let collapsedEncoded = try encodePayload(
      CollapsedSnapshotPayload(profile: profile.rawValue, nodes: collapsedNodes)
    )
    try collapsedEncoded.prettyData.write(
      to: profileDirectoryURL.appendingPathComponent("collapsed.json"),
      options: .atomic
    )

    let interactiveTransformStartedAt = Date()
    var interactiveNodes: [InteractiveSnapshotNode] = []
    Self.collectInteractiveNodes(from: prunedRoot, depth: 0, section: nil, into: &interactiveNodes)
    let interactiveTransformMs = milliseconds(since: interactiveTransformStartedAt)
    let interactiveEncoded = try encodePayload(
      InteractiveSnapshotPayload(profile: profile.rawValue, nodes: interactiveNodes)
    )
    try interactiveEncoded.prettyData.write(
      to: profileDirectoryURL.appendingPathComponent("interactive-only.json"),
      options: .atomic
    )

    let fullMetrics = SnapshotViewMetrics(
      kind: "full",
      transformMs: fullTransformMs,
      encodeMs: fullEncoded.encodeMs,
      nodeCount: Self.snapshotNodeCount(in: fullRoot),
      interactiveNodeCount: Self.interactiveNodeCount(in: fullRoot),
      prettyBytes: fullEncoded.prettyData.count,
      prettyLines: fullEncoded.prettyLines,
      compactBytes: fullEncoded.compactData.count,
      reductionVsRawPrettyBytesPct: Self.percentageReduction(
        base: rawSnapshotMetrics.prettyBytes,
        current: fullEncoded.prettyData.count
      )
    )

    let prunedMetrics = SnapshotViewMetrics(
      kind: "pruned",
      transformMs: prunedTransformMs,
      encodeMs: prunedEncoded.encodeMs,
      nodeCount: Self.snapshotNodeCount(in: prunedRoot),
      interactiveNodeCount: Self.interactiveNodeCount(in: prunedRoot),
      prettyBytes: prunedEncoded.prettyData.count,
      prettyLines: prunedEncoded.prettyLines,
      compactBytes: prunedEncoded.compactData.count,
      reductionVsRawPrettyBytesPct: Self.percentageReduction(
        base: rawSnapshotMetrics.prettyBytes,
        current: prunedEncoded.prettyData.count
      )
    )

    let collapsedMetrics = SnapshotViewMetrics(
      kind: "collapsed",
      transformMs: collapsedTransformMs,
      encodeMs: collapsedEncoded.encodeMs,
      nodeCount: collapsedNodes.count,
      interactiveNodeCount: collapsedNodes.filter { $0.interactive == true }.count,
      prettyBytes: collapsedEncoded.prettyData.count,
      prettyLines: collapsedEncoded.prettyLines,
      compactBytes: collapsedEncoded.compactData.count,
      reductionVsRawPrettyBytesPct: Self.percentageReduction(
        base: rawSnapshotMetrics.prettyBytes,
        current: collapsedEncoded.prettyData.count
      )
    )

    let interactiveMetrics = SnapshotViewMetrics(
      kind: "interactive-only",
      transformMs: interactiveTransformMs,
      encodeMs: interactiveEncoded.encodeMs,
      nodeCount: interactiveNodes.count,
      interactiveNodeCount: interactiveNodes.count,
      prettyBytes: interactiveEncoded.prettyData.count,
      prettyLines: interactiveEncoded.prettyLines,
      compactBytes: interactiveEncoded.compactData.count,
      reductionVsRawPrettyBytesPct: Self.percentageReduction(
        base: rawSnapshotMetrics.prettyBytes,
        current: interactiveEncoded.prettyData.count
      )
    )

    print(
      "PROBE_METRIC ax_tree_profile=\(profile.rawValue) snapshot_ms=\(rawSnapshotMetrics.snapshotMs) raw_pretty_bytes=\(rawSnapshotMetrics.prettyBytes) full_pretty_bytes=\(fullMetrics.prettyBytes) pruned_pretty_bytes=\(prunedMetrics.prettyBytes) collapsed_pretty_bytes=\(collapsedMetrics.prettyBytes) interactive_pretty_bytes=\(interactiveMetrics.prettyBytes)"
    )

    return SnapshotBenchmarkProfileSummary(
      profile: profile.rawValue,
      attachLatencyMs: attachedFixture.attachLatencyMs,
      profileStatusLabel: profileStatusLabel,
      rawSnapshot: rawSnapshotMetrics,
      views: [fullMetrics, prunedMetrics, collapsedMetrics, interactiveMetrics]
    )
  }

  @MainActor
  private func selectSnapshotBenchmarkProfile(
    _ profile: SnapshotBenchmarkProfile,
    app: XCUIApplication,
  ) throws -> String {
    let profileControl = app.segmentedControls["fixture.snapshot.profile.control"]
    XCTAssertTrue(
      profileControl.waitForExistence(timeout: interactionTimeout),
      "Expected the fixture snapshot profile control to exist before benchmarking."
    )

    let profileStatusLabel = app.staticTexts["fixture.snapshot.profile.statusLabel"]
    XCTAssertTrue(
      profileStatusLabel.waitForExistence(timeout: interactionTimeout),
      "Expected the fixture snapshot profile status label to exist before benchmarking."
    )

    let targetButton = profileControl.buttons[profile.segmentTitle]
    XCTAssertTrue(
      targetButton.waitForExistence(timeout: interactionTimeout),
      "Expected the fixture snapshot profile button for \(profile.segmentTitle) to exist."
    )

    if !targetButton.isSelected {
      targetButton.tap()
    }

    XCTAssertTrue(
      waitForLabel(profileStatusLabel, toEqual: profile.statusLabel, timeout: interactionTimeout),
      "Expected the fixture snapshot profile status label to confirm \(profile.rawValue)."
    )

    return profileStatusLabel.label
  }

  private func encodePayload<T: Encodable>(_ value: T) throws -> EncodedPayload {
    let startedAt = Date()

    let prettyEncoder = JSONEncoder()
    prettyEncoder.outputFormatting = [.prettyPrinted, .sortedKeys]
    let prettyData = try prettyEncoder.encode(value)

    let compactEncoder = JSONEncoder()
    compactEncoder.outputFormatting = [.sortedKeys]
    let compactData = try compactEncoder.encode(value)

    return EncodedPayload(
      prettyData: prettyData,
      prettyLines: Self.lineCount(in: prettyData),
      compactData: compactData,
      encodeMs: milliseconds(since: startedAt)
    )
  }

  private static func jsonData(_ value: Any, prettyPrinted: Bool) throws -> Data {
    let options: JSONSerialization.WritingOptions = prettyPrinted
      ? [.prettyPrinted, .sortedKeys]
      : [.sortedKeys]
    return try JSONSerialization.data(withJSONObject: value, options: options)
  }

  private static func lineCount(in data: Data) -> Int {
    guard let string = String(data: data, encoding: .utf8), !string.isEmpty else {
      return 0
    }

    return string.split(separator: "\n", omittingEmptySubsequences: false).count
  }

  private static func buildSnapshotNode(
    from snapshot: XCUIElementSnapshot,
    refIndex: inout Int,
  ) -> SnapshotNode {
    let ref = "@e\(refIndex)"
    refIndex += 1

    let children = snapshot.children.map { child in
      buildSnapshotNode(from: child, refIndex: &refIndex)
    }

    return SnapshotNode(
      ref: ref,
      type: elementTypeName(snapshot.elementType),
      identifier: normalizedText(snapshot.identifier),
      label: normalizedText(snapshot.label),
      value: normalizedValue(snapshot.value),
      title: normalizedText(snapshot.title),
      placeholder: normalizedText(snapshot.placeholderValue),
      frame: normalizedFrame(snapshot.frame),
      enabled: snapshot.isEnabled,
      selected: snapshot.isSelected,
      focused: snapshot.hasFocus,
      interactive: isInteractiveElementType(snapshot.elementType),
      children: children
    )
  }

  private static func pruneSnapshotNode(_ node: SnapshotNode) -> PrunedSnapshotNode {
    let children = node.children.map(pruneSnapshotNode)
    let placeholder = node.value == nil ? node.placeholder : nil
    let state = snapshotNodeState(from: node)
    let frame = node.interactive || node.identifier != nil ? node.frame : nil

    return PrunedSnapshotNode(
      ref: node.ref,
      type: node.type,
      identifier: node.identifier,
      label: node.label,
      value: node.value,
      placeholder: placeholder,
      frame: frame,
      state: state,
      interactive: node.interactive ? true : nil,
      children: children
    )
  }

  private static func buildRunnerSnapshotNode(from snapshot: XCUIElementSnapshot) -> RunnerSnapshotNode {
    let state = SnapshotNodeState(
      disabled: snapshot.isEnabled ? nil : true,
      selected: snapshot.isSelected ? true : nil,
      focused: snapshot.hasFocus ? true : nil
    )
    let normalizedState = state.disabled == nil && state.selected == nil && state.focused == nil
      ? nil
      : state

    return RunnerSnapshotNode(
      type: elementTypeName(snapshot.elementType),
      identifier: normalizedText(snapshot.identifier),
      label: normalizedText(snapshot.label),
      value: normalizedValue(snapshot.value),
      placeholder: normalizedText(snapshot.placeholderValue),
      frame: normalizedFrame(snapshot.frame),
      state: normalizedState,
      interactive: isInteractiveElementType(snapshot.elementType),
      children: snapshot.children.map(buildRunnerSnapshotNode)
    )
  }

  private static func snapshotNodeState(from node: SnapshotNode) -> SnapshotNodeState? {
    let state = SnapshotNodeState(
      disabled: node.enabled ? nil : true,
      selected: node.selected ? true : nil,
      focused: node.focused ? true : nil
    )

    if state.disabled == nil && state.selected == nil && state.focused == nil {
      return nil
    }

    return state
  }

  private static func collectCollapsedNodes(
    from node: PrunedSnapshotNode,
    depth: Int,
    into nodes: inout [CollapsedSnapshotNode],
  ) {
    if shouldCollapseStructuralNode(node) {
      node.children.forEach { child in
        collectCollapsedNodes(from: child, depth: depth, into: &nodes)
      }
      return
    }

    nodes.append(
      CollapsedSnapshotNode(
        ref: node.ref,
        depth: depth,
        type: node.type,
        identifier: node.identifier,
        label: node.label,
        value: node.value,
        placeholder: node.placeholder,
        frame: node.frame,
        state: node.state,
        interactive: node.interactive,
        childCount: node.children.isEmpty ? nil : node.children.count
      )
    )

    node.children.forEach { child in
      collectCollapsedNodes(from: child, depth: depth + 1, into: &nodes)
    }
  }

  private static func shouldCollapseStructuralNode(_ node: PrunedSnapshotNode) -> Bool {
    guard node.children.count == 1 else {
      return false
    }

    return node.identifier == nil
      && node.label == nil
      && node.value == nil
      && node.placeholder == nil
      && node.frame == nil
      && node.state == nil
      && node.interactive == nil
  }

  private static func collectInteractiveNodes(
    from node: PrunedSnapshotNode,
    depth: Int,
    section: String?,
    into nodes: inout [InteractiveSnapshotNode],
  ) {
    let nextSection = sectionContext(for: node) ?? section

    if node.interactive == true {
      nodes.append(
        InteractiveSnapshotNode(
          ref: node.ref,
          depth: depth,
          type: node.type,
          identifier: node.identifier,
          label: node.label,
          value: node.value,
          placeholder: node.placeholder,
          frame: node.frame,
          state: node.state,
          section: section
        )
      )
    }

    node.children.forEach { child in
      collectInteractiveNodes(from: child, depth: depth + 1, section: nextSection, into: &nodes)
    }
  }

  private static func sectionContext(for node: PrunedSnapshotNode) -> String? {
    node.identifier ?? node.label
  }

  private static func snapshotNodeCount(in node: SnapshotNode) -> Int {
    1 + node.children.reduce(0) { partial, child in
      partial + snapshotNodeCount(in: child)
    }
  }

  private static func snapshotNodeCount(in node: PrunedSnapshotNode) -> Int {
    1 + node.children.reduce(0) { partial, child in
      partial + snapshotNodeCount(in: child)
    }
  }

  private static func snapshotNodeCount(in node: RunnerSnapshotNode) -> Int {
    1 + node.children.reduce(0) { partial, child in
      partial + snapshotNodeCount(in: child)
    }
  }

  private static func interactiveNodeCount(in node: SnapshotNode) -> Int {
    (node.interactive ? 1 : 0) + node.children.reduce(0) { partial, child in
      partial + interactiveNodeCount(in: child)
    }
  }

  private static func interactiveNodeCount(in node: PrunedSnapshotNode) -> Int {
    (node.interactive == true ? 1 : 0) + node.children.reduce(0) { partial, child in
      partial + interactiveNodeCount(in: child)
    }
  }

  private static func interactiveNodeCount(in node: RunnerSnapshotNode) -> Int {
    (node.interactive ? 1 : 0) + node.children.reduce(0) { partial, child in
      partial + interactiveNodeCount(in: child)
    }
  }

  private static func normalizedText(_ value: String?) -> String? {
    guard let value else {
      return nil
    }

    let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
    return trimmed.isEmpty ? nil : trimmed
  }

  private static func normalizedValue(_ value: Any?) -> String? {
    guard let value else {
      return nil
    }

    if let text = value as? String {
      return normalizedText(text)
    }

    if let number = value as? NSNumber {
      return number.stringValue
    }

    let description = String(describing: value)
    return normalizedText(description)
  }

  private static func normalizedFrame(_ frame: CGRect) -> SnapshotFrame? {
    guard frame.width > 0, frame.height > 0 else {
      return nil
    }

    return SnapshotFrame(
      x: Int(frame.origin.x.rounded()),
      y: Int(frame.origin.y.rounded()),
      width: Int(frame.width.rounded()),
      height: Int(frame.height.rounded())
    )
  }

  private static func percentageReduction(base: Int, current: Int) -> Double {
    guard base > 0 else {
      return 0
    }

    let reduction = (1 - (Double(current) / Double(base))) * 100
    return (reduction * 10).rounded() / 10
  }

  private static func elementTypeName(_ elementType: XCUIElement.ElementType) -> String {
    switch elementType {
    case .application:
      return "application"
    case .window:
      return "window"
    case .other:
      return "other"
    case .scrollView:
      return "scrollView"
    case .button:
      return "button"
    case .staticText:
      return "staticText"
    case .textField:
      return "textField"
    case .secureTextField:
      return "secureTextField"
    case .textView:
      return "textView"
    case .switch:
      return "switch"
    case .segmentedControl:
      return "segmentedControl"
    case .table:
      return "table"
    case .cell:
      return "cell"
    case .collectionView:
      return "collectionView"
    case .navigationBar:
      return "navigationBar"
    default:
      return "type-\(elementType.rawValue)"
    }
  }

  private static func isInteractiveElementType(_ elementType: XCUIElement.ElementType) -> Bool {
    switch elementType {
    case .button,
      .cell,
      .datePicker,
      .link,
      .picker,
      .pickerWheel,
      .searchField,
      .secureTextField,
      .segmentedControl,
      .slider,
      .stepper,
      .switch,
      .textField,
      .textView:
      return true
    default:
      return false
    }
  }

  private func actionError(_ message: String) -> NSError {
    NSError(
      domain: "ProbeRunnerAction",
      code: 1,
      userInfo: [NSLocalizedDescriptionKey: message]
    )
  }

  private func requireActionCondition(_ condition: @autoclosure () -> Bool, _ message: String) throws {
    guard condition() else {
      throw actionError(message)
    }
  }

  private func describeUIActionLocator(_ locator: RunnerUIActionLocator) -> String {
    if locator.kind == "point" {
      guard let x = locator.x, let y = locator.y else {
        return "interaction-root point"
      }

      return "point(\(x), \(y))"
    }

    var parts: [String] = []

    if let identifier = Self.normalizedText(locator.identifier) {
      parts.append("identifier=\(identifier)")
    }

    if let label = Self.normalizedText(locator.label) {
      parts.append("label=\(label)")
    }

    if let value = Self.normalizedText(locator.value) {
      parts.append("value=\(value)")
    }

    if let placeholder = Self.normalizedText(locator.placeholder) {
      parts.append("placeholder=\(placeholder)")
    }

    if let type = Self.normalizedText(locator.type) {
      parts.append("type=\(type)")
    }

    if let section = Self.normalizedText(locator.section) {
      parts.append("section=\(section)")
    }

    if let interactive = locator.interactive {
      parts.append("interactive=\(interactive)")
    }

    if let ordinal = locator.ordinal {
      parts.append("ordinal=\(ordinal)")
    }

    return parts.isEmpty ? "ui target" : parts.joined(separator: ", ")
  }

  @MainActor
  private func resolveUIActionCoordinate(
    locator: RunnerUIActionLocator,
    app: XCUIApplication,
  ) throws -> XCUICoordinate {
    guard locator.kind == "point" else {
      throw actionError("Expected a point locator, received \(locator.kind).")
    }

    guard let x = locator.x, let y = locator.y else {
      throw actionError("Point locator must include x and y coordinates.")
    }

    let origin = app.coordinate(withNormalizedOffset: CGVector(dx: 0, dy: 0))
    return origin.withOffset(CGVector(dx: x, dy: y))
  }

  private func elementType(for typeName: String?) -> XCUIElement.ElementType {
    switch typeName {
    case nil:
      return .any
    case "application":
      return .application
    case "window":
      return .window
    case "other":
      return .other
    case "scrollView":
      return .scrollView
    case "button":
      return .button
    case "staticText":
      return .staticText
    case "textField":
      return .textField
    case "secureTextField":
      return .secureTextField
    case "textView":
      return .textView
    case "switch":
      return .switch
    case "segmentedControl":
      return .segmentedControl
    case "table":
      return .table
    case "cell":
      return .cell
    case "collectionView":
      return .collectionView
    case "navigationBar":
      return .navigationBar
    default:
      return .any
    }
  }

  private func elementMatchesLocator(_ element: XCUIElement, locator: RunnerUIActionLocator) -> Bool {
    guard locator.kind == "semantic" else {
      return false
    }

    if let identifier = Self.normalizedText(locator.identifier), Self.normalizedText(element.identifier) != identifier {
      return false
    }

    if let label = Self.normalizedText(locator.label), Self.normalizedText(element.label) != label {
      return false
    }

    if let value = Self.normalizedText(locator.value), Self.normalizedValue(element.value) != value {
      return false
    }

    if let placeholder = Self.normalizedText(locator.placeholder), Self.normalizedText(element.placeholderValue) != placeholder {
      return false
    }

    if let interactive = locator.interactive, Self.isInteractiveElementType(element.elementType) != interactive {
      return false
    }

    return true
  }

  // PRB-091: the bounded scan ceiling for the query planner below. Every
  // bounded probe (`boundedMatchingElements`, and the section-token lookups
  // in `boundedSectionMatches`) walks a query strictly by index via
  // `element(boundBy:)` and stops the moment it has proven what it needs
  // (zero, one, more-than-one, or the requested ordinal) — this cap only
  // bounds the pathological case where a locator never resolves (e.g. an
  // `interactive` post-filter over a large non-matching subtree), so the
  // scan is provably bounded rather than an unbounded tree walk. It is sized
  // generously above the largest fixture-benchmarked interactive/matching
  // set observed in knowledge/xcuitest-runner (the `Large` AX-tree profile's
  // interactive-only view: 405 entries) so a legitimate ordinal request
  // against that scale still resolves within the cap.
  private static let uiActionBoundedScanCap = 512

  // PRB-091: reads a query strictly by index — never `.allElementsBoundByIndex`
  // — and stops as soon as it has gathered enough passing matches to answer
  // the question actually being asked: with no ordinal, 2 matches are
  // enough to prove "ambiguous" (the exact total beyond that is never
  // needed); with ordinal N, N matches are enough to return the Nth. This is
  // the "materializes only enough matches to distinguish zero, one, or many"
  // requirement — the planner never enumerates the full match set by
  // default.
  @MainActor
  private func boundedMatchingElements(
    query: XCUIElementQuery,
    ordinal: Int?,
    postFilter: (XCUIElement) -> Bool,
  ) -> [XCUIElement] {
    let neededCount = max(ordinal ?? 2, 2)
    var matches: [XCUIElement] = []

    for index in 0..<Self.uiActionBoundedScanCap {
      let candidate = query.element(boundBy: index)
      guard candidate.exists else {
        break
      }

      if postFilter(candidate) {
        matches.append(candidate)

        if matches.count >= neededCount {
          break
        }
      }
    }

    return matches
  }

  // PRB-091: identifier-first section resolution. A section token names a
  // container by accessibility identifier first — `matching(identifier:)`
  // is Apple's own typed identifier predicate, the narrowest public query
  // for a strong locator — and only falls back to a `label ==` predicate
  // when no identifier match exists. Both paths are bounded (never
  // `app.descendants(matching: .any).allElementsBoundByIndex`) and stop at
  // 2 matches, enough to know "unique" from "ambiguous" without enumerating
  // every element in the app. See knowledge/xcuitest-runner/integration-notes.md.
  @MainActor
  private func boundedSectionMatches(sectionToken: String, app: XCUIApplication) -> [XCUIElement] {
    let identifierMatches = boundedMatchingElements(
      query: app.descendants(matching: .any).matching(identifier: sectionToken),
      ordinal: nil,
      postFilter: { $0.exists }
    )

    if !identifierMatches.isEmpty {
      return identifierMatches
    }

    let labelPredicate = NSPredicate(format: "label == %@", sectionToken)
    return boundedMatchingElements(
      query: app.descendants(matching: .any).matching(labelPredicate),
      ordinal: nil,
      postFilter: { $0.exists }
    )
  }

  // PRB-091: the narrowest public XCUIElementQuery the locator supports.
  // Identifier goes through `matching(identifier:)` first (typed, and the
  // only form the knowledge pack certifies for a strong locator); label and
  // placeholder — plain String AX attributes — narrow further as a single
  // compound NSPredicate. `value` deliberately stays out of the predicate:
  // AX `value` is `Any?` (String, NSNumber, ...) and normalizedValue's
  // NSNumber → stringValue coercion has no faithful NSPredicate equivalent,
  // so it is checked only by the `elementMatchesLocator` post-filter over
  // the few candidates the bounded scan actually fetches — never by
  // widening the query itself.
  private func narrowedUIActionQuery(
    root: XCUIElement,
    type: XCUIElement.ElementType,
    locator: RunnerUIActionLocator,
  ) -> XCUIElementQuery {
    var query = root.descendants(matching: type)

    if let identifier = Self.normalizedText(locator.identifier) {
      query = query.matching(identifier: identifier)
    }

    var predicateFormats: [String] = []
    var predicateArgs: [Any] = []

    if let label = Self.normalizedText(locator.label) {
      predicateFormats.append("label == %@")
      predicateArgs.append(label)
    }

    if let placeholder = Self.normalizedText(locator.placeholder) {
      predicateFormats.append("placeholderValue == %@")
      predicateArgs.append(placeholder)
    }

    if !predicateFormats.isEmpty {
      query = query.matching(NSPredicate(format: predicateFormats.joined(separator: " AND "), argumentArray: predicateArgs))
    }

    return query
  }

  @MainActor
  private func matchingUIActionElements(
    locator: RunnerUIActionLocator,
    app: XCUIApplication,
  ) -> ResolvedUIActionCandidates {
    guard locator.kind == "semantic" else {
      return ResolvedUIActionCandidates(matches: [], sectionMatchCount: nil)
    }

    if locator.type == "application" {
      return ResolvedUIActionCandidates(
        matches: elementMatchesLocator(app, locator: locator) ? [app] : [],
        sectionMatchCount: nil
      )
    }

    let type = elementType(for: locator.type)
    let sectionToken = Self.normalizedText(locator.section)
    let sectionMatchCount: Int?
    let queryRoot: XCUIElement

    if let sectionToken {
      let sectionMatches = boundedSectionMatches(sectionToken: sectionToken, app: app)
      sectionMatchCount = sectionMatches.count
      queryRoot = sectionMatches.count == 1 ? sectionMatches[0] : app
    } else {
      sectionMatchCount = nil
      queryRoot = app
    }

    let query = narrowedUIActionQuery(root: queryRoot, type: type, locator: locator)
    let matches = boundedMatchingElements(
      query: query,
      ordinal: locator.ordinal,
      postFilter: { element in element.exists && elementMatchesLocator(element, locator: locator) }
    )

    return ResolvedUIActionCandidates(matches: matches, sectionMatchCount: sectionMatchCount)
  }

  @MainActor
  private func resolveUIActionElement(
    locator: RunnerUIActionLocator,
    app: XCUIApplication,
  ) throws -> XCUIElement {
    guard locator.kind == "semantic" else {
      throw actionError("Point locators do not resolve to accessibility elements.")
    }

    let resolved = matchingUIActionElements(locator: locator, app: app)
    // PRB-091: bounded to at most `max(ordinal, 2)` elements by
    // `boundedMatchingElements` — never the full match set. `matches.count`
    // below is exact whenever it is below that bound (the true zero/one/N
    // case), and pinned at the bound otherwise, which is exactly the
    // "ambiguous"/"at-least-ordinal" signal the branches below need.
    let matches = resolved.matches

    let sectionDetail: String = {
      guard let sectionMatchCount = resolved.sectionMatchCount, sectionMatchCount > 1 else {
        return ""
      }

      return " The section token matched more than one container, so the runner could not narrow the duplicate weak target further."
    }()

    if let ordinal = locator.ordinal {
      guard ordinal > 0 else {
        throw actionError("Semantic locator \(describeUIActionLocator(locator)) reported invalid ordinal \(ordinal).")
      }

      if matches.count >= ordinal {
        return matches[ordinal - 1]
      }

      throw actionError(
        "Semantic locator \(describeUIActionLocator(locator)) expected ordinal \(ordinal) but the runner's bounded scan found only \(matches.count) matching element(s).\(sectionDetail) Add stronger accessibility identifiers or unique labels to remove ambiguity."
      )
    }

    if matches.count == 1, let match = matches.first {
      return match
    }

    if matches.isEmpty {
      if let sectionMatchCount = resolved.sectionMatchCount, sectionMatchCount == 0, let section = Self.normalizedText(locator.section) {
        throw actionError("No element matched \(describeUIActionLocator(locator)) inside section \(section).")
      }

      throw actionError("No element matched \(describeUIActionLocator(locator)).")
    }

    throw actionError(
      "Semantic locator \(describeUIActionLocator(locator)) matched more than one element on the runner. Replay can recover ref drift only while the runner-side semantic locator stays unique.\(sectionDetail) Duplicate weak targets still need stronger accessibility identifiers or unique labels."
    )
  }

  private func clearTextIfNeeded(on element: XCUIElement, locator: RunnerUIActionLocator) {
    guard locator.kind == "semantic" else {
      return
    }

    let currentValue = Self.normalizedValue(element.value)
    let placeholder = Self.normalizedText(locator.placeholder)

    guard let currentValue, currentValue != placeholder else {
      return
    }

    let deleteSequence = String(repeating: XCUIKeyboardKey.delete.rawValue, count: currentValue.count)
    element.typeText(deleteSequence)
  }

  private func performDirectionalGesture(on element: XCUIElement, direction: String) throws {
    switch direction {
    case "up":
      element.swipeUp()
    case "down":
      element.swipeDown()
    case "left":
      element.swipeLeft()
    case "right":
      element.swipeRight()
    default:
      throw actionError("Unsupported direction \(direction).")
    }
  }

  private func performDirectionalGesture(on coordinate: XCUICoordinate, direction: String) throws {
    let offset: CGVector

    switch direction {
    case "up":
      offset = CGVector(dx: 0, dy: -160)
    case "down":
      offset = CGVector(dx: 0, dy: 160)
    case "left":
      offset = CGVector(dx: -160, dy: 0)
    case "right":
      offset = CGVector(dx: 160, dy: 0)
    default:
      throw actionError("Unsupported direction \(direction).")
    }

    coordinate.press(forDuration: 0.01, thenDragTo: coordinate.withOffset(offset))
  }

  // PRB-091: `uiAction`'s timing breakdown. `resolutionMs` is how long the
  // query planner took to turn a locator into a coordinate/element (zero AX
  // enumeration for a point locator, a bounded query for a semantic one);
  // `waitMs` is existence/hittability gating (always zero for a point
  // locator — there is nothing to wait on); `interactionMs` is the gesture
  // itself. Kept as three explicit timers rather than one `handledMs` blob
  // so a caller can tell "the query planner got slow" apart from "the tap
  // itself got slow" instead of guessing from one number.
  private struct RunnerUIActionOutcome {
    let summary: String
    let resolutionMs: Int
    let waitMs: Int
    let interactionMs: Int
  }

  @MainActor
  private func performRunnerUIAction(
    _ action: RunnerUIActionPayload,
    app: XCUIApplication,
  ) throws -> RunnerUIActionOutcome {
    if action.locator.kind == "point" {
      let resolutionStartedAt = Date()
      let target = try resolveUIActionCoordinate(locator: action.locator, app: app)
      let resolutionMs = milliseconds(since: resolutionStartedAt)
      let targetDescription = describeUIActionLocator(action.locator)

      func pointOutcome(_ summary: String, interactionStartedAt: Date) -> RunnerUIActionOutcome {
        RunnerUIActionOutcome(
          summary: summary,
          resolutionMs: resolutionMs,
          // A point locator resolves directly to a coordinate with no
          // existence/hittability gating to wait on — see the doc comment
          // above.
          waitMs: 0,
          interactionMs: milliseconds(since: interactionStartedAt)
        )
      }

      switch action.kind {
      case "tap":
        let interactionStartedAt = Date()
        target.tap()
        return pointOutcome("tapped \(targetDescription)", interactionStartedAt: interactionStartedAt)

      case "press":
        let durationMs = action.durationMs ?? 750
        try requireActionCondition(durationMs > 0, "Press duration must be positive.")
        let interactionStartedAt = Date()
        target.press(forDuration: Double(durationMs) / 1000.0)
        return pointOutcome("pressed \(targetDescription)", interactionStartedAt: interactionStartedAt)

      case "swipe":
        let interactionStartedAt = Date()
        try performDirectionalGesture(on: target, direction: action.direction ?? "")
        return pointOutcome("swiped \(action.direction ?? "unknown") on \(targetDescription)", interactionStartedAt: interactionStartedAt)

      case "type":
        let interactionStartedAt = Date()
        target.tap()
        if let text = action.text, !text.isEmpty {
          app.typeText(text)
        }
        return pointOutcome("typed into \(targetDescription)", interactionStartedAt: interactionStartedAt)

      case "scroll":
        let steps = action.steps ?? 1
        try requireActionCondition(steps > 0, "Scroll steps must be positive.")
        let interactionStartedAt = Date()
        for _ in 0..<steps {
          try performDirectionalGesture(on: target, direction: action.direction ?? "")
        }
        return pointOutcome(
          "scrolled \(action.direction ?? "unknown") on \(targetDescription) for \(steps) steps",
          interactionStartedAt: interactionStartedAt
        )

      default:
        throw actionError("Unsupported UI action \(action.kind).")
      }
    }

    let resolutionStartedAt = Date()
    let target = try resolveUIActionElement(locator: action.locator, app: app)
    let resolutionMs = milliseconds(since: resolutionStartedAt)
    let targetDescription = describeUIActionLocator(action.locator)

    func requireExistsAndHittable(_ waitDescription: String) throws -> Int {
      let waitStartedAt = Date()
      try requireActionCondition(target.waitForExistence(timeout: interactionTimeout), "Expected \(targetDescription) to exist before \(waitDescription).")
      try requireActionCondition(target.isHittable, "Expected \(targetDescription) to be hittable before \(waitDescription).")
      return milliseconds(since: waitStartedAt)
    }

    func requireExists(_ waitDescription: String) throws -> Int {
      let waitStartedAt = Date()
      try requireActionCondition(target.waitForExistence(timeout: interactionTimeout), "Expected \(targetDescription) to exist before \(waitDescription).")
      return milliseconds(since: waitStartedAt)
    }

    switch action.kind {
    case "tap":
      let waitMs = try requireExistsAndHittable("tap")
      let interactionStartedAt = Date()
      target.tap()
      return RunnerUIActionOutcome(summary: "tapped \(targetDescription)", resolutionMs: resolutionMs, waitMs: waitMs, interactionMs: milliseconds(since: interactionStartedAt))

    case "press":
      let durationMs = action.durationMs ?? 750
      try requireActionCondition(durationMs > 0, "Press duration must be positive.")
      let waitMs = try requireExistsAndHittable("press")
      let interactionStartedAt = Date()
      target.press(forDuration: Double(durationMs) / 1000.0)
      return RunnerUIActionOutcome(summary: "pressed \(targetDescription)", resolutionMs: resolutionMs, waitMs: waitMs, interactionMs: milliseconds(since: interactionStartedAt))

    case "swipe":
      let waitMs = try requireExists("swipe")
      let interactionStartedAt = Date()
      try performDirectionalGesture(on: target, direction: action.direction ?? "")
      return RunnerUIActionOutcome(summary: "swiped \(action.direction ?? "unknown") on \(targetDescription)", resolutionMs: resolutionMs, waitMs: waitMs, interactionMs: milliseconds(since: interactionStartedAt))

    case "type":
      let waitMs = try requireExistsAndHittable("typing")
      let interactionStartedAt = Date()
      target.tap()
      if action.replace ?? true {
        clearTextIfNeeded(on: target, locator: action.locator)
      }
      if let text = action.text, !text.isEmpty {
        target.typeText(text)
      }
      return RunnerUIActionOutcome(summary: "typed into \(targetDescription)", resolutionMs: resolutionMs, waitMs: waitMs, interactionMs: milliseconds(since: interactionStartedAt))

    case "scroll":
      let steps = action.steps ?? 1
      try requireActionCondition(steps > 0, "Scroll steps must be positive.")
      let waitMs = try requireExists("scrolling")
      let interactionStartedAt = Date()
      for _ in 0..<steps {
        try performDirectionalGesture(on: target, direction: action.direction ?? "")
      }
      return RunnerUIActionOutcome(
        summary: "scrolled \(action.direction ?? "unknown") on \(targetDescription) for \(steps) steps",
        resolutionMs: resolutionMs,
        waitMs: waitMs,
        interactionMs: milliseconds(since: interactionStartedAt)
      )

    default:
      throw actionError("Unsupported UI action \(action.kind).")
    }
  }

  // PRB-091: generic (non-fixture) status text for response finalization.
  // The runner used to probe three ProbeFixture-only static-text
  // identifiers (`fixture.status.label`, `fixture.detail.label`,
  // `fixture.detail.summaryLabel`) on *every* response, for *every* target
  // app — three extra AX existence queries per command that only ever
  // resolved to anything on ProbeFixture itself, and did nothing but add
  // latency for every other app. `app.label` is already-resolved attribute
  // data on the `app` handle the caller already holds, not a fresh query,
  // so this reads as zero additional AX enumeration. Fixture-specific
  // status assertions (the `fixture.status.label` waits in `applyInput` and
  // the attach helpers, and the direct `staticTexts["fixture.status.label"]`
  // lookups in the test methods below) are unaffected — they are already
  // test-only and stay that way.
  @MainActor
  private static func genericResponseStatusLabel(app: XCUIApplication) -> String {
    app.label.isEmpty ? "<status-unavailable>" : app.label
  }

  @MainActor
  private func handleLifecycleCommand(
    _ command: LifecycleCommandFrame,
    app: XCUIApplication,
    statusLabel: XCUIElement,
    controlDirectoryURL: URL,
  ) throws -> LifecycleCommandResult {
    switch command.action {
    case "ping":
      let pingPayload = command.payload ?? ""
      return LifecycleCommandResult(
        inlinePayload: nil,
        inlinePayloadEncoding: nil,
        payload: "pong:\(pingPayload)",
        snapshotPayloadPath: nil,
        snapshotNodeCount: nil
      )

    case "applyInput":
      let resetButton = app.buttons["Reset"]
      let inputField = app.textFields["fixture.form.input"]
      let applyButton = app.buttons["fixture.form.applyButton"]
      let requestedInput = command.payload ?? ""
      let trimmedInput = requestedInput.trimmingCharacters(in: .whitespacesAndNewlines)
      let expectedValue = trimmedInput.isEmpty ? "<empty>" : trimmedInput

      XCTAssertTrue(resetButton.waitForExistence(timeout: interactionTimeout))
      resetButton.tap()
      XCTAssertTrue(
        waitForLabel(statusLabel, toEqual: "Ready for attach/control validation", timeout: interactionTimeout),
        "Expected reset before applyInput to restore the ready state."
      )

      XCTAssertTrue(inputField.waitForExistence(timeout: interactionTimeout))
      inputField.tap()
      if !requestedInput.isEmpty {
        inputField.typeText(requestedInput)
      }

      XCTAssertTrue(applyButton.waitForExistence(timeout: interactionTimeout))
      applyButton.tap()
      XCTAssertTrue(
        waitForLabel(statusLabel, toEqual: "Input applied: \(expectedValue)", timeout: interactionTimeout),
        "Expected applyInput to update the fixture status label."
      )

      return LifecycleCommandResult(
        inlinePayload: nil,
        inlinePayloadEncoding: nil,
        payload: statusLabel.label,
        snapshotPayloadPath: nil,
        snapshotNodeCount: nil
      )

    case "snapshot":
      let snapshot = try app.snapshot()
      let rawNodeCount = Self.snapshotNodeCount(in: snapshot.dictionaryRepresentation)
      let compactRoot = Self.buildRunnerSnapshotNode(from: snapshot)
      let compactNodeCount = Self.snapshotNodeCount(in: compactRoot)
      let interactiveNodeCount = Self.interactiveNodeCount(in: compactRoot)
      let payload = RunnerSnapshotPayload(
        capturedAt: Self.iso8601Formatter.string(from: Date()),
        statusLabel: Self.genericResponseStatusLabel(app: app),
        metrics: RunnerSnapshotMetrics(
          rawNodeCount: rawNodeCount,
          prunedNodeCount: compactNodeCount,
          interactiveNodeCount: interactiveNodeCount
        ),
        root: compactRoot
      )
      let payloadURL = lifecycleSnapshotPayloadURL(in: controlDirectoryURL, sequence: command.sequence)
      let payloadData = try JSONEncoder().encode(payload)
      try payloadData.write(to: payloadURL, options: .atomic)
      return LifecycleCommandResult(
        inlinePayload: String(decoding: payloadData, as: UTF8.self),
        inlinePayloadEncoding: "utf8",
        payload: "snapshot-captured",
        snapshotPayloadPath: payloadURL.path,
        snapshotNodeCount: compactNodeCount
      )

    case "screenshot":
      let screenshot = XCUIScreen.main.screenshot()
      let pngData = screenshot.pngRepresentation
      let payloadURL = lifecycleScreenshotPayloadURL(in: controlDirectoryURL, sequence: command.sequence)
      try pngData.write(to: payloadURL, options: .atomic)
      return LifecycleCommandResult(
        inlinePayload: pngData.base64EncodedString(),
        inlinePayloadEncoding: "base64",
        payload: "screenshot-captured",
        snapshotPayloadPath: payloadURL.path,
        snapshotNodeCount: nil
      )

    case "recordVideo":
      let requestedDurationMs = Int(command.payload ?? "") ?? defaultVideoDurationMs
      let durationMs = min(max(requestedDurationMs, 1), maxVideoDurationMs)
      let fps = Int((1 / videoFrameInterval).rounded())
      let framesDirectoryURL = lifecycleVideoFramesDirectoryURL(
        in: controlDirectoryURL,
        sequence: command.sequence
      )

      try FileManager.default.createDirectory(
        at: framesDirectoryURL,
        withIntermediateDirectories: true
      )

      let captureDeadline = Date().addingTimeInterval(TimeInterval(durationMs) / 1000)
      var frameIndex = 0

      while frameIndex == 0 || Date() < captureDeadline {
        let screenshot = XCUIScreen.main.screenshot()
        let frameURL = framesDirectoryURL.appendingPathComponent(
          String(format: "frame-%05d.png", frameIndex)
        )
        try screenshot.pngRepresentation.write(to: frameURL, options: .atomic)
        frameIndex += 1

        if Date() < captureDeadline {
          RunLoop.current.run(until: Date().addingTimeInterval(videoFrameInterval))
        }
      }

      let manifest = LifecycleVideoCaptureManifest(
        durationMs: durationMs,
        fps: fps,
        frameCount: frameIndex,
        framesDirectoryPath: framesDirectoryURL.path
      )
      try writeJSON(manifest, to: framesDirectoryURL.appendingPathComponent("manifest.json"))

      return LifecycleCommandResult(
        inlinePayload: nil,
        inlinePayloadEncoding: nil,
        payload: "video-captured",
        snapshotPayloadPath: framesDirectoryURL.path,
        snapshotNodeCount: nil
      )

    case "uiAction":
      let payloadData = Data((command.payload ?? "{}").utf8)
      let actionPayload = try JSONDecoder().decode(RunnerUIActionPayload.self, from: payloadData)
      let outcome = try performRunnerUIAction(actionPayload, app: app)
      return LifecycleCommandResult(
        inlinePayload: nil,
        inlinePayloadEncoding: nil,
        payload: outcome.summary,
        snapshotPayloadPath: nil,
        snapshotNodeCount: nil,
        resolutionMs: outcome.resolutionMs,
        waitMs: outcome.waitMs,
        interactionMs: outcome.interactionMs
      )

    case "shutdown":
      return LifecycleCommandResult(
        inlinePayload: nil,
        inlinePayloadEncoding: nil,
        payload: "shutdown-ack",
        snapshotPayloadPath: nil,
        snapshotNodeCount: nil
      )

    default:
      throw NSError(
        domain: "ProbeRunnerLifecycle",
        code: 1,
        userInfo: [NSLocalizedDescriptionKey: "Unsupported lifecycle action: \(command.action)"]
      )
    }
  }

  private func lifecycleSnapshotPayloadURL(in controlDirectoryURL: URL, sequence: Int) -> URL {
    controlDirectoryURL.appendingPathComponent(String(format: "snapshot-%03d.json", sequence))
  }

  private func lifecycleScreenshotPayloadURL(in controlDirectoryURL: URL, sequence: Int) -> URL {
    controlDirectoryURL.appendingPathComponent(String(format: "screenshot-%03d.png", sequence))
  }

  private func lifecycleVideoFramesDirectoryURL(in controlDirectoryURL: URL, sequence: Int) -> URL {
    controlDirectoryURL.appendingPathComponent(String(format: "video-frames-%03d", sequence))
  }

  private func writeJSON<T: Encodable>(_ value: T, to url: URL) throws {
    let data = try JSONEncoder().encode(value)
    try data.write(to: url, options: .atomic)
  }

  private func milliseconds(since startedAt: Date) -> Int {
    Int(Date().timeIntervalSince(startedAt) * 1000)
  }

  private static let iso8601Formatter: ISO8601DateFormatter = {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return formatter
  }()

  private static func snapshotTree(_ value: Any, containsIdentifier identifier: String) -> Bool {
    if let dictionary = value as? [String: Any] {
      if dictionary["identifier"] as? String == identifier {
        return true
      }

      return dictionary.values.contains { snapshotTree($0, containsIdentifier: identifier) }
    }

    if let dictionary = value as? NSDictionary {
      if dictionary["identifier"] as? String == identifier {
        return true
      }

      return dictionary.allValues.contains { snapshotTree($0, containsIdentifier: identifier) }
    }

    if let array = value as? [Any] {
      return array.contains { snapshotTree($0, containsIdentifier: identifier) }
    }

    if let array = value as? NSArray {
      return array.contains { snapshotTree($0, containsIdentifier: identifier) }
    }

    return false
  }

  private static func snapshotNodeCount(in value: Any) -> Int {
    if let dictionary = value as? [String: Any] {
      let childCount = dictionary.values.reduce(0) { partial, child in
        partial + snapshotNodeCount(in: child)
      }

      return 1 + childCount
    }

    if let dictionary = value as? NSDictionary {
      let childCount = dictionary.allValues.reduce(0) { partial, child in
        partial + snapshotNodeCount(in: child)
      }

      return 1 + childCount
    }

    if let array = value as? [Any] {
      return array.reduce(0) { partial, child in
        partial + snapshotNodeCount(in: child)
      }
    }

    if let array = value as? NSArray {
      return array.reduce(0) { partial, child in
        partial + snapshotNodeCount(in: child)
      }
    }

    return 0
  }

  private static func stateName(for state: XCUIApplication.State) -> String {
    switch state {
    case .unknown:
      return "unknown"
    case .notRunning:
      return "notRunning"
    case .runningBackgroundSuspended:
      return "runningBackgroundSuspended"
    case .runningBackground:
      return "runningBackground"
    case .runningForeground:
      return "runningForeground"
    @unknown default:
      return "unknownFutureState"
    }
  }
}
