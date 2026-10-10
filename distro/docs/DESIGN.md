# Design: what Núcleo is and why it is built this way

Núcleo is our distribution of OpenClaw: upstream OpenClaw pinned to an official release tag, carrying our adapted patches, built from our own source, and gated before any tag moves. The product and code name inside stays OpenClaw, so upstream merges and upstream documentation stay coherent; only the distribution, its image and its release notes carry the distro name.

## Why a distribution at all

We need to run a gateway that carries our fixes without waiting on upstream, and we need to be able to say exactly what is running and reproduce it. A fork alone gives the second only until someone force-pushes; a published upstream image gives neither. So we pin a release, carry our work as a small series on top, and build the artifact ourselves.

## Why the pin is a release tag and not main

main moves constantly and is what upstream tests against. A distribution that tracks it inherits changes other people are still working on, on every deploy, and a broken day upstream becomes a broken day here. We pin to a release, carry our own work as a small series, and move the pin deliberately, one release at a time.

## The patch series

Twelve patches today, each recorded in the manifest with its upstream PR number so its status is a lookup rather than a memory. The policy is upstream-first: where upstream has already solved something, we take upstream and drop our change for that file.

Two measurements shaped this.

First, the wholesale stack is not the way. Applying all twelve to the pin took the behaviours satisfied from 11 down to 7, so the stack as a whole regresses five of them. Patches therefore go back one at a time, each gated on its own.

The acceptance criterion is the BEHAVIOUR, never the diff. The replay resolves each conflict in upstream favour, so a line a patch added can be absent from the assembled tree because upstream solved that problem its own way, which is the policy working rather than a patch lost. Each patch therefore names the behaviour it exists for and the tests that encode it. A patch whose lines did not all land is reported as **partial** and must name that behaviour; a patch that names none is refused. Line presence cannot decide this on its own, and the measurement says so: our added lines are by definition not in the release we started from, so a check that only compares lines can neither pass nor fail with meaning.

Second, an improvement written against main cannot be applied to a release. On the first set, 12 of 12 branches were based on main, sitting 862 to 2942 commits past the pin. Replaying them collided, and a three-way apply could report success while changing nothing. scripts/port.mjs now names every adaptation point before a build runs, which on that set was 74 points across 51 files.

## Prior art: how other distributions carry patches

Carrying patches is what every distribution does, and the shape they converged on is the shape the manifest
already has: a pristine upstream release, a directory of patch files, and one file that owns the order and the
metadata. Debian keeps debian/patches/series with the 3.0 (quilt) source format, RPM lists Patch0 through
PatchN in the spec, Gentoo keeps files/*.patch beside an ebuild, Alpine and Arch list patches in the PKGBUILD
source and apply them in prepare(), Yocto names them in SRC_URI, and Buildroot keeps a patch directory per
package.

Three things are near-universal in that practice, and this repository depends on all three:

- **Provenance in the patch itself.** Debian DEP-3 header carries Description, Origin, Bug, Forwarded and
  Applied-Upstream so that "is this patch still needed?" is answerable without asking a person. Here the
  manifest plays that role: branch, subject, behaviour and behaviourTests.
- **Upstream-first.** Debian and Fedora both treat a patch as something to forward and then delete. The replay
  resolves conflicts the same way, preferring upstream where upstream already made the change, and records the
  count rather than deciding quietly.
- **A known cost at each upstream bump.** Distributions rebase the series by hand, fixing rejects or dropping a
  patch upstream absorbed. This repository replays commits instead, because a commit carries its parent and so
  a real merge base, which a bare diff does not.

Two habits in that practice are worth naming because they are easy to break:

- **A patch is a minimal diff, not a replacement.** Carrying a whole file to change one line is a replacement
  patch, and it is discouraged precisely because it silently reverts upstream own later edits to that same
  file. That is what pinOwnedFiles exists to prevent for ledgers and baselines: take upstream copy and change
  the input, never fork the file.
- **A patch is accepted on the behaviour it exists for, not on its diff being present.** Most distributions
  leave that question to the whole-package suite, so a patch that silently stopped doing its job surfaces
  later. Here every patch names the behaviour and the tests that encode it, which is stricter, and which is
  what turns a patch that stopped working into a reported failure rather than a mystery.

## The build

The container builds from the checkout on disk rather than cloning inside the image. That is faster, it means the image build needs no GitHub credential, and it keeps the recipe in this repository while the context stays the tree. The recipe is the pinned tree own Dockerfile, invoked with our version so the runtime stage asserts it, and with the build heap sized to the machine because the default of 8 GB is larger than a build guest has. Type declaration emission is skipped, because a gateway ships no declarations: that phase was 23m 13s of a 31m 47s host build, so the image is the cheap path and a host build-all is the expensive one.

## The gate

Lint, typecheck, test, build, in that order, with the image build behind all four. Anything that can reject the tree runs before a build, so a failure costs minutes rather than half an hour. The validator refuses a manifest whose build leg is not last, and a green log names exactly one commit.

## Hosts

The pool holds the authoritative checkout and runs the assembly, because replaying a patch series needs ancestry. The test host runs the gate, the image build, docker cache and disposable worktrees, and nothing authoritative lives on it. This is why the manifest refuses a shallow checkout for assembly and allows one for a build: a build needs one commit tree, not its ancestry.

## Deployment

A roll replaces a running service, so it is deliberate, it waits for Abi, and the previous tag stays on the host for rollback. Development images are the ones we roll while working; a release is what we stand behind.

## What we deliberately do not do

- We do not track main for the distribution.
- We do not release unless every gate on that commit is green.
- We do not publish on a schedule; a release happens when something that shipped changed.
- We do not keep unreviewed fixes on the distro branch, because that is what makes the next assembly unreplayable.
- We do not silently repoint a tag that a service is running.
