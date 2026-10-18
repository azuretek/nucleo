// ★ Núcleo's own version, kept separate from the OpenClaw version we pin.
//
// The product names itself (nucleo/product-name) and carries its own release numbers, while the code
// it runs is a pinned upstream release. Overwriting the OpenClaw version to show ours broke anything
// that compares it: plugin compatibility, build-info and the CLI all read one number. So the pin's
// version stays exactly as upstream shipped it, and this module carries the number people see.
//
// NUCLEO_VERSION is set by the image build (distro/scripts/nucleo.mjs) as <version>-dev.<build>.
// Unset, as in a plain checkout, the product version falls back to the OpenClaw version alone.
export function resolveNucleoVersion(env: NodeJS.ProcessEnv = process.env): string | null {
  const value = env.NUCLEO_VERSION?.trim();
  return value ? value : null;
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
