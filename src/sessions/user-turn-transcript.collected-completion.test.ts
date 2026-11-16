import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { buildAgentRunTerminalOutcome } from "../agents/agent-run-terminal-outcome.js";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import { rotateAgentEventLifecycleGeneration } from "../infra/agent-events.js";
import {
  closeOpenClawAgentDatabasesForTest,
  closeOpenClawAgentDatabasesAsync,
} from "../state/openclaw-agent-db.js";
import { createUserTurnTranscriptRecorder } from "./user-turn-transcript.js";
import {
  createSqliteTranscriptTarget,
  readTranscriptMessages,
} from "./user-turn-transcript.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
it("composes collected recorder completion for every original source across physical reopen", async () => {
  const target = createSqliteTranscriptTarget({ dir: tempDirs.make("collected-completion-") });
  await replaceSessionEntry(target, { sessionId: target.sessionId, updatedAt: 1 });
  const createSource = (id: string) =>
    createUserTurnTranscriptRecorder({
      input: { text: `Accepted ${id}`, idempotencyKey: `${id}:user` },
      target,
      trackInputCompletion: true,
    });
  const sources = [createSource("first"), createSource("second")];
  for (const [index, source] of sources.entries()) {
    expect(
      await source.stageApproved?.({ runId: `collect-${index}`, assertCurrent: () => {} }),
    ).toBe(true);
  }
  const aggregate = createUserTurnTranscriptRecorder({
    input: { text: "Accepted first\nAccepted second", idempotencyKey: "aggregate:completed:user" },
    pendingInputSources: sources,
    target,
  });
  expect(await aggregate.persistApproved()).toMatchObject({ appended: true });
  expect(
    aggregate.completeProcessing?.(buildAgentRunTerminalOutcome({ status: "ok" })),
  ).toMatchObject({ status: "ok" });
  aggregate.finishPendingInput?.("interrupted");
  rotateAgentEventLifecycleGeneration();
  closeOpenClawAgentDatabasesForTest();
  await closeOpenClawAgentDatabasesAsync();
  for (const [index, id] of ["first", "second"].entries()) {
    const replay = createSource(id);
    expect(
      await replay.stageApproved?.({ runId: `collect-${index}`, assertCurrent: () => {} }),
    ).toBe(false);
    expect(replay.getProcessingCompletion?.()).toMatchObject({ status: "ok", reason: "completed" });
    replay.finishPendingInput?.("interrupted");
  }
  expect(await readTranscriptMessages(target)).toHaveLength(1);
});
