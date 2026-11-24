import { performance } from "node:perf_hooks";
import { describe, expect, it, vi } from "vitest";
import { waitForGatewayActiveWork } from "../../infra/gateway-active-work.js";
import { drainGatewayActiveWork } from "./run-loop-drain.js";
import { resolveGatewayShutdownDrainBudget } from "./run-loop-shutdown-budget.js";

function harness(drained = true) {
  const events: string[] = [];
  const snapshot = { idle: true, counts: { totalActive: 0, embeddedRuns: 0 } };
  const runtime = {
    abortEmbeddedAgentRun: vi.fn(() => {
      events.push("embedded");
      return true;
    }),
    abortActiveCronTaskRuns: vi.fn(() => {
      events.push("cron");
      return 1;
    }),
    createGatewayActiveWorkSnapshot: () => snapshot,
    waitForGatewayActiveWork: vi.fn(async () => {
      events.push("wait");
      return { drained, snapshot };
    }),
    listActiveEmbeddedRunSessionIds: () => [],
    getDiagnosticSessionActivitySnapshot: () => undefined,
  };
  return {
    events,
    runtime,
    params: {
      request: {
        action: "stop" as const,
        signal: "SIGTERM" as const,
        acceptedAtMs: performance.now(),
      },
      runtime: runtime as unknown as typeof import("./lifecycle.runtime.js"),
      drainTimeoutMs: 30_000,
      restartDrainDeadlineAt: undefined,
      markDraining: () => {
        events.push("closed");
      },
      recordCounts: vi.fn(),
      recordWarning: vi.fn(),
      logger: { info: vi.fn(), warn: vi.fn() },
    },
  };
}

describe("stop cancellation lifecycle", () => {
  it("settles stop cleanup at its ceiling instead of the native outer deadline", async () => {
    vi.useFakeTimers();
    const h = harness();
    h.runtime.waitForGatewayActiveWork.mockImplementation(waitForGatewayActiveWork);
    // Keep one inventory owner active, independently of eligible cancellation.
    const { setActiveEmbeddedRun, clearActiveEmbeddedRun } =
      await import("../../agents/embedded-agent-runner/runs.js");
    const handle = {
      runId: "bare-cleanup-ceiling",
      queueMessage: async () => {},
      isStreaming: () => true,
      isCompacting: () => false,
      abort: () => {},
    };
    setActiveEmbeddedRun("bare-cleanup-ceiling", handle);
    let settled = false;
    try {
      const cleanup = drainGatewayActiveWork(h.params).then(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(29_999);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await cleanup;
      expect(settled).toBe(true);
      expect(h.runtime.abortEmbeddedAgentRun).toHaveBeenCalledTimes(2);
    } finally {
      clearActiveEmbeddedRun("bare-cleanup-ceiling", handle);
      vi.useRealTimers();
    }
  });

  it.each([true, false])(
    "cancels eligible work before joining cleanup (drained=%s)",
    async (drained) => {
      const h = harness(drained);
      await drainGatewayActiveWork(h.params);
      expect(h.events).toEqual(
        drained
          ? ["closed", "embedded", "cron", "wait"]
          : ["closed", "embedded", "cron", "wait", "embedded"],
      );
      expect(h.runtime.abortEmbeddedAgentRun).toHaveBeenNthCalledWith(1, undefined, {
        mode: "all",
        reason: "restart",
        replyOwnedOnly: true,
      });
      expect(h.runtime.waitForGatewayActiveWork).toHaveBeenCalledWith(30_000, expect.any(Object));
    },
  );

  it("cancels remaining owners after a rejected cleanup wait", async () => {
    const h = harness();
    h.runtime.waitForGatewayActiveWork.mockRejectedValueOnce(new Error("snapshot failed"));
    await drainGatewayActiveWork(h.params);
    expect(h.runtime.abortEmbeddedAgentRun).toHaveBeenNthCalledWith(2, undefined, {
      mode: "all",
      reason: "restart",
    });
    expect(h.params.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("gateway active-work drain failed"),
    );
    expect(h.params.logger.info).toHaveBeenCalledWith(
      "active-work drain settled; beginning server close",
    );
  });

  it("keeps restart draining ahead of cron cancellation", async () => {
    const h = harness(false);
    await drainGatewayActiveWork({
      ...h.params,
      request: { ...h.params.request, action: "restart" },
      restartDrainDeadlineAt: Date.now() + 320_000,
    });
    expect(h.events).toEqual(["closed", "wait", "cron"]);
    expect(h.runtime.abortEmbeddedAgentRun).not.toHaveBeenCalled();
  });

  it.each([330_000, 20_000, 5_000])(
    "caps stop cleanup without changing the %sms outer deadline",
    (timeoutMs) => {
      const result = resolveGatewayShutdownDrainBudget({
        budget: { nativeStopBudget: true, timeoutMs, reserveMs: 10_000 },
        action: "stop",
        forceRestart: false,
        restartWithoutSupervisor: false,
        acceptedAtMs: performance.now(),
      });
      expect(result.drainTimeoutMs).toBe(Math.min(30_000, Math.max(0, timeoutMs - 10_000)));
      expect(result.forceExitMs).toBe(timeoutMs);
    },
  );
});
