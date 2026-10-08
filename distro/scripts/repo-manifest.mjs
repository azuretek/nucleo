#!/usr/bin/env node
// Generates this repository's copy of the manifest from the working copy that lives with the
// nucleo skill. The working copy carries that host's real checkout and log paths, which must
// never be published, so the paths are replaced here rather than by hand.
//
// ★ This exists because the portable values were hand-maintained once and were overwritten by
// a plain copy of the host manifest, putting those paths into a public repo.
import { readFileSync, writeFileSync } from "node:fs";

const source = process.argv[2];
if (!source) {
  console.error("usage: repo-manifest.mjs <path to the working nucleo.json>");
  process.exit(2);
}
const m = JSON.parse(readFileSync(source, "utf8"));
m.checkout = "/home/USER/src/openclaw";
m.logs = "/var/log/nucleo";
m._pathsNote =
  "The working copy of this manifest lives with the nucleo skill and carries that host's real " +
  "checkout and log paths. These values are shape, not any host's paths.";
writeFileSync("nucleo.json", JSON.stringify(m, null, 2) + "\n");
console.log("wrote nucleo.json (version=" + m.version + " pin=" + m.pinnedTag + ")");
