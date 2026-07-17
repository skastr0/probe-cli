import { basename, dirname, join } from "node:path"

/**
 * Owns the video-artifact half of PRB-085's gate 12 ("session and artifact
 * policy move to coordinators") for SessionRegistry: given a capture outcome
 * (ffmpeg availability, frame/duration/fps metadata), which artifact kind
 * results and how it's described. This used to live inline in
 * SessionRegistry's video-capture wrappers, decided at the same call site
 * that invoked ffmpeg/ffprobe/simctl. SessionRegistry still owns invoking
 * those tools and registering the resulting artifact (that's session/runner
 * state, not video policy); this module only decides the shape and wording
 * of the result once the tool outcome is known -- no process spawning, no
 * session state.
 */

/** Requested recording duration is clamped to this bound before any capture starts. */
export const maxVideoDurationMs = 120_000

/** Fallback frame rate used when the runner-reported manifest omits one. */
export const defaultVideoCaptureFps = 10

export const normalizeVideoDurationMs = (durationMs: number): number =>
  Math.min(Math.max(Math.round(durationMs), 1), maxVideoDurationMs)

export const resolveFfmpegExecutable = (): string => process.env.PROBE_FFMPEG_PATH ?? "ffmpeg"

export const resolveFfprobeExecutable = (): string => {
  const configured = process.env.PROBE_FFPROBE_PATH

  if (configured) {
    return configured
  }

  const ffmpegExecutable = resolveFfmpegExecutable()
  const executableName = basename(ffmpegExecutable)

  if (executableName.includes("ffmpeg")) {
    return join(dirname(ffmpegExecutable), executableName.replace("ffmpeg", "ffprobe"))
  }

  return "ffprobe"
}

export const parseRationalNumber = (value: string): number | null => {
  const trimmed = value.trim()

  if (trimmed.length === 0) {
    return null
  }

  if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) {
    const numeric = Number(trimmed)
    return Number.isFinite(numeric) ? numeric : null
  }

  const match = trimmed.match(/^(-?\d+)\/(-?\d+)$/)

  if (!match) {
    return null
  }

  const numerator = Number(match[1])
  const denominator = Number(match[2])

  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) {
    return null
  }

  const numeric = numerator / denominator
  return Number.isFinite(numeric) ? numeric : null
}

export const formatFpsLabel = (value: number): string => {
  if (!Number.isFinite(value)) {
    return "unknown"
  }

  const rounded = Math.round(value * 100) / 100
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(2)
}

export interface VideoArtifactDescription {
  readonly kind: "mp4" | "mov" | "directory"
  readonly summary: string
}

/** Runner-backed capture (HTTP frame sequence), ffmpeg available: stitched to MP4. */
export const describeRunnerMp4Artifact = (args: {
  readonly frameCount: number
  readonly fps: number
}): VideoArtifactDescription => ({
  kind: "mp4",
  summary: `MP4 video with ${args.frameCount} frame(s) at ${args.fps} fps stitched from runner screenshots via ffmpeg.`,
})

/** Runner-backed capture, ffmpeg unavailable: archived as a frame-sequence bundle instead. */
export const describeRunnerFrameSequenceFallback = (args: {
  readonly frameCount: number
  readonly fps: number
}): VideoArtifactDescription => ({
  kind: "directory",
  summary:
    `Frame-sequence bundle with ${args.frameCount} frame(s) at ${args.fps} fps because ffmpeg was not available for MP4 stitching.`,
})

/** Simulator-native capture (`simctl io recordVideo`), ffmpeg unavailable: kept as the native .mov. */
export const describeSimulatorMovFallback = (args: {
  readonly durationMs: number
}): VideoArtifactDescription => ({
  kind: "mov",
  summary:
    `Native simulator QuickTime video captured over simctl with requested duration ${args.durationMs}ms because ffmpeg was not available to remux it to MP4.`,
})

/** Simulator-native capture, ffmpeg available: remuxed to MP4, optionally normalized to the source frame rate. */
export const describeSimulatorMp4Remux = (args: {
  readonly durationMs: number
  readonly sourceFrameRateLabel: string | null
}): VideoArtifactDescription => ({
  kind: "mp4",
  summary: args.sourceFrameRateLabel === null
    ? `Native simulator video captured over simctl and transcoded to MP4 via ffmpeg using the source timing for requested duration ${args.durationMs}ms.`
    : `Native simulator video captured over simctl and normalized to captured simulator rate ${args.sourceFrameRateLabel} fps MP4 via ffmpeg for requested duration ${args.durationMs}ms.`,
})
