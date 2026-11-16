import type { AgentRunTerminalOutcome } from "../agents/agent-run-terminal-outcome.js";

export type ChatRunTiming = {
  ackedAtMs: number;
  connId: string;
  dispatchStartedAtMs?: number;
  firstAssistantEventSent?: boolean;
  receivedAtMs: number;
};

export type ChatRunRegistration = {
  sessionKey: string;
  agentId?: string;
  clientRunId: string;
  chatSendTiming?: ChatRunTiming;
  beforeTerminalPublication?: (outcome: AgentRunTerminalOutcome) => void;
};
