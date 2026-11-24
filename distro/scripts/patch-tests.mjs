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
  for (const c of candidates) {
    if (existsSync(c)) {
      return c;
    }
  }
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

// ★ A patch opts into the repository's own test runner with "runner": "repo"; every other patch keeps
// bare Vitest, because some carried tests have only ever passed there and moving them is a change of
// its own. For opted-in patches the E2E runtime is prepared ONCE per gate run, by the setup upstream's
// E2E Vitest config runs, and reused the way the repository runner reuses its own preparation; left to
// each patch, every one listing an E2E test rebuilt the whole tree inside its own bound and timed out.
const usesRepoRunner = (p) => p.runner === "repo";
const E2E_TEST = /\.e2e\.test\.[cm]?[jt]s$/;
const TEST_FILE = /\.test\.[cm]?[jt]sx?$/;
const E2E_SETUP = "test/vitest/vitest.e2e.global-setup.ts";
const PREPARE_MS = 45 * 60 * 1000;
const runnerEnv = { ...process.env };
let e2eFailure = null;
if (patches.some((p) => usesRepoRunner(p) && (p.tests || []).some((file) => E2E_TEST.test(file)))) {
  if (existsSync(join(checkout, E2E_SETUP))) {
    console.log("   preparing the E2E runtime once for repo-runner patches (" + E2E_SETUP + ")");
    const prep = spawnSync(
      process.execPath,
      [
        "--import",
        "./scripts/tsx.mjs",
        "--input-type=module",
        "-e",
        "const setup = await import(" +
          JSON.stringify("./" + E2E_SETUP) +
          "); await setup.default();",
      ],
      {
        cwd: checkout,
        encoding: "utf8",
        maxBuffer: 1 << 30,
        timeout: PREPARE_MS,
        killSignal: "SIGTERM",
      },
    );
    if (prep.status === 0) {
      runnerEnv.OPENCLAW_E2E_USE_PREBUILT_DIST = "1";
    } else {
      e2eFailure =
        "E2E runtime preparation failed (rc=" + prep.status + ", signal=" + prep.signal + ")";
      console.log(String((prep.stdout || "") + (prep.stderr || "")).slice(-6000));
    }
  } else {
    e2eFailure = "this tree has no E2E setup (" + E2E_SETUP + ")";
  }
}
for (const p of patches) {
  // The step definition names the patches it covers, so a patch never has to know about the
  // build. A patch with no test file of its own is satisfied only when a declared step covers it.
  const coveringStep = (manifest.buildSteps || []).find(
    (step) => Array.isArray(step.covers) && step.covers.includes(p.branch),
  );
  if (!(p.tests || []).length && coveringStep) {
    held += 1;
    console.log(
      String(p.n).padStart(2) +
        " " +
        p.branch.padEnd(46) +
        " GATE  covered by the " +
        coveringStep.name +
        " step",
    );
    continue;
  }
  const files = (p.tests || []).filter((f) => existsSync(checkout + "/" + f));
  if (!files.length || files.length !== (p.tests || []).length) {
    console.log(
      String(p.n).padStart(2) +
        " " +
        p.branch.padEnd(46) +
        " FAIL  one or more declared tests are absent from this tree",
    );
    missing.push(p.branch + " (tests absent)");
    continue;
  }
  // ★ Bounded per patch. An unbounded wait means one hung integration test stalls the whole
  // suite silently, which is indistinguishable from "still working" and wastes the run.
  const PER_PATCH_MS = 10 * 60 * 1000;
  const nodeTests = files.every((file) => file.startsWith("distro/") && file.endsWith(".test.mjs"));
  // An opted-in patch runs through the checkout's own test runner, the command `pnpm test` runs. It
  // routes each file to the config that owns it and prepares the compiled workers some tests need;
  // under bare Vitest those tests fail for want of a runtime they never run without.
  const repo = !nodeTests && usesRepoRunner(p);
  const repoRunner = ["scripts/tsx.mjs", "scripts/test-projects.mts"];
  if (repo && !repoRunner.every((file) => existsSync(join(checkout, file)))) {
    console.log(
      String(p.n).padStart(2) +
        " " +
        p.branch.padEnd(46) +
        " FAIL  this tree has no repository test runner (" +
        repoRunner.join(", ") +
        ")",
    );
    missing.push(p.branch + " (no test runner)");
    continue;
  }
  // A patch may also list non-test inputs (a tsconfig its typecheck covers). They must exist, but
  // only test files go to the runner, which rejects any explicit target that matches no test file.
  const testFiles = repo ? files.filter((file) => TEST_FILE.test(file)) : files;
  if (!testFiles.length) {
    console.log(String(p.n).padStart(2) + " " + p.branch.padEnd(46) + " FAIL  no test file listed");
    missing.push(p.branch + " (no test file)");
    continue;
  }
  if (repo && e2eFailure && files.some((file) => E2E_TEST.test(file))) {
    console.log(String(p.n).padStart(2) + " " + p.branch.padEnd(46) + " FAIL  " + e2eFailure);
    missing.push(p.branch + " (E2E runtime)");
    continue;
  }
  const r = spawnSync(
    nodeTests || repo ? process.execPath : "pnpm",
    nodeTests
      ? ["--test", ...files]
      : repo
        ? ["--import", "./" + repoRunner[0], repoRunner[1], ...testFiles]
        : ["exec", "vitest", "run", ...files],
    {
      cwd: checkout,
      env: repo ? runnerEnv : process.env,
      encoding: "utf8",
      maxBuffer: 1 << 30,
      timeout: PER_PATCH_MS,
      killSignal: "SIGTERM",
    },
  );
  const timedOut = r.signal === "SIGTERM" || /ETIMEDOUT/.test(String(r.error && r.error.code));
  const ok = r.status === 0;
  if (ok) {
    held += 1;
  } else {
    missing.push(p.branch);
  }
  const mark = ok ? " HELD " : timedOut ? " TIME " : " FAIL ";
  console.log(
    String(p.n).padStart(2) + " " + p.branch.padEnd(46) + mark + " " + p.featureOrFix.slice(0, 58),
  );
  // A red patch prints its own test output, so the gate log shows the failing assertion
  // rather than a bare FAIL that has to be reproduced by hand.
  if (!ok) {
    console.log(String((r.stdout || "") + (r.stderr || "")).slice(-6000));
  }
  if (timedOut) {
    console.log(
      "     timed out after " +
        Math.round(PER_PATCH_MS / 60000) +
        " minutes; a bounded failure is a result, an unbounded one is not",
    );
  }
}
console.log("== patch tests held=" + held + " of " + patches.length + " ==");
if (missing.length) {
  console.log("== not satisfied: " + missing.join(", ") + " ==");
  process.exitCode = 1;
}
