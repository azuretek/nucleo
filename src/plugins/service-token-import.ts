import type { OpenClawConfig } from "../config/types.openclaw.js";
import { registerSecretValueForRedaction } from "../logging/secret-redaction-registry.js";
import type { PluginRuntimeCapabilityLease } from "./capability-lease.js";
import { getPluginInstance } from "./plugin-instance-scope.js";
import { getPluginRecordRegistry, isPluginRecordActive } from "./registry-lifecycle.js";
import { getPluginRegistryRuntime } from "./registry-runtime-binding.js";
import type { PluginRecord, PluginRegistry } from "./registry-types.js";
import {
  getCanonicalGatewayContextResolver,
  getGatewayContextLifetime,
  getGatewayContextResolver,
} from "./runtime/gateway-request-scope.js";
import type { OpenClawPluginServiceContext } from "./types.js";

type Target = { provider: string; profileId: string };

/** No caller-selected profile or provider can cross this capability. */
export function createServiceTokenImporterV1(params: {
  target: Target;
  ownsProvider: (provider: string) => boolean;
  assertCurrent: () => void;
  getConfig: () => OpenClawConfig;
  stateDir: string;
}): NonNullable<OpenClawPluginServiceContext["importAuthTokenV1"]> {
  const { provider, profileId } = params.target;
  const assertCurrent = () => {
    params.assertCurrent();
    const config = params.getConfig();
    const profile = config.auth?.profiles?.[profileId];
    const order = config.auth?.order?.[provider];
    if (
      !params.ownsProvider(provider) ||
      !profileId.startsWith(provider + ":") ||
      profile?.provider !== provider ||
      profile.mode !== "token" ||
      config.models?.providers?.[provider]?.apiKey !== undefined ||
      order?.length !== 1 ||
      order[0] !== profileId
    ) {
      throw new Error(
        "Service token import requires its owned token profile and exclusive auth order",
      );
    }
  };
  return async (credential) => {
    assertCurrent();
    if (
      typeof credential.token !== "string" ||
      !credential.token.trim() ||
      !Number.isFinite(credential.expires) ||
      credential.expires <= Date.now() ||
      credential.expires > 8640000000000000 ||
      Object.keys(credential).some((key) => key !== "token" && key !== "expires")
    ) {
      throw new Error("Service token import requires an unexpired access token");
    }
    const incoming = Object.freeze({ ...credential });
    registerSecretValueForRedaction(incoming.token);
    const [{ updateAuthProfileStoreWithLock }, { refreshModelAuthStateAfterMutation }] =
      await Promise.all([
        import("../agents/auth-profiles/store-runtime.js"),
        import("../gateway/model-auth-refresh.js"),
      ]);
    assertCurrent();
    // The owner invokes updater after awaited writer admission, inside its transaction.
    // Do not use compatibility upserts: they discard the authority guard.
    const result = await updateAuthProfileStoreWithLock({
      stateDir: params.stateDir,
      sharedStoreWrite: true,
      saveOptions: { filterExternalAuthProfiles: false, syncExternalCli: false },
      updater: (store) => {
        assertCurrent();
        if (incoming.expires <= Date.now()) {
          throw new Error("Service access token expired while waiting for admission");
        }
        const current = store.profiles[profileId];
        if (current && (current.provider !== provider || current.type !== "token")) {
          throw new Error("Service token import target changed provider or credential type");
        }
        if (
          current?.type === "token" &&
          current.token === incoming.token &&
          current.expires === incoming.expires
        ) {
          return false;
        }
        store.profiles[profileId] = { type: "token", provider, ...incoming };
        // usageStats belongs to quota/failure accounting, not credential synchronization.
        return true;
      },
    });
    if (!result) {
      throw new Error("Service token import could not acquire the auth writer");
    }
    // Once committed, publication is settlement, not a new credential mutation.
    // Do not strand accepted writes when service shutdown begins after commit.
    await refreshModelAuthStateAfterMutation(params.getConfig);
  };
}

/** Bind import authority to one service and one canonical Gateway generation. */
export function createPluginServiceTokenImporterV1(options: {
  target: Target;
  registry: PluginRegistry;
  record: PluginRecord;
  lease: PluginRuntimeCapabilityLease;
  isStopping: () => boolean;
  stateDir: string;
}): OpenClawPluginServiceContext["importAuthTokenV1"] {
  const { registry, record, lease } = options;
  const runtime = getPluginRegistryRuntime(registry);
  const resolver = runtime && getGatewayContextResolver(runtime);
  const gatewayOwner = resolver && getCanonicalGatewayContextResolver(resolver);
  if (!runtime || !resolver || !gatewayOwner) {
    return undefined;
  }
  const instance = getPluginInstance(record);
  return createServiceTokenImporterV1({
    target: { ...options.target },
    stateDir: options.stateDir,
    ownsProvider: (provider) =>
      getPluginRecordRegistry(registry, record).providers.some(
        (providerEntry) =>
          providerEntry.pluginId === record.id && providerEntry.provider.id === provider,
      ),
    getConfig: () => {
      const context = resolver();
      if (!context) {
        throw new Error("Service token import Gateway unavailable");
      }
      return context.getRuntimeConfig();
    },
    assertCurrent: () => {
      lease.assertActive("token import");
      if (
        getPluginRegistryRuntime(registry) !== runtime ||
        getGatewayContextResolver(runtime) !== resolver ||
        options.isStopping() ||
        !isPluginRecordActive(registry, record)
      ) {
        throw new Error("Service token import authority is no longer active");
      }
      getGatewayContextLifetime(gatewayOwner).signal.throwIfAborted();
      instance?.lifecycle.signal.throwIfAborted();
    },
  });
}
