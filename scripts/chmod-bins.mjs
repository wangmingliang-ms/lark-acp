#!/usr/bin/env node
// Make the built bin entrypoints executable (chmod +x) after `tsc`.
//
// Replaces a bare `chmod +x …` in the build script, which fails on Windows
// where `chmod` is not on PATH (cmd.exe cannot find it) and aborts the whole
// build. Setting the mode via Node keeps this cross-platform: on POSIX it adds
// the execute bits so `./dist/bin/humming.js` and the npm-linked bin run
// directly; on Windows `fs.chmodSync` is effectively a no-op (the filesystem
// has no POSIX execute bit and npm generates its own .cmd shims), so it does no
// harm.

import { chmodSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const BIN_RELATIVE_PATHS = [
  "dist/bin/humming.js",
  "dist/bin/lifecycle-coordinator.js",
  "dist/bin/mock-agent.js",
];
const EXECUTABLE_MODE = 0o755;

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

for (const relativePath of BIN_RELATIVE_PATHS) {
  const absolutePath = join(repoRoot, relativePath);
  if (!existsSync(absolutePath)) {
    throw new Error(`chmod-bins: expected build output not found: ${relativePath}`);
  }
  chmodSync(absolutePath, EXECUTABLE_MODE);
}
