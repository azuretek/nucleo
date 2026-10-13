// One read-only location request, shared by the snapshot child and the in-process test fixture.
import path from "node:path";
import {
  formatSqliteReadOnlyInspectionFailure,
  isSqliteLockError,
} from "./sqlite-error-diagnostics.js";
import { releaseSnapshotTempDirectory } from "./sqlite-readonly-location-cleanup.js";
import {
  prepareSqliteReadOnlyLocationInProcess,
  prepareSqliteReadOnlyLocationSyncInProcess,
  SqliteSourceChangedError,
} from "./sqlite-readonly-location.js";
import type { PreparedSqliteReadOnlyLocation } from "./sqlite-readonly-location.types.js";
import {
  SQLITE_INSPECTION_CONTENTION_PREFIX,
  type SqliteReadOnlyWorkerResult,
} from "./sqlite-readonly-worker-protocol.js";

export function sqliteReadOnlyRequestFailure(error: unknown): SqliteReadOnlyWorkerResult {
  const contention = error instanceof SqliteSourceChangedError || isSqliteLockError(error);
  return {
    ok: false,
    message: `${contention ? SQLITE_INSPECTION_CONTENTION_PREFIX : ""}${formatSqliteReadOnlyInspectionFailure(error)}`,
  };
}

/** Hand the private snapshot to the requester, which adopts its cleanup. */
export function handOffSqliteReadOnlyLocation(
  prepared: PreparedSqliteReadOnlyLocation,
): SqliteReadOnlyWorkerResult {
  releaseSnapshotTempDirectory(prepared.cleanupRoot ?? path.dirname(prepared.location));
  return { ok: true, location: prepared.location };
}

export function runSqliteReadOnlyLocationRequestSync(
  pathname: string,
  stagingRoot: string | undefined,
): SqliteReadOnlyWorkerResult {
  try {
    return handOffSqliteReadOnlyLocation(
      prepareSqliteReadOnlyLocationSyncInProcess(pathname, stagingRoot),
    );
  } catch (error) {
    return sqliteReadOnlyRequestFailure(error);
  }
}

export async function runSqliteReadOnlyLocationRequest(
  pathname: string,
  stagingRoot: string | undefined,
): Promise<SqliteReadOnlyWorkerResult> {
  try {
    return handOffSqliteReadOnlyLocation(
      await prepareSqliteReadOnlyLocationInProcess(pathname, stagingRoot),
    );
  } catch (error) {
    return sqliteReadOnlyRequestFailure(error);
  }
}
