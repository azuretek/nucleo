/**
 * Exec runtime tests.
 * Covers cursor mode tracking, exit outcome classification, system events,
 * sandbox finalization, and process lifecycle behavior.
 */

import { expectDefined } from "@openclaw/normalization-core";
import { Type } from "typebox";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_SAFE_TIMEOUT_DELAY_MS } from "../../packages/gateway-client/src/timeouts.js";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  onInternalDiagnosticEvent,
  resetDiagnosticEventsForTest,
  type DiagnosticEventMetadata,
  type DiagnosticExecProcessCompletedEvent,
  type DiagnosticEventPayload,
} from "../infra/diagnostic-events.js";
import type { GatewayActiveWorkInspectors } from "../infra/gateway-active-work.js";
import { resetSystemEventsForTest } from "../infra/system-events.js";
import type { RunExit, SpawnInput } from "../process/supervisor/types.js";
import { createAgentToolExecutionBudget } from "./agent-tool-source-execution-guard.js";
import { createCodingToolsGatewayCaller } from "./agent-tools.caller.js";
import { getFinishedSession } from "./bash-process-registry.js";
import { createRunExit, runtimeManagedRun } from "./bash-tools.exec-runtime.test-support.js";
import type { BashSandboxConfig } from "./bash-tools.shared.js";
import { resolveConversationCapabilityProfile } from "./conversation-capability-profile.js";
import { resetExecSteeringQueueForTest } from "./exec-steering-queue.js";
import {
  getGatewayToolCallerIdentity,
  withGatewayToolCallerIdentity,
} from "./tools/gateway-caller-context.js";

const requestHeartbeatMock = vi.hoisted(() => vi.fn());
const enqueueSystemEventReceiptMock = vi.hoisted(() => vi.fn());
const supervisorMock = vi.hoisted(() => ({
  spawn: vi.fn(),
}));

vi.mock("../infra/heartbeat-wake.js", () => ({
  requestHeartbeat: requestHeartbeatMock,
}));

// Spy only on enqueueSystemEventReceipt; keep every other export real. The
// exec-steering queue singleton is a process-wide globalThis object that
// persists across test files in a worker, and its observer/context-key removal
// bind to whatever system-events module it first imported. Replacing the whole
// module with stubs would leak no-op bindings into a later suite that uses the
// real queue; importActual keeps those real so no cross-file contamination
// occurs regardless of file execution order.
vi.mock("../infra/system-events.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../infra/system-events.js")>();
  return {
    ...actual,
    enqueueSystemEventReceipt: enqueueSystemEventReceiptMock,
  };
});

vi.mock("../process/supervisor/index.js", () => ({
  getProcessSupervisor: () => ({
    spawn: supervisorMock.spawn,
  }),
}));

let markBackgrounded: typeof import("./bash-process-registry.js").markBackgrounded;
let getActiveBackgroundExecSessionCount: typeof import("./bash-process-registry.js").getActiveBackgroundExecSessionCount;
let listRunningSessions: typeof import("./bash-process-registry.js").listRunningSessions;
let resetProcessRegistryForTests: typeof import("./bash-process-registry.test-support.js").resetProcessRegistryForTests;
let runExecProcess: typeof import("./bash-tools.exec-runtime.js").runExecProcess;
let prepareGatewaySuspend: typeof import("../infra/gateway-suspend-coordinator.js").prepareGatewaySuspend;
let resetGatewaySuspendCoordinatorForLifecycleRestart: typeof import("../infra/gateway-suspend-coordinator.js").resetGatewaySuspendCoordinatorForLifecycleRestart;
let resumeGatewaySuspend: typeof import("../infra/gateway-suspend-coordinator.js").resumeGatewaySuspend;

beforeAll(async () => {
  ({ getActiveBackgroundExecSessionCount, listRunningSessions, markBackgrounded } =
    await import("./bash-process-registry.js"));
  ({ resetProcessRegistryForTests } = await import("./bash-process-registry.test-support.js"));
  ({ runExecProcess } = await import("./bash-tools.exec-runtime.js"));
  ({
    prepareGatewaySuspend,
    resetGatewaySuspendCoordinatorForLifecycleRestart,
    resumeGatewaySuspend,
  } = await import("../infra/gateway-suspend-coordinator.js"));
});

beforeEach(() => {
  resetGatewaySuspendCoordinatorForLifecycleRestart();
  resetProcessRegistryForTests();
  requestHeartbeatMock.mockReset();
  enqueueSystemEventReceiptMock.mockReset();
  enqueueSystemEventReceiptMock.mockReturnValue({ eventId: "evt-test", remove: vi.fn(() => true) });
  supervisorMock.spawn.mockReset();
});

afterEach(() => {
  resetProcessRegistryForTests();
  // Clear the exec-steering queue and its process-wide consumption observer so
  // the observer lazily registered by runExecProcess cannot leak into a later
  // file in this non-isolated worker. resetSystemEventsForTest is invoked
  // through the mocked-but-importOriginal system-events module below.
  resetExecSteeringQueueForTest();
  resetSystemEventsForTest();
});

function runTestExecProcess(params: Partial<Parameters<typeof runExecProcess>[0]> = {}) {
  return runExecProcess({
    command: "test-command",
    workdir: "/tmp",
    env: {},
    usePty: false,
    warnings: [],
    maxOutput: 1000,
    pendingMaxOutput: 1000,
    notifyOnExit: false,
    timeoutSec: null,
    ...params,
  });
}

async function runExecWithExit(params: {
  exit: RunExit;
  stdout?: string | string[];
  timeoutSec?: number | null;
  usePty?: boolean;
}) {
  supervisorMock.spawn.mockImplementationOnce(
    async (input: { onStdout?: (chunk: string) => void }) => {
      if (params.stdout) {
        for (const chunk of typeof params.stdout === "string" ? [params.stdout] : params.stdout) {
          input.onStdout?.(chunk);
        }
      }
      return {
        activity: { resultSettled: true, lastOutputAtMs: Date.now() },
        runId: "run-exit",
        startedAtMs: Date.now(),
        pid: 123,
        wait: async () => params.exit,
        cancel: vi.fn(),
      };
    },
  );
  const run = await runTestExecProcess({
    usePty: params.usePty ?? false,
    timeoutSec: params.timeoutSec ?? null,
  });
  return { run, outcome: await run.promise };
}

function prepareSuspension(requestId: string) {
  // This test owns only the background-exec registry. Other process-global
  // activity counters may legitimately stay busy in the non-isolated suite.
  const inspect: GatewayActiveWorkInspectors = {
    getQueueSize: () => 0,
    getPendingReplies: () => 0,
    getEmbeddedRuns: () => 0,
    getBackgroundExecSessions: getActiveBackgroundExecSessionCount,
    getCronRuns: () => 0,
    getAgentRuns: () => 0,
    getAcpRuns: () => 0,
    getMediaRuns: () => 0,
    getRootRequests: () => 0,
    getSessionAdmissions: () => 0,
    getSessionMutations: () => 0,
    getChatRuns: () => 0,
    getQueuedTurns: () => 0,
    getTerminalPersistence: () => 0,
    getTerminalSessions: () => 0,
  };
  return prepareGatewaySuspend({
    requestId,
    pauseScheduling: vi.fn(),
    resumeScheduling: vi.fn(),
    inspect,
  });
}

function requireSystemEventCall(): [string, Record<string, unknown>] {
  const call = enqueueSystemEventReceiptMock.mock.calls[0];
  if (!call) {
    throw new Error("expected system event call");
  }
  return call as [string, Record<string, unknown>];
}

describe("runExecProcess cursor tracking", () => {
  it.each([
    { raw: ["\x1b[?1l\x1b", "[?1", "h"], expected: "application" },
    { raw: ["\x1b[?1h\x1b[?", "1", "l"], expected: "normal" },
    { raw: ["\x1b]0;\x1b[?1h", "\x07"], expected: "unknown" },
  ])("tracks the last cursor-mode toggle as $expected", async ({ raw, expected }) => {
    const { run } = await runExecWithExit({
      stdout: raw,
      usePty: true,
      exit: createRunExit(),
    });

    expect(run.session.cursorKeyMode).toBe(expected);
  });
});

describe("sandbox exec preparation failures", () => {
  it("rechecks the admitting repair authority after deferred supervisor work", async () => {
    let current = true;
    const controller = new AbortController();
    const budget = createAgentToolExecutionBudget({
      signal: controller.signal,
      abort: (error) => controller.abort(error),
      isCurrent: () => current,
    });
    const childEffect = vi.fn();
    supervisorMock.spawn.mockImplementation(async (input: SpawnInput) => {
      await Promise.resolve();
      current = false;
      input.assertCurrent?.();
      childEffect();
      return runtimeManagedRun(input);
    });
    await expect(
      budget.run(() =>
        runTestExecProcess({
          command: "echo forbidden",
          beforeSpawn: async () => {
            await Promise.resolve();
            return undefined;
          },
        }),
      ),
    ).rejects.toThrow("execution scope is no longer active");
    expect(childEffect).not.toHaveBeenCalled();
    expect(supervisorMock.spawn).toHaveBeenCalledOnce();
  });

  it.each([
    { mode: "PTY", usePty: true, cancelCheck: 1, expectedSpawns: 0 },
    { mode: "PTY fallback", usePty: true, cancelCheck: 2, expectedSpawns: 1 },
  ])(
    "does not start $mode after cancellation during final admission",
    async ({ usePty, cancelCheck, expectedSpawns }) => {
      const controller = new AbortController();
      let checks = 0;
      supervisorMock.spawn.mockImplementation(async (input: SpawnInput) => {
        if (input.mode === "pty") {
          throw new Error("PTY unavailable");
        }
        return runtimeManagedRun(input);
      });

      await expect(
        runTestExecProcess({
          command: "echo should-not-run",
          workdir: process.cwd(),
          usePty,
          startupSignal: controller.signal,
          beforeSpawn: async () => {
            if (++checks === cancelCheck) {
              controller.abort(new Error("cancelled during admission"));
            }
            return undefined;
          },
        }),
      ).rejects.toThrow("cancelled during admission");

      expect(supervisorMock.spawn.mock.calls.length).toBe(expectedSpawns);
      expect(checks).toBe(cancelCheck);
    },
  );

  it.each([
    { mode: "PTY", usePty: true, loseAt: 1, authority: "replaced", spawns: 0 },
    { mode: "PTY fallback", usePty: true, loseAt: 2, authority: "revoked", spawns: 1 },
    { mode: "PTY construction", usePty: true, loseAt: -1, authority: "revoked", spawns: 1 },
  ])(
    "checks $authority source authority before $mode admission without polling",
    async ({ usePty, loseAt, authority, spawns }) => {
      const originalClaim = {};
      let currentClaim: object | undefined = originalClaim;
      let checks = 0;
      const generation = new AbortController();
      const warnings: string[] = [];
      supervisorMock.spawn.mockImplementation(async (input: SpawnInput) => {
        // The real supervisor preserves this callback across queued construction.
        await Promise.resolve();
        if (loseAt === -1) {
          currentClaim = undefined;
        }
        input.assertCurrent?.();
        if (input.mode === "pty") {
          throw new Error("PTY unavailable");
        }
        return runtimeManagedRun(input);
      });
      const pending = withGatewayToolCallerIdentity(
        {
          agentId: "main",
          sessionKey: "agent:main:source-exec-authority",
          receiptAuthority: () => currentClaim === originalClaim,
        },
        () =>
          runTestExecProcess({
            command: "source-authority-command",
            workdir: process.cwd(),
            usePty,
            warnings,
            startupSignal: generation.signal,
            beforeSpawn: async () => {
              if (++checks === loseAt) {
                currentClaim = authority === "replaced" ? {} : undefined;
              }
              return undefined;
            },
          }),
      );
      await expect(pending).rejects.toThrow("authority is no longer active");
      expect(generation.signal.aborted).toBe(false);
      expect(supervisorMock.spawn).toHaveBeenCalledTimes(spawns);
      expect(warnings).toEqual(
        usePty && loseAt !== -1 && spawns > 0
          ? [expect.stringContaining("retrying without PTY")]
          : [],
      );
      expect(listRunningSessions()).toHaveLength(0);
    },
  );

  it.each(["current", "revoked", "reassigned"] as const)(
    "rechecks a prepared settle tool at final process spawn when its batch is %s",
    async (state) => {
      const sessionKey = "agent:main:settle-exec";
      const claim = {};
      let currentClaim: object | undefined = claim;
      const profile = resolveConversationCapabilityProfile({ sessionKey, agentId: "main" });
      const wrap = createCodingToolsGatewayCaller({
        agentId: "main",
        sessionKey,
        capabilityProfile: {
          ...profile,
          policy: { ...profile.policy, requesterPolicySource: "completion-handoff" },
        },
        options: {
          trustedInternalHandoff: {
            kind: "subagent-completion",
            sourceSessionKey: "agent:main:subagent:child",
            targetSessionKey: sessionKey,
            targetSessionId: "settle-parent",
            provider: "openai",
            model: "test-model",
            settleBatch: {
              sourceSessionKeys: ["agent:main:subagent:child"],
              isCurrent: () => currentClaim === claim,
            },
          },
        },
      });
      const effect = vi.fn();
      supervisorMock.spawn.mockImplementationOnce(async (input: SpawnInput) => {
        await Promise.resolve();
        currentClaim = state === "current" ? claim : state === "reassigned" ? {} : undefined;
        input.assertCurrent?.();
        effect();
        return runtimeManagedRun(input);
      });
      const tool = wrap({
        name: "exec",
        label: "Exec",
        description: "Synthetic exec using the production process boundary",
        parameters: Type.Object({}),
        execute: async () => {
          const process = await runTestExecProcess();
          return { content: [], details: await process.promise };
        },
      });
      const pending = withGatewayToolCallerIdentity(
        { agentId: "main", sessionKey, receiptAuthority: () => true },
        () =>
          expectDefined(tool.execute, "Expected the prepared settle exec tool")("settle-exec", {}),
      );
      if (state === "current") {
        await expect(pending).resolves.toMatchObject({ details: { status: "completed" } });
        expect(effect).toHaveBeenCalledOnce();
      } else {
        await expect(pending).rejects.toThrow("authority is no longer active");
        expect(effect).not.toHaveBeenCalled();
      }
      expect(supervisorMock.spawn).toHaveBeenCalledOnce();
    },
  );

  it("keeps turn authority out of process lifetime while preserving foreground updates", async () => {
    const exit = createDeferred<RunExit>();
    const identity = {
      agentId: "main",
      sessionKey: "agent:main:exec-lifetime",
      signedAgentRuntimeIdentityToken: "synthetic-turn-identity",
    };
    const spawnIdentity = vi.fn();
    const updateIdentity = vi.fn();
    const settledIdentity = vi.fn();
    const beforeSpawn = vi.fn(async () => {
      expect(getGatewayToolCallerIdentity()).toMatchObject(identity);
      return undefined;
    });
    let stdout: SpawnInput["onStdout"];
    supervisorMock.spawn.mockImplementationOnce(async (input: SpawnInput) => {
      spawnIdentity(getGatewayToolCallerIdentity());
      stdout = input.onStdout;
      stdout?.("foreground output\n");
      return { ...runtimeManagedRun(input), wait: () => exit.promise };
    });

    const run = await withGatewayToolCallerIdentity(identity, () =>
      runTestExecProcess({
        beforeSpawn,
        onUpdate: () => updateIdentity(getGatewayToolCallerIdentity()),
        onSettledBeforeNotify: () => settledIdentity(getGatewayToolCallerIdentity()),
      }),
    );
    run.disableUpdates();
    stdout?.("background output\n");
    exit.resolve(createRunExit());
    const outcome = await run.promise;

    expect(beforeSpawn).toHaveBeenCalledOnce();
    expect(updateIdentity).toHaveBeenCalledExactlyOnceWith(expect.objectContaining(identity));
    expect(outcome.aggregated).toBe("foreground output\nbackground output");
    expect(spawnIdentity).toHaveBeenCalledExactlyOnceWith(undefined);
    expect(settledIdentity).toHaveBeenCalledExactlyOnceWith(undefined);
  });

  it("runs the final authorization check after async preparation and before spawn", async () => {
    const preparation =
      createDeferred<Awaited<ReturnType<NonNullable<BashSandboxConfig["buildExecSpec"]>>>>();
    const denied = new Error("approval directory changed");
    const beforeSpawn = vi.fn(async () => {
      throw denied;
    });
    const pending = runTestExecProcess({
      command: "sandbox-command",
      sandbox: {
        containerName: "sandbox",
        workspaceDir: "/workspace",
        containerWorkdir: "/workspace",
        buildExecSpec: async () => await preparation.promise,
      },
      beforeSpawn,
    });

    expect(beforeSpawn).not.toHaveBeenCalled();
    preparation.resolve({
      argv: ["sandbox-command"],
      env: {},
      stdinMode: "pipe-closed",
    });
    await expect(pending).rejects.toBe(denied);
    expect(beforeSpawn).toHaveBeenCalledOnce();
    expect(supervisorMock.spawn).not.toHaveBeenCalled();
  });

  it("rejects a sandbox without a backend-owned exec specification", async () => {
    supervisorMock.spawn.mockImplementationOnce(async (input: SpawnInput) =>
      runtimeManagedRun(input),
    );

    await expect(
      runTestExecProcess({
        command: "sandbox-command",
        env: { EXAMPLE_VALUE: "synthetic-runtime-sandbox-value" },
        sandbox: {
          containerName: "sandbox",
          workspaceDir: "/workspace",
          containerWorkdir: "/workspace",
        },
      }),
    ).rejects.toThrow("sandbox backend does not provide buildExecSpec");

    expect(supervisorMock.spawn).not.toHaveBeenCalled();
  });

  it("settles the registered session once when buildExecSpec rejects", async () => {
    const registry = await import("./bash-process-registry.js");
    const sessionSlugs = await import("./session-slug.js");
    const sessionId = "sandbox-preparation-failure";
    const sessionSlug = vi.spyOn(sessionSlugs, "createSessionSlug").mockReturnValue(sessionId);
    const preparation =
      createDeferred<Awaited<ReturnType<NonNullable<BashSandboxConfig["buildExecSpec"]>>>>();
    const finalizeExec = vi.fn<NonNullable<BashSandboxConfig["finalizeExec"]>>(async () => {});
    const onSettledBeforeNotify = vi.fn();
    const completionEvents: DiagnosticExecProcessCompletedEvent[] = [];
    const unsubscribe = onInternalDiagnosticEvent((event) => {
      if (
        event.type === "exec.process.completed" &&
        event.sessionKey === "agent:main:sandbox-preparation"
      ) {
        completionEvents.push(event);
      }
    });
    const failure = new Error("sandbox preparation failed");

    try {
      const pending = runTestExecProcess({
        command: "sandbox-command",
        sandbox: {
          containerName: "sandbox",
          workspaceDir: "/workspace",
          containerWorkdir: "/workspace",
          buildExecSpec: async () => await preparation.promise,
          finalizeExec,
        },
        sessionKey: "agent:main:sandbox-preparation",
        onSettledBeforeNotify,
      });

      expect(registry.getSession(sessionId)).toMatchObject({ exited: false });
      preparation.reject(failure);
      await expect(pending).rejects.toBe(failure);
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });

      expect(finalizeExec).not.toHaveBeenCalled();
      expect(supervisorMock.spawn).not.toHaveBeenCalled();
      expect(registry.getSession(sessionId)).toBeUndefined();
      expect(onSettledBeforeNotify).toHaveBeenCalledOnce();
      expect(onSettledBeforeNotify).toHaveBeenCalledWith(
        expect.objectContaining({ status: "failed", failureKind: "runtime-error" }),
      );
      expect(completionEvents).toEqual([
        expect.objectContaining({
          type: "exec.process.completed",
          target: "sandbox",
          mode: "child",
          outcome: "failed",
          failureKind: "runtime-error",
          timedOut: false,
          sessionKey: "agent:main:sandbox-preparation",
        }),
      ]);
    } finally {
      unsubscribe();
      sessionSlug.mockRestore();
    }
  });
});

describe("sandbox exec finalization suspension", () => {
  it.each([
    {
      scenario: "successful cleanup",
      finalizeRejects: false,
      processTimesOut: false,
      expectedStatus: "completed" as const,
      expectedFailureKind: undefined,
    },
    {
      scenario: "failed cleanup after a process timeout",
      finalizeRejects: true,
      processTimesOut: true,
      expectedStatus: "failed" as const,
      expectedFailureKind: "overall-timeout" as const,
    },
  ])(
    "keeps suspension busy until asynchronous finalization settles after $scenario",
    async ({ finalizeRejects, processTimesOut, expectedFailureKind, expectedStatus }) => {
      const exit = createDeferred<RunExit>();
      const finalization = createDeferred();
      const finalizeExec = vi.fn<NonNullable<BashSandboxConfig["finalizeExec"]>>(
        async () => await finalization.promise,
      );
      let producer: SpawnInput | undefined;
      supervisorMock.spawn.mockImplementationOnce(async (input: SpawnInput) => {
        producer = input;
        input.onStdout?.("sandbox output\n");
        const activity = { resultSettled: false, lastOutputAtMs: Date.now() };
        return {
          activity,
          runId: "sandbox-run",
          startedAtMs: Date.now(),
          pid: 123,
          wait: async () => {
            try {
              return await exit.promise;
            } finally {
              activity.resultSettled = true;
            }
          },
          cancel: vi.fn(),
        };
      });

      const run = await runTestExecProcess({
        command: "sandbox-command",
        sandbox: {
          containerName: "sandbox",
          workspaceDir: "/workspace",
          containerWorkdir: "/workspace",
          buildExecSpec: async () => ({
            argv: ["sandbox-command"],
            env: {},
            stdinMode: "pipe-closed",
            finalizeToken: "sandbox-token",
          }),
          finalizeExec,
        },
        notifyOnExit: true,
        sessionKey: "agent:main:main",
      });
      markBackgrounded(run.session);
      expect(getActiveBackgroundExecSessionCount()).toBe(1);

      exit.resolve(
        createRunExit({
          reason: processTimesOut ? "overall-timeout" : "exit",
          exitCode: processTimesOut ? null : 0,
          exitSignal: processTimesOut ? "SIGKILL" : null,
          timedOut: processTimesOut,
        }),
      );
      await vi.waitFor(() => expect(finalizeExec).toHaveBeenCalledOnce());
      expect(run.session.finalizing).toBe(true);
      producer?.onStderr?.("during cleanup\n");
      expect(getFinishedSession(run.session.id)).toBeUndefined();

      const busy = prepareSuspension(`before-finalize-${expectedFailureKind ?? "success"}`);
      expect(busy.status).toBe("busy");
      if (busy.status === "busy") {
        expect(busy.blockers).toContainEqual(
          expect.objectContaining({ kind: "background-exec", count: 1 }),
        );
      }
      expect(getActiveBackgroundExecSessionCount()).toBe(1);

      if (finalizeRejects) {
        finalization.reject(new Error("sandbox finalize failed"));
      } else {
        finalization.resolve();
      }
      const outcome = await run.promise;

      expect(outcome.status).toBe(expectedStatus);
      if (outcome.status === "failed") {
        expect(outcome.failureKind).toBe(expectedFailureKind);
        expect(outcome.reason).toContain("timed out");
      }
      expect(finalizeExec).toHaveBeenCalledOnce();
      expect(getActiveBackgroundExecSessionCount()).toBe(0);
      expect(run.session.finalizing).toBe(false);
      expect(enqueueSystemEventReceiptMock).toHaveBeenCalledTimes(1);
      expect(requireSystemEventCall()[0]).toContain(
        expectedStatus === "failed" ? "Exec failed" : "Exec completed",
      );
      expect(requireSystemEventCall()[0]).toContain("during cleanup");
      const retained = getFinishedSession(run.session.id);
      const outputBeforeLateCallback = {
        aggregated: retained?.aggregated,
        tail: retained?.tail,
        totalOutputChars: retained?.totalOutputChars,
        truncated: retained?.truncated,
      };
      expect(outputBeforeLateCallback.aggregated).toContain("sandbox output\nduring cleanup\n");
      producer?.onStdout?.("late output".repeat(1_000));
      expect(getFinishedSession(run.session.id)).toMatchObject(outputBeforeLateCallback);

      const ready = prepareSuspension(`after-finalize-${expectedFailureKind ?? "success"}`);
      expect(ready.status).toBe("ready");
      if (ready.status === "ready") {
        expect(resumeGatewaySuspend(ready.suspensionId)).toMatchObject({ ok: true });
      }
    },
  );
});

describe("terminal execution-context release", () => {
  it.each([
    { path: "notify", trace: ["task", "enqueue", "wake"] },
    { path: "quiet", trace: ["task"] },
    { path: "unrouted", trace: ["task"] },
    { path: "observed", trace: ["task"] },
    { path: "task failure", trace: ["task", "task"] },
    { path: "enqueue failure", trace: ["task", "enqueue", "task"] },
    { path: "wake failure", trace: ["task", "enqueue", "wake", "task"] },
  ])(
    "releases routing after $path without changing notification order",
    async ({ path, trace }) => {
      const exit = createDeferred<RunExit>();
      const observed: string[] = [];
      const removal = vi.fn(() => true);
      const deliveryContext = { channel: "telegram", to: "synthetic-chat" };
      const failure = new Error("notification boundary failed");
      enqueueSystemEventReceiptMock.mockImplementation((_text, options) => {
        observed.push("enqueue");
        expect(options.deliveryContext).toEqual(deliveryContext);
        if (path === "enqueue failure") {
          throw failure;
        }
        return { eventId: "evt-test", remove: removal };
      });
      requestHeartbeatMock.mockImplementation(() => {
        observed.push("wake");
        if (path === "wake failure") {
          throw failure;
        }
      });
      supervisorMock.spawn.mockImplementationOnce(async (input: SpawnInput) => ({
        ...runtimeManagedRun(input, path === "quiet" ? "" : "retained output\n"),
        wait: () => exit.promise,
      }));
      const run = await runExecProcess({
        command: "context-release",
        workdir: "/tmp",
        env: {},
        usePty: false,
        warnings: [],
        maxOutput: 1_000,
        pendingMaxOutput: 1_000,
        scopeKey: "process-scope",
        sessionKey: path === "unrouted" ? undefined : "agent:main:main",
        agentId: "main",
        eventRouting: { mainKey: "main", sessionScope: "per-sender" },
        notifyDeliveryContext: deliveryContext,
        notifyOnExit: true,
        notifyOnExitEmptySuccess: false,
        timeoutSec: null,
        onSettledBeforeNotify: () => {
          observed.push("task");
          if (path === "task failure" && observed.length === 1) {
            throw failure;
          }
        },
      });
      markBackgrounded(run.session);
      if (path === "observed") {
        acknowledgeNotifyOnExit(run.session);
      }
      exit.resolve(createRunExit());
      const outcome = await run.promise;
      expect(observed).toEqual(trace);
      expect(outcome.status).toBe(path.endsWith("failure") ? "failed" : "completed");
      const retained = getFinishedSession(run.session.id);
      expect(retained).toMatchObject({ scopeKey: "process-scope", terminalStatus: "completed" });
      for (const field of [
        "sessionKey",
        "agentId",
        "eventRouting",
        "notifyDeliveryContext",
        "notifyOnExit",
        "notifyOnExitEmptySuccess",
        "stdin",
      ] as const) {
        expect(retained?.[field], field).toBeUndefined();
      }
      expect(retained?.notifyOnExitRemoval).toBe(trace.includes("wake") ? removal : undefined);
      expect(removal).not.toHaveBeenCalled();
    },
  );
});
