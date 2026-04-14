import { createHash } from "node:crypto"
import { mkdtemp, readFile, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, extname, join } from "node:path"
import { ChildProcessError, EnvironmentError, UserInputError } from "../domain/errors"
import type {
  ArtifactKind,
  OutputFormat,
  XcresultAttachmentsReport,
  XcresultDrillQuery,
  XcresultSummaryReport,
} from "../domain/output"

export interface HostCommandResult {
  readonly stdout: string
  readonly stderr: string
  readonly exitCode: number | null
}

export interface SessionArtifactPath {
  readonly key: string
  readonly absolutePath: string
  readonly summary: string
}

export interface XcresultAttachmentRecord {
  readonly id: string
  readonly testIdentifier: string
  readonly testIdentifierURL: string | null
  readonly exportedFileName: string
  readonly name: string
  readonly associatedWithFailure: boolean
  readonly timestamp: number | null
  readonly configurationName: string | null
  readonly deviceName: string | null
  readonly deviceId: string | null
  readonly repetitionNumber: number | null
  readonly arguments: ReadonlyArray<number>
  readonly mediaType: string
  readonly artifactKind: ArtifactKind
  readonly sizeBytes: number
  readonly absolutePath: string
}

export type XcresultRenderedDrill =
  | {
      readonly kind: "content"
      readonly format: OutputFormat
      readonly content: string
      readonly summary: string
    }
  | {
      readonly kind: "artifact-file"
      readonly artifactKind: ArtifactKind
      readonly sourceAbsolutePath: string
      readonly sourceFileName: string
      readonly label: string
      readonly summary: string
    }

export interface XcresultInspection<T> {
  readonly report: T
  readonly summary: string
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null

const readOptionalString = (record: Record<string, unknown>, key: string): string | null => {
  const value = record[key]
  return typeof value === "string" ? value : null
}

const readOptionalNumber = (record: Record<string, unknown>, key: string): number | null => {
  const value = record[key]
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

const readOptionalBoolean = (record: Record<string, unknown>, key: string): boolean | null => {
  const value = record[key]
  return typeof value === "boolean" ? value : null
}

const readNumberArray = (value: unknown): ReadonlyArray<number> =>
  Array.isArray(value)
    ? value.filter((entry): entry is number => typeof entry === "number" && Number.isFinite(entry))
    : []

const toRecordArray = (value: unknown): ReadonlyArray<Record<string, unknown>> =>
  Array.isArray(value) ? value.filter(isRecord) : []

const formatCommand = (command: string, args: ReadonlyArray<string>): string =>
  [command, ...args].join(" ")

const tailExcerpt = (stdout: string, stderr: string): string =>
  `${stdout}\n${stderr}`
    .trim()
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .slice(-4)
    .join(" | ")

const toChildProcessError = (args: {
  readonly code: string
  readonly command: string
  readonly result: HostCommandResult
  readonly nextStep: string
}) =>
  new ChildProcessError({
    code: args.code,
    command: args.command,
    reason: tailExcerpt(args.result.stdout, args.result.stderr) || `${args.command} exited unsuccessfully.`,
    nextStep: args.nextStep,
    exitCode: args.result.exitCode,
    stderrExcerpt: tailExcerpt(args.result.stdout, args.result.stderr),
  })

const parseJsonDocument = (raw: string): unknown => {
  const trimmed = raw.trim()

  if (trimmed.length === 0) {
    throw new EnvironmentError({
      code: "xcresult-json-empty",
      reason: "The Apple tooling command returned no JSON output.",
      nextStep: "Inspect the xcresult bundle and retry the drill request.",
      details: [],
    })
  }

  const lines = trimmed.split(/\r?\n/)
  const jsonLineIndex = lines.findIndex((line) => {
    const candidate = line.trimStart()
    return candidate.startsWith("{") || candidate.startsWith("[")
  })
  const candidate = jsonLineIndex >= 0 ? lines.slice(jsonLineIndex).join("\n") : trimmed

  try {
    return JSON.parse(candidate)
  } catch {
    throw new EnvironmentError({
      code: "xcresult-json-parse",
      reason: "The Apple tooling command returned malformed JSON output.",
      nextStep: "Inspect the xcresult bundle and retry the drill request.",
      details: [],
    })
  }
}

const runJsonCommand = async (args: {
  readonly runCommand: (command: string, commandArgs: ReadonlyArray<string>) => Promise<HostCommandResult>
  readonly command: string
  readonly commandArgs: ReadonlyArray<string>
  readonly code: string
  readonly nextStep: string
}): Promise<unknown> => {
  const result = await args.runCommand(args.command, args.commandArgs)

  if (result.exitCode !== 0) {
    throw toChildProcessError({
      code: args.code,
      command: formatCommand(args.command, args.commandArgs),
      result,
      nextStep: args.nextStep,
    })
  }

  return parseJsonDocument(result.stdout)
}

const collectFailureTexts = (summary: unknown): Map<string, Array<string>> => {
  const failures = new Map<string, Array<string>>()

  if (!isRecord(summary)) {
    return failures
  }

  const rawFailures = Array.isArray(summary.testFailures)
    ? summary.testFailures
    : summary.testFailures === undefined || summary.testFailures === null
      ? []
      : [summary.testFailures]

  for (const failure of rawFailures.filter(isRecord)) {
    const message = readOptionalString(failure, "failureText")

    if (!message) {
      continue
    }

    for (const key of [
      readOptionalString(failure, "testIdentifierURL"),
      readOptionalString(failure, "testIdentifierString"),
      readOptionalString(failure, "testName"),
    ]) {
      if (!key) {
        continue
      }

      const existing = failures.get(key) ?? []
      failures.set(key, [...existing, message])
    }
  }

  return failures
}

const collectIssuesFromNode = (node: Record<string, unknown>): ReadonlyArray<{
  readonly kind: "failure" | "warning"
  readonly message: string
}> => {
  const issues: Array<{
    readonly kind: "failure" | "warning"
    readonly message: string
  }> = []

  const visit = (current: Record<string, unknown>) => {
    const nodeType = readOptionalString(current, "nodeType")
    const name = readOptionalString(current, "name")
    const details = readOptionalString(current, "details")

    if (nodeType === "Failure Message") {
      issues.push({ kind: "failure", message: details ?? name ?? "Test failure" })
    }

    if (nodeType === "Runtime Warning") {
      issues.push({ kind: "warning", message: details ?? name ?? "Runtime warning" })
    }

    for (const child of toRecordArray(current.children)) {
      visit(child)
    }
  }

  visit(node)

  return [...new Map(issues.map((issue) => [`${issue.kind}:${issue.message}`, issue])).values()]
}

const findDescendantsByType = (
  node: Record<string, unknown>,
  nodeType: string,
): ReadonlyArray<Record<string, unknown>> => {
  const matches: Array<Record<string, unknown>> = []

  const visit = (current: Record<string, unknown>) => {
    if (readOptionalString(current, "nodeType") === nodeType) {
      matches.push(current)
    }

    for (const child of toRecordArray(current.children)) {
      visit(child)
    }
  }

  for (const child of toRecordArray(node.children)) {
    visit(child)
  }

  return matches
}

const collectTestCaseNodes = (tests: unknown): ReadonlyArray<Record<string, unknown>> => {
  if (!isRecord(tests)) {
    return []
  }

  const testCases: Array<Record<string, unknown>> = []

  const visit = (node: Record<string, unknown>) => {
    if (readOptionalString(node, "nodeType") === "Test Case") {
      testCases.push(node)
    }

    for (const child of toRecordArray(node.children)) {
      visit(child)
    }
  }

  for (const node of toRecordArray(tests.testNodes)) {
    visit(node)
  }

  if (testCases.length > 0) {
    return testCases
  }

  const testRuns: Array<Record<string, unknown>> = []

  const visitRuns = (node: Record<string, unknown>) => {
    if (readOptionalString(node, "nodeType") === "Test Case Run") {
      testRuns.push(node)
    }

    for (const child of toRecordArray(node.children)) {
      visitRuns(child)
    }
  }

  for (const node of toRecordArray(tests.testNodes)) {
    visitRuns(node)
  }

  return testRuns
}

const buildSummaryPayload = (args: {
  readonly bundlePath: string
  readonly summary: unknown
  readonly tests: unknown
  readonly coverage: XcresultSummaryReport["coverage"]
  readonly logArtifacts: ReadonlyArray<SessionArtifactPath>
}): XcresultSummaryReport => {
  const summary = isRecord(args.summary) ? args.summary : {}
  const failures = collectFailureTexts(args.summary)
  const testCases = collectTestCaseNodes(args.tests)
  const topInsights = toRecordArray(summary.topInsights).map((insight) => ({
    impact: readOptionalString(insight, "impact"),
    category: readOptionalString(insight, "category"),
    text: readOptionalString(insight, "text"),
  }))
  const statistics = toRecordArray(summary.statistics).map((statistic) => ({
    title: readOptionalString(statistic, "title"),
    subtitle: readOptionalString(statistic, "subtitle"),
  }))

  return {
    kind: "xcresult-summary" as const,
    bundlePath: args.bundlePath,
    bundleName: basename(args.bundlePath),
    title: readOptionalString(summary, "title") ?? basename(args.bundlePath),
    environmentDescription: readOptionalString(summary, "environmentDescription"),
    result: readOptionalString(summary, "result") ?? "unknown",
    totals: {
      totalTests: readOptionalNumber(summary, "totalTestCount"),
      passedTests: readOptionalNumber(summary, "passedTests"),
      failedTests: readOptionalNumber(summary, "failedTests"),
      skippedTests: readOptionalNumber(summary, "skippedTests"),
      expectedFailures: readOptionalNumber(summary, "expectedFailures"),
    },
    timings: {
      startTime: readOptionalNumber(summary, "startTime"),
      finishTime: readOptionalNumber(summary, "finishTime"),
    },
    insights: topInsights,
    statistics,
    logPaths: args.logArtifacts.map((artifact) => ({
      artifactKey: artifact.key,
      path: artifact.absolutePath,
      summary: artifact.summary,
    })),
    coverage: args.coverage,
    failures: [...failures.entries()].flatMap(([key, messages]) =>
      messages.map((message) => ({ identifier: key, message }))),
    tests: testCases.map((testCase) => {
      const primaryRun = findDescendantsByType(testCase, "Test Case Run")[0] ?? testCase
      const identifier = readOptionalString(primaryRun, "nodeIdentifier") ?? readOptionalString(testCase, "nodeIdentifier")
      const fallbackIssues = [
        ...(identifier ? failures.get(identifier) ?? [] : []),
        ...(readOptionalString(testCase, "name") ? failures.get(readOptionalString(testCase, "name")!) ?? [] : []),
      ].map((message) => ({ kind: "failure" as const, message }))
      const issues = collectIssuesFromNode(testCase)
      const dedupedIssues = [...new Map([...issues, ...fallbackIssues].map((issue) => [`${issue.kind}:${issue.message}`, issue])).values()]

      return {
        id: identifier,
        name: readOptionalString(testCase, "name") ?? readOptionalString(primaryRun, "name") ?? "unnamed-test",
        result: readOptionalString(primaryRun, "result") ?? readOptionalString(testCase, "result") ?? "unknown",
        duration: readOptionalString(primaryRun, "duration") ?? readOptionalString(testCase, "duration"),
        durationInSeconds:
          readOptionalNumber(primaryRun, "durationInSeconds") ?? readOptionalNumber(testCase, "durationInSeconds"),
        issues: dedupedIssues,
      }
    }),
  }
}

const seemsTextBuffer = (buffer: Buffer): boolean => {
  if (buffer.includes(0)) {
    return false
  }

  const sample = buffer.subarray(0, 512)
  const printable = [...sample].filter((byte) =>
    byte === 9 || byte === 10 || byte === 13 || (byte >= 32 && byte <= 126)).length

  return sample.length === 0 || printable / sample.length > 0.85
}

const inferAttachmentKind = async (absolutePath: string, fileName: string): Promise<{ kind: ArtifactKind; mediaType: string }> => {
  switch (extname(fileName).toLowerCase()) {
    case ".json":
      return { kind: "json", mediaType: "application/json" }
    case ".xml":
      return { kind: "xml", mediaType: "application/xml" }
    case ".plist":
      return { kind: "xml", mediaType: "application/x-plist" }
    case ".txt":
    case ".log":
    case ".md":
    case ".csv":
      return { kind: "text", mediaType: "text/plain" }
    case ".png":
      return { kind: "png", mediaType: "image/png" }
    case ".mp4":
      return { kind: "mp4", mediaType: "video/mp4" }
    case ".mov":
      return { kind: "mov", mediaType: "video/quicktime" }
    case ".jpg":
    case ".jpeg":
      return { kind: "binary", mediaType: "image/jpeg" }
    case ".heic":
      return { kind: "binary", mediaType: "image/heic" }
    default: {
      const content = await readFile(absolutePath)
      return seemsTextBuffer(content)
        ? { kind: "text", mediaType: "text/plain" }
        : { kind: "binary", mediaType: "application/octet-stream" }
    }
  }
}

const makeAttachmentId = (args: {
  readonly testIdentifier: string
  readonly testIdentifierURL: string | null
  readonly exportedFileName: string
  readonly timestamp: number | null
  readonly repetitionNumber: number | null
}) =>
  `att-${createHash("sha1")
    .update(JSON.stringify(args))
    .digest("hex")
    .slice(0, 16)}`

const readAttachmentManifest = async (exportDirectory: string): Promise<ReadonlyArray<XcresultAttachmentRecord>> => {
  const manifestPath = join(exportDirectory, "manifest.json")
  const manifest = parseJsonDocument(await readFile(manifestPath, "utf8"))
  const records = Array.isArray(manifest)
    ? manifest.filter(isRecord)
    : isRecord(manifest) && Array.isArray(manifest.attachments)
      ? manifest.attachments.filter(isRecord)
      : []

  return Promise.all(records.map(async (record) => {
    const attachment = isRecord(record.attachments) ? record.attachments : {}
    const exportedFileName = readOptionalString(attachment, "exportedFileName")

    if (!exportedFileName) {
      throw new EnvironmentError({
        code: "xcresult-attachment-manifest",
        reason: "The exported xcresult attachment manifest did not include an exported file name.",
        nextStep: "Inspect the result bundle attachments and retry the drill request.",
        details: [],
      })
    }

    const absolutePath = join(exportDirectory, exportedFileName)
    const fileStat = await stat(absolutePath)
    const inferred = await inferAttachmentKind(absolutePath, exportedFileName)
    const testIdentifier = readOptionalString(record, "testIdentifier") ?? "unknown-test"
    const testIdentifierURL = readOptionalString(record, "testIdentifierURL")
    const timestamp = readOptionalNumber(attachment, "timestamp")
    const repetitionNumber = readOptionalNumber(attachment, "repetitionNumber")

    return {
      id: makeAttachmentId({
        testIdentifier,
        testIdentifierURL,
        exportedFileName,
        timestamp,
        repetitionNumber,
      }),
      testIdentifier,
      testIdentifierURL,
      exportedFileName,
      name: readOptionalString(attachment, "suggestedHumanReadableName") ?? exportedFileName,
      associatedWithFailure: readOptionalBoolean(attachment, "isAssociatedWithFailure") ?? false,
      timestamp,
      configurationName: readOptionalString(attachment, "configurationName"),
      deviceName: readOptionalString(attachment, "deviceName"),
      deviceId: readOptionalString(attachment, "deviceId"),
      repetitionNumber,
      arguments: readNumberArray(attachment.arguments),
      mediaType: inferred.mediaType,
      artifactKind: inferred.kind,
      sizeBytes: fileStat.size,
      absolutePath,
    } satisfies XcresultAttachmentRecord
  }))
}

const exportAttachments = async (args: {
  readonly bundlePath: string
  readonly runCommand: (command: string, commandArgs: ReadonlyArray<string>) => Promise<HostCommandResult>
}): Promise<ReadonlyArray<XcresultAttachmentRecord>> => {
  const exportDirectory = await mkdtemp(join(tmpdir(), "probe-cli-xcresult-attachments-"))

  try {
    const command = "/usr/bin/xcrun"
    const commandArgs = [
      "xcresulttool",
      "export",
      "attachments",
      "--path",
      args.bundlePath,
      "--output-path",
      exportDirectory,
    ]
    const result = await args.runCommand(command, commandArgs)

    if (result.exitCode !== 0) {
      throw toChildProcessError({
        code: "xcresult-attachments-export",
        command: formatCommand(command, commandArgs),
        result,
        nextStep: "Inspect the result bundle attachments and retry the drill request.",
      })
    }

    return await readAttachmentManifest(exportDirectory)
  } finally {
    // The individual attachment drill copies any selected file into session outputs before cleanup.
    await rm(exportDirectory, { recursive: true, force: true })
  }
}

const exportAttachmentsWithLease = async <T>(args: {
  readonly bundlePath: string
  readonly runCommand: (command: string, commandArgs: ReadonlyArray<string>) => Promise<HostCommandResult>
  readonly use: (attachments: ReadonlyArray<XcresultAttachmentRecord>) => Promise<T>
}): Promise<T> => {
  const exportDirectory = await mkdtemp(join(tmpdir(), "probe-cli-xcresult-attachments-"))

  try {
    const command = "/usr/bin/xcrun"
    const commandArgs = [
      "xcresulttool",
      "export",
      "attachments",
      "--path",
      args.bundlePath,
      "--output-path",
      exportDirectory,
    ]
    const result = await args.runCommand(command, commandArgs)

    if (result.exitCode !== 0) {
      throw toChildProcessError({
        code: "xcresult-attachments-export",
        command: formatCommand(command, commandArgs),
        result,
        nextStep: "Inspect the result bundle attachments and retry the drill request.",
      })
    }

    const attachments = await readAttachmentManifest(exportDirectory)
    return await args.use(attachments)
  } finally {
    await rm(exportDirectory, { recursive: true, force: true })
  }
}

const buildCoverageSummary = (coverage: unknown): XcresultSummaryReport["coverage"] => {
  if (!isRecord(coverage)) {
    return {
      available: false,
      reason: "Coverage output was not a JSON object.",
      coveredLines: null,
      executableLines: null,
      lineCoverage: null,
      targets: [],
    }
  }

  return {
    available: true,
    reason: null,
    coveredLines: readOptionalNumber(coverage, "coveredLines"),
    executableLines: readOptionalNumber(coverage, "executableLines"),
    lineCoverage: readOptionalNumber(coverage, "lineCoverage"),
    targets: toRecordArray(coverage.targets).map((target) => ({
      name: readOptionalString(target, "name"),
      coveredLines: readOptionalNumber(target, "coveredLines"),
      executableLines: readOptionalNumber(target, "executableLines"),
      lineCoverage: readOptionalNumber(target, "lineCoverage"),
      fileCount: Array.isArray(target.files) ? target.files.length : null,
    })),
  }
}

const readCoverageSummary = async (args: {
  readonly bundlePath: string
  readonly runCommand: (command: string, commandArgs: ReadonlyArray<string>) => Promise<HostCommandResult>
}): Promise<XcresultSummaryReport["coverage"]> => {
  try {
    const coverage = await runJsonCommand({
      runCommand: args.runCommand,
      command: "/usr/bin/xcrun",
      commandArgs: ["xccov", "view", "--report", "--json", args.bundlePath],
      code: "xccov-report",
      nextStep: "Inspect the xcresult coverage data and retry the drill request.",
    })

    return buildCoverageSummary(coverage)
  } catch (error) {
    return {
      available: false,
      reason: error instanceof ChildProcessError || error instanceof EnvironmentError
        ? error.reason
        : error instanceof Error
          ? error.message
          : String(error),
      coveredLines: null,
      executableLines: null,
      lineCoverage: null,
      targets: [],
    }
  }
}

const renderSummaryLabel = (bundlePath: string): string => `xcresult summary for ${basename(bundlePath)}`

const renderAttachmentsLabel = (bundlePath: string, count: number): string =>
  `${count} xcresult attachment(s) from ${basename(bundlePath)}`

const buildAttachmentsPayload = (args: {
  readonly bundlePath: string
  readonly attachments: ReadonlyArray<XcresultAttachmentRecord>
}): XcresultAttachmentsReport => ({
  kind: "xcresult-attachments",
  bundlePath: args.bundlePath,
  bundleName: basename(args.bundlePath),
  count: args.attachments.length,
  attachments: args.attachments.map((attachment) => ({
    id: attachment.id,
    testIdentifier: attachment.testIdentifier,
    testIdentifierURL: attachment.testIdentifierURL,
    exportedFileName: attachment.exportedFileName,
    name: attachment.name,
    associatedWithFailure: attachment.associatedWithFailure,
    timestamp: attachment.timestamp,
    configurationName: attachment.configurationName,
    deviceName: attachment.deviceName,
    deviceId: attachment.deviceId,
    repetitionNumber: attachment.repetitionNumber,
    arguments: attachment.arguments,
    mediaType: attachment.mediaType,
    artifactKind: attachment.artifactKind,
    sizeBytes: attachment.sizeBytes,
  })),
})

export const inspectXcresultSummary = async (args: {
  readonly bundlePath: string
  readonly sessionArtifacts: ReadonlyArray<SessionArtifactPath>
  readonly runCommand: (command: string, commandArgs: ReadonlyArray<string>) => Promise<HostCommandResult>
}): Promise<XcresultInspection<XcresultSummaryReport>> => {
  const [summary, tests, coverage] = await Promise.all([
    runJsonCommand({
      runCommand: args.runCommand,
      command: "/usr/bin/xcrun",
      commandArgs: ["xcresulttool", "get", "test-results", "summary", "--path", args.bundlePath, "--compact"],
      code: "xcresult-summary",
      nextStep: "Inspect the result bundle summary and retry the drill request.",
    }),
    runJsonCommand({
      runCommand: args.runCommand,
      command: "/usr/bin/xcrun",
      commandArgs: ["xcresulttool", "get", "test-results", "tests", "--path", args.bundlePath, "--compact"],
      code: "xcresult-tests",
      nextStep: "Inspect the result bundle tests and retry the drill request.",
    }),
    readCoverageSummary({ bundlePath: args.bundlePath, runCommand: args.runCommand }),
  ])

  const logArtifacts = args.sessionArtifacts.filter((artifact) =>
    artifact.key.includes("log") || artifact.key === "stdout-events")
  const payload = buildSummaryPayload({
    bundlePath: args.bundlePath,
    summary,
    tests,
    coverage,
    logArtifacts,
  })

  return {
    report: payload,
    summary: renderSummaryLabel(args.bundlePath),
  }
}

const renderSummary = async (args: {
  readonly bundlePath: string
  readonly sessionArtifacts: ReadonlyArray<SessionArtifactPath>
  readonly runCommand: (command: string, commandArgs: ReadonlyArray<string>) => Promise<HostCommandResult>
}): Promise<XcresultRenderedDrill> => {
  const inspected = await inspectXcresultSummary(args)

  return {
    kind: "content",
    format: "json",
    content: `${JSON.stringify(inspected.report, null, 2)}\n`,
    summary: inspected.summary,
  }
}

export const inspectXcresultAttachments = async (args: {
  readonly bundlePath: string
  readonly runCommand: (command: string, commandArgs: ReadonlyArray<string>) => Promise<HostCommandResult>
}): Promise<XcresultInspection<XcresultAttachmentsReport>> => {
  const attachments = await exportAttachments({ bundlePath: args.bundlePath, runCommand: args.runCommand })
  const payload = buildAttachmentsPayload({
    bundlePath: args.bundlePath,
    attachments,
  })

  return {
    report: payload,
    summary: renderAttachmentsLabel(args.bundlePath, attachments.length),
  }
}

const renderAttachmentsListing = async (args: {
  readonly bundlePath: string
  readonly runCommand: (command: string, commandArgs: ReadonlyArray<string>) => Promise<HostCommandResult>
}): Promise<XcresultRenderedDrill> => {
  const inspected = await inspectXcresultAttachments(args)

  return {
    kind: "content",
    format: "json",
    content: `${JSON.stringify(inspected.report, null, 2)}\n`,
    summary: inspected.summary,
  }
}

const renderAttachment = async (args: {
  readonly bundlePath: string
  readonly attachmentId: string
  readonly runCommand: (command: string, commandArgs: ReadonlyArray<string>) => Promise<HostCommandResult>
}): Promise<XcresultRenderedDrill> =>
  exportAttachmentsWithLease({
    bundlePath: args.bundlePath,
    runCommand: args.runCommand,
    use: async (attachments) => {
      const attachment = attachments.find((candidate) => candidate.id === args.attachmentId)

      if (!attachment) {
        throw new UserInputError({
          code: "xcresult-attachment-id",
          reason: `Attachment id ${args.attachmentId} was not found in ${basename(args.bundlePath)}.`,
          nextStep: "List the xcresult attachments first and retry with one of the returned ids.",
          details: [],
        })
      }

      if (attachment.artifactKind === "json") {
        const content = JSON.stringify(parseJsonDocument(await readFile(attachment.absolutePath, "utf8")), null, 2)
        return {
          kind: "content",
          format: "json",
          content: `${content}\n`,
          summary: `xcresult attachment ${attachment.name} (${attachment.id})`,
        }
      }

      if (attachment.artifactKind === "text" || attachment.artifactKind === "xml") {
        const content = await readFile(attachment.absolutePath, "utf8")
        return {
          kind: "content",
          format: "text",
          content,
          summary: `xcresult attachment ${attachment.name} (${attachment.id})`,
        }
      }

      return {
        kind: "artifact-file",
        artifactKind: attachment.artifactKind,
        sourceAbsolutePath: attachment.absolutePath,
        sourceFileName: attachment.exportedFileName,
        label: `xcresult-attachment-${attachment.id}`,
        summary:
          `xcresult attachment ${attachment.name} (${attachment.mediaType}, ${attachment.sizeBytes} bytes) copied from ${basename(args.bundlePath)}`,
      }
    },
  })

export const renderXcresultDrill = async (args: {
  readonly bundlePath: string
  readonly query: XcresultDrillQuery
  readonly sessionArtifacts: ReadonlyArray<SessionArtifactPath>
  readonly runCommand: (command: string, commandArgs: ReadonlyArray<string>) => Promise<HostCommandResult>
}): Promise<XcresultRenderedDrill> => {
  switch (args.query.view) {
    case "summary":
      return renderSummary(args)
    case "attachments":
      return args.query.attachmentId
        ? renderAttachment({
            bundlePath: args.bundlePath,
            attachmentId: args.query.attachmentId,
            runCommand: args.runCommand,
          })
        : renderAttachmentsListing({
            bundlePath: args.bundlePath,
            runCommand: args.runCommand,
          })
  }
}
