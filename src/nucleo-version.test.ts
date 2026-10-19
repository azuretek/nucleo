import { describe, expect, it } from "vitest";
import { formatProductVersion, resolveNucleoVersion } from "./nucleo-version.js";

const noBuildInfo = () => null;

describe("nucleo-version", () => {
  it("is absent when neither the env var nor build-info carries a number", () => {
    expect(resolveNucleoVersion({}, "file:///app/dist/x.js", noBuildInfo)).toBeNull();
    expect(
      resolveNucleoVersion({ NUCLEO_VERSION: "   " }, "file:///app/dist/x.js", noBuildInfo),
    ).toBeNull();
  });

  it("reads the number the image build sets", () => {
    expect(resolveNucleoVersion({ NUCLEO_VERSION: "0.0.1-dev.103" })).toBe("0.0.1-dev.103");
  });

  it("falls back to build-info, so a build without the env var still names itself", () => {
    expect(resolveNucleoVersion({}, "file:///app/dist/x.js", () => "0.0.1-dev.104")).toBe(
      "0.0.1-dev.104",
    );
  });

  it("prefers the env var over build-info", () => {
    expect(
      resolveNucleoVersion(
        { NUCLEO_VERSION: "0.0.1-dev.103" },
        "file:///app/dist/x.js",
        () => "9.9.9",
      ),
    ).toBe("0.0.1-dev.103");
  });

  it("shows both numbers in a Núcleo build, and the pin's alone otherwise", () => {
    expect(formatProductVersion("2026.9.8", "0.0.1-dev.103")).toBe(
      "Núcleo 0.0.1-dev.103 (OpenClaw 2026.9.8)",
    );
    expect(formatProductVersion("2026.9.8", null)).toBe("Núcleo 2026.9.8");
  });
});
