import { readFile } from "node:fs/promises"
import { Effect } from "effect"
import { UserInputError } from "../domain/errors"
import { optionalOption } from "./options"

export interface JsonInputDependencies {
  readonly readStdinText?: () => Effect.Effect<string, UserInputError>
}

const defaultReadStdinText = (label: string) =>
  Effect.tryPromise({
    try: async () => {
      const chunks: Array<string> = []

      for await (const chunk of process.stdin) {
        chunks.push(typeof chunk === "string" ? chunk : chunk.toString("utf8"))
      }

      return chunks.join("")
    },
    catch: (error) =>
      new UserInputError({
        code: "json-stdin-read",
        reason: `Could not read ${label} JSON from stdin: ${error instanceof Error ? error.message : String(error)}.`,
        nextStep: `Pipe valid ${label} JSON to stdin and retry the command.`,
        details: [],
      }),
  })

const decodeJsonText = <T>(raw: string, label: string, decode: (value: unknown) => T) =>
  Effect.try({
    try: () => decode(JSON.parse(raw) as unknown),
    catch: (error) =>
      new UserInputError({
        code: "json-input-parse",
        reason: `Could not parse ${label} JSON: ${error instanceof Error ? error.message : String(error)}.`,
        nextStep: `Validate the ${label} JSON shape and retry the command.`,
        details: [],
      }),
  })

const readJsonFile = <T>(path: string, label: string, decode: (value: unknown) => T) =>
  Effect.gen(function* () {
    const raw = yield* Effect.tryPromise({
      try: () => readFile(path, "utf8"),
      catch: (error) =>
        new UserInputError({
          code: "json-file-read",
          reason: `Could not read ${label} file ${path}: ${error instanceof Error ? error.message : String(error)}.`,
          nextStep: `Verify the ${label} file path and retry the command.`,
          details: [],
        }),
    })

    return yield* decodeJsonText(raw, label, decode)
  })

export const hasMachineJsonOutput = (args: ReadonlyArray<string>): boolean =>
  args.includes("--output-json") || args.includes("--json")

export const readOptionalJsonInput = <T>(
  args: ReadonlyArray<string>,
  label: string,
  decode: (value: unknown) => T,
  deps?: JsonInputDependencies,
  options?: {
    readonly allowFile?: boolean
    readonly allowStdin?: boolean
    readonly fileFlag?: string
  },
) =>
  Effect.gen(function* () {
    const allowFile = options?.allowFile ?? true
    const allowStdin = options?.allowStdin ?? true
    const fileFlag = options?.fileFlag ?? "--file"
    const inline = yield* optionalOption(args, "--input-json")
    const filePath = allowFile ? yield* optionalOption(args, fileFlag) : null
    const useStdin = allowStdin && args.includes("--stdin")

    const sources = [
      inline !== null ? "--input-json" : null,
      filePath !== null ? fileFlag : null,
      useStdin ? "--stdin" : null,
    ].filter((source): source is string => source !== null)

    if (sources.length === 0) {
      return null
    }

    if (sources.length > 1) {
      return yield* new UserInputError({
        code: "json-input-ambiguous",
        reason: `Multiple JSON input sources were provided for ${label}: ${sources.join(", ")}.`,
        nextStep: "Provide exactly one of --input-json, --file, or --stdin and retry the command.",
        details: [],
      })
    }

    if (inline !== null) {
      return yield* decodeJsonText(inline, label, decode)
    }

    if (filePath !== null) {
      return yield* readJsonFile(filePath, label, decode)
    }

    const raw = yield* (deps?.readStdinText ?? (() => defaultReadStdinText(label)))()
    return yield* decodeJsonText(raw, label, decode)
  })

export const failLegacyJsonInput = (command: string) =>
  Effect.fail(
    new UserInputError({
      code: "legacy-json-input",
      reason: `${command} no longer accepts --json <payload> as input because --json is an output-mode compatibility alias.`,
      nextStep: `Use --input-json <payload> for inline JSON input and --output-json for machine output.`,
      details: [],
    }),
  )

export const hasLegacyJsonInput = (args: ReadonlyArray<string>): boolean => {
  const index = args.indexOf("--json")
  return index !== -1 && typeof args[index + 1] === "string" && !args[index + 1]!.startsWith("--")
}
