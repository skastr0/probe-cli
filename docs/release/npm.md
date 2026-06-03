# npm Release Runbook

Probe's npm distribution is a wrapper package plus native binary packages:

- `@skastr0/probe`: public package with the `probe` bin entry and a Node.js launcher.
- `@skastr0/probe-darwin-arm64`: macOS arm64 native binary.
- `@skastr0/probe-darwin-x64`: macOS x64 native binary.

The launcher is intentionally small. It resolves the installed platform package and executes the bundled native binary. Users should not need Probe source, fixture source outside the binary package, LLDB bridge files outside the binary package, or Bun at runtime. They still need macOS, Node.js/npm for npm installation, and Apple's Xcode tooling for simulator/device control.

## Current Status

`0.1.0` has been bootstrapped on npm:

- `@skastr0/probe@0.1.0`
- `@skastr0/probe-darwin-arm64@0.1.0`
- `@skastr0/probe-darwin-x64@0.1.0`

npm trusted publishing is configured for all three packages with the GitHub repository `skastr0/probe`, workflow file `publish.yml`, and environment `npm-publish`. Do not dispatch the publish workflow for `0.1.0`; future CI releases need a version bump first.

## Local Validation

Run these before any release approval:

```bash
bun install --frozen-lockfile
bun run verify
bun run prepare:npm
bun run validate:npm
```

`bun run validate:npm` performs package dry-runs, packs the tarballs, installs the launcher plus the current host platform package into a clean temporary project, runs `probe --version`, runs `probe doctor --output-json` with a temporary runtime cache, and checks the equivalent `npx --package` path.

## Trusted Publishing Setup

The steady-state release path is GitHub Actions OIDC through `.github/workflows/publish.yml`, with no `NODE_AUTH_TOKEN` in the publish job.

Configure a trusted publisher for each package:

```bash
npm trust github @skastr0/probe-darwin-arm64 --repo skastr0/probe --file publish.yml --env npm-publish --allow-publish
npm trust github @skastr0/probe-darwin-x64 --repo skastr0/probe --file publish.yml --env npm-publish --allow-publish
npm trust github @skastr0/probe --repo skastr0/probe --file publish.yml --env npm-publish --allow-publish
npm trust list @skastr0/probe-darwin-arm64
npm trust list @skastr0/probe-darwin-x64
npm trust list @skastr0/probe
```

`npm trust` requires npm 11.10.0 or newer, account-level 2FA, package write access, and an already-existing package on the npm registry. The `0.1.0` local bootstrap satisfied the existing-package requirement; future releases should use trusted publishing from CI.

## Publish Flow

For each new public version:

1. Update the root `package.json` version plus `CHANGELOG.md`.
2. Run the local validation commands.
3. Commit the release changes.
4. With explicit maintainer approval, create a `v<version>` tag or manually dispatch `Publish npm packages` from GitHub Actions.
5. Verify `npm trust list`, `npm dist-tag ls`, `npm view`, and a clean registry install smoke test after CI publishes.

The only expected local publish path was the maintainer-approved `0.1.0` bootstrap:

```bash
npm publish ./packages/probe-darwin-arm64 --access public
npm publish ./packages/probe-darwin-x64 --access public
npm publish ./packages/probe --access public
```

## Release Gates

- `release.md` must stay absent from the public release surface. It is temporary coordination scratch space only.
- The workflow refuses to publish `0.0.0`.
- Tag-triggered releases must use `v<package.json version>`.
- Platform packages publish before `@skastr0/probe`, so a fresh install can resolve the optional native package immediately.
- Homebrew is deferred until npm distribution has shipped and the release asset/checksum policy is validated.

## Audit Notes

The root `package.json` is intentionally `private: true`. It is the source/workspace package and must not be published directly. Release audits may flag this as a warning; treat it as accepted only when the package dry-runs target the publishable package directories:

- `./packages/probe-darwin-arm64`
- `./packages/probe-darwin-x64`
- `./packages/probe`
