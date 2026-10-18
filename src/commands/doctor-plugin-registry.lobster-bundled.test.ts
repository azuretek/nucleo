import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolvePluginNpmProjectDir } from "../plugins/install-paths.js";
import { writePersistedInstalledPluginIndex } from "../plugins/installed-plugin-index-store-write.js";
import { readPersistedInstalledPluginIndex } from "../plugins/installed-plugin-index-store.js";
import { resolveRetainedManagedNpmInstallMarkerPath } from "../plugins/managed-npm-retention.js";
import { cleanupTrackedTempDirs, makeTrackedTempDir } from "../plugins/test-helpers/fs-fixtures.js";
import { maybeRepairStaleManagedNpmBundledPlugins } from "./doctor-plugin-registry.js";

// A host that ran upstream OpenClaw has @openclaw/lobster installed from npm. Núcleo ships its
// patched lobster bundled, so the first doctor run on Núcleo must retire that npm copy and its
// install record, or the npm record outranks the bundled copy and the patch never loads.

const tempDirs: string[] = [];
const packageName = "@openclaw/lobster";
const npmVersion = "2026.9.8";

afterEach(() => {
  cleanupTrackedTempDirs(tempDirs);
});

function readLobsterPackageJson(): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join("extensions", "lobster", "package.json"), "utf8"));
}

function writeBundledLobster(bundledRoot: string, packageJson: Record<string, unknown>): void {
  const dir = path.join(bundledRoot, "lobster");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "index.js"), "export default {};\n", "utf8");
  fs.copyFileSync(
    path.join("extensions", "lobster", "openclaw.plugin.json"),
    path.join(dir, "openclaw.plugin.json"),
  );
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify(packageJson), "utf8");
}

async function seedUpstreamNpmLobster(stateDir: string) {
  const npmRoot = resolvePluginNpmProjectDir({ npmDir: path.join(stateDir, "npm"), packageName });
  const packageDir = path.join(npmRoot, "node_modules", "@openclaw", "lobster");
  fs.mkdirSync(packageDir, { recursive: true });
  fs.writeFileSync(
    path.join(npmRoot, "package.json"),
    JSON.stringify({ dependencies: { [packageName]: npmVersion } }),
    "utf8",
  );
  fs.writeFileSync(
    path.join(packageDir, "package.json"),
    JSON.stringify({ name: packageName, version: npmVersion, openclaw: { extensions: ["."] } }),
    "utf8",
  );
  fs.copyFileSync(
    path.join("extensions", "lobster", "openclaw.plugin.json"),
    path.join(packageDir, "openclaw.plugin.json"),
  );
  const installRecords = {
    lobster: {
      source: "npm" as const,
      spec: packageName,
      installPath: packageDir,
      version: npmVersion,
      resolvedName: packageName,
      resolvedVersion: npmVersion,
      resolvedSpec: `${packageName}@${npmVersion}`,
    },
  };
  await writePersistedInstalledPluginIndex(
    {
      version: 1,
      hostContractVersion: "2026.4.25",
      compatRegistryVersion: "compat-v1",
      migrationVersion: 1,
      policyHash: "policy-v1",
      generatedAtMs: 1777118400000,
      installRecords,
      plugins: [],
      diagnostics: [],
    },
    { stateDir },
  );
  return { packageDir, installRecords };
}

function sweep(stateDir: string, bundledRoot: string) {
  return maybeRepairStaleManagedNpmBundledPlugins({
    stateDir,
    candidates: [],
    env: {
      OPENCLAW_BUNDLED_PLUGINS_DIR: bundledRoot,
      OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR: "1",
      OPENCLAW_VERSION: "2026.9.8",
      VITEST: "true",
    },
    config: { plugins: { allow: ["lobster"], entries: { lobster: { enabled: true } } } },
    prompter: { shouldRepair: true },
  });
}

describe("Núcleo bundled lobster replaces an upstream npm install", () => {
  it("declares lobster as bundled dist so doctor owns it", () => {
    expect(readLobsterPackageJson()).toMatchObject({
      name: packageName,
      openclaw: { build: { bundledDist: true } },
    });
  });

  it("retires the npm package and its install record on the first doctor run", async () => {
    const stateDir = makeTrackedTempDir("nucleo-lobster-bundled-state", tempDirs);
    const bundledRoot = makeTrackedTempDir("nucleo-lobster-bundled-root", tempDirs);
    writeBundledLobster(bundledRoot, readLobsterPackageJson());
    const { packageDir } = await seedUpstreamNpmLobster(stateDir);

    const result = sweep(stateDir, bundledRoot);

    expect(result).not.toBeNull();
    expect(fs.existsSync(packageDir)).toBe(false);
    expect(
      (await readPersistedInstalledPluginIndex({ stateDir }))?.installRecords,
    ).not.toHaveProperty("lobster");
  });

  it("keeps the npm install when lobster is not bundled dist", async () => {
    const stateDir = makeTrackedTempDir("nucleo-lobster-external-state", tempDirs);
    const bundledRoot = makeTrackedTempDir("nucleo-lobster-external-root", tempDirs);
    const upstream = readLobsterPackageJson() as { openclaw: { build: Record<string, unknown> } };
    const { bundledDist: _bundledDist, ...build } = upstream.openclaw.build;
    writeBundledLobster(bundledRoot, { ...upstream, openclaw: { ...upstream.openclaw, build } });
    const { packageDir, installRecords } = await seedUpstreamNpmLobster(stateDir);

    expect(sweep(stateDir, bundledRoot)).toBeNull();
    expect(fs.existsSync(packageDir)).toBe(true);
    expect((await readPersistedInstalledPluginIndex({ stateDir }))?.installRecords).toEqual(
      installRecords,
    );
  });

  it("keeps an npm install the operator retained", async () => {
    const stateDir = makeTrackedTempDir("nucleo-lobster-retained-state", tempDirs);
    const bundledRoot = makeTrackedTempDir("nucleo-lobster-retained-root", tempDirs);
    writeBundledLobster(bundledRoot, readLobsterPackageJson());
    const { packageDir } = await seedUpstreamNpmLobster(stateDir);
    const marker = resolveRetainedManagedNpmInstallMarkerPath(packageDir);
    fs.mkdirSync(path.dirname(marker), { recursive: true });
    fs.writeFileSync(marker, "{}\n", "utf8");

    expect(sweep(stateDir, bundledRoot)).toBeNull();
    expect(fs.existsSync(packageDir)).toBe(true);
  });
});
