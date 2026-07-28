import { spawn } from "node:child_process"
import { mkdtemp, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

/**
 * Batch-symbolicate program counters with `xcrun atos`.
 *
 * MVP for Probe time-profiler leaf PCs: pass the target .app binary or dSYM
 * and the leaf addresses from `cp-user-callstack`. Without a correct load
 * address (`-l`) device slides may miss — we still return best-effort names
 * and leave unresolved PCs as empty strings so callers can keep the raw hex.
 */
export const symbolicateAddressesWithAtos = async (args: {
  readonly binaryPath: string
  readonly addresses: ReadonlyArray<string>
  readonly arch?: string
  readonly loadAddress?: string
  readonly timeoutMs?: number
}): Promise<ReadonlyMap<string, string>> => {
  const addresses = [...new Set(args.addresses.map((a) => a.toLowerCase()).filter((a) => /^0x[0-9a-f]+$/i.test(a)))]
  if (addresses.length === 0) {
    return new Map()
  }

  const dir = await mkdtemp(join(tmpdir(), "probe-atos-"))
  const inputPath = join(dir, "addrs.txt")
  await writeFile(inputPath, `${addresses.join("\n")}\n`, "utf8")

  const commandArgs = [
    "atos",
    "-o",
    args.binaryPath,
    "-arch",
    args.arch ?? "arm64",
    ...(args.loadAddress ? ["-l", args.loadAddress] : []),
    "-f",
    inputPath,
  ]

  try {
    const stdout = await runProcess("xcrun", commandArgs, args.timeoutMs ?? 15_000)
    const lines = stdout.split(/\r?\n/).filter((line) => line.trim().length > 0)
    const symbols = new Map<string, string>()

    for (let i = 0; i < addresses.length; i += 1) {
      const address = addresses[i]!
      const line = lines[i]?.trim()
      if (!line || line === address || line.startsWith("0x")) {
        // Unresolved — atos often echoes the address or returns "0x…".
        continue
      }
      symbols.set(address, line)
    }

    return symbols
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined)
  }
}

/** Resolve a binary path from the environment for optional symbolication. */
export const resolveAtosBinaryPath = (): string | null => {
  const candidates = [
    process.env.PROBE_PERF_BINARY,
    process.env.PROBE_ATOS_BINARY,
  ]
  for (const candidate of candidates) {
    if (candidate && candidate.trim().length > 0) {
      return candidate.trim()
    }
  }
  return null
}

const runProcess = (command: string, commandArgs: ReadonlyArray<string>, timeoutMs: number): Promise<string> =>
  new Promise((resolve, reject) => {
    const child = spawn(command, [...commandArgs], { stdio: ["ignore", "pipe", "pipe"] })
    let stdout = ""
    let stderr = ""
    const timer = setTimeout(() => {
      child.kill("SIGTERM")
      reject(new Error(`${command} timed out after ${timeoutMs}ms`))
    }, timeoutMs)

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8")
    })
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8")
    })
    child.on("error", (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on("close", (code) => {
      clearTimeout(timer)
      if (code === 0) {
        resolve(stdout)
        return
      }
      reject(new Error(`${command} exited ${code}: ${stderr.trim() || stdout.trim()}`))
    })
  })
