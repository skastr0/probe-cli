import { describe, expect, test } from "bun:test"
import { writeFile } from "node:fs/promises"
import { join } from "node:path"
import { renderXcresultDrill, type HostCommandResult } from "./XcresultIntrospection"

const summaryFixture = {
  title: "Probe Runner Tests",
  environmentDescription: "iPhone 15 / iOS 18.0",
  result: "Failed",
  totalTestCount: 2,
  passedTests: 1,
  failedTests: 1,
  skippedTests: 0,
  expectedFailures: 0,
  topInsights: [
    {
      impact: "high",
      category: "Test Failure",
      text: "1 failing test",
    },
  ],
  statistics: [
    {
      title: "Duration",
      subtitle: "0.7s",
    },
  ],
  testFailures: [
    {
      testName: "ProbeUITests/testFailure()",
      testIdentifierString: "case-fail",
      failureText: "XCTAssertEqual failed: expected Ready, got Error",
    },
  ],
}

const testsFixture = {
  testNodes: [
    {
      nodeType: "Test Suite",
      name: "All Tests",
      children: [
        {
          nodeType: "Test Case",
          nodeIdentifier: "case-pass",
          name: "ProbeUITests/testPass()",
          duration: "0.2s",
          durationInSeconds: 0.2,
          result: "Passed",
          children: [],
        },
        {
          nodeType: "Test Case",
          nodeIdentifier: "case-fail",
          name: "ProbeUITests/testFailure()",
          duration: "0.5s",
          durationInSeconds: 0.5,
          result: "Failed",
          children: [
            {
              nodeType: "Failure Message",
              name: "Assertion Failure",
              details: "XCTAssertEqual failed: expected Ready, got Error",
              children: [],
            },
          ],
        },
      ],
    },
  ],
}

const coverageFixture = {
  coveredLines: 12,
  executableLines: 20,
  lineCoverage: 0.6,
  targets: [
    {
      name: "ProbeFixture",
      coveredLines: 12,
      executableLines: 20,
      lineCoverage: 0.6,
      files: [{}, {}],
    },
  ],
}

const writeAttachmentFixture = async (outputPath: string) => {
  await writeFile(
    join(outputPath, "failure-details.txt"),
    "Failure details\nLine 2\n",
    "utf8",
  )
  await writeFile(
    join(outputPath, "failure-screenshot.png"),
    Buffer.from("89504e470d0a1a0a", "hex"),
  )
  await writeFile(
    join(outputPath, "manifest.json"),
    `${JSON.stringify([
      {
        testIdentifier: "case-fail",
        attachments: {
          exportedFileName: "failure-details.txt",
          suggestedHumanReadableName: "Failure Details",
          isAssociatedWithFailure: true,
          timestamp: 1710000000,
          configurationName: "Default",
          deviceName: "iPhone 15",
          deviceId: "sim-1",
          repetitionNumber: 1,
          arguments: [],
        },
      },
      {
        testIdentifier: "case-fail",
        attachments: {
          exportedFileName: "failure-screenshot.png",
          suggestedHumanReadableName: "Failure Screenshot",
          isAssociatedWithFailure: true,
          timestamp: 1710000001,
          configurationName: "Default",
          deviceName: "iPhone 15",
          deviceId: "sim-1",
          repetitionNumber: 1,
          arguments: [],
        },
      },
    ], null, 2)}\n`,
    "utf8",
  )
}

const createRunner = () =>
  async (_command: string, args: ReadonlyArray<string>): Promise<HostCommandResult> => {
    if (args[0] === "xcresulttool" && args[1] === "get" && args[2] === "test-results" && args[3] === "summary") {
      return {
        stdout: `${JSON.stringify(summaryFixture)}\n`,
        stderr: "",
        exitCode: 0,
      }
    }

    if (args[0] === "xcresulttool" && args[1] === "get" && args[2] === "test-results" && args[3] === "tests") {
      return {
        stdout: `${JSON.stringify(testsFixture)}\n`,
        stderr: "",
        exitCode: 0,
      }
    }

    if (args[0] === "xccov") {
      return {
        stdout: `2026-04-14 10:00:00.000 xccov[1:1] note\n${JSON.stringify(coverageFixture)}\n`,
        stderr: "",
        exitCode: 0,
      }
    }

    if (args[0] === "xcresulttool" && args[1] === "export" && args[2] === "attachments") {
      const outputPathIndex = args.indexOf("--output-path")

      if (outputPathIndex < 0) {
        throw new Error("expected --output-path for attachment export")
      }

      await writeAttachmentFixture(args[outputPathIndex + 1]!)

      return {
        stdout: "",
        stderr: "",
        exitCode: 0,
      }
    }

    throw new Error(`unexpected command: ${args.join(" ")}`)
  }

describe("xcresult introspection", () => {
  test("renders structured xcresult summaries", async () => {
    const result = await renderXcresultDrill({
      bundlePath: "/tmp/ProbeRunnerTransportBoundary.xcresult",
      query: {
        kind: "xcresult",
        view: "summary",
        attachmentId: null,
      },
      sessionArtifacts: [
        {
          key: "build-log",
          absolutePath: "/tmp/build.log",
          summary: "build log",
        },
        {
          key: "stdout-events",
          absolutePath: "/tmp/stdout.ndjson",
          summary: "stdout events",
        },
      ],
      runCommand: createRunner(),
    })

    expect(result.kind).toBe("content")

    if (result.kind !== "content") {
      throw new Error("expected inline content")
    }

    const payload = JSON.parse(result.content)
    expect(payload.kind).toBe("xcresult-summary")
    expect(payload.tests).toHaveLength(2)
    expect(payload.tests[1].issues[0].message).toContain("XCTAssertEqual failed")
    expect(payload.logPaths[0].path).toBe("/tmp/build.log")
    expect(payload.coverage.available).toBe(true)
    expect(payload.coverage.coveredLines).toBe(12)
  })

  test("lists xcresult attachments with ids, types, and sizes", async () => {
    const result = await renderXcresultDrill({
      bundlePath: "/tmp/ProbeRunnerTransportBoundary.xcresult",
      query: {
        kind: "xcresult",
        view: "attachments",
        attachmentId: null,
      },
      sessionArtifacts: [],
      runCommand: createRunner(),
    })

    expect(result.kind).toBe("content")

    if (result.kind !== "content") {
      throw new Error("expected inline content")
    }

    const payload = JSON.parse(result.content)
    expect(payload.kind).toBe("xcresult-attachments")
    expect(payload.count).toBe(2)
    expect(payload.attachments[0].id).toContain("att-")
    expect(payload.attachments[0].artifactKind).toBe("text")
    expect(payload.attachments[0].sizeBytes).toBeGreaterThan(0)
    expect(payload.attachments[1].artifactKind).toBe("png")
  })

  test("drills text attachments inline and binary attachments as files", async () => {
    const listing = await renderXcresultDrill({
      bundlePath: "/tmp/ProbeRunnerTransportBoundary.xcresult",
      query: {
        kind: "xcresult",
        view: "attachments",
        attachmentId: null,
      },
      sessionArtifacts: [],
      runCommand: createRunner(),
    })

    if (listing.kind !== "content") {
      throw new Error("expected inline attachment listing")
    }

    const payload = JSON.parse(listing.content)
    const textAttachmentId = payload.attachments.find((attachment: { artifactKind: string }) => attachment.artifactKind === "text")?.id
    const imageAttachmentId = payload.attachments.find((attachment: { artifactKind: string }) => attachment.artifactKind === "png")?.id

    const textResult = await renderXcresultDrill({
      bundlePath: "/tmp/ProbeRunnerTransportBoundary.xcresult",
      query: {
        kind: "xcresult",
        view: "attachments",
        attachmentId: textAttachmentId ?? null,
      },
      sessionArtifacts: [],
      runCommand: createRunner(),
    })

    expect(textResult.kind).toBe("content")

    if (textResult.kind !== "content") {
      throw new Error("expected text attachment content")
    }

    expect(textResult.content).toContain("Failure details")

    const imageResult = await renderXcresultDrill({
      bundlePath: "/tmp/ProbeRunnerTransportBoundary.xcresult",
      query: {
        kind: "xcresult",
        view: "attachments",
        attachmentId: imageAttachmentId ?? null,
      },
      sessionArtifacts: [],
      runCommand: createRunner(),
    })

    expect(imageResult.kind).toBe("artifact-file")

    if (imageResult.kind !== "artifact-file") {
      throw new Error("expected binary attachment export")
    }

    expect(imageResult.artifactKind).toBe("png")
    expect(imageResult.sourceFileName).toBe("failure-screenshot.png")
  })
})
