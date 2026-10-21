import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const checkout = fileURLToPath(new URL("../../", import.meta.url));
test("carried WAL support and Vitest cache hook satisfy the pinned strict type contract", () => {
  // Use the real source files, not copies of the corrected expressions. Keep the
  // test/config tree in scope even though the production/image build excludes it.
  const config = path.join(checkout, "distro", `.tooling-types-${randomUUID()}.generated.json`);
  try {
    fs.writeFileSync(
      config,
      JSON.stringify({
        extends: "../tsconfig.json",
        compilerOptions: { incremental: false, rootDir: ".." },
        files: [
          "../src/infra/sqlite-wal.replacement.test-support.ts",
          "../test/vitest/vitest.performance-config.ts",
        ],
        include: ["../src/types/**/*.d.ts"],
        exclude: [],
      }),
    );
    const result = spawnSync(
      process.execPath,
      [path.join(checkout, "scripts/run-tsgo.mjs"), "--project", config, "--noEmit"],
      { cwd: checkout, encoding: "utf8", timeout: 120_000, maxBuffer: 16 * 1024 * 1024 },
    );
    assert.equal(result.status, 0, result.stdout + result.stderr);
  } finally {
    fs.rmSync(config, { force: true });
  }
});
