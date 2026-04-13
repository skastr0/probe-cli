import { describe, expect, test } from "bun:test"
import {
  injectBootstrapJsonIntoXctestrunPlist,
  injectEnvironmentVariablesIntoXctestrunPlist,
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
