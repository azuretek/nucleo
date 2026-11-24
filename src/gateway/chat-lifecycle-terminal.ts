import { isAgentLifecycleYieldedWaiting } from "../agents/agent-lifecycle-parent-state.js";
import {
  buildAgentRunTerminalOutcomeFromLifecycleEvent,
  classifyAgentRunTerminalOutcome,
  type AgentRunTerminalOutcome,
} from "../agents/agent-run-terminal-outcome.js";
import type { AgentEventRuntimePayload } from "../infra/agent-events.js";
import { formatErrorMessage } from "../infra/errors.js";

const CHAT_STATE_BY_TERMINAL_CLASSIFICATION = {
  success: "done",
  timeout: "error",
  cancellation: "aborted",
  failure: "error",
} as const;

/** Commit only the exact chat registration's successful input before native terminal projection. */
export function prepareChatLifecycleTerminal(
  inputEvent: AgentEventRuntimePayload,
  inputPhase: "end" | "error",
  beforeTerminalPublication?: (outcome: AgentRunTerminalOutcome) => void,
) {
  let event = inputEvent;
  let phase = inputPhase;
  let terminalOutcome = buildAgentRunTerminalOutcomeFromLifecycleEvent({
    phase,
    data: event.data,
    endedAt: event.data?.endedAt ?? event.ts,
  });
  let yieldedWaiting = isAgentLifecycleYieldedWaiting({
    phase,
    yielded: event.data?.yielded,
    livenessState: event.data?.livenessState,
    stopReason: terminalOutcome.stopReason,
    aborted: event.data?.aborted === true,
    status: event.data?.status,
    timeoutPhase: event.data?.timeoutPhase,
    error: event.data?.error,
  });
  if (classifyAgentRunTerminalOutcome(terminalOutcome) === "success" && !yieldedWaiting) {
    try {
      beforeTerminalPublication?.(terminalOutcome);
    } catch (error) {
      phase = "error";
      event = {
        ...event,
        data: {
          ...event.data,
          phase,
          status: "error",
          stopReason: "error",
          error: formatErrorMessage(error),
        },
      };
      terminalOutcome = buildAgentRunTerminalOutcomeFromLifecycleEvent({
        phase,
        data: event.data,
        endedAt: event.data?.endedAt ?? event.ts,
      });
      yieldedWaiting = false;
    }
  }
  const terminalClassification = classifyAgentRunTerminalOutcome(terminalOutcome);
  return {
    event,
    phase,
    terminalOutcome,
    yieldedWaiting,
    terminalClassification,
    terminalState: CHAT_STATE_BY_TERMINAL_CLASSIFICATION[terminalClassification],
  };
}
