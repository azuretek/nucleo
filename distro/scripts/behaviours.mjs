#!/usr/bin/env node
// Checks the BEHAVIOUR each patch exists for, against a checkout.
//
// ★ Why behaviour and not the diff: a patch is carried because a behaviour is missing. If the
// pinned release already has that behaviour, the port does not matter, and if upstream supplies
// it later the same check keeps passing. So each patch names the tests that encode its behaviour,
// and passing those tests is the acceptance criterion, never "our diff applied".
//
// Usage: node scripts/behaviours.mjs <checkout> [patchNumber]
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
for (const p of patches) {
  const files = (p.behaviourTests || []).filter((f) => existsSync(checkout + "/" + f));
  if (!files.length) {
    console.log(
      String(p.n).padStart(2) +
        " " +
        p.branch.padEnd(46) +
        " SKIP  none of its tests exist in this tree",
    );
    missing.push(p.branch + " (tests absent)");
    continue;
  }
  // ★ Bounded per patch. An unbounded wait means one hung integration test stalls the whole
  // suite silently, which is indistinguishable from "still working" and wastes the run.
  const PER_PATCH_MS = 10 * 60 * 1000;
  const r = spawnSync("pnpm", ["exec", "vitest", "run", ...files], {
    cwd: checkout,
    encoding: "utf8",
    maxBuffer: 1 << 30,
    timeout: PER_PATCH_MS,
    killSignal: "SIGTERM",
  });
  const timedOut = r.signal === "SIGTERM" || /ETIMEDOUT/.test(String(r.error && r.error.code));
  const ok = r.status === 0;
  if (ok) held += 1;
  else missing.push(p.branch);
  const mark = ok ? " HELD " : timedOut ? " TIME " : " FAIL ";
  console.log(
    String(p.n).padStart(2) + " " + p.branch.padEnd(46) + mark + " " + p.behaviour.slice(0, 58),
  );
  if (timedOut)
    console.log(
      "     timed out after " +
        Math.round(PER_PATCH_MS / 60000) +
        " minutes; a bounded failure is a result, an unbounded one is not",
    );
}
console.log("== behaviours held=" + held + " of " + patches.length + " ==");
if (missing.length) {
  console.log("== not satisfied: " + missing.join(", ") + " ==");
  process.exitCode = 1;
}
