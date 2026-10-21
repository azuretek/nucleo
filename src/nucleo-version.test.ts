import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../test/helpers/temp-dir.js";
import {
  formatProductVersion,
  readNucleoVersionFromBuildInfo,
  resolveNucleoVersion,
} from "./nucleo-version.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const moduleUrl = import.meta.url;

describe("nucleo-version", () => {
  it("is absent when neither source carries a product version", () => {
    expect(resolveNucleoVersion({}, moduleUrl, () => null)).toBeNull();
    expect(resolveNucleoVersion({ NUCLEO_VERSION: "   " }, moduleUrl, () => null)).toBeNull();
  });

  it("prefers the trimmed environment override without reading metadata", () => {
    const read = vi.fn(() => "0.0.1-dev.104");
    expect(resolveNucleoVersion({ NUCLEO_VERSION: " 0.0.1-dev.105 " }, moduleUrl, read)).toBe(
      "0.0.1-dev.105",
    );
    expect(read).not.toHaveBeenCalled();
  });

  it.each([{}, { NUCLEO_VERSION: "   " }])(
    "uses build-info without a usable override: %j",
    (env) => {
      const read = vi.fn(() => "0.0.1-dev.104");
      expect(resolveNucleoVersion(env, moduleUrl, read)).toBe("0.0.1-dev.104");
      expect(read).toHaveBeenCalledWith(moduleUrl);
    },
  );

  it.each(["entry.js", "chunks/version.js", "chunks/shared/version.js"])(
    "reads product metadata relative to packaged %s",
    (entry) => {
      const root = tempDirs.make("nucleo-version-");
      const dist = path.join(root, "dist");
      fs.mkdirSync(dist);
      fs.writeFileSync(
        path.join(dist, "build-info.json"),
        JSON.stringify({ version: "2026.9.8", nucleoVersion: " 0.0.1-dev.104 " }),
      );
      const url = pathToFileURL(path.join(dist, entry)).href;
      expect(resolveNucleoVersion({}, url)).toBe("0.0.1-dev.104");
      expect(formatProductVersion("2026.9.8", resolveNucleoVersion({}, url))).toBe(
        "Núcleo 0.0.1-dev.104 (OpenClaw 2026.9.8)",
      );
    },
  );

  it.each([undefined, "{}", "null", "not json", '{"nucleoVersion":42}', '{"nucleoVersion":"   "}'])(
    "ignores missing or unusable metadata: %j",
    (raw) => {
      const root = tempDirs.make("nucleo-version-");
      if (raw !== undefined) {
        fs.writeFileSync(path.join(root, "build-info.json"), raw);
      }
      expect(
        readNucleoVersionFromBuildInfo(pathToFileURL(path.join(root, "entry.js")).href),
      ).toBeNull();
    },
  );

  it("shows both numbers in a Núcleo build, and the pin's alone otherwise", () => {
    expect(formatProductVersion("2026.9.8", "0.0.1-dev.103")).toBe(
      "Núcleo 0.0.1-dev.103 (OpenClaw 2026.9.8)",
    );
    expect(formatProductVersion("2026.9.8", null)).toBe("Núcleo 2026.9.8");
  });
});
