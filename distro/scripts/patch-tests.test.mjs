import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const runner = fileURLToPath(new URL("./patch-tests.mjs", import.meta.url));
test("manifest Node tests execute and propagate failures instead of claiming build coverage", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "patch-node-route-"));
  try {
    fs.mkdirSync(path.join(root, "distro/scripts"), { recursive: true });
    const file = "distro/scripts/proof.test.mjs";
    const manifest = path.join(root, "manifest.json");
    fs.writeFileSync(
      manifest,
      JSON.stringify({
        patches: [{ n: 14, branch: "fixture", featureOrFix: "fixture", tests: [file] }],
      }),
    );
    const env = { ...process.env, NUCLEO_MANIFEST: manifest };
    delete env.NODE_TEST_CONTEXT;
    const run = () =>
      spawnSync(process.execPath, [runner, root, "14"], {
        encoding: "utf8",
        timeout: 15_000,
        env,
      });
    fs.writeFileSync(
      path.join(root, file),
      'import fs from "node:fs"; fs.writeFileSync("executed", "yes");',
    );
    const green = run();
    assert.equal(green.status, 0, green.stdout + green.stderr);
    assert.equal(fs.readFileSync(path.join(root, "executed"), "utf8"), "yes");
    assert.match(green.stdout, /held=1 of 1/);
    fs.writeFileSync(path.join(root, file), 'throw new Error("behavior regressed");');
    const red = run();
    assert.equal(red.status, 1, red.stdout + red.stderr);
    assert.match(red.stdout, /behavior regressed/);
    fs.writeFileSync(path.join(root, file), "");
    fs.writeFileSync(
      manifest,
      JSON.stringify({
        patches: [
          {
            n: 14,
            branch: "fixture",
            featureOrFix: "fixture",
            tests: [file, "distro/scripts/missing.test.mjs"],
          },
        ],
      }),
    );
    const missing = run();
    assert.equal(missing.status, 1, missing.stdout + missing.stderr);
    assert.match(missing.stdout, /declared tests are absent/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
