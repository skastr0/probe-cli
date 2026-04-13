import Darwin
import Foundation
import Network
import XCTest

final class AttachControlSpikeUITests: XCTestCase {
  private let attachTimeout: TimeInterval = 10
  private let interactionTimeout: TimeInterval = 5
  private let lifecycleCommandTimeout: TimeInterval = 20
  private let defaultVideoDurationMs = 10_000
  private let maxVideoDurationMs = 120_000
  private let videoFrameInterval: TimeInterval = 0.1
  private let stdinProbeTimeout: TimeInterval = 5
  private let runnerBootstrapRootPath = "/tmp/probe-runner-bootstrap"
  private let runnerTransportContract = "probe.runner.transport/hybrid-v1"

  private struct LifecycleReadyFrame: Codable {
    let kind: String
    let attachLatencyMs: Int
    let bootstrapPath: String
    let bootstrapSource: String
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
  }

  private struct LifecycleCommandFrame: Codable {
    let action: String
    let payload: String?
    let sequence: Int
  }

  private struct LifecycleResponseFrame: Codable {
    let action: String
    let error: String?
    let handledMs: Int
    let kind: String
    let ok: Bool
    let payload: String?
    let snapshotPayloadPath: String?
    let recordedAt: String
    let sequence: Int
    let snapshotNodeCount: Int?
    let statusLabel: String
  }

  private struct LifecycleCommandResult {
    let payload: String?
    let snapshotPayloadPath: String?
    let snapshotNodeCount: Int?
  }

  private struct LifecycleVideoCaptureManifest: Codable {
    let durationMs: Int
    let fps: Int
    let frameCount: Int
    let framesDirectoryPath: String
  }

  private struct RunnerUIActionLocator: Codable {
    let identifier: String?
    let label: String?
    let value: String?
    let placeholder: String?
    let type: String?
    let section: String?
    let interactive: Bool?
    let ordinal: Int?
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

  private struct StdinProbeCommandFrame: Codable {
    let kind: String
    let payload: String?
  }

  private struct StdinProbeResultFrame: Codable {
    let kind: String
    let status: String
    let payload: String?
    let error: String?
    let recordedAt: String
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
    let controlDirectoryURL = URL(
      fileURLWithPath: resolvedControlDirectory.controlDirectoryPath,
      isDirectory: true,
    )
    try FileManager.default.createDirectory(at: controlDirectoryURL, withIntermediateDirectories: true)

    let lifecycleState = try attachForLifecycleLoop(
      resolvedControlDirectory: resolvedControlDirectory,
      controlDirectoryURL: controlDirectoryURL,
      foregroundFailureMessage: "Fixture app must already be running in the foreground before ProbeRunner enters its lifecycle loop.",
      statusLabelFailureMessage: "Expected fixture status label to exist before the lifecycle loop starts."
    )

    try emitStdoutJSONLine(lifecycleState.readyFrame)

    print(
      "PROBE_METRIC lifecycle_ready attach_latency_ms=\(lifecycleState.readyFrame.attachLatencyMs) control_dir=\(controlDirectoryURL.path) pid=\(lifecycleState.readyFrame.processIdentifier)"
    )

    try runLifecycleCommandLoop(
      controlDirectoryURL: controlDirectoryURL,
      app: lifecycleState.app,
      statusLabel: lifecycleState.statusLabel
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

    if isDevice {
      let httpCommandServer = try startHTTPCommandServer(
        desiredPort: resolveRunnerPortFromEnvironment(),
        controlDirectoryURL: controlDirectoryURL,
        app: lifecycleState.app,
        statusLabel: lifecycleState.statusLabel
      )
      lifecycleState.readyFrame.runnerPort = httpCommandServer.port

      try emitStdoutJSONLine(lifecycleState.readyFrame)

      print(
        "PROBE_METRIC transport_boundary_ready attach_latency_ms=\(lifecycleState.readyFrame.attachLatencyMs) control_dir=\(controlDirectoryURL.path) pid=\(lifecycleState.readyFrame.processIdentifier) runner_port=\(httpCommandServer.port)"
      )

      try httpCommandServer.waitForShutdown()
      return
    }

    try emitStdoutJSONLine(lifecycleState.readyFrame)

    print(
      "PROBE_METRIC transport_boundary_ready attach_latency_ms=\(lifecycleState.readyFrame.attachLatencyMs) control_dir=\(controlDirectoryURL.path) pid=\(lifecycleState.readyFrame.processIdentifier)"
    )

    let stdinProbeResult = probeStdinJSONL(timeout: stdinProbeTimeout)
    try emitStdoutJSONLine(stdinProbeResult)

    print(
      "PROBE_METRIC transport_boundary_stdin_probe status=\(stdinProbeResult.status) payload=\(stdinProbeResult.payload ?? "<nil>") error=\(stdinProbeResult.error ?? "<nil>")"
    )

    try runLifecycleCommandLoop(
      controlDirectoryURL: controlDirectoryURL,
      app: lifecycleState.app,
      statusLabel: lifecycleState.statusLabel
    )
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
    let statusLabelExists = statusLabel.waitForExistence(timeout: interactionTimeout)

    if isFixtureApp {
      XCTAssertTrue(statusLabelExists, statusLabelFailureMessage)
    }

    let readyFrame = LifecycleReadyFrame(
      kind: "ready",
      attachLatencyMs: attachLatencyMs,
      bootstrapPath: resolvedControlDirectory.bootstrapPath,
      bootstrapSource: resolvedControlDirectory.bootstrapSource.rawValue,
      controlDirectoryPath: controlDirectoryURL.path,
      currentDirectoryPath: FileManager.default.currentDirectoryPath,
      egressTransport: resolvedControlDirectory.config.egressTransport,
      homeDirectoryPath: NSHomeDirectory(),
      ingressTransport: resolvedControlDirectory.bootstrapSource == .deviceBootstrapManifest
        ? "http-post"
        : resolvedControlDirectory.config.ingressTransport,
      initialStatusLabel: statusLabelExists ? statusLabel.label : "",
      processIdentifier: ProcessInfo.processInfo.processIdentifier,
      recordedAt: Self.iso8601Formatter.string(from: Date()),
      runnerPort: nil,
      runnerTransportContract: resolvedControlDirectory.config.contractVersion,
      sessionIdentifier: resolvedControlDirectory.config.sessionIdentifier,
      simulatorUdid: resolvedControlDirectory.config.simulatorUdid
    )

    // Keep file mirrors for lifecycle/transport validation scripts; the runtime consumes stdout as canonical egress.
    // On real device the sandbox may prevent writes, so tolerate failure.
    try? writeJSON(readyFrame, to: controlDirectoryURL.appendingPathComponent("ready.json"))

    return LifecycleLoopState(app: app, readyFrame: readyFrame, statusLabel: statusLabel)
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

    guard bootstrapConfig.ingressTransport == "file-mailbox" else {
      throw lifecycleBootstrapError(
        "Bootstrap manifest \(expectedBootstrapPath) declared ingress \(bootstrapConfig.ingressTransport), expected file-mailbox."
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

  @MainActor
  private func runLifecycleCommandLoop(
    controlDirectoryURL: URL,
    app: XCUIApplication,
    statusLabel: XCUIElement,
  ) throws {
    var expectedSequence = 1
    var handledCommands = 0

    while true {
      let commandURL = lifecycleCommandURL(in: controlDirectoryURL, sequence: expectedSequence)
      guard let command = try waitForLifecycleCommand(at: commandURL, timeout: lifecycleCommandTimeout) else {
        XCTFail("Timed out waiting for lifecycle command #\(expectedSequence) at \(commandURL.path).")
        return
      }

      let commandStartedAt = Date()
      let responseFrame = executeLifecycleCommandFrame(
        command,
        startedAt: commandStartedAt,
        app: app,
        statusLabel: statusLabel,
        controlDirectoryURL: controlDirectoryURL
      )

      // Keep file mirrors for lifecycle/transport validation scripts; the runtime consumes stdout as canonical egress.
      try writeJSON(
        responseFrame,
        to: lifecycleResponseURL(in: controlDirectoryURL, sequence: expectedSequence)
      )

      try emitStdoutJSONLine(responseFrame)

      print(
        "PROBE_METRIC lifecycle_response sequence=\(responseFrame.sequence) action=\(responseFrame.action) ok=\(responseFrame.ok) handled_ms=\(responseFrame.handledMs) snapshot_nodes=\(responseFrame.snapshotNodeCount ?? -1)"
      )

      handledCommands += 1
      expectedSequence += 1

      if !responseFrame.ok {
        let failureMessage = responseFrame.error ?? "unknown error"
        XCTFail("Lifecycle command #\(responseFrame.sequence) failed: \(failureMessage)")
        return
      }

      if command.action == "shutdown" {
        print("PROBE_METRIC lifecycle_shutdown handled_commands=\(handledCommands)")
        return
      }
    }
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
  ) -> LifecycleResponseFrame {
    do {
      let result = try handleLifecycleCommand(
        command,
        app: app,
        statusLabel: statusLabel,
        controlDirectoryURL: controlDirectoryURL
      )
      return LifecycleResponseFrame(
        action: command.action,
        error: nil,
        handledMs: milliseconds(since: startedAt),
        kind: "response",
        ok: true,
        payload: result.payload,
        snapshotPayloadPath: result.snapshotPayloadPath,
        recordedAt: Self.iso8601Formatter.string(from: Date()),
        sequence: command.sequence,
        snapshotNodeCount: result.snapshotNodeCount,
        statusLabel: currentStatusLabelText(app: app)
      )
    } catch {
      return LifecycleResponseFrame(
        action: command.action,
        error: String(describing: error),
        handledMs: milliseconds(since: startedAt),
        kind: "response",
        ok: false,
        payload: nil,
        snapshotPayloadPath: nil,
        recordedAt: Self.iso8601Formatter.string(from: Date()),
        sequence: command.sequence,
        snapshotNodeCount: nil,
        statusLabel: currentStatusLabelText(app: app)
      )
    }
  }

  @MainActor
  private func startHTTPCommandServer(
    desiredPort: Int,
    controlDirectoryURL: URL,
    app: XCUIApplication,
    statusLabel: XCUIElement,
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
        onShutdown: {
          listener.cancel()
          finishLoopIfNeeded()
        }
      )
    }

    listener.start(queue: queue)

    guard startupSemaphore.wait(timeout: .now() + 10) == .success else {
      listener.cancel()
      throw lifecycleBootstrapError("The real-device HTTP command listener did not become ready before the timeout.")
    }

    if let startupError {
      listener.cancel()
      throw startupError
    }

    guard let actualPort else {
      listener.cancel()
      throw lifecycleBootstrapError("The real-device HTTP command listener did not report a bound port.")
    }

    return HTTPCommandServer(
      port: actualPort,
      waitForShutdown: {
        let waitResult = XCTWaiter.wait(for: [doneExpectation], timeout: 24 * 60 * 60)
        listener.cancel()

        if waitResult != .completed {
          throw self.lifecycleBootstrapError("The real-device HTTP command listener ended with \(waitResult).")
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
      guard let body = self.parseHTTPRequestBody(from: combined) else {
        self.receiveHTTPRequest(
          on: connection,
          buffer: combined,
          controlDirectoryURL: controlDirectoryURL,
          app: app,
          statusLabel: statusLabel,
          onShutdown: onShutdown,
        )
        return
      }

      Task { @MainActor in
        let response = self.handleHTTPRequestBody(
          body,
          controlDirectoryURL: controlDirectoryURL,
          app: app,
          statusLabel: statusLabel,
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
  private func handleHTTPRequestBody(
    _ body: Data,
    controlDirectoryURL: URL,
    app: XCUIApplication,
    statusLabel: XCUIElement,
  ) -> (data: Data, shouldShutdown: Bool) {
    do {
      let command = try JSONDecoder().decode(LifecycleCommandFrame.self, from: body)
      let responseFrame = executeLifecycleCommandFrame(
        command,
        startedAt: Date(),
        app: app,
        statusLabel: statusLabel,
        controlDirectoryURL: controlDirectoryURL,
      )
      return (
        try encodeHTTPJSONResponse(status: 200, value: responseFrame),
        command.action == "shutdown"
      )
    } catch {
      return (
        (try? encodeHTTPJSONResponse(status: 400, value: ["error": String(describing: error)]))
          ?? Data("HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".utf8),
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

  private func parseHTTPRequestBody(from data: Data) -> Data? {
    guard let headerEnd = data.range(of: Data("\r\n\r\n".utf8)) else {
      return nil
    }

    let headerData = data.subdata(in: 0..<headerEnd.lowerBound)
    let bodyStart = headerEnd.upperBound
    let headers = String(decoding: headerData, as: UTF8.self)

    guard let contentLength = extractHTTPContentLength(from: headers) else {
      return nil
    }

    guard data.count >= bodyStart + contentLength else {
      return nil
    }

    return data.subdata(in: bodyStart..<(bodyStart + contentLength))
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
    let headers = [
      "HTTP/1.1 \(status) OK",
      "Content-Type: application/json",
      "Content-Length: \(body.count)",
      "Connection: close",
      "",
      "",
    ].joined(separator: "\r\n")

    var response = Data(headers.utf8)
    response.append(body)
    return response
  }

  private func emitStdoutJSONLine<T: Encodable>(_ value: T) throws {
    let data = try JSONEncoder().encode(value)
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data([0x0A]))
  }

  private func probeStdinJSONL(timeout: TimeInterval) -> StdinProbeResultFrame {
    let duplicatedStdin = dup(STDIN_FILENO)

    guard duplicatedStdin >= 0 else {
      return StdinProbeResultFrame(
        kind: "stdin-probe-result",
        status: "dup-failed",
        payload: nil,
        error: String(cString: strerror(errno)),
        recordedAt: Self.iso8601Formatter.string(from: Date())
      )
    }

    defer {
      close(duplicatedStdin)
    }

    let originalFlags = fcntl(duplicatedStdin, F_GETFL)

    if originalFlags >= 0 {
      _ = fcntl(duplicatedStdin, F_SETFL, originalFlags | O_NONBLOCK)
    }

    defer {
      if originalFlags >= 0 {
        _ = fcntl(duplicatedStdin, F_SETFL, originalFlags)
      }
    }

    let deadline = Date().addingTimeInterval(timeout)
    var buffer = Data()

    while Date() < deadline {
      var descriptor = pollfd(
        fd: duplicatedStdin,
        events: Int16(POLLIN | POLLERR | POLLHUP),
        revents: 0
      )

      let pollResult = withUnsafeMutablePointer(to: &descriptor) { pointer in
        poll(pointer, 1, 100)
      }

      if pollResult < 0 {
        if errno == EINTR {
          continue
        }

        return StdinProbeResultFrame(
          kind: "stdin-probe-result",
          status: "poll-failed",
          payload: nil,
          error: String(cString: strerror(errno)),
          recordedAt: Self.iso8601Formatter.string(from: Date())
        )
      }

      if pollResult == 0 {
        continue
      }

      if (descriptor.revents & Int16(POLLERR)) != 0 {
        return StdinProbeResultFrame(
          kind: "stdin-probe-result",
          status: "poll-error",
          payload: nil,
          error: "POLLERR",
          recordedAt: Self.iso8601Formatter.string(from: Date())
        )
      }

      if (descriptor.revents & Int16(POLLHUP)) != 0 && (descriptor.revents & Int16(POLLIN)) == 0 {
        return StdinProbeResultFrame(
          kind: "stdin-probe-result",
          status: "eof",
          payload: nil,
          error: nil,
          recordedAt: Self.iso8601Formatter.string(from: Date())
        )
      }

      if (descriptor.revents & Int16(POLLIN)) != 0 {
        var chunk = [UInt8](repeating: 0, count: 4096)
        let readCount = read(duplicatedStdin, &chunk, chunk.count)

        if readCount == 0 {
          return StdinProbeResultFrame(
            kind: "stdin-probe-result",
            status: "eof",
            payload: nil,
            error: nil,
            recordedAt: Self.iso8601Formatter.string(from: Date())
          )
        }

        if readCount < 0 {
          if errno == EAGAIN || errno == EWOULDBLOCK || errno == EINTR {
            continue
          }

          return StdinProbeResultFrame(
            kind: "stdin-probe-result",
            status: "read-failed",
            payload: nil,
            error: String(cString: strerror(errno)),
            recordedAt: Self.iso8601Formatter.string(from: Date())
          )
        }

        buffer.append(contentsOf: chunk.prefix(readCount))

        if let newlineIndex = buffer.firstIndex(of: 0x0A) {
          let lineData = Data(buffer.prefix(upTo: newlineIndex))

          guard let line = String(data: lineData, encoding: .utf8) else {
            return StdinProbeResultFrame(
              kind: "stdin-probe-result",
              status: "invalid-utf8",
              payload: nil,
              error: nil,
              recordedAt: Self.iso8601Formatter.string(from: Date())
            )
          }

          do {
            let command = try JSONDecoder().decode(StdinProbeCommandFrame.self, from: lineData)

            guard command.kind == "stdin-probe" else {
              return StdinProbeResultFrame(
                kind: "stdin-probe-result",
                status: "unexpected-kind",
                payload: line,
                error: command.kind,
                recordedAt: Self.iso8601Formatter.string(from: Date())
              )
            }

            return StdinProbeResultFrame(
              kind: "stdin-probe-result",
              status: "received",
              payload: command.payload,
              error: nil,
              recordedAt: Self.iso8601Formatter.string(from: Date())
            )
          } catch {
            return StdinProbeResultFrame(
              kind: "stdin-probe-result",
              status: "invalid-json",
              payload: line,
              error: String(describing: error),
              recordedAt: Self.iso8601Formatter.string(from: Date())
            )
          }
        }
      }
    }

    return StdinProbeResultFrame(
      kind: "stdin-probe-result",
      status: "timeout",
      payload: nil,
      error: nil,
      recordedAt: Self.iso8601Formatter.string(from: Date())
    )
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

  private func elementMatchesSectionToken(_ element: XCUIElement, token: String) -> Bool {
    Self.normalizedText(element.identifier) == token || Self.normalizedText(element.label) == token
  }

  @MainActor
  private func matchingUIActionElements(
    locator: RunnerUIActionLocator,
    app: XCUIApplication,
  ) -> ResolvedUIActionCandidates {
    if locator.type == "application" {
      return ResolvedUIActionCandidates(
        matches: elementMatchesLocator(app, locator: locator) ? [app] : [],
        sectionMatchCount: nil
      )
    }

    let type = elementType(for: locator.type)
    let sectionToken = Self.normalizedText(locator.section)
    let sectionMatches: [XCUIElement]

    if let sectionToken {
      sectionMatches = app.descendants(matching: .any).allElementsBoundByIndex.filter { element in
        element.exists && elementMatchesSectionToken(element, token: sectionToken)
      }
    } else {
      sectionMatches = []
    }

    let queryRoot = sectionMatches.count == 1 ? sectionMatches[0] : app
    let query = queryRoot.descendants(matching: type)
    let candidates: [XCUIElement]

    if let identifier = Self.normalizedText(locator.identifier) {
      candidates = query.matching(identifier: identifier).allElementsBoundByIndex
    } else {
      candidates = query.allElementsBoundByIndex
    }

    return ResolvedUIActionCandidates(
      matches: candidates.filter { element in
        element.exists && elementMatchesLocator(element, locator: locator)
      },
      sectionMatchCount: sectionToken == nil ? nil : sectionMatches.count
    )
  }

  @MainActor
  private func resolveUIActionElement(
    locator: RunnerUIActionLocator,
    app: XCUIApplication,
  ) throws -> XCUIElement {
    let resolved = matchingUIActionElements(locator: locator, app: app)
    let matches = resolved.matches

    let sectionDetail: String = {
      guard let sectionMatchCount = resolved.sectionMatchCount, sectionMatchCount > 1 else {
        return ""
      }

      return " The section token matched \(sectionMatchCount) containers, so the runner could not narrow the duplicate weak target further."
    }()

    if let ordinal = locator.ordinal {
      guard ordinal > 0 else {
        throw actionError("Semantic locator \(describeUIActionLocator(locator)) reported invalid ordinal \(ordinal).")
      }

      if matches.count >= ordinal {
        return matches[ordinal - 1]
      }

      throw actionError(
        "Semantic locator \(describeUIActionLocator(locator)) expected ordinal \(ordinal) but runner found only \(matches.count) matches.\(sectionDetail) Add stronger accessibility identifiers or unique labels to remove ambiguity."
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
      "Semantic locator \(describeUIActionLocator(locator)) matched \(matches.count) elements on the runner. Replay can recover ref drift only while the runner-side semantic locator stays unique.\(sectionDetail) Duplicate weak targets still need stronger accessibility identifiers or unique labels."
    )
  }

  private func clearTextIfNeeded(on element: XCUIElement, locator: RunnerUIActionLocator) {
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

  @MainActor
  private func performRunnerUIAction(
    _ action: RunnerUIActionPayload,
    app: XCUIApplication,
  ) throws -> String {
    let target = try resolveUIActionElement(locator: action.locator, app: app)
    let targetDescription = describeUIActionLocator(action.locator)

    switch action.kind {
    case "tap":
      try requireActionCondition(target.waitForExistence(timeout: interactionTimeout), "Expected \(targetDescription) to exist before tap.")
      try requireActionCondition(target.isHittable, "Expected \(targetDescription) to be hittable before tap.")
      target.tap()
      return "tapped \(targetDescription)"

    case "press":
      let durationMs = action.durationMs ?? 750
      try requireActionCondition(durationMs > 0, "Press duration must be positive.")
      try requireActionCondition(target.waitForExistence(timeout: interactionTimeout), "Expected \(targetDescription) to exist before press.")
      try requireActionCondition(target.isHittable, "Expected \(targetDescription) to be hittable before press.")
      target.press(forDuration: Double(durationMs) / 1000.0)
      return "pressed \(targetDescription)"

    case "swipe":
      try requireActionCondition(target.waitForExistence(timeout: interactionTimeout), "Expected \(targetDescription) to exist before swipe.")
      try performDirectionalGesture(on: target, direction: action.direction ?? "")
      return "swiped \(action.direction ?? "unknown") on \(targetDescription)"

    case "type":
      try requireActionCondition(target.waitForExistence(timeout: interactionTimeout), "Expected \(targetDescription) to exist before typing.")
      try requireActionCondition(target.isHittable, "Expected \(targetDescription) to be hittable before typing.")
      target.tap()
      if action.replace ?? true {
        clearTextIfNeeded(on: target, locator: action.locator)
      }
      if let text = action.text, !text.isEmpty {
        target.typeText(text)
      }
      return "typed into \(targetDescription)"

    case "scroll":
      let steps = action.steps ?? 1
      try requireActionCondition(steps > 0, "Scroll steps must be positive.")
      try requireActionCondition(target.waitForExistence(timeout: interactionTimeout), "Expected \(targetDescription) to exist before scrolling.")
      for _ in 0..<steps {
        try performDirectionalGesture(on: target, direction: action.direction ?? "")
      }
      return "scrolled \(action.direction ?? "unknown") on \(targetDescription) for \(steps) steps"

    default:
      throw actionError("Unsupported UI action \(action.kind).")
    }
  }

  @MainActor
  private func currentStatusLabelText(app: XCUIApplication) -> String {
    let primaryStatus = app.staticTexts["fixture.status.label"]
    if primaryStatus.exists {
      return primaryStatus.label
    }

    let detailLabel = app.staticTexts["fixture.detail.label"]
    if detailLabel.exists {
      return detailLabel.label
    }

    let detailSummary = app.staticTexts["fixture.detail.summaryLabel"]
    if detailSummary.exists {
      return detailSummary.label
    }

    return app.label.isEmpty ? "<status-unavailable>" : app.label
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
      _ = statusLabel.waitForExistence(timeout: interactionTimeout)
      return LifecycleCommandResult(
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
        statusLabel: currentStatusLabelText(app: app),
        metrics: RunnerSnapshotMetrics(
          rawNodeCount: rawNodeCount,
          prunedNodeCount: compactNodeCount,
          interactiveNodeCount: interactiveNodeCount
        ),
        root: compactRoot
      )
      let payloadURL = lifecycleSnapshotPayloadURL(in: controlDirectoryURL, sequence: command.sequence)
      try writeJSON(payload, to: payloadURL)
      return LifecycleCommandResult(
        payload: "snapshot-captured",
        snapshotPayloadPath: payloadURL.path,
        snapshotNodeCount: compactNodeCount
      )

    case "screenshot":
      let screenshot = XCUIScreen.main.screenshot()
      let payloadURL = lifecycleScreenshotPayloadURL(in: controlDirectoryURL, sequence: command.sequence)
      try screenshot.pngRepresentation.write(to: payloadURL, options: .atomic)
      return LifecycleCommandResult(
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
        payload: "video-captured",
        snapshotPayloadPath: framesDirectoryURL.path,
        snapshotNodeCount: nil
      )

    case "uiAction":
      let payloadData = Data((command.payload ?? "{}").utf8)
      let actionPayload = try JSONDecoder().decode(RunnerUIActionPayload.self, from: payloadData)
      let summary = try performRunnerUIAction(actionPayload, app: app)
      return LifecycleCommandResult(
        payload: summary,
        snapshotPayloadPath: nil,
        snapshotNodeCount: nil
      )

    case "shutdown":
      return LifecycleCommandResult(
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

  @MainActor
  private func waitForLifecycleCommand(
    at url: URL,
    timeout: TimeInterval,
  ) throws -> LifecycleCommandFrame? {
    let deadline = Date().addingTimeInterval(timeout)

    while Date() < deadline {
      if FileManager.default.fileExists(atPath: url.path) {
        let data = try Data(contentsOf: url)
        try? FileManager.default.removeItem(at: url)
        return try JSONDecoder().decode(LifecycleCommandFrame.self, from: data)
      }

      RunLoop.current.run(until: Date().addingTimeInterval(0.05))
    }

    return nil
  }

  private func lifecycleCommandURL(in controlDirectoryURL: URL, sequence: Int) -> URL {
    controlDirectoryURL.appendingPathComponent(String(format: "command-%03d.json", sequence))
  }

  private func lifecycleResponseURL(in controlDirectoryURL: URL, sequence: Int) -> URL {
    controlDirectoryURL.appendingPathComponent(String(format: "response-%03d.json", sequence))
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
