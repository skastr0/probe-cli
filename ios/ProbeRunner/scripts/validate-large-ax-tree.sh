#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
PROJECT_PATH="${ROOT_DIR}/ios/ProbeFixture/ProbeFixture.xcodeproj"
SCHEME="ProbeRunner"
FIXTURE_BUNDLE_ID="dev.probe.fixture"
DERIVED_DATA_PATH="${PROBE_AX_TREE_DERIVED_DATA_PATH:-$(mktemp -d "/tmp/probe-runner-ax-tree-derived-data.XXXXXX")}"
RESULT_BUNDLE_PATH="${PROBE_AX_TREE_RESULT_BUNDLE_PATH:-${DERIVED_DATA_PATH}/ProbeRunnerAxTree.xcresult}"
CONTROL_DIR="${PROBE_AX_TREE_CONTROL_DIR:-$(mktemp -d "/tmp/probe-runner-ax-tree-control.XXXXXX")}"
LOG_PATH="${PROBE_AX_TREE_LOG_PATH:-${DERIVED_DATA_PATH}/probe-runner-ax-tree.log}"
SUMMARY_FILENAME="ax-tree-performance-summary.json"
SUMMARY_PATH="${PROBE_AX_TREE_SUMMARY_PATH:-${CONTROL_DIR}/${SUMMARY_FILENAME}}"
BOOTSTRAP_ROOT="${PROBE_RUNNER_BOOTSTRAP_ROOT:-/tmp/probe-runner-bootstrap}"
BOOTSTRAP_PATH=""

resolve_udid() {
  if [[ -n "${PROBE_FIXTURE_SIMULATOR_UDID:-}" ]]; then
    printf '%s\n' "${PROBE_FIXTURE_SIMULATOR_UDID}"
    return
  fi

  /usr/bin/python3 - <<'PY'
import json
import subprocess
import sys

data = json.loads(subprocess.check_output([
    "xcrun", "simctl", "list", "devices", "available", "-j"
]))

for runtime, devices in data.get("devices", {}).items():
    if "iOS" not in runtime:
        continue
    for device in devices:
        if not device.get("isAvailable"):
            continue
        if device.get("name", "").startswith("iPhone"):
            print(device["udid"])
            sys.exit(0)

raise SystemExit("No available iPhone simulator found.")
PY
}

write_bootstrap_json() {
  local path="$1"
  local control_dir="$2"
  local simulator_udid="$3"

  mkdir -p "$(dirname "${path}")"

  BOOTSTRAP_PATH_TO_WRITE="${path}" BOOTSTRAP_CONTROL_DIR="${control_dir}" BOOTSTRAP_SIMULATOR_UDID="${simulator_udid}" /usr/bin/python3 - <<'PY'
import json
import os
from datetime import datetime, timezone
from pathlib import Path

Path(os.environ["BOOTSTRAP_PATH_TO_WRITE"]).write_text(
    json.dumps(
        {
            "contractVersion": "probe.runner.transport/hybrid-v1",
            "controlDirectoryPath": os.environ["BOOTSTRAP_CONTROL_DIR"],
            "ingressTransport": "file-mailbox",
            "egressTransport": "stdout-jsonl-mixed-log",
            "sessionIdentifier": Path(os.environ["BOOTSTRAP_CONTROL_DIR"]).name,
            "simulatorUdid": os.environ["BOOTSTRAP_SIMULATOR_UDID"],
            "generatedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        },
        indent=2,
    )
    + "\n"
)
PY
}

print_log_excerpt() {
  if [[ ! -f "${LOG_PATH}" ]]; then
    printf 'AX tree log not found at %s\n' "${LOG_PATH}" >&2
    return
  fi

  printf 'AX tree log excerpt (%s):\n' "${LOG_PATH}" >&2
  LOG_PATH="${LOG_PATH}" /usr/bin/python3 - <<'PY'
import os
from pathlib import Path

path = Path(os.environ["LOG_PATH"])
for line in path.read_text().splitlines()[-120:]:
    print(line)
PY
}

cleanup() {
  if [[ -n "${BOOTSTRAP_PATH}" ]]; then
    rm -f "${BOOTSTRAP_PATH}" 2>/dev/null || true
  fi
}

trap cleanup EXIT

SIMULATOR_UDID="$(resolve_udid)"
DESTINATION="platform=iOS Simulator,id=${SIMULATOR_UDID}"
BOOTSTRAP_PATH="${BOOTSTRAP_ROOT}/${SIMULATOR_UDID}.json"
RUN_SUMMARY_PATH="${CONTROL_DIR}/${SUMMARY_FILENAME}"

rm -rf "${CONTROL_DIR}"
mkdir -p "${CONTROL_DIR}"
mkdir -p "$(dirname "${SUMMARY_PATH}")"
rm -rf "${RESULT_BUNDLE_PATH}"

write_bootstrap_json "${BOOTSTRAP_PATH}" "${CONTROL_DIR}" "${SIMULATOR_UDID}"

printf 'Using simulator UDID: %s\n' "${SIMULATOR_UDID}"
printf 'Using DerivedData: %s\n' "${DERIVED_DATA_PATH}"
printf 'Using result bundle: %s\n' "${RESULT_BUNDLE_PATH}"
printf 'Using control dir: %s\n' "${CONTROL_DIR}"
printf 'Using runner bootstrap: %s\n' "${BOOTSTRAP_PATH}"
printf 'Using xcodebuild log: %s\n' "${LOG_PATH}"
printf 'Writing durable summary to: %s\n' "${SUMMARY_PATH}"

xcrun simctl bootstatus "${SIMULATOR_UDID}" -b

xcodebuild \
  -project "${PROJECT_PATH}" \
  -scheme "${SCHEME}" \
  -destination "${DESTINATION}" \
  -derivedDataPath "${DERIVED_DATA_PATH}" \
  CODE_SIGNING_ALLOWED=NO \
  build-for-testing

APP_PATH="${DERIVED_DATA_PATH}/Build/Products/Debug-iphonesimulator/ProbeFixture.app"

if [[ ! -d "${APP_PATH}" ]]; then
  printf 'Expected app bundle not found at %s\n' "${APP_PATH}" >&2
  exit 1
fi

xcrun simctl install "${SIMULATOR_UDID}" "${APP_PATH}"
LAUNCH_OUTPUT="$(xcrun simctl launch "${SIMULATOR_UDID}" "${FIXTURE_BUNDLE_ID}")"

printf 'Fixture launch result: %s\n' "${LAUNCH_OUTPUT}"

set +e
xcodebuild \
  -project "${PROJECT_PATH}" \
  -scheme "${SCHEME}" \
  -destination "${DESTINATION}" \
  -derivedDataPath "${DERIVED_DATA_PATH}" \
  -resultBundlePath "${RESULT_BUNDLE_PATH}" \
  CODE_SIGNING_ALLOWED=NO \
  test-without-building \
  -only-testing:ProbeRunnerUITests/AttachControlSpikeUITests/testLargeAxTreePerformanceSpike \
  > "${LOG_PATH}" 2>&1
XCODEBUILD_EXIT_CODE="$?"
set -e

if [[ "${XCODEBUILD_EXIT_CODE}" -ne 0 ]]; then
  printf 'xcodebuild test-without-building exited with %s\n' "${XCODEBUILD_EXIT_CODE}" >&2
  print_log_excerpt
  exit "${XCODEBUILD_EXIT_CODE}"
fi

if [[ ! -f "${RUN_SUMMARY_PATH}" ]]; then
  printf 'Expected benchmark summary not found at %s\n' "${RUN_SUMMARY_PATH}" >&2
  print_log_excerpt
  exit 1
fi

cp "${RUN_SUMMARY_PATH}" "${SUMMARY_PATH}"

SUMMARY_PATH="${SUMMARY_PATH}" /usr/bin/python3 - <<'PY'
import json
import os
from pathlib import Path

summary_path = Path(os.environ["SUMMARY_PATH"])
summary = json.loads(summary_path.read_text())
print(json.dumps(summary, indent=2))
PY

printf 'AX tree benchmark summary written to %s\n' "${SUMMARY_PATH}"
printf 'AX tree benchmark artifacts kept in %s\n' "${CONTROL_DIR}"
