import os from "node:os";
import { setTimeout as delay } from "node:timers/promises";

export type VitestMemoryAdmission = (
  lane: number,
  pending: () => boolean,
) => Promise<(() => void) | undefined>;

export type VitestMemoryAdmissionOptions = {
  /** Measured peak resident memory of one shard process tree. */
  shardBytes: number;
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
  const reservations = new Set<{ at: number }>();
  const reservedBytes = () => {
    const at = now();
    for (const reservation of reservations) {
      if (at - reservation.at >= rampMs) {
        reservations.delete(reservation);
      }
    }
    return reservations.size * options.shardBytes;
  };
  const reserve = () => {
    const reservation = { at: now() };
    reservations.add(reservation);
    return () => {
      reservations.delete(reservation);
    };
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
