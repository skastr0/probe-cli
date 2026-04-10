#!/usr/bin/env bun

import { existsSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir, platform, arch } from "os";

const INSTALL_DIR = process.env.INSTALL_DIR || join(homedir(), ".local", "bin");
const BINARY_NAME = "probe";

function detectPlatform(): string {
  const os = platform();
  const cpu = arch();

  let platformStr: string;
  switch (os) {
    case "darwin":
      platformStr = "darwin";
      break;
    case "linux":
      platformStr = "linux";
      break;
    default:
      console.error(`Unsupported operating system: ${os}`);
      process.exit(1);
  }

  let archStr: string;
  switch (cpu) {
    case "x64":
      archStr = "x64";
      break;
    case "arm64":
      archStr = "arm64";
      break;
    default:
      console.error(`Unsupported architecture: ${cpu}`);
      process.exit(1);
  }

  return `${platformStr}-${archStr}`;
}

async function install() {
  const platformArch = detectPlatform();
  console.log(`Detected platform: ${platformArch}`);

  const binaryPath = join("dist", `${BINARY_NAME}-${platformArch}`);

  if (!existsSync(binaryPath)) {
    console.error(`Binary not found: ${binaryPath}`);
    console.error("Run 'bun run build' first to create the binaries.");
    process.exit(1);
  }

  mkdirSync(INSTALL_DIR, { recursive: true });

  const destPath = join(INSTALL_DIR, BINARY_NAME);

  console.log(`Installing to ${destPath}...`);
  await Bun.$`cp ${binaryPath} ${destPath}`;
  await Bun.$`chmod +x ${destPath}`;

  try {
    await Bun.$`codesign --remove-signature ${destPath}`.quiet();
  } catch {
    // fresh binaries may not have a removable signature yet
  }

  try {
    await Bun.$`codesign --sign - --force ${destPath}`.quiet();
    console.log("Binary signed (ad-hoc)");
  } catch (error) {
    console.log("Ad-hoc signing failed; the installed binary may be killed by macOS until it is re-signed manually.");
    throw error;
  }

  // Remove macOS provenance/quarantine attributes that block locally-built binaries
  try {
    await Bun.$`xattr -d com.apple.provenance ${destPath}`.quiet();
    await Bun.$`xattr -d com.apple.quarantine ${destPath}`.quiet();
  } catch {
    // attrs may not be present, that's fine
  }

  console.log(`\nInstalled ${BINARY_NAME} to ${destPath}`);

  // Check if INSTALL_DIR is in PATH
  const pathDirs = (process.env.PATH || "").split(":");
  if (!pathDirs.includes(INSTALL_DIR)) {
    console.log(`
Note: ${INSTALL_DIR} is not in your PATH.
Add it to your shell configuration:

  # bash (~/.bashrc or ~/.bash_profile)
  export PATH="$HOME/.local/bin:$PATH"

  # zsh (~/.zshrc)
  export PATH="$HOME/.local/bin:$PATH"

  # fish (~/.config/fish/config.fish)
  set -gx PATH $HOME/.local/bin $PATH
`);
  }

  console.log(`\nRun '${BINARY_NAME} doctor' to get started.`);
}

install();
