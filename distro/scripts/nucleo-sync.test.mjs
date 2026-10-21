import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

test("sync accepts a patch authored on the pin without an off-pin diagnostic", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "nucleo-sync-"));
  try {
    const checkout = path.join(root, "checkout");
    const tooling = path.join(root, "tooling");
    mkdirSync(checkout);
    mkdirSync(tooling);
    cpSync(new URL(".", import.meta.url), path.join(tooling, "scripts"), { recursive: true });
    const git = (...args) => execFileSync("git", args, { cwd: checkout, encoding: "utf8" }).trim();
    git("init", "-q", "-b", "main");
    git("config", "user.name", "Fixture");
    git("config", "user.email", "fixture@example.invalid");
    writeFileSync(path.join(checkout, "feature.txt"), "pin\n");
    git("add", ".");
    git("commit", "-qm", "test: pin");
    const pin = git("rev-parse", "HEAD");
    git("tag", "test-pin");
    git("checkout", "-qb", "feature");
    writeFileSync(path.join(checkout, "feature.txt"), "patch\n");
    git("commit", "-qam", "fix: feature");
    git("checkout", "main");
    git("remote", "add", "origin", checkout);
    git("remote", "add", "upstream", checkout);
    const manifest = {
      checkout,
      logs: path.join(root, "logs"),
      pinnedTag: "test-pin",
      pinnedCommit: pin,
      distroBranch: "candidate",
      fork: { remote: "origin" },
      upstream: { remote: "upstream" },
      patches: [{ n: 1, branch: "feature" }],
      forkOwnedPaths: [],
      pinOwnedFiles: [],
    };
    writeFileSync(path.join(tooling, "nucleo.json"), JSON.stringify(manifest));
    // Fixture host paths must win over the outer GitHub runner workspace.
    writeFileSync(
      path.join(tooling, "nucleo.local.json"),
      JSON.stringify({
        checkout,
        logs: manifest.logs,
      }),
    );
    const result = spawnSync(process.execPath, [path.join(tooling, "scripts/nucleo.mjs"), "sync"], {
      encoding: "utf8",
      timeout: 30_000,
      env: { ...process.env, GITHUB_ACTIONS: "true", GITHUB_WORKSPACE: tooling, RUNNER_TEMP: root },
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /authored_off_pin=0 of 1/);
    assert.equal(git("show", "candidate:feature.txt"), "patch");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
