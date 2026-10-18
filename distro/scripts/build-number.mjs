// The dev build number, and the one rule it follows: it only ever goes up.
//
// It used to be the count of commits from the pin, but the distro branch is rebuilt from the pin on
// every assembly, so the count stays the same however many builds there are: on 2026-10-18 two
// different commits both came out as dev.102, and the second image replaced the first under one tag.
// So the number is one more than the highest dev number already tagged for this version. A commit that
// already carries a dev tag keeps its number, so rerunning a build of the same commit never takes a
// new one. With no dev tag at all for the version, the caller's fallback starts the count.

/** Picks the dev build number for a commit from the repository's existing tag names. */
export function nextDevBuildNumber({ tags, version, sha, fallback }) {
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp("^v" + escaped + "-dev\\.(\\d+)\\.([0-9a-f]+)$");
  let highest = 0;
  for (const tag of tags) {
    const m = pattern.exec(tag);
    if (!m) continue;
    const n = Number(m[1]);
    if (sha && (sha.startsWith(m[2]) || m[2].startsWith(sha))) return n;
    if (n > highest) highest = n;
  }
  return highest > 0 ? highest + 1 : fallback;
}

/** Reads tag names from `git ls-remote --tags` output, dropping peeled `^{}` entries. */
export function tagNamesFromLsRemote(stdout) {
  return [
    ...new Set(
      String(stdout || "")
        .split("\n")
        .map((l) => (l.split("refs/tags/")[1] || "").trim())
        .filter((t) => t && !t.endsWith("^{}")),
    ),
  ];
}
