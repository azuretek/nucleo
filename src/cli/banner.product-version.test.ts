import { stripVTControlCharacters } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { formatCliBannerLine } from "./banner.js";

const stamp = vi.hoisted(() => ({ value: "0.0.1-dev.141" as string | null }));

vi.mock("../nucleo-version.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../nucleo-version.js")>();
  return {
    ...actual,
    resolveNucleoVersion: (env: NodeJS.ProcessEnv) =>
      actual.resolveNucleoVersion(env, "file:///app/dist/banner.js", () => stamp.value),
  };
});

afterEach(() => {
  stamp.value = "0.0.1-dev.141";
});

describe("Gateway banner product metadata handoff", () => {
  it.each([false, true])(
    "uses the stamped product version without an override (rich=%s)",
    (richTty) => {
      const line = formatCliBannerLine("2026.9.8", {
        env: {},
        commit: "abc1234",
        platform: "linux",
        isTty: false,
        richTty,
        mode: "off",
      });
      expect(stripVTControlCharacters(line)).toBe(
        "Núcleo 0.0.1-dev.141 (OpenClaw 2026.9.8) (abc1234)",
      );
    },
  );

  it.each([
    ["   ", "0.0.1-dev.141"],
    [" 9.8.7-override ", "9.8.7-override"],
  ])("retains resolver precedence for override %j", (override, expected) => {
    expect(
      formatCliBannerLine("2026.9.8", {
        env: { NUCLEO_VERSION: override },
        commit: "abc1234",
        platform: "linux",
        isTty: false,
        richTty: false,
        mode: "off",
      }),
    ).toBe(`Núcleo ${expected} (OpenClaw 2026.9.8) (abc1234)`);
  });

  it("keeps the source-checkout display when neither product source exists", () => {
    stamp.value = null;
    expect(
      formatCliBannerLine("2026.9.8", {
        env: {},
        commit: "abc1234",
        platform: "linux",
        isTty: false,
        richTty: false,
        mode: "off",
      }),
    ).toBe("Núcleo 2026.9.8 (abc1234)");
  });
});
