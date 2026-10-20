import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AuthProfileStore } from "../agents/auth-profiles/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { GatewayRequestContext } from "../gateway/server-methods/types.js";
import { createLazyPluginRuntime } from "./loader-module-runtime.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import { markPluginRegistryActive, revokePluginRecord } from "./registry-lifecycle.js";
import { bindPluginRegistryRuntime } from "./registry-runtime-binding.js";
import {
  bindGatewayContextResolver,
  getGatewayContextLifetime,
} from "./runtime/gateway-request-scope.js";
import type { PluginRuntime } from "./runtime/types.js";
import { startPluginServices, type PluginServicesHandle } from "./services.js";
import { createPluginRecord } from "./status.test-helpers.js";
import type { OpenClawPluginServiceContext, ProviderPlugin } from "./types.js";

const mocks = vi.hoisted(() => ({ update: vi.fn(), publish: vi.fn(), redact: vi.fn() }));
vi.mock("../agents/auth-profiles/store-runtime.js", () => ({
  updateAuthProfileStoreWithLock: mocks.update,
}));
vi.mock("../gateway/model-auth-refresh.js", () => ({
  refreshModelAuthStateAfterMutation: mocks.publish,
}));
vi.mock("../logging/secret-redaction-registry.js", () => ({
  registerSecretValueForRedaction: mocks.redact,
}));
const handles: PluginServicesHandle[] = [];
let store: AuthProfileStore;
let admission: Promise<void>;
beforeEach(() => {
  vi.clearAllMocks();
  admission = Promise.resolve();
  store = {
    version: 1,
    profiles: {},
    usageStats: { "anthropic:subscription": { cooldownUntil: 9_999_999_999_999, errorCount: 2 } },
  };
  mocks.publish.mockResolvedValue(undefined);
  mocks.update.mockImplementation(async ({ updater }) => {
    await admission;
    updater(store);
    return store;
  });
});
afterEach(async () => {
  for (const handle of handles.splice(0)) {
    await handle.stop();
  }
});
async function fixture(target = { provider: "anthropic", profileId: "anthropic:subscription" }) {
  const config: OpenClawConfig = {
    auth: {
      profiles: { "anthropic:subscription": { provider: "anthropic", mode: "token" } },
      order: { anthropic: ["anthropic:subscription"] },
    },
  };
  const registry = createEmptyPluginRegistry();
  const record = createPluginRecord({ id: "anthropic" });
  registry.plugins.push(record);
  registry.providers.push({
    pluginId: record.id,
    source: record.source,
    provider: { id: "anthropic" } as ProviderPlugin,
  });
  const gateway = { getRuntimeConfig: () => config } as GatewayRequestContext;
  const resolver = () => gateway;
  const subagent = {} as PluginRuntime["subagent"];
  bindGatewayContextResolver(subagent, resolver);
  bindPluginRegistryRuntime(registry, createLazyPluginRuntime({ runtimeOptions: { subagent } }));
  markPluginRegistryActive(registry);
  let serviceContext: OpenClawPluginServiceContext | undefined;
  registry.services.push({
    id: "keeper",
    pluginId: record.id,
    source: record.source,
    origin: record.origin,
    service: {
      id: "keeper",
      authTokenImportV1: target,
      start: (ctx) => {
        serviceContext = ctx;
      },
    },
  });
  const handle = await startPluginServices({ registry, config });
  handles.push(handle);
  if (!serviceContext?.importAuthTokenV1) {
    throw new Error("Gateway did not issue the import capability");
  }
  return {
    importToken: serviceContext.importAuthTokenV1,
    config,
    handle,
    shutdown: () => getGatewayContextLifetime(resolver).abort(),
    revoke: () => revokePluginRecord(registry, record),
  };
}
const expires = Date.now() + 8 * 60 * 60_000;
const credential = () => ({ token: "synthetic-subscription-access", expires });
it("the service entry point commits access-only material, preserves quota cooldown, and publishes", async () => {
  const f = await fixture();
  const cooldown = structuredClone(store.usageStats);
  await f.importToken(credential());
  expect(store.profiles["anthropic:subscription"]).toEqual({
    type: "token",
    provider: "anthropic",
    ...credential(),
  });
  expect(store.usageStats).toEqual(cooldown);
  expect(mocks.redact).toHaveBeenCalledWith("synthetic-subscription-access");
  expect(mocks.publish).toHaveBeenCalledOnce();
  expect(mocks.update).toHaveBeenCalledWith(
    expect.objectContaining({
      sharedStoreWrite: true,
      saveOptions: { filterExternalAuthProfiles: false, syncExternalCli: false },
    }),
  );
});
it.each(["stop", "shutdown", "revoke", "config", "provider-key"] as const)(
  "rejects %s while waiting for writer admission and never publishes",
  async (operation) => {
    const f = await fixture();
    let release!: () => void;
    admission = new Promise<void>((resolve) => {
      release = resolve;
    });
    const result = f.importToken(credential());
    const rejected = expect(result).rejects.toThrow();
    if (operation === "stop") {
      await f.handle.stop();
    }
    if (operation === "shutdown") {
      f.shutdown();
    }
    if (operation === "revoke") {
      f.revoke();
    }
    if (operation === "config") {
      f.config.auth!.order!.anthropic = ["anthropic:paid"];
    }
    if (operation === "provider-key") {
      f.config.models = {
        providers: {
          anthropic: {
            baseUrl: "https://example.invalid",
            models: [],
            apiKey: "synthetic-paid-override",
          },
        },
      };
    }
    release();
    await rejected;
    expect(store.profiles).toEqual({});
    expect(mocks.publish).not.toHaveBeenCalled();
  },
);
it.each([
  { provider: "openai", profileId: "openai:subscription" },
  { provider: "anthropic", profileId: "anthropic:other" },
  { provider: "anthropic", profileId: "openai:subscription" },
])("rejects an undeclared provider or unconfigured profile: %j", async (target) => {
  const f = await fixture(target);
  await expect(f.importToken(credential())).rejects.toThrow();
  expect(mocks.update).not.toHaveBeenCalled();
});
it.each(["api_key", "oauth"] as const)(
  "rejects a concurrent %s target at actual commit",
  async (type) => {
    const f = await fixture();
    store.profiles["anthropic:subscription"] =
      type === "api_key"
        ? { type, provider: "anthropic", key: "synthetic-paid-key" }
        : {
            type,
            provider: "anthropic",
            access: "synthetic-access",
            refresh: "synthetic-refresh",
            expires: Date.now() + 999_999,
          };
    const before = structuredClone(store.profiles);
    await expect(f.importToken(credential())).rejects.toThrow("credential type");
    expect(store.profiles).toEqual(before);
    expect(mocks.publish).not.toHaveBeenCalled();
  },
);
it("refuses expired tokens, extra credential types, and paid fallback configuration", async () => {
  const f = await fixture();
  await expect(f.importToken({ token: "synthetic", expires: 1 })).rejects.toThrow("unexpired");
  await expect(
    f.importToken({ ...credential(), type: "api_key" } as ReturnType<typeof credential>),
  ).rejects.toThrow("unexpired");
  f.config.auth!.order!.anthropic.push("anthropic:paid");
  await expect(f.importToken(credential())).rejects.toThrow("exclusive auth order");
  expect(mocks.update).not.toHaveBeenCalled();
});

it("rejects provider-level paid-key shadowing before writer admission", async () => {
  const f = await fixture();
  f.config.models = {
    providers: {
      anthropic: {
        baseUrl: "https://example.invalid",
        models: [],
        apiKey: "synthetic-paid-override",
      },
    },
  };
  await expect(f.importToken(credential())).rejects.toThrow();
  expect(mocks.update).not.toHaveBeenCalled();
});
