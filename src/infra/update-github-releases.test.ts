// Covers the GitHub releases update source a distribution opts into with OPENCLAW_UPDATE_GITHUB_REPO.
import { describe, expect, it, vi } from "vitest";
import {
  fetchGithubReleaseTarget,
  githubReleaseNoticeTag,
  releaseTagToVersion,
  resolveUpdateGithubRepo,
  selectGithubReleaseTarget,
} from "./update-github-releases.js";

const devRelease = (n: number, sha: string) => ({
  tag_name: `v0.0.1-dev.${n}.${sha}`,
  html_url: `https://github.com/azuretek/nucleo/releases/tag/v0.0.1-dev.${n}.${sha}`,
  draft: false,
  prerelease: true,
});

describe("update-github-releases", () => {
  it("is off unless a valid owner/repo is configured", () => {
    expect(resolveUpdateGithubRepo({})).toBeNull();
    expect(resolveUpdateGithubRepo({ OPENCLAW_UPDATE_GITHUB_REPO: "  " })).toBeNull();
    expect(resolveUpdateGithubRepo({ OPENCLAW_UPDATE_GITHUB_REPO: "not a repo" })).toBeNull();
    expect(resolveUpdateGithubRepo({ OPENCLAW_UPDATE_GITHUB_REPO: "azuretek/nucleo" })).toBe(
      "azuretek/nucleo",
    );
  });

  it("reads the version from a tag, dropping the commit after a build number", () => {
    expect(releaseTagToVersion("v0.0.1-dev.103.2b17edcb88")).toBe("0.0.1-dev.103");
    expect(releaseTagToVersion("v0.0.1")).toBe("0.0.1");
    expect(releaseTagToVersion("v2026.9.8")).toBe("2026.9.8");
    expect(releaseTagToVersion("nightly")).toBeNull();
  });

  it("offers the newest dev build to a dev build on the stable channel", () => {
    const target = selectGithubReleaseTarget(
      [devRelease(102, "d7a3d68f43"), devRelease(110, "aaaaaaaaaa"), devRelease(103, "2b17edcb88")],
      { channel: "stable", currentVersion: "0.0.1-dev.103" },
    );
    expect(target?.version).toBe("0.0.1-dev.110");
    expect(target?.url).toContain("/releases/tag/v0.0.1-dev.110.aaaaaaaaaa");
  });

  it("orders dev build numbers numerically, not as text", () => {
    const target = selectGithubReleaseTarget(
      [devRelease(99, "aaaaaaaaaa"), devRelease(100, "bbbbbbbbbb")],
      {
        channel: "dev",
      },
    );
    expect(target?.version).toBe("0.0.1-dev.100");
  });

  it("offers only final releases to a final release on the stable channel, and never drafts", () => {
    const releases = [
      devRelease(120, "aaaaaaaaaa"),
      { tag_name: "v0.0.2", html_url: "u2", draft: true, prerelease: false },
      { tag_name: "v0.0.1", html_url: "u1", draft: false, prerelease: false },
    ];
    expect(
      selectGithubReleaseTarget(releases, { channel: "stable", currentVersion: "0.0.1" }),
    ).toEqual({
      tag: "v0.0.1",
      version: "0.0.1",
      url: "u1",
      prerelease: false,
    });
    expect(
      selectGithubReleaseTarget([devRelease(120, "aaaaaaaaaa")], {
        channel: "stable",
        currentVersion: "0.0.1",
      }),
    ).toBeNull();
  });

  it("fetches the repository's releases from GitHub", async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify([devRelease(104, "cccccccccc")]), { status: 200 }),
    ) as unknown as typeof fetch;
    const result = await fetchGithubReleaseTarget({
      repo: "azuretek/nucleo",
      channel: "stable",
      currentVersion: "0.0.1-dev.103",
      fetchImpl,
    });
    expect(result.target?.version).toBe("0.0.1-dev.104");
    expect(vi.mocked(fetchImpl).mock.calls[0]?.[0]).toBe(
      "https://api.github.com/repos/azuretek/nucleo/releases?per_page=30",
    );
  });

  it("reports an HTTP failure instead of a version", async () => {
    const fetchImpl = vi.fn(
      async () => new Response("nope", { status: 403 }),
    ) as unknown as typeof fetch;
    const result = await fetchGithubReleaseTarget({
      repo: "azuretek/nucleo",
      channel: "dev",
      fetchImpl,
    });
    expect(result).toEqual({ target: null, error: "HTTP 403" });
  });

  it("labels notices with the npm source's tag names", () => {
    expect(githubReleaseNoticeTag("stable")).toBe("latest");
    expect(githubReleaseNoticeTag("dev")).toBe("dev");
  });
});
