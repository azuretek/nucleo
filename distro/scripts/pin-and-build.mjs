#!/usr/bin/env node
// Drives the Núcleo chain so the distro branch is always covered by a green build, with no one
// driving the stages by hand: assemble, verify, hand over, then gate and build on the build machine.
//
// The stages belong to pipeline.mjs and this only decides WHEN and on WHICH HOST, so the stage logic,
// the timeouts and the run records keep one owner.
//
// ★ It runs whenever the distro branch is NOT covered by a green run that includes a build, which is
// the plain statement of what a distro needs. A newer upstream release is reported, never applied:
// the design lands the pin change and the patch adaptation together, and that adaptation is a
// judgement rather than a step.
//
// Dry by default; --apply runs it. One run at a time: a lock refuses a second, because two long git
// operations in one worktree race and corrupt the index.
import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const TOOLING = join(HERE, "..");
const REPO = join(TOOLING, "..");
const MANIFEST = JSON.parse(readFileSync(join(TOOLING, "nucleo.json"), "utf8"));
const LOCAL = join(TOOLING, "nucleo.local.json");
if (existsSync(LOCAL)) Object.assign(MANIFEST, JSON.parse(readFileSync(LOCAL, "utf8")));

const APPLY = process.argv.includes("--apply");
// The build machine and its checkout come from the manifest, never from this file: a host path or a
// LAN address committed here is a household identifier in a public repo, and the publish scan
// refuses it, correctly. The host-local override carries this host values.
const MACHINE = process.env.NUCLEO_MACHINE || MANIFEST.machine?.ssh || "";
const MACHINE_CHECKOUT = process.env.NUCLEO_MACHINE_CHECKOUT || MANIFEST.machine?.checkout || "";
// The alert lane is one script with no model in it, and its path comes from the manifest for the same
// reason the machine does: a path with a user name in it is a household identifier in a public repo.
const NOTIFY = process.env.NUCLEO_NOTIFY || MANIFEST.notifyScript || "";
const PIPELINE = join(HERE, "pipeline.mjs");
const LOG_DIR = MANIFEST.logs || join(TOOLING, "logs");
const RUNS = join(LOG_DIR, "runs");
const LOCK = join(LOG_DIR, "pin-and-build.lock");
const LOCK_STALE_MS = 6 * 60 * 60 * 1000;

// One timestamped line per stage start and end and per chain result, the stream chain-status.mjs follows.
const event = (line) => {
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    appendFileSync(join(LOG_DIR, "events.log"), new Date().toISOString() + " " + line + "\n");
  } catch {}
};
const run = (cmd, args, opts = {}) =>
  spawnSync(cmd, args, { encoding: "utf8", timeout: 60000, ...opts });
const git = (args, opts = {}) => run("git", args, { cwd: REPO, ...opts });
const say = (line) => console.log(line);
const stamp = () => new Date().toISOString();

// The pid holding the lock while that process is alive, or null. A dead holder never counts.
function liveLockHolder() {
  if (!existsSync(LOCK)) return null;
  const pid = Number(readFileSync(LOCK, "utf8").trim().split(" ")[0]);
  try {
    process.kill(pid, 0);
    return pid;
  } catch (err) {
    return err.code === "EPERM" ? pid : null;
  }
}

function takeLock() {
  mkdirSync(LOG_DIR, { recursive: true });
  // ★ A lock is stale the moment its holder is dead, not only after the stale window: a driver
  // killed while it waits on a stage cannot release it, because no handler runs during spawnSync,
  // and a six hour wait behind a dead pid is how the twice-daily run lost a whole evening.
  if (existsSync(LOCK)) {
    const [pid, ms] = readFileSync(LOCK, "utf8").trim().split(" ");
    let alive = false;
    try {
      process.kill(Number(pid), 0);
      alive = true;
    } catch (err) {
      alive = err.code === "EPERM";
    }
    const age = Date.now() - Number(ms || 0);
    if (alive && Number.isFinite(age) && age < LOCK_STALE_MS) return false;
    say(
      "clearing a stale lock held by " +
        (alive ? "a run past the stale window" : "dead pid " + pid),
    );
  }
  writeFileSync(LOCK, String(process.pid) + " " + Date.now());
  return true;
}
const releaseLock = () => {
  try {
    unlinkSync(LOCK);
  } catch {}
};

const FETCH_MAIN = [
  "fetch",
  "--quiet",
  MANIFEST.fork.remote,
  "+refs/heads/" +
    MANIFEST.distroBranch +
    ":refs/remotes/" +
    MANIFEST.fork.remote +
    "/" +
    MANIFEST.distroBranch,
];

// Covered means: a run record exists for exactly this distro commit, every stage in it passed, and a
// build was among them. Anything less and the chain has something left to do.
function coveredByGreenBuild(sha) {
  if (!existsSync(RUNS)) return false;
  for (const f of readdirSync(RUNS).filter((n) => n.endsWith(".json"))) {
    let rec;
    try {
      rec = JSON.parse(readFileSync(join(RUNS, f), "utf8"));
    } catch {
      continue;
    }
    if (!rec || rec.inputs?.distro !== sha) continue;
    const stages = Array.isArray(rec.stages) ? rec.stages : [];
    if (!stages.some((s) => s.name === "build" && s.status === "ok")) continue;
    if (stages.every((s) => s.status === "ok")) return rec.id;
  }
  return false;
}

function newestUpstreamPin() {
  const r = git(["ls-remote", "--tags", MANIFEST.upstream.remote], { timeout: 120000 });
  if (r.status !== 0) return undefined;
  const tags = [
    ...new Set(
      (r.stdout || "")
        .split("\n")
        .map((l) => (l.split("refs/tags/")[1] || "").replace(/\^\{\}$/, ""))
        .filter((t) => /^v\d{4}\.\d+\.\d+$/.test(t)),
    ),
  ];
  tags.sort((a, b) => {
    const pa = a.slice(1).split(".").map(Number);
    const pb = b.slice(1).split(".").map(Number);
    return pa[0] - pb[0] || pa[1] - pb[1] || pa[2] - pb[2];
  });
  return tags[tags.length - 1];
}

const STEPS = [
  ["assembly", ["run", "--only", "assemble,verify"], 5400000],
  ["handoff", ["run", "--only", "handoff"], 900000],
  // A full test run on the build machine outlasted four hours, and the stage was killed mid-test.
  ["machine", ["run", "--only", "gate,build"], 8 * 60 * 60 * 1000],
];

function alert(subject, body) {
  if (!NOTIFY || !existsSync(NOTIFY)) {
    say("no alert lane configured, so this failure is only in the log");
    return;
  }
  const r = run(process.execPath, [NOTIFY, "--subject", subject, "--body", body, "--tag", "cron"], {
    timeout: 90000,
  });
  say(r.status === 0 ? "alert sent" : "alert failed: " + (r.stderr || "").trim().slice(0, 200));
}
// ★ Upstream workflow files stay in the tree, because its tests and its build read them, and GitHub
// would run every one of them. So around each handoff the driver switches Actions off, pushes, and
// disables by id every workflow that is not ours before switching Actions back on. A workflow that
// first appears in a new pin therefore never gets a run, and nothing upstream ships has to change.
const REPO_SLUG = MANIFEST.fork.repo;
// The commit the handoff pushed, which is what the machine gates and builds. The green record names this,
// never the branch tip at the end of the run, because a merge during the run would move the tip.
let HANDED_OFF = "";
const OUR_WORKFLOW = ".github/workflows/distro.yml";
const gh = (args, timeout = 120000) => run("gh", args, { timeout });
function setActions(enabled) {
  const args = [
    "api",
    "-X",
    "PUT",
    "repos/" + REPO_SLUG + "/actions/permissions",
    "-F",
    "enabled=" + enabled,
  ];
  if (enabled) args.push("-f", "allowed_actions=all");
  const r = gh(args);
  if (r.status !== 0)
    throw new Error("could not set Actions enabled=" + enabled + ": " + (r.stderr || "").trim());
}
function activeStrays() {
  const r = gh([
    "api",
    "--paginate",
    "repos/" + REPO_SLUG + "/actions/workflows?per_page=100",
    "--jq",
    '.workflows[] | select(.state=="active") | "\\(.id) \\(.path)"',
  ]);
  if (r.status !== 0) throw new Error("could not list workflows: " + (r.stderr || "").trim());
  return (r.stdout || "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => ({ id: l.slice(0, l.indexOf(" ")), path: l.slice(l.indexOf(" ") + 1) }))
    .filter((w) => w.path !== OUR_WORKFLOW);
}
function knownWorkflowCount() {
  const r = gh([
    "api",
    "repos/" + REPO_SLUG + "/actions/workflows?per_page=1",
    "--jq",
    ".total_count",
  ]);
  return Number((r.stdout || "0").trim()) || 0;
}
// Waits for GitHub to register the pushed workflow files (the count is the state it waits on, the
// deadline only the failsafe), then disables every active one that is not ours.
function disableStrays(expected, waitMs) {
  const deadline = Date.now() + waitMs;
  while (knownWorkflowCount() < expected && Date.now() < deadline)
    run("sleep", ["10"], { timeout: 20000 });
  let disabled = 0;
  for (const w of activeStrays()) {
    const r = gh([
      "api",
      "-X",
      "PUT",
      "repos/" + REPO_SLUG + "/actions/workflows/" + w.id + "/disable",
    ]);
    if (r.status === 0) disabled += 1;
    else say("could not disable " + w.path + ": " + (r.stderr || "").trim());
  }
  return disabled;
}
function handoffQuietly(args, timeoutMs) {
  const expected = (
    git(["ls-tree", "--name-only", MANIFEST.distroBranch, ".github/workflows/"]).stdout || ""
  )
    .split("\n")
    .filter((p) => /\.ya?ml$/.test(p)).length;
  // The way back: the remote tip this handoff replaces is archived and read back before anything
  // is pushed over it, so every handoff can be undone.
  git(FETCH_MAIN);
  const prior = (
    git(["rev-parse", "refs/remotes/" + MANIFEST.fork.remote + "/" + MANIFEST.distroBranch])
      .stdout || ""
  ).trim();
  if (prior) {
    const archive = "archive/" + MANIFEST.distroBranch + "-" + prior.slice(0, 12);
    git(["push", "-q", MANIFEST.fork.remote, prior + ":refs/heads/" + archive], {
      timeout: 120000,
    });
    const back = (
      git(["ls-remote", MANIFEST.fork.remote, "refs/heads/" + archive], { timeout: 60000 })
        .stdout || ""
    )
      .split("\t")[0]
      .trim();
    if (back !== prior) {
      return { status: 1, stdout: "", stderr: "could not confirm the archive branch " + archive };
    }
    say("  way back: " + archive);
  }
  setActions(false);
  let r;
  try {
    r = run("node", [PIPELINE, ...args], { cwd: REPO, timeout: timeoutMs });
    if (r.status === 0) say("  disabled while Actions was off: " + disableStrays(expected, 90000));
  } finally {
    setActions(true);
  }
  if (r.status !== 0) return r;
  HANDED_OFF = (git(["rev-parse", MANIFEST.distroBranch]).stdout || "").trim();
  say("  disabled after Actions came back: " + disableStrays(expected, 180000));
  const left = activeStrays();
  if (left.length) {
    return {
      status: 1,
      stdout:
        "workflows this fork did not choose are still active: " +
        left.map((w) => w.path).join(", "),
      stderr: "",
    };
  }
  return r;
}

function runStep(where, args, timeoutMs) {
  say("  stage " + where + ": " + args.join(" "));
  if (where === "handoff") {
    try {
      return handoffQuietly(args, timeoutMs);
    } catch (e) {
      return { status: 1, stdout: "", stderr: String(e) };
    }
  }
  if (where === "machine") {
    const remote =
      // umask 022: the node host refuses a temp workspace under a group-writable ancestor, and a
      // host umask of 002 made every directory the gate created trip that check.
      "umask 022 && cd " +
      MACHINE_CHECKOUT +
      " && git fetch -q --force origin '+refs/heads/main:refs/remotes/origin/main' && git checkout -q -f -B main origin/main && OPENCLAW_OXLINT_SHARD_TIMEOUT_MS=2700000 OPENCLAW_BOUNDARY_DTS_TIMEOUT_MS=1800000 OPENCLAW_PLUGIN_SDK_BOUNDARY_ROOT_SHIMS_TIMEOUT_MS=1800000 node distro/scripts/pipeline.mjs " +
      args.join(" ");
    // -tt ties the remote gate to this connection, so a driver that is killed ends it too instead
    // of leaving an orphan gate running for hours on the build machine.
    return run("ssh", ["-tt", "-o", "BatchMode=yes", MACHINE, remote], {
      timeout: timeoutMs,
      maxBuffer: 64 * 1024 * 1024,
    });
  }
  return run("node", [PIPELINE, ...args], { cwd: REPO, timeout: timeoutMs });
}

function main() {
  if (!MACHINE || !MACHINE_CHECKOUT || /USER|HOST/.test(MACHINE + MACHINE_CHECKOUT)) {
    say(
      "the build machine is not set for this host: put machine.ssh and machine.checkout in nucleo.local.json",
    );
    process.exitCode = 1;
    return;
  }
  if (!takeLock()) {
    say("another run holds the lock; doing nothing");
    return;
  }
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    git(FETCH_MAIN);
    const head = (
      git(["rev-parse", "refs/remotes/" + MANIFEST.fork.remote + "/" + MANIFEST.distroBranch])
        .stdout || ""
    ).trim();
    if (!head) {
      say("cannot read the distro branch");
      process.exitCode = 1;
      return;
    }
    const covered = coveredByGreenBuild(head);
    const newer = newestUpstreamPin();
    say(
      "distro " +
        head.slice(0, 12) +
        " pin " +
        MANIFEST.pinnedTag +
        (newer && newer !== MANIFEST.pinnedTag ? " (newer upstream release: " + newer + ")" : ""),
    );
    if (covered) {
      say("covered by a green build: run " + covered + "; nothing to do");
      event("chain COVERED " + head);
      if (newer && newer !== MANIFEST.pinnedTag)
        say(
          "a pin bump to " +
            newer +
            " is still due: it lands with its patch adaptation, so it is reported rather than applied",
        );
      appendFileSync(
        join(LOG_DIR, "pin-and-build.log"),
        stamp() + " current " + head + " run " + covered + "\n",
      );
      return;
    }
    say("not covered by a green build: running the chain");
    if (!APPLY) {
      for (const [where, args] of STEPS) say("  would run " + where + ": " + args.join(" "));
      say("dry run: pass --apply to run it");
      return;
    }
    appendFileSync(join(LOG_DIR, "pin-and-build.log"), stamp() + " chain for " + head + "\n");
    event("chain start " + head);
    for (const [where, args, timeoutMs] of STEPS) {
      event("stage " + where + " start");
      const r = runStep(where, args, timeoutMs);
      event("stage " + where + " rc=" + r.status);
      if (r.status !== 0) {
        say("RED at " + where + ": " + args.join(" "));
        const tail = ((r.stdout || "") + (r.stderr || "") + (r.error ? String(r.error) : ""))
          .trim()
          .split("\n")
          .slice(-14)
          .join("\n");
        say(tail);
        alert("nucleo chain red at " + where, tail);
        event("chain RED at " + where);
        appendFileSync(join(LOG_DIR, "pin-and-build.log"), stamp() + " RED " + where + "\n");
        process.exitCode = 1;
        return;
      }
    }
    say("chain green");
    // The machine records live on the build machine, so the green result is recorded here as well,
    // against the commit the handoff pushed, which is what the coverage check reads.
    const built = HANDED_OFF || head;
    mkdirSync(RUNS, { recursive: true });
    const id = stamp().replace(/[:.]/g, "-") + "-chain";
    writeFileSync(
      join(RUNS, id + ".json"),
      JSON.stringify(
        {
          id,
          pinTag: MANIFEST.pinnedTag,
          inputs: { distro: built },
          stages: [
            { name: "assembly", status: "ok" },
            { name: "handoff", status: "ok" },
            { name: "build", status: "ok" },
          ],
          result: "green",
        },
        null,
        2,
      ) + "\n",
    );
    event("chain GREEN " + built);
    appendFileSync(join(LOG_DIR, "pin-and-build.log"), stamp() + " green " + head + "\n");
  } finally {
    releaseLock();
  }
}

// ★ --idle exits 0 only when no live run holds the lock. Check it BEFORE fetching and checking
// out, because the checkout is the one the running chain assembles in, and a forced checkout
// under a running assembly is the two-git-operations race that corrupts the index.
if (process.argv.includes("--idle")) {
  const holder = liveLockHolder();
  if (holder) say("a run is in progress (pid " + holder + "); leaving the checkout alone");
  process.exit(holder ? 1 : 0);
}
main();
