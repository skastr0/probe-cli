#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
PROJECT_PATH="${ROOT_DIR}/ios/ProbeFixture/ProbeFixture.xcodeproj"
SCHEME="ProbeRunner"
FIXTURE_BUNDLE_ID="dev.probe.fixture"
DERIVED_DATA_PATH="${PROBE_RUNNER_DERIVED_DATA_PATH:-$(mktemp -d "/tmp/probe-runner-derived-data.XXXXXX")}" 
RESULT_BUNDLE_PATH="${PROBE_RUNNER_RESULT_BUNDLE_PATH:-${DERIVED_DATA_PATH}/ProbeRunner.xcresult}"

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

SIMULATOR_UDID="$(resolve_udid)"
DESTINATION="platform=iOS Simulator,id=${SIMULATOR_UDID}"

printf 'Using simulator UDID: %s\n' "${SIMULATOR_UDID}"
printf 'Using DerivedData: %s\n' "${DERIVED_DATA_PATH}"
printf 'Using result bundle: %s\n' "${RESULT_BUNDLE_PATH}"

xcrun simctl bootstatus "${SIMULATOR_UDID}" -b

rm -rf "${RESULT_BUNDLE_PATH}"

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
LAUNCH_PID="$(LAUNCH_OUTPUT="${LAUNCH_OUTPUT}" /usr/bin/python3 - <<'PY'
import re
import os
import sys

output = os.environ["LAUNCH_OUTPUT"].strip()
match = re.search(r':\s*(\d+)\s*$', output)

if not match:
    raise SystemExit('Unable to parse fixture launch pid from simctl output.')

print(match.group(1))
PY
)"

printf 'Fixture launch result: %s\n' "${LAUNCH_OUTPUT}"
printf 'Fixture launch pid: %s\n' "${LAUNCH_PID}"

xcodebuild \
  -project "${PROJECT_PATH}" \
  -scheme "${SCHEME}" \
  -destination "${DESTINATION}" \
  -derivedDataPath "${DERIVED_DATA_PATH}" \
  -resultBundlePath "${RESULT_BUNDLE_PATH}" \
  CODE_SIGNING_ALLOWED=NO \
  test-without-building \
  -only-testing:ProbeRunnerUITests/AttachControlSpikeUITests/testAttachSnapshotAndControlWithoutRelaunch

if FIXTURE_PROCESS="$(ps -p "${LAUNCH_PID}" -o pid=,command=)" && [[ -n "${FIXTURE_PROCESS}" ]]; then
  printf 'Fixture pid after test: %s\n' "${FIXTURE_PROCESS}"
else
  printf 'Fixture pid %s not present after test.\n' "${LAUNCH_PID}" >&2
  exit 1
fi
