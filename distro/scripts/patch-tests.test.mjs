import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const script = fileURLToPath(new URL("patch-tests.mjs", import.meta.url));
function fixture(t, { absent = false, fail = false, only } = {}) {
  const root = mkdtempSync(join(tmpdir(), "patch-tests-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "bin"));
  writeFileSync(join(root, "present.test.ts"), "");
  const manifest = join(root, "nucleo.json");
  writeFileSync(manifest, JSON.stringify({ patches: [
    { n: 1, branch: "one", tests: ["present.test.ts", ...(absent ? ["absent.test.ts"] : [])] },
    { n: 2, branch: "two", tests: ["present.test.ts"] },
  ] }));
  writeFileSync(join(root, "bin", "pnpm"), "#!/usr/bin/env node\n" +
    "require('node:fs').appendFileSync(process.env.CALLS, JSON.stringify({args: process.argv.slice(2), workers: process.env.OPENCLAW_VITEST_MAX_WORKERS})+'\\n'); process.exit(Number(process.env.FAIL));\n", { mode: 0o755 });
  const calls = join(root, "calls");
  const r = spawnSync(process.execPath, [script, root, ...(only ? [String(only)] : [])], {
    encoding: "utf8", env: { ...process.env, NUCLEO_MANIFEST: manifest,
      PATH: join(root, "bin") + ":" + process.env.PATH, CALLS: calls, FAIL: fail ? "1" : "0" },
    timeout: 5000,
  });
  return { r, calls: readFileSync(calls, "utf8").trim().split("\n").map(JSON.parse) };
}
test("one invocation deduplicates shared tests and bounds workers", (t) => {
  const { r, calls } = fixture(t);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { args: ["exec", "vitest", "run", "present.test.ts"], workers: "2" });
});
test("a combined failure stays red without rerunning patches", (t) => {
  const { r, calls } = fixture(t, { fail: true });
  assert.equal(r.status, 1);
  assert.equal(calls.length, 1);
  assert.match(r.stdout, /combined patch tests/);
});
test("a partially missing test list cannot pass", (t) => {
  const { r } = fixture(t, { absent: true });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /absent.test.ts/);
});
test("a selected patch runs without unrelated patches", (t) => {
  const { r, calls } = fixture(t, { only: 2 });
  assert.equal(r.status, 0);
  assert.equal(calls.length, 1);
  assert.match(r.stdout, /held=1 of 1/);
});
