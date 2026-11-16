import { withOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly.js";
import { hasSessionInputCompletionsSchema } from "../../state/openclaw-agent-pending-inputs-schema.js";
import type { SessionAccessScope } from "./session-accessor.sqlite-contract.js";
import { readSessionInputCompletion } from "./session-accessor.sqlite-pending-inputs.js";
import {
  resolveSqliteTranscriptScope,
  toDatabaseOptions,
} from "./session-accessor.sqlite-scope.js";

type InputCompletionScope = SessionAccessScope & { agentId: string; sessionId: string };

/**
 * Read one input's committed completion for a retry answer; this never authorizes replay.
 * A missing store or table reads as no row; a store that cannot be read throws.
 */
export function readSessionInputCompletionForRetry(
  scope: InputCompletionScope,
  idempotencyKey: string,
): ReturnType<typeof readSessionInputCompletion> {
  const resolved = resolveSqliteTranscriptScope(scope);
  const result = withOpenClawAgentDatabaseReadOnly(
    (database) =>
      hasSessionInputCompletionsSchema(database.db)
        ? readSessionInputCompletion(database, { ...resolved, idempotencyKey })
        : undefined,
    toDatabaseOptions(resolved),
  );
  return result.found ? result.value : undefined;
}
