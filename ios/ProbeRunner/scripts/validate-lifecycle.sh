#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
PROJECT_PATH="${ROOT_DIR}/ios/ProbeFixture/ProbeFixture.xcodeproj"
SCHEME="ProbeRunner"
FIXTURE_BUNDLE_ID="dev.probe.fixture"
DERIVED_DATA_PATH="${PROBE_RUNNER_DERIVED_DATA_PATH:-$(mktemp -d "/tmp/probe-runner-lifecycle-derived-data.XXXXXX")}" 
RESULT_BUNDLE_PATH="${PROBE_RUNNER_RESULT_BUNDLE_PATH:-${DERIVED_DATA_PATH}/ProbeRunnerLifecycle.xcresult}"
CONTROL_DIR="${PROBE_RUNNER_CONTROL_DIR:-$(mktemp -d "/tmp/probe-runner-lifecycle-spike.XXXXXX")}"
LOG_PATH="${PROBE_RUNNER_LIFECYCLE_LOG_PATH:-${DERIVED_DATA_PATH}/probe-runner-lifecycle.log}"
SUMMARY_PATH="${CONTROL_DIR}/summary.json"
COMMAND_METRICS_PATH="${CONTROL_DIR}/command-metrics.tsv"
READY_PATH="${CONTROL_DIR}/ready.json"
BOOTSTRAP_ROOT="${PROBE_RUNNER_BOOTSTRAP_ROOT:-/tmp/probe-runner-bootstrap}"
BOOTSTRAP_PATH=""

now_ms() {
  /usr/bin/python3 - <<'PY'
import time
print(time.time_ns() // 1_000_000)
PY
}

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

print_log_excerpt() {
  if [[ ! -f "${LOG_PATH}" ]]; then
    printf 'Lifecycle log not found at %s\n' "${LOG_PATH}" >&2
    return
  fi

  printf 'Lifecycle log excerpt (%s):\n' "${LOG_PATH}" >&2
  LOG_PATH="${LOG_PATH}" /usr/bin/python3 - <<'PY'
import os
from pathlib import Path

path = Path(os.environ["LOG_PATH"])
lines = path.read_text().splitlines()
for line in lines[-80:]:
    print(line)
PY
}

cleanup() {
  if [[ -n "${XCODEBUILD_PID:-}" ]] && kill -0 "${XCODEBUILD_PID}" 2>/dev/null; then
    kill "${XCODEBUILD_PID}" 2>/dev/null || true
    wait "${XCODEBUILD_PID}" 2>/dev/null || true
  fi

  if [[ -n "${BOOTSTRAP_PATH}" ]]; then
    rm -f "${BOOTSTRAP_PATH}" 2>/dev/null || true
  fi
}

trap cleanup EXIT

wait_for_file() {
  local path="$1"
  local label="$2"
  local timeout_ms="$3"
  local started_at
  started_at="$(now_ms)"

  while (( $(now_ms) - started_at < timeout_ms )); do
    if [[ -f "${path}" ]]; then
      return 0
    fi

    if [[ -n "${XCODEBUILD_PID:-}" ]] && ! kill -0 "${XCODEBUILD_PID}" 2>/dev/null; then
      printf 'xcodebuild exited before %s appeared: %s\n' "${label}" "${path}" >&2
      return 1
    fi

    sleep 0.05
  done

  printf 'Timed out waiting for %s: %s\n' "${label}" "${path}" >&2
  return 1
}

write_command_json() {
  local path="$1"
  local sequence="$2"
  local action="$3"
  local payload="$4"

  COMMAND_PATH="${path}" COMMAND_SEQUENCE="${sequence}" COMMAND_ACTION="${action}" COMMAND_PAYLOAD="${payload}" /usr/bin/python3 - <<'PY'
import json
import os
from pathlib import Path

payload = os.environ["COMMAND_PAYLOAD"]
data = {
    "sequence": int(os.environ["COMMAND_SEQUENCE"]),
    "action": os.environ["COMMAND_ACTION"],
    "payload": None if payload == "__PROBE_NULL__" else payload,
}
Path(os.environ["COMMAND_PATH"]).write_text(json.dumps(data))
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

emit_summary() {
  local startup_ms="$1"
  local teardown_ms="$2"
  local total_session_ms="$3"
  local fixture_pid_alive_after="$4"

  SUMMARY_PATH="${SUMMARY_PATH}" READY_PATH="${READY_PATH}" COMMAND_METRICS_PATH="${COMMAND_METRICS_PATH}" CONTROL_DIR="${CONTROL_DIR}" RESULT_BUNDLE_PATH="${RESULT_BUNDLE_PATH}" LOG_PATH="${LOG_PATH}" SIMULATOR_UDID="${SIMULATOR_UDID}" DERIVED_DATA_PATH="${DERIVED_DATA_PATH}" STARTUP_MS="${startup_ms}" TEARDOWN_MS="${teardown_ms}" TOTAL_SESSION_MS="${total_session_ms}" FIXTURE_PID_ALIVE_AFTER="${fixture_pid_alive_after}" /usr/bin/python3 - <<'PY'
import json
import os
from pathlib import Path

summary_path = Path(os.environ["SUMMARY_PATH"])
ready = json.loads(Path(os.environ["READY_PATH"]).read_text())
metrics_lines = Path(os.environ["COMMAND_METRICS_PATH"]).read_text().splitlines()
commands = []

for line in metrics_lines:
    if not line.strip():
        continue
    sequence, action, idle_gap_ms, host_rtt_ms, response_path = line.split("\t")
    response = json.loads(Path(response_path).read_text())
    commands.append({
        "sequence": int(sequence),
        "action": action,
        "idleGapBeforeMs": int(idle_gap_ms),
        "hostRttMs": int(host_rtt_ms),
        "response": response,
    })

steady_state = [command["hostRttMs"] for command in commands if command["action"] != "shutdown"]
summary = {
    "simulatorUdid": os.environ["SIMULATOR_UDID"],
    "derivedDataPath": os.environ["DERIVED_DATA_PATH"],
    "resultBundlePath": os.environ["RESULT_BUNDLE_PATH"],
    "controlDir": os.environ["CONTROL_DIR"],
    "logPath": os.environ["LOG_PATH"],
    "selectedTransport": {
        "contract": ready.get("runnerTransportContract"),
        "bootstrapSource": ready.get("bootstrapSource"),
        "bootstrapPath": ready.get("bootstrapPath"),
        "ingress": ready.get("ingressTransport"),
        "egress": ready.get("egressTransport"),
        "sessionIdentifier": ready.get("sessionIdentifier"),
    },
    "startupMs": int(os.environ["STARTUP_MS"]),
    "teardownMs": int(os.environ["TEARDOWN_MS"]),
    "totalSessionMs": int(os.environ["TOTAL_SESSION_MS"]),
    "fixturePidAliveAfter": os.environ["FIXTURE_PID_ALIVE_AFTER"] == "true",
    "ready": ready,
    "commands": commands,
    "steadyState": {
        "count": len(steady_state),
        "minHostRttMs": min(steady_state) if steady_state else 0,
        "maxHostRttMs": max(steady_state) if steady_state else 0,
        "avgHostRttMs": round(sum(steady_state) / len(steady_state), 3) if steady_state else 0,
    },
}

summary_path.write_text(json.dumps(summary, indent=2) + "\n")
print(json.dumps(summary, indent=2))
PY
}

send_command() {
  local sequence="$1"
  local action="$2"
  local payload="$3"
  local idle_gap_ms="$4"
  local command_path="${CONTROL_DIR}/command-$(printf '%03d' "${sequence}").json"
  local response_path="${CONTROL_DIR}/response-$(printf '%03d' "${sequence}").json"

  if (( idle_gap_ms > 0 )); then
    /usr/bin/python3 - "${idle_gap_ms}" <<'PY'
import sys
import time

time.sleep(int(sys.argv[1]) / 1000)
PY
  fi

  local started_at
  started_at="$(now_ms)"
  write_command_json "${command_path}" "${sequence}" "${action}" "${payload}"
  wait_for_file "${response_path}" "response ${sequence}" 20000
  local completed_at
  completed_at="$(now_ms)"
  local host_rtt_ms=$((completed_at - started_at))

  printf '%s\t%s\t%s\t%s\t%s\n' "${sequence}" "${action}" "${idle_gap_ms}" "${host_rtt_ms}" "${response_path}" >> "${COMMAND_METRICS_PATH}"

  RESPONSE_PATH="${response_path}" HOST_RTT_MS="${host_rtt_ms}" /usr/bin/python3 - <<'PY'
import json
import os

response = json.loads(open(os.environ["RESPONSE_PATH"]).read())
print(
    "PROBE_METRIC command_sequence={sequence} action={action} ok={ok} host_rtt_ms={host_rtt_ms} handled_ms={handled_ms} status_label={status_label}".format(
        sequence=response["sequence"],
        action=response["action"],
        ok=response["ok"],
        host_rtt_ms=os.environ.get("HOST_RTT_MS", ""),
        handled_ms=response["handledMs"],
        status_label=json.dumps(response["statusLabel"]),
    )
)
PY
}

SIMULATOR_UDID="$(resolve_udid)"
DESTINATION="platform=iOS Simulator,id=${SIMULATOR_UDID}"
BOOTSTRAP_PATH="${BOOTSTRAP_ROOT}/${SIMULATOR_UDID}.json"

rm -rf "${CONTROL_DIR}"
mkdir -p "${CONTROL_DIR}"
: > "${COMMAND_METRICS_PATH}"
rm -rf "${RESULT_BUNDLE_PATH}"
write_bootstrap_json "${BOOTSTRAP_PATH}" "${CONTROL_DIR}" "${SIMULATOR_UDID}"

printf 'Using simulator UDID: %s\n' "${SIMULATOR_UDID}"
printf 'Using DerivedData: %s\n' "${DERIVED_DATA_PATH}"
printf 'Using result bundle: %s\n' "${RESULT_BUNDLE_PATH}"
printf 'Using control dir: %s\n' "${CONTROL_DIR}"
printf 'Using runner bootstrap: %s\n' "${BOOTSTRAP_PATH}"
printf 'Using xcodebuild log: %s\n' "${LOG_PATH}"

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
LAUNCH_PID="$(LAUNCH_OUTPUT="${LAUNCH_OUTPUT}" /usr/bin/python3 - <<'PY'
import os
import re

output = os.environ["LAUNCH_OUTPUT"].strip()
match = re.search(r':\s*(\d+)\s*$', output)

if not match:
    raise SystemExit('Unable to parse fixture launch pid from simctl output.')

print(match.group(1))
PY
)"

printf 'Fixture launch result: %s\n' "${LAUNCH_OUTPUT}"
printf 'Fixture launch pid: %s\n' "${LAUNCH_PID}"

SESSION_STARTED_AT="$(now_ms)"
xcodebuild \
  -project "${PROJECT_PATH}" \
  -scheme "${SCHEME}" \
  -destination "${DESTINATION}" \
  -derivedDataPath "${DERIVED_DATA_PATH}" \
  -resultBundlePath "${RESULT_BUNDLE_PATH}" \
  CODE_SIGNING_ALLOWED=NO \
  test-without-building \
  -only-testing:ProbeRunnerUITests/AttachControlSpikeUITests/testCommandLoopLifecycle \
  > "${LOG_PATH}" 2>&1 &
XCODEBUILD_PID="$!"

wait_for_file "${READY_PATH}" "runner ready frame" 120000 || {
  print_log_excerpt
  exit 1
}

READY_SEEN_AT="$(now_ms)"
STARTUP_MS=$((READY_SEEN_AT - SESSION_STARTED_AT))

printf 'PROBE_METRIC startup_ms=%s\n' "${STARTUP_MS}"

send_command 1 ping startup-check 0
send_command 2 applyInput lifecycle-alpha 2000
send_command 3 snapshot __PROBE_NULL__ 2000
send_command 4 ping post-snapshot 2000

SHUTDOWN_STARTED_AT="$(now_ms)"
send_command 5 shutdown __PROBE_NULL__ 0

set +e
wait "${XCODEBUILD_PID}"
XCODEBUILD_EXIT_CODE="$?"
set -e

if [[ "${XCODEBUILD_EXIT_CODE}" -ne 0 ]]; then
  printf 'xcodebuild test-without-building exited with %s\n' "${XCODEBUILD_EXIT_CODE}" >&2
  print_log_excerpt
  exit "${XCODEBUILD_EXIT_CODE}"
fi

XCODEBUILD_PID=""
TEARDOWN_FINISHED_AT="$(now_ms)"
TEARDOWN_MS=$((TEARDOWN_FINISHED_AT - SHUTDOWN_STARTED_AT))
TOTAL_SESSION_MS=$((TEARDOWN_FINISHED_AT - SESSION_STARTED_AT))

FIXTURE_PID_ALIVE_AFTER="false"
if FIXTURE_PROCESS="$(ps -p "${LAUNCH_PID}" -o pid=,command=)" && [[ -n "${FIXTURE_PROCESS}" ]]; then
  FIXTURE_PID_ALIVE_AFTER="true"
  printf 'Fixture pid after lifecycle test: %s\n' "${FIXTURE_PROCESS}"
else
  printf 'Fixture pid %s not present after lifecycle test.\n' "${LAUNCH_PID}" >&2
fi

printf 'PROBE_METRIC teardown_ms=%s total_session_ms=%s\n' "${TEARDOWN_MS}" "${TOTAL_SESSION_MS}"
emit_summary "${STARTUP_MS}" "${TEARDOWN_MS}" "${TOTAL_SESSION_MS}" "${FIXTURE_PID_ALIVE_AFTER}"

printf 'Lifecycle summary written to %s\n' "${SUMMARY_PATH}"
