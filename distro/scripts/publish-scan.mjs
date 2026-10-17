#!/usr/bin/env node
import { spawnSync } from "node:child_process";
// Mechanical pre-publish scan for this repository, so the check runs on its own in CI
// rather than depending on someone remembering to look. Exit 0 means clean.
//
// ★ This file is excluded from its own scan, because a scanner has to name what it bans.
// Patterns are built from escapes so this source carries no literal em dash.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = process.cwd();
const SELF = "scripts/publish-scan.mjs";
const SKIP_DIRS = new Set([".git", "node_modules"]);

const BANNED = [
  {
    name: "attribution",
    re: /co-authored-by|noreply@anthropic\.com|generated with claude|written by ai/i,
  },
  { name: "em-dash", re: new RegExp("\u2014") },
  { name: "host-path", re: /\/azuredata\d|\/home\/(?!USER\b)[a-z][a-z0-9_-]{2,}/i },
  {
    name: "tailnet-or-lan-ip",
    re: /[a-z0-9-]+\.ts\.net|\b192\.168\.\d+\.\d+\b|\b100\.\d+\.\d+\.\d+\b/,
  },
];

function walk(dir, out = []) {
  for (const e of readdirSync(dir)) {
    if (SKIP_DIRS.has(e)) continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

let hits = 0;
const files = walk(ROOT);
// ★ A gitignored file is not published, so it is not this scan's business. The
// host override (nucleo.local.json) holds real host paths and never leaves the machine;
// scanning the working copy made this check fail on a file that cannot be committed.
const ignored = new Set();
try {
  const rels = files.map((f) => relative(ROOT, f));
  const gi = spawnSync("git", ["check-ignore", "--stdin"], {
    input: rels.join("\n"),
    encoding: "utf8",
  });
  for (const line of (gi.stdout || "").split("\n")) if (line.trim()) ignored.add(line.trim());
} catch {}
for (const f of files) {
  const rel = relative(ROOT, f);
  if (rel === SELF || rel === ".git") continue;
  if (ignored.has(rel)) continue;
  const isPatch = rel.endsWith(".patch");
  let text;
  try {
    text = readFileSync(f, "utf8");
  } catch {
    continue;
  }
  // A patch file is a DIFF, not a document we wrote: its context lines and its @@ hunk
  // headers are the pinned tree's own text, so this check would fail on upstream's em
  // dashes, which we cannot fix without diverging from the pin. For a patch we test only
  // the lines we author, meaning the added ones.
  for (const { name, re } of BANNED) {
    text.split("\n").forEach((line, i) => {
      if (isPatch && !(line.startsWith("+") && !line.startsWith("+++"))) return;
      if (re.test(line)) {
        hits++;
        console.log(`FAIL ${name} ${rel}:${i + 1}: ${line.trim().slice(0, 100)}`);
      }
    });
  }
}
console.log(`publish-scan: files=${files.length} hits=${hits}`);
process.exit(hits ? 1 : 0);
