#!/usr/bin/env python3

from __future__ import annotations

import argparse
import json
import os
import signal
import subprocess
import sys
import threading
import time
from datetime import datetime, timezone
from pathlib import Path


def iso_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def write_json(path: Path, value: dict) -> None:
    path.write_text(json.dumps(value, indent=2) + "\n")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--control-dir", required=True)
    parser.add_argument("--destination")
    parser.add_argument("--log-path", required=True)
    parser.add_argument("--stdout-events-path", required=True)
    parser.add_argument("--stdin-probe-payload", required=False, default=None)
    parser.add_argument("command", nargs=argparse.REMAINDER)
    args = parser.parse_args()

    command = list(args.command)
    if command and command[0] == "--":
        command = command[1:]
    if not command:
        raise SystemExit("Missing command to execute.")

    if args.destination:
        if Path(command[0]).name != "xcodebuild":
            raise SystemExit("--destination currently requires an xcodebuild command.")

        if "-destination" in command:
            raise SystemExit(
                "Provide either --destination or an explicit xcodebuild -destination, not both."
            )

        command = [command[0], "-destination", args.destination, *command[1:]]

    control_dir = Path(args.control_dir)
    control_dir.mkdir(parents=True, exist_ok=True)
    log_path = Path(args.log_path)
    log_path.parent.mkdir(parents=True, exist_ok=True)
    stdout_events_path = Path(args.stdout_events_path)
    stdout_events_path.parent.mkdir(parents=True, exist_ok=True)

    process = subprocess.Popen(
        command,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
        env=os.environ.copy(),
    )

    def forward_stdin() -> None:
        """Forward host stdin lines to xcodebuild stdin."""
        try:
            for line in sys.stdin:
                if process.poll() is not None:
                    break
                try:
                    process.stdin.write(line)
                    process.stdin.flush()
                except (BrokenPipeError, OSError):
                    break
        except Exception:
            pass

    stdin_thread = threading.Thread(target=forward_stdin, daemon=True)
    stdin_thread.start()

    def forward_signal(signum: int, _frame: object) -> None:
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
        raise SystemExit(128 + signum)

    signal.signal(signal.SIGTERM, forward_signal)
    signal.signal(signal.SIGINT, forward_signal)

    ready_path = control_dir / "stdout-ready.json"
    stdin_probe_path = control_dir / "stdout-stdin-probe-result.json"

    if process.stdout is None:
        raise SystemExit("xcodebuild stdout pipe was not created")

    if process.stdin is None:
        raise SystemExit("xcodebuild stdin pipe was not created")

    with (
        log_path.open("w", encoding="utf-8") as log_file,
        stdout_events_path.open("w", encoding="utf-8") as stdout_events_file,
    ):
        for raw_line in process.stdout:
            log_file.write(raw_line)
            log_file.flush()
            sys.stdout.write(raw_line)
            sys.stdout.flush()

            text = raw_line.strip()
            if not text.startswith("{"):
                continue

            try:
                frame = json.loads(text)
            except json.JSONDecodeError:
                continue

            event = dict(frame)
            event["hostObservedAt"] = iso_now()
            stdout_events_file.write(json.dumps(event) + "\n")
            stdout_events_file.flush()

            kind = event.get("kind")
            if kind == "ready":
                write_json(ready_path, event)
                # Stdin probe is now sent by the host through the forwarded stdin pipe.
            elif kind == "stdin-probe-result":
                write_json(stdin_probe_path, event)
            elif kind == "response":
                sequence = event.get("sequence")
                if isinstance(sequence, int):
                    write_json(
                        control_dir / f"stdout-response-{sequence:03d}.json", event
                    )

    return process.wait()


if __name__ == "__main__":
    raise SystemExit(main())
