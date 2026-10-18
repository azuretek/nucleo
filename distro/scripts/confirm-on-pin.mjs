#!/usr/bin/env node
// Confirms whether upstream's own fix satisfies OUR expectations: for each patch it puts OUR
// version of that behaviour's tests onto the PINNED code and runs them.
//
// ★ Why this and not the reverse: the behaviour suite used the tests already in the tree, which
// were written for upstream's implementation. A test we wrote, run against their code, is the only
// thing that shows their fix solves the problem WE were addressing rather than an adjacent one.
//
// PASS  their code satisfies our test        -> our patch is redundant
// FAIL  their code does not satisfy our test -> the patch still has work to do
// SKIP  our test cannot run there (it needs code only our patch adds) -> inconclusive
//
// Usage: node scripts/confirm-on-pin.mjs <checkout> [patchNumber]
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

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
  console.error("no nucleo.json found");
  process.exit(2);
}
const checkout = process.argv[2];
const only = process.argv[3] ? Number(process.argv[3]) : null;
const manifest = JSON.parse(readFileSync(findManifest(checkout), "utf8"));
const BR = manifest.fork.remote;
function git(args) {
  const r = spawnSync("git", args, { cwd: checkout, encoding: "utf8", maxBuffer: 1 << 30 });
  return r;
}

const patches = manifest.patches.filter((p) => (only ? p.n === only : true));
let pass = 0,
  fail = 0,
  skip = 0;
const verdicts = [];
for (const p of patches) {
  const files = p.behaviourTests || [];
  let placed = [];
  for (const f of files) {
    const co = git(["checkout", BR + "/" + p.branch, "--", f]);
    if (co.status === 0) placed.push(f);
  }
  if (!placed.length) {
    console.log(
      String(p.n).padStart(2) +
        " " +
        p.branch.padEnd(46) +
        " SKIP  our tests do not exist on the pin",
    );
    skip += 1;
    verdicts.push(p.branch + " SKIP");
    continue;
  }
  const r = spawnSync("pnpm", ["exec", "vitest", "run", ...placed], {
    cwd: checkout,
    encoding: "utf8",
    maxBuffer: 1 << 30,
    timeout: 600000,
  });
  const ok = r.status === 0;
  // ★ A failure has to be CLASSIFIED. "Our test asserts something their code does not do" is a
  // result; "our test could not load because it needs code our patch adds" is not, and the two
  // look identical in an exit code.
  const out = String(r.stdout || "") + String(r.stderr || "");
  let kind = "unknown";
  if (ok) kind = "satisfied";
  else if (
    /Cannot find module|Failed to load|Failed to resolve import|is not exported by/.test(out)
  )
    kind = "cannot-run";
  else if (/AssertionError|expected .* to |toHaveLength|toBe\(/.test(out)) kind = "difference";
  else if (/Test timed out|timed out/.test(out)) kind = "timeout";
  const first =
    (out.match(/(AssertionError|TypeError|ReferenceError|Error):[^\n]*/) || [])[0] || "";
  if (ok) pass += 1;
  else fail += 1;
  verdicts.push(p.branch + (ok ? " PASS" : " FAIL/" + kind));
  console.log(
    String(p.n).padStart(2) +
      " " +
      p.branch.padEnd(46) +
      (ok ? " PASS " : " FAIL ") +
      kind.padEnd(10) +
      " (" +
      placed.length +
      " files) " +
      first.slice(0, 62),
  );
  if (kind === "cannot-run") skip += 1;
  git(["checkout", "--", "."]);
  for (const f of placed) if (!existsSync(join(checkout, f))) git(["rm", "-q", "--cached", f]);
}
console.log(
  "== their fix satisfies our tests: pass=" +
    pass +
    " fail=" +
    fail +
    " inconclusive=" +
    skip +
    " ==",
);
