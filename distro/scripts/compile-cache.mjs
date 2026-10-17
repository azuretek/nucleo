#!/usr/bin/env node
// Bound the Node compile cache the build machine's tests share.
//
// NODE_COMPILE_CACHE makes every Node process and worker thread reuse V8's compiled code for a
// module it has already compiled, instead of parsing and compiling it again. The test suite starts
// hundreds of worker threads per config, each loading the same bundled chunks, and with the cache
// measured 12 to 13 percent faster on a worker-heavy file. Entries are keyed by source content, so a
// new pin or patch adds entries and never replaces old ones: left alone the directory only grows.
// This runs before the tests and clears the directory once it passes the bound; the next run
// rebuilds it on its first pass. Unset NODE_COMPILE_CACHE means nothing to do.
//
//   node distro/scripts/compile-cache.mjs [--max-mb <n>]

import { readdirSync, rmSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";

const argv = process.argv.slice(2);
const i = argv.indexOf("--max-mb");
const MAX_MB = i >= 0 ? Number(argv[i + 1]) : 2048;
const dir = (process.env.NODE_COMPILE_CACHE ?? "").trim();

function sizeOf(path) {
  let total = 0;
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const full = join(path, entry.name);
    total += entry.isDirectory() ? sizeOf(full) : entry.isFile() ? statSync(full).size : 0;
  }
  return total;
}

if (!dir) {
  console.log("compile-cache: NODE_COMPILE_CACHE unset, nothing to bound");
} else if (!isAbsolute(dir) || !/compile/.test(dir) || !Number.isFinite(MAX_MB) || MAX_MB <= 0) {
  // A guard, not a convenience: this deletes a directory, so it acts only on an absolute path that
  // names itself a compile cache.
  console.error("compile-cache: refusing " + JSON.stringify(dir) + " with --max-mb " + MAX_MB);
  process.exit(2);
} else {
  let bytes = 0;
  try {
    bytes = sizeOf(dir);
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  const mb = Math.round(bytes / 1048576);
  if (mb > MAX_MB) {
    rmSync(dir, { recursive: true, force: true });
    console.log("compile-cache: " + mb + " MB over the " + MAX_MB + " MB bound, cleared");
  } else {
    console.log("compile-cache: " + mb + " MB of " + MAX_MB + " MB");
  }
}
