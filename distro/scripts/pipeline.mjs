#!/usr/bin/env node
// Núcleo pipeline: the whole build as ordered stages, with a run record that binds every artifact to
// the commit it came from.
//
// Upstream OpenClaw cuts a release the same way in spirit: stages wired as reusable pieces, an exact
// source SHA behind every artifact, a candidate REUSED rather than rebuilt when its inputs have not
// changed, and a record that can be read back afterwards. This is that discipline at the scale of our
// own machines, and it replaces shell chains living in scratch, which cannot be diffed or rolled back.
//
//   node scripts/pipeline.mjs run [--from <stage>] [--only a,b] [--dry-run] [--reuse]
//   node scripts/pipeline.mjs status
//
// Stages in order: assemble, verify, handoff, gate, build, publish.
// A stage that fails stops the run. Nothing downstream of a failure executes.

import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const MANIFEST = JSON.parse(readFileSync(join(ROOT, "nucleo.json"), "utf8"));
const NUCLEO = join(HERE, "nucleo.mjs");
const RUNS = join(ROOT, "logs", "runs");

const argv = process.argv.slice(2);
const CMD = argv.find((a) => !a.startsWith("-")) ?? "status";
const has = (n) => argv.includes(n);
const val = (n) => {
  const i = argv.indexOf(n);
  return i >= 0 ? argv[i + 1] : undefined;
};
const ASSEMBLY = val("--assembly") ?? "";
const dry = has("--dry-run");

function shell(command, cwd) {
  const r = spawnSync("sh", ["-c", command], {
    cwd: cwd ?? MANIFEST.checkout,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  return { status: r.status ?? 1, out: (r.stdout || "") + (r.stderr || "") };
}
function git(args) {
  const r = spawnSync("git", args, { cwd: MANIFEST.checkout, encoding: "utf8" });
  return (r.stdout || "").trim();
}

const STAGES = [
  { name: "assemble", where: "assembly", cmd: "node " + NUCLEO + " sync" },
  { name: "verify", where: "assembly", cmd: "node " + NUCLEO + " verify" },
  {
    name: "handoff",
    where: "assembly",
    cmd: "git -C " + MANIFEST.checkout + " push --force-with-lease origin " + MANIFEST.distroBranch,
  },
  { name: "gate", where: "machine", cmd: "node " + NUCLEO + " gate" },
  { name: "build", where: "machine", cmd: "node " + NUCLEO + " build" },
  { name: "publish", where: "machine", cmd: "node " + NUCLEO + " publish" },
];

function inputs() {
  return {
    pin: MANIFEST.pinnedCommit,
    distro: git(["rev-parse", MANIFEST.distroBranch]),
    patches: MANIFEST.patches
      .map((p) => p.branch + "@" + git(["rev-parse", MANIFEST.fork.remote + "/" + p.branch]))
      .join(" "),
  };
}

function latest() {
  if (!existsSync(RUNS)) return null;
  const out = spawnSync(
    "sh",
    ["-c", "ls -1t " + JSON.stringify(RUNS) + "/*.json 2>/dev/null | head -1"],
    { encoding: "utf8" },
  ).stdout.trim();
  if (!out) return null;
  try {
    return { path: out, record: JSON.parse(readFileSync(out, "utf8")) };
  } catch {
    return null;
  }
}

function status() {
  const now = inputs();
  console.log("pin    " + MANIFEST.pinnedTag + "  " + now.pin.slice(0, 12));
  console.log("distro " + MANIFEST.distroBranch + "  " + now.distro.slice(0, 12));
  const last = latest();
  if (!last) {
    console.log("no run recorded");
    return;
  }
  console.log("last   " + last.record.id + " -> " + last.record.result);
  for (const s of last.record.stages ?? [])
    console.log(
      "       " +
        s.name.padEnd(9) +
        s.status +
        (s.seconds === undefined ? "" : "  " + s.seconds + "s"),
    );
  const same =
    last.record.inputs &&
    last.record.inputs.patches === now.patches &&
    last.record.inputs.pin === now.pin;
  console.log(
    "inputs " +
      (same
        ? "unchanged since that run, so its candidate can be reused"
        : "have changed since that run"),
  );
}

function pipeline() {
  let stages = STAGES;
  const only = (val("--only") ?? "").split(",").filter(Boolean);
  if (only.length) stages = stages.filter((s) => only.includes(s.name));
  const from = val("--from");
  if (from) {
    const i = stages.findIndex((s) => s.name === from);
    if (i > 0) stages = stages.slice(i);
  }

  const now = inputs();
  if (has("--reuse")) {
    const last = latest();
    if (
      last &&
      last.record.result === "green" &&
      last.record.inputs?.patches === now.patches &&
      last.record.inputs?.pin === now.pin
    ) {
      console.log(
        "reusing the candidate recorded in " + last.record.id + ": the inputs are unchanged",
      );
      stages = stages.filter((s) => s.name !== "assemble" && s.name !== "verify");
    }
  }

  mkdirSync(RUNS, { recursive: true });
  const id = new Date().toISOString().replace(/[:.]/g, "-");
  const record = {
    id,
    startedAt: new Date().toISOString(),
    pinTag: MANIFEST.pinnedTag,
    inputs: now,
    stages: [],
    result: "running",
  };
  const recordPath = join(RUNS, id + ".json");
  const logPath = join(ROOT, "logs", "pipeline-" + id + ".log");

  console.log("run " + id + "  pin " + MANIFEST.pinnedTag + "  distro " + now.distro.slice(0, 12));
  for (const stage of stages) {
    process.stdout.write("  " + stage.name.padEnd(9));
    if (dry) {
      console.log("would run: " + stage.cmd);
      record.stages.push({ name: stage.name, status: "dry-run" });
      continue;
    }
    const started = Date.now();
    const command =
      stage.where === "assembly" && ASSEMBLY
        ? ASSEMBLY + " " + JSON.stringify(stage.cmd)
        : stage.cmd;
    const r = shell(command);
    const seconds = Math.round((Date.now() - started) / 1000);
    appendFileSync(
      logPath,
      "\n### " + stage.name + " rc=" + r.status + " " + seconds + "s\n" + r.out.slice(-4000) + "\n",
    );
    const ok = r.status === 0;
    record.stages.push({ name: stage.name, status: ok ? "ok" : "failed", seconds, log: logPath });
    console.log(ok ? "ok " + seconds + "s" : "FAILED " + seconds + "s");
    if (!ok) {
      record.result = "red at " + stage.name;
      record.finishedAt = new Date().toISOString();
      writeFileSync(recordPath, JSON.stringify(record, null, 2) + "\n");
      console.log("stopped at " + stage.name + ", nothing downstream ran. record: " + recordPath);
      process.exitCode = 1;
      return;
    }
  }
  record.result = "green";
  record.finishedAt = new Date().toISOString();
  record.distroAfter = git(["rev-parse", MANIFEST.distroBranch]);
  writeFileSync(recordPath, JSON.stringify(record, null, 2) + "\n");
  console.log("run " + id + " green. record: " + recordPath);
}

if (CMD === "run") pipeline();
else if (CMD === "status") status();
else {
  console.error(
    "usage: pipeline.mjs run [--from s] [--only a,b] [--dry-run] [--reuse] [--assembly <prefix>] | status",
  );
  process.exit(2);
}
