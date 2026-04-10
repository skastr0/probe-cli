import { Effect } from "effect"
import { UserInputError } from "../domain/errors"

const missingValueError = (flag: string) =>
  Effect.fail(
    new UserInputError({
    code: "missing-option-value",
    reason: `Option ${flag} requires a value.`,
    nextStep: `Provide ${flag} <value> and retry the command.`,
    details: [],
    }),
  )

export const requireOption = (args: ReadonlyArray<string>, flag: string) =>
  Effect.gen(function* () {
    const index = args.indexOf(flag)

    if (index === -1) {
      return yield* Effect.fail(
        new UserInputError({
        code: "missing-option",
        reason: `Missing required option ${flag}.`,
        nextStep: `Provide ${flag} <value> and retry the command.`,
        details: [],
        }),
      )
    }

    if (index === args.length - 1) {
      return yield* missingValueError(flag)
    }

    return args[index + 1]!
  })

export const optionalOption = (args: ReadonlyArray<string>, flag: string) =>
  Effect.gen(function* () {
    const index = args.indexOf(flag)

    if (index === -1) {
      return null
    }

    if (index === args.length - 1) {
      return yield* missingValueError(flag)
    }

    return args[index + 1]!
  })

export const invalidOption = (flag: string, reason: string, nextStep: string) =>
  Effect.fail(
    new UserInputError({
      code: "invalid-option",
      reason: `${flag}: ${reason}`,
      nextStep,
      details: [],
    }),
  )

export const unknownSubcommand = (group: string, subcommand: string | undefined) =>
  Effect.fail(
    new UserInputError({
      code: "unknown-subcommand",
      reason: `Unknown ${group} subcommand: ${subcommand ?? "<missing>"}.`,
      nextStep: `Run \`probe ${group}\` with a supported subcommand and retry.`,
      details: [],
    }),
  )
