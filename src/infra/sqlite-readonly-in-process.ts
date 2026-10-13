// Test setup may serve read-only snapshot requests in this process instead of a child per request.
// Production never installs a fixture, so every request there still runs in its own process.
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import type { SqliteReadOnlyWorkerResult } from "./sqlite-readonly-worker-protocol.js";

/** Each handler returns undefined to decline, and the request then runs in a real child. */
export type SqliteReadOnlyInProcessRequests = {
  location: (
    pathname: string,
    stagingRoot: string | undefined,
  ) => SqliteReadOnlyWorkerResult | undefined;
  locationAsync: (
    pathname: string,
    stagingRoot: string | undefined,
  ) => Promise<SqliteReadOnlyWorkerResult | undefined>;
  contentVersion: (pathname: string) => SqliteReadOnlyWorkerResult | undefined;
};

export type SqliteReadOnlyInProcessFixture = {
  /** Undefined until load() settles; synchronous requests use a child until then. */
  readonly requests: SqliteReadOnlyInProcessRequests | undefined;
  load: () => Promise<SqliteReadOnlyInProcessRequests>;
};

export const sqliteReadOnlyInProcessFixture = resolveGlobalSingleton(
  Symbol.for("openclaw.sqliteReadOnlyInProcessFixture"),
  (): { current: SqliteReadOnlyInProcessFixture | undefined } => ({ current: undefined }),
);
