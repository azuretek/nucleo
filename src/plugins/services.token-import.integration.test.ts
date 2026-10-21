import { expect, it } from "vitest";
import { loadPersistedSharedAuthProfileStore } from "../agents/auth-profiles/persisted.js";
import { getPreparedModelRuntimeAuthStore } from "../agents/prepared-model-runtime-auth.js";
import {
  getPreparedModelRuntimeSnapshot,
  refreshPreparedModelRuntimeSnapshots,
} from "../agents/prepared-model-runtime.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createServiceTokenImporterV1 } from "./service-token-import.js";

it("publishes a real shared-store import to every configured agent", async () => {
  const state = await createOpenClawTestState({ prefix: "keeper-publication-", applyEnv: true });
  try {
    const config: OpenClawConfig = {
      agents: {
        list: [
          { id: "first", agentDir: state.agentDir("first") },
          { id: "second", agentDir: state.agentDir("second") },
        ],
      },
      plugins: { enabled: false },
      auth: {
        profiles: { "anthropic:subscription": { provider: "anthropic", mode: "token" } },
        order: { anthropic: ["anthropic:subscription"] },
      },
    };
    await state.writeConfig(config);
    const inputs = ["first", "second"].map((agentId) => ({
      config,
      agentId,
      agentDir: state.agentDir(agentId),
    }));
    await refreshPreparedModelRuntimeSnapshots(config, {
      gatewayLifecycle: true,
      catalogMode: "static",
    });
    const importToken = createServiceTokenImporterV1({
      target: { provider: "anthropic", profileId: "anthropic:subscription" },
      ownsProvider: (provider) => provider === "anthropic",
      assertCurrent: () => {},
      getConfig: () => config,
      stateDir: state.stateDir,
    });
    const credential = { token: "synthetic-disk-subscription", expires: Date.now() + 3_600_000 };
    await importToken(credential);
    expect(
      loadPersistedSharedAuthProfileStore(state.env)?.profiles["anthropic:subscription"],
    ).toEqual({
      type: "token",
      provider: "anthropic",
      ...credential,
    });
    for (const input of inputs) {
      const snapshot = getPreparedModelRuntimeSnapshot(input);
      expect(snapshot).toBeDefined();
      if (!snapshot) {
        throw new Error("Configured agent has no published runtime snapshot");
      }
      expect(
        getPreparedModelRuntimeAuthStore(snapshot)?.profiles["anthropic:subscription"],
      ).toEqual({
        type: "token",
        provider: "anthropic",
        ...credential,
      });
    }
  } finally {
    await state.cleanup();
  }
});
