import { setImmediate as nextTurn } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import {
  createVitestMemoryAdmission,
  resolveVitestShardMaxWorkers,
  resolveVitestShardMemoryBytes,
  resolveVitestShardWantedWorkers,
  resolveVitestWorkerMemoryBytes,
} from "../../scripts/lib/vitest-memory-admission.mts";
import { runVitestPlans } from "../../scripts/lib/vitest-plan-scheduling.mts";
import { createDeferred } from "../helpers/promise.js";

const GIB = 1024 ** 3;

function createClock() {
  let at = 0;
  const waiters: Array<{ until: number; resolve: () => void }> = [];
  return {
    now: () => at,
    wait: (ms: number) =>
      new Promise<void>((resolve) => {
        waiters.push({ until: at + ms, resolve });
      }),
    async advance(ms: number) {
      at += ms;
      for (const waiter of waiters.splice(0)) {
        if (waiter.until <= at) {
          waiter.resolve();
        } else {
          waiters.push(waiter);
        }
      }
      await nextTurn();
    },
  };
}

describe("memory-admitted Vitest shards", () => {
  it("always admits lane zero, even with no free memory", async () => {
    const admit = createVitestMemoryAdmission({ shardBytes: 3 * GIB, freeMemoryBytes: () => 0 });
    const release = await admit(0, () => true);
    expect(release).toBeTypeOf("function");
  });

  it("counts ramping reservations against free memory", async () => {
    const clock = createClock();
    const admit = createVitestMemoryAdmission({
      shardBytes: 3 * GIB,
      rampMs: 30_000,
      pollMs: 1_000,
      freeMemoryBytes: () => 7 * GIB,
      now: clock.now,
      wait: clock.wait,
    });
    await admit(0, () => true);
    // 7 GiB free less one 3 GiB reservation admits one more, not two.
    expect(await admit(1, () => true)).toBeTypeOf("function");
    let third: (() => void) | undefined;
    const waiting = admit(2, () => true).then((release) => {
      third = release;
    });
    await nextTurn();
    expect(third).toBeUndefined();
    await clock.advance(30_000);
    await waiting;
    expect(third).toBeTypeOf("function");
  });

  it("admits again as soon as a finished shard releases its reservation", async () => {
    const clock = createClock();
    const admit = createVitestMemoryAdmission({
      shardBytes: 3 * GIB,
      pollMs: 1_000,
      freeMemoryBytes: () => 6 * GIB,
      now: clock.now,
      wait: clock.wait,
    });
    await admit(0, () => true);
    const second = await admit(1, () => true);
    let admitted = false;
    const waiting = admit(2, () => true).then(() => {
      admitted = true;
    });
    await clock.advance(1_000);
    expect(admitted).toBe(false);
    second?.();
    await clock.advance(1_000);
    await waiting;
    expect(admitted).toBe(true);
  });

  it("grants a large shard the extra workers free memory covers", async () => {
    let free = 12 * GIB;
    const admit = createVitestMemoryAdmission({
      shardBytes: 3 * GIB,
      workerBytes: GIB,
      maxWorkers: 4,
      freeMemoryBytes: () => free,
    });
    const first = await admit(0, () => true);
    // 12 GiB free less its own 3 GiB reservation covers up to 9 extra; the cap is 4 in all.
    expect(first?.grantWorkers?.(8)).toBe(4);
    const second = await admit(1, () => true);
    // 12 - (3 + 3 extra) - 3 = 3 GiB of room: three extra workers, capped by its want of 2.
    expect(second?.grantWorkers?.(2)).toBe(2);
    free = 9 * GIB;
    // Lane zero runs without free memory; 9 GiB less 6 + 4 + 3 reserved leaves no room for more.
    const third = await admit(0, () => true);
    expect(third?.grantWorkers?.(6)).toBe(1);
    expect(third?.grantWorkers?.(1)).toBe(1);
  });

  it("keeps every shard on one worker unless a worker budget is configured", async () => {
    const admit = createVitestMemoryAdmission({ shardBytes: GIB, freeMemoryBytes: () => 64 * GIB });
    expect((await admit(0, () => true))?.grantWorkers?.(8)).toBe(1);
    expect(resolveVitestWorkerMemoryBytes({})).toBeUndefined();
    expect(resolveVitestWorkerMemoryBytes({ OPENCLAW_TEST_WORKER_MEMORY_MB: "1200" })).toBe(
      1200 * 1024 ** 2,
    );
    expect(() => resolveVitestWorkerMemoryBytes({ OPENCLAW_TEST_WORKER_MEMORY_MB: "0" })).toThrow();
    expect(resolveVitestShardMaxWorkers({})).toBe(4);
    expect(resolveVitestShardMaxWorkers({ OPENCLAW_TEST_SHARD_MAX_WORKERS: "6" })).toBe(6);
    expect(resolveVitestShardWantedWorkers(["a"])).toBe(1);
    expect(resolveVitestShardWantedWorkers(Array.from({ length: 41 }))).toBe(3);
    expect(resolveVitestShardWantedWorkers(undefined)).toBe(Number.MAX_SAFE_INTEGER);
    // A whole-config shard carries no targets at all.
    expect(resolveVitestShardWantedWorkers(null)).toBe(Number.MAX_SAFE_INTEGER);
  });

  it("passes the admission to the plan it started", async () => {
    const seen: number[] = [];
    const admit = createVitestMemoryAdmission({
      shardBytes: GIB,
      workerBytes: GIB,
      freeMemoryBytes: () => 16 * GIB,
    });
    await runVitestPlans([0, 1], {
      concurrency: 1,
      shouldStop: () => false,
      admit,
      run: async (_plan, _index, _lane, admission) => {
        seen.push(admission?.grantWorkers?.(3) ?? 0);
      },
    });
    expect(seen).toEqual([3, 3]);
  });

  it("stops waiting once no work is pending", async () => {
    const clock = createClock();
    let pending = true;
    const admit = createVitestMemoryAdmission({
      shardBytes: 3 * GIB,
      pollMs: 1_000,
      freeMemoryBytes: () => 0,
      now: clock.now,
      wait: clock.wait,
    });
    const waiting = admit(1, () => pending);
    pending = false;
    await clock.advance(1_000);
    await expect(waiting).resolves.toBeUndefined();
  });

  it("runs every plan exactly once and releases every admission", async () => {
    const released: number[] = [];
    let granted = 0;
    let free = 9 * GIB;
    const admit = createVitestMemoryAdmission({
      shardBytes: 3 * GIB,
      rampMs: 0,
      pollMs: 1,
      freeMemoryBytes: () => free,
    });
    const seen: number[] = [];
    let running = 0;
    let peak = 0;
    await runVitestPlans([0, 1, 2, 3, 4, 5], {
      concurrency: 4,
      shouldStop: () => false,
      admit: async (lane, pending) => {
        const release = await admit(lane, pending);
        if (release) {
          granted += 1;
        }
        return release
          ? () => {
              released.push(lane);
              release();
            }
          : undefined;
      },
      run: async (plan) => {
        running += 1;
        free -= 3 * GIB;
        peak = Math.max(peak, running);
        seen.push(plan);
        await nextTurn();
        free += 3 * GIB;
        running -= 1;
      },
    });
    expect([...seen].sort()).toEqual([0, 1, 2, 3, 4, 5]);
    // A lane admitted after the last plan was taken releases without running.
    expect(granted).toBeGreaterThanOrEqual(6);
    expect(released).toHaveLength(granted);
    expect(peak).toBeLessThanOrEqual(4);
  });

  it("keeps fixed parallelism unless a shard budget is configured", () => {
    expect(resolveVitestShardMemoryBytes({})).toBeUndefined();
    expect(resolveVitestShardMemoryBytes({ OPENCLAW_TEST_SHARD_MEMORY_MB: "3000" })).toBe(
      3000 * 1024 * 1024,
    );
    expect(() => resolveVitestShardMemoryBytes({ OPENCLAW_TEST_SHARD_MEMORY_MB: "0" })).toThrow(
      "positive integer",
    );
  });

  it("gates lanes through runVitestPlans without starving lane zero", async () => {
    const gate = createDeferred();
    const seen: Array<[number, number]> = [];
    const done = runVitestPlans([0, 1], {
      concurrency: 2,
      shouldStop: () => false,
      admit: async (lane, pending) => {
        if (lane === 1) {
          await gate.promise;
        }
        return pending() ? () => {} : undefined;
      },
      run: async (plan, _index, lane) => {
        seen.push([plan, lane]);
      },
    });
    await nextTurn();
    await nextTurn();
    expect(seen).toEqual([
      [0, 0],
      [1, 0],
    ]);
    gate.resolve();
    await done;
  });
});
