#!/usr/bin/env python3

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
import xml.etree.ElementTree as ET


REPO_ROOT = Path(__file__).resolve().parents[2]
KNOWLEDGE_DIR = REPO_ROOT / "knowledge" / "xctrace-instruments"
FIXTURE_VALIDATE_SCRIPT = (
    REPO_ROOT / "ios" / "ProbeFixture" / "scripts" / "validate-simulator.sh"
)
FIXTURE_BUNDLE_ID = "dev.probe.fixture"

TEMPLATES: list[dict[str, Any]] = [
    {
        "name": "Time Profiler",
        "slug": "time-profiler",
        "expected_status": "success",
        "schema_queries": [
            "time-profile",
            "time-sample",
        ],
    },
    {
        "name": "Metal System Trace",
        "slug": "metal-system-trace",
        "expected_status": "success",
        "schema_queries": [
            "metal-driver-event-intervals",
            "metal-gpu-intervals",
            "metal-application-encoders-list",
        ],
    },
    {
        "name": "Swift Concurrency",
        "slug": "swift-concurrency",
        "expected_status": "success",
        "schema_queries": [
            "swift-task-lifetime",
            "swift-task-state",
            "swift-actor-execution",
        ],
    },
    {
        "name": "Logging",
        "slug": "logging",
        "expected_status": "success",
        "schema_queries": [
            "os-log",
            "os-signpost",
        ],
    },
    {
        "name": "System Trace",
        "slug": "system-trace",
        "expected_status": "success",
        "schema_queries": [
            "thread-state",
            "cpu-state",
            "runloop-events",
        ],
    },
    {
        "name": "Network",
        "slug": "network",
        "expected_status": "expected-simulator-failure",
        "schema_queries": [
            "com-apple-cfnetwork-transaction-intervals",
            "network-connection-detected",
        ],
    },
]


def iso_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def run_command(
    command: list[str],
    *,
    cwd: Path | None = None,
    env: dict[str, str] | None = None,
    timeout: int | None = None,
) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        command,
        cwd=str(cwd) if cwd else None,
        env=env,
        text=True,
        capture_output=True,
        timeout=timeout,
        check=False,
    )


def resolve_simulator_udid() -> str:
    explicit = os.environ.get("PROBE_FIXTURE_SIMULATOR_UDID")
    if explicit:
        return explicit

    result = run_command(
        ["xcrun", "simctl", "list", "devices", "available", "-j"], cwd=REPO_ROOT
    )
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip() or "Failed to list simulators")

    devices = json.loads(result.stdout).get("devices", {})
    for runtime_name, runtime_devices in devices.items():
        if "iOS" not in runtime_name:
            continue
        for device in runtime_devices:
            if device.get("isAvailable") and device.get("name", "").startswith(
                "iPhone"
            ):
                return str(device["udid"])

    raise RuntimeError("No available iPhone simulator found")


def boot_simulator(udid: str) -> None:
    result = run_command(
        ["xcrun", "simctl", "bootstatus", udid, "-b"], cwd=REPO_ROOT, timeout=300
    )
    if result.returncode != 0:
        raise RuntimeError(
            result.stderr.strip() or result.stdout.strip() or "Failed to boot simulator"
        )


def build_install_fixture() -> dict[str, Any]:
    result = run_command([str(FIXTURE_VALIDATE_SCRIPT)], cwd=REPO_ROOT, timeout=1800)
    if result.returncode != 0:
        raise RuntimeError(
            result.stderr.strip()
            or result.stdout.strip()
            or "Fixture validation failed"
        )

    launch_match = re.search(r"Launch result:\s*(.+)$", result.stdout, re.MULTILINE)
    derived_data_match = re.search(
        r"Using DerivedData:\s*(.+)$", result.stdout, re.MULTILINE
    )
    app_path_match = re.search(r"Installed app:\s*(.+)$", result.stdout, re.MULTILINE)

    return {
        "stdout": result.stdout,
        "stderr": result.stderr,
        "derived_data_path": derived_data_match.group(1).strip()
        if derived_data_match
        else None,
        "app_path": app_path_match.group(1).strip() if app_path_match else None,
        "launch_result": launch_match.group(1).strip() if launch_match else None,
    }


def launch_fixture(udid: str) -> dict[str, Any]:
    run_command(
        ["xcrun", "simctl", "terminate", udid, FIXTURE_BUNDLE_ID], cwd=REPO_ROOT
    )
    result = run_command(
        ["xcrun", "simctl", "launch", udid, FIXTURE_BUNDLE_ID], cwd=REPO_ROOT
    )
    if result.returncode != 0:
        raise RuntimeError(
            result.stderr.strip() or result.stdout.strip() or "Fixture launch failed"
        )

    match = re.search(r":\s*(\d+)\s*$", result.stdout.strip())
    if not match:
        raise RuntimeError(
            f"Unable to parse pid from simctl launch output: {result.stdout!r}"
        )

    return {
        "output": result.stdout.strip(),
        "pid": int(match.group(1)),
    }


def export_toc(trace_path: Path, destination: Path) -> ET.Element:
    result = run_command(
        ["xcrun", "xctrace", "export", "--input", str(trace_path), "--toc"],
        cwd=REPO_ROOT,
        timeout=1800,
    )
    if result.returncode != 0:
        raise RuntimeError(
            result.stderr.strip()
            or result.stdout.strip()
            or f"Failed to export TOC for {trace_path}"
        )

    destination.write_text(result.stdout, encoding="utf-8")
    return ET.fromstring(result.stdout)


def capture_schema_excerpt(trace_path: Path, schema_name: str) -> dict[str, Any]:
    xpath = f'/trace-toc/run[@number="1"]/data/table[@schema="{schema_name}"]'
    proc = subprocess.Popen(
        [
            "xcrun",
            "xctrace",
            "export",
            "--input",
            str(trace_path),
            "--xpath",
            xpath,
        ],
        cwd=str(REPO_ROOT),
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )

    assert proc.stdout is not None
    assert proc.stderr is not None

    buffer = ""
    while True:
        chunk = proc.stdout.read(4096)
        if not chunk:
            break
        buffer += chunk
        if "</schema>" in buffer:
            if "<row" not in buffer:
                for _ in range(8):
                    extra = proc.stdout.read(4096)
                    if not extra:
                        break
                    buffer += extra
                    if "<row" in buffer:
                        break
            proc.terminate()
            try:
                proc.wait(timeout=2)
            except subprocess.TimeoutExpired:
                proc.kill()
            break

    stderr_output = proc.stderr.read()
    if "<schema" not in buffer:
        return {
            "schema": schema_name,
            "xpath": xpath,
            "columns": [],
            "has_rows": False,
            "error": stderr_output.strip() or "No schema fragment captured",
        }

    schema_fragment = buffer[
        buffer.index("<schema") : buffer.index("</schema>") + len("</schema>")
    ]
    schema_element = ET.fromstring(schema_fragment)

    columns = []
    for col in schema_element.findall("col"):
        columns.append(
            {
                "mnemonic": (col.findtext("mnemonic") or "").strip(),
                "name": (col.findtext("name") or "").strip(),
                "engineering_type": (col.findtext("engineering-type") or "").strip(),
            }
        )

    return {
        "schema": schema_name,
        "xpath": xpath,
        "columns": columns,
        "has_rows": "<row" in buffer,
        "error": stderr_output.strip() or None,
    }


def summarize_tables(toc_root: ET.Element) -> list[dict[str, Any]]:
    tables = []
    for table in toc_root.findall("./run/data/table"):
        table_summary = {"schema": table.attrib.get("schema", "")}
        extra_attrs = {k: v for k, v in table.attrib.items() if k != "schema"}
        if extra_attrs:
            table_summary["attributes"] = extra_attrs
        tables.append(table_summary)
    return tables


def main() -> int:
    generated_at = iso_now()
    simulator_udid = resolve_simulator_udid()
    boot_simulator(simulator_udid)

    fixture_setup = build_install_fixture()
    fixture_launch = launch_fixture(simulator_udid)

    trace_root = Path(tempfile.mkdtemp(prefix="probe-xctrace-schema-spike."))

    xcode_version = run_command(["xcodebuild", "-version"], cwd=REPO_ROOT)
    xctrace_version = run_command(["xcrun", "xctrace", "version"], cwd=REPO_ROOT)

    results: dict[str, Any] = {
        "generatedAt": generated_at,
        "xcodeVersion": xcode_version.stdout.strip(),
        "xctraceVersion": xctrace_version.stdout.strip(),
        "simulatorUdid": simulator_udid,
        "fixtureBundleId": FIXTURE_BUNDLE_ID,
        "fixturePid": fixture_launch["pid"],
        "fixtureLaunchOutput": fixture_launch["output"],
        "fixtureSetup": {
            "derivedDataPath": fixture_setup["derived_data_path"],
            "appPath": fixture_setup["app_path"],
            "launchResult": fixture_setup["launch_result"],
        },
        "traceRoot": str(trace_root),
        "templates": [],
    }

    try:
        for template in TEMPLATES:
            slug = template["slug"]
            trace_path = trace_root / f"{slug}.trace"
            if trace_path.exists():
                if trace_path.is_dir():
                    shutil.rmtree(trace_path)
                else:
                    trace_path.unlink()

            record_command = [
                "xcrun",
                "xctrace",
                "record",
                "--template",
                template["name"],
                "--device",
                simulator_udid,
                "--attach",
                str(fixture_launch["pid"]),
                "--time-limit",
                "5s",
                "--output",
                str(trace_path),
                "--no-prompt",
            ]

            record_result = run_command(record_command, cwd=REPO_ROOT, timeout=1800)
            toc_path = KNOWLEDGE_DIR / f"fixture-{slug}.toc.xml"
            toc_root = export_toc(trace_path, toc_path)

            schema_excerpts = []
            for schema_name in template["schema_queries"]:
                schema_excerpts.append(capture_schema_excerpt(trace_path, schema_name))

            results["templates"].append(
                {
                    "templateName": template["name"],
                    "slug": slug,
                    "expectedStatus": template["expected_status"],
                    "tracePath": str(trace_path),
                    "tocPath": str(toc_path.relative_to(REPO_ROOT)),
                    "recordExitCode": record_result.returncode,
                    "recordStdout": record_result.stdout.strip(),
                    "recordStderr": record_result.stderr.strip(),
                    "tableCount": len(toc_root.findall("./run/data/table")),
                    "tables": summarize_tables(toc_root),
                    "schemaExcerpts": schema_excerpts,
                }
            )
    finally:
        terminate_result = run_command(
            ["xcrun", "simctl", "terminate", simulator_udid, FIXTURE_BUNDLE_ID],
            cwd=REPO_ROOT,
        )
        results["fixtureTerminate"] = {
            "exitCode": terminate_result.returncode,
            "stdout": terminate_result.stdout.strip(),
            "stderr": terminate_result.stderr.strip(),
        }

    output_path = KNOWLEDGE_DIR / "schema-spike-results.json"
    output_path.write_text(json.dumps(results, indent=2) + "\n", encoding="utf-8")

    print(str(output_path.relative_to(REPO_ROOT)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
