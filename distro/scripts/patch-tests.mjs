#!/usr/bin/env node
// Checks the BEHAVIOUR each patch exists for, against a checkout.
//
// ★ Why feature or fix and not the diff: a patch is carried because a feature or fix is missing. If the
// pinned release already has that feature or fix, the port does not matter, and if upstream supplies
// it later the same check keeps passing. So each patch names the tests that encode its feature or fix,
// and passing those tests is the acceptance criterion, never "our diff applied".
//
// Usage: node scripts/patch-tests.mjs <checkout> [patchNumber]
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// The manifest is found rather than assumed: this script runs both from the skill that owns it
// and from a copy inside a checkout, and a relative path only works from one of those.
function findManifest(checkoutArg) {
  const here = fileURLToPath(new URL(".", import.meta.url));
  const candidates = [
    process.env.NUCLEO_MANIFEST,
    join(here, "..", "nucleo.json"),
    join(here, "nucleo.json"),
    checkoutArg ? join(checkoutArg, "nucleo.json") : null,
    process.cwd() + "/nucleo.json",
  ].filter(Boolean);
  for (const c of candidates) if (existsSync(c)) return c;
  console.error("no nucleo.json found; tried:\n  " + candidates.join("\n  "));
  process.exit(2);
}
const checkoutArg = process.argv[2];
const manifest = JSON.parse(readFileSync(findManifest(checkoutArg), "utf8"));
const checkout = checkoutArg || manifest.checkout;
const only = process.argv[3] ? Number(process.argv[3]) : null;
if (!existsSync(checkout)) {
  console.error("checkout not found: " + checkout);
  process.exit(2);
}

const patches = manifest.patches.filter((p) => (only ? p.n === only : true));
let held = 0;
const missing = [];
const files = new Set();
for (const p of patches) {
  const coveringStep = (manifest.buildSteps || []).find(
    (step) => Array.isArray(step.covers) && step.covers.includes(p.branch),
  );
  if (!(p.tests || []).length && coveringStep) {
    held += 1;
    console.log(p.branch + " GATE covered by " + coveringStep.name);
    continue;
  }
  const absent = (p.tests || []).filter((f) => !existsSync(join(checkout, f)));
  if (!(p.tests || []).length || absent.length) {
    missing.push(p.branch + " (tests absent: " + absent.join(", ") + ")");
    continue;
  }
  for (const file of p.tests) files.add(file);
}
// Share one module graph and stream output rather than buffering a gigabyte.
// A failed combined run stays failed: rerunning subsets must not hide a failure.
if (files.size) {
  const started = Date.now();
  const r = spawnSync("pnpm", ["exec", "vitest", "run", ...files], {
    cwd: checkout,
    env: { ...process.env, OPENCLAW_VITEST_MAX_WORKERS: "2" },
    stdio: "inherit",
    timeout: 10 * 60 * 1000,
    killSignal: "SIGTERM",
  });
  console.log("patch tests: " + files.size + " unique files rc=" + r.status +
    " signal=" + (r.signal || "none") + " in " + Math.round((Date.now() - started) / 1000) + "s");
  if (r.error) console.error(r.error.message);
  if (r.status !== 0) missing.push("combined patch tests");
  else held = patches.length - missing.length;
}
console.log("== patch tests held=" + held + " of " + patches.length + " ==");
if (missing.length) {
  console.log("== not satisfied: " + missing.join(", ") + " ==");
  process.exitCode = 1;
}
