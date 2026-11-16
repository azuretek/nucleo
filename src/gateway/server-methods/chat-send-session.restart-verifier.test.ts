import { describe, expect, it } from "vitest";
import { registerAgentSessionLoopTestLifecycle } from "../../agents/sessions/agent-session-loop-correctness.test-support.js";
import { patchSessionEntryCore } from "../../config/sessions/session-accessor.js";
import { installGatewayTestHooks } from "../test-helpers.js";
import { createRestartSafeChatRequest } from "./chat-restart-recovery.js";
import { useBrowserFollowupFixture } from "./chat-send-pending-inputs.test-support.js";
import { resolveChatSendRequestConflict } from "./chat-send-pre-admission.js";
import { normalizeChatSendRequest } from "./chat-send-request.js";
import { prepareChatSendSession } from "./chat-send-session.js";
installGatewayTestHooks();
registerAgentSessionLoopTestLifecycle();
const createBrowserFollowupFixture = useBrowserFollowupFixture();

type Fixture = Awaited<ReturnType<typeof createBrowserFollowupFixture>>;
const RECONNECT = { __controlUiReconnectResume: true };

function prepare(fixture: Fixture, params: Record<string, unknown>, client = fixture.client) {
  const normalized = normalizeChatSendRequest({ params, client });
  if (!normalized.ok) {
    throw new Error(normalized.error);
  }
  const prepared = prepareChatSendSession({
    request: normalized.value,
    client,
    context: fixture.context,
  });
  if (!prepared.ok) {
    throw new Error(String(prepared.error));
  }
  return { request: normalized.value, session: prepared.value };
}

function conflictFor(fixture: Fixture, prepared: ReturnType<typeof prepare>) {
  return resolveChatSendRequestConflict({
    request: prepared.request,
    session: prepared.session,
    context: fixture.context,
  } as Parameters<typeof resolveChatSendRequestConflict>[0]);
}

async function retainClaim(fixture: Fixture, sourceRunId: string, fingerprint?: string) {
  await patchSessionEntryCore(fixture.scope, () => ({
    restartRecoveryDeliverySourceRunId: sourceRunId,
    ...(fingerprint !== undefined
      ? { restartRecoveryDeliveryRequestFingerprint: fingerprint }
      : {}),
  }));
}

async function originalClaim() {
  const fixture = await createBrowserFollowupFixture({ active: false });
  // The Control UI sends its resolved sessionId with both the original and the reconnect.
  expect(fixture.params.sessionId).toBe(fixture.scope.sessionId);
  const original = prepare(fixture, { ...fixture.params });
  expect(original.request.reconnectResumeRequested).toBe(false);
  const fingerprint = original.session.restartSafeRequest?.fingerprint;
  expect(fingerprint).toMatch(/^hmac-sha256:v1:/);
  await retainClaim(fixture, fixture.params.idempotencyKey, fingerprint);
  return { fixture, fingerprint: fingerprint! };
}

const CONFLICT = { details: { reason: "chat-request-conflict" } };

describe("restart-safe verifier for a Control UI reconnect retry", () => {
  it("accepts the identical reconnect retry of a retained same-source claim", async () => {
    const { fixture, fingerprint } = await originalClaim();
    const retry = prepare(fixture, { ...fixture.params, ...RECONNECT });
    expect(retry.request.reconnectResumeRequested).toBe(true);
    expect(retry.request.requestIdentity).toBe(
      prepare(fixture, { ...fixture.params }).request.requestIdentity,
    );
    expect(conflictFor(fixture, retry)).toBeUndefined();
    expect(retry.session.restartSafeRequest?.fingerprint).toBe(fingerprint);
  });

  it("still accepts the identical unmarked retry", async () => {
    const { fixture } = await originalClaim();
    expect(conflictFor(fixture, prepare(fixture, { ...fixture.params }))).toBeUndefined();
  });

  it("rejects changed message bytes on reconnect", async () => {
    const { fixture } = await originalClaim();
    const retry = prepare(fixture, {
      ...fixture.params,
      ...RECONNECT,
      message: "Raw follow-up awaiting approval!",
    });
    expect(conflictFor(fixture, retry)).toMatchObject(CONFLICT);
  });

  it.each([
    [
      "mentions",
      { mentions: [{ profileId: "other-profile", start: 0, end: 3 }], senderIsOwner: true },
    ],
    ["owner", { senderIsOwner: false }],
  ] as const)(
    "rejects a reconnect whose retained claim differs only in %s",
    async (_label, variant) => {
      const fixture = await createBrowserFollowupFixture({ active: false });
      const stored = createRestartSafeChatRequest({
        eligible: true,
        message: fixture.params.message,
        cfg: fixture.context.getRuntimeConfig(),
        ...variant,
      });
      expect(stored?.fingerprint).toMatch(/^hmac-sha256:v1:/);
      await retainClaim(fixture, fixture.params.idempotencyKey, stored!.fingerprint);
      const retry = prepare(fixture, { ...fixture.params, ...RECONNECT });
      expect(retry.session.restartSafeRequest?.fingerprint).not.toBe(stored!.fingerprint);
      expect(conflictFor(fixture, retry)).toMatchObject(CONFLICT);
    },
  );

  it("rejects a reconnect from a non-owner client against an owner claim", async () => {
    const { fixture } = await originalClaim();
    const client = {
      ...fixture.client,
      connect: { ...fixture.client.connect!, scopes: ["operator.read", "operator.write"] },
    };
    const retry = prepare(fixture, { ...fixture.params, ...RECONNECT }, client);
    expect(conflictFor(fixture, retry)).toMatchObject(CONFLICT);
  });

  it("gives a reconnect no verifier without a retained fingerprint", async () => {
    const fixture = await createBrowserFollowupFixture({ active: false });
    await retainClaim(fixture, fixture.params.idempotencyKey);
    expect(
      prepare(fixture, { ...fixture.params, ...RECONNECT }).session.restartSafeRequest,
    ).toBeUndefined();
  });

  it("never admits an empty retained fingerprint", async () => {
    const fixture = await createBrowserFollowupFixture({ active: false });
    await retainClaim(fixture, fixture.params.idempotencyKey, "");
    const retry = prepare(fixture, { ...fixture.params, ...RECONNECT });
    expect(retry.session.restartSafeRequest?.fingerprint).not.toBe("");
    expect(conflictFor(fixture, retry)).toMatchObject(CONFLICT);
    const unsafe = prepare(fixture, { ...fixture.params, ...RECONNECT, message: "/status" });
    expect(unsafe.session.restartSafeRequest).toBeUndefined();
    expect(conflictFor(fixture, unsafe)).toMatchObject(CONFLICT);
  });

  it("gives a reconnect no verifier for another source run's claim", async () => {
    const fixture = await createBrowserFollowupFixture({ active: false });
    await retainClaim(fixture, "another-source-run", "hmac-sha256:v1:other:retained");
    expect(
      prepare(fixture, { ...fixture.params, ...RECONNECT }).session.restartSafeRequest,
    ).toBeUndefined();
  });

  it("gives a fresh reconnect no verifier", async () => {
    const fixture = await createBrowserFollowupFixture({ active: false });
    const retry = prepare(fixture, { ...fixture.params, ...RECONNECT });
    expect(retry.request.reconnectResumeRequested).toBe(true);
    expect(retry.session.restartSafeRequest).toBeUndefined();
  });

  it.each([
    [
      "attachments",
      {
        attachments: [
          {
            type: "file",
            mimeType: "text/plain",
            fileName: "a.txt",
            content: Buffer.from("bytes").toString("base64"),
          },
        ],
      },
    ],
    ["thinking override", { thinking: "high" }],
    ["timeout override", { timeoutMs: 1000 }],
    ["slash command", { message: "/status" }],
    ["bang command", { message: "!status" }],
  ] as const)("keeps a same-source reconnect with %s ineligible", async (_label, extra) => {
    const { fixture } = await originalClaim();
    const retry = prepare(fixture, { ...fixture.params, ...RECONNECT, ...extra });
    expect(retry.session.restartSafeRequest).toBeUndefined();
    expect(conflictFor(fixture, retry)).toMatchObject(CONFLICT);
  });

  it("keeps the reserved marker rejected for a public webchat client", async () => {
    const fixture = await createBrowserFollowupFixture({ active: false });
    const client = {
      ...fixture.client,
      connect: {
        ...fixture.client.connect!,
        client: {
          id: "webchat-ui" as const,
          version: "test",
          platform: "web",
          mode: "webchat" as const,
        },
      },
    };
    const normalized = normalizeChatSendRequest({
      params: { ...fixture.params, ...RECONNECT },
      client,
    });
    expect(normalized.ok).toBe(false);
    expect(normalized.ok ? "" : normalized.error).toContain("__controlUiReconnectResume");
  });
});
