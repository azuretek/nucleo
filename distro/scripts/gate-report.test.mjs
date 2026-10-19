import assert from "node:assert/strict";
import { test } from "node:test";
import {
  escapeCommand,
  failureLines,
  failureReport,
  failureSummary,
  workflowCommands,
} from "./gate-report.mjs";

// The check log of run 39153422508 (2026-10-18), shortened, with the colour codes it carried.
const CHECK_LOG =
  "::warning file=config/env-var-count-budget.txt,line=1,col=0,title=Environment variable count budget::OPENCLAW_* count 477 exceeds budget 476; update config/env-var-count-budget.txt\n  3.45s  ok         media download helper guard\nsrc/infra/update-github-releases.ts(43,5): error TS2322: Type 'string | undefined' is not assignable to type 'string | null'.\n[tsgo] FAILED (exit 2)\n[ELIFECYCLE] Command failed with exit code 2.\n[ELIFECYCLE] Command failed with exit code 2.\n  7.50s  ok         package patch guard\n\u001b[31m  71.09s  failed:2   typecheck prod\u001b[0m\n[ELIFECYCLE] Command failed with exit code 2.";

test("the type error and the failed summary row are the reasons, not the budget warning alone", () => {
  const reasons = failureLines(CHECK_LOG);
  assert.ok(
    reasons.some((l) => l.includes("error TS2322")),
    "the type error is a reason",
  );
  assert.ok(
    reasons.some((l) => /failed:2\s+typecheck prod/.test(l)),
    "the summary row is a reason",
  );
  assert.ok(reasons.some((l) => l.includes("[tsgo] FAILED")));
  assert.ok(!reasons.some((l) => l.includes("ELIFECYCLE")), "repeated lifecycle lines are noise");
  assert.ok(!reasons.some((l) => /\sok\s/.test(l)), "passing rows are not reasons");
  assert.ok(!reasons.some((l) => l.includes("\u001b")), "colour codes are stripped");
  assert.ok(!reasons.some((l) => l.includes("exceeds budget")), "a warning is not a reason");
});

test("a warning printed into the step log is re-emitted for GitHub", () => {
  const cmds = workflowCommands(CHECK_LOG);
  assert.equal(cmds.length, 1);
  assert.match(cmds[0], /^::warning file=config\/env-var-count-budget\.txt.*exceeds budget 476/);
});

test("the same budget line printed as a plain failure is a reason", () => {
  const reasons = failureLines(
    "OPENCLAW_* count 477 exceeds budget 476; update config/env-var-count-budget.txt\n",
  );
  assert.equal(reasons.length, 1);
});

test("on CI the report annotates each reason and folds the log end", () => {
  const out = failureReport({
    step: "check",
    rc: 1,
    logFile: "gate-check.log",
    text: CHECK_LOG,
    ci: true,
  });
  const errors = out.filter((l) => l.startsWith("::error "));
  assert.ok(errors.some((l) => l.includes("error TS2322")));
  assert.ok(errors.every((l) => l.startsWith("::error title=gate step check failed::")));
  assert.ok(out.includes("::group::end of the check log") && out.at(-1) === "::endgroup::");
  assert.ok(out.some((l) => l.startsWith("::warning ")));
});

test("off CI there are no workflow commands", () => {
  const out = failureReport({ step: "check", rc: 1, logFile: "x.log", text: CHECK_LOG, ci: false });
  assert.ok(!out.some((l) => l.startsWith("::")));
  assert.ok(out.some((l) => l.includes("error TS2322")));
});

test("a log with no recognisable reason still says so and still fails loudly", () => {
  const out = failureReport({
    step: "tests",
    rc: 137,
    logFile: "x.log",
    text: "killed\n",
    ci: true,
  });
  assert.ok(out.some((l) => l.includes("no reason line found")));
  assert.ok(out.some((l) => l.startsWith("::error ") && l.includes("rc=137")));
});

test("the summary names the step and lists the reasons", () => {
  const md = failureSummary({ step: "check", rc: 1, text: CHECK_LOG });
  assert.match(md, /### Gate step `check` failed \(rc=1\)/);
  assert.match(md, /error TS2322/);
});

test("workflow command values are escaped", () => {
  assert.equal(escapeCommand("50%\nnext"), "50%25%0Anext");
});
