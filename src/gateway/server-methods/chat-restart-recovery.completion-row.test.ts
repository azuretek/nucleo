import { createHash } from "node:crypto";
import { stableStringify } from "@openclaw/normalization-core/stable-stringify";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorCodes } from "../../../packages/gateway-protocol/src/index.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { pendingChatSendDedupeKey } from "../server-shared.js";
import { runChatSendPreAdmission } from "./chat-send-pre-admission.js";

const readRow = vi.hoisted(() => vi.fn());
vi.mock("../../config/sessions/session-accessor.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../config/sessions/session-accessor.js")>()),
  readSessionInputCompletionForRetry: readRow,
}));

const RUN = "original-run";
const SESSION_ID = "recovery-session";
const SESSION_KEY = "agent:main:recovery";
const PROFILE = "profile-1";
const p = { sessionKey: SESSION_KEY, idempotencyKey: RUN, message: "hello" };

// Independent of product code: the admission recorder's request-hash formula, written out.
const matchingHash =
  "request:" +
  createHash("sha256")
    .update(
      stableStringify([
        { ...p, sessionId: SESSION_ID, expectedLeafEntryId: undefined },
        { type: "profile", id: PROFILE },
        false,
      ]),
    )
    .digest("hex");

function row(outcome: Record<string, unknown>, requestHash = matchingHash) {
  return {
    session_key: SESSION_KEY,
    session_id: SESSION_ID,
    idempotency_key: RUN + ":user",
    run_id: RUN,
    request_hash: requestHash,
    outcome_json: JSON.stringify(outcome),
    succeeded: outcome.reason === "completed" ? 1 : 0,
    completed_at: 200,
    outcome,
  };
}

function settledRetry(entry: Partial<SessionEntry>) {
  const respond = vi.fn();
  const params = {
    client: { authenticatedUserProfile: { profileId: PROFILE }, connect: { scopes: [] } },
    context: createDirectChatContext(),
    respond,
    request: {
      rawMessage: "hello",
      requestIdentity: "original-request",
      p,
      chatSendReceivedAtMs: 100,
      supportsTaskSuggestions: false,
      inboundMessage: "hello",
      suppressCommandInterpretation: false,
      stopCommand: false,
      turnKind: "main",
      normalizedAttachments: [],
      reconnectResumeRequested: true,
    },
    session: {
      clientRunId: RUN,
      pendingChatSendKey: pendingChatSendDedupeKey(RUN),
      entry: {
        sessionId: SESSION_ID,
        updatedAt: 100,
        status: "done",
        abortedLastRun: false,
        restartRecoveryTerminalRunIds: [RUN, "recovery-run"],
        ...entry,
      },
      agentId: "main",
      sessionKey: SESSION_KEY,
      storePath: "/tmp/completion-row.sqlite",
      restartSafeRequest: undefined,
      cfg: {},
      rawSessionKey: SESSION_KEY,
      sessionLoadKey: SESSION_KEY,
      sessionLoadOptions: { agentId: "main" },
      sessionLoadMs: 0,
      legacyKey: undefined,
      sessionRoutingChanged: () => false,
      expectedLeafEntryId: undefined,
      agentIdOverride: undefined,
      requestedAgentId: "main",
      selectedAgent: { ok: true, agentId: "main" },
      requestedSessionId: SESSION_ID,
      backingSessionId: SESSION_ID,
      resolvedSessionModel: { provider: "openai", model: "gpt-4.1" },
      resolvedSessionAuthProvider: "openai",
      timeoutMs: 1000,
      now: 100,
    },
  } as unknown as Parameters<typeof runChatSendPreAdmission>[0];
  return { params, respond };
}

async function answer(entry: Partial<SessionEntry> = {}) {
  const { params, respond } = settledRetry(entry);
  expect(await runChatSendPreAdmission(params)).toBe(false);
  expect(respond).toHaveBeenCalledTimes(1);
  expect(params.context.dedupe.has("chat:" + RUN)).toBe(false);
  return respond.mock.calls[0] ?? [];
}

beforeEach(() => readRow.mockReset());

describe("settled restart-recovery retry is answered by the committed completion row", () => {
  it("does not answer ok when the row records a failed outcome", async () => {
    readRow.mockReturnValue(row({ status: "error", reason: "failed", error: "provider exploded" }));
    const [ok, payload, error] = await answer();
    expect(payload).not.toEqual(expect.objectContaining({ status: "ok" }));
    expect(ok).toBe(false);
    expect(error).toEqual(
      expect.objectContaining({ code: ErrorCodes.UNAVAILABLE, message: "provider exploded" }),
    );
  });

  it("does not answer ok when the row records a cancellation", async () => {
    readRow.mockReturnValue(
      row({ status: "ok", reason: "cancelled", stopReason: "aborted", endedAt: 300 }),
    );
    const [ok, payload] = await answer();
    expect(ok).toBe(true);
    expect(payload).toEqual(
      expect.objectContaining({ runId: RUN, status: "timeout", summary: "aborted", endedAt: 300 }),
    );
  });

  it("answers chat-request-conflict when the row's request hash differs", async () => {
    readRow.mockReturnValue(row({ status: "ok", reason: "completed" }, "request:other-input"));
    const [ok, payload, error] = await answer();
    expect(ok).toBe(false);
    expect(payload).toBeUndefined();
    expect(error).toEqual(
      expect.objectContaining({
        code: ErrorCodes.INVALID_REQUEST,
        details: { reason: "chat-request-conflict" },
      }),
    );
  });

  it("answers ok from a succeeded row after reading the original input's key", async () => {
    readRow.mockReturnValue(row({ status: "ok", reason: "completed" }));
    expect(await answer()).toEqual([
      true,
      { runId: RUN, status: "ok" },
      undefined,
      expect.objectContaining({ cached: true, runId: RUN }),
    ]);
    expect(readRow).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "main", sessionId: SESSION_ID, sessionKey: SESSION_KEY }),
      RUN + ":user",
    );
  });

  it("keeps today's ok answer when no row exists", async () => {
    readRow.mockReturnValue(undefined);
    expect(await answer()).toEqual([
      true,
      { runId: RUN, status: "ok" },
      undefined,
      expect.objectContaining({ cached: true, runId: RUN }),
    ]);
  });

  it("answers retryable UNAVAILABLE, never ok, when the completion store cannot be read", async () => {
    readRow.mockImplementationOnce(() => {
      throw new Error("database is locked");
    });
    const [ok, payload, error] = await answer();
    expect(ok).toBe(false);
    expect(payload).toBeUndefined();
    expect(error).toEqual(
      expect.objectContaining({
        code: ErrorCodes.UNAVAILABLE,
        retryable: true,
        message: expect.stringContaining("could not be verified"),
      }),
    );
  });

  it("never consults the row while recovery is still in flight", async () => {
    readRow.mockReturnValue(row({ status: "error", reason: "failed", error: "provider exploded" }));
    const [ok, payload] = await answer({
      status: "running",
      restartRecoveryDeliveryRunId: "recovery-run",
      restartRecoveryDeliverySourceRunId: RUN,
    });
    expect([ok, payload]).toEqual([true, { runId: RUN, status: "in_flight" }]);
    expect(readRow).not.toHaveBeenCalled();
  });
});
