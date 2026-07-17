import { spawnSync } from "node:child_process"

export interface CommandResult {
  readonly status: number | null
  readonly stdout: string
  readonly stderr: string
}

export type CommandRunner = (command: string, args: ReadonlyArray<string>, timeoutMs?: number) => CommandResult

export const realCommandRunner: CommandRunner = (command, args, timeoutMs = 30_000) => {
  const result = spawnSync(command, [...args], { encoding: "utf8", timeout: timeoutMs })

  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.error ? result.error.message : result.stderr ?? "",
  }
}

export const formatReceipt = (command: string, args: ReadonlyArray<string>, result: CommandResult): string =>
  `$ ${command} ${args.join(" ")} -> exit ${result.status ?? "null"}`
