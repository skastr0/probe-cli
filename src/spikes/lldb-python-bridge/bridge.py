#!/usr/bin/env python3

from __future__ import annotations

import json
import os
import signal
import subprocess
import sys
from dataclasses import dataclass
from typing import Any


def _resolve_lldb_python_path() -> str:
    override = os.environ.get("PROBE_LLDB_PYTHON_PATH")
    if override:
        return override

    lldb_binary_candidates = []

    try:
        xcrun_result = subprocess.run(
            ["xcrun", "--find", "lldb"],
            check=True,
            capture_output=True,
            text=True,
        )
        lldb_binary_candidates.append(xcrun_result.stdout.strip())
    except Exception:
        pass

    lldb_binary_candidates.append("lldb")

    for candidate in lldb_binary_candidates:
        if not candidate:
            continue

        try:
            result = subprocess.run(
                [candidate, "-P"],
                check=True,
                capture_output=True,
                text=True,
            )
            path = result.stdout.strip()
            if path:
                return path
        except Exception:
            continue

    raise RuntimeError(
        "Unable to resolve the LLDB Python module path. Set PROBE_LLDB_PYTHON_PATH or ensure `lldb -P` works."
    )


LLDB_PYTHON_PATH = _resolve_lldb_python_path()
if LLDB_PYTHON_PATH not in sys.path:
    sys.path.insert(0, LLDB_PYTHON_PATH)

import lldb  # type: ignore  # noqa: E402


def _write_frame(value: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(value) + "\n")
    sys.stdout.flush()


def _state_name(state: int) -> str:
    names = {
        lldb.eStateInvalid: "invalid",
        lldb.eStateUnloaded: "unloaded",
        lldb.eStateConnected: "connected",
        lldb.eStateAttaching: "attaching",
        lldb.eStateLaunching: "launching",
        lldb.eStateStopped: "stopped",
        lldb.eStateRunning: "running",
        lldb.eStateStepping: "stepping",
        lldb.eStateCrashed: "crashed",
        lldb.eStateDetached: "detached",
        lldb.eStateExited: "exited",
        lldb.eStateSuspended: "suspended",
    }
    return names.get(state, f"unknown-{state}")


def _stop_reason_name(reason: int) -> str:
    names = {
        lldb.eStopReasonInvalid: "invalid",
        lldb.eStopReasonNone: "none",
        lldb.eStopReasonTrace: "trace",
        lldb.eStopReasonBreakpoint: "breakpoint",
        lldb.eStopReasonWatchpoint: "watchpoint",
        lldb.eStopReasonSignal: "signal",
        lldb.eStopReasonException: "exception",
        lldb.eStopReasonExec: "exec",
        lldb.eStopReasonPlanComplete: "plan-complete",
        lldb.eStopReasonThreadExiting: "thread-exiting",
        lldb.eStopReasonInstrumentation: "instrumentation",
    }
    return names.get(reason, f"unknown-{reason}")


def _line_entry(frame: lldb.SBFrame) -> dict[str, Any] | None:
    entry = frame.GetLineEntry()
    if not entry.IsValid():
        return None

    file_spec = entry.GetFileSpec()
    return {
        "file": file_spec.fullpath or file_spec.GetFilename(),
        "line": entry.GetLine(),
        "column": entry.GetColumn(),
    }


def _value_to_dict(
    value: lldb.SBValue, depth: int = 0, max_depth: int = 1
) -> dict[str, Any]:
    child_count = value.GetNumChildren()
    payload: dict[str, Any] = {
        "name": value.GetName(),
        "type": value.GetTypeName(),
        "value": value.GetValue(),
        "summary": value.GetSummary(),
        "numChildren": child_count,
        "valueText": value.GetSummary() or value.GetValue(),
    }

    error = value.GetError()
    if error.IsValid() and not error.Success():
        payload["error"] = error.GetCString()

    if depth < max_depth and child_count > 0:
        payload["children"] = [
            _value_to_dict(value.GetChildAtIndex(index), depth + 1, max_depth)
            for index in range(child_count)
        ]

    return payload


def _frame_to_dict(frame: lldb.SBFrame) -> dict[str, Any]:
    return {
        "frameId": frame.GetFrameID(),
        "pc": frame.GetPC(),
        "function": frame.GetFunctionName(),
        "displayFunction": frame.GetDisplayFunctionName(),
        "module": frame.GetModule().GetFileSpec().GetFilename(),
        "lineEntry": _line_entry(frame),
        "isArtificial": frame.IsArtificial(),
        "isHidden": frame.IsHidden(),
        "isInlined": frame.IsInlined(),
    }


def _thread_to_dict(
    thread: lldb.SBThread, frame_limit: int | None = None
) -> dict[str, Any]:
    frame_count = thread.GetNumFrames()
    limit = frame_count if frame_limit is None else min(frame_limit, frame_count)

    return {
        "threadId": thread.GetThreadID(),
        "indexId": thread.GetIndexID(),
        "name": thread.GetName(),
        "queue": thread.GetQueueName(),
        "stopReason": _stop_reason_name(thread.GetStopReason()),
        "stopDescription": thread.GetStopDescription(256),
        "frames": [
            _frame_to_dict(thread.GetFrameAtIndex(index)) for index in range(limit)
        ],
    }


def _process_snapshot(process: lldb.SBProcess, frame_limit: int = 8) -> dict[str, Any]:
    selected_thread = process.GetSelectedThread()
    return {
        "pid": process.GetProcessID(),
        "state": _state_name(process.GetState()),
        "stopId": process.GetStopID(True),
        "numThreads": process.GetNumThreads(),
        "selectedThread": {
            "threadId": selected_thread.GetThreadID(),
            "indexId": selected_thread.GetIndexID(),
            "stopReason": _stop_reason_name(selected_thread.GetStopReason()),
        }
        if selected_thread.IsValid()
        else None,
        "threads": [
            _thread_to_dict(process.GetThreadAtIndex(index), frame_limit)
            for index in range(process.GetNumThreads())
        ],
    }


def _success_response(
    request_id: Any, command: str, payload: dict[str, Any]
) -> dict[str, Any]:
    return {
        "kind": "response",
        "id": request_id,
        "command": command,
        "ok": True,
        **payload,
    }


def _error_response(request_id: Any, command: str, error: str) -> dict[str, Any]:
    return {
        "kind": "response",
        "id": request_id,
        "command": command,
        "ok": False,
        "error": error,
    }


@dataclass
class BridgeSession:
    debugger: lldb.SBDebugger
    target: lldb.SBTarget | None = None
    process: lldb.SBProcess | None = None

    def close_current_process(self) -> None:
        if self.process is not None and self.process.IsValid():
            state = self.process.GetState()
            if state not in (
                lldb.eStateDetached,
                lldb.eStateExited,
                lldb.eStateInvalid,
            ):
                self.process.Detach()

        self.target = None
        self.process = None

    def shutdown(self) -> None:
        self.close_current_process()

    def _require_process(self) -> lldb.SBProcess:
        if self.process is None or not self.process.IsValid():
            raise RuntimeError("No attached process.")
        return self.process

    def _resolve_thread(
        self, process: lldb.SBProcess, thread_index_id: int | None
    ) -> lldb.SBThread:
        if thread_index_id is None:
            thread = process.GetSelectedThread()
            if thread.IsValid():
                return thread
            if process.GetNumThreads() == 0:
                raise RuntimeError("The attached process has no threads.")
            return process.GetThreadAtIndex(0)

        for index in range(process.GetNumThreads()):
            thread = process.GetThreadAtIndex(index)
            if thread.GetIndexID() == thread_index_id:
                return thread

        raise RuntimeError(f"Thread index id {thread_index_id} was not found.")

    def _resolve_frame(
        self,
        process: lldb.SBProcess,
        thread_index_id: int | None,
        frame_index: int | None,
    ) -> lldb.SBFrame:
        thread = self._resolve_thread(process, thread_index_id)
        index = frame_index or 0
        if index < 0 or index >= thread.GetNumFrames():
            raise RuntimeError(
                f"Frame index {index} is out of range for thread index id {thread.GetIndexID()}."
            )
        return thread.GetFrameAtIndex(index)

    def attach(self, pid: int) -> dict[str, Any]:
        self.close_current_process()

        self.target = self.debugger.CreateTarget(None)
        error = lldb.SBError()
        self.process = self.target.AttachToProcessWithID(
            self.debugger.GetListener(), pid, error
        )
        if not error.Success() or self.process is None or not self.process.IsValid():
            self.target = None
            self.process = None
            raise RuntimeError(error.GetCString() or f"Attach to pid {pid} failed.")

        return {
            "process": _process_snapshot(self.process),
        }

    def backtrace(
        self, thread_index_id: int | None, frame_limit: int
    ) -> dict[str, Any]:
        process = self._require_process()
        thread = self._resolve_thread(process, thread_index_id)
        return {
            "process": {
                "pid": process.GetProcessID(),
                "state": _state_name(process.GetState()),
                "stopId": process.GetStopID(True),
            },
            "thread": _thread_to_dict(thread, frame_limit),
        }

    def vars(
        self, thread_index_id: int | None, frame_index: int | None
    ) -> dict[str, Any]:
        process = self._require_process()
        frame = self._resolve_frame(process, thread_index_id, frame_index)
        values = frame.GetVariables(True, True, True, True)
        return {
            "process": {
                "pid": process.GetProcessID(),
                "state": _state_name(process.GetState()),
                "stopId": process.GetStopID(True),
            },
            "frame": _frame_to_dict(frame),
            "variables": [
                _value_to_dict(values.GetValueAtIndex(index))
                for index in range(values.GetSize())
            ],
        }

    def evaluate(
        self,
        expression: str,
        thread_index_id: int | None,
        frame_index: int | None,
        timeout_ms: int,
    ) -> dict[str, Any]:
        process = self._require_process()
        frame = self._resolve_frame(process, thread_index_id, frame_index)

        options = lldb.SBExpressionOptions()
        options.SetTimeoutInMicroSeconds(timeout_ms * 1_000)
        options.SetOneThreadTimeoutInMicroSeconds(timeout_ms * 1_000)
        options.SetTryAllThreads(False)
        options.SetTrapExceptions(True)
        options.SetUnwindOnError(True)
        options.SetIgnoreBreakpoints(False)
        options.SetStopOthers(True)
        options.SetSuppressPersistentResult(True)

        value = frame.EvaluateExpression(expression, options)
        error = value.GetError()
        if error.IsValid() and not error.Success():
            raise RuntimeError(error.GetCString() or f"Expression failed: {expression}")

        return {
            "process": {
                "pid": process.GetProcessID(),
                "state": _state_name(process.GetState()),
                "stopId": process.GetStopID(True),
            },
            "frame": _frame_to_dict(frame),
            "expression": expression,
            "result": _value_to_dict(value),
            "options": {
                "timeoutMs": timeout_ms,
                "tryAllThreads": False,
                "trapExceptions": True,
                "unwindOnError": True,
                "ignoreBreakpoints": False,
                "stopOthers": True,
                "suppressPersistentResult": True,
            },
        }

    def continue_process(self) -> dict[str, Any]:
        process = self._require_process()
        error = process.Continue()
        if not error.Success():
            raise RuntimeError(error.GetCString() or "Continue failed.")
        return {"process": _process_snapshot(process)}

    def detach(self) -> dict[str, Any]:
        process = self._require_process()
        error = process.Detach()
        if not error.Success():
            raise RuntimeError(error.GetCString() or "Detach failed.")
        pid = process.GetProcessID()
        self.target = None
        self.process = None
        return {"pid": pid, "state": "detached"}


def main() -> int:
    lldb.SBDebugger.Initialize()
    debugger = lldb.SBDebugger.Create(False)
    debugger.SetAsync(False)

    session = BridgeSession(debugger=debugger)

    def _graceful_exit(_signum: int, _frame: object) -> None:
        session.shutdown()
        lldb.SBDebugger.Destroy(debugger)
        lldb.SBDebugger.Terminate()
        raise SystemExit(0)

    signal.signal(signal.SIGINT, _graceful_exit)
    signal.signal(signal.SIGTERM, _graceful_exit)

    _write_frame(
        {
            "kind": "ready",
            "bridgePid": os.getpid(),
            "pythonExecutable": sys.executable,
            "lldbPythonPath": LLDB_PYTHON_PATH,
            "lldbVersion": lldb.SBDebugger.GetVersionString(),
            "initFilesSkipped": True,
            "asyncMode": False,
        }
    )

    try:
        for raw_line in sys.stdin:
            text = raw_line.strip()
            if not text:
                continue

            request_id: Any = None
            command = "unknown"

            try:
                request = json.loads(text)
                request_id = request.get("id")
                command = str(request.get("command") or "")

                if command == "handshake":
                    response = _success_response(
                        request_id,
                        command,
                        {
                            "bridgePid": os.getpid(),
                            "pythonExecutable": sys.executable,
                            "lldbPythonPath": LLDB_PYTHON_PATH,
                            "lldbVersion": lldb.SBDebugger.GetVersionString(),
                        },
                    )
                elif command == "attach":
                    response = _success_response(
                        request_id, command, session.attach(int(request["pid"]))
                    )
                elif command == "backtrace":
                    response = _success_response(
                        request_id,
                        command,
                        session.backtrace(
                            request.get("threadIndexId"),
                            int(request.get("frameLimit", 12)),
                        ),
                    )
                elif command == "vars":
                    response = _success_response(
                        request_id,
                        command,
                        session.vars(
                            request.get("threadIndexId"), request.get("frameIndex")
                        ),
                    )
                elif command == "eval":
                    response = _success_response(
                        request_id,
                        command,
                        session.evaluate(
                            str(request["expression"]),
                            request.get("threadIndexId"),
                            request.get("frameIndex"),
                            int(request.get("timeoutMs", 500)),
                        ),
                    )
                elif command == "continue":
                    response = _success_response(
                        request_id, command, session.continue_process()
                    )
                elif command == "detach":
                    response = _success_response(request_id, command, session.detach())
                elif command == "shutdown":
                    response = _success_response(
                        request_id, command, {"state": "shutting-down"}
                    )
                    _write_frame(response)
                    break
                else:
                    response = _error_response(
                        request_id, command, f"Unknown command: {command}"
                    )
            except (
                Exception
            ) as error:  # pragma: no cover - command errors are data-plane results
                response = _error_response(request_id, command, str(error))

            _write_frame(response)
    finally:
        session.shutdown()
        lldb.SBDebugger.Destroy(debugger)
        lldb.SBDebugger.Terminate()

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
