import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const runner = fileURLToPath(new URL("./patch-tests.mjs", import.meta.url));

// A stand-in for pnpm that records how the gate invoked bare Vitest.
function fakePnpm(root) {
  const bin = path.join(root, "bin");
  fs.mkdirSync(bin, { recursive: true });
  const pnpm = path.join(bin, "pnpm");
  fs.writeFileSync(
    pnpm,
    '#!/bin/sh\necho "$* prebuilt=${OPENCLAW_E2E_USE_PREBUILT_DIST:-none}" >> pnpm-runs\n',
  );
  fs.chmodSync(pnpm, 0o755);
  return bin;
}
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

test("an opted-in patch runs through the checkout's own test runner and propagates its failures", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "patch-repo-runner-"));
  try {
    fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    const file = "src/proof.test.ts";
    const config = "src/tsconfig.proof.json";
    fs.writeFileSync(path.join(root, file), "");
    fs.writeFileSync(path.join(root, config), "{}");
    const manifest = path.join(root, "manifest.json");
    fs.writeFileSync(
      manifest,
      JSON.stringify({
        patches: [
          {
            n: 30,
            branch: "fixture",
            featureOrFix: "fixture",
            runner: "repo",
            tests: [file, config],
          },
        ],
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

test("the E2E runtime is prepared once and every opted-in patch with an E2E test reuses it", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "patch-e2e-once-"));
  try {
    for (const dir of ["scripts", "src", "test/vitest"]) {
      fs.mkdirSync(path.join(root, dir), { recursive: true });
    }
    const e2e = ["src/one.e2e.test.ts", "src/two.e2e.test.ts"];
    for (const file of [...e2e, "src/plain.test.ts", "src/bare.e2e.test.ts"]) {
      fs.writeFileSync(path.join(root, file), "");
    }
    const manifest = path.join(root, "manifest.json");
    fs.writeFileSync(
      manifest,
      JSON.stringify({
        patches: [
          { n: 1, branch: "one", featureOrFix: "one", runner: "repo", tests: [e2e[0]] },
          { n: 2, branch: "two", featureOrFix: "two", runner: "repo", tests: [e2e[1]] },
          {
            n: 3,
            branch: "plain",
            featureOrFix: "plain",
            runner: "repo",
            tests: ["src/plain.test.ts"],
          },
          { n: 4, branch: "bare", featureOrFix: "bare", tests: ["src/bare.e2e.test.ts"] },
        ],
      }),
    );
    fs.writeFileSync(path.join(root, "scripts/tsx.mjs"), "");
    fs.writeFileSync(
      path.join(root, "test/vitest/vitest.e2e.global-setup.ts"),
      [
        'import fs from "node:fs";',
        "export default async function setup() {",
        '  fs.appendFileSync("setup-runs", "x");',
        '  if (fs.existsSync("setup-fails")) throw new Error("setup failed");',
        "}",
      ].join("\n"),
    );
    fs.writeFileSync(
      path.join(root, "scripts/test-projects.mts"),
      [
        'import fs from "node:fs";',
        'fs.appendFileSync("runner-runs", JSON.stringify({ file: process.argv[2], prebuilt: process.env.OPENCLAW_E2E_USE_PREBUILT_DIST ?? null }) + "\\n");',
      ].join("\n"),
    );
    const bin = fakePnpm(root);
    const env = {
      ...process.env,
      NUCLEO_MANIFEST: manifest,
      PATH: bin + path.delimiter + process.env.PATH,
    };
    delete env.NODE_TEST_CONTEXT;
    delete env.OPENCLAW_E2E_USE_PREBUILT_DIST;
    const run = () =>
      spawnSync(process.execPath, [runner, root], { encoding: "utf8", timeout: 15_000, env });
    const green = run();
    assert.equal(green.status, 0, green.stdout + green.stderr);
    assert.match(green.stdout, /held=4 of 4/);
    assert.equal(
      fs.readFileSync(path.join(root, "pnpm-runs"), "utf8"),
      "exec vitest run src/bare.e2e.test.ts prebuilt=none\n",
    );
    assert.equal(fs.readFileSync(path.join(root, "setup-runs"), "utf8"), "x");
    const runs = fs
      .readFileSync(path.join(root, "runner-runs"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.deepEqual(runs, [
      { file: e2e[0], prebuilt: "1" },
      { file: e2e[1], prebuilt: "1" },
      { file: "src/plain.test.ts", prebuilt: "1" },
    ]);
    fs.writeFileSync(path.join(root, "setup-fails"), "");
    fs.rmSync(path.join(root, "runner-runs"));
    const red = run();
    assert.equal(red.status, 1, red.stdout + red.stderr);
    assert.match(red.stdout, /E2E runtime preparation failed/);
    assert.match(red.stdout, /held=2 of 4/);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, "runner-runs"), "utf8").trim()), {
      file: "src/plain.test.ts",
      prebuilt: null,
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a patch without a runner keeps bare Vitest and never touches the repository runner", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "patch-bare-default-"));
  try {
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    const files = ["src/proof.test.ts", "src/tsconfig.proof.json"];
    for (const file of files) {
      fs.writeFileSync(path.join(root, file), "");
    }
    const manifest = path.join(root, "manifest.json");
    fs.writeFileSync(
      manifest,
      JSON.stringify({ patches: [{ n: 6, branch: "bare", featureOrFix: "bare", tests: files }] }),
    );
    const bin = fakePnpm(root);
    const env = {
      ...process.env,
      NUCLEO_MANIFEST: manifest,
      PATH: bin + path.delimiter + process.env.PATH,
    };
    delete env.NODE_TEST_CONTEXT;
    const r = spawnSync(process.execPath, [runner, root], {
      encoding: "utf8",
      timeout: 15_000,
      env,
    });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /held=1 of 1/);
    assert.equal(
      fs.readFileSync(path.join(root, "pnpm-runs"), "utf8"),
      "exec vitest run " + files.join(" ") + " prebuilt=none\n",
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
