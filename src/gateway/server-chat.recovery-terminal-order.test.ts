import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  getAgentEventLifecycleGeneration,
  resetAgentEventsForTest,
  type AgentEventPayload,
} from "../infra/agent-events.js";
import { registerAgentRunContext } from "../infra/agent-run-registry.js";
import {
  createAgentEventHandler,
  createChatRunState,
  createSessionEventSubscriberRegistry,
  createSessionMessageSubscriberRegistry,
} from "./server-chat.js";
import { loadSessionEntry } from "./session-utils.js";

vi.mock("../config/io.js", () => ({ getRuntimeConfig: vi.fn(() => ({})) }));
vi.mock("./session-utils.js", () => {
  const load = vi.fn();
  return { loadSessionEntry: load, loadGatewaySessionEntryReadOnly: load };
});

const persist = vi.fn();

beforeEach(() => {
  resetAgentEventsForTest({ preserveListeners: true });
  persist.mockReset();
  vi.mocked(loadSessionEntry)
    .mockReset()
    .mockReturnValue({
      cfg: {},
      agentId: "main",
      storePath: "/tmp/sessions.json",
      store: {},
      entry: undefined,
      canonicalKey: "session-recovery",
      storeKeys: ["session-recovery"],
      legacyKey: undefined,
    } as unknown as ReturnType<typeof loadSessionEntry>);
});
afterEach(() => resetAgentEventsForTest({ preserveListeners: true }));

function createHarness() {
  const broadcast = vi.fn();
  const broadcastToConnIds = vi.fn();
  const chatRunState = createChatRunState();
  const handler = createAgentEventHandler({
    broadcast,
    broadcastToConnIds,
    nodeSendToSession: vi.fn(),
    nodeHasSessionSubscribers: () => true,
    agentRunSeq: new Map(),
    chatRunState,
    resolveSessionKeyForRun: () => "session-recovery",
    clearAgentRunContext: vi.fn(),
    toolEventRecipients: chatRunState.toolEventRecipients,
    sessionEventSubscribers: createSessionEventSubscriberRegistry(),
    sessionMessageSubscribers: createSessionMessageSubscriberRegistry(),
    loadGatewaySessionLifecycleSnapshotForEvent: () => ({ row: null }),
    persistGatewaySessionLifecycleEventForEvent: persist,
  });
  const finals = () =>
    [...broadcast.mock.calls, ...broadcastToConnIds.mock.calls].filter(
      (call) => call[0] === "chat" && (call[1] as { state?: string })?.state === "final",
    );
  return { handler, finals };
}

function terminal(runId: string, recovery: boolean): AgentEventPayload {
  return {
    runId,
    seq: 1,
    stream: "lifecycle",
    ts: Date.now(),
    lifecycleGeneration: getAgentEventLifecycleGeneration(),
    ...(recovery ? { mainSessionRestartRecovery: true as const } : {}),
    data: { phase: "end", executionSettled: true },
  } as AgentEventPayload;
}

describe("restart recovery terminal publication", () => {
  it.each([false, true])(
    "publishes the recovery final only after its lifecycle commit settles (write fails=%s)",
    async (writeFails) => {
      const persistence = createDeferred<void>();
      persist.mockReturnValue(persistence.promise);
      const h = createHarness();
      registerAgentRunContext("recovery-run", { sessionKey: "session-recovery" });
      h.handler(terminal("recovery-run", true));
      expect(persist).toHaveBeenCalledOnce();
      expect(h.finals()).toHaveLength(0);
      if (writeFails) {
        persistence.reject(new Error("disk full"));
      } else {
        persistence.resolve();
      }
      await persistence.promise.catch(() => undefined);
      await vi.waitFor(() => expect(h.finals()).toHaveLength(1));
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 10);
      });
      expect(h.finals()).toHaveLength(1);
    },
  );

  it("keeps a non-recovery final synchronous", () => {
    const persistence = createDeferred<void>();
    persist.mockReturnValue(persistence.promise);
    const h = createHarness();
    registerAgentRunContext("ordinary-run", { sessionKey: "session-recovery" });
    h.handler(terminal("ordinary-run", false));
    expect(h.finals()).toHaveLength(1);
    persistence.resolve();
  });
});
