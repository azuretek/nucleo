import type { AgentRunTerminalOutcome } from "../../agents/agent-run-terminal-outcome.types.js";
import { getAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { hasSessionPendingInputsSchema } from "../../state/openclaw-agent-pending-inputs-schema.js";
import { hasRestartRecoveryTerminalRun } from "./restart-recovery-state.js";
import { writeSessionInputCompletion } from "./session-accessor.sqlite-pending-inputs.js";
import type { SessionEntry } from "./types.js";

const RECOVERED_INPUT_OUTCOME = { status: "ok", reason: "completed" } as AgentRunTerminalOutcome;

/**
 * A crash strands the original input's completion owner. When a later process adopts that
 * exact input and the session commits done with the source tombstoned, this same row write
 * records the original's completion, so cross-process retries see an outcome-bearing receipt.
 * Non-final outcomes, the original process, and unrelated runs only retire the descriptor.
 */
export function settleRestartRecoveryInputCompletion(
  database: OpenClawAgentDatabase,
  sessionKey: string,
  entry: SessionEntry,
): SessionEntry {
  const owed = entry.restartRecoveryInputCompletion;
  if (!owed) {
    return entry;
  }
  if (owed.sessionId === entry.sessionId) {
    if (!hasRestartRecoveryTerminalRun(entry, owed.sourceRunId) || entry.status === "running") {
      return entry;
    }
    const currentGeneration = getAgentEventLifecycleGeneration();
    if (
      entry.status === "done" &&
      owed.lifecycleGeneration !== currentGeneration &&
      hasSessionPendingInputsSchema(database.db)
    ) {
      writeSessionInputCompletion(
        database,
        {
          sessionKey,
          sessionId: entry.sessionId,
          idempotencyKey: owed.idempotencyKey,
          runId: owed.sourceRunId,
          requestHash: owed.requestHash,
          lifecycleGeneration: currentGeneration,
        },
        RECOVERED_INPUT_OUTCOME,
      );
    }
  }
  const { restartRecoveryInputCompletion: _settled, ...settled } = entry;
  return settled;
}
