import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { acquireFileLock } from "openclaw/plugin-sdk/file-lock";
import type { ClaudeAccessCredential, ClaudeKeeperAdapter } from "./subscription-keeper.js";

export const CLAUDE_KEEPER_ARGS = [
  "-p",
  "Reply with the single word ok.",
  "--model",
  "claude-haiku-4-5",
  "--max-turns",
  "1",
  "--no-session-persistence",
  "--tools",
  "",
  "--setting-sources",
  "",
  "--settings",
  '{"apiKeyHelper":""}',
  "--strict-mcp-config",
  "--mcp-config",
  '{"mcpServers":{}}',
];

/** An allowlist, not an incomplete list of known paid-key overrides. */
export function claudeKeeperEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const safe: NodeJS.ProcessEnv = { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" };
  for (const key of ["HOME", "PATH", "TMPDIR", "LANG", "LC_ALL", "SSL_CERT_FILE", "SSL_CERT_DIR"]) {
    if (env[key] !== undefined) {
      safe[key] = env[key];
    }
  }
  return safe;
}

export async function runClaudeKeeperCli(signal: AbortSignal): Promise<string> {
  signal.throwIfAborted();
  return await new Promise<string>((resolve) => {
    const child = spawn("claude", CLAUDE_KEEPER_ARGS, {
      cwd: tmpdir(),
      env: claudeKeeperEnvironment(process.env),
      stdio: ["ignore", "pipe", "pipe"],
      signal,
      killSignal: "SIGKILL",
      timeout: 120_000,
    });
    let output = "";
    const collect = (chunk: Buffer) => {
      if (output.length < 16_384) {
        output += chunk.toString().slice(0, 16_384 - output.length);
      }
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    // Wait for close, including on abort: service stop must not leave a refresh child running.
    child.on("error", () => {});
    child.on("close", () => resolve(output));
  });
}

export function classifyClaudeKeeperRefusal(output: string): "quota" | "auth" | "unknown" {
  if (/usage limit|quota|weekly limit|rate.?limit|hit your limit/i.test(output)) {
    return "quota";
  }
  if (/authentication|unauthorized|invalid.*token|login|log in|sign in/i.test(output)) {
    return "auth";
  }
  return "unknown";
}

type Payload = { claudeAiOauth: Record<string, unknown>; [key: string]: unknown };
export function createLinuxClaudeKeeperAdapter(options?: {
  homeDir?: string;
  runCli?: (signal: AbortSignal) => Promise<string>;
  now?: () => number;
}): ClaudeKeeperAdapter {
  const file = path.join(options?.homeDir ?? homedir(), ".claude", ".credentials.json");
  const readPayload = async (): Promise<Payload> => {
    const handle = await fs.open(file, "r");
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > 1024 * 1024) {
        throw new Error("Invalid Claude credential file");
      }
      const value: unknown = JSON.parse(await handle.readFile("utf8"));
      if (
        !value ||
        typeof value !== "object" ||
        !("claudeAiOauth" in value) ||
        !value.claudeAiOauth ||
        typeof value.claudeAiOauth !== "object" ||
        Array.isArray(value.claudeAiOauth)
      ) {
        throw new Error("Missing Claude subscription login");
      }
      return value as Payload;
    } finally {
      await handle.close();
    }
  };
  const access = (payload: Payload): ClaudeAccessCredential => {
    const { accessToken, expiresAt } = payload.claudeAiOauth;
    if (
      typeof accessToken !== "string" ||
      !accessToken ||
      typeof expiresAt !== "number" ||
      !Number.isFinite(expiresAt) ||
      expiresAt <= 0
    ) {
      throw new Error("Invalid Claude subscription credential");
    }
    return { token: accessToken, expires: expiresAt };
  };
  return {
    async withLock(run) {
      // Shared across Gateway processes on this home. Never steal a possibly live owner.
      const lock = await acquireFileLock(file + ".nucleo-keeper", {
        retries: { retries: 0, factor: 1, minTimeout: 0, maxTimeout: 0 },
        stale: 180_000,
        staleRecovery: "remove-if-definitely-stale",
      });
      try {
        return await run();
      } finally {
        await lock.release();
      }
    },
    async read() {
      return access(await readPayload());
    },
    async refresh(before, signal) {
      signal.throwIfAborted();
      const payload = await readPayload();
      const current = access(payload);
      if (current.token !== before.token || current.expires !== before.expires) {
        return "unknown";
      }
      // Native CLI owns expiry decisions and every credential-file write.
      // Never nudge expiry: a private keeper lock cannot serialize native CLI writers.
      signal.throwIfAborted();
      return classifyClaudeKeeperRefusal(await (options?.runCli ?? runClaudeKeeperCli)(signal));
    },
  };
}
