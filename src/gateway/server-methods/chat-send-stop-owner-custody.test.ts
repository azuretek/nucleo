import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { abortEmbeddedAgentRun } from "../../agents/embedded-agent-runner/runs.js";
import { isAgentRunRestartAbortReason } from "../../agents/run-termination.js";
import { registerAgentSessionLoopTestLifecycle } from "../../agents/sessions/agent-session-loop-correctness.test-support.js";
import type { dispatchInboundMessage } from "../../auto-reply/dispatch.js";
import {
  createQueueSettings,
  createQueueTestRun,
} from "../../auto-reply/reply/queue.test-helpers.js";
import { enqueueFollowupRun } from "../../auto-reply/reply/queue/enqueue.js";
import { clearFollowupQueue } from "../../auto-reply/reply/queue/state.js";
import { drainGatewayActiveWork } from "../../cli/gateway-cli/run-loop-drain.js";
import { listSessionPendingInputs } from "../../config/sessions/session-accessor.pending-inputs.js";
import { listSessionPendingInputReceipts } from "../../config/sessions/session-accessor.sqlite-pending-input-receipts.js";
import { loadTranscriptEventsSync } from "../../config/sessions/session-accessor.sqlite-read.js";
import { createGatewayActiveWorkSnapshot } from "../../infra/gateway-active-work.js";
import { createChatAbortOps } from "../chat-abort-ops.js";
import { prepareGatewayRunShutdown } from "../server-run-shutdown.js";
import { dispatchInboundMessageMock, installGatewayTestHooks } from "../test-helpers.js";
import { useBrowserFollowupFixture } from "./chat-send-pending-inputs.test-support.js";

installGatewayTestHooks();
registerAgentSessionLoopTestLifecycle();
const createBrowserFollowupFixture = useBrowserFollowupFixture();

async function within<T>(promise: Promise<T>, milestone: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Stop owner milestone timed out: ${milestone}`)),
          5_000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

describe("CLI stop with independent browser input ownership", () => {
  it.each(["admitted", "queued"] as const)(
    "retains %s input through the real stop shutdown owner",
    async (target) => {
      const fixture = await createBrowserFollowupFixture();
      let dispatchCompletion: Promise<void> | undefined;
      try {
        await within(fixture.send(), "browser ACK");
        await within(fixture.dispatchedRecorder, "accepted dispatch recorder");
        const runId = fixture.params.idempotencyKey;
        const original = structuredClone(listSessionPendingInputs(fixture.scope).items[0]);
        expect(original).toMatchObject({ runId, state: "queued" });
        const inputOwner = fixture.context.chatAbortControllers.get(runId);
        expect(inputOwner).toBeDefined();
        if (!inputOwner) {
          throw new Error("Expected admitted browser owner");
        }
        // This backend belongs to the preceding turn, not the browser followup.
        // Deliberately do not call abortChatRunById from this callback.
        expect(fixture.activeRun).toBeDefined();
        const priorCancel = vi.fn();
        fixture.activeRun?.attachBackend({ kind: "embedded", cancel: priorCancel });
        fixture.activeRun?.setPhase("running");
        if (target === "queued") {
          const dispatch = dispatchInboundMessageMock.mock.calls.at(-1)?.[0] as Parameters<
            typeof dispatchInboundMessage
          >[0];
          const followup = createQueueTestRun({ prompt: fixture.params.message });
          followup.abortSignal = inputOwner.controller.signal;
          followup.turnAdoptionLifecycle = dispatch.replyOptions?.turnAdoptionLifecycle;
          expect(followup.turnAdoptionLifecycle).toBeDefined();
          expect(
            enqueueFollowupRun(
              fixture.scope.sessionKey,
              followup,
              createQueueSettings({ mode: "followup" }),
              "none",
              async () => {},
              false,
            ),
          ).toBe(true);
          const detached = createDeferred();
          // createDirectChatContext installs removeChatRun as vi.fn() with no
          // cleanup implementation, so this observer preserves its behavior.
          vi.mocked(fixture.context.removeChatRun).mockImplementationOnce(
            (_sessionId, clientRunId) => {
              expect(clientRunId).toBe(runId);
              detached.resolve();
              return undefined;
            },
          );
          // Detach only the followup dispatcher; its preceding reply remains live.
          dispatchCompletion = fixture.finishDispatch({ completeActiveRun: false });
          await within(
            Promise.race([
              detached.promise,
              dispatchCompletion.then(() => {
                throw new Error("Followup settled before its detachment milestone");
              }),
            ]),
            "queue detachment",
          );
          expect(fixture.context.chatAbortControllers.has(runId)).toBe(false);
          expect(fixture.context.chatQueuedTurns.get(runId)?.controller).toBe(
            inputOwner.controller,
          );
        }
        const warn = vi.fn();
        const join = vi.fn(async () => ({
          drained: false,
          snapshot: createGatewayActiveWorkSnapshot(),
        }));
        // Model an exhausted CLI drain without spending 30 wall-clock seconds.
        // Registry cancellation and the later server-close cancellation remain real.
        const runtime = {
          abortEmbeddedAgentRun,
          abortActiveCronTaskRuns: () => 0,
          waitForGatewayActiveWork: join,
          listActiveEmbeddedRunSessionIds: () => [],
          getDiagnosticSessionActivitySnapshot: () => undefined,
        };
        expect(priorCancel).not.toHaveBeenCalled();
        await drainGatewayActiveWork({
          request: { action: "stop", signal: "SIGTERM", acceptedAtMs: 0 },
          runtime:
            runtime as unknown as typeof import("../../cli/gateway-cli/lifecycle.runtime.js"),
          drainTimeoutMs: 30_000,
          restartDrainDeadlineAt: undefined,
          markDraining: () => {},
          recordCounts: () => {},
          recordWarning: () => {},
          logger: { info: () => {}, warn },
        });
        expect(priorCancel).toHaveBeenCalledExactlyOnceWith("restart");
        expect(join).toHaveBeenCalledOnce();
        expect(warn.mock.calls.some(([message]) => message.includes("drain failed"))).toBe(false);
        // Prove no implicit reverse link from the prior reply to this input owner.
        expect(inputOwner.controller.signal.aborted).toBe(false);
        if (target === "queued") {
          expect(fixture.context.chatAbortControllers.has(runId)).toBe(false);
          expect(fixture.context.chatQueuedTurns.get(runId)?.controller).toBe(
            inputOwner.controller,
          );
        }
        expect(listSessionPendingInputs(fixture.scope).items).toEqual([original]);
        // server-close.ts uses restart:false when restartExpectedMs is null for stop.
        // Invoke that real owner rather than manufacturing an ingress abort in a stub.
        const warnings: string[] = [];
        await prepareGatewayRunShutdown({
          ...createChatAbortOps(fixture.context),
          chatRunState: fixture.context.chatRunState,
          removeChatRun: fixture.context.removeChatRun,
          resolveGatewayContext: () => fixture.context,
          chatQueuedTurns: fixture.context.chatQueuedTurns,
          restart: false,
          getPendingReplyCount: () => 0,
          timeoutMs: 0,
          warnings,
        });
        await within(dispatchCompletion ?? fixture.finishDispatch(), "input shutdown settlement");
        expect(warnings).toEqual([]);
        expect(inputOwner.controller.signal.aborted).toBe(true);
        // These are the required recovery invariants, not an assertion of current
        // behavior. Static trace predicts a red result until the real stop owner
        // preserves restart disposition; execution is deferred to the proof host.
        expect({
          restartDisposition: isAgentRunRestartAbortReason(inputOwner.controller.signal.reason),
          items: listSessionPendingInputs(fixture.scope).items,
          receipts: listSessionPendingInputReceipts(fixture.scope, { runIds: [runId] }),
          transcript: loadTranscriptEventsSync(fixture.scope),
        }).toEqual({
          restartDisposition: true,
          items: [{ ...original, state: "interrupted" }],
          receipts: [{ runId, state: "pending" }],
          transcript: fixture.activeTranscript,
        });
      } finally {
        clearFollowupQueue(fixture.scope.sessionKey);
        await within(fixture.cleanup(), "fixture cleanup");
      }
    },
  );
});
