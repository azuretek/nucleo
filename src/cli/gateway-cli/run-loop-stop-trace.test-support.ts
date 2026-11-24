import { expect, it, vi, type Mock } from "vitest";
import type { GatewayActiveWorkSnapshot } from "../../infra/gateway-active-work.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { captureEnv, deleteTestEnvValue } from "../../test-utils/env.js";
import {
  createActiveWorkSnapshot,
  withIsolatedSignals,
  type UpdateRespawnFixtures,
} from "./run-loop.test-support.js";

export function registerDirectStopTraceTests({
  createSignaledLoopHarness,
  waitForGatewayActiveWork,
  idleActiveWorkSnapshot,
  abortEmbeddedAgentRun,
  abortActiveCronTaskRuns,
  isGatewayWorkAdmissionClosed,
  createGatewayActiveWorkSnapshot,
  gatewayLog,
}: Pick<
  UpdateRespawnFixtures,
  | "createSignaledLoopHarness"
  | "waitForGatewayActiveWork"
  | "isGatewayWorkAdmissionClosed"
  | "gatewayLog"
> & {
  idleActiveWorkSnapshot: GatewayActiveWorkSnapshot;
  abortEmbeddedAgentRun: Mock;
  abortActiveCronTaskRuns: Mock;
  createGatewayActiveWorkSnapshot: Mock;
}) {
  it.each([
    { signal: "SIGTERM", trace: undefined },
    { signal: "SIGINT", trace: "0" },
    { signal: "SIGTERM", trace: "1" },
  ] as const)(
    "reports only category counts while direct $signal stop is pending (trace=$trace)",
    async ({ signal, trace }) => {
      vi.clearAllMocks();
      const traceEnv = captureEnv(["OPENCLAW_GATEWAY_RESTART_TRACE"]);
      if (trace === undefined) {
        deleteTestEnvValue("OPENCLAW_GATEWAY_RESTART_TRACE");
      } else {
        process.env.OPENCLAW_GATEWAY_RESTART_TRACE = trace;
      }
      try {
        await withIsolatedSignals(async ({ captureSignal }) => {
          const { close, runtime, exited } = await createSignaledLoopHarness();
          const { startGatewayRestartTrace } = await import("../../gateway/restart-trace.js");
          startGatewayRestartTrace("prior.sequence");
          const pendingDrain = createDeferredCore();
          const enteredDrain = createDeferredCore();
          const activeSnapshot = createActiveWorkSnapshot(
            {
              queueSize: 1,
              pendingReplies: 2,
              embeddedRuns: 3,
              backgroundExecSessions: 4,
              cronRuns: 5,
              agentRuns: 6,
              acpRuns: 0,
              mediaRuns: 0,
              rootRequests: 7,
              sessionAdmissions: 8,
              sessionMutations: 9,
              chatRuns: 10,
              queuedTurns: 11,
              terminalPersistence: 12,
              terminalSessions: 13,
            },
            [
              { kind: "root-request", count: 7, message: "private-root-holder-origin" },
              {
                kind: "agent-run",
                count: 6,
                message: "private-task-message",
              },
            ],
          );
          const counts =
            "queueSize=1 pendingReplies=2 embeddedRuns=3 backgroundExecSessions=4 cronRuns=5 agentRuns=6 rootRequests=7 sessionAdmissions=8 sessionMutations=9 chatRuns=10 queuedTurns=11 terminalPersistence=12 terminalSessions=13";
          waitForGatewayActiveWork.mockImplementationOnce(async (_timeoutMs, options) => {
            options?.onSnapshot?.(activeSnapshot);
            enteredDrain.resolve();
            await pendingDrain.promise;
            return { drained: true, snapshot: idleActiveWorkSnapshot };
          });
          let now = Date.now();
          const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
          try {
            captureSignal(signal)();
            await enteredDrain.promise;
            expect(abortEmbeddedAgentRun).toHaveBeenCalledExactlyOnceWith(undefined, {
              mode: "all",
              reason: "restart",
              replyOwnedOnly: true,
            });
            expect(abortActiveCronTaskRuns).toHaveBeenCalledWith("Gateway stopping.");
            expect(abortEmbeddedAgentRun.mock.invocationCallOrder[0]).toBeLessThan(
              waitForGatewayActiveWork.mock.invocationCallOrder[0]!,
            );
            expect(isGatewayWorkAdmissionClosed()).toBe(true);
            expect(waitForGatewayActiveWork).toHaveBeenCalledWith(30_000, {
              onSnapshot: expect.any(Function),
            });
            expect(createGatewayActiveWorkSnapshot).not.toHaveBeenCalled();
            expect(close).not.toHaveBeenCalled();
            expect(runtime.exit).not.toHaveBeenCalled();
            expect(gatewayLog.info).toHaveBeenCalledWith(
              `draining active work before stop with timeout 30000ms: ${counts}`,
            );
            captureSignal(signal)();
            expect(waitForGatewayActiveWork).toHaveBeenCalledOnce();
            const onSnapshot = waitForGatewayActiveWork.mock.calls[0]?.[1]?.onSnapshot;
            now += 29_999;
            onSnapshot?.(activeSnapshot);
            expect(gatewayLog.warn).not.toHaveBeenCalled();
            now += 1;
            onSnapshot?.(activeSnapshot);
            onSnapshot?.(activeSnapshot);
            expect(gatewayLog.warn).toHaveBeenCalledExactlyOnceWith(
              `still draining active work before stop: ${counts}`,
            );
            clock.mockRestore();
            pendingDrain.resolve();
            await expect(exited).resolves.toBe(0);
            expect(abortEmbeddedAgentRun).toHaveBeenCalledExactlyOnceWith(undefined, {
              mode: "all",
              reason: "restart",
              replyOwnedOnly: true,
            });
            expect(gatewayLog.info).toHaveBeenCalledWith(
              "active-work drain settled; beginning server close",
            );
            const output = [...gatewayLog.info.mock.calls, ...gatewayLog.warn.mock.calls]
              .flat()
              .join("\n");
            expect(output).not.toContain("private-");
            expect(output).not.toContain("totalActive");
            expect(output.includes("restart trace:")).toBe(trace === "1");
            const starts = gatewayLog.info.mock.calls
              .flat()
              .filter((line) => String(line).includes("stop.signal.received "));
            expect(starts).toEqual(
              trace === "1"
                ? [`restart trace: stop.signal.received 0.0ms total=0.0ms signal=${signal}`]
                : [],
            );
            expect(close).toHaveBeenCalledWith({
              reason: "gateway stopping",
              restartExpectedMs: null,
            });
          } finally {
            clock.mockRestore();
            pendingDrain.resolve();
            await exited;
          }
        });
      } finally {
        traceEnv.restore();
      }
    },
  );
}
