import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  WORKER_RECYCLE_MB_ENV,
  resolveWorkerRecycleBytes,
  withWorkerRecycling,
} from "./vitest/vitest.recycling-pool.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const poolModule = path.join(repoRoot, "test/vitest/vitest.recycling-pool.ts");

// Two workers, four files, isolation off: later files reuse the two workers' threads unless the pool
// declines reuse. One worker would not show it, because Vitest then sends a non-isolated project's
// files as a single task. Returns the thread each file ran in.
function threadsPerFile(pool: string): string[] {
  // openclaw-temp-dir: the nested run owns this directory and it is removed below.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-recycling-pool-"));
  try {
    const out = path.join(dir, "threads.txt");
    for (const name of ["a", "b", "c", "d"]) {
      fs.writeFileSync(
        path.join(dir, `${name}.test.ts`),
        `import { threadId } from "node:worker_threads";
import { appendFileSync } from "node:fs";
test("${name}", () => { appendFileSync(${JSON.stringify(out)}, "${name} " + process.pid + ":" + threadId + "\\n"); });\n`,
      );
    }
    fs.writeFileSync(
      path.join(dir, "vitest.config.ts"),
      `import { recyclingPool } from ${JSON.stringify(poolModule)};
export default { test: { globals: true, isolate: false, maxWorkers: 2,
  sequence: { shuffle: false }, include: ["*.test.ts"], pool: ${pool} } };\n`,
    );
    const run = spawnSync(
      process.execPath,
      [
        path.join(repoRoot, "node_modules/vitest/vitest.mjs"),
        "run",
        "--config",
        "vitest.config.ts",
      ],
      { cwd: dir, encoding: "utf8", timeout: 90_000, env: { ...process.env, CI: "1" } },
    );
    expect(run.status, run.stdout + run.stderr).toBe(0);
    return fs
      .readFileSync(out, "utf8")
      .trim()
      .split("\n")
      .toSorted()
      .map((line) => line.split(" ")[1]!);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe("worker recycling", () => {
  it("reads the bound in whole megabytes and refuses anything else", () => {
    expect(resolveWorkerRecycleBytes({})).toBeNull();
    expect(resolveWorkerRecycleBytes({ [WORKER_RECYCLE_MB_ENV]: " 1536 " })).toBe(
      1536 * 1024 * 1024,
    );
    for (const raw of ["0", "-5", "1.5", "lots"]) {
      expect(() => resolveWorkerRecycleBytes({ [WORKER_RECYCLE_MB_ENV]: raw })).toThrow(
        WORKER_RECYCLE_MB_ENV,
      );
    }
  });

  it("leaves a pool unchanged without the bound, for isolated configs, and for custom pools", () => {
    const env = { [WORKER_RECYCLE_MB_ENV]: "1024" };
    const custom = { name: "custom", createPoolWorker: () => undefined };
    expect(withWorkerRecycling("threads", false, {})).toBe("threads");
    expect(withWorkerRecycling("forks", true, env)).toBe("forks");
    expect(withWorkerRecycling(custom, false, env)).toBe(custom);
    expect(withWorkerRecycling("threads", false, env)).toMatchObject({
      name: "openclaw-threads-recycling",
    });
  });

  it(
    "starts a fresh worker for the next file once the heap passes the bound",
    { timeout: 200_000 },
    () => {
      expect(new Set(threadsPerFile(JSON.stringify("threads"))).size).toBeLessThanOrEqual(2);
      expect(new Set(threadsPerFile('recyclingPool("threads", 1)')).size).toBe(4);
    },
  );
});
