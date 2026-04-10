#!/usr/bin/env bun

import { mkdirSync, readFileSync, rmSync } from "fs";
import { join } from "path";

const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
const version = packageJson.version;
const distDir = "dist";

const targets = [
  { platform: "darwin", arch: "x64" },
  { platform: "darwin", arch: "arm64" },
] as const;

console.log("Cleaning dist directory...");
rmSync(distDir, { recursive: true, force: true });
mkdirSync(distDir, { recursive: true });

console.log(`\nBuilding probe v${version}...\n`);

for (const { platform, arch } of targets) {
  const outfile = join(distDir, `probe-${platform}-${arch}`);

  console.log(`Building ${platform}-${arch}...`);

  try {
    const buildResult = await Bun.build({
      target: "bun",
      compile: {
        target: `bun-${platform}-${arch}`,
        outfile,
      },
      entrypoints: ["src/cli/main.ts"],
      define: {
        APP_VERSION: `'${version}'`,
      },
      minify: true,
    });

    if (!buildResult.success) {
      console.error(`  Failed to build ${platform}-${arch}`);
      for (const log of buildResult.logs) {
        console.error(log);
      }
      continue;
    }

    await Bun.$`chmod +x ${outfile}`;
    const { stdout } = await Bun.$`du -h ${outfile}`.quiet();
    const size = stdout.toString().split("\t")[0];
    console.log(`  ${outfile} (${size})`);
  } catch (error) {
    console.error(`  Error building ${platform}-${arch}:`, error);
  }
}

console.log(`
Build complete!

Binaries available at: ${distDir}/

To install locally:
  bun run install:local

To test:
  ./${distDir}/probe-darwin-arm64 --help
`);
