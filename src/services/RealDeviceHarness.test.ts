import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"
import {
  buildRunnerHttpArtifactUrls,
  buildRunnerHttpCommandUrls,
  detectRealDeviceInterruption,
  decodeRunnerVideoArtifactManifest,
  extractDeviceCandidate,
  extractDeviceTunnelIp,
  injectBootstrapJsonIntoXctestrunPlist,
  injectEnvironmentVariablesIntoXctestrunPlist,
  materializeDeviceRunnerVideoArtifacts,
} from "./RealDeviceHarness"

describe("injectBootstrapJsonIntoXctestrunPlist", () => {
  test("injects PROBE_BOOTSTRAP_JSON into every non-metadata test target", () => {
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
  <key>__xctestrun_metadata__</key>
  <dict>
    <key>FormatVersion</key>
    <integer>2</integer>
  </dict>
  <key>ProbeRunnerUITests</key>
  <dict>
    <key>EnvironmentVariables</key>
    <dict>
      <key>EXISTING_FLAG</key>
      <string>1</string>
    </dict>
  </dict>
  <key>ProbeRunnerSmokeTests</key>
  <dict>
    <key>TestBundlePath</key>
    <string>__TESTROOT__/ProbeRunnerSmokeTests.xctest</string>
  </dict>
</dict>
</plist>
`
    const bootstrapJson = JSON.stringify({
      sessionIdentifier: "session-1",
      controlDirectoryPath: "/tmp/probe-runner-bootstrap/runtime&control",
    })

    const updated = injectBootstrapJsonIntoXctestrunPlist(plist, bootstrapJson)

    expect(updated.match(/<key>PROBE_BOOTSTRAP_JSON<\/key>/g)?.length).toBe(2)
    expect(updated).toContain("<key>EXISTING_FLAG</key>")
    expect(updated).toContain("runtime&amp;control")
    expect(updated).toContain("<key>FormatVersion</key>")
  })

  test("replaces an existing injected bootstrap value instead of duplicating it", () => {
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
  <key>ProbeRunnerUITests</key>
  <dict>
    <key>EnvironmentVariables</key>
    <dict>
      <key>PROBE_BOOTSTRAP_JSON</key>
      <string>{&quot;sessionIdentifier&quot;:&quot;old-session&quot;}</string>
    </dict>
  </dict>
</dict>
</plist>
`
    const bootstrapJson = JSON.stringify({ sessionIdentifier: "new-session" })

    const updated = injectBootstrapJsonIntoXctestrunPlist(plist, bootstrapJson)

    expect(updated.match(/<key>PROBE_BOOTSTRAP_JSON<\/key>/g)?.length).toBe(1)
    expect(updated).toContain("new-session")
    expect(updated).not.toContain("old-session")
  })

  test("fills an empty self-closing environment dict", () => {
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
  <key>ProbeRunnerUITests</key>
  <dict>
    <key>EnvironmentVariables</key>
    <dict/>
  </dict>
</dict>
</plist>
`

    const updated = injectBootstrapJsonIntoXctestrunPlist(plist, JSON.stringify({ sessionIdentifier: "session-2" }))

    expect(updated).toContain("<dict>\n  <key>PROBE_BOOTSTRAP_JSON</key>")
    expect(updated).toContain("session-2")
  })

  test("injects multiple runner environment variables into each test target", () => {
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
  <key>ProbeRunnerUITests</key>
  <dict>
    <key>EnvironmentVariables</key>
    <dict>
      <key>EXISTING_FLAG</key>
      <string>1</string>
    </dict>
  </dict>
</dict>
</plist>
`

    const updated = injectEnvironmentVariablesIntoXctestrunPlist(plist, {
      PROBE_BOOTSTRAP_JSON: JSON.stringify({ sessionIdentifier: "session-3" }),
      PROBE_RUNNER_PORT: "43123",
    })

    expect(updated).toContain("<key>EXISTING_FLAG</key>")
    expect(updated).toContain("<key>PROBE_BOOTSTRAP_JSON</key>")
    expect(updated).toContain("session-3")
    expect(updated).toContain("<key>PROBE_RUNNER_PORT</key>")
    expect(updated).toContain("43123")
  })
})

describe("extractDeviceTunnelIp", () => {
  test("returns the tunnel IP from a successful device details payload", () => {
    const tunnelIp = extractDeviceTunnelIp({
      info: {
        outcome: "success",
      },
      result: {
        connectionProperties: {
          tunnelIPAddress: "fd66:7144:c05f::1",
        },
      },
    })

    expect(tunnelIp).toBe("fd66:7144:c05f::1")
  })

  test("returns null when the device details payload was not successful", () => {
    const tunnelIp = extractDeviceTunnelIp({
      info: {
        outcome: "failure",
      },
      result: {
        connectionProperties: {
          tunnelIPAddress: "fd66:7144:c05f::1",
        },
      },
    })

    expect(tunnelIp).toBeNull()
  })
})

describe("extractDeviceCandidate", () => {
  test("prefers the hardware UDID as the canonical identifier when CoreDevice exposes both ids", () => {
    const candidate = extractDeviceCandidate({
      identifier: "9FE1EE68-650B-590A-B131-48E1575FBE5A",
      name: "iPhone (2)",
      hardwareProperties: {
        udid: "00008110-0006293936C0401E",
        serialNumber: "JNFJJ6GP4R",
      },
    })

    expect(candidate).toEqual({
      identifier: "00008110-0006293936C0401E",
      name: "iPhone (2)",
      runtime: null,
      matchKeys: [
        "00008110-0006293936C0401E",
        "9FE1EE68-650B-590A-B131-48E1575FBE5A",
        "iPhone (2)",
        "JNFJJ6GP4R",
      ],
    })
  })

  test("falls back to the CoreDevice identifier when no UDID is available", () => {
    const candidate = extractDeviceCandidate({
      identifier: "9FE1EE68-650B-590A-B131-48E1575FBE5A",
      name: "iPhone (2)",
    })

    expect(candidate).toEqual({
      identifier: "9FE1EE68-650B-590A-B131-48E1575FBE5A",
      name: "iPhone (2)",
      runtime: null,
      matchKeys: [
        "9FE1EE68-650B-590A-B131-48E1575FBE5A",
        "iPhone (2)",
      ],
    })
  })
})

describe("buildRunnerHttpCommandUrls", () => {
  test("prefers the device tunnel IP before localhost for real-device sessions", () => {
    expect(buildRunnerHttpCommandUrls({
      port: 57873,
      tunnelIp: "fd66:7144:c05f::1",
    })).toEqual([
      "http://[fd66:7144:c05f::1]:57873/command",
      "http://127.0.0.1:57873/command",
    ])
  })

  test("falls back to localhost when no tunnel IP is available", () => {
    expect(buildRunnerHttpCommandUrls({
      port: 57873,
      tunnelIp: null,
    })).toEqual([
      "http://127.0.0.1:57873/command",
    ])
  })
})

describe("buildRunnerHttpArtifactUrls", () => {
  test("rewrites each command URL to the artifact endpoint while preserving the fallback order", () => {
    const artifactPath = "/private/var/mobile/Containers/Data/Application/abc/tmp/video-frames-009/manifest.json"
    const urls = buildRunnerHttpArtifactUrls({
      commandUrls: [
        "http://[fd66:7144:c05f::1]:57873/command",
        "http://127.0.0.1:57873/command",
      ],
      artifactPath,
    })

    expect(urls).toHaveLength(2)

    const first = new URL(urls[0]!)
    const second = new URL(urls[1]!)

    expect(first.pathname).toBe("/artifact")
    expect(first.searchParams.get("path")).toBe(artifactPath)
    expect(second.pathname).toBe("/artifact")
    expect(second.searchParams.get("path")).toBe(artifactPath)
    expect(urls[0]).toContain("http://[fd66:7144:c05f::1]:57873/artifact?")
    expect(urls[1]).toContain("http://127.0.0.1:57873/artifact?")
  })
})

describe("decodeRunnerVideoArtifactManifest", () => {
  test("accepts the runner video manifest fields required by the host materializer", () => {
    expect(decodeRunnerVideoArtifactManifest({
      durationMs: 3_000,
      fps: 10,
      frameCount: 2,
      framesDirectoryPath: "/private/var/mobile/video-frames-009",
    })).toEqual({
      durationMs: 3_000,
      fps: 10,
      frameCount: 2,
    })
  })

  test("rejects manifests missing required numeric fields", () => {
    expect(() => decodeRunnerVideoArtifactManifest({
      durationMs: 3_000,
      fps: 10,
      frameCount: 0,
    })).toThrow("runner video manifest is missing one or more required numeric fields")
  })
})

describe("materializeDeviceRunnerVideoArtifacts", () => {
  test("downloads the manifest and frame PNGs into a host-visible directory", async () => {
    const originalFetch = globalThis.fetch
    const tempRoot = await mkdtemp(join(tmpdir(), "probe-real-device-video-"))
    const deviceFramesDirectoryPath = "/private/var/mobile/Containers/Data/Application/abc/tmp/video-frames-009"
    const requestedUrls: Array<string> = []

    globalThis.fetch = (async (input) => {
      const url = typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url
      requestedUrls.push(url)

      if (url.startsWith("http://[fd66:7144:c05f::1]:57873/")) {
        return new Response("runner unavailable on this endpoint", { status: 503 })
      }

      const parsed = new URL(url)
      const requestedPath = parsed.searchParams.get("path")

      if (requestedPath === join(deviceFramesDirectoryPath, "manifest.json")) {
        return new Response(JSON.stringify({
          durationMs: 3_000,
          fps: 10,
          frameCount: 2,
          framesDirectoryPath: deviceFramesDirectoryPath,
        }), {
          status: 200,
          headers: {
            "Content-Type": "application/json",
          },
        })
      }

      if (requestedPath === join(deviceFramesDirectoryPath, "frame-00000.png")) {
        return new Response(new Uint8Array([1, 2, 3]), {
          status: 200,
          headers: {
            "Content-Type": "image/png",
          },
        })
      }

      if (requestedPath === join(deviceFramesDirectoryPath, "frame-00001.png")) {
        return new Response(new Uint8Array([4, 5, 6]), {
          status: 200,
          headers: {
            "Content-Type": "image/png",
          },
        })
      }

      return new Response("missing", { status: 404 })
    }) as typeof fetch

    try {
      const hostFramesDirectory = await materializeDeviceRunnerVideoArtifacts({
        commandUrls: [
          "http://[fd66:7144:c05f::1]:57873/command",
          "http://127.0.0.1:57873/command",
        ],
        deviceFramesDirectoryPath,
        observerControlDirectory: tempRoot,
        sequence: 9,
      })

      expect(hostFramesDirectory).toBe(join(tempRoot, "video-frames-009"))
      expect(await readFile(join(hostFramesDirectory, "manifest.json"), "utf8")).toContain('"frameCount":2')
      expect(new Uint8Array(await readFile(join(hostFramesDirectory, "frame-00000.png")))).toEqual(
        new Uint8Array([1, 2, 3]),
      )
      expect(new Uint8Array(await readFile(join(hostFramesDirectory, "frame-00001.png")))).toEqual(
        new Uint8Array([4, 5, 6]),
      )
      expect(requestedUrls[0]).toContain("http://[fd66:7144:c05f::1]:57873/artifact?")
      expect(requestedUrls[1]).toContain("http://127.0.0.1:57873/artifact?")
    } finally {
      globalThis.fetch = originalFetch
      await rm(tempRoot, { recursive: true, force: true })
    }
  })
})

describe("detectRealDeviceInterruption", () => {
  test("detects direct passcode evidence from device-side command output", async () => {
    const interruption = await detectRealDeviceInterruption({
      targetBundleId: "com.skastr0.ripple",
      device: {
        identifier: "00008110-0006293936C0401E",
        name: "iPhone 13 Pro",
      },
      evidenceSources: [{
        label: "devicectl device process launch",
        text: "Error: type device passcode before the app can be launched.",
      }],
    })

    expect(interruption?.signal).toBe("passcode-required")
    expect(interruption?.evidenceKind).toBe("direct")
    expect(interruption?.details).toContain(
      "devicectl device process launch: Error: type device passcode before the app can be launched.",
    )
  })

  test("infers a blocked attach from long foreground waits against the target app", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "probe-real-device-interruption-"))
    const logPath = join(tempRoot, "xcodebuild-session.log")

    await writeFile(logPath, [
      "t =     0.04s Wait for com.skastr0.ripple to become Running Foreground",
      "t =    35.04s Wait for com.skastr0.ripple to become Running Foreground",
      "t =    35.05s Waiting 5.0s for app to settle",
      "{\"kind\":\"ready\"}",
      "",
    ].join("\n"), "utf8")

    try {
      const interruption = await detectRealDeviceInterruption({
        targetBundleId: "com.skastr0.ripple",
        device: {
          identifier: "00008110-0006293936C0401E",
          name: "iPhone 13 Pro",
        },
        observedLatencyMs: 45_000,
        logPath,
      })

      expect(interruption?.signal).toBe("target-foreground-blocked")
      expect(interruption?.evidenceKind).toBe("inferred")
      expect(interruption?.details).toContain("foreground waits: 2")
    } finally {
      await rm(tempRoot, { recursive: true, force: true })
    }
  })

  test("fails closed when attach is slow but there is no interruption evidence", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "probe-real-device-interruption-"))
    const logPath = join(tempRoot, "xcodebuild-session.log")

    await writeFile(logPath, "t = 0.00s Start Test\nt = 40.00s Runner still preparing\n", "utf8")

    try {
      const interruption = await detectRealDeviceInterruption({
        targetBundleId: "com.skastr0.ripple",
        device: {
          identifier: "00008110-0006293936C0401E",
          name: "iPhone 13 Pro",
        },
        observedLatencyMs: 45_000,
        logPath,
      })

      expect(interruption).toBeNull()
    } finally {
      await rm(tempRoot, { recursive: true, force: true })
    }
  })
})
