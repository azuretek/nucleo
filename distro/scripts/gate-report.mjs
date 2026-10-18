// Lifts the reason a gate step failed out of its log file, so it reaches the CI job log, the run's
// annotations and its summary instead of staying in a log file on the runner.
//
// ★ Why: on 2026-10-18 a gate run said only "check FAILED". The cause, a type error in a carried
// patch, sat in the step log, which reached GitHub only as a downloaded artifact. The warning that
// came first in that log got read as the cause, and a second build went out with the real error
// still in it.

const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;
const WORKFLOW_COMMAND = /^::(error|warning|notice)(?: [^:]*)?::/;
// Lines that name a reason. Each pattern is one shape upstream's checks print.
const REASON = [
  /\berror TS\d+:/, // TypeScript
  /^\s*[\d.]+m?s\s+failed(?::\d+)?\s/, // check.mts summary row
  /\[[\w:-]+\] FAILED\b/, // a runner's own failure line, such as [tsgo] FAILED
  /^\s*(?:FAIL|×|✗|✖)\s/, // a failing test file or case
  /\b(?:AssertionError|TypeError|ReferenceError|SyntaxError)\b/,
  /^\s*(?:Error|error):\s/,
  /\bexceeds\b.*\bbudget\b/,
];
// Repeats that carry no reason of their own.
const NOISE = [/\[ELIFECYCLE\] Command failed/];

const clean = (text) =>
  String(text || "")
    .replace(ANSI, "")
    .split(/\r?\n/);

/** The reason lines in a step log, in order, without repeats, capped. */
export function failureLines(text, max = 30) {
  const out = [];
  const seen = new Set();
  for (const raw of clean(text)) {
    // A warning is never the reason a step failed; it is re-emitted as a warning instead.
    if (/^::(?:warning|notice)\b/.test(raw.trim())) continue;
    const line = raw.replace(WORKFLOW_COMMAND, "").trimEnd();
    if (!line.trim() || NOISE.some((p) => p.test(line))) continue;
    if (!REASON.some((p) => p.test(line))) continue;
    if (seen.has(line)) continue;
    seen.add(line);
    out.push(line);
    if (out.length >= max) break;
  }
  return out;
}

/** Workflow commands a step printed into its own log, which GitHub never saw. */
export function workflowCommands(text, max = 20) {
  const out = [];
  for (const raw of clean(text)) {
    const line = raw.trim();
    if (WORKFLOW_COMMAND.test(line) && !out.includes(line)) out.push(line);
    if (out.length >= max) break;
  }
  return out;
}

/** The last lines of a log, for context beside the reasons. */
export function tailLines(text, n = 60) {
  const lines = clean(text);
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  return lines.slice(-n);
}

/** Escapes a message for a GitHub workflow command. */
export function escapeCommand(value) {
  return String(value).replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}

/** The lines the gate prints to its own output when a step fails. */
export function failureReport({ step, rc, logFile, text, ci }) {
  const reasons = failureLines(text);
  const lines = [];
  lines.push("  why " + step + " failed (rc=" + rc + "), from " + logFile + ":");
  if (reasons.length) for (const r of reasons) lines.push("    " + r);
  else lines.push("    no reason line found; the end of the log follows");
  if (ci) {
    for (const cmd of workflowCommands(text)) lines.push(cmd);
    for (const r of reasons.slice(0, 10))
      lines.push(
        "::error title=" +
          escapeCommand("gate step " + step + " failed") +
          "::" +
          escapeCommand(r.trim()),
      );
    if (!reasons.length)
      lines.push(
        "::error title=" +
          escapeCommand("gate step " + step + " failed") +
          "::" +
          escapeCommand("rc=" + rc + ", see the end of the step log in this job"),
      );
    lines.push("::group::end of the " + step + " log");
  } else {
    lines.push("  end of the " + step + " log:");
  }
  for (const t of tailLines(text)) lines.push(ci ? t : "    " + t);
  if (ci) lines.push("::endgroup::");
  return lines;
}

/** The markdown the gate adds to the run summary when a step fails. */
export function failureSummary({ step, rc, text }) {
  const reasons = failureLines(text);
  const fence = "```";
  return [
    "### Gate step `" + step + "` failed (rc=" + rc + ")",
    "",
    ...(reasons.length
      ? [fence, ...reasons, fence]
      : ["No reason line found; the end of the step log is in the job log."]),
    "",
  ].join("\n");
}
