import UIKit

final class FixtureViewController: UIViewController {
  private enum SnapshotProfile: Int {
    case baseline
    case medium
    case large

    var generatedCardCount: Int {
      sectionCount * cardsPerSection
    }

    var sectionCount: Int {
      switch self {
      case .baseline:
        0
      case .medium:
        3
      case .large:
        6
      }
    }

    var cardsPerSection: Int {
      switch self {
      case .baseline:
        0
      case .medium:
        4
      case .large:
        8
      }
    }

    var identifierPrefix: String {
      switch self {
      case .baseline:
        "fixture.snapshot.baseline"
      case .medium:
        "fixture.snapshot.medium"
      case .large:
        "fixture.snapshot.large"
      }
    }

    var statusLabel: String {
      switch self {
      case .baseline:
        "Snapshot profile ready: baseline (0 generated cards)"
      case .medium:
        "Snapshot profile ready: medium (12 generated cards)"
      case .large:
        "Snapshot profile ready: large (48 generated cards)"
      }
    }
  }

  private let listItems = ["Alpha", "Beta", "Gamma", "Delta"]

  private let scrollView = UIScrollView()
  private let contentStack = UIStackView()
  private let statusLabel = UILabel()
  private let snapshotProfileControl = UISegmentedControl(items: ["Base", "Medium", "Large"])
  private let snapshotProfileStatusLabel = UILabel()
  private let snapshotProfileContentStack = UIStackView()
  private let inputField = UITextField()
  private let applyButton = UIButton(type: .system)
  private let modeControl = UISegmentedControl(items: ["Idle", "Edit", "Review"])
  private let enabledSwitch = UISwitch()
  private let tableView = UITableView(frame: .zero, style: .insetGrouped)
  private let openDetailButton = UIButton(type: .system)
  private let disabledButton = UIButton(type: .system)
  private let logTextView = UITextView()
  private let offscreenButton = UIButton(type: .system)

  private var logLines: [String] = []
  private var snapshotProfile: SnapshotProfile = .baseline

  override func viewDidLoad() {
    super.viewDidLoad()

    title = "Probe Fixture"
    view.backgroundColor = .systemBackground
    view.accessibilityIdentifier = "fixture.root.view"

    configureNavigationItem()
    configureScrollView()
    configureStatusLabel()
    configureSnapshotProfileControl()
    configureSnapshotProfileStatusLabel()
    configureSnapshotProfileContentStack()
    configureInputField()
    configureButtons()
    configureModeControl()
    configureToggle()
    configureTableView()
    configureLogTextView()
    buildLayout()
    applySnapshotProfile(.baseline)
    resetFixtureState()
  }

  private func configureNavigationItem() {
    navigationItem.rightBarButtonItem = UIBarButtonItem(
      title: "Reset",
      style: .plain,
      target: self,
      action: #selector(handleReset)
    )
  }

  private func configureScrollView() {
    scrollView.translatesAutoresizingMaskIntoConstraints = false
    contentStack.translatesAutoresizingMaskIntoConstraints = false
    contentStack.axis = .vertical
    contentStack.spacing = 16
    contentStack.alignment = .fill
  }

  private func configureStatusLabel() {
    statusLabel.font = .preferredFont(forTextStyle: .headline)
    statusLabel.numberOfLines = 0
    statusLabel.accessibilityIdentifier = "fixture.status.label"
  }

  private func configureSnapshotProfileControl() {
    snapshotProfileControl.selectedSegmentIndex = SnapshotProfile.baseline.rawValue
    snapshotProfileControl.addTarget(self, action: #selector(handleSnapshotProfileChanged), for: .valueChanged)
    snapshotProfileControl.accessibilityIdentifier = "fixture.snapshot.profile.control"
  }

  private func configureSnapshotProfileStatusLabel() {
    snapshotProfileStatusLabel.font = .preferredFont(forTextStyle: .subheadline)
    snapshotProfileStatusLabel.numberOfLines = 0
    snapshotProfileStatusLabel.textColor = .secondaryLabel
    snapshotProfileStatusLabel.accessibilityIdentifier = "fixture.snapshot.profile.statusLabel"
  }

  private func configureSnapshotProfileContentStack() {
    snapshotProfileContentStack.axis = .vertical
    snapshotProfileContentStack.spacing = 16
    snapshotProfileContentStack.alignment = .fill
    snapshotProfileContentStack.accessibilityIdentifier = "fixture.snapshot.profile.contentStack"
  }

  private func configureInputField() {
    inputField.borderStyle = .roundedRect
    inputField.placeholder = "Type fixture input"
    inputField.returnKeyType = .done
    inputField.clearButtonMode = .whileEditing
    inputField.autocapitalizationType = .none
    inputField.autocorrectionType = .no
    inputField.delegate = self
    inputField.accessibilityIdentifier = "fixture.form.input"
  }

  private func configureButtons() {
    applyButton.configuration = .filled()
    applyButton.configuration?.title = "Apply Input"
    applyButton.addTarget(self, action: #selector(handleApplyInput), for: .touchUpInside)
    applyButton.accessibilityIdentifier = "fixture.form.applyButton"

    openDetailButton.configuration = .bordered()
    openDetailButton.configuration?.title = "Open Detail"
    openDetailButton.addTarget(self, action: #selector(handleOpenDetail), for: .touchUpInside)
    openDetailButton.accessibilityIdentifier = "fixture.navigation.detailButton"

    disabledButton.configuration = .bordered()
    disabledButton.configuration?.title = "Disabled Control"
    disabledButton.isEnabled = false
    disabledButton.accessibilityIdentifier = "fixture.problem.disabledButton"

    offscreenButton.configuration = .filled()
    offscreenButton.configuration?.title = "Tap Offscreen Action"
    offscreenButton.addTarget(self, action: #selector(handleOffscreenTap), for: .touchUpInside)
    offscreenButton.accessibilityIdentifier = "fixture.problem.offscreenButton"
  }

  private func configureModeControl() {
    modeControl.selectedSegmentIndex = 0
    modeControl.addTarget(self, action: #selector(handleModeChanged), for: .valueChanged)
    modeControl.accessibilityIdentifier = "fixture.mode.segmentedControl"
  }

  private func configureToggle() {
    enabledSwitch.addTarget(self, action: #selector(handleToggleChanged), for: .valueChanged)
    enabledSwitch.accessibilityIdentifier = "fixture.state.toggle"
  }

  private func configureTableView() {
    tableView.translatesAutoresizingMaskIntoConstraints = false
    tableView.dataSource = self
    tableView.delegate = self
    tableView.rowHeight = 52
    tableView.isScrollEnabled = false
    tableView.accessibilityIdentifier = "fixture.list.table"
    tableView.register(UITableViewCell.self, forCellReuseIdentifier: "FixtureCell")
  }

  private func configureLogTextView() {
    logTextView.font = .monospacedSystemFont(ofSize: 13, weight: .regular)
    logTextView.isEditable = false
    logTextView.isSelectable = true
    logTextView.layer.cornerRadius = 12
    logTextView.backgroundColor = .secondarySystemBackground
    logTextView.textContainerInset = UIEdgeInsets(top: 12, left: 12, bottom: 12, right: 12)
    logTextView.accessibilityIdentifier = "fixture.logs.textView"
  }

  private func buildLayout() {
    view.addSubview(scrollView)
    scrollView.addSubview(contentStack)

    let introLabel = makeSectionLabel(
      text: "UIKit fixture harness for Probe runner validation.",
      identifier: "fixture.intro.label"
    )
    introLabel.font = .preferredFont(forTextStyle: .subheadline)
    introLabel.textColor = .secondaryLabel

    let formStack = UIStackView(arrangedSubviews: [inputField, applyButton])
    formStack.axis = .vertical
    formStack.spacing = 12

    let toggleRow = UIStackView(arrangedSubviews: [
      makeSectionLabel(text: "Feature toggle", identifier: "fixture.state.toggleLabel"),
      enabledSwitch,
    ])
    toggleRow.axis = .horizontal
    toggleRow.alignment = .center
    toggleRow.distribution = .equalSpacing

    let tableHeight = CGFloat(listItems.count) * tableView.rowHeight + 44
    tableView.heightAnchor.constraint(equalToConstant: tableHeight).isActive = true
    logTextView.heightAnchor.constraint(equalToConstant: 180).isActive = true

    let offscreenHint = makeSectionLabel(
      text: "The spacer below forces a scroll so attach/control spikes can validate offscreen interaction.",
      identifier: "fixture.problem.hintLabel"
    )
    offscreenHint.font = .preferredFont(forTextStyle: .footnote)
    offscreenHint.textColor = .secondaryLabel

    let spacer = UIView()
    spacer.translatesAutoresizingMaskIntoConstraints = false
    spacer.heightAnchor.constraint(equalToConstant: 280).isActive = true

    [
      makeSectionLabel(text: "Probe Fixture", identifier: "fixture.title.label"),
      introLabel,
      statusLabel,
      makeSectionLabel(text: "Snapshot profiles", identifier: "fixture.snapshot.sectionLabel"),
      snapshotProfileControl,
      snapshotProfileStatusLabel,
      snapshotProfileContentStack,
      makeSectionLabel(text: "Form", identifier: "fixture.form.sectionLabel"),
      formStack,
      makeSectionLabel(text: "Mode", identifier: "fixture.mode.sectionLabel"),
      modeControl,
      toggleRow,
      makeSectionLabel(text: "List", identifier: "fixture.list.sectionLabel"),
      tableView,
      makeSectionLabel(text: "Navigation", identifier: "fixture.navigation.sectionLabel"),
      openDetailButton,
      makeSectionLabel(text: "Problem shapes", identifier: "fixture.problem.sectionLabel"),
      disabledButton,
      offscreenHint,
      spacer,
      offscreenButton,
      makeSectionLabel(text: "Logs", identifier: "fixture.logs.sectionLabel"),
      logTextView,
    ].forEach(contentStack.addArrangedSubview(_:))

    NSLayoutConstraint.activate([
      scrollView.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
      scrollView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
      scrollView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
      scrollView.bottomAnchor.constraint(equalTo: view.bottomAnchor),

      contentStack.topAnchor.constraint(equalTo: scrollView.contentLayoutGuide.topAnchor, constant: 20),
      contentStack.leadingAnchor.constraint(equalTo: scrollView.frameLayoutGuide.leadingAnchor, constant: 20),
      contentStack.trailingAnchor.constraint(equalTo: scrollView.frameLayoutGuide.trailingAnchor, constant: -20),
      contentStack.bottomAnchor.constraint(equalTo: scrollView.contentLayoutGuide.bottomAnchor, constant: -20),
    ])
  }

  private func resetFixtureState() {
    inputField.text = ""
    modeControl.selectedSegmentIndex = 0
    enabledSwitch.isOn = true
    appendLog("fixture reset")
    updateStatus("Ready for attach/control validation")
  }

  private func updateStatus(_ text: String) {
    statusLabel.text = text
  }

  private func appendLog(_ message: String) {
    let timestamp = DateFormatter.fixtureLogTimestamp.string(from: Date())
    logLines.append("[\(timestamp)] \(message)")
    logTextView.text = logLines.joined(separator: "\n")
  }

  private func applySnapshotProfile(_ profile: SnapshotProfile) {
    snapshotProfile = profile
    snapshotProfileControl.selectedSegmentIndex = profile.rawValue
    snapshotProfileStatusLabel.text = profile.statusLabel

    snapshotProfileContentStack.arrangedSubviews.forEach { arrangedSubview in
      snapshotProfileContentStack.removeArrangedSubview(arrangedSubview)
      arrangedSubview.removeFromSuperview()
    }

    guard profile != .baseline else {
      let hintLabel = makeSectionLabel(
        text: "Switch to Medium or Large to generate the benchmark-heavy accessibility tree.",
        identifier: "fixture.snapshot.baseline.hintLabel"
      )
      hintLabel.font = .preferredFont(forTextStyle: .footnote)
      hintLabel.textColor = .secondaryLabel
      snapshotProfileContentStack.addArrangedSubview(hintLabel)
      return
    }

    for sectionIndex in 0..<profile.sectionCount {
      snapshotProfileContentStack.addArrangedSubview(
        makeSnapshotProfileSection(profile: profile, sectionIndex: sectionIndex)
      )
    }
  }

  private func makeSnapshotProfileSection(profile: SnapshotProfile, sectionIndex: Int) -> UIView {
    let sectionStack = UIStackView()
    sectionStack.axis = .vertical
    sectionStack.spacing = 12
    sectionStack.alignment = .fill
    sectionStack.accessibilityIdentifier = "\(profile.identifierPrefix).section.\(sectionIndex).stack"

    let sectionLabel = makeSectionLabel(
      text: "\(profile == .medium ? "Medium" : "Large") benchmark section \(sectionIndex + 1)",
      identifier: "\(profile.identifierPrefix).section.\(sectionIndex).label"
    )
    sectionLabel.font = .preferredFont(forTextStyle: .subheadline)

    sectionStack.addArrangedSubview(sectionLabel)

    for cardIndex in 0..<profile.cardsPerSection {
      sectionStack.addArrangedSubview(
        makeSnapshotProfileCard(profile: profile, sectionIndex: sectionIndex, cardIndex: cardIndex)
      )
    }

    return sectionStack
  }

  private func makeSnapshotProfileCard(
    profile: SnapshotProfile,
    sectionIndex: Int,
    cardIndex: Int,
  ) -> UIView {
    let prefix = "\(profile.identifierPrefix).section.\(sectionIndex).card.\(cardIndex)"

    let container = UIView()
    container.backgroundColor = .secondarySystemBackground
    container.layer.cornerRadius = 14
    container.accessibilityIdentifier = "\(prefix).container"

    let stack = UIStackView()
    stack.translatesAutoresizingMaskIntoConstraints = false
    stack.axis = .vertical
    stack.spacing = 10
    stack.alignment = .fill
    stack.accessibilityIdentifier = "\(prefix).stack"

    let titleLabel = makeSectionLabel(
      text: "Benchmark card \(sectionIndex + 1)-\(cardIndex + 1)",
      identifier: "\(prefix).title"
    )
    titleLabel.font = .preferredFont(forTextStyle: .headline)

    let summaryLabel = makeSectionLabel(
      text: "Synthetic accessibility content for snapshot benchmarking with repeated controls and nested groups.",
      identifier: "\(prefix).summary"
    )
    summaryLabel.font = .preferredFont(forTextStyle: .body)
    summaryLabel.textColor = .secondaryLabel

    let badgeLabel = makeSectionLabel(
      text: profile == .medium ? "Medium depth" : "Large depth",
      identifier: "\(prefix).badge"
    )
    badgeLabel.font = .preferredFont(forTextStyle: .footnote)
    badgeLabel.textColor = .systemBlue

    let metricRow = UIStackView(arrangedSubviews: [
      makeSnapshotMetricLabel(text: "Section \(sectionIndex + 1)", identifier: "\(prefix).metric.section"),
      makeSnapshotMetricLabel(text: "Card \(cardIndex + 1)", identifier: "\(prefix).metric.card"),
      makeSnapshotMetricLabel(text: profile == .medium ? "Mode M" : "Mode L", identifier: "\(prefix).metric.mode"),
    ])
    metricRow.axis = .horizontal
    metricRow.spacing = 8
    metricRow.distribution = .fillEqually
    metricRow.accessibilityIdentifier = "\(prefix).metricsRow"

    let primaryButton = UIButton(type: .system)
    primaryButton.configuration = .filled()
    primaryButton.configuration?.title = "Primary Action \(sectionIndex + 1)-\(cardIndex + 1)"
    primaryButton.accessibilityIdentifier = "\(prefix).primaryButton"

    let secondaryButton = UIButton(type: .system)
    secondaryButton.configuration = .bordered()
    secondaryButton.configuration?.title = "Details"
    secondaryButton.accessibilityIdentifier = "\(prefix).secondaryButton"

    let controlButtons = UIStackView(arrangedSubviews: [primaryButton, secondaryButton])
    controlButtons.axis = .horizontal
    controlButtons.spacing = 12
    controlButtons.distribution = .fillEqually
    controlButtons.accessibilityIdentifier = "\(prefix).buttonRow"

    let toggle = UISwitch()
    toggle.isOn = (sectionIndex + cardIndex).isMultiple(of: 2)
    toggle.accessibilityIdentifier = "\(prefix).toggle"

    let toggleLabel = makeSectionLabel(
      text: "Automation enabled",
      identifier: "\(prefix).toggleLabel"
    )
    toggleLabel.font = .preferredFont(forTextStyle: .body)

    let toggleRow = UIStackView(arrangedSubviews: [toggleLabel, toggle])
    toggleRow.axis = .horizontal
    toggleRow.spacing = 12
    toggleRow.distribution = .equalSpacing
    toggleRow.alignment = .center
    toggleRow.accessibilityIdentifier = "\(prefix).toggleRow"

    let field = UITextField()
    field.borderStyle = .roundedRect
    field.placeholder = "Benchmark input \(sectionIndex + 1)-\(cardIndex + 1)"
    field.text = "value-\(sectionIndex + 1)-\(cardIndex + 1)"
    field.accessibilityIdentifier = "\(prefix).input"

    let modeControl = UISegmentedControl(items: ["Idle", "Queue", "Live"])
    modeControl.selectedSegmentIndex = (sectionIndex + cardIndex) % 3
    modeControl.accessibilityIdentifier = "\(prefix).segmentedControl"

    [titleLabel, summaryLabel, badgeLabel, metricRow, controlButtons, toggleRow, field, modeControl]
      .forEach(stack.addArrangedSubview(_:))

    container.addSubview(stack)

    NSLayoutConstraint.activate([
      stack.topAnchor.constraint(equalTo: container.topAnchor, constant: 14),
      stack.leadingAnchor.constraint(equalTo: container.leadingAnchor, constant: 14),
      stack.trailingAnchor.constraint(equalTo: container.trailingAnchor, constant: -14),
      stack.bottomAnchor.constraint(equalTo: container.bottomAnchor, constant: -14),
    ])

    return container
  }

  private func makeSnapshotMetricLabel(text: String, identifier: String) -> UILabel {
    let label = UILabel()
    label.font = .preferredFont(forTextStyle: .caption1)
    label.numberOfLines = 0
    label.textAlignment = .center
    label.textColor = .secondaryLabel
    label.layer.cornerRadius = 10
    label.layer.masksToBounds = true
    label.backgroundColor = .tertiarySystemBackground
    label.text = text
    label.accessibilityIdentifier = identifier
    return label
  }

  private func makeSectionLabel(text: String, identifier: String) -> UILabel {
    let label = UILabel()
    label.font = .preferredFont(forTextStyle: .headline)
    label.numberOfLines = 0
    label.text = text
    label.accessibilityIdentifier = identifier
    return label
  }

  @objc
  private func handleReset() {
    logLines.removeAll()
    resetFixtureState()
  }

  @objc
  private func handleApplyInput() {
    let text = inputField.text?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    let value = text.isEmpty ? "<empty>" : text
    updateStatus("Input applied: \(value)")
    appendLog("input applied -> \(value)")
  }

  @objc
  private func handleSnapshotProfileChanged() {
    let selectedProfile = SnapshotProfile(rawValue: snapshotProfileControl.selectedSegmentIndex) ?? .baseline
    applySnapshotProfile(selectedProfile)
  }

  @objc
  private func handleModeChanged() {
    let selectedMode = modeControl.titleForSegment(at: modeControl.selectedSegmentIndex) ?? "unknown"
    updateStatus("Mode changed to \(selectedMode)")
    appendLog("mode changed -> \(selectedMode)")
  }

  @objc
  private func handleToggleChanged() {
    let state = enabledSwitch.isOn ? "enabled" : "disabled"
    updateStatus("Fixture state is \(state)")
    appendLog("toggle changed -> \(state)")
  }

  @objc
  private func handleOpenDetail() {
    appendLog("detail view opened")
    navigationController?.pushViewController(FixtureDetailViewController(summary: statusLabel.text ?? "No status"), animated: true)
  }

  @objc
  private func handleOffscreenTap() {
    updateStatus("Offscreen action reached")
    appendLog("offscreen action tapped")
  }
}

extension FixtureViewController: UITextFieldDelegate {
  func textFieldShouldReturn(_ textField: UITextField) -> Bool {
    handleApplyInput()
    textField.resignFirstResponder()
    return true
  }
}

extension FixtureViewController: UITableViewDataSource, UITableViewDelegate {
  func tableView(_ tableView: UITableView, numberOfRowsInSection section: Int) -> Int {
    listItems.count
  }

  func tableView(_ tableView: UITableView, cellForRowAt indexPath: IndexPath) -> UITableViewCell {
    let cell = tableView.dequeueReusableCell(withIdentifier: "FixtureCell", for: indexPath)
    var content = cell.defaultContentConfiguration()
    content.text = listItems[indexPath.row]
    content.secondaryText = "fixture.list.item.\(indexPath.row)"
    cell.contentConfiguration = content
    cell.accessibilityIdentifier = "fixture.list.item.\(indexPath.row)"
    return cell
  }

  func tableView(_ tableView: UITableView, didSelectRowAt indexPath: IndexPath) {
    let selection = listItems[indexPath.row]
    updateStatus("Selected list item: \(selection)")
    appendLog("list item selected -> \(selection)")
    tableView.deselectRow(at: indexPath, animated: true)
  }
}

private final class FixtureDetailViewController: UIViewController {
  private let summary: String

  init(summary: String) {
    self.summary = summary
    super.init(nibName: nil, bundle: nil)
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) {
    fatalError("init(coder:) has not been implemented")
  }

  override func viewDidLoad() {
    super.viewDidLoad()

    title = "Detail"
    view.backgroundColor = .systemBackground
    view.accessibilityIdentifier = "fixture.detail.view"

    let label = UILabel()
    label.translatesAutoresizingMaskIntoConstraints = false
    label.font = .preferredFont(forTextStyle: .title2)
    label.text = "Detail view active"
    label.accessibilityIdentifier = "fixture.detail.label"

    let summaryLabel = UILabel()
    summaryLabel.translatesAutoresizingMaskIntoConstraints = false
    summaryLabel.font = .preferredFont(forTextStyle: .body)
    summaryLabel.numberOfLines = 0
    summaryLabel.text = summary
    summaryLabel.accessibilityIdentifier = "fixture.detail.summaryLabel"

    let button = UIButton(type: .system)
    button.translatesAutoresizingMaskIntoConstraints = false
    button.configuration = .filled()
    button.configuration?.title = "Pop Detail"
    button.addTarget(self, action: #selector(handlePop), for: .touchUpInside)
    button.accessibilityIdentifier = "fixture.detail.popButton"

    view.addSubview(label)
    view.addSubview(summaryLabel)
    view.addSubview(button)

    NSLayoutConstraint.activate([
      label.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 32),
      label.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 20),
      label.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -20),

      summaryLabel.topAnchor.constraint(equalTo: label.bottomAnchor, constant: 16),
      summaryLabel.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 20),
      summaryLabel.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -20),

      button.topAnchor.constraint(equalTo: summaryLabel.bottomAnchor, constant: 24),
      button.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 20),
    ])
  }

  @objc
  private func handlePop() {
    navigationController?.popViewController(animated: true)
  }
}

private extension DateFormatter {
  static let fixtureLogTimestamp: DateFormatter = {
    let formatter = DateFormatter()
    formatter.locale = Locale(identifier: "en_US_POSIX")
    formatter.dateFormat = "HH:mm:ss"
    return formatter
  }()
}
