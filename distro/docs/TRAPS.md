# Traps we paid for

Each of these cost real time once, and each now has something that holds it. They are environment traps rather than design rules, which is why they live here and not in DESIGN.md.

## Assembly

- **A stale copy of the tooling can rebuild the wrong branch.** A host's copy of this repository once still named an old distro branch, and `sync` announced it was about to reset that branch and replay our patches onto it. It was caught in its own first log line. Refresh the tooling copy before an assembly, and read the first line `sync` prints.
- **A broken script passed every text check.** A patch nested one function inside another and left `nucleo.mjs` a syntax error that the manifest validator and the publish scan both passed. `validate-manifest.mjs` now runs `node --check` over `scripts/*.mjs`.
- **Two long git operations in one worktree corrupt it.** A second run's reset races the first, and `git apply -3` can then report success while changing nothing. Never start a second run while one may still be alive, and recover a moved branch from the pushed ref.
- **A pin-owned baseline came back after a patch tightened it.** Baselines are taken from the pin after the replay, which restored an allowance a patch had removed, and the ratchet failed with `0 < 1`. `sync` now keeps the lines our patches delete from a pin-owned file.

## The gate

- **The ratchet guards measure against `origin/main`.** Their allowance is computed from the merge base of HEAD and that ref, so if it points anywhere but the release we build on, ten files read as expanding while the code is fine. Point `origin/main` at the pin on the build host before the gate, from `pinnedCommit` in the manifest, and the gate prints base and pin first so a mismatch shows in line one.
- **A shallow build tree needs the pin commit.** The comparison above needs it, though not the tag. Fetch the distro branch deep enough to include the pin and use its sha.
- **A lint runner edit turns off changed-file lint scoping.** Upstream reads any edit to a lint runner as a policy change and then enforces line caps on files we never touched. `lintScopeNeutralPaths` names the runner files our patches edit without changing a rule.
- **A failure that only happens inside the gate needs the gate's own output.** `behaviours.mjs` once printed only FAIL. It now prints the failing patch's test output.

## Tools on a host

- **corepack's download prompt defaults to on, so pnpm hangs instead of failing.** Install a real pnpm and set `COREPACK_ENABLE_DOWNLOAD_PROMPT=0` in every script that runs pnpm.
- **A fresh clone has no hooks installed**, so the repository's pre-push gate is skipped in silence. Run `pnpm run hooks:install` before trusting a push from a new checkout.
- **A host with no git identity cannot rebase.** Set the identity in the repository config on every host that commits.
- **The first pnpm install on a host is slow and the second is fast.** An install that reports seconds means the store already had everything, not that the tree was small.
- **A workflow re-run replays the original event.** A pull request title check kept reading the title from when the PR was opened, however often it was re-run. A fresh event, such as a new commit, is the cure.

## The image

- **The build host cannot count the build number.** Its tree is shallow and has no tag, so the driver counts on the assembly host and passes `NUCLEO_BUILD_NUMBER`.
- **Upstream's build info refuses a short commit.** `GIT_COMMIT` must be the full 40-character sha.
- **Plugins upstream publishes separately are left out of the image** unless `OPENCLAW_EXTENSIONS` names them, so `image.extensions` in the manifest lists the ones our patches change.
