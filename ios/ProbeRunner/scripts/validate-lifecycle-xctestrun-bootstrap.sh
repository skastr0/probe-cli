#!/usr/bin/env bash
#
# PRB-102: consolidated, tested workaround for the Xcode 26.6 Simulator
# XCUITest bootstrap-manifest ENOENT defect.
#
# `resolveLifecycleControlDirectory`'s file-based bootstrap path
# (AttachControlSpikeUITests.swift) reads
# /tmp/probe-runner-bootstrap/<udid>.json from inside the UI test process.
# On this host/Xcode combination (26.6, 17F113) that read intermittently
# fails with an ENOENT-shaped error --
# "The data couldn't be read because it is missing" -- even though
# `FileManager.fileExists` and the host shell both confirm the same file
# exists and is readable at the same moment. This is a host/Simulator
# cross-process filesystem-visibility defect, not a Probe logic bug; see
# knowledge/xcuitest-runner/open-questions.md question 6 and
# knowledge/xcuitest-runner/transport-contract.md's "Not yet covered"
# section for the fuller investigation history this script consolidates.
#
# The fix (found during PRB-092's review-fix pass, made reusable here):
# skip the file read entirely by carrying the bootstrap manifest through
# the `PROBE_BOOTSTRAP_JSON` environment variable instead --
# `resolveLifecycleControlDirectory` already prefers that env var over the
# file when it is non-empty. The one wrinkle: a `TEST_RUNNER_`-prefixed
# `xcodebuild` build setting does NOT reach the environment variables
# actually visible inside the spawned UI test process's `.xctestrun`; the
# only reliable way found was to edit the *generated* `.xctestrun` file's
# `EnvironmentVariables` dictionary directly (Python's `plistlib`, never
# `PlistBuddy` -- see the injector below for why) and invoke
# `xcodebuild test-without-building -xctestrun <path>` instead of
# `-project`/`-scheme`.
#
# Usage:
#   ios/ProbeRunner/scripts/validate-lifecycle-xctestrun-bootstrap.sh [test-identifier]
#
# Defaults to PRB-089's own live-Simulator replay-safety gate
# (testCommandLoopReplaySafety), the specific test this glyph's acceptance
# criterion names -- but works for any AttachControlSpikeUITests method that
# goes through `resolveLifecycleControlDirectory`.
#
# Env overrides (all optional):
#   PROBE_FIXTURE_SIMULATOR_UDID          pin a specific simulator instead of
#                                         auto-selecting the first available iPhone
#   PROBE_RUNNER_DERIVED_DATA_PATH        reuse an existing build-for-testing
#                                         output instead of building fresh

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
PROJECT_PATH="${ROOT_DIR}/ios/ProbeFixture/ProbeFixture.xcodeproj"
SCHEME="ProbeRunner"
FIXTURE_BUNDLE_ID="dev.probe.fixture"
TEST_IDENTIFIER="${1:-ProbeRunnerUITests/AttachControlSpikeUITests/testCommandLoopReplaySafety}"
REUSE_DERIVED_DATA="${PROBE_RUNNER_DERIVED_DATA_PATH:-}"
DERIVED_DATA_PATH="${REUSE_DERIVED_DATA:-$(mktemp -d "/tmp/probe-runner-xctestrun-bootstrap-derived-data.XXXXXX")}"
RESULT_BUNDLE_PATH="${DERIVED_DATA_PATH}/ProbeRunnerXctestrunBootstrap-$(date +%s).xcresult"
BUILD_LOG_PATH="${DERIVED_DATA_PATH}/probe-runner-xctestrun-bootstrap-build.log"
TEST_LOG_PATH="${DERIVED_DATA_PATH}/probe-runner-xctestrun-bootstrap-test.log"
CONTROL_DIR="$(mktemp -d "/tmp/probe-runner-xctestrun-bootstrap-spike.XXXXXX")"

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

cleanup() {
  rm -rf "${CONTROL_DIR}" 2>/dev/null || true

  if [[ -z "${REUSE_DERIVED_DATA}" ]]; then
    rm -rf "${DERIVED_DATA_PATH}" 2>/dev/null || true
  fi
}
trap cleanup EXIT

SIMULATOR_UDID="$(resolve_udid)"
DESTINATION="platform=iOS Simulator,id=${SIMULATOR_UDID}"

printf 'Using simulator UDID: %s\n' "${SIMULATOR_UDID}"
printf 'Using DerivedData: %s (reused: %s)\n' "${DERIVED_DATA_PATH}" "$([[ -n "${REUSE_DERIVED_DATA}" ]] && echo yes || echo no)"
printf 'Using control dir: %s\n' "${CONTROL_DIR}"
printf 'Test identifier: %s\n' "${TEST_IDENTIFIER}"

xcrun simctl bootstatus "${SIMULATOR_UDID}" -b

if [[ -z "${REUSE_DERIVED_DATA}" ]]; then
  xcodebuild \
    -project "${PROJECT_PATH}" \
    -scheme "${SCHEME}" \
    -destination "${DESTINATION}" \
    -derivedDataPath "${DERIVED_DATA_PATH}" \
    CODE_SIGNING_ALLOWED=NO \
    build-for-testing \
    > "${BUILD_LOG_PATH}" 2>&1
fi

APP_PATH="${DERIVED_DATA_PATH}/Build/Products/Debug-iphonesimulator/ProbeFixture.app"

if [[ ! -d "${APP_PATH}" ]]; then
  printf 'Expected app bundle not found at %s\n' "${APP_PATH}" >&2
  [[ -f "${BUILD_LOG_PATH}" ]] && tail -n 60 "${BUILD_LOG_PATH}" >&2
  exit 1
fi

XCTESTRUN_PATH="$(find "${DERIVED_DATA_PATH}/Build/Products" -maxdepth 1 -name '*.xctestrun' | head -n1)"

if [[ -z "${XCTESTRUN_PATH}" ]]; then
  printf 'No .xctestrun found under %s/Build/Products\n' "${DERIVED_DATA_PATH}" >&2
  exit 1
fi

INJECTED_XCTESTRUN_PATH="${DERIVED_DATA_PATH}/Build/Products/bootstrap-injected.xctestrun"

printf 'Source xctestrun: %s\n' "${XCTESTRUN_PATH}"
printf 'Injected xctestrun: %s\n' "${INJECTED_XCTESTRUN_PATH}"

xcrun simctl install "${SIMULATOR_UDID}" "${APP_PATH}"
LAUNCH_OUTPUT="$(xcrun simctl launch "${SIMULATOR_UDID}" "${FIXTURE_BUNDLE_ID}")"
printf 'Fixture launch result: %s\n' "${LAUNCH_OUTPUT}"

# Two pitfalls documented at knowledge/xcuitest-runner/transport-contract.md's
# "Not yet covered" section, both encoded here so a future caller does not
# have to rediscover them: (1) never use PlistBuddy to write this key --
# `-c "Add ... string \"<json>\""` mangles embedded double quotes and
# silently corrupts the JSON; `plistlib` load/mutate/dump avoids that.
# (2) `resolveLifecycleControlDirectory`'s env-var branch decodes into the
# exact same `LifecycleBootstrapConfig` as the file-based branches, so every
# field below is required -- `targetBundleId` in particular is not written
# by validate-lifecycle.sh's older `write_bootstrap_json`, and
# `ingressTransport` must be `http-post` (`validateLifecycleBootstrapConfig`
# rejects the older scripts' `file-mailbox` value outright).
SOURCE_XCTESTRUN="${XCTESTRUN_PATH}" \
DEST_XCTESTRUN="${INJECTED_XCTESTRUN_PATH}" \
BOOTSTRAP_CONTROL_DIR="${CONTROL_DIR}" \
BOOTSTRAP_SIMULATOR_UDID="${SIMULATOR_UDID}" \
BOOTSTRAP_TARGET_BUNDLE_ID="${FIXTURE_BUNDLE_ID}" \
/usr/bin/python3 - <<'PY'
import json
import os
import plistlib
from datetime import datetime, timezone
from pathlib import Path

source = Path(os.environ["SOURCE_XCTESTRUN"])
dest = Path(os.environ["DEST_XCTESTRUN"])
control_dir = os.environ["BOOTSTRAP_CONTROL_DIR"]

with source.open("rb") as handle:
    plist = plistlib.load(handle)

bootstrap_config = {
    "contractVersion": "probe.runner.transport/hybrid-v1",
    "controlDirectoryPath": control_dir,
    "egressTransport": "stdout-jsonl-mixed-log",
    "generatedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
    "ingressTransport": "http-post",
    "sessionIdentifier": Path(control_dir).name,
    "simulatorUdid": os.environ["BOOTSTRAP_SIMULATOR_UDID"],
    "targetBundleId": os.environ["BOOTSTRAP_TARGET_BUNDLE_ID"],
}

target = plist["ProbeRunnerUITests"]
env = dict(target.get("EnvironmentVariables", {}))
env["PROBE_BOOTSTRAP_JSON"] = json.dumps(bootstrap_config)
target["EnvironmentVariables"] = env

with dest.open("wb") as handle:
    plistlib.dump(plist, handle)

print(f"Injected PROBE_BOOTSTRAP_JSON into {dest}")
PY

mkdir -p "${CONTROL_DIR}"

set +e
xcodebuild \
  -xctestrun "${INJECTED_XCTESTRUN_PATH}" \
  -destination "${DESTINATION}" \
  -resultBundlePath "${RESULT_BUNDLE_PATH}" \
  CODE_SIGNING_ALLOWED=NO \
  test-without-building \
  "-only-testing:${TEST_IDENTIFIER}" \
  > "${TEST_LOG_PATH}" 2>&1
TEST_EXIT_CODE="$?"
set -e

tail -n 100 "${TEST_LOG_PATH}"

if [[ "${TEST_EXIT_CODE}" -ne 0 ]]; then
  printf 'xcodebuild test-without-building exited with %s -- see %s\n' "${TEST_EXIT_CODE}" "${TEST_LOG_PATH}" >&2
  exit "${TEST_EXIT_CODE}"
fi

printf 'PASSED via PROBE_BOOTSTRAP_JSON env-var injection (no bootstrap-manifest file read at all): %s\n' "${TEST_IDENTIFIER}"
