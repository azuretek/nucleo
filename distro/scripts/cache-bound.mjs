#!/usr/bin/env node
// Bound the caches the build machine keeps between runs, oldest entries first.
//
// Two caches make a repeat run cheaper and only ever grow:
// - NODE_COMPILE_CACHE: V8's compiled code per module, shared by every Node process and worker the
//   tests start. Entries are keyed by source content, so a new pin or patch adds entries.
// - <checkout>/.cache/vitest: Vitest's per-config module cache, keyed the same way.
// Clearing a whole cache when it passed its bound made the next run start cold, and a cold gateway
// start inside a test is what pushed it over its deadline. So each cache is trimmed instead: files
// are removed least recently used first until the cache is back under its bound, and the entries
// the current tree uses, which are the newest, stay warm. Bounds come from caches in nucleo.json.
//
//   node distro/scripts/cache-bound.mjs <checkout>
import { readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const MANIFEST = JSON.parse(readFileSync(join(HERE, "..", "nucleo.json"), "utf8"));
const checkout = process.argv[2] || join(HERE, "..", "..");
const MB = 1048576;

function files(root) {
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) {
        const s = statSync(full);
        out.push({ path: full, size: s.size, used: Math.max(s.atimeMs, s.mtimeMs) });
      }
    }
  };
  try {
    walk(root);
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  return out;
}

function bound(name, dir, maxMb, guard) {
  if (!dir) return console.log("cache-bound: " + name + " not set, nothing to bound");
  // A guard, not a convenience: this deletes files, so it acts only on an absolute path that
  // names itself the cache it is meant to be.
  if (!isAbsolute(dir) || !guard.test(dir) || !Number.isFinite(maxMb) || maxMb <= 0) {
    console.error("cache-bound: refusing " + JSON.stringify(dir) + " for " + name);
    process.exit(2);
  }
  const all = files(dir);
  let total = all.reduce((n, f) => n + f.size, 0);
  const before = Math.round(total / MB);
  if (total <= maxMb * MB)
    return console.log("cache-bound: " + name + " " + before + " MB of " + maxMb + " MB");
  all.sort((a, b) => a.used - b.used);
  let removed = 0;
  for (const f of all) {
    if (total <= maxMb * MB) break;
    rmSync(f.path, { force: true });
    total -= f.size;
    removed += 1;
  }
  console.log(
    "cache-bound: " +
      name +
      " " +
      before +
      " MB over the " +
      maxMb +
      " MB bound, trimmed " +
      removed +
      " least recently used files to " +
      Math.round(total / MB) +
      " MB",
  );
}

const caches = MANIFEST.caches || {};
bound(
  "NODE_COMPILE_CACHE",
  (process.env.NODE_COMPILE_CACHE || "").trim(),
  caches.nodeCompileMb,
  /compile/,
);
bound(
  "vitest module cache",
  join(checkout, ".cache", "vitest"),
  caches.vitestMb,
  /\/\.cache\/vitest$/,
);
