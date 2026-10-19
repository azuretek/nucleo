// Covers the startup update check reading a distribution's own GitHub releases instead of npm.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readConfigMachineState } from "../state/config-machine-state.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import type { UpdateCheckResult } from "./update-check.js";

const {
  checkTelemetryUpdateMock,
  getRuntimeConfigMock,
  refreshRemoteModelCatalogMock,
  versionMock,
} = vi.hoisted(() => ({
  checkTelemetryUpdateMock: vi.fn<typeof import("./telemetry.js").checkTelemetryUpdate>(),
  getRuntimeConfigMock: vi.fn(() => ({})),
  refreshRemoteModelCatalogMock: vi.fn(async () => ({
    status: "unchanged" as const,
    providers: 1,
    models: 1,
    generatedAt: 1_753_500_000_000,
  })),
  versionMock: { value: "0.0.1-dev.103" },
}));

vi.mock("../config/config.js", () => ({ getRuntimeConfig: getRuntimeConfigMock }));
vi.mock("./telemetry.js", () => ({ checkTelemetryUpdate: checkTelemetryUpdateMock }));
vi.mock("../model-catalog/remote-refresh.js", async () => ({
  ...(await vi.importActual<typeof import("../model-catalog/remote-refresh.js")>(
    "../model-catalog/remote-refresh.js",
  )),
  refreshRemoteModelCatalog: refreshRemoteModelCatalogMock,
}));
vi.mock("./openclaw-root.js", async () => ({
  ...(await vi.importActual<typeof import("./openclaw-root.js")>("./openclaw-root.js")),
  resolveOpenClawPackageRoot: vi.fn(async () => "/opt/openclaw"),
}));
vi.mock("./update-check.js", async () => ({
  ...(await vi.importActual<typeof import("./update-check.js")>("./update-check.js")),
  checkUpdateStatus: vi.fn(async (): Promise<UpdateCheckResult> => ({
    root: "/opt/openclaw",
    installKind: "package",
    packageManager: "npm",
  })),
  resolveNpmChannelTag: vi.fn(async () => ({ tag: "latest", version: "2026.10.4" })),
}));
vi.mock("../version.js", () => ({
  get VERSION() {
    return versionMock.value;
  },
}));

const RELEASES = [
  {
    tag_name: "v0.0.1-dev.104.cccccccccc",
    html_url: "https://github.com/azuretek/nucleo/releases/tag/v0.0.1-dev.104.cccccccccc",
    draft: false,
    prerelease: true,
  },
  {
    tag_name: "v0.0.1-dev.103.2b17edcb88",
    html_url: "https://github.com/azuretek/nucleo/releases/tag/v0.0.1-dev.103.2b17edcb88",
    draft: false,
    prerelease: true,
  },
];

describe("update-startup with GitHub releases as the update source", () => {
  let testState: OpenClawTestState;
  let scheduler: ReturnType<typeof createTestGatewayScheduler>;
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(RELEASES), { status: 200 }));

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-18T10:00:00Z"));
    scheduler = createTestGatewayScheduler("fake-timers");
    testState = await createOpenClawTestState({
      layout: "state-only",
      prefix: "openclaw-update-github-releases-",
      env: {
        OPENCLAW_UPDATE_GITHUB_REPO: "azuretek/nucleo",
        OPENCLAW_NO_AUTO_UPDATE: undefined,
        OPENCLAW_SUPERVISOR_MODE: undefined,
        NODE_ENV: "test",
        VITEST: undefined,
      },
    });
    checkTelemetryUpdateMock.mockReset().mockResolvedValue({ version: "2026.10.4" });
    fetchMock.mockClear();
    vi.stubGlobal("fetch", fetchMock);
    const { resetUpdateAvailableStateForTest } = await import("./update-startup.js");
    resetUpdateAvailableStateForTest(scheduler);
  });

  afterEach(async () => {
    const { resetUpdateAvailableStateForTest } = await import("./update-startup.js");
    resetUpdateAvailableStateForTest(scheduler);
    await scheduler.stop();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    closeOpenClawStateDatabaseForTest();
    await testState.cleanup();
  });

  async function runCheck(cfg: Record<string, unknown>) {
    const { runGatewayUpdateCheck } = await import("./update-startup.js");
    const { resolveNpmChannelTag } = await import("./update-check.js");
    const log = { info: vi.fn() };
    const runAutoUpdate = vi.fn();
    await runGatewayUpdateCheck({
      getConfig: () => cfg,
      log,
      isNixMode: false,
      allowInTests: true,
      runAutoUpdate,
    });
    return { log, runAutoUpdate, resolveNpmChannelTag: vi.mocked(resolveNpmChannelTag) };
  }

  it("names the newer release, never the upstream npm version", async () => {
    const { log, resolveNpmChannelTag } = await runCheck({ update: { channel: "stable" } });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.github.com/repos/azuretek/nucleo/releases?per_page=30",
      expect.anything(),
    );
    expect(log.info).toHaveBeenCalledWith(
      "update available (dev): v0.0.1-dev.104 (current v0.0.1-dev.103). Release: https://github.com/azuretek/nucleo/releases/tag/v0.0.1-dev.104.cccccccccc",
    );
    const notices = log.info.mock.calls.map((call) => String(call[0]));
    expect(notices.some((line) => line.includes("2026.10.4"))).toBe(false);
    expect(resolveNpmChannelTag).not.toHaveBeenCalled();
    expect(
      readConfigMachineState<{ lastAvailableVersion?: string }>("update.checkState")
        ?.lastAvailableVersion,
    ).toBe("0.0.1-dev.104");
  });

  it("stays quiet when the running build is the newest release", async () => {
    versionMock.value = "0.0.1-dev.104";
    try {
      const { log } = await runCheck({ update: { channel: "stable" } });
      const notices = log.info.mock.calls.map((call) => String(call[0]));
      expect(notices.some((line) => line.startsWith("update available"))).toBe(false);
    } finally {
      versionMock.value = "0.0.1-dev.103";
    }
  });

  it("never hands a release to the package auto-updater", async () => {
    const { log, runAutoUpdate } = await runCheck({
      update: { channel: "stable", auto: { enabled: true } },
    });
    await vi.advanceTimersByTimeAsync(60_000);

    expect(runAutoUpdate).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith(
      "auto-update skipped: updates are releases of azuretek/nucleo",
      { version: "0.0.1-dev.104", tag: "dev" },
    );
  });
});
