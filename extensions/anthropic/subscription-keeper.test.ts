import type {
  OpenClawPluginService,
  OpenClawPluginServiceContext,
} from "openclaw/plugin-sdk/plugin-entry";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { registerAnthropicPlugin } from "./register.runtime.js";
import {
  createClaudeSubscriptionKeeper,
  KEEPER_INTERVAL_MS,
  type ClaudeKeeperAdapter,
} from "./subscription-keeper.js";

vi.mock("./session-catalog-executable.js", () => ({
  resolveClaudeTerminalExecutable: () => ({ executable: "claude" }),
}));
const services: Array<{ service: OpenClawPluginService; ctx: OpenClawPluginServiceContext }> = [];
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_800_000_000_000);
});
afterEach(async () => {
  for (const { service, ctx } of services.splice(0)) {
    await service.stop?.(ctx);
  }
  vi.useRealTimers();
});
function fixture(options: { platform?: NodeJS.Platform; adapter?: ClaudeKeeperAdapter } = {}) {
  let credential = { token: "synthetic-access-before", expires: Date.now() + 30 * 60_000 };
  const refresh = vi.fn<ClaudeKeeperAdapter["refresh"]>(async () => {
    credential = { token: "synthetic-access-after", expires: Date.now() + 8 * 60 * 60_000 };
    return "unknown" as const;
  });
  const adapter: ClaudeKeeperAdapter = options.adapter ?? {
    read: async () => ({ ...credential }),
    refresh,
    withLock: async (run) => run(),
  };
  const loadAdapter = vi.fn(async () => adapter);
  const ctx: OpenClawPluginServiceContext = {
    config: {
      plugins: { entries: { anthropic: { config: { subscriptionKeeper: { enabled: true } } } } },
    },
    stateDir: "/synthetic-state",
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    importAuthTokenV1: vi.fn(async () => {}),
    serviceHealth: { reportFailure: vi.fn(), clearFailure: vi.fn() },
  };
  const service = createClaudeSubscriptionKeeper({
    profileId: "anthropic:subscription",
    platform: options.platform ?? "linux",
    loadAdapter,
  });
  services.push({ service, ctx });
  return {
    service,
    ctx,
    refresh,
    loadAdapter,
    adapter,
    setCredential: (value: typeof credential) => {
      credential = value;
    },
  };
}

it.each([undefined, {}, { enabled: false }])(
  "the actual Anthropic registration does no keeper work by default (%j)",
  (subscriptionKeeper) => {
    const registerService = vi.fn();
    const api = createTestPluginApi({
      pluginConfig: { sessionCatalog: { enabled: false }, subscriptionKeeper },
      registerService,
    });
    registerAnthropicPlugin(api);
    expect(registerService).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  },
);

it("the Anthropic entry point registers one explicitly targeted opt-in service", () => {
  const registerService = vi.fn();
  registerAnthropicPlugin(
    createTestPluginApi({
      pluginConfig: { sessionCatalog: { enabled: false }, subscriptionKeeper: { enabled: true } },
      registerService,
    }),
  );
  expect(registerService).toHaveBeenCalledOnce();
  expect(registerService.mock.calls[0][0].reload.configPrefixes).toContain(
    "models.providers.anthropic",
  );
  expect(registerService.mock.calls[0][0].authTokenImportV1).toEqual({
    provider: "anthropic",
    profileId: "anthropic:subscription",
  });
});

it("near expiry asks CLI once then imports only the refreshed access credential", async () => {
  const f = fixture();
  await f.service.start(f.ctx);
  await vi.advanceTimersByTimeAsync(0);
  expect(f.refresh).toHaveBeenCalledOnce();
  expect(f.ctx.importAuthTokenV1).toHaveBeenCalledWith({
    token: "synthetic-access-after",
    expires: Date.now() + 8 * 60 * 60_000,
  });
  await vi.advanceTimersByTimeAsync(KEEPER_INTERVAL_MS);
  expect(f.refresh).toHaveBeenCalledOnce();
  expect(f.ctx.importAuthTokenV1).toHaveBeenCalledOnce();
});

it("imports credential drift even when no refresh is needed", async () => {
  const f = fixture();
  f.setCredential({ token: "synthetic-cli-rotation", expires: Date.now() + 8 * 60 * 60_000 });
  await f.service.start(f.ctx);
  await vi.advanceTimersByTimeAsync(0);
  expect(f.refresh).not.toHaveBeenCalled();
  expect(f.ctx.importAuthTokenV1).toHaveBeenCalledWith(
    expect.objectContaining({ token: "synthetic-cli-rotation" }),
  );
  f.setCredential({ token: "synthetic-external-rotation", expires: Date.now() + 9 * 60 * 60_000 });
  await vi.advanceTimersByTimeAsync(KEEPER_INTERVAL_MS);
  expect(f.ctx.importAuthTokenV1).toHaveBeenLastCalledWith(
    expect.objectContaining({ token: "synthetic-external-rotation" }),
  );
});

it("syncs a successful refresh even if the CLI inference refuses weekly quota", async () => {
  const f = fixture();
  f.refresh.mockImplementation(async () => {
    f.setCredential({ token: "synthetic-new-quota", expires: Date.now() + 8 * 60 * 60_000 });
    return "quota";
  });
  await f.service.start(f.ctx);
  await vi.advanceTimersByTimeAsync(0);
  expect(f.ctx.importAuthTokenV1).toHaveBeenCalledWith(
    expect.objectContaining({ token: "synthetic-new-quota" }),
  );
  expect(f.ctx.serviceHealth?.reportFailure).not.toHaveBeenCalled();
  expect(f.ctx.logger.debug).toHaveBeenCalledWith(
    expect.stringContaining("not an authentication failure"),
  );
});

it("backs off unchanged credentials exponentially, caps the delay, and reports no paid fallback", async () => {
  const f = fixture();
  f.refresh.mockResolvedValue("quota");
  await f.service.start(f.ctx);
  await vi.advanceTimersByTimeAsync(0);
  expect(f.ctx.serviceHealth?.reportFailure).toHaveBeenCalledWith(
    expect.objectContaining({ message: expect.stringContaining("no paid fallback") }),
  );
  await vi.advanceTimersByTimeAsync(KEEPER_INTERVAL_MS * 2);
  expect(f.refresh).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(KEEPER_INTERVAL_MS);
  expect(f.refresh).toHaveBeenCalledTimes(3);
  await vi.advanceTimersByTimeAsync(KEEPER_INTERVAL_MS * 60);
  // No retry can exceed the six-hour cap: a 30-hour simulated span retries repeatedly.
  expect(f.refresh.mock.calls.length).toBeGreaterThan(7);
  expect(f.refresh.mock.calls.length).toBeLessThan(12);
});

it("never overlaps ticks and stop waits for refresh cancellation without importing", async () => {
  let began!: () => void;
  const started = new Promise<void>((resolve) => {
    began = resolve;
  });
  const f = fixture();
  f.refresh.mockImplementation(async (_credential, signal) => {
    began();
    await new Promise<void>((resolve) => {
      signal.addEventListener("abort", () => resolve(), { once: true });
    });
    return "unknown";
  });
  await f.service.start(f.ctx);
  await vi.advanceTimersByTimeAsync(0);
  await started;
  await vi.advanceTimersByTimeAsync(KEEPER_INTERVAL_MS * 10);
  expect(f.refresh).toHaveBeenCalledOnce();
  await f.service.stop?.(f.ctx);
  expect(f.ctx.importAuthTokenV1).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it("does not leak CLI adapter errors into health or logs", async () => {
  const f = fixture();
  f.refresh.mockRejectedValue(new Error("synthetic-secret-never-log"));
  await f.service.start(f.ctx);
  await vi.advanceTimersByTimeAsync(0);
  expect(
    JSON.stringify(
      vi.mocked(f.ctx.serviceHealth!.reportFailure).mock.calls.map(([error]) => String(error)),
    ),
  ).not.toContain("synthetic-secret-never-log");
  expect(f.ctx.logger.error).not.toHaveBeenCalled();
});

it.each(["darwin", "win32"] as const)(
  "fails visibly without reading credentials or starting CLI on %s",
  async (platform) => {
    const f = fixture({ platform });
    await f.service.start(f.ctx);
    expect(f.loadAdapter).not.toHaveBeenCalled();
    expect(f.ctx.serviceHealth?.reportFailure).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining("requires Linux") }),
    );
    expect(vi.getTimerCount()).toBe(0);
  },
);

it("sync retry retains producer quota outcome without repeating refresh", async () => {
  const f = fixture();
  f.refresh.mockImplementation(async () => {
    f.setCredential({ token: "synthetic-recovered", expires: Date.now() + 8 * 60 * 60_000 });
    return "quota";
  });
  vi.mocked(f.ctx.importAuthTokenV1!).mockRejectedValueOnce(
    new Error("synthetic-admission-failure"),
  );
  await f.service.start(f.ctx);
  await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(KEEPER_INTERVAL_MS);
  expect(f.refresh).toHaveBeenCalledOnce();
  expect(f.ctx.importAuthTokenV1).toHaveBeenCalledTimes(2);
  expect(f.ctx.logger.debug).toHaveBeenLastCalledWith(
    expect.stringContaining("not an authentication failure"),
  );
  expect(f.ctx.serviceHealth?.clearFailure).toHaveBeenCalledOnce();
});

it("read failure after producer refresh still synchronizes fresh drift on next tick", async () => {
  const f = fixture();
  const read = f.adapter.read;
  let calls = 0;
  f.adapter.read = async () => {
    if (++calls === 2) {
      throw new Error("synthetic-read-failure");
    }
    return read();
  };
  f.refresh.mockImplementation(async () => {
    f.setCredential({ token: "synthetic-read-recovered", expires: Date.now() + 8 * 60 * 60_000 });
    return "quota";
  });
  await f.service.start(f.ctx);
  await vi.advanceTimersByTimeAsync(0);
  expect(f.ctx.importAuthTokenV1).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(KEEPER_INTERVAL_MS);
  expect(f.refresh).toHaveBeenCalledOnce();
  expect(f.ctx.importAuthTokenV1).toHaveBeenCalledWith(
    expect.objectContaining({ token: "synthetic-read-recovered" }),
  );
  expect(f.ctx.logger.debug).toHaveBeenLastCalledWith(
    expect.stringContaining("not an authentication failure"),
  );
});
