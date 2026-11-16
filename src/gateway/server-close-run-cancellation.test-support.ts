import { expect, it, vi } from "vitest";
import { isAgentRunRestartAbortReason } from "../agents/run-termination.js";
import type { GatewayCloseParams } from "./server-close.test-support.js";
import type { GatewayCloseOptions } from "./server-public.js";

type MarkMainSessionsAbortedForRestart = NonNullable<
  GatewayCloseParams["markMainSessionsAbortedForRestart"]
>;

export function registerOrdinaryStopRunCancellationTests({
  createGatewayCloseTestDeps,
  createGatewayCloseHandler,
}: {
  createGatewayCloseTestDeps: (overrides?: Partial<GatewayCloseParams>) => GatewayCloseParams;
  createGatewayCloseHandler: (
    params: GatewayCloseParams,
  ) => (opts?: GatewayCloseOptions) => Promise<{ warnings: string[] }>;
}) {
  it.each(
    ([undefined, "chat-send", "agent"] as const).flatMap((kind) =>
      [true, false].map((projectSessionActive) => ({ kind, projectSessionActive })),
    ),
  )(
    "cancels remaining $kind runs (projected=$projectSessionActive) after ordinary shutdown grace without restart recovery",
    async ({ kind, projectSessionActive }) => {
      const controller = new AbortController();
      const chatAbortControllers = new Map([
        [
          "run-1",
          {
            controller,
            sessionId: "run-1",
            sessionKey: "session-1",
            startedAtMs: Date.now(),
            expiresAtMs: Date.now() + 60_000,
          },
        ],
      ]);
      Object.assign(chatAbortControllers.get("run-1")!, { kind, projectSessionActive });
      const getPendingReplyCount = vi.fn(() => 1);
      const markMainSessionsAbortedForRestart = vi.fn<MarkMainSessionsAbortedForRestart>();
      const deps = createGatewayCloseTestDeps({
        chatAbortControllers,
        getPendingReplyCount,
        markMainSessionsAbortedForRestart,
      });
      const close = createGatewayCloseHandler(deps);

      const result = await close({ reason: "SIGTERM", drainTimeoutMs: 0 });

      expect(result.warnings).not.toContain("restart-reply-drain");
      expect(controller.signal.aborted).toBe(true);
      expect(isAgentRunRestartAbortReason(controller.signal.reason)).toBe(kind !== "agent");
      expect(chatAbortControllers.size).toBe(0);
      expect(getPendingReplyCount).not.toHaveBeenCalled();
      expect(markMainSessionsAbortedForRestart).not.toHaveBeenCalled();
      if (projectSessionActive) {
        expect(deps.broadcast).toHaveBeenCalledWith(
          "chat",
          expect.objectContaining({
            runId: "run-1",
            state: "aborted",
            stopReason: kind !== "agent" ? "restart" : "rpc",
          }),
          { sessionKeys: ["session-1"] },
        );
      } else {
        expect(vi.mocked(deps.broadcast).mock.calls.some(([event]) => event === "chat")).toBe(
          false,
        );
      }
    },
  );
}
