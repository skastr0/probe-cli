import { Transform } from "node:stream"

/**
 * Owns the artifact half of PRB-085's gate 12 ("session and artifact policy
 * move to coordinators"): how much exported output a caller is willing to
 * accept before it stops trusting the export and kills the producing
 * process, and how that decision is reported. This used to live inline in
 * PerfService (the wrapper); PerfService now only wires this guard into its
 * xctrace export pipeline and decides what to do when it reports an
 * exceeded budget -- it does not own the budget-enforcement policy itself.
 */

const mib = 1024 * 1024

/** Exported so callers (PerfService's own progress/error wording) share one canonical byte formatter. */
export const formatBytes = (value: number): string => {
  if (value >= mib) {
    return `${(value / mib).toFixed(1)} MiB`
  }

  if (value >= 1024) {
    return `${(value / 1024).toFixed(1)} KiB`
  }

  return `${value} B`
}

const rowTag = "<row>"
const rowTagTailLength = rowTag.length - 1

const countOccurrences = (source: string, token: string): number => {
  let count = 0
  let index = source.indexOf(token)

  while (index !== -1) {
    count += 1
    index = source.indexOf(token, index + token.length)
  }

  return count
}

export interface ExportBudget {
  readonly maxBytes: number
  readonly maxRows: number
}

export class ExportBudgetExceededError extends Error {
  readonly kind: "bytes" | "rows"
  readonly limit: number
  readonly observed: number

  constructor(args: {
    readonly kind: "bytes" | "rows"
    readonly limit: number
    readonly observed: number
  }) {
    super(
      args.kind === "bytes"
        ? `Export exceeded ${formatBytes(args.limit)}.`
        : `Export exceeded ${args.limit} rows.`,
    )
    this.name = "ExportBudgetExceededError"
    this.kind = args.kind
    this.limit = args.limit
    this.observed = args.observed
  }
}

/**
 * Enforces `budget` against an xctrace `<row>`-tagged export stream: fails
 * once bytes or row count exceed budget, so the caller can stop the
 * underlying process instead of buffering (or writing to disk) an unbounded
 * export.
 */
export class ExportBudgetTransform extends Transform {
  bytesWritten = 0
  rowCount = 0
  /** Set (once) when a budget is exceeded, so callers can inspect it after the pipeline settles. */
  exceededError: ExportBudgetExceededError | null = null
  private trailingText = ""

  constructor(private readonly budget: ExportBudget) {
    super()
  }

  override _transform(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null, data?: Buffer | string) => void,
  ): void {
    const text = typeof chunk === "string" ? chunk : chunk.toString("utf8")
    this.bytesWritten += Buffer.byteLength(text, "utf8")

    if (this.bytesWritten > this.budget.maxBytes) {
      this.exceededError = new ExportBudgetExceededError({
        kind: "bytes",
        limit: this.budget.maxBytes,
        observed: this.bytesWritten,
      })
      callback(this.exceededError)
      return
    }

    const combined = `${this.trailingText}${text}`
    this.rowCount += countOccurrences(combined, rowTag)
    this.trailingText = combined.slice(-rowTagTailLength)

    if (this.rowCount > this.budget.maxRows) {
      this.exceededError = new ExportBudgetExceededError({
        kind: "rows",
        limit: this.budget.maxRows,
        observed: this.rowCount,
      })
      callback(this.exceededError)
      return
    }

    callback(null, chunk)
  }
}
