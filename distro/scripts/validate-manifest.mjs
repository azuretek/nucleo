#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
// Validates the manifest. The manifest is the single owner of every shared value, so a
// malformed one has to fail here rather than at build time on a host.
//
// ★ Shape is read from the manifest that exists, not from a guess at it. The first
// version of this file checked a "name" key that the manifest has never had, which is a
// validator lying about a real file.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const m = JSON.parse(readFileSync("nucleo.json", "utf8"));
const problems = [];
const need = (cond, msg) => {
  if (!cond) problems.push(msg);
};

need(
  typeof m.pinnedTag === "string" && /^v\d{4}\.\d+\.\d+$/.test(m.pinnedTag),
  `pinnedTag must look like v<year>.<minor>.<patch>, got ${JSON.stringify(m.pinnedTag)}`,
);
need(typeof m.distroBranch === "string" && m.distroBranch, "distroBranch is required");
// ★ The fork main IS the distribution: it carries the pin plus our adapted patches, so
// branch name != pin version. The two assertions that demanded otherwise were removed on
// purpose (they rejected the manifest we actually use). What replaces them checks the
// versioning rule, which is the thing that was really load-bearing.
need(
  typeof m.version === "string" && /^\d+\.\d+\.\d+$/.test(m.version),
  `version must be plain semver on our own line, never upstream's, got ${JSON.stringify(m.version)}`,
);
need(
  typeof m.current === "string" && /^\d+\.\d+\.\d+$/.test(m.current),
  "current must be plain semver: the version a deployment reports today",
);
need(
  m.current !== m.version,
  "current and version must differ: version is the one in development, so the dev line is ahead of what is deployed",
);
need(typeof m.image?.name === "string" && m.image.name, "image.name is required");
need(
  typeof m.image?.devTagScheme === "string" && m.image.devTagScheme.includes("<version>"),
  "image.devTagScheme must carry <version>: an image tag is our version, not upstream's",
);
need(
  typeof m.image?.releaseTagScheme === "string" && m.image.releaseTagScheme.includes("<version>"),
  "image.releaseTagScheme must carry <version>",
);
need(Array.isArray(m.gates) && m.gates.length > 0, "gates must be a non-empty array");
need(
  m.gates.lastIndexOf("build") === m.gates.length - 1,
  "build must be the LAST gate: everything that can reject the tree runs before a build",
);

need(m.upstream?.remote && m.upstream?.repo, "upstream.remote and upstream.repo are required");
need(m.fork?.remote && m.fork?.repo, "fork.remote and fork.repo are required");
need(
  m.patchPolicy === "upstream-first",
  `patchPolicy must be upstream-first, got ${JSON.stringify(m.patchPolicy)}`,
);
need(
  m.refuseShallowClone === true,
  "refuseShallowClone must be true: a shallow clone cannot replay a patch series",
);
need(
  m.image?.tagScheme === undefined,
  "image.tagScheme is gone: the tag scheme always carries our version now",
);
need(
  Number.isInteger(m.image?.keepDevImages) && m.image.keepDevImages >= 1,
  "image.keepDevImages must be a positive integer: the rule bounds how many dev images we keep",
);
need(
  typeof m.devTagScheme === "string" && m.devTagScheme.includes("<sha>"),
  "the dev git tag must carry <sha>, matching chela and cuate",
);
need(
  typeof m.devBuildNumber === "string" && m.devBuildNumber,
  "devBuildNumber must state where <build> comes from",
);
need(Array.isArray(m.patches) && m.patches.length, "patches must be a non-empty array");
need(
  typeof m.pinnedCommit === "string" && /^[0-9a-f]{40}$/.test(m.pinnedCommit),
  "pinnedCommit must be the pin commit, which is the base every measurement uses",
);

// ★ Our own scripts are code, and a syntax error in one of them is invisible to a text scan.
// This check is why a broken nucleo.mjs can never reach a host again.
for (const f of readdirSync(join(dirname(fileURLToPath(import.meta.url))))) {
  if (!f.endsWith(".mjs")) continue;
  const r = spawnSync(
    process.execPath,
    ["--check", join(dirname(fileURLToPath(import.meta.url)), f)],
    { encoding: "utf8" },
  );
  need(
    r.status === 0,
    "scripts/" + f + " does not parse: " + String(r.stderr || "").split("\n")[0],
  );
}

const seenBranches = new Set();
const seenNumbers = new Set();
for (const [i, p] of (m.patches || []).entries()) {
  need(Number.isInteger(p.n), `patches[${i}].n must be an integer`);
  need(typeof p.branch === "string" && p.branch, `patches[${i}].branch is required`);
  need(typeof p.subject === "string" && p.subject, `patches[${i}].subject is required`);
  if (seenBranches.has(p.branch)) problems.push(`duplicate patch branch: ${p.branch}`);
  if (seenNumbers.has(p.n)) problems.push(`duplicate patch number: ${p.n}`);
  seenBranches.add(p.branch);
  seenNumbers.add(p.n);
}

if (problems.length) {
  for (const p of problems) console.log(`FAIL ${p}`);
  process.exit(1);
}
console.log(
  `manifest ok: pin=${m.pinnedTag} branch=${m.distroBranch} patches=${m.patches.length} gates=${m.gates.join(",")}`,
);
