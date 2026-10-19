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
  it("refuses new work, then cancels, before it waits for anything", async () => {
    const { spies, markDraining, logger } = await runStop(
      { drained: true, snapshot: idleSnapshot },
      GATEWAY_STOP_DRAIN_HARD_LIMIT_MS,
    );

    expect(markDraining).toHaveBeenCalledWith("stop (SIGTERM)");
    expect(markDraining.mock.invocationCallOrder[0]).toBeLessThan(
      spies.abortEmbeddedAgentRun.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    expect(spies.abortEmbeddedAgentRun).toHaveBeenCalledWith(undefined, { mode: "all" });
    expect(spies.abortActiveCronTaskRuns).toHaveBeenCalledWith("Gateway stopping.");
    expect(spies.abortEmbeddedAgentRun.mock.invocationCallOrder[0]).toBeLessThan(
      spies.waitForGatewayActiveWork.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    expect(spies.waitForGatewayActiveWork).toHaveBeenCalledWith(
      GATEWAY_STOP_DRAIN_HARD_LIMIT_MS,
      expect.anything(),
    );
    const phases = logger.info.mock.calls.map((call) => String(call[0]));
    expect(phases[0]).toContain("shutdown phase 1/4 refused new work");
    expect(phases[1]).toContain("shutdown phase 2/4 cancelled in-flight work");
    expect(phases[2]).toContain("shutdown phase 3/4 active work settled");
    expect(phases[3]).toContain("shutdown phase 4/4 beginning server close");
  });

  it("names the ceiling it spent and does not cancel a second time", async () => {
    const { spies, recordWarning, logger } = await runStop(
      { drained: false, snapshot: busySnapshot },
      GATEWAY_STOP_DRAIN_HARD_LIMIT_MS,
    );

    expect(spies.abortEmbeddedAgentRun).toHaveBeenCalledTimes(1);
    expect(recordWarning).toHaveBeenCalledWith(
      expect.stringContaining("stop drain ceiling 30000ms reached"),
    );
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("embeddedRuns=1"));
    const phases = logger.info.mock.calls.map((call) => String(call[0]));
    expect(phases.at(-1)).toContain("shutdown phase 4/4 beginning server close");
    expect(phases.some((line) => line.includes("3/4 active work settled"))).toBe(false);
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
