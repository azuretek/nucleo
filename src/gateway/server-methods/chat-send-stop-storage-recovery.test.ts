import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { registerAgentSessionLoopTestLifecycle } from "../../agents/sessions/agent-session-loop-correctness.test-support.js";
import type { dispatchInboundMessage } from "../../auto-reply/dispatch.js";
import { getRuntimeConfig } from "../../config/config.js";
import {
  listSessionPendingInputs,
  loadTranscriptEventsSync,
  patchSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { listSessionPendingInputReceipts } from "../../config/sessions/session-accessor.sqlite-pending-input-receipts.js";
import { readSessionInputCompletion } from "../../config/sessions/session-accessor.sqlite-pending-inputs.js";
import {
  resolveSqliteScope,
  toDatabaseOptions,
} from "../../config/sessions/session-accessor.sqlite-scope.js";
import { rotateAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import { getSessionWorkAdmissionRelease } from "../../sessions/session-lifecycle-admission.js";
import type { UserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { createChatAbortOps } from "../chat-abort-ops.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { prepareGatewayRunShutdown } from "../server-run-shutdown.js";
import { dispatchInboundMessageMock, installGatewayTestHooks } from "../test-helpers.js";
import { handleChatSend } from "./chat-send-handler.js";
import { useBrowserFollowupFixture } from "./chat-send-pending-inputs.test-support.js";
import type { GatewayRequestContext, RespondFn } from "./types.js";

installGatewayTestHooks();
registerAgentSessionLoopTestLifecycle();
const createFixture = useBrowserFollowupFixture();

async function within<T>(promise: Promise<T>, milestone: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Storage recovery milestone timed out: " + milestone)),
          5_000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

it.each(["direct", "deferred"] as const)(
  "consumes one durable stopped input across storage reopen and fresh-context retries (%s)",
  async (execution) => {
    const fixture = await createFixture({ preserveContent: true });
    const profile = ensureProfileForEmail("stop-storage-recovery@example.test");
    fixture.client.authenticatedUserProfile = {
      profileId: profile.id,
      displayName: "Input author",
      hasAvatar: false,
      updatedAt: 1,
    };
    const resumedRelease = createDeferred();
    const resumedStarted = createDeferred();
    const persistence = createDeferred<{
      result?: Awaited<ReturnType<UserTurnTranscriptRecorder["persistApproved"]>>;
      error?: unknown;
    }>();
    let resumedCompletion: Promise<void> | undefined;
    try {
      await within(fixture.send(), "original ACK");
      const originalRecorder = await within(fixture.dispatchedRecorder, "original recorder");
      const original = structuredClone(listSessionPendingInputs(fixture.scope).items[0]);
      expect(original).toMatchObject({ runId: fixture.params.idempotencyKey, state: "queued" });
      await prepareGatewayRunShutdown({
        ...createChatAbortOps(fixture.context),
        chatRunState: fixture.context.chatRunState,
        removeChatRun: fixture.context.removeChatRun,
        resolveGatewayContext: () => fixture.context,
        chatQueuedTurns: fixture.context.chatQueuedTurns,
        restart: false,
        getPendingReplyCount: () => 0,
        timeoutMs: 0,
        warnings: [],
      });
      await within(fixture.finishDispatch(), "original stop settlement");
      rotateAgentEventLifecycleGeneration();
      closeOpenClawAgentDatabasesForTest();
      await within(closeOpenClawAgentDatabasesAsync(), "database close join");
      // Accessors must reopen real on-disk SQLite; no in-memory receipt is reused.
      expect(listSessionPendingInputs(fixture.scope).items).toEqual([
        { ...original, state: "interrupted" },
      ]);
      expect(
        listSessionPendingInputReceipts(fixture.scope, { runIds: [fixture.params.idempotencyKey] }),
      ).toEqual([{ runId: fixture.params.idempotencyKey, state: "pending" }]);
      expect(loadTranscriptEventsSync(fixture.scope)).toEqual(fixture.activeTranscript);
      expect(() => originalRecorder.withPendingInput?.(() => {})).toThrow("ownership ended");
      // Model the preceding task having settled; this is not a startup recovery boot.
      await patchSessionEntryCore(fixture.scope, () => ({ status: "done" }));

      const recoveredContext = createDirectChatContext({
        getRuntimeConfig,
        chatQueuedTurns: new Map(),
      });
      expect(recoveredContext.dedupe.size).toBe(0);
      const reconnectParams = {
        ...fixture.params,
        sessionId: fixture.scope.sessionId,
        __controlUiReconnectResume: true,
      };
      const reconnect = async (context: GatewayRequestContext) => {
        const respond = vi.fn<RespondFn>();
        await handleChatSend({
          req: {
            type: "req",
            id: reconnectParams.idempotencyKey,
            method: "chat.send",
            params: reconnectParams,
          },
          params: reconnectParams,
          client: fixture.client,
          context,
          respond,
          isWebchatConnect: () => true,
        });
        return respond;
      };
      const recoveredDispatch = vi.fn(
        async (options: Parameters<typeof dispatchInboundMessage>[0]) => {
          const recorder = options.replyOptions?.userTurnTranscriptRecorder;
          if (!recorder) {
            throw new Error("Fresh reconnect lacks admitted recorder");
          }
          const lifecycle = options.replyOptions?.turnAdoptionLifecycle;
          if (execution === "deferred") {
            expect(lifecycle?.onDeferred?.()).toBe(true);
          }
          resumedStarted.resolve();
          await resumedRelease.promise;
          try {
            if (execution === "deferred") {
              await lifecycle?.onAdopted();
            }
            persistence.resolve({ result: await recorder.persistApproved() });
            if (execution === "deferred") {
              await options.replyOptions?.onQueuedFollowupReplyBatch?.({
                kind: "queued-followup",
                runId: fixture.params.idempotencyKey,
                originatingChannel: "webchat",
                payloads: [],
                completion: { kind: "completed" },
              });
            }
          } catch (error) {
            persistence.resolve({ error });
            throw error;
          } finally {
            if (execution === "deferred") {
              lifecycle?.onSettled?.();
            }
          }
          return {};
        },
      );
      dispatchInboundMessageMock.mockImplementation(recoveredDispatch);
      const ack = await within(reconnect(recoveredContext), "reconnect ACK");
      expect(ack).toHaveBeenCalledWith(
        true,
        expect.objectContaining({ status: "started", runId: fixture.params.idempotencyKey }),
        undefined,
        expect.anything(),
      );
      await within(resumedStarted.promise, "fresh admitted recorder");
      expect(listSessionPendingInputs(fixture.scope).items).toEqual([
        { ...original, state: "queued" },
      ]);
      resumedCompletion = getSessionWorkAdmissionRelease({
        scope: fixture.scope.storePath,
        identities: [fixture.scope.sessionKey, fixture.scope.sessionId],
      });
      expect(resumedCompletion).toBeDefined();
      if (!resumedCompletion) {
        throw new Error("Fresh input has no active admission release barrier");
      }
      resumedRelease.resolve();
      const observed = await within(persistence.promise, "durable promotion");
      expect(observed.error).toBeUndefined();
      expect(observed.result).toMatchObject({ appended: true, messageId: original?.id });
      expect(observed.result?.message).toEqual(original?.message);
      await within(resumedCompletion, "fresh input settlement");
      expect(recoveredDispatch).toHaveBeenCalledOnce();
      expect(fixture.beforeApprove).toHaveBeenCalledOnce();
      const transcript = loadTranscriptEventsSync(fixture.scope);
      expect(transcript.slice(0, fixture.activeTranscript.length)).toEqual(
        fixture.activeTranscript,
      );
      expect(transcript).toHaveLength(fixture.activeTranscript.length + 1);
      const appended = transcript.at(-1);
      expect(appended).toMatchObject({
        type: "message",
        id: observed.result?.messageId,
        message: original?.message,
      });
      const receipts = listSessionPendingInputReceipts(fixture.scope, {
        runIds: [fixture.params.idempotencyKey],
      });
      // A direct source is deleted on promotion; collected sources alone retain
      // consumed_event_id. Final retry authority is session_input_completions.
      expect(receipts).toEqual([]);
      const readCompletion = () =>
        readSessionInputCompletion(
          openOpenClawAgentDatabase(toDatabaseOptions(resolveSqliteScope(fixture.scope))),
          { ...fixture.scope, idempotencyKey: `${fixture.params.idempotencyKey}:user` },
        );
      const completion = readCompletion();
      expect(completion).toMatchObject({
        run_id: fixture.params.idempotencyKey,
        session_id: fixture.scope.sessionId,
        succeeded: 1,
        outcome: { reason: "completed" },
      });
      expect(listSessionPendingInputs(fixture.scope).items).toEqual([]);
      rotateAgentEventLifecycleGeneration();
      closeOpenClawAgentDatabasesForTest();
      await within(closeOpenClawAgentDatabasesAsync(), "database close join");
      const duplicateContext = createDirectChatContext({
        getRuntimeConfig,
        chatQueuedTurns: new Map(),
      });
      expect(duplicateContext.dedupe.size).toBe(0);
      const duplicate = await within(reconnect(duplicateContext), "second fresh reconnect");
      expect(duplicate).toHaveBeenCalledWith(
        true,
        { runId: fixture.params.idempotencyKey, status: "ok" },
        undefined,
        expect.objectContaining({ cached: true }),
      );
      expect(recoveredDispatch).toHaveBeenCalledOnce();
      expect(fixture.beforeApprove).toHaveBeenCalledOnce();
      expect(
        listSessionPendingInputReceipts(fixture.scope, { runIds: [fixture.params.idempotencyKey] }),
      ).toEqual(receipts);
      const freshContext = () =>
        createDirectChatContext({ getRuntimeConfig, chatQueuedTurns: new Map() });
      const originalMessage = reconnectParams.message;
      reconnectParams.message = "Different bytes under the completed request key.";
      try {
        const conflict = await within(reconnect(freshContext()), "changed payload replay");
        expect(conflict).toHaveBeenCalledWith(
          false,
          expect.objectContaining({ status: "error" }),
          expect.objectContaining({
            code: "UNAVAILABLE",
            message: expect.stringContaining("conflicts with the accepted input"),
          }),
          expect.anything(),
        );
      } finally {
        reconnectParams.message = originalMessage;
      }
      const originalProfile = fixture.client.authenticatedUserProfile;
      const otherProfile = ensureProfileForEmail("other-storage-recovery@example.test");
      fixture.client.authenticatedUserProfile = { ...originalProfile, profileId: otherProfile.id };
      try {
        const conflict = await within(reconnect(freshContext()), "different author replay");
        expect(conflict).toHaveBeenCalledWith(
          false,
          expect.objectContaining({ status: "error" }),
          expect.objectContaining({
            code: "UNAVAILABLE",
            message: expect.stringContaining("conflicts with the accepted input"),
          }),
          expect.anything(),
        );
      } finally {
        fixture.client.authenticatedUserProfile = originalProfile;
      }
      expect(recoveredDispatch).toHaveBeenCalledOnce();
      expect(fixture.beforeApprove).toHaveBeenCalledOnce();
      expect(readCompletion()).toEqual(completion);
      expect(loadTranscriptEventsSync(fixture.scope)).toEqual(transcript);
      expect(listSessionPendingInputs(fixture.scope).items).toEqual([]);
    } finally {
      resumedRelease.resolve();
      try {
        const cleanupCompletion =
          resumedCompletion ??
          getSessionWorkAdmissionRelease({
            scope: fixture.scope.storePath,
            identities: [fixture.scope.sessionKey, fixture.scope.sessionId],
          });
        if (cleanupCompletion) {
          await within(cleanupCompletion, "recovery cleanup");
        }
      } finally {
        await within(fixture.cleanup(), "fixture cleanup");
      }
    }
  },
);

it("does not publish terminal success when durable input completion fails", async () => {
  const fixture = await createFixture({ preserveContent: true, persistDuringDispatch: true });
  const profile = ensureProfileForEmail("completion-write-failure@example.test");
  fixture.client.authenticatedUserProfile = {
    profileId: profile.id,
    displayName: "Input author",
    hasAvatar: false,
    updatedAt: 1,
  };
  try {
    await within(fixture.send(), "completion failure ACK");
    const recorder = await within(fixture.dispatchedRecorder, "completion failure recorder");
    const complete = vi.fn(() => {
      throw new Error("required completion write unavailable");
    });
    recorder.completeProcessing = complete;
    vi.mocked(fixture.context.broadcast).mockClear();
    await within(fixture.finishDispatch(), "completion failure settlement");
    expect(complete).toHaveBeenCalledOnce();
    expect(
      vi
        .mocked(fixture.context.broadcast)
        .mock.calls.some(
          ([event, payload]) =>
            event === "chat" && (payload as { state?: string }).state === "final",
        ),
    ).toBe(false);
    expect(fixture.context.dedupe.get(`chat:${fixture.params.idempotencyKey}`)?.ok).toBe(false);
  } finally {
    await fixture.cleanup();
  }
});
