import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import {
  buildAgentRunTerminalOutcome,
  classifyAgentRunTerminalOutcome,
  type AgentRunTerminalOutcome,
} from "../../agents/agent-run-terminal-outcome.js";
import type { UserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import { broadcastChatError } from "./chat-broadcast.js";

/** Processing custody commits before any terminal publication; interrupted or queued work stays recoverable. */
export function publishChatSendProcessingCompletion(params: {
  aborted: boolean;
  failed: boolean;
  cancelled: boolean;
  queued: boolean;
  recorder: UserTurnTranscriptRecorder;
  outcome?: AgentRunTerminalOutcome;
  publications: readonly (() => void)[];
}) {
  if (!params.aborted && !params.failed && !params.cancelled && !params.queued) {
    params.recorder.completeProcessing?.(
      params.outcome ?? buildAgentRunTerminalOutcome({ status: "ok" }),
    );
  }
  for (const publish of params.publications) {
    publish();
  }
}

/** ACP rich outcomes and native recorded outcomes are authoritative; warnings are not. */
export function resolveChatSendRuntimeClassification(
  outcome: AgentRunTerminalOutcome | undefined,
  recorded: "completed" | "failed" | undefined,
) {
  const runtimeClassification = outcome
    ? classifyAgentRunTerminalOutcome(outcome)
    : recorded && (recorded === "failed" ? "failure" : "success");
  return {
    runtimeClassification,
    runtimeCancelled: runtimeClassification === "cancellation",
    runtimeFailed: runtimeClassification === "failure" || runtimeClassification === "timeout",
  };
}

export function createChatSendInputCompletion(recorder: UserTurnTranscriptRecorder): () => void {
  return () => {
    recorder.completeProcessing?.(buildAgentRunTerminalOutcome({ status: "ok" }));
  };
}

export function publishChatSendFailure(
  failed: boolean,
  params: Parameters<typeof broadcastChatError>[0],
) {
  if (!failed) {
    return undefined;
  }
  broadcastChatError(params);
  return errorShape(
    ErrorCodes.UNAVAILABLE,
    params.errorMessage ?? "agent returned an error payload",
  );
}
