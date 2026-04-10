#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
PROJECT_PATH="${ROOT_DIR}/ios/ProbeFixture/ProbeFixture.xcodeproj"
SCHEME="ProbeFixture"
BUNDLE_ID="dev.probe.fixture"
DERIVED_DATA_PATH="${PROBE_FIXTURE_DERIVED_DATA_PATH:-$(mktemp -d "/tmp/probe-fixture-derived-data.XXXXXX")}"

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

xcrun simctl bootstatus "${SIMULATOR_UDID}" -b

xcodebuild \
  -project "${PROJECT_PATH}" \
  -scheme "${SCHEME}" \
  -destination "${DESTINATION}" \
  -derivedDataPath "${DERIVED_DATA_PATH}" \
  CODE_SIGNING_ALLOWED=NO \
  build

APP_PATH="${DERIVED_DATA_PATH}/Build/Products/Debug-iphonesimulator/ProbeFixture.app"

if [[ ! -d "${APP_PATH}" ]]; then
  printf 'Expected app bundle not found at %s\n' "${APP_PATH}" >&2
  exit 1
fi

xcrun simctl install "${SIMULATOR_UDID}" "${APP_PATH}"
LAUNCH_OUTPUT="$(xcrun simctl launch "${SIMULATOR_UDID}" "${BUNDLE_ID}")"

printf 'Installed app: %s\n' "${APP_PATH}"
printf 'Launch result: %s\n' "${LAUNCH_OUTPUT}"
