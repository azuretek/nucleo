import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const checkout = fileURLToPath(new URL("../../", import.meta.url));
test("preparation passes the plugin timeout to the declaration worker", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "distro-preparation-"));
  const write = (file, text) => {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
  };
  try {
    for (const file of ["scripts", "packages/normalization-core"]) {
      fs.cpSync(path.join(checkout, file), path.join(root, file), { recursive: true });
    }
    write("package.json", '{"name":"openclaw","type":"module"}');
    write("pnpm-workspace.yaml", "packages: []\n");
    const require = createRequire(path.join(checkout, "package.json"));
    const nativeRequire = createRequire(require.resolve("typescript/package.json"));
    const platform = `@typescript/typescript-${process.platform}-${process.arch}`;
    for (const [name, owner] of [
      ["typescript", require],
      [platform, nativeRequire],
    ]) {
      const target = path.join(root, "node_modules", name);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.cpSync(path.dirname(owner.resolve(name + "/package.json")), target, { recursive: true });
    }
    const fsSafe = path.join(root, "node_modules/@openclaw/fs-safe");
    fs.mkdirSync(path.dirname(fsSafe), { recursive: true });
    fs.symlinkSync(
      fs.realpathSync(path.join(checkout, "node_modules/@openclaw/fs-safe")),
      fsSafe,
      "dir",
    );
    write("scripts/lib/plugin-sdk-entrypoints.json", '["core"]');
    write("tsconfig.json", '{"compilerOptions":{"types":[]}}');
    write("packages/plugin-sdk/tsconfig.json", '{"files":["../../src/plugin-sdk/core.ts"]}');
    write("src/plugin-sdk/core.ts", "export const value = 1;");
    for (const [id, entry] of [
      ["qa-channel", "api"],
      ["memory-core", "api"],
      ["matrix", "test-api"],
      ["discord", "api"],
      ["slack", "test-api"],
      ["telegram", "api"],
      ["whatsapp", "api"],
    ]) {
      write("extensions/" + id + "/tsconfig.json", JSON.stringify({ files: [entry + ".ts"] }));
      write("extensions/" + id + "/" + entry + ".ts", "export const value = 1;");
    }
    // Controlled compiler boundary: emit a complete SDK receipt, then keep the
    // plugin worker alive. The real preparer must apply its configured deadline.
    write(
      "scripts/compile-extension-boundary.mts",
      [
        'import fs from "node:fs"; import path from "node:path";',
        "const r = JSON.parse(process.argv[2]);",
        'if (r.configFile.startsWith("extensions/")) { setInterval(() => {}, 1000); } else {',
        'for (const f of [r.inputReceipt, r.compilerOptions.outDir + "/src/plugin-sdk/core.d.ts"]) {',
        'fs.mkdirSync(path.dirname(f), {recursive:true}); fs.writeFileSync(f, JSON.stringify({inputs:["src/plugin-sdk/core.ts"]})); console.log("TSFILE: " + path.resolve(f)); } }',
      ].join("\n"),
    );
    const result = spawnSync(
      process.execPath,
      [path.join(root, "scripts/prepare-extension-package-boundary-artifacts.mts"), "--mode=all"],
      {
        cwd: root,
        encoding: "utf8",
        timeout: 15_000,
        env: { ...process.env, OPENCLAW_BOUNDARY_DTS_TIMEOUT_MS: "25" },
      },
    );
    assert.equal(result.error, undefined, String(result.error));
    assert.notEqual(result.status, 0);
    assert.match(result.stdout + result.stderr, /boundary dts timed out after 25ms/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
