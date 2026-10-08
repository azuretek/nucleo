// Extracted from bash-tools.exec-runtime.test.ts, which is grandfathered over its line cap and may
// only shrink. The shared setup above the describes is duplicated here on purpose: the steering queue
// is a process-wide singleton, so each file does its own resets rather than relying on another suite.

/**
 * Exec runtime tests.
 * Covers cursor mode tracking, exit outcome classification, system events,
 * sandbox finalization, and process lifecycle behavior.
 */

import { expectDefined } from "@openclaw/normalization-core";
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
import { resetSystemEventsForTest } from "../infra/system-events.js";
import type { RunExit, SpawnInput } from "../process/supervisor/types.js";
import { createRunExit, runtimeManagedRun } from "./bash-tools.exec-runtime.test-support.js";
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
let listRunningSessions: typeof import("./bash-process-registry.js").listRunningSessions;
let waitForExecScope: typeof import("./bash-process-registry.js").waitForExecScope;
let resetProcessRegistryForTests: typeof import("./bash-process-registry.test-support.js").resetProcessRegistryForTests;
let runExecProcess: typeof import("./bash-tools.exec-runtime.js").runExecProcess;
let resetGatewaySuspendCoordinatorForLifecycleRestart: typeof import("../infra/gateway-suspend-coordinator.js").resetGatewaySuspendCoordinatorForLifecycleRestart;

beforeAll(async () => {
  ({ waitForExecScope, listRunningSessions, markBackgrounded } =
    await import("./bash-process-registry.js"));
  ({ resetProcessRegistryForTests } = await import("./bash-process-registry.test-support.js"));
  ({ runExecProcess } = await import("./bash-tools.exec-runtime.js"));
  ({ resetGatewaySuspendCoordinatorForLifecycleRestart } =
    await import("../infra/gateway-suspend-coordinator.js"));
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

function requireSystemEventCall(): [string, Record<string, unknown>] {
  const call = enqueueSystemEventReceiptMock.mock.calls[0];
  if (!call) {
    throw new Error("expected system event call");
  }
  return call as [string, Record<string, unknown>];
}

describe("exec settlement recovery", () => {
  it.each([
    { boundary: "task", trace: ["task:completed", "task:failed", "scope-released"] },
    {
      boundary: "enqueue",
      trace: ["task:completed", "enqueue", "task:failed", "scope-released"],
    },
    {
      boundary: "wake",
      trace: ["task:completed", "enqueue", "wake", "task:failed", "scope-released"],
    },
  ])("retries $boundary failure before releasing the exec scope", async ({ boundary, trace }) => {
    const exit = createDeferred<RunExit>();
    const observed: string[] = [];
    const identities: Array<ReturnType<typeof getGatewayToolCallerIdentity>> = [];
    const failure = new Error("process settlement failed");
    const scopeKey = `settlement-recovery:${boundary}`;
    enqueueSystemEventReceiptMock.mockImplementation(() => {
      observed.push("enqueue");
      if (boundary === "enqueue") {
        throw failure;
      }
      return { eventId: "evt-test", remove: vi.fn(() => true) };
    });
    requestHeartbeatMock.mockImplementation(() => {
      observed.push("wake");
      if (boundary === "wake") {
        throw failure;
      }
    });
    supervisorMock.spawn.mockImplementationOnce(async (input: SpawnInput) => ({
      ...runtimeManagedRun(input, "process output\n"),
      wait: () => exit.promise,
    }));
    const run = await withGatewayToolCallerIdentity(
      { agentId: "main", sessionKey: "agent:main:settlement-recovery" },
      () =>
        runExecProcess({
          command: "settlement-recovery",
          workdir: "/tmp",
          env: {},
          usePty: false,
          warnings: [],
          maxOutput: 1000,
          pendingMaxOutput: 1000,
          scopeKey,
          sessionKey: "agent:main:settlement-recovery",
          notifyOnExit: true,
          timeoutSec: null,
          onSettledBeforeNotify: (outcome) => {
            observed.push(`task:${outcome.status}`);
            identities.push(getGatewayToolCallerIdentity());
            if (boundary === "task" && observed.length === 1) {
              throw failure;
            }
          },
        }),
    );
    markBackgrounded(run.session);
    const joined = waitForExecScope(scopeKey).then(() => {
      observed.push("scope-released");
    });
    exit.resolve(createRunExit());

    const outcome = await run.promise;
    await joined;
    expect(outcome.status).toBe("failed");
    expect(observed).toEqual(trace);
    expect(identities).toEqual([undefined, undefined]);
  });
});

describe("runExecProcess exit outcomes", () => {
  it("keeps non-zero normal exits in the completed path", async () => {
    const { outcome } = await runExecWithExit({
      stdout: "done",
      exit: createRunExit({ exitCode: 1, durationMs: 123 }),
      timeoutSec: 30,
    });
    expect(outcome.status).toBe("completed");
    if (outcome.status !== "completed") {
      throw new Error(`Expected completed outcome, got ${outcome.status}`);
    }
    expect(outcome.exitCode).toBe(1);
    expect(outcome.aggregated).toBe("done\n\n(Command exited with code 1)");
  });
});

describe("runExecProcess PTY fallback", () => {
  afterEach(() => {
    resetDiagnosticEventsForTest();
  });

  function runPtyFallback(warnings: string[] = []) {
    return runTestExecProcess({
      command: "printf ok",
      workdir: process.cwd(),
      usePty: true,
      warnings,
      maxOutput: 20_000,
      pendingMaxOutput: 20_000,
      timeoutSec: 5,
    });
  }

  function spawnInput(index: number): SpawnInput {
    const call = supervisorMock.spawn.mock.calls[index] as [SpawnInput] | undefined;
    if (!call) {
      throw new Error(`expected supervisor spawn call ${index}`);
    }
    return call[0];
  }

  it("visibly falls back when the portable worker rejects PTY", async () => {
    supervisorMock.spawn
      .mockRejectedValueOnce(new Error("PTY is unavailable in the portable worker runtime"))
      .mockImplementationOnce(async (input: SpawnInput) => runtimeManagedRun(input, "ok"));

    const warnings: string[] = [];
    const handle = await runPtyFallback(warnings);
    const outcome = await handle.promise;

    expect(outcome.status).toBe("completed");
    expect(outcome.aggregated).toContain("ok");
    expect(warnings.join("\n")).toContain("PTY is unavailable in the portable worker runtime");
    expect(spawnInput(0).mode).toBe("pty");
    expect(spawnInput(1).mode).toBe("child");
  });

  it("cleans session state when PTY fallback spawn also fails", async () => {
    supervisorMock.spawn
      .mockRejectedValueOnce(new Error("pty spawn failed"))
      .mockRejectedValueOnce(new Error("child fallback failed"));

    await expect(runPtyFallback()).rejects.toThrow("child fallback failed");

    expect(listRunningSessions()).toHaveLength(0);
  });

  it("emits bounded process diagnostics without command text", async () => {
    supervisorMock.spawn.mockImplementationOnce(async (input: SpawnInput) =>
      runtimeManagedRun(input, "ok"),
    );
    const events: DiagnosticEventPayload[] = [];
    const metadataByEvent = new Map<DiagnosticEventPayload, DiagnosticEventMetadata>();
    const unsubscribe = onInternalDiagnosticEvent((event, metadata) => {
      events.push(event);
      metadataByEvent.set(event, metadata);
    });
    try {
      const command = "printf super-secret-value";
      const handle = await runTestExecProcess({
        command,
        workdir: process.cwd(),
        maxOutput: 20_000,
        pendingMaxOutput: 20_000,
        sessionKey: "session-1",
        timeoutSec: 5,
      });

      await handle.promise;
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });

      const event = events.find(
        (item): item is DiagnosticExecProcessCompletedEvent =>
          item.type === "exec.process.completed",
      );
      if (!event) {
        throw new Error("Expected exec process completed event");
      }
      expect(event.type).toBe("exec.process.completed");
      // The payload stays untrusted, but exporters need the ambient trace context marked
      // OpenClaw-owned or the exec span cannot be nested under the run that spawned it.
      expect(metadataByEvent.get(event)?.trusted).toBe(false);
      expect(metadataByEvent.get(event)?.trustedTraceContext).toBe(true);
      expect(event.target).toBe("host");
      expect(event.mode).toBe("child");
      expect(event.outcome).toBe("completed");
      expect(typeof event.durationMs).toBe("number");
      expect(event.commandLength).toBe(command.length);
      expect(event.exitCode).toBe(0);
      expect(event.sessionKey).toBe("session-1");
      const serialized = JSON.stringify(event);
      expect(serialized).not.toContain("printf");
      expect(serialized).not.toContain("super-secret-value");
      expect(serialized).not.toContain(process.cwd());
    } finally {
      unsubscribe();
    }
  });
});

function successfulSupervisorRun() {
  return {
    activity: { resultSettled: true, lastOutputAtMs: Date.now() },
    runId: "mock-run",
    startedAtMs: Date.now(),
    wait: async () => createRunExit({ durationMs: 0 }),
    cancel: vi.fn(),
  };
}

function requireHeartbeatCall(): Record<string, unknown> {
  const call = requestHeartbeatMock.mock.calls[0];
  if (!call) {
    throw new Error("expected heartbeat call");
  }
  return call[0] as Record<string, unknown>;
}

describe("exec notifyOnExit suppression", () => {
  async function runBackgroundedExit(params: {
    reason: "manual-cancel" | "overall-timeout";
    stdout?: string;
  }) {
    supervisorMock.spawn.mockImplementationOnce(
      async (input: { onStdout?: (chunk: string) => void }) => {
        if (params.stdout) {
          input.onStdout?.(params.stdout);
        }
        const activity = { resultSettled: false, lastOutputAtMs: Date.now() };
        return {
          activity,
          runId: "run-1",
          startedAtMs: Date.now(),
          pid: 123,
          wait: async () => {
            await new Promise((resolve) => {
              setImmediate(resolve);
            });
            activity.resultSettled = true;
            return {
              reason: params.reason,
              exitCode: null,
              exitSignal: "SIGKILL",
              durationMs: 10,
              stdout: "",
              stderr: "",
              timedOut: params.reason === "overall-timeout",
              noOutputTimedOut: false,
            };
          },
          cancel: vi.fn(),
        };
      },
    );

    const run = await runTestExecProcess({
      command: "sleep 999",
      notifyOnExit: true,
      notifyOnExitEmptySuccess: false,
      sessionKey: "agent:main:main",
    });
    markBackgrounded(run.session);
    return await run.promise;
  }

  it.each(["partial output\n"])(
    "keeps manually canceled background execs silent (output=%j)",
    async (stdout) => {
      const outcome = await runBackgroundedExit({ reason: "manual-cancel", stdout });

      expect(outcome.status).toBe("failed");
      expect(enqueueSystemEventReceiptMock).not.toHaveBeenCalled();
      expect(requestHeartbeatMock).not.toHaveBeenCalled();
    },
  );

  it("still notifies for no-output background exec timeouts", async () => {
    await runBackgroundedExit({ reason: "overall-timeout" });

    const [message, options] = requireSystemEventCall();
    expect(message).toContain("Exec failed");
    expect(message).toContain("external side effects may already have completed");
    expect(message).toContain("Verify the resulting state before retrying");
    expect(message).toContain("Do not automatically rerun non-idempotent commands");
    expect(options.sessionKey).toBe("agent:main:main");
    expect(requestHeartbeatMock).toHaveBeenCalledTimes(1);
    const heartbeat = requireHeartbeatCall();
    expect(heartbeat.coalesceMs).toBe(0);
    expect(heartbeat.reason).toBe("exec-event");
    expect(heartbeat.sessionKey).toBe("agent:main:main");
  });

  it("keeps background exec exit-notification snippets on a UTF-16 boundary", async () => {
    const head = "a".repeat(178);
    const overflowingOutput = `${head}🎉${"b".repeat(30)}`;
    await runBackgroundedExit({ reason: "overall-timeout", stdout: overflowingOutput });

    const [message] = requireSystemEventCall();
    const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;
    expect(message).not.toMatch(loneSurrogate);
    expect(message).toContain("…");
    expect(message).toContain(head);
  });

  it("keeps the notify tail source on a UTF-16 boundary", async () => {
    const prefix = "a".repeat(101);
    const tailHead = "b".repeat(179);
    const overflowingOutput = `${prefix}🎉${tailHead}${"c".repeat(220)}`;
    await runBackgroundedExit({ reason: "overall-timeout", stdout: overflowingOutput });

    const [message] = requireSystemEventCall();
    const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;
    expect(message).not.toMatch(loneSurrogate);
    expect(message).not.toContain("�");
    expect(message).toContain(tailHead);
  });
});

describe("runExecProcess POSIX command wrapper", () => {
  it("normalizes non-finite and oversized exec timeouts before spawning", async () => {
    supervisorMock.spawn.mockResolvedValue(successfulSupervisorRun());

    const baseParams = {
      command: "echo test",
      env: { PATH: "/usr/bin" },
      pathPrepend: [],
    };

    await runTestExecProcess({
      ...baseParams,
      timeoutSec: Number.POSITIVE_INFINITY,
    });
    await runTestExecProcess({
      ...baseParams,
      timeoutSec: 3_000_000,
    });

    expect(supervisorMock.spawn.mock.calls[0]?.[0].timeoutMs).toBeUndefined();
    expect(supervisorMock.spawn.mock.calls[1]?.[0].timeoutMs).toBe(MAX_SAFE_TIMEOUT_DELAY_MS);
  });

  it("wraps command with PATH export if OPENCLAW_PREPEND_PATH is present", async () => {
    if (process.platform === "win32") {
      return;
    }

    supervisorMock.spawn.mockResolvedValueOnce(successfulSupervisorRun());

    await runTestExecProcess({
      command: "echo test",
      env: { PATH: "/usr/bin" },
      pathPrepend: ["/custom/bin", "/opt/bin"],
    });

    const spawnCall = expectDefined(
      supervisorMock.spawn.mock.calls[0],
      "supervisorMock.spawn.mock.calls[0] test invariant",
    )[0];
    expect(spawnCall.argv.join(" ")).toContain(
      'export PATH="${OPENCLAW_PREPEND_PATH}${PATH:+:$PATH}"; unset OPENCLAW_PREPEND_PATH; echo test',
    );
  });

  it("does not wrap command on Windows", async () => {
    if (process.platform !== "win32") {
      return;
    }

    supervisorMock.spawn.mockResolvedValueOnce(successfulSupervisorRun());
    await runTestExecProcess({
      command: "echo test",
      workdir: "C:\\tmp",
      env: { Path: "C:\\Windows\\System32" },
      pathPrepend: ["C:\\custom\\bin"],
    });

    const spawnCall = expectDefined(
      supervisorMock.spawn.mock.calls[0],
      "supervisorMock.spawn.mock.calls[0] test invariant",
    )[0];
    const commandStr = spawnCall.argv.join(" ");
    expect(commandStr).not.toContain("export PATH=");
    expect(commandStr).toContain("echo test");
  });
});

describe("runExecProcess stream sanitization", () => {
  function runStyledExec() {
    return runTestExecProcess({
      command: "printf styled",
      workdir: process.cwd(),
      maxOutput: 20_000,
      pendingMaxOutput: 20_000,
      timeoutSec: 5,
    });
  }

  it("sanitizes ANSI and OSC sequences split across stdout chunks", async () => {
    supervisorMock.spawn.mockImplementationOnce(async (input: SpawnInput) => {
      for (const chunk of [
        "A\u001B]0;title",
        "\u0007B",
        "C\u001B[31",
        "mD",
        "E\u009D0;title",
        "\u001B\\F",
        "G\u009B31",
        "mH",
      ]) {
        input.onStdout?.(chunk);
      }
      return runtimeManagedRun(input);
    });

    const outcome = await (await runStyledExec()).promise;
    expect(outcome.aggregated).toContain("ABCDEFGH");
    expect(outcome.aggregated).not.toContain("\\x1b");
  });

  it("keeps stdout and stderr parser state independent", async () => {
    supervisorMock.spawn.mockImplementationOnce(async (input: SpawnInput) => {
      input.onStdout?.("out\u001B[");
      input.onStderr?.("err\u001B[");
      input.onStdout?.("32mOUT");
      input.onStderr?.("31mERR");
      return runtimeManagedRun(input);
    });

    const outcome = await (await runStyledExec()).promise;
    expect(outcome.aggregated).toBe("outerrOUTERR");
  });
});
