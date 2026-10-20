import type {
  OpenClawPluginApi,
  OpenClawPluginService,
  OpenClawPluginServiceContext,
} from "openclaw/plugin-sdk/plugin-entry";

export const KEEPER_INTERVAL_MS = 30 * 60_000;
const REFRESH_WITHIN_MS = 60 * 60_000;
const MAX_BACKOFF_MS = 6 * 60 * 60_000;
export type ClaudeAccessCredential = { token: string; expires: number };
export type ClaudeKeeperAdapter = {
  withLock: <T>(run: () => Promise<T>) => Promise<T>;
  read: () => Promise<ClaudeAccessCredential>;
  refresh: (
    credential: ClaudeAccessCredential,
    signal: AbortSignal,
  ) => Promise<"quota" | "auth" | "unknown">;
};

export function createClaudeSubscriptionKeeper(options: {
  profileId: string;
  loadAdapter?: () => Promise<ClaudeKeeperAdapter>;
  now?: () => number;
  platform?: NodeJS.Platform;
}): OpenClawPluginService {
  const now = options.now ?? Date.now;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lifetime: AbortController;
  let pending: Promise<void> | undefined;
  let nextRefreshAt = 0;
  let failures = 0;
  let synced: ClaudeAccessCredential | undefined;
  let producerRefusal: "quota" | "auth" | "unknown" = "unknown";
  const service: OpenClawPluginService = {
    id: "claude-subscription-keeper",
    authTokenImportV1: { provider: "anthropic", profileId: options.profileId },
    reload: {
      configPrefixes: [
        "plugins.entries.anthropic.config.subscriptionKeeper",
        "auth",
        "models.providers.anthropic",
      ],
    },
    start(ctx) {
      lifetime = new AbortController();
      failures = 0;
      nextRefreshAt = 0;
      synced = undefined;
      producerRefusal = "unknown";
      const current = ctx.config.plugins?.entries?.anthropic?.config?.subscriptionKeeper;
      if (
        !current ||
        typeof current !== "object" ||
        !("enabled" in current) ||
        current.enabled !== true
      ) {
        return;
      }
      if (
        ("profileId" in current ? current.profileId : "anthropic:subscription") !==
        options.profileId
      ) {
        ctx.serviceHealth?.reportFailure(
          new Error("Claude keeper target changed; restart the plugin to bind its new profile"),
        );
        return;
      }
      if ((options.platform ?? process.platform) !== "linux") {
        ctx.serviceHealth?.reportFailure(
          new Error(
            "Claude subscription keeper currently requires Linux file credentials; disable it on this platform",
          ),
        );
        return;
      }
      if (!ctx.importAuthTokenV1) {
        ctx.serviceHealth?.reportFailure(
          new Error("Claude subscription keeper requires Gateway token-import V1"),
        );
        return;
      }
      const schedule = (delay: number) => {
        if (lifetime.signal.aborted) {
          return;
        }
        timer = setTimeout(() => {
          timer = undefined;
          pending = tick(ctx).finally(() => {
            pending = undefined;
            schedule(KEEPER_INTERVAL_MS);
          });
        }, delay);
        timer.unref?.();
      };
      const tick = async (context: OpenClawPluginServiceContext) => {
        try {
          const adapter = await (
            options.loadAdapter ??
            (() =>
              import("./subscription-keeper-linux.js").then((m) =>
                m.createLinuxClaudeKeeperAdapter(),
              ))
          )();
          lifetime.signal.throwIfAborted();
          await adapter.withLock(async () => {
            lifetime.signal.throwIfAborted();
            let credential = await adapter.read();
            let refusal: "quota" | "auth" | "unknown" = producerRefusal;
            let refreshFailed = false;
            if (credential.expires - now() <= REFRESH_WITHIN_MS && now() >= nextRefreshAt) {
              const before = credential;
              refusal = await adapter.refresh(before, lifetime.signal);
              producerRefusal = refusal;
              lifetime.signal.throwIfAborted();
              credential = await adapter.read();
              if (credential.token === before.token || credential.expires <= now()) {
                refreshFailed = true;
                failures = Math.min(failures + 1, 5);
                nextRefreshAt =
                  now() + Math.min(KEEPER_INTERVAL_MS * 2 ** (failures - 1), MAX_BACKOFF_MS);
              } else {
                failures = 0;
                nextRefreshAt = 0;
              }
            }
            // CLI inference may refuse quota AFTER successfully refreshing. Sync is independent.
            if (
              credential.expires > now() &&
              (synced?.token !== credential.token || synced.expires !== credential.expires)
            ) {
              lifetime.signal.throwIfAborted();
              await context.importAuthTokenV1!({ ...credential });
              lifetime.signal.throwIfAborted();
              synced = credential;
              if (credential.expires - now() > REFRESH_WITHIN_MS) {
                failures = 0;
                nextRefreshAt = 0;
              }
            }
            if (refreshFailed || credential.expires <= now() || nextRefreshAt > now()) {
              context.serviceHealth?.reportFailure(
                new Error(
                  refusal === "quota"
                    ? "Claude subscription quota refused; credential refresh not confirmed; keeper is backing off (no paid fallback)"
                    : refusal === "auth"
                      ? "Claude subscription login needs attention; keeper is backing off; run claude auth login"
                      : "Claude credential refresh not confirmed; keeper is backing off",
                ),
              );
            } else {
              context.serviceHealth?.clearFailure();
              context.logger.debug?.(
                refusal === "quota"
                  ? "Claude credential synchronized; subscription quota refused (not an authentication failure)"
                  : "Claude subscription credential synchronized",
              );
            }
          });
        } catch {
          if (lifetime.signal.aborted) {
            return;
          }
          failures = Math.min(failures + 1, 5);
          nextRefreshAt =
            now() + Math.min(KEEPER_INTERVAL_MS * 2 ** (failures - 1), MAX_BACKOFF_MS);
          // Never forward CLI output, credentials, paths or raw adapter errors to health/logs.
          ctx.serviceHealth?.reportFailure(
            new Error(
              "Claude subscription keeper could not read, refresh or synchronize its credential; retry is backed off",
            ),
          );
        }
      };
      schedule(0);
    },
    async stop() {
      lifetime?.abort();
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      timer = undefined;
      await pending;
      synced = undefined;
    },
  };
  return service;
}

/** Registration has no timers, credential reads or CLI work unless explicitly enabled. */
export function registerClaudeSubscriptionKeeper(api: OpenClawPluginApi): void {
  const config = api.pluginConfig as
    | { subscriptionKeeper?: { enabled?: boolean; profileId?: string } }
    | undefined;
  if (config?.subscriptionKeeper?.enabled !== true) {
    return;
  }
  api.registerService(
    createClaudeSubscriptionKeeper({
      profileId: config.subscriptionKeeper.profileId ?? "anthropic:subscription",
    }),
  );
}
