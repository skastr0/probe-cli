import { describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { startLldbBridgeProcess } from "./LldbBridge"

// Real, non-mocked coverage of the AppleProcessSupervisor-backed migration --
// a fake python3 script speaks the same line-framed JSON-RPC protocol as the
// real LLDB bridge (see knowledge/lldb-python) without needing a real
// LLDB/Xcode Python environment.

/** Every pid currently alive in the process group led by `pgid` (best-effort, macOS/Linux `ps`). */
const processGroupMembers = (pgid: number): ReadonlyArray<number> => {
  try {
    const output = execFileSync("ps", ["-o", "pid=", "-g", String(pgid)], { encoding: "utf8" })
    return output
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map(Number)
  } catch {
    return []
  }
}

const withTempDir = async <T>(fn: (dir: string) => Promise<T>): Promise<T> => {
  const dir = await mkdtemp(join(tmpdir(), "lldb-bridge-process-helpers-"))
  try {
    return await fn(dir)
  } finally {
    await rm(dir, { force: true, recursive: true })
  }
}

/**
 * A fake bridge: prints a valid ready frame immediately, then answers every
 * request with a generic ok response -- except `shutdown`, which it
 * acknowledges and exits on, matching the real bridge's shutdown contract.
 */
const fakeBridgeScript = [
  "import sys, json, os",
  "print(json.dumps({",
  "  'kind': 'ready', 'bridgePid': os.getpid(), 'pythonExecutable': sys.executable,",
  "  'lldbPythonPath': '/fake', 'lldbVersion': 'lldb-fake-1.0',",
  "  'initFilesSkipped': True, 'asyncMode': False,",
  "}))",
  "sys.stdout.flush()",
  "for raw in sys.stdin:",
  "  line = raw.strip()",
  "  if not line:",
  "    continue",
  "  req = json.loads(line)",
  "  if req.get('command') == 'shutdown':",
  "    print(json.dumps({'kind': 'response', 'id': req['id'], 'ok': True, 'command': 'shutdown', 'state': 'shutting-down'}))",
  "    sys.stdout.flush()",
  "    break",
  "  print(json.dumps({",
  "    'kind': 'response', 'id': req['id'], 'ok': True, 'command': 'handshake',",
  "    'bridgePid': os.getpid(), 'pythonExecutable': sys.executable,",
  "    'lldbPythonPath': '/fake', 'lldbVersion': 'lldb-fake-1.0',",
  "  }))",
  "  sys.stdout.flush()",
].join("\n")

/**
 * A fake bridge that forks two real descendant processes and then never
 * responds to anything (including `shutdown`) -- deliberately, so `close()`'s
 * request-level shutdown attempt times out and falls through to the forced
 * `handle.stop("SIGTERM")` path while the bridge itself is still alive. That
 * keeps the process-group-kill assertion below deterministic: it exercises
 * the real TERM -> grace -> KILL ladder killing the whole group, not a race
 * between the bridge's own graceful exit and Node observing it.
 */
const fakeBridgeScriptWithUnresponsiveDescendants = [
  "import sys, json, os, time",
  "os.system('sleep 30 </dev/null >/dev/null 2>/dev/null & sleep 30 </dev/null >/dev/null 2>/dev/null &')",
  "print(json.dumps({",
  "  'kind': 'ready', 'bridgePid': os.getpid(), 'pythonExecutable': sys.executable,",
  "  'lldbPythonPath': '/fake', 'lldbVersion': 'lldb-fake-1.0',",
  "  'initFilesSkipped': True, 'asyncMode': False,",
  "}))",
  "sys.stdout.flush()",
  "while True:",
  "  time.sleep(0.05)",
].join("\n")

describe("LldbBridge process helpers (real spawn, via AppleProcessSupervisor)", () => {
  test("startLldbBridgeProcess completes the ready handshake and round-trips a request/response", async () => {
    await withTempDir(async (dir) => {
      const handle = await startLldbBridgeProcess({
        command: "/usr/bin/python3",
        commandArgs: ["-c", fakeBridgeScript],
        frameLogPath: join(dir, "frames.ndjson"),
        stderrLogPath: join(dir, "stderr.log"),
      })

      expect(handle.ready.kind).toBe("ready")
      expect(handle.ready.lldbVersion).toBe("lldb-fake-1.0")
      expect(handle.isRunning()).toBe(true)

      const response = await handle.send({ command: "handshake" })
      expect(response.ok).toBe(true)
      expect(response.command).toBe("handshake")

      await handle.close()
      expect(handle.isRunning()).toBe(false)

      const frameLogLines = (await readFile(join(dir, "frames.ndjson"), "utf8"))
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as { readonly kind: string })
      expect(frameLogLines[0]?.kind).toBe("ready")
      expect(frameLogLines.length).toBeGreaterThanOrEqual(3)
    })
  })

  test("close() leaves zero surviving descendants -- the piped-stdin bridge routes through the same TERM -> grace -> KILL ladder", async () => {
    await withTempDir(async (dir) => {
      const handle = await startLldbBridgeProcess({
        command: "/usr/bin/python3",
        commandArgs: ["-c", fakeBridgeScriptWithUnresponsiveDescendants],
        frameLogPath: join(dir, "frames.ndjson"),
        stderrLogPath: join(dir, "stderr.log"),
        readyTimeoutMs: 300,
        shutdownGracePeriodMs: 500,
      })

      // Give the fake bridge's `os.system` call time to actually fork.
      await new Promise((resolve) => setTimeout(resolve, 150))

      const bridgePid = handle.ready.kind === "ready" ? handle.ready.bridgePid : -1
      const membersBeforeClose = processGroupMembers(bridgePid)
      expect(membersBeforeClose.length).toBeGreaterThan(0)
      expect(handle.isRunning()).toBe(true)

      await handle.close()

      expect(handle.isRunning()).toBe(false)
      expect(processGroupMembers(bridgePid).length).toBe(0)
    })
  })

  test("close() is a no-op once the bridge has already exited", async () => {
    await withTempDir(async (dir) => {
      const handle = await startLldbBridgeProcess({
        command: "/usr/bin/python3",
        commandArgs: ["-c", fakeBridgeScript],
        frameLogPath: join(dir, "frames.ndjson"),
        stderrLogPath: join(dir, "stderr.log"),
      })

      await handle.send({ command: "shutdown" })
      await handle.waitForExit
      expect(handle.isRunning()).toBe(false)

      // Should resolve immediately without attempting another shutdown/signal.
      await handle.close()
    })
  })

  test("rejects when the process never sends a ready frame in time", async () => {
    await withTempDir(async (dir) => {
      await expect(
        startLldbBridgeProcess({
          command: "/bin/sh",
          // Short-lived on purpose: this rejection path (like the
          // pre-migration code) does not itself stop the child, matching
          // pre-existing behavior -- keep the leaked process brief instead of
          // a real long-lived one lingering past this test.
          commandArgs: ["-c", "sleep 1"],
          frameLogPath: join(dir, "frames.ndjson"),
          stderrLogPath: join(dir, "stderr.log"),
          readyTimeoutMs: 200,
        }),
      ).rejects.toThrow(/Timed out waiting for LLDB bridge frame/)
    })
  })
})
