export type TransportKind = "stdout-jsonl" | "unix-socket"

export type RunnerAction = "ping" | "shutdown" | "crash"

export interface RunnerCommand {
  readonly kind: "command"
  readonly id: string
  readonly action: RunnerAction
  readonly payload?: string
}

export interface RunnerReadyMessage {
  readonly kind: "ready"
  readonly transport: TransportKind
  readonly pid: number
}

export interface RunnerResponse {
  readonly kind: "response"
  readonly id: string
  readonly transport: TransportKind
  readonly pid: number
  readonly ok: boolean
  readonly action: RunnerAction
  readonly sequence: number
  readonly payload?: string
  readonly error?: string
}

export type RunnerMessage = RunnerReadyMessage | RunnerResponse

export const encodeJsonLine = (message: RunnerCommand | RunnerMessage): string =>
  `${JSON.stringify(message)}\n`

export const decodeJsonLine = <T>(line: string): T => JSON.parse(line) as T
