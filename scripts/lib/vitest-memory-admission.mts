import os from "node:os";
import { setTimeout as delay } from "node:timers/promises";

/** Releases a shard's reservation; grantWorkers widens it to more Vitest workers. */
export type VitestAdmissionRelease = (() => void) & {
  grantWorkers?: (wanted: number) => number;
};

export type VitestMemoryAdmission = (
  lane: number,
  pending: () => boolean,
) => Promise<VitestAdmissionRelease | undefined>;

export type VitestMemoryAdmissionOptions = {
  /** Measured peak resident memory of one shard process tree. */
  shardBytes: number;
  /** Measured memory of one more Vitest worker in a shard; unset keeps every shard on one worker. */
  workerBytes?: number;
  /** Most workers one shard may be granted. */
  maxWorkers?: number;
  /** How long a new shard keeps its reservation before its own usage shows in free memory. */
  rampMs?: number;
  pollMs?: number;
  freeMemoryBytes?: () => number;
  now?: () => number;
  wait?: (ms: number) => Promise<unknown>;
};

/**
 * Admit shards while free memory covers one more shard. Lane zero always runs so a
 * tight host still makes progress; other lanes wait for memory instead of starting
 * into swap. A host whose memory grows on demand admits more shards as it grows.
 */
export function createVitestMemoryAdmission(
  options: VitestMemoryAdmissionOptions,
): VitestMemoryAdmission {
  if (!Number.isFinite(options.shardBytes) || options.shardBytes <= 0) {
    throw new RangeError("shardBytes must be a positive number");
  }
  const rampMs = options.rampMs ?? 30_000;
  const pollMs = options.pollMs ?? 2_000;
  const freeMemoryBytes = options.freeMemoryBytes ?? (() => os.freemem());
  const now = options.now ?? (() => performance.now());
  const wait = options.wait ?? ((ms: number) => delay(ms));
  const workerBytes = options.workerBytes;
  const maxWorkers = Math.max(1, options.maxWorkers ?? 4);
  const reservations = new Set<{ at: number; bytes: number }>();
  const reservedBytes = () => {
    const at = now();
    for (const reservation of reservations) {
      if (at - reservation.at >= rampMs) {
        reservations.delete(reservation);
      }
    }
    let bytes = 0;
    for (const reservation of reservations) {
      bytes += reservation.bytes;
    }
    return bytes;
  };
  const reserve = (): VitestAdmissionRelease => {
    const reservation = { at: now(), bytes: options.shardBytes };
    reservations.add(reservation);
    const release: VitestAdmissionRelease = () => {
      reservations.delete(reservation);
    };
    // A large shard on one worker ran its files serially for hours while the host sat idle.
    // Grant it the extra workers free memory covers now, reserved like a shard so later
    // admissions see them, and restart the ramp because the new workers start from nothing.
    release.grantWorkers = (wanted) => {
      if (!workerBytes || wanted <= 1) {
        return 1;
      }
      const room = freeMemoryBytes() - reservedBytes();
      const extra = Math.max(
        0,
        Math.min(wanted - 1, maxWorkers - 1, Math.floor(room / workerBytes)),
      );
      reservation.bytes += extra * workerBytes;
      reservation.at = now();
      return 1 + extra;
    };
    return release;
  };
  // One waiter decides at a time, so two lanes never both count the same free memory.
  let turn: Promise<unknown> = Promise.resolve();
  return (lane, pending) => {
    const decision = turn.then(async () => {
      while (pending()) {
        if (lane === 0 || freeMemoryBytes() - reservedBytes() >= options.shardBytes) {
          return reserve();
        }
        await wait(pollMs);
      }
      return undefined;
    });
    turn = decision.catch(() => undefined);
    return decision;
  };
}

/** Parse the per-worker memory budget; unset keeps every shard on one Vitest worker. */
export function resolveVitestWorkerMemoryBytes(env: NodeJS.ProcessEnv): number | undefined {
  const raw = env.OPENCLAW_TEST_WORKER_MEMORY_MB?.trim();
  if (!raw) {
    return undefined;
  }
  const megabytes = Number(raw);
  if (!Number.isSafeInteger(megabytes) || megabytes <= 0) {
    throw new Error("OPENCLAW_TEST_WORKER_MEMORY_MB must be a positive integer");
  }
  return megabytes * 1024 * 1024;
}

/** Parse the most workers one shard may be granted; defaults to 4. */
export function resolveVitestShardMaxWorkers(env: NodeJS.ProcessEnv): number {
  const raw = env.OPENCLAW_TEST_SHARD_MAX_WORKERS?.trim();
  if (!raw) {
    return 4;
  }
  const workers = Number(raw);
  if (!Number.isSafeInteger(workers) || workers <= 0) {
    throw new Error("OPENCLAW_TEST_SHARD_MAX_WORKERS must be a positive integer");
  }
  return workers;
}

/** How many workers a shard can use: one per twenty files, every worker for a whole config. */
export function resolveVitestShardWantedWorkers(files: readonly unknown[] | null | undefined) {
  return files == null ? Number.MAX_SAFE_INTEGER : Math.max(1, Math.ceil(files.length / 20));
}

/** Parse the per-shard memory budget; unset keeps the fixed shard parallelism. */
export function resolveVitestShardMemoryBytes(env: NodeJS.ProcessEnv): number | undefined {
  const raw = env.OPENCLAW_TEST_SHARD_MEMORY_MB?.trim();
  if (!raw) {
    return undefined;
  }
  const megabytes = Number(raw);
  if (!Number.isSafeInteger(megabytes) || megabytes <= 0) {
    throw new Error("OPENCLAW_TEST_SHARD_MEMORY_MB must be a positive integer");
  }
  return megabytes * 1024 * 1024;
}
