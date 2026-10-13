import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { requireNodeSqlite } from "./node-sqlite.js";
import { isSqliteFamilyOpenInThisProcess } from "./sqlite-readonly-in-process.test-support.js";

// The guard reads /proc/self/fd, so elsewhere it always reports open and requests keep a child.
describe.skipIf(process.platform !== "linux")("isSqliteFamilyOpenInThisProcess", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
  const databasePath = () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "sqlite-in-process-"));
    roots.push(root);
    return path.join(root, "state.sqlite");
  };

  it("reports a database this process holds open, and not once it is closed", () => {
    const pathname = databasePath();
    const database = new (requireNodeSqlite().DatabaseSync)(pathname);
    database.exec("PRAGMA journal_mode = WAL; CREATE TABLE entries (value TEXT)");
    expect(isSqliteFamilyOpenInThisProcess(pathname)).toBe(true);
    database.close();
    expect(isSqliteFamilyOpenInThisProcess(pathname)).toBe(false);
  });

  it("reports a WAL sidecar held open on its own", () => {
    const pathname = databasePath();
    fs.writeFileSync(pathname, "");
    const descriptor = fs.openSync(`${pathname}-wal`, "w");
    try {
      expect(isSqliteFamilyOpenInThisProcess(pathname)).toBe(true);
    } finally {
      fs.closeSync(descriptor);
    }
  });

  it("treats a database that does not exist as not open", () => {
    expect(isSqliteFamilyOpenInThisProcess(databasePath())).toBe(false);
  });
});
