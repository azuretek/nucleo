import { createHash } from "node:crypto";
import { stableStringify } from "@openclaw/normalization-core/stable-stringify";
import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import { classifyAgentRunTerminalOutcome } from "../../agents/agent-run-terminal-outcome.js";
import { buildAbortedChatSendPayload } from "./chat-abort-authorization.js";
import { hasGatewayAdminScope } from "./chat-origin-routing.js";
import type { DurableChatInputCompletion } from "./chat-restart-recovery.js";
import type { NormalizedChatSendRequest } from "./chat-send-request.js";
import { gatewayClientSenderFields } from "./gateway-client-identity.js";
import type { GatewayClient } from "./shared-types.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

/**
 * Attribution and submitted bytes survive reconnect; display names, leaf cursors and
 * generated media paths are not immutable request identity. Admission and the
 * cross-process retry answer share this one derivation, so their hashes agree.
 */
export function resolveChatSendInputRequestFingerprint(params: {
  client: GatewayClient | null;
  request: Pick<NormalizedChatSendRequest, "goalOperation" | "p">;
  sessionId: string;
}): string | undefined {
  const sender = gatewayClientSenderFields(params.client).sender;
  if (!sender?.id || params.request.goalOperation) {
    return undefined;
  }
  return createHash("sha256")
    .update(
      stableStringify([
        { ...params.request.p, sessionId: params.sessionId, expectedLeafEntryId: undefined },
        sender.identity ?? sender.id,
        hasGatewayAdminScope(params.client),
      ]),
    )
    .digest("hex");
}

/** One conflict shape for RAM, tombstone and committed-completion retries. */
export function chatRequestConflictError(unverifiable = false) {
  return errorShape(
    ErrorCodes.INVALID_REQUEST,
    unverifiable
      ? "The previous mention selections cannot be verified. Check the conversation history and use a new message ID to send again."
      : "This message ID was already used for different input. Check the conversation history and use a new message ID to send again.",
    { details: { reason: "chat-request-conflict" } },
  );
}

/** A committed input completion, not its tombstone, answers a retry; only success is ok. */
export function respondDurableInputCompletion(params: {
  completion: DurableChatInputCompletion;
  respond: GatewayRequestHandlerOptions["respond"];
  runId: string;
}) {
  const { completion, respond, runId } = params;
  const meta = { cached: true, runId };
  if (completion.kind === "conflict") {
    respond(false, undefined, chatRequestConflictError(), meta);
    return;
  }
  if (completion.kind === "unverified") {
    const message = "The outcome of this message could not be verified; retry.";
    respond(
      false,
      undefined,
      errorShape(ErrorCodes.UNAVAILABLE, message, { retryable: true }),
      meta,
    );
    return;
  }
  const { outcome } = completion;
  const classification = classifyAgentRunTerminalOutcome(outcome);
  if (classification === "success") {
    respond(true, { runId, status: "ok" as const }, undefined, meta);
  } else if (classification === "cancellation") {
    const payload = buildAbortedChatSendPayload({
      runId,
      endedAt: outcome.endedAt ?? Date.now(),
      ...(outcome.stopReason ? { stopReason: outcome.stopReason } : {}),
    });
    respond(true, payload, undefined, meta);
  } else {
    const message = outcome.error ?? "agent returned an error payload";
    respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, message), meta);
  }
}
