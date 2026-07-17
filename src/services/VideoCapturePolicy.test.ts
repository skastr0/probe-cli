import { describe, expect, test } from "bun:test"
import {
  describeRunnerFrameSequenceFallback,
  describeRunnerMp4Artifact,
  describeSimulatorMovFallback,
  describeSimulatorMp4Remux,
  formatFpsLabel,
  maxVideoDurationMs,
  normalizeVideoDurationMs,
  parseRationalNumber,
  resolveFfmpegExecutable,
  resolveFfprobeExecutable,
} from "./VideoCapturePolicy"

// Unit coverage of the policy itself, decoupled from SessionRegistry and from
// any real process spawn -- the coordinator this policy moved into (PRB-085
// gate 12) should be testable on its own, not only indirectly through a
// wrapper's end-to-end video-capture pipeline.

describe("VideoCapturePolicy", () => {
  describe("normalizeVideoDurationMs", () => {
    test("rounds and clamps into [1, maxVideoDurationMs]", () => {
      expect(normalizeVideoDurationMs(0)).toBe(1)
      expect(normalizeVideoDurationMs(-500)).toBe(1)
      expect(normalizeVideoDurationMs(1_500.4)).toBe(1_500)
      expect(normalizeVideoDurationMs(1_500.6)).toBe(1_501)
      expect(normalizeVideoDurationMs(maxVideoDurationMs + 60_000)).toBe(maxVideoDurationMs)
    })
  })

  describe("resolveFfmpegExecutable / resolveFfprobeExecutable", () => {
    const withEnv = (env: Record<string, string | undefined>, run: () => void): void => {
      const original: Record<string, string | undefined> = {}
      for (const key of Object.keys(env)) {
        original[key] = process.env[key]
        if (env[key] === undefined) {
          delete process.env[key]
        } else {
          process.env[key] = env[key]
        }
      }
      try {
        run()
      } finally {
        for (const key of Object.keys(env)) {
          if (original[key] === undefined) {
            delete process.env[key]
          } else {
            process.env[key] = original[key]
          }
        }
      }
    }

    test("defaults to bare 'ffmpeg'/'ffprobe' when unset", () => {
      withEnv({ PROBE_FFMPEG_PATH: undefined, PROBE_FFPROBE_PATH: undefined }, () => {
        expect(resolveFfmpegExecutable()).toBe("ffmpeg")
        expect(resolveFfprobeExecutable()).toBe("ffprobe")
      })
    })

    test("derives ffprobe from a configured ffmpeg path in the same directory", () => {
      withEnv({ PROBE_FFMPEG_PATH: "/opt/homebrew/bin/ffmpeg", PROBE_FFPROBE_PATH: undefined }, () => {
        expect(resolveFfprobeExecutable()).toBe("/opt/homebrew/bin/ffprobe")
      })
    })

    test("PROBE_FFPROBE_PATH overrides ffmpeg-derived resolution", () => {
      withEnv({ PROBE_FFMPEG_PATH: "/opt/homebrew/bin/ffmpeg", PROBE_FFPROBE_PATH: "/custom/ffprobe" }, () => {
        expect(resolveFfprobeExecutable()).toBe("/custom/ffprobe")
      })
    })

    test("falls back to bare 'ffprobe' when the ffmpeg executable name doesn't contain 'ffmpeg'", () => {
      withEnv({ PROBE_FFMPEG_PATH: "/opt/homebrew/bin/custom-transcoder", PROBE_FFPROBE_PATH: undefined }, () => {
        expect(resolveFfprobeExecutable()).toBe("ffprobe")
      })
    })
  })

  describe("parseRationalNumber", () => {
    test("parses plain integers and decimals", () => {
      expect(parseRationalNumber("30")).toBe(30)
      expect(parseRationalNumber("29.97")).toBeCloseTo(29.97)
    })

    test("parses ffprobe's rational fraction form", () => {
      expect(parseRationalNumber("30000/1001")).toBeCloseTo(29.970029970029973)
      expect(parseRationalNumber("60/1")).toBe(60)
    })

    test("rejects a zero denominator, empty input, and garbage", () => {
      expect(parseRationalNumber("30/0")).toBeNull()
      expect(parseRationalNumber("")).toBeNull()
      expect(parseRationalNumber("   ")).toBeNull()
      expect(parseRationalNumber("not-a-number")).toBeNull()
    })
  })

  describe("formatFpsLabel", () => {
    test("drops trailing zeros for whole numbers", () => {
      expect(formatFpsLabel(30)).toBe("30")
      expect(formatFpsLabel(60.0)).toBe("60")
    })

    test("rounds to 2 decimal places for fractional rates", () => {
      expect(formatFpsLabel(29.970029970029973)).toBe("29.97")
    })

    test("reports 'unknown' for non-finite input", () => {
      expect(formatFpsLabel(Number.NaN)).toBe("unknown")
      expect(formatFpsLabel(Number.POSITIVE_INFINITY)).toBe("unknown")
    })
  })

  describe("artifact descriptions", () => {
    test("describeRunnerMp4Artifact", () => {
      const description = describeRunnerMp4Artifact({ frameCount: 42, fps: 10 })
      expect(description.kind).toBe("mp4")
      expect(description.summary).toContain("42 frame(s)")
      expect(description.summary).toContain("10 fps")
      expect(description.summary).toContain("via ffmpeg")
    })

    test("describeRunnerFrameSequenceFallback", () => {
      const description = describeRunnerFrameSequenceFallback({ frameCount: 7, fps: 5 })
      expect(description.kind).toBe("directory")
      expect(description.summary).toContain("7 frame(s)")
      expect(description.summary).toContain("ffmpeg was not available")
    })

    test("describeSimulatorMovFallback", () => {
      const description = describeSimulatorMovFallback({ durationMs: 5_000 })
      expect(description.kind).toBe("mov")
      expect(description.summary).toContain("5000ms")
      expect(description.summary).toContain("ffmpeg was not available")
    })

    test("describeSimulatorMp4Remux without a source frame rate", () => {
      const description = describeSimulatorMp4Remux({ durationMs: 3_000, sourceFrameRateLabel: null })
      expect(description.kind).toBe("mp4")
      expect(description.summary).toContain("source timing")
      expect(description.summary).not.toContain("normalized to captured simulator rate")
    })

    test("describeSimulatorMp4Remux with a source frame rate", () => {
      const description = describeSimulatorMp4Remux({ durationMs: 3_000, sourceFrameRateLabel: "29.97" })
      expect(description.kind).toBe("mp4")
      expect(description.summary).toContain("normalized to captured simulator rate 29.97 fps")
    })
  })
})
