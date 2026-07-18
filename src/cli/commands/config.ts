import { Effect } from "effect"
import { UserInputError } from "../../domain/errors"
import {
  developmentTeamEnvKey,
  readPersistedDeviceSigningConfig,
  resolveDevelopmentTeam,
  writePersistedDeviceSigningConfig,
} from "../../services/DeviceSigningConfig"
import { hasMachineJsonOutput } from "../json"
import { optionalOption, unknownSubcommand } from "../options"

/**
 * PRB-095: the CLI-side seam for the "persisted config" precedence tier (see
 * `DeviceSigningConfig`). `session open` resolves this file automatically --
 * this command exists so an operator has a way to set/clear/inspect the
 * persisted default without hand-editing `~/.probe/config.json`.
 */

const formatShow = (args: {
  readonly developmentTeam: string | null
  readonly environmentTeamId: string | null
  readonly resolvedTeamId: string | null
  readonly resolvedSource: string | null
}): string => [
  `persisted development team: ${args.developmentTeam ?? "(none)"}`,
  `${developmentTeamEnvKey}: ${args.environmentTeamId ?? "(unset)"}`,
  `resolved for the next real-device session open: ${
    args.resolvedTeamId
      ? `${args.resolvedTeamId} (from ${args.resolvedSource})`
      : "(none -- session open will require an explicit --team-id)"
  }`,
].join("\n")

const requireTeamIdArgument = (rest: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const flagValue = yield* optionalOption(rest, "--team-id")
    const positional = flagValue ?? rest.find((arg) => !arg.startsWith("--")) ?? null

    if (!positional) {
      return yield* Effect.fail(
        new UserInputError({
          code: "missing-option",
          reason: "Missing required team id.",
          nextStep: "Provide `probe config set-team-id <team-id>` (or `--team-id <team-id>`) and retry.",
          details: [],
        }),
      )
    }

    return positional
  })

export const runConfigCommand = (args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const [subcommand, ...rest] = args
    const asJson = hasMachineJsonOutput(rest)

    switch (subcommand) {
      case undefined:
      case "show": {
        const persisted = yield* Effect.promise(() => readPersistedDeviceSigningConfig())
        const environmentTeamId = process.env[developmentTeamEnvKey] ?? null
        const resolved = resolveDevelopmentTeam({
          explicitTeamId: null,
          persistedTeamId: persisted.developmentTeam,
          environmentTeamId,
        })

        yield* Effect.sync(() => {
          const output = asJson
            ? JSON.stringify({
                developmentTeam: persisted.developmentTeam,
                environmentTeamId,
                resolved,
              }, null, 2)
            : formatShow({
                developmentTeam: persisted.developmentTeam,
                environmentTeamId,
                resolvedTeamId: resolved?.developmentTeam ?? null,
                resolvedSource: resolved?.source ?? null,
              })
          console.log(output)
        })
        return
      }

      case "set-team-id": {
        const teamId = yield* requireTeamIdArgument(rest)
        yield* Effect.promise(() => writePersistedDeviceSigningConfig({ developmentTeam: teamId }))

        yield* Effect.sync(() => {
          console.log(asJson ? JSON.stringify({ developmentTeam: teamId }, null, 2) : `persisted development team: ${teamId}`)
        })
        return
      }

      case "clear-team-id": {
        yield* Effect.promise(() => writePersistedDeviceSigningConfig({ developmentTeam: null }))

        yield* Effect.sync(() => {
          console.log(asJson ? JSON.stringify({ developmentTeam: null }, null, 2) : "persisted development team cleared.")
        })
        return
      }

      default:
        return yield* unknownSubcommand("config", subcommand)
    }
  })
