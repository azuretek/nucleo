import { describe, expect, it, vi } from "vitest";
import type { GatewayActiveWorkSnapshot } from "../../infra/gateway-active-work.js";
import { drainGatewayActiveWork } from "./run-loop-drain.js";
import {
  GATEWAY_STOP_DRAIN_HARD_LIMIT_MS,
  resolveGatewayShutdownDrainBudget,
} from "./run-loop-shutdown-budget.js";

const idleSnapshot = {
  idle: true,
  counts: { totalActive: 0, embeddedRuns: 0, cronRuns: 0 },
  blockers: [],
  writeCustody: {},
} as unknown as GatewayActiveWorkSnapshot;

const busySnapshot = {
  idle: false,
  counts: { totalActive: 1, embeddedRuns: 1, cronRuns: 0 },
  blockers: [],
  writeCustody: {},
} as unknown as GatewayActiveWorkSnapshot;

function createStopRuntime(drainResult: { drained: boolean; snapshot: GatewayActiveWorkSnapshot }) {
  const runtime = {
    abortEmbeddedAgentRun: vi.fn(() => true),
    abortActiveCronTaskRuns: vi.fn(() => 2),
    waitForGatewayActiveWork: vi.fn(async () => drainResult),
    listActiveEmbeddedRunSessionIds: vi.fn(() => []),
    getDiagnosticSessionActivitySnapshot: vi.fn(() => undefined),
  };
  return { runtime: runtime as unknown as typeof import("./lifecycle.runtime.js"), spies: runtime };
}

function runStop(
  drainResult: { drained: boolean; snapshot: GatewayActiveWorkSnapshot },
  drainTimeoutMs: number,
) {
  const { runtime, spies } = createStopRuntime(drainResult);
  const markDraining = vi.fn();
  const recordWarning = vi.fn();
  const logger = { info: vi.fn(), warn: vi.fn() };
  return drainGatewayActiveWork({
    request: { acceptedAtMs: 0, action: "stop", signal: "SIGTERM" },
    runtime,
    drainTimeoutMs,
    restartDrainDeadlineAt: undefined,
    markDraining,
    recordCounts: vi.fn(),
    recordWarning,
    logger,
  }).then(() => ({ spies, markDraining, recordWarning, logger }));
}

describe("gateway stop drain", () => {
  it("refuses new work, then joins what is durable, and cancels nothing that settled", async () => {
    const { spies, markDraining, logger } = await runStop(
      { drained: true, snapshot: idleSnapshot },
      GATEWAY_STOP_DRAIN_HARD_LIMIT_MS,
    );

    expect(markDraining).toHaveBeenCalledWith("stop (SIGTERM)");
    expect(markDraining.mock.invocationCallOrder[0]).toBeLessThan(
      spies.waitForGatewayActiveWork.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    // An adopted channel turn carries input no later process can recover, so a
    // stop never cancels work that settled inside the ceiling.
    expect(spies.abortEmbeddedAgentRun).not.toHaveBeenCalled();
    expect(spies.abortActiveCronTaskRuns).not.toHaveBeenCalled();
    expect(spies.waitForGatewayActiveWork).toHaveBeenCalledWith(
      GATEWAY_STOP_DRAIN_HARD_LIMIT_MS,
      expect.anything(),
    );
    const lines = logger.info.mock.calls.map((call) => String(call[0]));
    expect(lines[0]).toContain("shutdown phase 1/4 refused new work");
    expect(lines[1]).toContain("shutdown phase 2/4 active work settled");
    expect(lines[2]).toBe("active-work drain settled; beginning server close");
    expect(lines[3]).toContain("shutdown phase 3/4 beginning server close");
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("cancels only what outlives the ceiling, after the join, and names the ceiling", async () => {
    const { spies, recordWarning, logger } = await runStop(
      { drained: false, snapshot: busySnapshot },
      GATEWAY_STOP_DRAIN_HARD_LIMIT_MS,
    );

    expect(spies.waitForGatewayActiveWork.mock.invocationCallOrder[0]).toBeLessThan(
      spies.abortEmbeddedAgentRun.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    expect(spies.abortEmbeddedAgentRun).toHaveBeenCalledTimes(1);
    expect(spies.abortEmbeddedAgentRun).toHaveBeenCalledWith(undefined, { mode: "all" });
    expect(spies.abortActiveCronTaskRuns).toHaveBeenCalledWith("Gateway stopping.");
    expect(recordWarning).toHaveBeenCalledWith(
      expect.stringContaining("stop drain ceiling 30000ms reached"),
    );
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("embeddedRuns=1"));
    const lines = logger.info.mock.calls.map((call) => String(call[0]));
    expect(lines.some((line) => line.includes("cancelling what is left"))).toBe(true);
  });
});

describe("gateway stop drain budget", () => {
  it("caps a stop at 30s even when the supervisor allows five minutes", () => {
    const drain = resolveGatewayShutdownDrainBudget({
      budget: { nativeStopBudget: true, timeoutMs: 330_000, reserveMs: 10_000 },
      action: "stop",
      forceRestart: false,
      restartWithoutSupervisor: false,
      acceptedAtMs: 0,
    });

    expect(drain.drainTimeoutMs).toBe(GATEWAY_STOP_DRAIN_HARD_LIMIT_MS);
    // The supervisor deadline still owns the outer failsafe.
    expect(drain.forceExitMs).toBe(330_000);
  });

  it("never raises a supervisor allowance shorter than the cap", () => {
    const drain = resolveGatewayShutdownDrainBudget({
      budget: { nativeStopBudget: true, timeoutMs: 20_000, reserveMs: 10_000 },
      action: "stop",
      forceRestart: false,
      restartWithoutSupervisor: false,
      acceptedAtMs: 0,
    });

    expect(drain.drainTimeoutMs).toBe(10_000);
  });
});
