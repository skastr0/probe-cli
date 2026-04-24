import { Effect, Schema } from "effect"
import { DrillQuery, OutputMode } from "../../domain/output"
import { DaemonClient } from "../../services/DaemonClient"
import { hasMachineJsonOutput, readOptionalJsonInput } from "../json"
import { invalidOption, optionalOption, requireOption } from "../options"

const DrillPayload = Schema.Struct({
  sessionId: Schema.String,
  artifactKey: Schema.String,
  outputMode: Schema.optional(OutputMode),
  query: DrillQuery,
})

const decodeDrillPayload = Schema.decodeUnknownSync(DrillPayload)

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
    const xcresult = yield* optionalOption(args, "--xcresult")
    const attachmentId = yield* optionalOption(args, "--attachment-id")
    const jsonPointer = yield* optionalOption(args, "--json-pointer")
    const xpath = yield* optionalOption(args, "--xpath")
    const lines = yield* optionalOption(args, "--lines")
    const match = yield* optionalOption(args, "--match")

    if (xcresult) {
      if (jsonPointer || xpath || lines || match) {
        return yield* invalidOption(
          "--xcresult",
          "xcresult drill views cannot be combined with --json-pointer, --xpath, or --lines.",
          "Use either --xcresult summary|attachments or one of the existing text/JSON/XML drill flags.",
        )
      }

      if (xcresult !== "summary" && xcresult !== "attachments") {
        return yield* invalidOption(
          "--xcresult",
          `invalid value ${xcresult}; expected summary or attachments.`,
          "Provide --xcresult summary|attachments and retry the command.",
        )
      }

      if (attachmentId && xcresult !== "attachments") {
        return yield* invalidOption(
          "--attachment-id",
          "--attachment-id requires --xcresult attachments.",
          "Use --xcresult attachments --attachment-id <id> after listing the xcresult attachments.",
        )
      }

      return {
        kind: "xcresult",
        view: xcresult,
        attachmentId: attachmentId ?? null,
      } as const satisfies DrillQuery
    }

    if (attachmentId) {
      return yield* invalidOption(
        "--attachment-id",
        "--attachment-id requires --xcresult attachments.",
        "Use --xcresult attachments --attachment-id <id> after listing the xcresult attachments.",
      )
    }

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

const parseOutputMode = (args: ReadonlyArray<string>, query: DrillQuery, asJson: boolean) =>
  Effect.gen(function* () {
    const mode = yield* optionalOption(args, "--output")

    if (!mode) {
      return asJson && query.kind === "xcresult" ? "inline" : "auto"
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
    const payload = yield* readOptionalJsonInput(args, "drill payload", decodeDrillPayload, undefined, {
      allowFile: false,
      allowStdin: false,
    })
    const sessionId = payload?.sessionId ?? (yield* requireOption(args, "--session-id"))
    const artifactKey = payload?.artifactKey ?? (yield* requireOption(args, "--artifact"))
    const asJson = hasMachineJsonOutput(args)
    const query = payload?.query ?? (yield* parseDrillQuery(args))
    const outputMode = payload?.outputMode ?? (yield* parseOutputMode(args, query, asJson))
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
        if (query.kind === "xcresult" && result.kind === "inline" && result.format === "json") {
          process.stdout.write(result.content)
          return
        }

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
