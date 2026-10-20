import fs from "node:fs/promises";
import path from "node:path";
import { withTempDir } from "openclaw/plugin-sdk/test-env";
import { expect, it, vi } from "vitest";
import {
  CLAUDE_KEEPER_ARGS,
  claudeKeeperEnvironment,
  classifyClaudeKeeperRefusal,
  createLinuxClaudeKeeperAdapter,
  runClaudeKeeperCli,
} from "./subscription-keeper-linux.js";

it("executes the CLI with isolated settings and no inherited paid credentials", async () => {
  await withTempDir("claude-keeper-child-", async (home) => {
    const executable = path.join(home, "claude");
    const receipt = path.join(home, "receipt.json");
    await fs.writeFile(
      executable,
      [
        "#!" + process.execPath,
        'const fs = require("node:fs");',
        'fs.writeFileSync(process.env.HOME + "/receipt.json", JSON.stringify({args: process.argv.slice(2), env: process.env, cwd: process.cwd()}));',
        'process.stdout.write("Weekly usage limit reached");',
      ].join("\n"),
      { mode: 0o700 },
    );
    vi.stubEnv("HOME", home);
    vi.stubEnv("PATH", home);
    vi.stubEnv("ANTHROPIC_API_KEY", "synthetic-paid-key");
    vi.stubEnv("ANTHROPIC_AUTH_TOKEN", "synthetic-paid-token");
    vi.stubEnv("CLAUDE_CONFIG_DIR", "/synthetic-untrusted-config");
    try {
      expect(await runClaudeKeeperCli(new AbortController().signal)).toBe(
        "Weekly usage limit reached",
      );
      const observed = JSON.parse(await fs.readFile(receipt, "utf8")) as {
        args: string[];
        env: Record<string, string>;
        cwd: string;
      };
      expect(observed.args).toEqual(CLAUDE_KEEPER_ARGS);
      expect(observed.env.ANTHROPIC_API_KEY).toBeUndefined();
      expect(observed.env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
      expect(observed.env.CLAUDE_CONFIG_DIR).toBeUndefined();
      expect(observed.env.HOME).toBe(home);
      expect(observed.cwd).not.toBe(process.cwd());
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

const now = 1_800_000_000_000;
async function fixture(home: string) {
  const file = path.join(home, ".claude", ".credentials.json");
  const payload = {
    otherSetting: "preserved",
    claudeAiOauth: {
      accessToken: "synthetic-old",
      refreshToken: "synthetic-refresh-cli-only",
      expiresAt: now + 100_000,
    },
  };
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(payload));
  return {
    file,
    payload,
    read: async () => JSON.parse(await fs.readFile(file, "utf8")) as typeof payload,
  };
}
it("leaves the grant and all token exchange to CLI and detects refresh despite quota refusal", async () => {
  await withTempDir("claude-keeper-", async (home) => {
    const f = await fixture(home);
    const adapter = createLinuxClaudeKeeperAdapter({
      homeDir: home,
      now: () => now,
      runCli: async () => {
        expect((await f.read()).claudeAiOauth.expiresAt).toBe(f.payload.claudeAiOauth.expiresAt);
        await fs.writeFile(
          f.file,
          JSON.stringify({
            ...f.payload,
            claudeAiOauth: {
              ...f.payload.claudeAiOauth,
              accessToken: "synthetic-rotated",
              refreshToken: "synthetic-rotated-refresh",
              expiresAt: now + 8 * 60 * 60_000,
            },
          }),
        );
        return "Weekly usage limit reached";
      },
    });
    await adapter.withLock(async () => {
      expect(await adapter.refresh(await adapter.read(), new AbortController().signal)).toBe(
        "quota",
      );
      expect(await adapter.read()).toEqual({
        token: "synthetic-rotated",
        expires: now + 8 * 60 * 60_000,
      });
    });
    expect((await f.read()).claudeAiOauth.refreshToken).toBe("synthetic-rotated-refresh");
    expect((await f.read()).otherSetting).toBe("preserved");
  });
});
it("never writes credentials on failure, preserving native CLI rotation", async () => {
  await withTempDir("claude-keeper-", async (home) => {
    const f = await fixture(home);
    const adapter = createLinuxClaudeKeeperAdapter({
      homeDir: home,
      now: () => now,
      runCli: async () => {
        const payload = await f.read();
        payload.claudeAiOauth.refreshToken = "synthetic-external-refresh";
        await fs.writeFile(f.file, JSON.stringify(payload));
        throw new Error("synthetic-cli-failure");
      },
    });
    await expect(
      adapter.refresh(await adapter.read(), new AbortController().signal),
    ).rejects.toThrow("synthetic-cli-failure");
    expect((await f.read()).claudeAiOauth).toEqual({
      ...f.payload.claudeAiOauth,
      refreshToken: "synthetic-external-refresh",
    });
  });
});
it("refuses concurrent keeper owners across adapter instances", async () => {
  await withTempDir("claude-keeper-", async (home) => {
    await fixture(home);
    const first = createLinuxClaudeKeeperAdapter({ homeDir: home });
    const second = createLinuxClaudeKeeperAdapter({ homeDir: home });
    await first.withLock(async () => {
      await expect(
        second.withLock(async () => {
          throw new Error("must not enter");
        }),
      ).rejects.not.toThrow("must not enter");
    });
    expect(await second.withLock(() => second.read())).toHaveProperty("token", "synthetic-old");
  });
});
it("does not overwrite credentials that drift before refresh admission", async () => {
  await withTempDir("claude-keeper-", async (home) => {
    const f = await fixture(home);
    let calls = 0;
    const adapter = createLinuxClaudeKeeperAdapter({
      homeDir: home,
      runCli: async () => {
        calls++;
        return "";
      },
    });
    const old = await adapter.read();
    await fs.writeFile(
      f.file,
      JSON.stringify({
        ...f.payload,
        claudeAiOauth: { ...f.payload.claudeAiOauth, accessToken: "synthetic-drift" },
      }),
    );
    await adapter.refresh(old, new AbortController().signal);
    expect(calls).toBe(0);
    expect((await adapter.read()).token).toBe("synthetic-drift");
  });
});
it("cancellation never changes expiry or starts a second CLI", async () => {
  await withTempDir("claude-keeper-", async (home) => {
    const f = await fixture(home);
    const abort = new AbortController();
    const adapter = createLinuxClaudeKeeperAdapter({
      homeDir: home,
      runCli: async () => {
        abort.abort();
        throw new Error("cancelled");
      },
      now: () => now,
    });
    await expect(adapter.refresh(await adapter.read(), abort.signal)).rejects.toThrow("cancelled");
    expect((await f.read()).claudeAiOauth.expiresAt).toBe(f.payload.claudeAiOauth.expiresAt);
  });
});
it("has no paid route, inherited auth override, settings helper, MCP or tools", () => {
  expect(
    claudeKeeperEnvironment({
      HOME: "/synthetic",
      PATH: "/bin",
      ANTHROPIC_API_KEY: "synthetic-paid",
      ANTHROPIC_AUTH_TOKEN: "synthetic-paid",
      CLAUDE_CODE_OAUTH_TOKEN: "synthetic-override",
      ANTHROPIC_BASE_URL: "https://example.invalid",
      CLAUDE_CONFIG_DIR: "/other-account",
      NEW_PAID_AUTH: "synthetic",
    }),
  ).toEqual({ HOME: "/synthetic", PATH: "/bin", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" });
  expect(CLAUDE_KEEPER_ARGS).toContain("--no-session-persistence");
  expect(CLAUDE_KEEPER_ARGS).toContain('{"apiKeyHelper":""}');
  expect(CLAUDE_KEEPER_ARGS).toContain("--strict-mcp-config");
});
it.each([
  ["Weekly quota exhausted", "quota"],
  ["Invalid authentication token", "auth"],
  ["network unavailable", "unknown"],
])("classifies %s separately", (output, expected) => {
  expect(classifyClaudeKeeperRefusal(output)).toBe(expected);
});

it("has no credential write even when native rotation lands during refresh", async () => {
  await withTempDir("claude-keeper-", async (home) => {
    const f = await fixture(home);
    const adapter = createLinuxClaudeKeeperAdapter({
      homeDir: home,
      runCli: async () => {
        const latest = {
          ...f.payload,
          claudeAiOauth: {
            ...f.payload.claudeAiOauth,
            refreshToken: "synthetic-native-writer",
            accessToken: "synthetic-native-access",
            expiresAt: now + 999999,
          },
        };
        await fs.writeFile(f.file, JSON.stringify(latest));
        return "";
      },
    });
    await adapter.refresh(await adapter.read(), new AbortController().signal);
    expect((await f.read()).claudeAiOauth.refreshToken).toBe("synthetic-native-writer");
    expect((await adapter.read()).token).toBe("synthetic-native-access");
  });
});
