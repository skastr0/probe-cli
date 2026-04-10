import { Effect } from "effect"
import type { DrillQuery, OutputMode } from "../../domain/output"
import { DaemonClient } from "../../services/DaemonClient"
import { invalidOption, optionalOption, requireOption } from "../options"

const parseLines = (value: string) =>
  Effect.gen(function* () {
    const [start, end] = value.split(":")
    const startLine = Number(start)
    const endLine = Number(end)

    if (!Number.isFinite(startLine) || !Number.isFinite(endLine) || startLine <= 0 || endLine < startLine) {
      return yield* invalidOption(
        "--lines",
        `invalid value ${value}; expected start:end with positive integers.`,
        "Provide --lines <start:end> with positive integers and retry the command.",
      )
    }

    return { startLine, endLine }
  })

const parseDrillQuery = (args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const jsonPointer = yield* optionalOption(args, "--json-pointer")
    const xpath = yield* optionalOption(args, "--xpath")
    const lines = yield* optionalOption(args, "--lines")
    const match = yield* optionalOption(args, "--match")

    if (jsonPointer) {
      return { kind: "json", pointer: jsonPointer } as const satisfies DrillQuery
    }

    if (xpath) {
      return { kind: "xml", xpath } as const satisfies DrillQuery
    }

    const parsedLines = yield* parseLines(lines ?? "1:40")
    return {
      kind: "text",
      startLine: parsedLines.startLine,
      endLine: parsedLines.endLine,
      match,
      contextLines: 0,
    } as const satisfies DrillQuery
  })

const parseOutputMode = (args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const mode = yield* optionalOption(args, "--output")

    if (!mode) {
      return "auto"
    }

    if (mode === "auto" || mode === "inline" || mode === "artifact") {
      return mode
    }

    return yield* invalidOption(
      "--output",
      `invalid value ${mode}; expected auto, inline, or artifact.`,
      "Provide --output auto|inline|artifact and retry the command.",
    )
  })

export const runDrillCommand = (args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const sessionId = yield* requireOption(args, "--session-id")
    const artifactKey = yield* requireOption(args, "--artifact")
    const asJson = args.includes("--json")
    const query = yield* parseDrillQuery(args)
    const outputMode = yield* parseOutputMode(args)
    const client = yield* DaemonClient
    const result = yield* client.drillArtifact({
      sessionId,
      artifactKey,
      query,
      outputMode,
      onEvent: asJson
        ? undefined
        : (stage, message) => {
            console.error(`[${stage}] ${message}`)
          },
    })

    yield* Effect.sync(() => {
      if (asJson) {
        console.log(JSON.stringify(result, null, 2))
        return
      }

      if (result.kind === "inline") {
        console.log(result.content)
        return
      }

      console.log(result.summary)
      console.log(result.artifact.absolutePath)
    })
  })
