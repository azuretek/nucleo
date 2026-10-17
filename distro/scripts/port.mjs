#!/usr/bin/env node
// Reports EVERY adaptation point for porting our patch commits onto the pinned release,
// before a single build is run.
//
// ★ Why this exists: a patch branch carries upstream merge commits as well as our own work
// (measured on our first set: 161 range commits, only 83 ours). Replaying the whole range
// drags newer upstream files onto the pin, and those files call siblings the pin lacks, so
// the failures surface one MISSING_EXPORT per ten-minute build. Porting OUR commits only,
// with --reject, names all of them in about two minutes.
//
// Usage: node scripts/port.mjs <checkout> [worktreeDir]
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const manifest = JSON.parse(readFileSync(new URL("../nucleo.json", import.meta.url), "utf8"));
const checkout = process.argv[2] || manifest.checkout;
const probe = process.argv[3] || "/tmp/nucleo-port-probe";
if (!existsSync(checkout)) {
  console.error("checkout not found: " + checkout);
  process.exit(2);
}

function git(args, cwd) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 1 << 30 });
  return { ok: r.status === 0, out: (r.stdout || "").trim(), err: (r.stderr || "").trim() };
}

git(["worktree", "remove", "--force", probe], checkout);
git(["worktree", "prune"], checkout);
mkdirSync(probe, { recursive: true });
const added = git(["worktree", "add", "-f", "--detach", probe, manifest.pinnedTag], checkout);
if (!added.ok) {
  console.error("could not create worktree at " + manifest.pinnedTag + ": " + added.err);
  process.exit(1);
}

const lines = [];
let clean = 0;
let ourTotal = 0;
console.log("pin " + manifest.pinnedTag + " -> " + probe);
for (const p of manifest.patches) {
  const ref = manifest.fork.remote + "/" + p.branch;
  const list = git(
    ["rev-list", "--no-merges", "--reverse", ref, "--not", manifest.upstream.remote + "/main"],
    probe,
  );
  const commits = list.ok ? list.out.split("\n").filter(Boolean) : [];
  let rejects = 0;
  for (const c of commits) {
    ourTotal += 1;
    const patch = git(["show", "--binary", "--format=", c], probe).out;
    if (!patch) continue;
    writeFileSync(probe + "/.port.patch", patch + "\n");
    if (git(["apply", "--3way", "--whitespace=nowarn", ".port.patch"], probe).ok) {
      clean += 1;
      continue;
    }
    git(["checkout", "--", "."], probe);
    const rej = spawnSync(
      "sh",
      [
        "-c",
        'git apply --reject --whitespace=nowarn .port.patch >/dev/null 2>&1; find . -name "*.rej" -not -path "./.git/*"',
      ],
      { cwd: probe, encoding: "utf8" },
    );
    for (const f of (rej.stdout || "")
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean)) {
      lines.push(
        p.branch + " " + c.slice(0, 11) + " " + f.replace(/^\.\//, "").replace(/\.rej$/, ""),
      );
      rejects += 1;
    }
    spawnSync("sh", ["-c", 'find . -name "*.rej" -not -path "./.git/*" -delete'], { cwd: probe });
  }
  console.log(
    "  " +
      String(p.n).padStart(2) +
      " " +
      p.branch.padEnd(46) +
      " ours=" +
      commits.length +
      " points=" +
      rejects,
  );
}
console.log(
  "== our commits=" +
    ourTotal +
    " applied clean=" +
    clean +
    " adaptation points=" +
    lines.length +
    " ==",
);
const files = [...new Set(lines.map((l) => l.split(" ").slice(2).join(" ")))].sort();
console.log("== distinct files=" + files.length + " ==");
writeFileSync(resolve(probe, "port-worklist.txt"), lines.join("\n") + "\n");
console.log("worklist: " + resolve(probe, "port-worklist.txt"));
