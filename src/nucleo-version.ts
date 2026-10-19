// ★ Núcleo's own version, kept separate from the OpenClaw version we pin.
//
// The product names itself (nucleo/product-name) and carries its own release numbers, while the code
// it runs is a pinned upstream release. Overwriting the OpenClaw version to show ours broke anything
// that compares it: plugin compatibility, build-info and the CLI all read one number. So the pin's
// version stays exactly as upstream shipped it, and this module carries the number people see.
//
// The number reaches a running build two ways: NUCLEO_VERSION from the image build, and nucleoVersion
// in dist/build-info.json, which the image stamps. The env var alone is not enough, because a gateway
// started from a plain checkout, or from an image built before that ENV existed, has no env var and
// would silently fall back to showing the OpenClaw version as if it were ours.
import { createRequire } from "node:module";

const BUILD_INFO_CANDIDATES = [
  "../build-info.json",
  "../../build-info.json",
  "./build-info.json",
] as const;

export function readNucleoVersionFromBuildInfo(moduleUrl: string): string | null {
  try {
    const require = createRequire(moduleUrl);
    for (const candidate of BUILD_INFO_CANDIDATES) {
      try {
        const parsed = require(candidate) as { nucleoVersion?: unknown };
        const value = typeof parsed.nucleoVersion === "string" ? parsed.nucleoVersion.trim() : "";
        if (value) {
          return value;
        }
      } catch {
        // ignore missing or unreadable candidate
      }
    }
    return null;
  } catch {
    return null;
  }
}

export function resolveNucleoVersion(
  env: NodeJS.ProcessEnv = process.env,
  moduleUrl: string = import.meta.url,
  readBuildInfo: (url: string) => string | null = readNucleoVersionFromBuildInfo,
): string | null {
  const value = env.NUCLEO_VERSION?.trim();
  if (value) {
    return value;
  }
  return readBuildInfo(moduleUrl);
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
