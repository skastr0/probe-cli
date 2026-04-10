#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
PROJECT_PATH="${ROOT_DIR}/ios/ProbeFixture/ProbeFixture.xcodeproj"
SCHEME="ProbeRunner"
FIXTURE_BUNDLE_ID="dev.probe.fixture"
DERIVED_DATA_PATH="${PROBE_RUNNER_TRANSPORT_DERIVED_DATA_PATH:-$(mktemp -d "/tmp/probe-runner-transport-derived-data.XXXXXX")}"
RESULT_BUNDLE_PATH="${PROBE_RUNNER_TRANSPORT_RESULT_BUNDLE_PATH:-${DERIVED_DATA_PATH}/ProbeRunnerTransportBoundary.xcresult}"
CONTROL_DIR="${PROBE_RUNNER_TRANSPORT_CONTROL_DIR:-$(mktemp -d "/tmp/probe-runner-transport-boundary.XXXXXX")}"
LOG_PATH="${PROBE_RUNNER_TRANSPORT_LOG_PATH:-${DERIVED_DATA_PATH}/probe-runner-transport-boundary.log}"
SUMMARY_PATH="${PROBE_RUNNER_TRANSPORT_SUMMARY_PATH:-${ROOT_DIR}/knowledge/xcuitest-runner/transport-boundary-spike-results.json}"
COMMAND_METRICS_PATH="${CONTROL_DIR}/transport-command-metrics.tsv"
READY_PATH=""
STDOUT_READY_PATH="${CONTROL_DIR}/stdout-ready.json"
STDIN_PROBE_PATH="${CONTROL_DIR}/stdout-stdin-probe-result.json"
STDOUT_EVENTS_PATH="${CONTROL_DIR}/stdout-events.ndjson"
SESSION_RUNNER_SCRIPT="${ROOT_DIR}/ios/ProbeRunner/scripts/run-transport-boundary-session.py"
RUNTIME_CONTROL_DIR="${PROBE_RUNNER_RUNTIME_CONTROL_DIR:-$(mktemp -d "/tmp/probe-runner-runtime-control.XXXXXX")}"
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
  local min_mtime_ms="$4"
  local started_at

  started_at="$(now_ms)"

  while (( $(now_ms) - started_at < timeout_ms )); do
    if [[ -f "${path}" ]]; then
      local file_mtime_ms
      file_mtime_ms="$(PATH_TO_CHECK="${path}" /usr/bin/python3 - <<'PY'
import os
from pathlib import Path

print(Path(os.environ["PATH_TO_CHECK"]).stat().st_mtime_ns // 1_000_000)
PY
)"

      if (( file_mtime_ms >= min_mtime_ms )); then
        printf '%s\n' "$(now_ms)"
        return 0
      fi
    fi

    if [[ -n "${XCODEBUILD_PID:-}" ]] && ! kill -0 "${XCODEBUILD_PID}" 2>/dev/null; then
      printf 'xcodebuild exited before %s appeared: %s\n' "${label}" "${path}" >&2
      return 1
    fi

    sleep 0.01
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
Path(os.environ["COMMAND_PATH"]).write_text(json.dumps({
    "sequence": int(os.environ["COMMAND_SEQUENCE"]),
    "action": os.environ["COMMAND_ACTION"],
    "payload": None if payload == "__PROBE_NULL__" else payload,
}))
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
  local ready_file_seen_ms="$1"
  local ready_stdout_seen_ms="$2"

  SUMMARY_PATH="${SUMMARY_PATH}" READY_PATH="${READY_PATH}" STDOUT_READY_PATH="${STDOUT_READY_PATH}" STDIN_PROBE_PATH="${STDIN_PROBE_PATH}" COMMAND_METRICS_PATH="${COMMAND_METRICS_PATH}" CONTROL_DIR="${CONTROL_DIR}" RUNTIME_CONTROL_DIR="${RUNTIME_CONTROL_DIR}" RESULT_BUNDLE_PATH="${RESULT_BUNDLE_PATH}" LOG_PATH="${LOG_PATH}" STDOUT_EVENTS_PATH="${STDOUT_EVENTS_PATH}" SIMULATOR_UDID="${SIMULATOR_UDID}" DERIVED_DATA_PATH="${DERIVED_DATA_PATH}" READY_FILE_SEEN_MS="${ready_file_seen_ms}" READY_STDOUT_SEEN_MS="${ready_stdout_seen_ms}" /usr/bin/python3 - <<'PY'
import json
import os
from pathlib import Path


def summarize(values):
    if not values:
        return {"count": 0, "minMs": 0, "maxMs": 0, "avgMs": 0}
    return {
        "count": len(values),
        "minMs": min(values),
        "maxMs": max(values),
        "avgMs": round(sum(values) / len(values), 3),
    }


summary_path = Path(os.environ["SUMMARY_PATH"])
summary_path.parent.mkdir(parents=True, exist_ok=True)

ready = json.loads(Path(os.environ["READY_PATH"]).read_text())
stdout_ready = json.loads(Path(os.environ["STDOUT_READY_PATH"]).read_text())
stdin_probe = json.loads(Path(os.environ["STDIN_PROBE_PATH"]).read_text())
commands = []
commands_by_key = {}
file_rtts = []
stdout_rtts = []
stdout_minus_file = []

for line in Path(os.environ["COMMAND_METRICS_PATH"]).read_text().splitlines():
    if not line.strip():
        continue

    sequence, action, idle_gap_ms, file_host_rtt_ms, stdout_host_rtt_ms, file_response_path, stdout_response_path = line.split("\t")
    file_response = json.loads(Path(file_response_path).read_text())
    stdout_response = json.loads(Path(stdout_response_path).read_text())
    delta = int(stdout_host_rtt_ms) - int(file_host_rtt_ms)

    command_record = {
        "sequence": int(sequence),
        "action": action,
        "idleGapBeforeMs": int(idle_gap_ms),
        "fileHostRttMs": int(file_host_rtt_ms),
        "stdoutHostRttMs": int(stdout_host_rtt_ms),
        "stdoutMinusFileMs": delta,
        "fileResponse": file_response,
        "stdoutResponseEvent": stdout_response,
    }
    commands_by_key[(int(sequence), action)] = command_record

commands = [commands_by_key[key] for key in sorted(commands_by_key)]
file_rtts = [command["fileHostRttMs"] for command in commands]
stdout_rtts = [command["stdoutHostRttMs"] for command in commands]
stdout_minus_file = [command["stdoutMinusFileMs"] for command in commands]

summary = {
    "generatedAt": stdout_ready["hostObservedAt"],
    "simulatorUdid": os.environ["SIMULATOR_UDID"],
    "derivedDataPath": os.environ["DERIVED_DATA_PATH"],
    "resultBundlePath": os.environ["RESULT_BUNDLE_PATH"],
    "stdoutArtifactControlDir": os.environ["CONTROL_DIR"],
    "runnerFileControlDir": os.environ["RUNTIME_CONTROL_DIR"],
    "logPath": os.environ["LOG_PATH"],
    "stdoutEventsPath": os.environ["STDOUT_EVENTS_PATH"],
    "selectedTransport": {
        "contract": stdout_ready.get("runnerTransportContract"),
        "bootstrapSource": stdout_ready.get("bootstrapSource"),
        "bootstrapPath": stdout_ready.get("bootstrapPath"),
        "ingress": stdout_ready.get("ingressTransport"),
        "egress": stdout_ready.get("egressTransport"),
        "sessionIdentifier": stdout_ready.get("sessionIdentifier"),
    },
    "ready": {
        "fileReadySeenMs": int(os.environ["READY_FILE_SEEN_MS"]),
        "stdoutReadySeenMs": int(os.environ["READY_STDOUT_SEEN_MS"]),
        "stdoutMinusFileMs": int(os.environ["READY_STDOUT_SEEN_MS"]) - int(os.environ["READY_FILE_SEEN_MS"]),
        "fileReady": ready,
        "stdoutReadyEvent": stdout_ready,
    },
    "stdinProbe": stdin_probe,
    "commands": commands,
    "fileBoundary": summarize(file_rtts),
    "stdoutBoundary": summarize(stdout_rtts),
    "stdoutMinusFile": summarize(stdout_minus_file),
    "conclusion": {
        "validated": [
            "Structured runner frames survive the xcodebuild-launched XCUITest runner boundary as mixed stdout log lines.",
            "The host can demultiplex ready and response frames from the xcodebuild/XCTest log stream.",
            "A simulator bootstrap manifest can carry a per-session file-mailbox control directory into the runner without relying on ad hoc shell environment injection.",
        ],
        "notValidated": [
            "A pure dedicated JSONL stdout channel with no surrounding log noise.",
            "Host-to-runner stdin delivery through xcodebuild.",
            "A clean real-device equivalent for the shared file ingress path.",
        ],
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
  local command_path="${RUNTIME_CONTROL_DIR}/command-$(printf '%03d' "${sequence}").json"
  local file_response_path="${RUNTIME_CONTROL_DIR}/response-$(printf '%03d' "${sequence}").json"
  local stdout_response_path="${CONTROL_DIR}/stdout-response-$(printf '%03d' "${sequence}").json"

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

  local file_seen_at
  local stdout_seen_at
  file_seen_at="$(wait_for_file "${file_response_path}" "response ${sequence} file artifact" 20000 "${started_at}")"
  stdout_seen_at="$(wait_for_file "${stdout_response_path}" "response ${sequence} stdout artifact" 20000 "${started_at}")"

  local file_host_rtt_ms=$((file_seen_at - started_at))
  local stdout_host_rtt_ms=$((stdout_seen_at - started_at))

  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
    "${sequence}" \
    "${action}" \
    "${idle_gap_ms}" \
    "${file_host_rtt_ms}" \
    "${stdout_host_rtt_ms}" \
    "${file_response_path}" \
    "${stdout_response_path}" \
    >> "${COMMAND_METRICS_PATH}"

  RESPONSE_PATH="${file_response_path}" STDOUT_RESPONSE_PATH="${stdout_response_path}" FILE_HOST_RTT_MS="${file_host_rtt_ms}" STDOUT_HOST_RTT_MS="${stdout_host_rtt_ms}" /usr/bin/python3 - <<'PY'
import json
import os

response = json.loads(open(os.environ["RESPONSE_PATH"]).read())
stdout_event = json.loads(open(os.environ["STDOUT_RESPONSE_PATH"]).read())
print(
    "PROBE_METRIC transport_boundary sequence={sequence} action={action} file_host_rtt_ms={file_host_rtt_ms} stdout_host_rtt_ms={stdout_host_rtt_ms} stdout_minus_file_ms={delta} stdout_observed_at={observed_at}".format(
        sequence=response["sequence"],
        action=response["action"],
        file_host_rtt_ms=os.environ["FILE_HOST_RTT_MS"],
        stdout_host_rtt_ms=os.environ["STDOUT_HOST_RTT_MS"],
        delta=int(os.environ["STDOUT_HOST_RTT_MS"]) - int(os.environ["FILE_HOST_RTT_MS"]),
        observed_at=stdout_event["hostObservedAt"],
    )
)
PY
}

SIMULATOR_UDID="$(resolve_udid)"
DESTINATION="platform=iOS Simulator,id=${SIMULATOR_UDID}"
BOOTSTRAP_PATH="${BOOTSTRAP_ROOT}/${SIMULATOR_UDID}.json"

mkdir -p "${CONTROL_DIR}"
mkdir -p "$(dirname "${SUMMARY_PATH}")"
: > "${COMMAND_METRICS_PATH}"
rm -rf "${RESULT_BUNDLE_PATH}"
write_bootstrap_json "${BOOTSTRAP_PATH}" "${RUNTIME_CONTROL_DIR}" "${SIMULATOR_UDID}"

printf 'Using simulator UDID: %s\n' "${SIMULATOR_UDID}"
printf 'Using DerivedData: %s\n' "${DERIVED_DATA_PATH}"
printf 'Using result bundle: %s\n' "${RESULT_BUNDLE_PATH}"
printf 'Using control dir: %s\n' "${CONTROL_DIR}"
printf 'Using runner bootstrap: %s\n' "${BOOTSTRAP_PATH}"
printf 'Using xcodebuild log: %s\n' "${LOG_PATH}"
printf 'Writing summary to: %s\n' "${SUMMARY_PATH}"

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

SESSION_STARTED_AT="$(now_ms)"
/usr/bin/python3 "${SESSION_RUNNER_SCRIPT}" \
  --control-dir "${CONTROL_DIR}" \
  --log-path "${LOG_PATH}" \
  --stdout-events-path "${STDOUT_EVENTS_PATH}" \
  --stdin-probe-payload "host-stdin-probe" \
  -- \
  xcodebuild \
    -project "${PROJECT_PATH}" \
    -scheme "${SCHEME}" \
    -destination "${DESTINATION}" \
    -derivedDataPath "${DERIVED_DATA_PATH}" \
    -resultBundlePath "${RESULT_BUNDLE_PATH}" \
    CODE_SIGNING_ALLOWED=NO \
    test-without-building \
    -only-testing:ProbeRunnerUITests/AttachControlSpikeUITests/testCommandLoopTransportBoundary &
XCODEBUILD_PID="$!"

READY_STDOUT_SEEN_MS="$(wait_for_file "${STDOUT_READY_PATH}" "runner ready stdout frame" 120000 "${SESSION_STARTED_AT}")"
RUNTIME_CONTROL_DIR="$(STDOUT_READY_PATH="${STDOUT_READY_PATH}" /usr/bin/python3 - <<'PY'
import json
import os

print(json.loads(open(os.environ["STDOUT_READY_PATH"]).read())["controlDirectoryPath"])
PY
)"
READY_PATH="${RUNTIME_CONTROL_DIR}/ready.json"
READY_FILE_SEEN_MS="$(wait_for_file "${READY_PATH}" "runner ready file" 120000 "${SESSION_STARTED_AT}")"
STDIN_PROBE_SEEN_MS="$(wait_for_file "${STDIN_PROBE_PATH}" "stdin probe frame" 120000 "${SESSION_STARTED_AT}")"

printf 'PROBE_METRIC transport_ready file_startup_ms=%s stdout_startup_ms=%s stdout_minus_file_ms=%s stdin_probe_seen_ms=%s\n' \
  "$((READY_FILE_SEEN_MS - SESSION_STARTED_AT))" \
  "$((READY_STDOUT_SEEN_MS - SESSION_STARTED_AT))" \
  "$((READY_STDOUT_SEEN_MS - READY_FILE_SEEN_MS))" \
  "$((STDIN_PROBE_SEEN_MS - SESSION_STARTED_AT))"

send_command 1 ping boundary-probe-1 0
send_command 2 ping boundary-probe-2 1000
send_command 3 snapshot __PROBE_NULL__ 1000
send_command 4 ping boundary-probe-3 1000
send_command 5 shutdown __PROBE_NULL__ 0

set +e
wait "${XCODEBUILD_PID}"
XCODEBUILD_EXIT_CODE="$?"
set -e

if [[ "${XCODEBUILD_EXIT_CODE}" -ne 0 ]]; then
  printf 'xcodebuild test-without-building exited with %s\n' "${XCODEBUILD_EXIT_CODE}" >&2
  exit "${XCODEBUILD_EXIT_CODE}"
fi

XCODEBUILD_PID=""
emit_summary "${READY_FILE_SEEN_MS}" "${READY_STDOUT_SEEN_MS}"

printf 'Transport boundary summary written to %s\n' "${SUMMARY_PATH}"
