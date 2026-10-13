// Recycle a reused Vitest worker once its heap passes a bound.
//
// Configs here run with isolate off, so one worker keeps its module graph and anything a test file
// leaves reachable while it runs file after file. Vitest only recycles by memory in its vm pools.
// For the threads and forks pools it asks the worker's canReuse() before handing it the next file,
// and a false answer stops that worker and starts a fresh one. This wraps a worker so it reports its
// heap after every file (Vitest's own reportMemory) and declines reuse once that heap reaches
// OPENCLAW_TEST_WORKER_RECYCLE_MB. Unset, nothing is wrapped and the pools behave exactly as before.
import {
  ForksPoolWorker,
  ThreadsPoolWorker,
  type PoolOptions,
  type PoolTask,
  type PoolWorker,
  type WorkerRequest,
} from "vitest/node";
import { isRecord } from "../../packages/normalization-core/src/record-coerce.ts";

export const WORKER_RECYCLE_MB_ENV = "OPENCLAW_TEST_WORKER_RECYCLE_MB";

export function resolveWorkerRecycleBytes(
  env: Record<string, string | undefined> = process.env,
): number | null {
  const raw = env[WORKER_RECYCLE_MB_ENV]?.trim();
  if (!raw) {
    return null;
  }
  const mb = Number(raw);
  if (!Number.isInteger(mb) || mb <= 0) {
    throw new Error(
      `${WORKER_RECYCLE_MB_ENV} must be a positive integer, got ${JSON.stringify(raw)}`,
    );
  }
  return mb * 1024 * 1024;
}

type BoundableWorker = PoolWorker & { start(): Promise<void>; send(message: WorkerRequest): void };

function environmentKey(environment: unknown): string {
  return JSON.stringify(environment ?? null);
}

/** Make a worker report its heap per file and decline reuse at the bound. */
export function applyHeapBound<T extends BoundableWorker>(
  worker: T,
  name: string,
  limitBytes: number,
): T {
  let usedBytes = 0;
  let environment: string | undefined;
  const observe = (message: unknown) => {
    if (
      isRecord(message) &&
      message.type === "testfileFinished" &&
      typeof message.usedMemory === "number"
    ) {
      usedBytes = message.usedMemory;
    }
  };
  // The pool matches a reusable worker to a task by name, so a renamed pool needs a renamed worker.
  Object.defineProperty(worker, "name", { value: name, configurable: true });
  Object.defineProperty(worker, "reportMemory", { value: true, configurable: true });
  const start = worker.start.bind(worker);
  worker.start = async () => {
    await start();
    worker.on("message", observe);
  };
  const send = worker.send.bind(worker);
  worker.send = (message: WorkerRequest) => {
    if (message.type === "run" || message.type === "collect") {
      environment = environmentKey(message.context.environment);
    }
    send(message);
  };
  // Defining canReuse replaces Vitest's environment comparison, so it is kept here.
  worker.canReuse = (task: PoolTask) =>
    environment === environmentKey(task.context.environment) && usedBytes < limitBytes;
  return worker;
}

export function recyclingPool(kind: "threads" | "forks", limitBytes: number) {
  const name = `openclaw-${kind}-recycling`;
  return {
    name,
    createPoolWorker: (options: PoolOptions) =>
      applyHeapBound(
        kind === "threads" ? new ThreadsPoolWorker(options) : new ForksPoolWorker(options),
        name,
        limitBytes,
      ),
  };
}

/** The pool a non-isolated config runs with: recycling when the bound is set, else unchanged. */
export function withWorkerRecycling<P>(
  pool: P,
  isolate: boolean,
  env: Record<string, string | undefined> = process.env,
): P | ReturnType<typeof recyclingPool> {
  const limit = resolveWorkerRecycleBytes(env);
  if (limit === null || isolate || (pool !== "threads" && pool !== "forks")) {
    return pool;
  }
  return recyclingPool(pool, limit);
}
