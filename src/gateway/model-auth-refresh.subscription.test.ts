import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  prepare: vi.fn(),
  secrets: vi.fn(),
  reload: vi.fn(),
  clear: vi.fn(),
}));
vi.mock("../agents/agent-scope.js", () => ({ listAgentIds: () => ["first", "second"] }));
vi.mock("../agents/auth-profiles/path-resolve.js", () => ({
  reloadSharedAuthStoreOwnership: mocks.reload,
}));
vi.mock("../agents/prepared-model-runtime.js", () => ({
  prepareModelRuntimeSnapshot: mocks.prepare,
}));
vi.mock("../secrets/runtime.js", () => ({
  refreshActiveProviderAuthRuntimeSnapshot: mocks.secrets,
}));
vi.mock("./server-methods/models-auth-status-usage-cache.js", () => ({
  clearModelAuthStatusUsageCache: mocks.clear,
}));
vi.mock("./server-methods/model-auth-agent-scope.js", () => ({
  resolveModelAuthAgentScope: (_config: unknown, agentId: string) => ({
    ok: true,
    agentId,
    agentDir: "/synthetic/" + agentId,
  }),
  modelAuthAgentScopeError: () => ({ message: "unknown agent" }),
}));
import { refreshModelAuthStateAfterMutation } from "./model-auth-refresh.js";
beforeEach(() => {
  vi.clearAllMocks();
});
it("shared credential publication joins every configured agent without choosing a default", async () => {
  await refreshModelAuthStateAfterMutation(() => ({}));
  expect(mocks.secrets).toHaveBeenCalledOnce();
  expect(mocks.prepare.mock.calls.map(([args]) => args.agentId)).toEqual(["first", "second"]);
});
it("existing agent-scoped callers still refresh only their requested agent", async () => {
  await refreshModelAuthStateAfterMutation(() => ({}), "second");
  expect(mocks.prepare).toHaveBeenCalledOnce();
  expect(mocks.prepare).toHaveBeenCalledWith({
    config: {},
    agentId: "second",
    agentDir: "/synthetic/second",
  });
});
