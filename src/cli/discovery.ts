import { Effect } from "effect"
import { UserInputError } from "../domain/errors"
import { perfTemplateChoiceText } from "../domain/perf"
import { hasMachineJsonOutput } from "./json"

export interface SchemaDiscoveryEntry {
  readonly schema_id: string
  readonly command: string
  readonly rpc_method: string | null
  readonly description: string
  readonly input_controls: ReadonlyArray<string>
  readonly output_controls: ReadonlyArray<string>
  readonly payload_shape: Record<string, unknown>
  readonly result_shape: Record<string, unknown>
}

export interface ExampleDiscoveryEntry {
  readonly name: string
  readonly command: string
  readonly description: string
  readonly invocation: string
  readonly payload: Record<string, unknown> | null
}

const outputControls = ["--output-json", "--json (compatibility alias)"]
const jsonInputControls = ["--input-json <json>", "--file <payload.json>", "--stdin"]

export const schemaEntries: ReadonlyArray<SchemaDiscoveryEntry> = [
  {
    schema_id: "probe.command.capabilities.input/v1",
    command: "capabilities",
    rpc_method: null,
    description: "Report daemon, runner, simulator/device, artifact, accessibility, commerce, performance, logging, and optional dependency readiness.",
    input_controls: [],
    output_controls: [...outputControls],
    payload_shape: {},
    result_shape: { workspaceStatus: "WorkspaceStatus" },
  },
  {
    schema_id: "probe.command.session.open.input/v1",
    command: "session open",
    rpc_method: "session.open",
    description: "Open a simulator or device session.",
    input_controls: ["--input-json <json>"],
    output_controls: [...outputControls],
    payload_shape: {
      target: "simulator|device optional",
      bundleId: "string optional; defaults to dev.probe.fixture",
      simulatorUdid: "string|null optional",
      deviceId: "string|null optional",
    },
    result_shape: { sessionHealth: "SessionHealth" },
  },
  {
    schema_id: "probe.command.validate.accessibility.input/v1",
    command: "validate accessibility",
    rpc_method: null,
    description: "Validate current-screen accessibility for a session.",
    input_controls: ["--input-json <json>"],
    output_controls: [...outputControls],
    payload_shape: { sessionId: "string", scope: "current-screen optional" },
    result_shape: { report: "AccessibilityValidationReport" },
  },
  {
    schema_id: "probe.command.validate.commerce.input/v1",
    command: "validate commerce",
    rpc_method: null,
    description: "Run commerce validation with optional inline plan payload.",
    input_controls: ["--input-json <json>", "--plan <commerce-plan.json>"],
    output_controls: [...outputControls],
    payload_shape: {
      sessionId: "string",
      mode: "local-storekit|sandbox|testflight",
      provider: "revenuecat|null optional",
      plan: "CommerceValidationPlan|null optional",
    },
    result_shape: { report: "CommerceValidationReport" },
  },
  {
    schema_id: "probe.command.doctor.accessibility.input/v1",
    command: "doctor accessibility",
    rpc_method: null,
    description: "Check accessibility readiness for a session.",
    input_controls: ["--input-json <json>"],
    output_controls: [...outputControls],
    payload_shape: { sessionId: "string" },
    result_shape: { report: "AccessibilityDoctorReport" },
  },
  {
    schema_id: "probe.command.doctor.commerce.input/v1",
    command: "doctor commerce",
    rpc_method: null,
    description: "Check commerce readiness for a bundle id.",
    input_controls: ["--input-json <json>"],
    output_controls: [...outputControls],
    payload_shape: {
      bundleId: "string",
      mode: "local-storekit|sandbox|testflight|null optional",
      provider: "revenuecat|null optional",
      storekitConfigPath: "string|null optional",
    },
    result_shape: { report: "CommerceDoctorReport" },
  },
  {
    schema_id: "probe.command.doctor.capture.input/v1",
    command: "doctor capture",
    rpc_method: "session.diagnostic.capture",
    description: "Capture simulator or device diagnostic artifacts.",
    input_controls: ["--input-json <json>"],
    output_controls: [...outputControls],
    payload_shape: { sessionId: "string", target: "simulator|device", kind: "sysdiagnose|null optional" },
    result_shape: { result: "SummaryArtifactResult" },
  },
  {
    schema_id: "probe.command.session.logs.input/v1",
    command: "session logs",
    rpc_method: "session.logs",
    description: "Read or capture a compact log view with filters.",
    input_controls: ["--input-json <json>"],
    output_controls: [...outputControls],
    payload_shape: {
      sessionId: "string",
      source: "runner|build|wrapper|stdout|simulator optional",
      lineCount: "positive integer optional",
      match: "string|null optional",
      outputMode: "auto|inline|artifact optional",
      captureSeconds: "positive integer optional",
      predicate: "string|null optional",
      process: "string|null optional",
      subsystem: "string|null optional",
      category: "string|null optional",
    },
    result_shape: { result: "SessionLogsResult" },
  },
  {
    schema_id: "probe.command.perf.record.input/v1",
    command: "perf record",
    rpc_method: "perf.record",
    description: "Record a bounded Instruments trace.",
    input_controls: ["--input-json <json>"],
    output_controls: [...outputControls],
    payload_shape: {
      sessionId: "string",
      template: perfTemplateChoiceText,
      customTemplatePath: "string optional",
      timeLimit: "duration optional",
    },
    result_shape: { result: "PerfRecordResult" },
  },
  {
    schema_id: "probe.command.perf.around.input/v1",
    command: "perf around",
    rpc_method: "perf.around",
    description: "Record a trace while running a session flow.",
    input_controls: [...jsonInputControls],
    output_controls: [...outputControls],
    payload_shape: { sessionId: "string", template: perfTemplateChoiceText, flow: "SessionFlowContract" },
    result_shape: { result: "PerfAroundFlowResult" },
  },
  {
    schema_id: "probe.command.drill.input/v1",
    command: "drill",
    rpc_method: "artifact.drill",
    description: "Inspect a bounded window into a text, JSON, XML, or xcresult artifact.",
    input_controls: ["--input-json <json>"],
    output_controls: [...outputControls],
    payload_shape: { sessionId: "string", artifactKey: "string", outputMode: "auto|inline|artifact optional", query: "DrillQuery" },
    result_shape: { result: "DrillResult" },
  },
  {
    schema_id: "probe.command.session.action.input/v1",
    command: "session action",
    rpc_method: "session.action",
    description: "Perform one UI action.",
    input_controls: [...jsonInputControls],
    output_controls: [...outputControls],
    payload_shape: { sessionId: "string optional when --session-id is provided", action: "SessionAction or bare SessionAction" },
    result_shape: { result: "SessionActionResult" },
  },
  {
    schema_id: "probe.command.session.run.input/v1",
    command: "session run",
    rpc_method: "session.run",
    description: "Run a multi-step flow.",
    input_controls: [...jsonInputControls],
    output_controls: [...outputControls],
    payload_shape: { sessionId: "string optional when --session-id is provided", flow: "SessionFlowContract or bare SessionFlowContract" },
    result_shape: { result: "SessionFlowResult" },
  },
  {
    schema_id: "probe.command.session.replay.input/v1",
    command: "session replay",
    rpc_method: "session.replay",
    description: "Replay an exported action recording.",
    input_controls: [...jsonInputControls],
    output_controls: [...outputControls],
    payload_shape: { sessionId: "string optional when --session-id is provided", script: "ActionRecordingScript or bare ActionRecordingScript" },
    result_shape: { result: "SessionReplayResult" },
  },
  {
    schema_id: "probe.command.session.result.input/v1",
    command: "session result summary|attachments",
    rpc_method: "session.result.summary|session.result.attachments",
    description: "Inspect aggregate result artifacts for a session.",
    input_controls: ["--input-json <json>"],
    output_controls: [...outputControls],
    payload_shape: { sessionId: "string" },
    result_shape: { result: "SessionResultSummaryResult|SessionResultAttachmentsResult" },
  },
  {
    schema_id: "probe.rpc.frames/v1",
    command: "rpc frames",
    rpc_method: "*",
    description: "Daemon RPC uses newline-delimited JSON request, response, failure, and event frames.",
    input_controls: ["Unix socket NDJSON"],
    output_controls: ["Unix socket NDJSON"],
    payload_shape: {
      request: { kind: "request", protocolVersion: "probe-rpc/v1", requestId: "string", method: "RpcMethod", params: "object" },
      event: { kind: "event", type: "string", sequence: "number", timestamp: "ISO-8601", requestId: "string", method: "RpcMethod", data: "object" },
      failure: { kind: "failure", requestId: "string", method: "RpcMethod", failure: "ProbeFailurePayload" },
    },
    result_shape: {
      response: { kind: "response", protocolVersion: "probe-rpc/v1", requestId: "string", method: "RpcMethod", result: "object" },
    },
  },
]

export const exampleEntries: ReadonlyArray<ExampleDiscoveryEntry> = [
  {
    name: "session-open-fixture-json",
    command: "session open",
    description: "Open the built-in simulator fixture app with explicit JSON output.",
    invocation: "probe session open --input-json '{\"target\":\"simulator\",\"bundleId\":\"dev.probe.fixture\"}' --output-json",
    payload: { target: "simulator", bundleId: "dev.probe.fixture" },
  },
  {
    name: "session-action-tap-json",
    command: "session action",
    description: "Tap a known accessibility ref from an inline JSON payload.",
    invocation: "probe session action --input-json '{\"sessionId\":\"<session-id>\",\"action\":{\"kind\":\"tap\",\"target\":{\"kind\":\"ref\",\"ref\":\"@e5\",\"fallback\":null}}}' --output-json",
    payload: {
      sessionId: "<session-id>",
      action: { kind: "tap", target: { kind: "ref", ref: "@e5", fallback: null } },
    },
  },
  {
    name: "session-run-file-json",
    command: "session run",
    description: "Run a flow from a JSON file and request machine output.",
    invocation: "probe session run --session-id <session-id> --file docs/examples/flows/verified-only-v1.json --output-json",
    payload: null,
  },
  {
    name: "logs-filter-json",
    command: "session logs",
    description: "Fetch a filtered simulator log window through a JSON payload.",
    invocation: "probe session logs --input-json '{\"sessionId\":\"<session-id>\",\"source\":\"simulator\",\"lineCount\":120,\"match\":\"payment\",\"outputMode\":\"auto\",\"captureSeconds\":3}' --output-json",
    payload: {
      sessionId: "<session-id>",
      source: "simulator",
      lineCount: 120,
      match: "payment",
      outputMode: "auto",
      captureSeconds: 3,
    },
  },
  {
    name: "perf-record-json",
    command: "perf record",
    description: "Record a bounded time profiler trace with a JSON payload.",
    invocation: "probe perf record --input-json '{\"sessionId\":\"<session-id>\",\"template\":\"time-profiler\",\"timeLimit\":\"3s\"}' --output-json",
    payload: { sessionId: "<session-id>", template: "time-profiler", timeLimit: "3s" },
  },
  {
    name: "drill-json-pointer",
    command: "drill",
    description: "Inspect a JSON artifact by pointer.",
    invocation: "probe drill --input-json '{\"sessionId\":\"<session-id>\",\"artifactKey\":\"snapshot.latest\",\"query\":{\"kind\":\"json\",\"pointer\":\"/nodes/0\"},\"outputMode\":\"inline\"}' --output-json",
    payload: {
      sessionId: "<session-id>",
      artifactKey: "snapshot.latest",
      query: { kind: "json", pointer: "/nodes/0" },
      outputMode: "inline",
    },
  },
]

const printJsonEnvelope = (command: string, data: unknown) =>
  Effect.sync(() => {
    console.log(JSON.stringify({ ok: true, command, data }, null, 2))
  })

const printTextList = (rows: ReadonlyArray<{ readonly key: string; readonly command: string; readonly description: string }>) =>
  Effect.sync(() => {
    console.log(rows.map((row) => `${row.key}\n  command: ${row.command}\n  ${row.description}`).join("\n\n"))
  })

const findSchema = (key: string) =>
  schemaEntries.find((entry) =>
    entry.schema_id === key
      || entry.command === key
      || entry.rpc_method === key
      || entry.command.replace(/\s+/g, ".") === key,
  )

const findExample = (key: string) =>
  exampleEntries.find((entry) => entry.name === key || entry.command === key)

export const runSchemaCommand = (args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const [subcommand, key] = args
    const asJson = hasMachineJsonOutput(args)

    switch (subcommand) {
      case "list": {
        const data = {
          schemas: schemaEntries.map(({ schema_id, command, rpc_method, description }) => ({
            schema_id,
            command,
            rpc_method,
            description,
          })),
        }

        if (asJson) {
          yield* printJsonEnvelope("schema list", data)
          return
        }

        yield* printTextList(data.schemas.map((schema) => ({
          key: schema.schema_id,
          command: schema.command,
          description: schema.description,
        })))
        return
      }

      case "show": {
        if (!key) {
          return yield* new UserInputError({
            code: "missing-schema-key",
            reason: "Missing schema id, command name, or RPC method.",
            nextStep: "Run `probe schema list --output-json`, then retry with `probe schema show <schema-id>`.",
            details: [],
          })
        }

        const schema = findSchema(key)

        if (!schema) {
          return yield* new UserInputError({
            code: "unknown-schema",
            reason: `No Probe schema matched ${key}.`,
            nextStep: "Run `probe schema list --output-json` and choose one of the returned schema_id values.",
            details: [],
          })
        }

        if (asJson) {
          yield* printJsonEnvelope("schema show", { schema })
          return
        }

        yield* Effect.sync(() => {
          console.log(`${schema.schema_id}\ncommand: ${schema.command}\nrpc: ${schema.rpc_method ?? "n/a"}\n${schema.description}`)
        })
        return
      }

      default:
        return yield* new UserInputError({
          code: "unknown-schema-subcommand",
          reason: `Unknown schema subcommand: ${subcommand ?? "<missing>"}.`,
          nextStep: "Run `probe schema list --output-json` or `probe schema show <schema-id> --output-json`.",
          details: [],
        })
    }
  })

export const runExamplesCommand = (args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const [subcommand, key] = args
    const asJson = hasMachineJsonOutput(args)

    switch (subcommand) {
      case "list": {
        const data = {
          examples: exampleEntries.map(({ name, command, description }) => ({ name, command, description })),
        }

        if (asJson) {
          yield* printJsonEnvelope("examples list", data)
          return
        }

        yield* printTextList(data.examples.map((example) => ({
          key: example.name,
          command: example.command,
          description: example.description,
        })))
        return
      }

      case "show": {
        if (!key) {
          return yield* new UserInputError({
            code: "missing-example-key",
            reason: "Missing example name or command name.",
            nextStep: "Run `probe examples list --output-json`, then retry with `probe examples show <name>`.",
            details: [],
          })
        }

        const example = findExample(key)

        if (!example) {
          return yield* new UserInputError({
            code: "unknown-example",
            reason: `No Probe example matched ${key}.`,
            nextStep: "Run `probe examples list --output-json` and choose one of the returned example names.",
            details: [],
          })
        }

        if (asJson) {
          yield* printJsonEnvelope("examples show", { example })
          return
        }

        yield* Effect.sync(() => {
          console.log(`${example.name}\ncommand: ${example.command}\n${example.description}\n\n${example.invocation}`)
        })
        return
      }

      default:
        return yield* new UserInputError({
          code: "unknown-examples-subcommand",
          reason: `Unknown examples subcommand: ${subcommand ?? "<missing>"}.`,
          nextStep: "Run `probe examples list --output-json` or `probe examples show <name> --output-json`.",
          details: [],
        })
    }
  })
