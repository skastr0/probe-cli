#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
PROJECT_PATH="${ROOT_DIR}/ios/ProbeFixture/ProbeFixture.xcodeproj"
SCHEME="ProbeRunner"
SPIKE_ROOT="${PROBE_REAL_DEVICE_SPIKE_ROOT:-$(mktemp -d "/tmp/probe-real-device-spike.XXXXXX")}"
LOG_DIR="${SPIKE_ROOT}/logs"
DEVICECTL_DIR="${SPIKE_ROOT}/devicectl"
SIGNED_DERIVED_DATA_PATH="${PROBE_REAL_DEVICE_SIGNED_DERIVED_DATA_PATH:-${SPIKE_ROOT}/derived-data-device-signed}"
UNSIGNED_DERIVED_DATA_PATH="${PROBE_REAL_DEVICE_UNSIGNED_DERIVED_DATA_PATH:-${SPIKE_ROOT}/derived-data-device-unsigned}"
SUMMARY_PATH="${PROBE_REAL_DEVICE_SUMMARY_PATH:-${ROOT_DIR}/knowledge/devicectl-device-signing/host-validation-results.json}"
DEVICE_IDENTIFIER="${PROBE_REAL_DEVICE_IDENTIFIER:-}"
VALIDATE_INSTALL_AND_LAUNCH="${PROBE_REAL_DEVICE_VALIDATE_INSTALL_AND_LAUNCH:-0}"

mkdir -p "${LOG_DIR}" "${DEVICECTL_DIR}" "$(dirname "${SUMMARY_PATH}")"

run_logged() {
  local label="$1"
  shift

  local log_path="${LOG_DIR}/${label}.log"
  local exit_path="${LOG_DIR}/${label}.exitcode"

  set +e
  "$@" >"${log_path}" 2>&1
  local exit_code=$?
  set -e

  printf '%s\n' "${exit_code}" >"${exit_path}"
}

read_exit_code() {
  local label="$1"
  local exit_path="${LOG_DIR}/${label}.exitcode"

  if [[ -f "${exit_path}" ]]; then
    tr -d '\n' <"${exit_path}"
    return
  fi

  printf 'missing'
}

printf 'Using spike root: %s\n' "${SPIKE_ROOT}"
printf 'Writing summary to: %s\n' "${SUMMARY_PATH}"

run_logged "xcodebuild-version" xcodebuild -version
run_logged "xcode-select-path" xcode-select -p
run_logged "devicectl-help" xcrun devicectl help
run_logged "devicectl-help-manage-pair" xcrun devicectl help manage pair
run_logged "devicectl-help-list-preferredDDI" xcrun devicectl help list preferredDDI
run_logged "devicectl-help-device-info-ddiServices" xcrun devicectl help device info ddiServices
run_logged "devicectl-help-device-info-apps" xcrun devicectl help device info apps
run_logged "devicectl-help-device-install-app" xcrun devicectl help device install app
run_logged "devicectl-help-device-process-launch" xcrun devicectl help device process launch

run_logged \
  "devicectl-list-preferredDDI" \
  xcrun devicectl list preferredDDI --json-output "${DEVICECTL_DIR}/preferredDDI.json"

run_logged \
  "devicectl-list-devices" \
  xcrun devicectl list devices --json-output "${DEVICECTL_DIR}/devices.json"

run_logged \
  "build-for-testing-device-signed" \
  xcodebuild \
  -project "${PROJECT_PATH}" \
  -scheme "${SCHEME}" \
  -destination "generic/platform=iOS" \
  -derivedDataPath "${SIGNED_DERIVED_DATA_PATH}" \
  build-for-testing

run_logged \
  "build-for-testing-device-unsigned" \
  xcodebuild \
  -project "${PROJECT_PATH}" \
  -scheme "${SCHEME}" \
  -destination "generic/platform=iOS" \
  -derivedDataPath "${UNSIGNED_DERIVED_DATA_PATH}" \
  CODE_SIGNING_ALLOWED=NO \
  build-for-testing

UNSIGNED_APP_PATH="${UNSIGNED_DERIVED_DATA_PATH}/Build/Products/Debug-iphoneos/ProbeFixture.app"
UNSIGNED_RUNNER_APP_PATH="${UNSIGNED_DERIVED_DATA_PATH}/Build/Products/Debug-iphoneos/ProbeRunnerUITests-Runner.app"
UNSIGNED_XCTEST_PATH="${UNSIGNED_RUNNER_APP_PATH}/PlugIns/ProbeRunnerUITests.xctest"
SIGNED_APP_PATH="${SIGNED_DERIVED_DATA_PATH}/Build/Products/Debug-iphoneos/ProbeFixture.app"

shopt -s nullglob
unsigned_xctestrun_matches=("${UNSIGNED_DERIVED_DATA_PATH}/Build/Products/"*.xctestrun)
signed_xctestrun_matches=("${SIGNED_DERIVED_DATA_PATH}/Build/Products/"*.xctestrun)
shopt -u nullglob

UNSIGNED_XCTESTRUN_PATH="${unsigned_xctestrun_matches[0]:-}"
SIGNED_XCTESTRUN_PATH="${signed_xctestrun_matches[0]:-}"

if [[ -d "${UNSIGNED_APP_PATH}" ]]; then
  run_logged "codesign-verify-unsigned-app" codesign --verify --deep --strict "${UNSIGNED_APP_PATH}"
fi

if [[ -d "${UNSIGNED_RUNNER_APP_PATH}" ]]; then
  run_logged "codesign-verify-unsigned-runner-app" codesign --verify --deep --strict "${UNSIGNED_RUNNER_APP_PATH}"
fi

if [[ -d "${UNSIGNED_XCTEST_PATH}" ]]; then
  run_logged "codesign-verify-unsigned-xctest" codesign --verify --deep --strict "${UNSIGNED_XCTEST_PATH}"
fi

if [[ -n "${DEVICE_IDENTIFIER}" ]]; then
  run_logged \
    "devicectl-device-info-ddiServices" \
    xcrun devicectl device info ddiServices --device "${DEVICE_IDENTIFIER}" --json-output "${DEVICECTL_DIR}/ddiServices.json"

  run_logged \
    "devicectl-device-info-apps" \
    xcrun devicectl device info apps --device "${DEVICE_IDENTIFIER}" --json-output "${DEVICECTL_DIR}/apps.json"

  if [[ "${VALIDATE_INSTALL_AND_LAUNCH}" == "1" && "$(read_exit_code build-for-testing-device-signed)" == "0" && -d "${SIGNED_APP_PATH}" ]]; then
    run_logged \
      "devicectl-device-install-app" \
      xcrun devicectl device install app --device "${DEVICE_IDENTIFIER}" "${SIGNED_APP_PATH}"

    run_logged \
      "devicectl-device-process-launch" \
      xcrun devicectl device process launch --device "${DEVICE_IDENTIFIER}" dev.probe.fixture --terminate-existing
  fi
fi

ROOT_DIR="${ROOT_DIR}" \
SPIKE_ROOT="${SPIKE_ROOT}" \
LOG_DIR="${LOG_DIR}" \
DEVICECTL_DIR="${DEVICECTL_DIR}" \
SUMMARY_PATH="${SUMMARY_PATH}" \
DEVICE_IDENTIFIER="${DEVICE_IDENTIFIER}" \
SIGNED_DERIVED_DATA_PATH="${SIGNED_DERIVED_DATA_PATH}" \
UNSIGNED_DERIVED_DATA_PATH="${UNSIGNED_DERIVED_DATA_PATH}" \
UNSIGNED_APP_PATH="${UNSIGNED_APP_PATH}" \
UNSIGNED_RUNNER_APP_PATH="${UNSIGNED_RUNNER_APP_PATH}" \
UNSIGNED_XCTEST_PATH="${UNSIGNED_XCTEST_PATH}" \
SIGNED_APP_PATH="${SIGNED_APP_PATH}" \
SIGNED_XCTESTRUN_PATH="${SIGNED_XCTESTRUN_PATH}" \
UNSIGNED_XCTESTRUN_PATH="${UNSIGNED_XCTESTRUN_PATH}" \
/usr/bin/python3 - <<'PY'
import json
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional


def read_text(path: Path) -> str:
    if not path.exists():
        return ""
    return path.read_text()


def read_exit(label: str):
    path = Path(os.environ["LOG_DIR"]) / f"{label}.exitcode"
    if not path.exists():
        return None
    return int(path.read_text().strip())


def load_json(path: Path):
    if not path.exists():
        return None
    return json.loads(path.read_text())


def first_matching_line(text: str, markers: tuple[str, ...]) -> Optional[str]:
    for line in text.splitlines():
        if any(marker in line for marker in markers):
            return line.strip()
    return None


def compact_lines(text: str, limit: int = 6):
    return [line for line in text.splitlines() if line.strip()][:limit]


def command_report(*, name: str, mode: str, label: str, summary: str, evidence: list[str], blocked_reason: Optional[str] = None):
    return {
        "name": name,
        "mode": mode,
        "exitCode": read_exit(label),
        "summary": summary,
        "evidence": evidence,
        "blockedReason": blocked_reason,
        "logPath": str(Path(os.environ["LOG_DIR"]) / f"{label}.log"),
    }


summary_path = Path(os.environ["SUMMARY_PATH"])
summary_path.parent.mkdir(parents=True, exist_ok=True)

preferred_ddi = load_json(Path(os.environ["DEVICECTL_DIR"]) / "preferredDDI.json") or {}
devices = load_json(Path(os.environ["DEVICECTL_DIR"]) / "devices.json") or {}
preferred_platforms = preferred_ddi.get("result", {}).get("platforms", {})
ios_ddi_entries = preferred_platforms.get("iOS", [])
ios_ddi_metadata = ios_ddi_entries[0].get("ddiMetadata", {}) if ios_ddi_entries else {}
connected_devices = devices.get("result", {}).get("devices", [])
device_count = len(connected_devices)

xcode_version_lines = compact_lines(read_text(Path(os.environ["LOG_DIR"]) / "xcodebuild-version.log"), limit=4)
developer_dir = read_text(Path(os.environ["LOG_DIR"]) / "xcode-select-path.log").strip()

signed_build_log = read_text(Path(os.environ["LOG_DIR"]) / "build-for-testing-device-signed.log")
unsigned_build_log = read_text(Path(os.environ["LOG_DIR"]) / "build-for-testing-device-unsigned.log")

signed_build_exit = read_exit("build-for-testing-device-signed")
unsigned_build_exit = read_exit("build-for-testing-device-unsigned")

signing_failure = first_matching_line(
    signed_build_log,
    (
        "Signing for \"ProbeFixture\" requires a development team",
        "Signing for \"ProbeRunnerUITests\" requires a development team",
        "requires a development team",
    ),
)
unsigned_success = first_matching_line(unsigned_build_log, ("** TEST BUILD SUCCEEDED **", "** BUILD SUCCEEDED **"))

unsigned_artifacts = {
    "appPath": os.environ["UNSIGNED_APP_PATH"],
    "runnerAppPath": os.environ["UNSIGNED_RUNNER_APP_PATH"],
    "xctestPath": os.environ["UNSIGNED_XCTEST_PATH"],
    "xctestrunPath": os.environ["UNSIGNED_XCTESTRUN_PATH"],
    "appExists": Path(os.environ["UNSIGNED_APP_PATH"]).exists(),
    "runnerAppExists": Path(os.environ["UNSIGNED_RUNNER_APP_PATH"]).exists(),
    "xctestExists": Path(os.environ["UNSIGNED_XCTEST_PATH"]).exists(),
    "xctestrunExists": bool(os.environ["UNSIGNED_XCTESTRUN_PATH"]) and Path(os.environ["UNSIGNED_XCTESTRUN_PATH"]).exists(),
}

codesign_reports = []
for label, title in (
    ("codesign-verify-unsigned-app", "ProbeFixture.app"),
    ("codesign-verify-unsigned-runner-app", "ProbeRunnerUITests-Runner.app"),
    ("codesign-verify-unsigned-xctest", "ProbeRunnerUITests.xctest"),
):
    exit_code = read_exit(label)
    if exit_code is None:
        continue
    log_text = read_text(Path(os.environ["LOG_DIR"]) / f"{label}.log")
    codesign_reports.append(
        {
            "artifact": title,
            "exitCode": exit_code,
            "evidence": compact_lines(log_text, limit=4),
            "logPath": str(Path(os.environ["LOG_DIR"]) / f"{label}.log"),
        }
    )

devicectl_reports = [
    command_report(
        name="devicectl list preferredDDI",
        mode="validated",
        label="devicectl-list-preferredDDI",
        summary=(
            "Validated on this host; CoreDevice reports a usable iOS DDI."
            if read_exit("devicectl-list-preferredDDI") == 0 and ios_ddi_metadata.get("isUsable")
            else "Preferred DDI check did not validate a usable iOS DDI on this host."
        ),
        evidence=[
            f"jsonVersion={preferred_ddi.get('info', {}).get('jsonVersion')}",
            f"hostCoreDeviceVersion={preferred_ddi.get('result', {}).get('hostCoreDeviceVersion')}",
            f"iOS hostDDI={ios_ddi_entries[0].get('hostDDI')}" if ios_ddi_entries else "iOS hostDDI missing",
            f"iOS isUsable={ios_ddi_metadata.get('isUsable')}",
            f"iOS contentIsCompatible={ios_ddi_metadata.get('contentIsCompatible')}",
        ],
    ),
    command_report(
        name="devicectl list devices",
        mode="validated",
        label="devicectl-list-devices",
        summary=(
            f"Validated on this host; CoreDevice discovered {device_count} connected device(s)."
            if read_exit("devicectl-list-devices") == 0
            else "Device discovery did not complete successfully on this host."
        ),
        evidence=[
            f"jsonVersion={devices.get('info', {}).get('jsonVersion')}",
            f"outcome={devices.get('info', {}).get('outcome')}",
            f"deviceCount={device_count}",
        ],
    ),
    command_report(
        name="devicectl manage pair --help",
        mode="surface-only",
        label="devicectl-help-manage-pair",
        summary="Validated the command surface locally via help output.",
        evidence=compact_lines(read_text(Path(os.environ["LOG_DIR"]) / "devicectl-help-manage-pair.log"), limit=5),
    ),
    command_report(
        name="devicectl device info ddiServices --help",
        mode="surface-only",
        label="devicectl-help-device-info-ddiServices",
        summary="Validated the command surface locally via help output.",
        evidence=compact_lines(read_text(Path(os.environ["LOG_DIR"]) / "devicectl-help-device-info-ddiServices.log"), limit=6),
    ),
    command_report(
        name="devicectl device info apps --help",
        mode="surface-only",
        label="devicectl-help-device-info-apps",
        summary="Validated the command surface locally via help output.",
        evidence=compact_lines(read_text(Path(os.environ["LOG_DIR"]) / "devicectl-help-device-info-apps.log"), limit=6),
    ),
    command_report(
        name="devicectl device install app --help",
        mode="surface-only",
        label="devicectl-help-device-install-app",
        summary="Validated the install command surface locally via help output.",
        evidence=compact_lines(read_text(Path(os.environ["LOG_DIR"]) / "devicectl-help-device-install-app.log"), limit=6),
    ),
    command_report(
        name="devicectl device process launch --help",
        mode="surface-only",
        label="devicectl-help-device-process-launch",
        summary="Validated the launch command surface locally via help output.",
        evidence=compact_lines(read_text(Path(os.environ["LOG_DIR"]) / "devicectl-help-device-process-launch.log"), limit=8),
    ),
]

if os.environ["DEVICE_IDENTIFIER"]:
    devicectl_reports.append(
        command_report(
            name="devicectl device info ddiServices",
            mode="validated",
            label="devicectl-device-info-ddiServices",
            summary="Attempted device-specific DDI service validation with the provided device identifier.",
            evidence=compact_lines(read_text(Path(os.environ["LOG_DIR"]) / "devicectl-device-info-ddiServices.log"), limit=8),
        )
    )
    devicectl_reports.append(
        command_report(
            name="devicectl device info apps",
            mode="validated",
            label="devicectl-device-info-apps",
            summary="Attempted installed-app enumeration with the provided device identifier.",
            evidence=compact_lines(read_text(Path(os.environ["LOG_DIR"]) / "devicectl-device-info-apps.log"), limit=8),
        )
    )
else:
    blocked_reason = "No physical device identifier was provided, and CoreDevice discovered no connected devices on this host."
    devicectl_reports.extend(
        [
            {
                "name": "devicectl device info ddiServices",
                "mode": "blocked",
                "exitCode": None,
                "summary": "Skipped because the host has no concrete physical device target.",
                "evidence": [f"deviceCount={device_count}"],
                "blockedReason": blocked_reason,
                "logPath": None,
            },
            {
                "name": "devicectl device info apps",
                "mode": "blocked",
                "exitCode": None,
                "summary": "Skipped because the host has no concrete physical device target.",
                "evidence": [f"deviceCount={device_count}"],
                "blockedReason": blocked_reason,
                "logPath": None,
            },
            {
                "name": "devicectl device install app",
                "mode": "blocked",
                "exitCode": None,
                "summary": "Skipped because the host has no connected real device and no signed app artifact to install.",
                "evidence": [f"signedBuildExit={signed_build_exit}", f"deviceCount={device_count}"],
                "blockedReason": blocked_reason,
                "logPath": None,
            },
            {
                "name": "devicectl device process launch",
                "mode": "blocked",
                "exitCode": None,
                "summary": "Skipped because install/launch validation needs a paired real device and a signed app on that device.",
                "evidence": [f"signedBuildExit={signed_build_exit}", f"deviceCount={device_count}"],
                "blockedReason": blocked_reason,
                "logPath": None,
            },
        ]
    )

signing_setup_requirements = [
    "Configure a non-empty DEVELOPMENT_TEAM (or equivalent signing settings) for both ProbeFixture and ProbeRunnerUITests before attempting a real-device build.",
    "Provide development signing artifacts that can sign both the target app host and the UI-test runner path.",
    "Treat build-for-testing output as the canonical runner artifact contract for now: ProbeFixture.app, ProbeRunnerUITests-Runner.app, ProbeRunnerUITests.xctest, and the generated .xctestrun file.",
]

user_setup_requirements = [
    "Use the active Xcode selected by xcode-select and confirm xcodebuild -version matches the intended toolchain.",
    "Pair and trust the iPhone/iPad with Xcode before relying on devicectl-managed real-device flows.",
    "Enable Developer Mode on the device before trying to run development-signed software.",
    "Use an iOS 17+ physical device for the devicectl path.",
    "Confirm xcrun devicectl list preferredDDI reports a usable iOS DDI before trying device info, install, or launch operations.",
]

retry_requirements = [
    "After pairing, trust, or Developer Mode changes, rerun devicectl list devices and device info ddiServices instead of assuming the host state refreshed itself.",
    "If DDI compatibility is broken, run xcodebuild -runFirstLaunch -checkForNewerComponents and xcrun devicectl manage ddis update before retrying install or launch.",
    "Retry devicectl install/launch only after the signed build succeeds; Probe should not mask missing-team or unsigned-artifact failures with opaque retries.",
]

fallback_requirements = [
    "If no physical device is connected, stop at host-side validation and surface explicit setup requirements instead of claiming real-device support works.",
    "If the device is older than the devicectl support window, keep the session on Simulator or use an explicitly different Xcode-managed path; do not pretend devicectl covers it.",
    "If signed runner artifacts are unavailable, require externally built and signed artifacts rather than teaching Probe to provision teams, certificates, or devices itself.",
]

hard_walls = []
if device_count == 0:
    hard_walls.append("No physical device is connected to this host, so pair/DDI-service/install/launch behavior could not be exercised end-to-end.")
if signed_build_exit != 0:
    hard_walls.append("The ProbeFixture project cannot currently produce a deployable iPhoneOS runner build because the project has no development team configured for signing.")

if signed_build_exit == 0 and unsigned_build_exit == 0 and device_count > 0:
    overall_outcome = "viable"
elif read_exit("devicectl-list-preferredDDI") == 0 and read_exit("devicectl-list-devices") == 0 and unsigned_build_exit == 0:
    overall_outcome = "partial"
else:
    overall_outcome = "blocked"

summary = {
    "generatedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
    "overallOutcome": overall_outcome,
    "summary": (
        "Host-side real-device prerequisites are partially validated: devicectl is present, iOS DDI metadata is usable, and the Probe runner compiles for iPhoneOS without signing, but deployment remains blocked by missing signing configuration and the lack of a connected physical device."
        if overall_outcome == "partial"
        else "Real-device validation is blocked by missing host prerequisites."
    ),
    "host": {
        "workspaceRoot": os.environ["ROOT_DIR"],
        "spikeRoot": os.environ["SPIKE_ROOT"],
        "developerDir": developer_dir,
        "xcodeVersionLines": xcode_version_lines,
    },
    "signing": {
        "signedBuild": {
            "exitCode": signed_build_exit,
            "status": "validated" if signed_build_exit == 0 else "blocked",
            "xctestrunPath": os.environ["SIGNED_XCTESTRUN_PATH"] or None,
            "evidence": compact_lines(signed_build_log, limit=12),
            "keyFailure": signing_failure,
            "logPath": str(Path(os.environ["LOG_DIR"]) / "build-for-testing-device-signed.log"),
        },
        "unsignedBuild": {
            "exitCode": unsigned_build_exit,
            "status": "validated" if unsigned_build_exit == 0 else "blocked",
            "successMarker": unsigned_success,
            "artifacts": unsigned_artifacts,
            "logPath": str(Path(os.environ["LOG_DIR"]) / "build-for-testing-device-unsigned.log"),
        },
        "codeSignVerification": codesign_reports,
        "setupRequirements": signing_setup_requirements,
    },
    "devicectl": {
        "coreDeviceVersion": preferred_ddi.get("result", {}).get("hostCoreDeviceVersion"),
        "jsonVersion": preferred_ddi.get("info", {}).get("jsonVersion"),
        "deviceCount": device_count,
        "commands": devicectl_reports,
    },
    "requirements": {
        "userSetup": user_setup_requirements,
        "retry": retry_requirements,
        "fallback": fallback_requirements,
    },
    "hardWalls": hard_walls,
}

summary_path.write_text(json.dumps(summary, indent=2) + "\n")
print(f"OVERALL_OUTCOME={overall_outcome}")
print(f"SUMMARY_PATH={summary_path}")
print(summary["summary"])
for wall in hard_walls:
    print(f"HARD_WALL={wall}")
PY
