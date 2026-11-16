import { expect, it, vi, type Mock } from "vitest";
import { registerAgentRunContext } from "../infra/agent-run-registry.js";
import type { ChatRunState } from "./server-chat-state.js";
import { emitAgentEvent, registerChatRun } from "./server-chat.agent-events.test-helpers.js";
import type { AgentEventHandlerOptions, createAgentEventHandler } from "./server-chat.js";

export function registerNativeInputCompletionTests(
  createHarness: (
    params: Pick<
      AgentEventHandlerOptions,
      "resolveSessionKeyForRun" | "lifecycleErrorRetryGraceMs" | "isChatSendRunActive"
    >,
  ) => {
    broadcast: Mock;
    chatRunState: ChatRunState;
    handler: ReturnType<typeof createAgentEventHandler>;
    clearAgentRunContext: Mock;
    agentRunSeq: Map<string, number>;
  },
) {
  const chatBroadcastCalls = (broadcast: Mock) =>
    broadcast.mock.calls.filter(([event]) => event === "chat");
  it.each([false, true])(
    "commits native input before lifecycle success publication (write failure=%s)",
    (fails) => {
      const runId = "run-native-input-completion";
      const sessionKey = "session-native-input-completion";
      const harness = createHarness({
        resolveSessionKeyForRun: () => sessionKey,
        lifecycleErrorRetryGraceMs: 0,
      });
      const complete = vi.fn(() => {
        expect(
          chatBroadcastCalls(harness.broadcast).filter(([, payload]) => payload.state === "final"),
        ).toHaveLength(0);
        if (fails) {
          throw new Error("required native completion unavailable");
        }
      });
      registerChatRun(harness.chatRunState, runId, sessionKey, runId, {
        beforeTerminalPublication: complete,
      });
      registerAgentRunContext(runId, { sessionKey });
      emitAgentEvent(harness.handler, runId, "lifecycle", { phase: "end" });
      expect(complete).toHaveBeenCalledOnce();
      expect(
        chatBroadcastCalls(harness.broadcast).filter(([, payload]) => payload.state === "final"),
      ).toHaveLength(fails ? 0 : 1);
      expect(
        chatBroadcastCalls(harness.broadcast).filter(([, payload]) => payload.state === "error"),
      ).toHaveLength(fails ? 1 : 0);
    },
  );

  it("emits lifecycle chat errors for active chat.send runs with a chat run link", () => {
    vi.useFakeTimers();
    const { broadcast, chatRunState, clearAgentRunContext, agentRunSeq, handler } = createHarness({
      resolveSessionKeyForRun: () => "session-chat-send",
      lifecycleErrorRetryGraceMs: 100,
      isChatSendRunActive: (runId) => runId === "run-chat-send",
    });
    registerChatRun(chatRunState, "run-chat-send", "session-chat-send", "run-chat-send");
    registerAgentRunContext("run-chat-send", { sessionKey: "session-chat-send" });

    emitAgentEvent(handler, "run-chat-send", "lifecycle", {
      phase: "error",
      error: "chat.send failed",
    });

    vi.advanceTimersByTime(100);

    const chatErrors = chatBroadcastCalls(broadcast).filter(
      ([, payload]) => (payload as { state?: string }).state === "error",
    );
    expect(chatErrors).toHaveLength(1);
    const errorPayload = chatErrors[0]?.[1] as Record<string, unknown>;
    expect(errorPayload).toMatchObject({
      runId: "run-chat-send",
      sessionKey: "session-chat-send",
      state: "error",
      errorMessage: "chat.send failed",
    });
    expect(errorPayload).not.toHaveProperty("message");
    expect(chatRunState.registry.peek("run-chat-send")).toBeUndefined();
    expect(clearAgentRunContext).toHaveBeenCalledWith("run-chat-send");
    expect(agentRunSeq.has("run-chat-send")).toBe(false);
  });
}
