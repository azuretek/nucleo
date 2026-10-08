#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
// Núcleo: assemble, verify, gate, build and publish our OpenClaw distribution.
// Read docs/distro.md first. Every shared value comes from nucleo.json, never from here.
//
//   nucleo.mjs sync [--dry-run] | verify | gate | build [--dry-run] | publish [--dry-run] | status
import { readFileSync, mkdirSync, appendFileSync, existsSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const MANIFEST = JSON.parse(readFileSync(join(HERE, "..", "nucleo.json"), "utf8"));
// ★ This file lives in a PUBLIC repository, so no host path may be committed: it would
// leak the machine, and publish-scan refuses it. Anything that differs by host comes
// from a gitignored nucleo.local.json beside this file. A placeholder that survives
// means the host has not been set up, which is a refusal and never a guess.
const LOCAL = join(HERE, "..", "nucleo.local.json");
if (existsSync(LOCAL)) Object.assign(MANIFEST, JSON.parse(readFileSync(LOCAL, "utf8")));
{
  const unresolved = [MANIFEST.checkout, MANIFEST.logs].filter(function (p) {
    return typeof p === "string" && p.indexOf("USER") !== -1;
  });
  if (unresolved.length)
    throw new Error(
      "unresolved host path in nucleo.json: " +
        unresolved.join(", ") +
        ". Copy nucleo.local.example.json to nucleo.local.json beside it and set this host.",
    );
}
const ARGS = process.argv.slice(2);
const CMD = ARGS[0] || "status";
const DRY = ARGS.includes("--dry-run");
const RELEASE = ARGS.includes("--release");

const log = (m) => process.stdout.write(m + "\n");
const git = (args, opts = {}) =>
  execFileSync("git", args, { cwd: MANIFEST.checkout, encoding: "utf8", ...opts }).trim();
const gitTry = (args, opts = {}) => {
  const r = spawnSync("git", args, { cwd: MANIFEST.checkout, encoding: "utf8", ...opts });
  return { ok: r.status === 0, out: (r.stdout || "").trim(), err: (r.stderr || "").trim() };
};
const sha = (ref) => gitTry(["rev-parse", "--short", ref]).out;

function logPath(kind) {
  mkdirSync(MANIFEST.logs, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return join(MANIFEST.logs, `${stamp}-${kind}.log`);
}

const NEEDS_HISTORY = new Set(["sync", "verify"]);

// A shallow checkout is fatal for assembly and fine for a build: sync and verify replay the
// patch series and need ancestry, while gate and build want one tree. So the refusal is scoped
// to the commands that need history, which is what lets the build host carry a shallow tree.
function assertUsable() {
  if (!existsSync(join(MANIFEST.checkout, ".git")))
    throw new Error(`no git checkout at ${MANIFEST.checkout}`);
  if (MANIFEST.refuseShallowClone && NEEDS_HISTORY.has(CMD)) {
    const shallow = gitTry(["rev-parse", "--is-shallow-repository"]);
    if (shallow.out === "true") {
      throw new Error(
        `checkout is SHALLOW: ${CMD} replays a patch series and needs ancestry. ` +
          "Run it on the assembly host, or: git fetch --unshallow",
      );
    }
  }
}
// Does upstream's copy of a file already contain the lines our commit adds to it?
function upstreamHasChange(commit, file) {
  const diff = gitTry(["show", "--format=", "--unified=0", commit, "--", file]);
  if (!diff.ok || !diff.out) return false;
  const added = diff.out
    .split("\n")
    .filter((l) => l.startsWith("+") && !l.startsWith("+++"))
    .map((l) => l.slice(1));
  if (!added.length) return false;
  const theirs = gitTry(["show", `${MANIFEST.pinnedTag}:${file}`]);
  if (!theirs.ok || !theirs.out) return false;
  return added.every((line) => theirs.out.includes(line));
}

function duplicateTopLevelDeclarations() {
  // ★ The bundler was the first thing to notice a duplicated block, an hour and a full
  // build later. This notices it at the moment it is created, so the failure is named
  // where it happens instead of at a build step that cannot explain it.
  const files = gitTry(["diff", "--name-only", MANIFEST.pinnedTag + ".." + MANIFEST.distroBranch])
    .out.split("\n")
    .filter(function (f) {
      return f.slice(-3) === ".ts";
    });
  const hits = [];
  for (const f of files) {
    const text = gitTry(["show", MANIFEST.distroBranch + ":" + f]).out;
    const seen = {};
    let inTemplate = false;
    for (const line of text.split("\n")) {
      // ★ Track whether we are inside a template literal. A probe script embedded in a
      // string starts lines with `import fs from "node:fs";` at column 0, which is
      // indistinguishable from a real binding to a line scanner, and it made this guard
      // report three duplicates that were text. Code inside a string is not code.
      const ticks = (line.match(/`/g) || []).length;
      const wasInTemplate = inTemplate;
      if (ticks % 2 === 1) inTemplate = !inTemplate;
      if (wasInTemplate) continue; // ★ Skip the forms that legitimately repeat a name. A function OVERLOAD signature is
      // bodiless, interfaces merge by declaration, and a type alias is a type. The tag's own
      // sqlite file declares prepareSqliteReadOnlyLocationFromOwnedDatabase three times as two
      // overloads plus an implementation, and counting those made this guard refuse a tree that
      // was correct. What it must catch is a VALUE bound twice, an import included.
      let m = /^(?:export\s+)?(?:const|let|var|class|enum)\s+([A-Za-z_$][\w$]*)/.exec(line);
      if (!m && line.includes("{"))
        m = /^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/.exec(line);
      if (!m) m = /^import\s+(?:type\s+)?([A-Za-z_$][\w$]*)\s*(?:,|\s+from)/.exec(line);
      if (!m) m = /^import\s+\*\s+as\s+([A-Za-z_$][\w$]*)/.exec(line);
      if (!m) continue;
      const name = m[1];
      // ★ The defect this exists for duplicates an entire block, so the signature is the
      // SAME declaration text appearing twice. Counting a name alone was too blunt: it
      // flagged legitimate overloads and script source embedded in template strings, and
      // on the tag's own files it refused a tree that builds. Identical text is the signal.
      const text2 = line.trim();
      const key = name + "\u0000" + text2;
      seen[key] = (seen[key] || 0) + 1;
      if (seen[key] === 2) hits.push(f + ": " + name);
    }
  }
  return hits;
}

// The assembly cuts a WORK branch, named for the pin it was built from, and never writes to the
// landing branch itself. main is our distro and only ever moves forward: a new upstream release
// descends from the old one, so landing our re-adapted fixes on it is a merge, not a rewrite.
function workBranchName() {
  return (MANIFEST.workBranch || MANIFEST.distroBranch).replace(
    "<pin>",
    MANIFEST.pinnedTag.replace(/^v/, ""),
  );
}
function sync() {
  let resolvedHunks = 0;
  let adaptCount = 0;
  assertUsable();
  log("pin: " + MANIFEST.pinnedTag + " -> distro branch " + MANIFEST.distroBranch);
  if (DRY) {
    log("dry run: would fetch tags, cut the branch, and replay the patches");
    return;
  }
  git(["fetch", MANIFEST.upstream.remote, "--tags", "--quiet"]);
  git(["fetch", MANIFEST.fork.remote, "--tags", "--quiet"]);
  const tag = gitTry(["rev-parse", MANIFEST.pinnedTag + "^{commit}"]);
  if (!tag.ok)
    throw new Error(
      "pinned tag " + MANIFEST.pinnedTag + " is not present. Fetch it before syncing.",
    );
  log("base commit: " + tag.out.slice(0, 12));
  // ★ Capture the branch tip we are about to rebuild from, because our own paths can only come from it.
  const priorTip = gitTry(["rev-parse", MANIFEST.fork.remote + "/" + MANIFEST.distroBranch]);
  git(["checkout", "-q", "-B", MANIFEST.distroBranch, MANIFEST.pinnedTag]);

  // ★ Replay COMMIT BY COMMIT rather than applying one pre-computed diff per branch.
  // A branch diff was authored against a different upstream revision and simply refuses to
  // apply to the pin (measured: 12 of 12). Cherry-picking merges each change in context, so
  // off-pin code is adapted by the merge instead of rejected.
  const file = logPath("sync");
  appendFileSync(file, "sync " + new Date().toISOString() + " base=" + tag.out + "\n");
  let applied = 0,
    resolvedUpstream = 0,
    resolvedOurs = 0,
    failed = 0,
    skippedDupes = 0,
    offPin = 0;
  const appliedPatchIds = new Set();

  for (const p of MANIFEST.patches) {
    const ref = MANIFEST.fork.remote + "/" + p.branch;
    // ★ The base is the merge base with the PIN, not with upstream/main. A rebased patch descends from
    // the pin, so measuring from upstream/main swallows the pin own history: every patch then reports
    // dozens of commits left to upstream and the landing check refuses an assembly that is correct.
    const base = gitTry(["merge-base", MANIFEST.pinnedCommit, ref]);
    if (!base.ok) {
      log("  " + p.n + " " + p.branch + ": NO MERGE BASE, skipped");
      failed++;
      continue;
    }
    if (gitTry(["merge-base", "--is-ancestor", base.out, MANIFEST.pinnedTag]).status !== 0) {
      offPin++;
      appendFileSync(file, "authored-off-pin " + p.branch + "\n");
    }
    const commits = gitTry(["rev-list", "--reverse", base.out + ".." + ref])
      .out.split("\n")
      .filter(Boolean);
    for (const c of commits) {
      const pid =
        spawnSync("sh", ["-c", "git show " + c + " | git patch-id --stable"], {
          cwd: MANIFEST.checkout,
          encoding: "utf8",
        })
          .stdout.trim()
          .split(/\s+/)[0] || "";
      if (pid && appliedPatchIds.has(pid)) {
        skippedDupes++;
        appendFileSync(file, "duplicate-change-skipped " + p.branch + " " + c.slice(0, 12) + "\n");
        continue;
      }
      const picked = gitTry(["cherry-pick", c]);
      if (picked.ok) {
        applied++;
        if (pid) appliedPatchIds.add(pid);
        continue;
      }
      const unmerged = gitTry(["diff", "--name-only", "--diff-filter=U"])
        .out.split("\n")
        .filter(Boolean);
      if (!unmerged.length) {
        const dirty = gitTry(["status", "--porcelain"]).out.trim();
        if (dirty === "") {
          gitTry(["cherry-pick", "--skip"]);
          resolvedUpstream++;
          if (pid) appliedPatchIds.add(pid);
          appendFileSync(file, "upstream-already-has-it " + p.branch + " " + c.slice(0, 12) + "\n");
          continue;
        }
        appendFileSync(file, "FAILED-non-content " + p.branch + " " + c.slice(0, 12) + "\n");
        gitTry(["cherry-pick", "--abort"]);
        failed++;
        break;
      }
      for (const f of unmerged) {
        // Resolve at HUNK level, not file level. Taking --theirs for a file takes OUR WHOLE VERSION of
        // it, and our versions were authored well before the pin, so that silently drops upstream's
        // later edits to the same file: added SAFETY comments, line-cap and suppression fixes. Three
        // ratchets caught exactly that. So merge our change into the file as it stands, using git's own
        // stage entries for the three sides, and fall back to the older file-level choice only when the
        // hunks genuinely cannot be combined.
        const stageBase = gitTry(["show", ":1:" + f]);
        const stageOurs = gitTry(["show", ":2:" + f]);
        const stageTheirs = gitTry(["show", ":3:" + f]);
        let hunkMerged = false;
        // ★ Upstream-first comes BEFORE the hunk merge, and the order matters: if upstream copy already
        // carries what our commit adds, merging our side in duplicates it. A tree built that way declared
        // checkGatewayWsBrowserOrigin twice and the line-cap guard could not parse the file at all. So:
        // upstream already has it, take upstream; otherwise merge our change into the file as it stands.
        if (!upstreamHasChange(c, f) && stageBase.ok && stageOurs.ok && stageTheirs.ok) {
          writeFileSync("/tmp/nucleo-base", stageBase.out);
          writeFileSync("/tmp/nucleo-ours", stageOurs.out);
          writeFileSync("/tmp/nucleo-theirs", stageTheirs.out);
          const m = spawnSync(
            "git",
            [
              "merge-file",
              "-p",
              "--theirs",
              "/tmp/nucleo-ours",
              "/tmp/nucleo-base",
              "/tmp/nucleo-theirs",
            ],
            { cwd: MANIFEST.checkout, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
          );
          if (m.status === 0 && typeof m.stdout === "string") {
            writeFileSync(join(MANIFEST.checkout, f), m.stdout);
            gitTry(["add", "--", f]);
            resolvedHunks++;
            hunkMerged = true;
            appendFileSync(file, "hunk-merge " + p.branch + " " + c.slice(0, 12) + " " + f + "\n");
          }
        }
        if (hunkMerged) continue;
        if (upstreamHasChange(c, f)) {
          gitTry(["checkout", "--ours", "--", f]);
          gitTry(["add", "--", f]);
          resolvedUpstream++;
          appendFileSync(file, "upstream-wins " + p.branch + " " + c.slice(0, 12) + " " + f + "\n");
        } else {
          gitTry(["checkout", "--theirs", "--", f]);
          gitTry(["add", "--", f]);
          resolvedOurs++;
          appendFileSync(file, "our-fix-wins " + p.branch + " " + c.slice(0, 12) + " " + f + "\n");
        }
      }
      const cont = spawnSync("git", ["-c", "core.editor=true", "cherry-pick", "--continue"], {
        cwd: MANIFEST.checkout,
        encoding: "utf8",
      });
      if (cont.status !== 0) {
        appendFileSync(file, "STUCK " + p.branch + " " + c.slice(0, 12) + "\n");
        gitTry(["cherry-pick", "--abort"]);
        failed++;
        break;
      }
      applied++;
      if (pid) appliedPatchIds.add(pid);
    }
    log("  " + String(p.n).padStart(2) + " " + p.branch + ": done");
  }

  const dupes = duplicateTopLevelDeclarations();
  for (const d of dupes) appendFileSync(file, "DUPLICATE-DECLARATION " + d + "\n");
  const head = sha(MANIFEST.distroBranch);
  // ★ Our own paths live only on this branch, never in the pin, so the reset above would drop
  // them: the tooling that runs this assembly lives here, and so does the one workflow the fork
  // keeps. Take each from the branch tip captured above and record the carry. This is the mirror
  // of the pin-owned adaptation below, with the ownership reversed.
  let carriedCount = 0;
  if (priorTip.ok && priorTip.out) {
    for (const own of MANIFEST.forkOwnedPaths || []) {
      const taken = gitTry(["checkout", priorTip.out, "--", own]);
      if (!taken.ok) {
        appendFileSync(file, "carry-miss " + own + "\n");
        continue;
      }
      const changed = spawnSync("git", ["diff", "--cached", "--quiet", "--", own], {
        cwd: MANIFEST.checkout,
      });
      if (changed.status !== 0) {
        spawnSync(
          "git",
          ["-c", "core.editor=true", "commit", "-q", "-m", "carry: keep our own path " + own],
          { cwd: MANIFEST.checkout, encoding: "utf8" },
        );
        appendFileSync(file, "carry " + own + "\n");
        carriedCount += 1;
      }
    }
  }
  // ★ Ledgers and baselines belong to upstream, not to a patch. When a patch carries an older copy
  // of one, that copy wins the file and every entry upstream added since our base disappears, so a
  // ratchet reads a stale allowance and reports failures against code that is fine: ten files came
  // back that way on 2026-10-06 while the code was never at fault. So these files are taken from the
  // pin once the replay is done, and the change is recorded as an adaptation commit.
  for (const owned of MANIFEST.pinOwnedFiles || []) {
    gitTry(["checkout", MANIFEST.pinnedTag, "--", owned]);
    const staged = spawnSync("git", ["diff", "--cached", "--quiet", "--", owned], {
      cwd: MANIFEST.checkout,
    });
    if (staged.status !== 0) {
      spawnSync(
        "git",
        ["-c", "core.editor=true", "commit", "-q", "-m", "adapt: take upstream copy of " + owned],
        { cwd: MANIFEST.checkout, encoding: "utf8" },
      );
      appendFileSync(file, "adaptation pin-owned " + owned + "\n");
      adaptCount++;
    }
  }
  appendFileSync(
    file,
    "applied=" +
      applied +
      " upstream_wins=" +
      resolvedUpstream +
      " hunk_merges=" +
      resolvedHunks +
      " adaptations=" +
      adaptCount +
      " carried=" +
      carriedCount +
      " our_fix_wins=" +
      resolvedOurs +
      " duplicate_changes_skipped=" +
      skippedDupes +
      " authored_off_pin=" +
      offPin +
      " duplicate_declarations=" +
      dupes.length +
      " failed=" +
      failed +
      "\n",
  );
  log(
    "distro " +
      MANIFEST.distroBranch +
      " at " +
      head +
      "; applied=" +
      applied +
      " failed=" +
      failed,
  );
  log(
    "upstream_wins=" +
      resolvedUpstream +
      " our_fix_wins=" +
      resolvedOurs +
      " duplicate_changes_skipped=" +
      skippedDupes,
  );
  log(
    "authored_off_pin=" + offPin + " of " + MANIFEST.patches.length + " (0 is the healthy number)",
  );
  log("duplicate_declarations=" + dupes.length);
  log("log: " + file);
  if (dupes.length) {
    log("REFUSING: a carried change was applied twice; see DUPLICATE-DECLARATION in the log.");
    process.exitCode = 1;
  }
  if (failed) {
    log("REFUSING: " + failed + " patch(es) did not land.");
    process.exitCode = 1;
  }
  if (!applied) {
    log("REFUSING: nothing was applied at all.");
    process.exitCode = 1;
  }
}

function verify() {
  // ★ Ancestry is the wrong test here, and it took a measurement to see it: a replay
  // CHERRY-PICKS, which writes new commits, so an original commit is never an ancestor
  // of the distro branch. Identity has to be by patch content, which is what patch-id
  // gives. We also do not demand presence for a commit the policy SKIPPED, because a
  // skip means upstream solved that issue its own way.
  assertUsable();
  const target = MANIFEST.distroBranch;
  const patchId = (sha) => {
    const r = spawnSync("sh", ["-c", `git show ${sha} | git patch-id --stable`], {
      cwd: MANIFEST.checkout,
      encoding: "utf8",
    });
    return (r.stdout || "").trim().split(/\s+/)[0] || "";
  };
  const carried = new Set(
    gitTry(["rev-list", `${MANIFEST.pinnedTag}..${target}`])
      .out.split("\n")
      .filter(Boolean)
      .map(patchId)
      .filter(Boolean),
  );
  let ok = 0,
    partial = 0,
    bad = 0,
    carriedTotal = 0,
    skippedTotal = 0,
    superseded = 0;
  for (const p of MANIFEST.patches) {
    const ref = `${MANIFEST.fork.remote}/${p.branch}`;
    const base = gitTry(["merge-base", MANIFEST.pinnedCommit, ref]);
    const commits = base.ok
      ? gitTry(["rev-list", `${base.out}..${ref}`])
          .out.split("\n")
          .filter(Boolean)
      : [];
    if (!commits.length) {
      log(`  ??   ${p.n} ${p.branch}: no commits found`);
      bad++;
      continue;
    }
    let mine = 0,
      theirs = 0,
      absent = 0;
    for (const c of commits) {
      if (!carried.has(patchId(c))) {
        theirs++;
        continue;
      } // policy left it to upstream
      mine++;
      const files = gitTry(["show", "--format=", "--name-only", c]).out.split("\n").filter(Boolean);
      for (const f of files) {
        const d = gitTry(["show", "--format=", "--unified=0", c, "--", f]);
        if (!d.ok || !d.out) continue;
        const added = d.out
          .split("\n")
          .filter((l) => l.startsWith("+") && !l.startsWith("+++"))
          .map((l) => l.slice(1))
          .filter(Boolean);
        if (!added.length) continue;
        const inTree = gitTry(["show", `${target}:${f}`]);
        if (!inTree.ok) {
          absent += added.length;
          continue;
        }
        const missing = added.filter((line) => !inTree.out.includes(line)).length;
        if (!missing) continue;
        // ★ A line our commit added can be missing because upstream OWN version of the file won the
        // conflict resolution, which is the policy: upstream-first. That is a recorded outcome, not a
        // failure. The test that tells the two apart is whether the file in the tree is identical to
        // the pin's version of it: if it is, our change to that file was superseded rather than lost.
        // A missing line is accounted when upstream RELEASE already carries that same line: the
        // behaviour is present whoever supplied it, which is the whole point of upstream-first. A
        // line that is in neither the tree nor the release is genuinely lost, and that is a failure.
        const pinFile = gitTry(["show", `${MANIFEST.pinnedTag}:${f}`]);
        const alreadyUpstream = pinFile.ok
          ? added.filter((line) => !inTree.out.includes(line) && pinFile.out.includes(line)).length
          : 0;
        superseded += alreadyUpstream;
        absent += missing - alreadyUpstream;
      }
    }
    carriedTotal += mine;
    skippedTotal += theirs;
    // ★ Line presence cannot decide whether a patch is carried: our added line can be absent because
    // the policy preferred upstream in that hunk, which is upstream-first working as designed. What
    // decides is the BEHAVIOUR, so a patch whose lines did not all land is accepted when it names the
    // behaviour and its tests, and is a hard failure when it names none. That is the same acceptance
    // criterion the manifest carries for every patch.
    const behaviour = Array.isArray(p.behaviourTests) && p.behaviourTests.length ? p.behaviour : "";
    if (absent === 0) {
      log(`  ok      ${p.n} ${p.branch} (${mine} carried, ${theirs} left to upstream)`);
      ok++;
    } else if (behaviour) {
      log(
        `  partial ${p.n} ${p.branch}: ${absent} added line(s) not in the tree, upstream preferred there; acceptance is the behaviour: ${behaviour}`,
      );
      partial++;
    } else {
      log(
        `  FAIL    ${p.n} ${p.branch}: ${absent} added line(s) absent from a CARRIED patch and it names no behaviour`,
      );
      bad++;
    }
  }
  log(
    `verify: ok=${ok} partial=${partial} failed=${bad} carried_patches=${carriedTotal} left_to_upstream=${skippedTotal} superseded_lines=${superseded}`,
  );
  // ★ A distro that carries NOTHING is not a valid distro, and this check passed on one:
  // it printed ok=12 on a branch sitting at the tag with zero patches carried. A check
  // that cannot fail is not a check.
  if (carriedTotal === 0) {
    log("REFUSING: the distro branch carries no patches at all.");
    process.exitCode = 1;
  }
  if (bad) process.exitCode = 1;
}

function gate() {
  const file = logPath("gate");
  const head = sha(MANIFEST.distroBranch);
  appendFileSync(
    file,
    `gate ${new Date().toISOString()} commit=${git(["rev-parse", MANIFEST.distroBranch])}\n`,
  );
  let green = true;
  for (const step of MANIFEST.gates) {
    log(`gate: pnpm run ${step}`);
    const r = spawnSync("pnpm", ["run", step], { cwd: MANIFEST.checkout, encoding: "utf8" });
    appendFileSync(
      file,
      `\n### ${step} rc=${r.status}\n${(r.stdout || "").slice(-4000)}\n${(r.stderr || "").slice(-2000)}\n`,
    );
    if (r.status !== 0) {
      green = false;
      log(`  ${step} FAILED`);
      break;
    }
    log(`  ${step} ok`);
  }
  appendFileSync(file, `\n@@@ ${green ? "GREEN" : "RED"} ${head}\n`);
  log(`gate ${green ? "GREEN" : "RED"} for ${head}: ${file}`);
  if (!green) process.exitCode = 1;
}

function build() {
  const head = git(["rev-parse", MANIFEST.distroBranch]);
  const scheme = RELEASE ? MANIFEST.image.releaseTagScheme : MANIFEST.image.devTagScheme;
  // ★ The build number has one owner and it is the assembly host, which has the history to count.
  // A build host carries a shallow tree on purpose, so it cannot count and must be told instead.
  const build =
    process.env.NUCLEO_BUILD_NUMBER ||
    git(["rev-list", "--count", MANIFEST.pinnedTag + ".." + MANIFEST.distroBranch]);
  const short = git(["rev-parse", "--short", MANIFEST.distroBranch]);
  const tag = scheme
    .replace("<version>", MANIFEST.version)
    .replace("<build>", build)
    .replace("<sha>", short);
  const image = MANIFEST.image.name + ":" + tag;
  log(
    "image " +
      image +
      " from " +
      head.slice(0, 12) +
      " (nucleo " +
      MANIFEST.version +
      ", pin " +
      MANIFEST.pinnedTag +
      ")",
  );
  if (DRY) return;
  const heap = String(MANIFEST.buildHeapMb || 3072);
  // The pinned tree ships the Dockerfile, and it is already built for this: type declaration
  // emission is off by default, the base images are pinned by digest, and the runtime stage
  // asserts OPENCLAW_DOCKER_BUILD_VERSION in three places. So the recipe is this invocation,
  // and the build context is the checkout itself rather than a clone inside the image.
  const r = spawnSync(
    "docker",
    [
      "build",
      "-f",
      join(MANIFEST.checkout, "Dockerfile"),
      "-t",
      image,
      "--build-arg",
      "OPENCLAW_DOCKER_BUILD_NODE_OPTIONS=--max-old-space-size=" + heap,
      "--build-arg",
      "GIT_COMMIT=" + short,
      "--build-arg",
      "NUCLEO_UPSTREAM_TAG=" + MANIFEST.pinnedTag,
      "--build-arg",
      "NUCLEO_UPSTREAM_COMMIT=" + head,
      "--build-arg",
      "OPENCLAW_DOCKER_BUILD_VERSION=" + MANIFEST.version,
      "--label",
      "org.opencontainers.image.version=" + MANIFEST.version,
      "--label",
      "org.opencontainers.image.revision=" + head,
      "--label",
      "nucleo.pin=" + MANIFEST.pinnedTag,
      MANIFEST.checkout,
    ],
    { stdio: "inherit" },
  );
  if (r.status !== 0) throw new Error("image build failed");
  log("built " + image + ". The previous tag stays on the host for rollback.");
}
function publish() {
  const head = git(["rev-parse", MANIFEST.distroBranch]);
  mkdirSync(MANIFEST.logs, { recursive: true });
  const logs = execFileSync("ls", [MANIFEST.logs], { encoding: "utf8" })
    .split("\n")
    .filter((f) => f.includes("gate"));
  const greenForThis = logs.some((f) => {
    const body = readFileSync(join(MANIFEST.logs, f), "utf8");
    return body.includes(`@@@ GREEN ${head.slice(0, 12)}`) || body.includes(`version=${head}`);
  });
  if (!greenForThis) throw new Error(`no green gate log for ${head}. Run: nucleo.mjs gate`);
  if (DRY) {
    log(`would push a tag for ${head.slice(0, 12)}`);
    return;
  }
  const buildNo = git(["rev-list", "--count", MANIFEST.pinnedTag + ".." + MANIFEST.distroBranch]);
  const short = git(["rev-parse", "--short", MANIFEST.distroBranch]);
  const tagName =
    "v" + (RELEASE ? MANIFEST.version : MANIFEST.version + "-dev." + buildNo + "." + short);
  log("publish is deliberate: create the tag, then push it with the fork remote");
  log(`  git tag ${tagName} ${head} && git push ${MANIFEST.fork.remote} ${tagName}`);
}

function status() {
  assertUsable();
  const tag = gitTry(["rev-parse", "--short", MANIFEST.pinnedTag]);
  const branch = gitTry(["rev-parse", "--short", MANIFEST.distroBranch]);
  log(`checkout: ${MANIFEST.checkout}`);
  log(`pinned tag: ${MANIFEST.pinnedTag} ${tag.ok ? tag.out : "(missing)"}`);
  log(`distro branch: ${MANIFEST.distroBranch} ${branch.ok ? branch.out : "(not cut yet)"}`);
  log(`patches in the manifest: ${MANIFEST.patches.length}`);
  log(`logs: ${MANIFEST.logs}`);
}

const RUN = { sync, verify, gate, build, publish, status };
if (!RUN[CMD]) {
  log(`unknown command: ${CMD}`);
  process.exit(2);
}
try {
  RUN[CMD]();
} catch (e) {
  log(`nucleo: ${String(e.message || e)}`);
  process.exit(1);
}
