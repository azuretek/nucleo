import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const checkout = fileURLToPath(new URL("../../", import.meta.url));
test("duplicate scan excludes distro but rejects unclassified upstream source", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "distro-duplicates-"));
  try {
    fs.cpSync(path.join(checkout, "scripts"), path.join(root, "scripts"), { recursive: true });
    fs.writeFileSync(path.join(root, "package.json"), '{"type":"module"}');
    fs.writeFileSync(path.join(root, "pnpm-workspace.yaml"), "packages: []\n");
    fs.symlinkSync(path.join(checkout, "node_modules"), path.join(root, "node_modules"), "dir");
    const git = (...args) => {
      const r = spawnSync("git", args, { cwd: root, encoding: "utf8", timeout: 10_000 });
      assert.equal(r.status, 0, r.stderr);
    };
    git("init", "--quiet");
    fs.mkdirSync(path.join(root, "distro"));
    fs.writeFileSync(path.join(root, "distro/tool.mjs"), "export const tooling = true;\n");
    git("add", "distro/tool.mjs");
    const scan = () =>
      spawnSync(process.execPath, [path.join(root, "scripts/check-duplicates.mts"), "--coverage"], {
        cwd: root,
        encoding: "utf8",
        timeout: 30_000,
      });
    const excluded = scan();
    assert.equal(excluded.status, 0, excluded.stdout + excluded.stderr);
    assert.match(excluded.stdout, /target coverage ok/);
    fs.mkdirSync(path.join(root, "unclassified"));
    fs.writeFileSync(path.join(root, "unclassified/source.ts"), "export const source = true;\n");
    git("add", "unclassified/source.ts");
    const rejected = scan();
    assert.equal(rejected.status, 1, rejected.stdout + rejected.stderr);
    assert.match(rejected.stderr, /unclassified\/source.ts/);
    assert.doesNotMatch(rejected.stderr, /distro\/tool.mjs/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
