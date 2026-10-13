// Serves read-only snapshot requests in the test process instead of starting a child per request.
// A raw read of the source would drop every POSIX lock this process holds on that file when its
// descriptor closes, so a request runs here only while no descriptor in this process, from any
// thread, points at the database family. Otherwise the real child serves it, as in production.
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll } from "vitest";
import {
  sqliteReadOnlyInProcessFixture,
  type SqliteReadOnlyInProcessRequests,
} from "./sqlite-readonly-in-process.js";

const DESCRIPTOR_DIRECTORY = "/proc/self/fd";

function resolveFamilyBase(pathname: string): string {
  const resolved = path.resolve(pathname);
  try {
    return path.join(fs.realpathSync.native(path.dirname(resolved)), path.basename(resolved));
  } catch {
    return resolved;
  }
}

/** True when this process may hold a lock on the database, or when that cannot be ruled out. */
export function isSqliteFamilyOpenInThisProcess(pathname: string): boolean {
  let descriptors: string[];
  try {
    descriptors = fs.readdirSync(DESCRIPTOR_DIRECTORY);
  } catch {
    return true;
  }
  const base = resolveFamilyBase(pathname);
  const family = new Set([base, `${base}-wal`, `${base}-shm`, `${base}-journal`]);
  for (const descriptor of descriptors) {
    let target: string;
    try {
      target = fs.readlinkSync(path.join(DESCRIPTOR_DIRECTORY, descriptor));
    } catch {
      continue;
    }
    if (family.has(target)) {
      return true;
    }
  }
  return false;
}

/** Install a fixture for this test file and return the restore for the previous one. */
export function installSqliteReadOnlyInProcessFixture(): () => void {
  const previous = sqliteReadOnlyInProcessFixture.current;
  let requests: SqliteReadOnlyInProcessRequests | undefined;
  let loading: Promise<SqliteReadOnlyInProcessRequests> | undefined;
  sqliteReadOnlyInProcessFixture.current = {
    get requests() {
      return requests;
    },
    load: () =>
      (loading ??= (async () => {
        const [location, revision] = await Promise.all([
          import("./sqlite-readonly-location-request.js"),
          import("./sqlite-source-revision.js"),
        ]);
        requests = {
          location: (pathname, stagingRoot) =>
            isSqliteFamilyOpenInThisProcess(pathname)
              ? undefined
              : location.runSqliteReadOnlyLocationRequestSync(pathname, stagingRoot),
          locationAsync: async (pathname, stagingRoot) =>
            isSqliteFamilyOpenInThisProcess(pathname)
              ? undefined
              : await location.runSqliteReadOnlyLocationRequest(pathname, stagingRoot),
          contentVersion: (pathname) =>
            isSqliteFamilyOpenInThisProcess(pathname)
              ? undefined
              : revision.readSqliteSourceContentVersionResult(pathname),
        };
        return requests;
      })()),
  };
  return () => {
    sqliteReadOnlyInProcessFixture.current = previous;
  };
}

/** Keep this file on real snapshot children, for tests that cover the worker processes themselves. */
export function useSqliteReadOnlyWorkerProcesses(): void {
  let previous: typeof sqliteReadOnlyInProcessFixture.current;
  beforeAll(() => {
    previous = sqliteReadOnlyInProcessFixture.current;
    sqliteReadOnlyInProcessFixture.current = undefined;
  });
  afterAll(() => {
    sqliteReadOnlyInProcessFixture.current = previous;
  });
}
