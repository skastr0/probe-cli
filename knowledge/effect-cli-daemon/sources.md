# Effect CLI daemon research sources

Accessed: 2026-04-09

## Local context used

| Source | Why it matters |
| --- | --- |
| `ARCHITECTURE.md` | Confirms Probe is daemon-first, single-runtime, artifact-first, and expects `ManagedRuntime` + `Layer.scoped` + daemon-owned subprocess cleanup. |
| `AGENTS.md` | Requires Effect guidance first for CLI/daemon work and requires reusable research packs under `knowledge/`. |
| `knowledge/README.md` | Defines the reusable pack shape and the rule to prefer official / primary sources. |
| Telechy Control SDLC item `PRB-003` | Defines the acceptance criteria for this pack. |

## Official / primary external sources

| Topic | Source | Kind | Notes |
| --- | --- | --- | --- |
| `@effect/cli` setup + examples | https://raw.githubusercontent.com/Effect-TS/effect/main/packages/cli/README.md | Primary source | Official package README with install + Node wiring examples. |
| Effect runtime overview + `ManagedRuntime` docs | https://effect.website/docs/runtime/ | Official docs | Cleanest explanation of default runtime vs top-level `ManagedRuntime`. |
| `ManagedRuntime` API | https://effect-ts.github.io/effect/effect/ManagedRuntime.ts.html | Official API docs | Public methods: `runFork`, `runPromise`, `runPromiseExit`, `dispose`, etc. |
| Layer concepts + `Layer.launch` | https://effect.website/docs/requirements-management/layers/ | Official docs | Explains dependency graph modeling and `Layer.launch` for layer-based apps. |
| `Layer` API | https://effect-ts.github.io/effect/effect/Layer.ts.html | Official API docs | Public API for `scoped`, `launch`, `toRuntime`, `buildWithScope`, `extendScope`. |
| Scope + finalizers + `acquireRelease` | https://effect.website/docs/resource-management/scope/ | Official docs | Resource lifetime, reverse-order finalizers, `Effect.scoped`, `Effect.acquireRelease`. |
| Platform command guide | https://effect.website/docs/platform/command/ | Official docs | Public guide for `Command.make`, `Command.start`, streaming, env, stdin/stdout handling. |
| Platform runtime guide | https://effect.website/docs/platform/runtime/ | Official docs | `runMain` behavior: signals, exit codes, teardown, error reporting. |
| Command API | https://effect-ts.github.io/effect/platform/Command.ts.html | Official API docs | Exact signatures for `start`, `string`, `stream`, `runInShell`, `workingDirectory`, etc. |
| Command executor API | https://effect-ts.github.io/effect/platform/CommandExecutor.ts.html | Official API docs | Exact `Process` interface and `CommandExecutor` surface. |
| Node runtime API | https://effect-ts.github.io/effect/platform-node/NodeRuntime.ts.html | Official API docs | Confirms public `NodeRuntime.runMain`. |
| Node command executor API | https://effect-ts.github.io/effect/platform-node/NodeCommandExecutor.ts.html | Official API docs | Confirms exported `layer`. |
| Node command executor implementation | https://raw.githubusercontent.com/Effect-TS/effect/main/packages/platform-node-shared/src/internal/commandExecutor.ts | Primary source (implementation detail) | Shows current spawn / cleanup / process-group behavior. Revalidate on dependency version changes. |
| Effect code-style guidance | https://effect.website/docs/code-style/guidelines/ | Official docs | Explicit guidance to use `NodeRuntime.runMain` for graceful teardown on Node. |
| Node child-process behavior | https://nodejs.org/api/child_process.html | Official docs | Canonical subprocess semantics for `spawn`, `exec`, buffering, pipes, AbortSignal, detached, shell risks. |

## Source-quality notes

- Prefer the public Effect docs / API docs for design and interface choices.
- Use raw Effect source only for **current implementation details** such as how `NodeCommandExecutor` currently supervises spawned processes.
- Treat implementation-detail findings as version-sensitive and re-check them when the Effect dependency is pinned for implementation work.
