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

test("upstream test files run through the checkout's own test runner and propagate its failures", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "patch-repo-runner-"));
  try {
    fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    const file = "src/proof.test.ts";
    fs.writeFileSync(path.join(root, file), "");
    const manifest = path.join(root, "manifest.json");
    fs.writeFileSync(
      manifest,
      JSON.stringify({
        patches: [{ n: 30, branch: "fixture", featureOrFix: "fixture", tests: [file] }],
      }),
    );
    fs.writeFileSync(path.join(root, "scripts/tsx.mjs"), 'globalThis.__repoLoader = "tsx";');
    fs.writeFileSync(
      path.join(root, "scripts/test-projects.mts"),
      [
        'import fs from "node:fs";',
        'fs.writeFileSync("runner-args.json", JSON.stringify({ loader: globalThis.__repoLoader, args: process.argv.slice(2) }));',
        'if (fs.existsSync("fail")) { console.log("listed test failed"); process.exit(1); }',
      ].join("\n"),
    );
    const env = { ...process.env, NUCLEO_MANIFEST: manifest };
    delete env.NODE_TEST_CONTEXT;
    const run = () =>
      spawnSync(process.execPath, [runner, root, "30"], { encoding: "utf8", timeout: 15_000, env });
    const green = run();
    assert.equal(green.status, 0, green.stdout + green.stderr);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, "runner-args.json"), "utf8")), {
      loader: "tsx",
      args: [file],
    });
    assert.match(green.stdout, /held=1 of 1/);
    fs.writeFileSync(path.join(root, "fail"), "");
    const red = run();
    assert.equal(red.status, 1, red.stdout + red.stderr);
    assert.match(red.stdout, /listed test failed/);
    fs.rmSync(path.join(root, "scripts/test-projects.mts"));
    const absent = run();
    assert.equal(absent.status, 1, absent.stdout + absent.stderr);
    assert.match(absent.stdout, /no repository test runner/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
