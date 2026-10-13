// Keep this child independent of SQLite and the shared runtime import graph.
import { SQLITE_READONLY_CHILD_ARG } from "./runtime-process-entrypoints.js";
import type { SqliteReadOnlyWorkerResult } from "./sqlite-readonly-worker-protocol.js";
import { readSqliteSourceContentVersionResult } from "./sqlite-source-revision.js";

if (process.argv[2] === SQLITE_READONLY_CHILD_ARG) {
  const pathname = process.argv[4];
  const result: SqliteReadOnlyWorkerResult =
    process.argv[3] !== "content-version" || !pathname
      ? { ok: false, message: "SQLite content observation requires its mode and source path" }
      : readSqliteSourceContentVersionResult(pathname);
  if (!result.ok) {
    process.exitCode = 1;
  }
  process.stdout.write(JSON.stringify(result));
}
