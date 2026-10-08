# Núcleo

**Núcleo** is our OpenClaw distribution: OpenClaw pinned to an official upstream release tag, carrying our
patches, built from our own source, and gated before any tag moves. The accent belongs in branding and docs;
`nucleo` is used in every identifier, because image tags, paths and branches cannot carry one.

The product and code name inside stays **OpenClaw**, so upstream merges keep working. This repository owns the
distribution: what it is pinned to, what we carry, how it is built, and what it promises.

## Why a distribution

Upstream `main` moves constantly and is what upstream tests against. A deployment that tracks it inherits
other people's in-flight changes on every restart. We pin to a release, carry a small patch series, build our
own image so our patches are actually deployed rather than merely present in a fork, and refuse a tag bump
without evidence.

## Versioning

Nucleo versions itself, because it diverges from upstream. Plain semver, and the version lives in
`nucleo.json` so that the image tag, the dev tag and the release tag cannot disagree.

The line starts at **0.0.0**, which is not a release: it is the dev line. **The first release is 0.0.1.**
`main` always carries the next unreleased version, and a release bump is what makes a tag.

- **`main` is our version**: the upstream release pin plus our adapted patches. It is not upstream's
  `main` and it deliberately is not `0 ahead` of the pin.
- **Dev builds come from `main` continuously**, tagged `v<version>-dev.<build>`. A dev build is not a
  release and nothing depends on it.
- **A release is a semver tag on `main`**, `v<version>`, unique to Nucleo and never upstream's version.
  Nothing is tagged without a green gate log naming that exact commit.
- **Bumping the pin is a version event**: the pin change and the patch adaptation land together, so
  `main` never carries a half-adapted release.

## Shape

| Path              | It is                                                                                       |
| ----------------- | ------------------------------------------------------------------------------------------- |
| `nucleo.json`     | the manifest: the pin, the branch, the patch list, the image and tag scheme, the gate steps |
| `docs/PATCHES.md` | every patch we carry, its upstream issue or PR, and its status                              |
| `docs/UPGRADE.md` | how a new upstream release is adopted                                                       |

The manifest is the only place a shared value lives. If a version, a branch name or a tag shape needs to
change, it changes there and nowhere else.

## How the image is built

The image is built with **the fork's own Dockerfile**, not a second one kept here. Upstream maintains a
multi-stage build that pins its base images by digest; a rival Dockerfile in this repo would drift from it and
is exactly the duplication the upstream-first policy exists to prevent. The build is therefore:

```
git worktree add --detach <worktree> refs/heads/<distroBranch>
docker build --load -t nucleo-base:<pinnedTag> -f Dockerfile <worktree>
```

The tool layer a deployment needs on top (docker CLI, `gh`, `op`) belongs to the deployment, not the
distribution, and lives with the compose stack.

## How it is driven

The `nucleo` skill owns the mechanics: `sync` assembles the branch, `verify` proves every carried patch is
really in the tree, `gate` runs the checks on the result, `build` makes the image, `publish` pushes a tag.
The build and the roll are deliberate because they replace a running service; the check half is safe on a timer.

## The policies

- **Upstream first.** Where upstream has already solved an issue we opened, we take upstream and drop our
  change for that file. A distribution that duplicates a fix upstream already shipped is a liability.
- **Evidence over inference.** A patch counts as carried only when the lines it adds are present in the built
  tree. Ancestry is not evidence: a replay writes new commits, so identity is checked by patch content.
- **A gate is per commit.** A green log names the exact commit it passed. A re-run of the checks is not
  evidence about an artifact that has since changed.
- **No shallow clones.** A shallow checkout cannot replay a patch series at all; the failure reads like a code
  problem and is not.
