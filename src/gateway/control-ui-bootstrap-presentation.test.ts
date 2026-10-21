import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => vi.unstubAllEnvs());
import { resolveControlUiBootstrapPresentation } from "./control-ui-bootstrap-presentation.js";

describe("Control UI model defaults bootstrap", () => {
  it("publishes the product display without replacing the compatibility version", () => {
    vi.stubEnv("NUCLEO_VERSION", " 0.0.1-dev.104 ");
    const presentation = resolveControlUiBootstrapPresentation(undefined, "2026.9.8");
    expect(presentation.productVersion).toBe("Núcleo 0.0.1-dev.104 (OpenClaw 2026.9.8)");
  });
  it.each([undefined, "last-used", "configured"] as const)(
    "projects %s without model restrictions",
    (newSessionModelDefaults) => {
      const result = resolveControlUiBootstrapPresentation({
        gateway: { controlUi: { newSessionModelDefaults } },
      });
      expect(result.newSessionModelDefaults).toBe(newSessionModelDefaults ?? "last-used");
      expect(result).not.toHaveProperty("modelSelectionPolicy");
    },
  );
});
