import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildRestartSafeChatTranscriptState } from "../../gateway/server-methods/chat-restart-recovery.js";
import {
  getAgentEventLifecycleGeneration,
  resetAgentEventsForTest,
  rotateAgentEventLifecycleGeneration,
} from "../../infra/agent-events.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  loadSessionEntry,
  patchSessionEntryCore,
  replaceSessionEntry,
} from "./session-accessor.js";
import { readSessionInputCompletion } from "./session-accessor.sqlite-pending-inputs.js";
import { resolveSqliteScope, toDatabaseOptions } from "./session-accessor.sqlite-scope.js";
import type { SessionEntry } from "./types.js";

const SOURCE = "source-run";
const SESSION_ID = "recovery-session";
const REQUEST_HASH = "request:original-fingerprint";

type Descriptor = {
  sourceRunId: string;
  sessionId: string;
  idempotencyKey: string;
  requestHash: string;
  lifecycleGeneration: string;
};
type EntryWithDescriptor = SessionEntry & { restartRecoveryInputCompletion?: Descriptor };

function seed(lifecycleGeneration: string): SessionEntry {
  const entry: EntryWithDescriptor = {
    sessionId: SESSION_ID,
    updatedAt: 1_000,
    startedAt: 1_000,
    status: "running",
    abortedLastRun: false,
    restartRecoveryDeliveryRunId: SOURCE,
    restartRecoveryDeliverySourceRunId: SOURCE,
    restartRecoveryInputCompletion: {
      sourceRunId: SOURCE,
      sessionId: SESSION_ID,
      idempotencyKey: `${SOURCE}:user`,
      requestHash: REQUEST_HASH,
      lifecycleGeneration,
    },
  };
  return entry;
}

function withTarget(
  run: (h: {
    target: { agentId: string; storePath: string; sessionKey: string };
    read: () => EntryWithDescriptor | undefined;
    completion: () => ReturnType<typeof readSessionInputCompletion>;
  }) => Promise<void>,
) {
  return withOpenClawTestState({ label: "recovery-input-completion" }, async (state) => {
    const target = {
      agentId: "main",
      storePath: state.statePath("agents", "main", "sessions", "sessions.json"),
      sessionKey: "agent:main:recovery-completion",
    };
    const read = () =>
      loadSessionEntry({ ...target, readConsistency: "latest" }) as EntryWithDescriptor | undefined;
    const completion = () =>
      readSessionInputCompletion(
        openOpenClawAgentDatabase(toDatabaseOptions(resolveSqliteScope(target))),
        {
          sessionKey: target.sessionKey,
          sessionId: SESSION_ID,
          idempotencyKey: `${SOURCE}:user`,
        },
      );
    await run({ target, read, completion });
  });
}

beforeEach(() => resetAgentEventsForTest({ preserveListeners: true }));
afterEach(() => resetAgentEventsForTest({ preserveListeners: true }));

describe("restart recovery adopting the original input", () => {
  it("records the original completion row in the commit that settles the session done", () =>
    withTarget(async ({ target, read, completion }) => {
      await replaceSessionEntry(target, seed(getAgentEventLifecycleGeneration()));
      rotateAgentEventLifecycleGeneration();
      // Mid-run claim cleanup tombstones the source while the recovery run still executes.
      await patchSessionEntryCore(target, () => ({
        restartRecoveryDeliveryRunId: undefined,
        restartRecoveryDeliverySourceRunId: undefined,
        restartRecoveryTerminalRunIds: [SOURCE, "recovery-run"],
        updatedAt: 1_500,
      }));
      expect(completion()).toBeUndefined();
      expect(read()?.restartRecoveryInputCompletion?.sourceRunId).toBe(SOURCE);
      await patchSessionEntryCore(target, () => ({
        status: "done",
        endedAt: 2_000,
        updatedAt: 2_000,
      }));
      expect(read()?.status).toBe("done");
      expect(read()?.restartRecoveryInputCompletion).toBeUndefined();
      expect(completion()).toMatchObject({
        run_id: SOURCE,
        session_id: SESSION_ID,
        request_hash: REQUEST_HASH,
        succeeded: 1,
        outcome: { status: "ok", reason: "completed" },
      });
    }));

  it("writes no row for a non-final recovery outcome", () =>
    withTarget(async ({ target, read, completion }) => {
      await replaceSessionEntry(target, seed(getAgentEventLifecycleGeneration()));
      rotateAgentEventLifecycleGeneration();
      await patchSessionEntryCore(target, () => ({
        status: "failed",
        restartRecoveryTerminalRunIds: [SOURCE],
        updatedAt: 2_000,
      }));
      expect(completion()).toBeUndefined();
      expect(read()?.restartRecoveryInputCompletion).toBeUndefined();
    }));

  it("leaves the original owner to complete its own input when no restart happened", () =>
    withTarget(async ({ target, read, completion }) => {
      await replaceSessionEntry(target, seed(getAgentEventLifecycleGeneration()));
      await patchSessionEntryCore(target, () => ({
        status: "done",
        restartRecoveryTerminalRunIds: [SOURCE],
        updatedAt: 2_000,
      }));
      expect(completion()).toBeUndefined();
      expect(read()?.restartRecoveryInputCompletion).toBeUndefined();
    }));

  it("writes no row for a recovery that did not adopt this input", () =>
    withTarget(async ({ target, read, completion }) => {
      await replaceSessionEntry(target, seed(getAgentEventLifecycleGeneration()));
      rotateAgentEventLifecycleGeneration();
      await patchSessionEntryCore(target, () => ({
        status: "done",
        restartRecoveryTerminalRunIds: ["unrelated-run"],
        updatedAt: 2_000,
      }));
      expect(completion()).toBeUndefined();
      expect(read()?.restartRecoveryInputCompletion?.sourceRunId).toBe(SOURCE);
    }));

  it("persists the completion descriptor with the restart-safe admission patch", () => {
    const withDescriptor = buildRestartSafeChatTranscriptState({
      admission: { requestFingerprint: "hmac" },
      clientRunId: SOURCE,
      startedAt: 1_000,
      inputCompletion: { sessionId: SESSION_ID, requestHash: REQUEST_HASH },
    } as Parameters<typeof buildRestartSafeChatTranscriptState>[0]);
    expect(
      (withDescriptor.sessionLifecyclePatch as { restartRecoveryInputCompletion?: Descriptor })
        .restartRecoveryInputCompletion,
    ).toEqual({
      sourceRunId: SOURCE,
      sessionId: SESSION_ID,
      idempotencyKey: `${SOURCE}:user`,
      requestHash: REQUEST_HASH,
      lifecycleGeneration: getAgentEventLifecycleGeneration(),
    });
    const without = buildRestartSafeChatTranscriptState({
      admission: { requestFingerprint: "hmac" },
      clientRunId: SOURCE,
      startedAt: 1_000,
    });
    expect(
      (without.sessionLifecyclePatch as { restartRecoveryInputCompletion?: Descriptor })
        .restartRecoveryInputCompletion,
    ).toBeUndefined();
  });
});
