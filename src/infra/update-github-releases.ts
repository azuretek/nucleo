// Reads update availability from a repository's GitHub releases instead of the npm registry.
// A distribution that ships as an image, not as the npm package, sets OPENCLAW_UPDATE_GITHUB_REPO to
// its owner/repo, so its update notices name its own releases rather than the upstream package.
// Unset, nothing here runs and the npm registry stays the source.
import { readProviderJsonResponse } from "../agents/provider-http-errors.js";
import { buildTimeoutAbortSignal } from "../utils/fetch-timeout.js";
import { cancelUnreadResponseBody } from "./http-body.js";
import { compareOpenClawReleaseVersions } from "./npm-registry-spec.js";
import { compareValidSemver, normalizeLegacyDotBetaVersion } from "./semver.js";
import type { UpdateChannel } from "./update-channels.js";
import { UPDATE_NETWORK_TIMEOUT_MS } from "./update-network-budget.js";

export type GithubReleaseTarget = {
  tag: string;
  version: string;
  url: string;
  prerelease: boolean;
};

type GithubReleaseRecord = {
  tag_name?: unknown;
  html_url?: unknown;
  draft?: unknown;
  prerelease?: unknown;
};

const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/** Returns the configured owner/repo, or null when releases are not the update source. */
export function resolveUpdateGithubRepo(env: NodeJS.ProcessEnv = process.env): string | null {
  const repo = env.OPENCLAW_UPDATE_GITHUB_REPO?.trim();
  return repo && REPO_PATTERN.test(repo) ? repo : null;
}

/**
 * Reads the version a release tag names. A trailing commit after the build number names which
 * commit was built, not the order, so "v0.0.1-dev.103.2b17edcb88" is version "0.0.1-dev.103".
 */
export function releaseTagToVersion(tag: string): string | null {
  const bare = tag.trim().replace(/^v/, "");
  const withCommit = /^(\d+\.\d+\.\d+-[0-9A-Za-z-]+\.\d+)\.[0-9a-f]{7,40}$/.exec(bare);
  if (withCommit) {
    return withCommit[1] ?? null;
  }
  return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(bare) ? bare : null;
}

function compareVersions(a: string, b: string): number {
  const release = compareOpenClawReleaseVersions(a, b);
  if (release != null) {
    return release;
  }
  return (
    compareValidSemver(normalizeLegacyDotBetaVersion(a), normalizeLegacyDotBetaVersion(b)) ?? 0
  );
}

/** A build carrying a prerelease number (0.0.1-dev.103) tracks the dev line; a final build the stable line. */
export function isDevBuild(currentVersion?: string): boolean {
  return Boolean(currentVersion?.includes("-"));
}

/**
 * Whether a release belongs to the line this install follows. A dev build is offered only dev
 * releases and a stable build only final ones, so a channel never silently becomes the other.
 */
export function releaseMatchesChannel(
  release: { prerelease: boolean; version: string },
  params: { channel: UpdateChannel; currentVersion?: string },
): boolean {
  if (isDevBuild(params.currentVersion)) {
    return release.prerelease && release.version.includes("-dev.");
  }
  if (params.channel === "beta" || params.channel === "dev") {
    return release.prerelease;
  }
  return !release.prerelease;
}

/** Picks the newest release the channel may offer, skipping drafts and unreadable tags. */
export function selectGithubReleaseTarget(
  releases: readonly GithubReleaseRecord[],
  params: { channel: UpdateChannel; currentVersion?: string },
): GithubReleaseTarget | null {
  let best: GithubReleaseTarget | null = null;
  for (const release of releases) {
    if (release.draft === true || typeof release.tag_name !== "string") {
      continue;
    }
    const version = releaseTagToVersion(release.tag_name);
    if (!version) {
      continue;
    }
    const prerelease = release.prerelease === true;
    if (!releaseMatchesChannel({ prerelease, version }, params)) {
      continue;
    }
    if (best && compareVersions(version, best.version) <= 0) {
      continue;
    }
    best = {
      tag: release.tag_name,
      version,
      url: typeof release.html_url === "string" ? release.html_url : "",
      prerelease,
    };
  }
  return best;
}

/** Fetches the repository's releases and returns the newest one the channel may offer. */
export async function fetchGithubReleaseTarget(params: {
  repo: string;
  channel: UpdateChannel;
  currentVersion?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}): Promise<{ target: GithubReleaseTarget | null; error?: string }> {
  const url = `https://api.github.com/repos/${params.repo}/releases?per_page=30`;
  const { signal, cleanup } = buildTimeoutAbortSignal({
    timeoutMs: Math.max(1, params.timeoutMs ?? UPDATE_NETWORK_TIMEOUT_MS),
    signal: params.signal,
    operation: "github-releases-update-check",
    url,
  });
  let res: Response | undefined;
  try {
    res = await (params.fetchImpl ?? fetch)(url, {
      signal,
      headers: { accept: "application/vnd.github+json" },
    });
    if (!res.ok) {
      return { target: null, error: `HTTP ${res.status}` };
    }
    const body = await readProviderJsonResponse<unknown>(res, "github releases");
    if (!Array.isArray(body)) {
      return { target: null, error: "unexpected releases response" };
    }
    return {
      target: selectGithubReleaseTarget(body as GithubReleaseRecord[], {
        channel: params.channel,
        currentVersion: params.currentVersion,
      }),
    };
  } catch (err) {
    params.signal?.throwIfAborted();
    return { target: null, error: err instanceof Error ? err.message : String(err) };
  } finally {
    await cancelUnreadResponseBody(res);
    cleanup();
  }
}

/** The label an update notice shows for the channel: dev builds read "dev", final builds "latest". */
export function githubReleaseNoticeTag(channel: UpdateChannel, currentVersion?: string): string {
  if (isDevBuild(currentVersion)) {
    return "dev";
  }
  return channel === "stable" || channel === "extended-stable" ? "latest" : channel;
}
