import { stat } from "node:fs/promises";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import {
  extractErrorCode,
  toErrorObject as toLintErrorObject,
} from "openclaw/plugin-sdk/error-runtime";
import { isPathInside } from "openclaw/plugin-sdk/file-access-runtime";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  deleteCheckpointProvenance,
  readCheckpointProvenance,
  writeCheckpointProvenance,
  type LobsterCheckpointCaller,
  type LobsterCheckpointHandle,
  type LobsterCheckpointProvenance,
  type LobsterLlmStage,
} from "./lobster-checkpoint-provenance.js";

type LobsterEnvelope =
  | {
      ok: true;
      status: "ok" | "needs_approval" | "cancelled";
      output: unknown[];
      requiresApproval: null | {
        type: "approval_request";
        prompt: string;
        items: unknown[];
        resumeToken?: string;
        approvalId?: string;
      };
    }
  | {
      ok: false;
      error: { type?: string; message: string };
    };

export type LobsterRunnerParams = {
  action: "run" | "resume";
  pipeline?: string;
  argsJson?: string;
  token?: string;
  approvalId?: string;
  approve?: boolean;
  /** True to cancel the checkpoint instead of approving or rejecting it. */
  cancel?: boolean;
  cwd: string;
  timeoutMs: number;
  maxStdoutBytes: number;
  /**
   * The live gateway request's abort signal. Linked into the runner's controller,
   * so Lobster's state-lock waits and resume-state consumption observe request
   * cancellation instead of running to completion after the client is gone.
   */
  signal?: AbortSignal;
};

export type LobsterRunner = {
  run: (params: LobsterRunnerParams) => Promise<LobsterEnvelope>;
};

type EmbeddedLlmAdapter = {
  source?: string;
  invoke: (params: {
    env?: Record<string, string | undefined>;
    args?: Record<string, unknown>;
    payload: unknown;
    signal?: AbortSignal;
  }) => Promise<unknown>;
};

type EmbeddedToolContext = {
  registry?: LobsterRegistry;
  cwd?: string;
  env?: Record<string, string | undefined>;
  mode?: "tool" | "human" | "sdk";
  stdin?: NodeJS.ReadableStream;
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
  signal?: AbortSignal;
  llmAdapters?: Record<string, EmbeddedLlmAdapter>;
};

type EmbeddedToolEnvelope = {
  ok: boolean;
  status?: "ok" | "needs_approval" | "needs_input" | "cancelled";
  output?: unknown[];
  requiresApproval?: {
    prompt: string;
    items: unknown[];
    resumeToken?: string;
    approvalId?: string;
  } | null;
  requiresInput?: {
    resumeToken?: string;
  } | null;
  error?: {
    message: string;
  };
};

type EmbeddedToolRuntime = {
  createDefaultRegistry?: () => LobsterRegistry;
  runToolRequest: (params: {
    pipeline?: string;
    filePath?: string;
    args?: Record<string, unknown>;
    ctx?: EmbeddedToolContext;
  }) => Promise<EmbeddedToolEnvelope>;
  resumeToolRequest: (params: {
    token?: string;
    approvalId?: string;
    approved?: boolean;
    ctx?: EmbeddedToolContext;
  }) => Promise<EmbeddedToolEnvelope>;
};

const workflowExts = new Set([".lobster", ".yaml", ".yml", ".json"]);

export function resolveLobsterCwd(cwdRaw: unknown): string {
  if (typeof cwdRaw !== "string" || !cwdRaw.trim()) {
    return process.cwd();
  }
  const cwd = cwdRaw.trim();
  if (path.isAbsolute(cwd)) {
    throw new Error("cwd must be a relative path");
  }
  const base = process.cwd();
  const resolved = path.resolve(base, cwd);

  if (!isPathInside(base, resolved)) {
    throw new Error("cwd must stay within the gateway working directory");
  }
  return resolved;
}

function createLimitedSink(maxBytes: number, label: "stdout" | "stderr") {
  let bytes = 0;
  return new Writable({
    write(chunk, _encoding, callback) {
      bytes += Buffer.byteLength(String(chunk), "utf8");
      if (bytes > maxBytes) {
        callback(new Error(`lobster ${label} exceeded maxStdoutBytes`));
        return;
      }
      callback();
    },
  });
}

function normalizeEnvelope(
  envelope: EmbeddedToolEnvelope,
  maxStdoutBytes: number,
): Extract<LobsterEnvelope, { ok: true }> {
  if (!envelope.ok) {
    throw new Error(envelope.error?.message ?? "lobster runtime failed");
  }
  if (envelope.status === "needs_input") {
    throw new Error("Lobster input requests are not supported by the OpenClaw Lobster tool yet");
  }
  const normalized: Extract<LobsterEnvelope, { ok: true }> = {
    ok: true,
    status: envelope.status ?? "ok",
    output: Array.isArray(envelope.output) ? envelope.output : [],
    requiresApproval: envelope.requiresApproval
      ? {
          type: "approval_request",
          prompt: envelope.requiresApproval.prompt,
          items: envelope.requiresApproval.items,
          ...(envelope.requiresApproval.resumeToken
            ? { resumeToken: envelope.requiresApproval.resumeToken }
            : {}),
          ...(envelope.requiresApproval.approvalId
            ? { approvalId: envelope.requiresApproval.approvalId }
            : {}),
        }
      : null,
  };
  if (Buffer.byteLength(JSON.stringify(normalized, null, 2), "utf8") > maxStdoutBytes) {
    throw new Error("lobster runtime result exceeded maxStdoutBytes");
  }
  return normalized;
}

async function detectWorkflowFile(candidate: string, cwd: string) {
  const trimmed = candidate.trim();
  if (!trimmed || trimmed.includes("|") || !workflowExts.has(path.extname(trimmed).toLowerCase())) {
    return null;
  }
  const resolved = path.isAbsolute(trimmed) ? trimmed : path.resolve(cwd, trimmed);
  try {
    if (!(await stat(resolved)).isFile()) {
      throw new Error("Workflow path is not a file");
    }
    return resolved;
  } catch (error) {
    if (/\s/.test(trimmed) && extractErrorCode(error) === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function createEmbeddedToolContext(
  params: LobsterRunnerParams,
  signal?: AbortSignal,
  llmAdapters?: Record<string, EmbeddedLlmAdapter>,
  registry?: LobsterRegistry,
): EmbeddedToolContext {
  const env = { ...process.env } as Record<string, string | undefined>;
  return {
    cwd: params.cwd,
    env,
    mode: "tool",
    stdin: Readable.from([]),
    stdout: createLimitedSink(Math.max(1024, params.maxStdoutBytes), "stdout"),
    stderr: createLimitedSink(Math.max(1024, params.maxStdoutBytes), "stderr"),
    signal,
    ...(llmAdapters ? { llmAdapters } : {}),
    ...(registry ? { registry } : {}),
  };
}

async function withTimeout<T>(
  timeoutMs: number,
  fn: (signal?: AbortSignal) => Promise<T>,
  external?: AbortSignal,
): Promise<T> {
  const timeout = Math.max(200, timeoutMs);
  const controller = new AbortController();
  // The live request signal is linked into this controller, so Lobster state-lock
  // waits and resume consumption observe the client going away instead of
  // running to completion after it is gone.
  const onExternalAbort = () => controller.abort(external?.reason);
  const unlink = () => external?.removeEventListener("abort", onExternalAbort);
  if (external) {
    if (external.aborted) controller.abort(external.reason);
    else external.addEventListener("abort", onExternalAbort, { once: true });
  }
  return await new Promise<T>((resolve, reject) => {
    const onTimeout = () => {
      const error = new Error("lobster runtime timed out");
      controller.abort(error);
      reject(error);
    };

    const timer = setTimeout(onTimeout, timeout);
    void fn(controller.signal).then(
      (value) => {
        clearTimeout(timer);
        unlink();
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        unlink();
        reject(toLintErrorObject(error, "Non-Error rejection"));
      },
    );
  });
}

async function loadEmbeddedToolRuntimeFromPackage(): Promise<EmbeddedToolRuntime> {
  // Joined specifier keeps bundlers from statically resolving
  // @clawdbot/lobster/core; the plugin's declared @clawdbot/lobster dependency
  // provides it at runtime, so it is a used direct dependency.
  const coreSpecifier = ["@clawdbot", "lobster", "core"].join("/");
  return (await import(coreSpecifier)) as EmbeddedToolRuntime;
}

type LobsterCommand = {
  name: string;
  run: (params: {
    input: AsyncIterable<unknown>;
    args: Record<string, unknown>;
    ctx: { env?: Record<string, string | undefined> } & Record<string, unknown>;
  }) => Promise<{ output?: AsyncIterable<unknown> } & Record<string, unknown>>;
} & Record<string, unknown>;

type LobsterRegistry = {
  get: (name: string) => LobsterCommand | undefined;
  list: () => string[];
};

export type LobsterReplayRequest = { provider: string; command: string };

const LLM_COMMANDS = new Set(["llm.invoke", "llm_task.invoke"]);

/**
 * Whether a stage explicitly chose the embedded route, by its own provider
 * argument or by LOBSTER_LLM_PROVIDER in its FINAL environment (process, then
 * workflow, then step blocks, which Lobster merges before the command runs). The
 * embedded route is opt-in, so it is never inferred from the routes the
 * environment happens to configure.
 */
function embeddedRouteWasRequested(
  args: Record<string, unknown>,
  env: Record<string, string | undefined>,
): boolean {
  const stepProvider = typeof args.provider === "string" ? args.provider.trim().toLowerCase() : "";
  if (stepProvider) {
    return stepProvider === "embedded";
  }
  return (env.LOBSTER_LLM_PROVIDER ?? "").trim().toLowerCase() === "embedded";
}

/**
 * The route label recorded for a non-embedded stage, for provenance and the
 * saved-answer re-authorization request only. Embedded output is the
 * `"embedded"` label, which is set separately; a provider-omitted stage is left
 * for Lobster to resolve, so its label falls back to the adapter source Lobster
 * reported.
 */
function nonEmbeddedRouteLabel(
  args: Record<string, unknown>,
  env: Record<string, string | undefined>,
  items: unknown[],
): string {
  const stepProvider = typeof args.provider === "string" ? args.provider.trim().toLowerCase() : "";
  if (stepProvider) {
    return stepProvider;
  }
  const configured = (env.LOBSTER_LLM_PROVIDER ?? "").trim().toLowerCase();
  if (configured) {
    return configured;
  }
  for (const item of items) {
    if (isRecord(item) && typeof item.source === "string" && item.source) {
      return item.source;
    }
  }
  return "external";
}

async function* replayItems(items: unknown[]): AsyncIterable<unknown> {
  yield* items;
}

/** LLM stages that executed during one runner call, and the caller an embedded one spent. */
type LlmStageTrace = { stages: LobsterLlmStage[]; caller?: LobsterCheckpointCaller };

function mergeCaller(
  previous: LobsterCheckpointCaller | undefined,
  current: LobsterCheckpointCaller | undefined,
): LobsterCheckpointCaller | undefined {
  if (!previous || !current) {
    return previous ?? current;
  }
  // The resume was authorized, so both name the same agent; keep the union of
  // authority so a later resume must hold everything either caller spent.
  return {
    ...(previous.agentId ? { agentId: previous.agentId } : {}),
    authority: [...new Set([...previous.authority, ...current.authority])].toSorted(),
  };
}

function nextProvenance(
  previous: LobsterCheckpointProvenance | undefined,
  resumed: boolean,
  trace: LlmStageTrace,
): LobsterCheckpointProvenance {
  const stages = new Map<string, LobsterLlmStage>();
  for (const stage of [...(previous?.stages ?? []), ...trace.stages]) {
    stages.set(`${stage.provider}\u0000${stage.command}`, stage);
  }
  const caller = mergeCaller(previous?.caller, trace.caller);
  return {
    version: 1,
    stages: [...stages.values()],
    ...(caller ? { caller } : {}),
    ...(resumed && (!previous || previous.untrackedOrigin) ? { untrackedOrigin: true } : {}),
  };
}

function checkpointHandle(envelope: EmbeddedToolEnvelope): LobsterCheckpointHandle | undefined {
  if (!envelope.ok) {
    return undefined;
  }
  if (envelope.status === "needs_approval" && envelope.requiresApproval) {
    return {
      token: envelope.requiresApproval.resumeToken,
      approvalId: envelope.requiresApproval.approvalId,
    };
  }
  if (envelope.status === "needs_input" && envelope.requiresInput) {
    return { token: envelope.requiresInput.resumeToken };
  }
  return undefined;
}

/**
 * Wrap Lobster's LLM commands at the one point every stage passes through,
 * inline, workflow and resumed alike, after the stage environment is merged:
 *
 * - Embedded stages spend the caller's own model authority, so their saved
 *   store is hidden entirely: nothing is read from or written to the persistent
 *   cache or run state, and every embedded stage executes under a fresh host
 *   authorization. These are command arguments, which a workflow, a step
 *   environment or a `--refresh false` flag cannot override.
 * - Other routes keep their cache, but a saved answer is shown only after the
 *   caller is re-authorized. A fresh call is not gated here, because the remote
 *   provider applies its own credentials. The direct adapter is hidden from the
 *   runtime for these stages, so Lobster's sole-adapter preference cannot move a
 *   provider-omitted step onto the embedded route: the runtime resolves the
 *   route from the step, then the environment, exactly as it did before the
 *   adapter existed.
 */
function wrapLlmCommands(
  base: LobsterRegistry,
  authorizeReplay: (request: LobsterReplayRequest) => Promise<void>,
  onStage: (stage: LobsterLlmStage) => void,
  beforeStage: () => Promise<void>,
): LobsterRegistry {
  const drain = async (
    result: { output?: AsyncIterable<unknown> } & Record<string, unknown>,
  ): Promise<unknown[]> => {
    const items: unknown[] = [];
    for await (const item of result.output ?? replayItems([])) {
      items.push(item);
    }
    return items;
  };
  const wasReplayed = (items: unknown[]): boolean =>
    items.some((item) => isRecord(item) && item.replayed === true);
  return {
    list: () => base.list(),
    get(name) {
      const command = base.get(name);
      if (!command || !LLM_COMMANDS.has(name)) {
        return command;
      }
      return {
        ...command,
        async run({ input, args, ctx }) {
          await beforeStage();
          const env = ctx.env ?? {};
          if (embeddedRouteWasRequested(args, env)) {
            const result = await command.run({
              input,
              ctx,
              args: {
                ...args,
                provider: "embedded",
                refresh: true,
                "disable-cache": true,
                "state-key": "",
              },
            });
            const items = await drain(result);
            onStage({ provider: "embedded", command: name });
            if (wasReplayed(items)) {
              await authorizeReplay({ provider: "embedded", command: name });
            }
            return { ...result, output: replayItems(items) };
          }
          const result = await command.run({
            input,
            ctx: { ...ctx, llmAdapters: undefined },
            args,
          });
          const items = await drain(result);
          const provider = nonEmbeddedRouteLabel(args, env, items);
          onStage({ provider, command: name });
          if (wasReplayed(items)) {
            await authorizeReplay({ provider, command: name });
          }
          return { ...result, output: replayItems(items) };
        },
      };
    },
  };
}

export function createEmbeddedLobsterRunner(options?: {
  loadRuntime?: () => Promise<EmbeddedToolRuntime>;
  llmAdapters?: Record<string, EmbeddedLlmAdapter>;
  /** Re-authorizes the caller before a saved non-embedded answer is shown. Required with llmAdapters. */
  authorizeReplay?: (request: LobsterReplayRequest) => Promise<void>;
  /**
   * Re-authorizes the caller before a resume discloses or consumes what a
   * checkpoint stored. Receives undefined for a checkpoint with no record.
   * Required with llmAdapters.
   */
  authorizeCheckpoint?: (provenance: LobsterCheckpointProvenance | undefined) => Promise<void>;
  /** The current caller's agent and authority, recorded when an embedded stage runs. Required with llmAdapters. */
  describeCaller?: () => LobsterCheckpointCaller;
}): LobsterRunner {
  const loadRuntime = options?.loadRuntime ?? loadEmbeddedToolRuntimeFromPackage;
  let runtimePromise: Promise<EmbeddedToolRuntime> | undefined;
  return {
    async run(params) {
      runtimePromise ??= loadRuntime();
      const runtime = await runtimePromise;
      let registry: LobsterRegistry | undefined;
      // Re-runs the resumed checkpoint's producer check at each downstream LLM
      // dispatch boundary; undefined for a fresh run.
      let reauthorizeResume: (() => Promise<void>) | undefined;
      let checkpoints:
        | {
            authorize: (provenance: LobsterCheckpointProvenance | undefined) => Promise<void>;
            trace: LlmStageTrace;
          }
        | undefined;
      if (options?.llmAdapters) {
        const { authorizeReplay, authorizeCheckpoint, describeCaller } = options;
        if (
          !runtime.createDefaultRegistry ||
          !authorizeReplay ||
          !authorizeCheckpoint ||
          !describeCaller
        ) {
          throw new Error(
            "lobster embedded route requires the Lobster command registry, a replay authorizer and a checkpoint authorizer",
          );
        }
        const trace: LlmStageTrace = { stages: [] };
        checkpoints = { authorize: authorizeCheckpoint, trace };
        registry = wrapLlmCommands(
          runtime.createDefaultRegistry(),
          authorizeReplay,
          (stage) => {
            trace.stages.push(stage);
            if (stage.provider === "embedded") {
              trace.caller = mergeCaller(trace.caller, describeCaller());
            }
          },
          async () => await reauthorizeResume?.(),
        );
      }
      return await withTimeout(
        params.timeoutMs,
        async (signal) => {
          const ctx = createEmbeddedToolContext(params, signal, options?.llmAdapters, registry);
          let envelope: EmbeddedToolEnvelope;
          let resumed:
            | { handle: LobsterCheckpointHandle; provenance?: LobsterCheckpointProvenance }
            | undefined;

          if (params.action === "run") {
            const pipeline = params.pipeline?.trim() ?? "";
            if (!pipeline) {
              throw new Error("pipeline required");
            }

            const filePath = await detectWorkflowFile(pipeline, params.cwd);
            if (filePath) {
              const parsedArgsJson = params.argsJson?.trim() ?? "";
              let args: Record<string, unknown> | undefined;
              if (parsedArgsJson) {
                try {
                  args = JSON.parse(parsedArgsJson) as Record<string, unknown>;
                } catch {
                  throw new Error("run --args-json must be valid JSON");
                }
              }
              envelope = await runtime.runToolRequest({ filePath, args, ctx });
            } else {
              envelope = await runtime.runToolRequest({ pipeline, ctx });
            }
          } else {
            const token = params.token?.trim() ?? "";
            const approvalId = params.approvalId?.trim() ?? "";
            if (!token && !approvalId) {
              throw new Error("token or approvalId required");
            }
            if (token && approvalId) {
              throw new Error("provide either token or approvalId, not both");
            }
            const hasCancel = params.cancel === true;
            if (!hasCancel && typeof params.approve !== "boolean") {
              throw new Error("approve required");
            }
            if (checkpoints && hasCancel) {
              // Cancelling discloses nothing and deletes the stored output.
              const handle = { token, approvalId };
              await deleteCheckpointProvenance(ctx.env ?? {}, handle);
              resumed = { handle };
            } else if (checkpoints) {
              // Lobster hands a checkpoint's stored stage output to the remaining
              // stages, or back to the caller, without running those stages again, so
              // the LLM command wrapper never sees it. Authorize the caller against
              // what the checkpoint carries before Lobster claims or consumes it; a
              // refusal leaves the checkpoint intact for a caller who may resume it.
              // A rejected approval is gated too: a workflow continues past one.
              const handle = { token, approvalId };
              const provenance = await readCheckpointProvenance(ctx.env ?? {}, handle);
              await checkpoints.authorize(provenance);
              resumed = { handle, ...(provenance ? { provenance } : {}) };
              reauthorizeResume = async () => {
                await checkpoints.authorize(provenance);
              };
            }
            envelope = await runtime.resumeToolRequest({
              ...(token ? { token } : {}),
              ...(approvalId ? { approvalId } : {}),
              approved: params.approve,
              ctx,
            });
          }
          // Record what a checkpoint left for a later resume to authorize: the LLM
          // stages whose output reached it, and the caller an embedded stage spent.
          if (checkpoints) {
            const handle = checkpointHandle(envelope);
            if (handle) {
              await writeCheckpointProvenance(
                ctx.env ?? {},
                handle,
                nextProvenance(resumed?.provenance, resumed !== undefined, checkpoints.trace),
              );
            }
          }
          return normalizeEnvelope(envelope, Math.max(1024, params.maxStdoutBytes));
        },
        params.signal,
      );
    },
  };
}
