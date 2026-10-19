import {
  markGatewayRestartTrace,
  measureGatewayRestartTrace,
} from "../../gateway/restart-trace.js";
import { formatErrorMessage } from "../../infra/errors.js";
import type { GatewayActiveWorkSnapshot } from "../../infra/gateway-active-work.js";
import type { SubsystemLogger } from "../../logging/subsystem.js";
import type { GatewayDrainReason } from "../../process/gateway-work-admission.js";
import type { GatewayRunSignalAction, GatewayRunSignalRequest } from "./run-loop-request.js";
import { formatDrainCounts, formatShutdownReason } from "./run-loop-shutdown-format.js";

const RESTART_DRAIN_STILL_PENDING_WARN_MS = 30_000;

export async function drainGatewayActiveWork({
  request,
  runtime,
  drainTimeoutMs,
  restartDrainDeadlineAt,
  markDraining,
  recordCounts,
  recordWarning,
  logger,
}: {
  request: GatewayRunSignalRequest;
  runtime: typeof import("./lifecycle.runtime.js");
  drainTimeoutMs: number | undefined;
  restartDrainDeadlineAt: number | undefined;
  markDraining: (reason: GatewayDrainReason) => void;
  recordCounts: (counts: string) => void;
  recordWarning: (warning: string) => void;
  logger: Pick<SubsystemLogger, "info" | "warn">;
}) {
  const { restartIntent } = request;
  const reportDrainSnapshot = createGatewayDrainReporter(
    request.action,
    drainTimeoutMs,
    runtime,
    logger,
    recordCounts,
  );
  // On restart, wait for the canonical process activity inventory before
  // tearing down the server so active work can settle.
  if (request.action !== "stop") {
    let activeWorkAtDrainStart = 0;
    let activeRunsAtDrainStart = 0;
    let drainTimedOut = false;
    await measureGatewayRestartTrace(
      "restart.drain",
      async () => {
        const { abortEmbeddedAgentRun, createGatewayActiveWorkSnapshot, waitForGatewayActiveWork } =
          runtime;
        // Reject new enqueues immediately during the drain window so
        // sessions get an explicit restart error instead of silent task loss.
        markDraining(formatShutdownReason(request));
        const initialSnapshot = createGatewayActiveWorkSnapshot();
        activeWorkAtDrainStart = initialSnapshot.counts.totalActive;
        activeRunsAtDrainStart = initialSnapshot.counts.embeddedRuns;
        if (activeRunsAtDrainStart > 0) {
          abortEmbeddedAgentRun(undefined, { mode: "compacting", reason: "restart" });
        }

        reportDrainSnapshot(initialSnapshot);
        const remainingDrainTimeoutMs =
          restartDrainDeadlineAt === undefined
            ? undefined
            : Math.max(0, restartDrainDeadlineAt - Date.now());
        const drain = await waitForGatewayActiveWork(remainingDrainTimeoutMs, {
          onSnapshot: reportDrainSnapshot,
        });
        if (drain.drained) {
          if (!initialSnapshot.idle) {
            logger.info("all active work drained");
          }
          return;
        }
        drainTimedOut = true;
        const warning = `restart drain budget ${drainTimeoutMs}ms exhausted; cutting short ${formatDrainCounts(drain.snapshot)}`;
        recordWarning(warning);
        logger.warn(warning);
        // Connection work can retain cron cleanup; cancel before close joins it.
        runtime.abortActiveCronTaskRuns("Gateway restarting.");
      },
      () => [
        ["activeWork", activeWorkAtDrainStart],
        ["activeRuns", activeRunsAtDrainStart],
        ["timedOut", drainTimedOut],
        ["force", restartIntent?.force === true],
      ],
    );
  } else {
    // A stop ends this process for good, so its drain is a cleanup ceiling
    // rather than time to spend: refuse new work, cancel what can be cancelled,
    // then let the cancellation's own cleanup settle inside the ceiling.
    const phaseStartedAt = Date.now();
    const reportPhase = (phase: string) =>
      logger.info(`shutdown phase ${phase} (+${Date.now() - phaseStartedAt}ms)`);
    const ceiling = drainTimeoutMs === undefined ? "no ceiling" : `${drainTimeoutMs}ms`;
    try {
      markGatewayRestartTrace("stop.drain.begin");
      // Work admitted after this point cannot outlive the process, so admitting
      // it would only spend the ceiling on something about to be cancelled.
      markDraining(formatShutdownReason(request));
      reportPhase("1/4 refused new work");
      // Aborting is the capture, not the loss: an embedded turn keeps its user
      // message in the transcript, and its pending input row is marked
      // interrupted rather than removed, so a follow-up resumes from the full
      // context. Cancelling before the wait is what keeps the wait short.
      const abortedEmbedded = runtime.abortEmbeddedAgentRun(undefined, { mode: "all" });
      const abortedCronRuns = runtime.abortActiveCronTaskRuns("Gateway stopping.");
      reportPhase(
        `2/4 cancelled in-flight work (embedded=${abortedEmbedded ? "aborted" : "none"}, cron=${abortedCronRuns})`,
      );
      const activeWorkDrain = await measureGatewayRestartTrace("stop.drain", () =>
        runtime.waitForGatewayActiveWork(drainTimeoutMs, {
          onSnapshot: reportDrainSnapshot,
        }),
      );
      if (activeWorkDrain.drained) {
        reportPhase("3/4 active work settled");
      } else {
        const warning = `stop drain ceiling ${ceiling} reached; closing with work still active: ${formatDrainCounts(activeWorkDrain.snapshot)}`;
        recordWarning(warning);
        logger.warn(warning);
      }
    } catch (err) {
      logger.warn(
        `gateway active-work drain failed; proceeding with shutdown: ${formatErrorMessage(err)}`,
      );
    }
    reportPhase("4/4 beginning server close");
  }
}

function createGatewayDrainReporter(
  action: GatewayRunSignalAction,
  drainTimeoutMs: number | undefined,
  runtime: Pick<
    typeof import("./lifecycle.runtime.js"),
    "listActiveEmbeddedRunSessionIds" | "getDiagnosticSessionActivitySnapshot"
  >,
  logger: Pick<SubsystemLogger, "info" | "warn">,
  recordCounts: (counts: string) => void,
) {
  const drainBudget =
    drainTimeoutMs === undefined ? "without a timeout" : `with timeout ${drainTimeoutMs}ms`;
  let lastPendingWarningAt: number | undefined;
  return (snapshot: GatewayActiveWorkSnapshot) => {
    recordCounts(formatDrainCounts(snapshot) || "no active work");
    const now = Date.now();
    if (lastPendingWarningAt === undefined) {
      lastPendingWarningAt = now;
      if (!snapshot.idle) {
        logger.info(
          `draining active work before ${action} ${drainBudget}: ${formatDrainCounts(snapshot)}`,
        );
        const requestTimeoutMs = Math.max(
          0,
          ...runtime
            .listActiveEmbeddedRunSessionIds()
            .map(
              (sessionId) =>
                runtime.getDiagnosticSessionActivitySnapshot({ sessionId })
                  ?.activeModelCallRequestTimeoutMs ?? 0,
            ),
        );
        if (requestTimeoutMs > 0) {
          logger.info(
            `largest observed model request timeout is ${requestTimeoutMs}ms; shutdown drain budget remains ${drainBudget}`,
          );
        }
      }
    } else if (
      !snapshot.idle &&
      now - lastPendingWarningAt >= RESTART_DRAIN_STILL_PENDING_WARN_MS
    ) {
      lastPendingWarningAt = now;
      logger.warn(`still draining active work before ${action}: ${formatDrainCounts(snapshot)}`);
    }
  };
}
