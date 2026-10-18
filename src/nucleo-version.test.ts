import { describe, expect, it } from "vitest";
import { formatProductVersion, resolveNucleoVersion } from "./nucleo-version.js";

describe("nucleo-version", () => {
  it("is absent in a plain checkout", () => {
    expect(resolveNucleoVersion({})).toBeNull();
    expect(resolveNucleoVersion({ NUCLEO_VERSION: "   " })).toBeNull();
  });

  it("reads the number the image build sets", () => {
    expect(resolveNucleoVersion({ NUCLEO_VERSION: "0.0.1-dev.103" })).toBe("0.0.1-dev.103");
  });

  it("shows both numbers in a Núcleo build, and the pin's alone otherwise", () => {
    expect(formatProductVersion("2026.9.8", "0.0.1-dev.103")).toBe(
      "Núcleo 0.0.1-dev.103 (OpenClaw 2026.9.8)",
    );
    expect(formatProductVersion("2026.9.8", null)).toBe("Núcleo 2026.9.8");
  });
});
