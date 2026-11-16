import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../../config/sessions/types.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { pendingChatSendDedupeKey } from "../server-shared.js";
import { resolveDurableChatClaim } from "./chat-restart-recovery.js";
import { runChatSendPreAdmission } from "./chat-send-pre-admission.js";

vi.mock("./chat-restart-recovery.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./chat-restart-recovery.js")>()),
  resolveDurableChatClaim: vi.fn(),
}));

const RUN = "original-run";

async function resolveActual(entry: SessionEntry) {
  const actual = await vi.importActual<typeof import("./chat-restart-recovery.js")>(
    "./chat-restart-recovery.js",
  );
  return actual.resolveDurableChatClaim({
    canonicalSessionKey: "agent:main:recovery",
    cfg: {},
    clientRunId: RUN,
    entry,
    persistedSessionKey: "agent:main:recovery",
    reloadEntry: () => entry,
    storePath: "/tmp/recovery.sqlite",
    warn: () => {},
  });
}

function preAdmission() {
  const respond = vi.fn();
  const sessionKey = "agent:main:recovery";
  const params = {
    client: null,
    context: createDirectChatContext(),
    respond,
    request: {
      rawMessage: "hello",
      requestIdentity: "original-request",
      p: { sessionKey, idempotencyKey: RUN, message: "hello" },
      chatSendReceivedAtMs: 100,
      supportsTaskSuggestions: false,
      inboundMessage: "hello",
      suppressCommandInterpretation: false,
      stopCommand: false,
      turnKind: "main",
      normalizedAttachments: [],
      reconnectResumeRequested: false,
    },
    session: {
      clientRunId: RUN,
      pendingChatSendKey: pendingChatSendDedupeKey(RUN),
      entry: { sessionId: "recovery-session", updatedAt: 100 },
      agentId: "main",
      sessionKey,
      storePath: "/tmp/recovery.sqlite",
      restartSafeRequest: undefined,
      cfg: {},
      rawSessionKey: sessionKey,
      sessionLoadKey: sessionKey,
      sessionLoadOptions: { agentId: "main" },
      sessionLoadMs: 0,
      legacyKey: undefined,
      sessionRoutingChanged: () => false,
      expectedLeafEntryId: undefined,
      agentIdOverride: undefined,
      requestedAgentId: "main",
      selectedAgent: { ok: true, agentId: "main" },
      requestedSessionId: undefined,
      backingSessionId: "recovery-session",
      resolvedSessionModel: { provider: "openai", model: "gpt-4.1" },
      resolvedSessionAuthProvider: "openai",
      timeoutMs: 1000,
      now: 100,
    },
  } as unknown as Parameters<typeof runChatSendPreAdmission>[0];
  return { params, respond };
}

beforeEach(() => vi.mocked(resolveDurableChatClaim).mockReset());

describe("identical retry while adopted restart recovery runs", () => {
  it("reports an adopted, running recovery as in flight", async () => {
    expect(
      await resolveActual({
        sessionId: "recovery-session",
        updatedAt: 100,
        status: "running",
        abortedLastRun: false,
        restartRecoveryDeliveryRunId: RUN,
        restartRecoveryDeliverySourceRunId: RUN,
      }),
    ).toEqual({ kind: "accepted", inFlight: true });
  });

  it("reports a source tombstoned mid-run, completion still owed, as in flight", async () => {
    expect(
      await resolveActual({
        sessionId: "recovery-session",
        updatedAt: 100,
        status: "running",
        restartRecoveryTerminalRunIds: [RUN, "recovery-run"],
        restartRecoveryInputCompletion: {
          sourceRunId: RUN,
          sessionId: "recovery-session",
          idempotencyKey: RUN + ":user",
          requestHash: "request:x",
          lifecycleGeneration: "g0",
        },
      } as SessionEntry),
    ).toEqual({ kind: "accepted", inFlight: true });
  });

  it("reports a settled source as completed", async () => {
    expect(
      await resolveActual({
        sessionId: "recovery-session",
        updatedAt: 100,
        status: "done",
        restartRecoveryTerminalRunIds: [RUN],
      }),
    ).toEqual({ kind: "accepted", inFlight: false });
  });

  it("keeps an old completed source ok while a different run is active", async () => {
    expect(
      await resolveActual({
        sessionId: "recovery-session",
        updatedAt: 100,
        status: "running",
        restartRecoveryTerminalRunIds: [RUN],
      }),
    ).toEqual({ kind: "accepted", inFlight: false });
  });

  it.each([
    [true, "in_flight"],
    [false, "ok"],
  ] as const)(
    "answers the retry with %s -> %s and dispatches nothing",
    async (inFlight, status) => {
      vi.mocked(resolveDurableChatClaim).mockResolvedValue({ kind: "accepted", inFlight } as never);
      const { params, respond } = preAdmission();
      expect(await runChatSendPreAdmission(params)).toBe(false);
      expect(respond).toHaveBeenCalledWith(
        true,
        { runId: RUN, status },
        undefined,
        expect.objectContaining({ cached: true, runId: RUN }),
      );
      expect(params.context.dedupe.has("chat:" + RUN)).toBe(false);
    },
  );
});
