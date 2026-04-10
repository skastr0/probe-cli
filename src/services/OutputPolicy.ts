import { Context, Layer } from "effect"
import type { OutputMode, OutputThreshold } from "../domain/output"
import { shouldInlineOutput } from "../domain/output"

const defaultThreshold: OutputThreshold = {
  maxInlineBytes: Number(process.env.PROBE_MAX_INLINE_BYTES ?? 4 * 1024),
  maxInlineLines: Number(process.env.PROBE_MAX_INLINE_LINES ?? 100),
}

export class OutputPolicy extends Context.Tag("@probe/OutputPolicy")<
  OutputPolicy,
  {
    readonly getDefaultInlineThreshold: () => OutputThreshold
    readonly shouldInline: (mode: OutputMode, content: string) => boolean
    readonly shouldInlineBinary: (mode: OutputMode) => boolean
  }
>() {}

export const OutputPolicyLive = Layer.succeed(
  OutputPolicy,
  OutputPolicy.of({
    getDefaultInlineThreshold: () => defaultThreshold,
    shouldInline: (mode, content) => shouldInlineOutput(mode, defaultThreshold, content),
    shouldInlineBinary: (_mode) => false,
  }),
)
