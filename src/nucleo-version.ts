// ★ Núcleo's own version, kept separate from the OpenClaw version we pin.
//
// The product names itself (nucleo/product-name) and carries its own release numbers, while the code
// it runs is a pinned upstream release. Overwriting the OpenClaw version to show ours broke anything
// that compares it: plugin compatibility, build-info and the CLI all read one number. So the pin's
// version stays exactly as upstream shipped it, and this module carries the number people see.
//
// Prefer NUCLEO_VERSION, then the separate product version when build-info carries it.
// Neither source changes the OpenClaw version used for plugin compatibility.
import { createRequire } from "node:module";

export function readNucleoVersionFromBuildInfo(moduleUrl: string): string | null {
  const require = createRequire(moduleUrl);
  for (const candidate of ["./build-info.json", "../build-info.json", "../../build-info.json"]) {
    try {
      const parsed = require(candidate) as { nucleoVersion?: unknown } | null;
      const value = typeof parsed?.nucleoVersion === "string" ? parsed.nucleoVersion.trim() : "";
      if (value) {
        return value;
      }
    } catch {
      // Missing or unreadable build metadata is normal in a source checkout.
    }
  }
  return null;
}

export function resolveNucleoVersion(
  env: NodeJS.ProcessEnv = process.env,
  moduleUrl: string = import.meta.url,
  readBuildInfo: (url: string) => string | null = readNucleoVersionFromBuildInfo,
): string | null {
  return env.NUCLEO_VERSION?.trim() || readBuildInfo(moduleUrl);
}

/**
 * The version string the product shows: "Núcleo <nucleo> (OpenClaw <openclaw>)" when this build
 * carries its own number, otherwise "Núcleo <openclaw>".
 */
export function formatProductVersion(
  openclawVersion: string,
  nucleoVersion: string | null = resolveNucleoVersion(),
): string {
  return nucleoVersion
    ? `Núcleo ${nucleoVersion} (OpenClaw ${openclawVersion})`
    : `Núcleo ${openclawVersion}`;
}
