import { Effect } from "effect"
import { ProbeKernel } from "../../services/ProbeKernel"

export const runServeCommand = Effect.gen(function* () {
  const kernel = yield* ProbeKernel
  yield* kernel.serve()
})
