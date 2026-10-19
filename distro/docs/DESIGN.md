# Design: what Núcleo is and why it is built this way

Núcleo is a faster, leaner distribution of OpenClaw: upstream OpenClaw pinned to an official release tag, carrying our fixes and performance work, built from our own source, and gated before any tag moves. The source and code name stay OpenClaw, so upstream merges and upstream documentation stay coherent. Everything people see from outside the code, the `nucleo` command, the `nucleo-gateway` image, the releases, the README and the repository conventions, is Núcleo, and the build renames it. Code internals, configuration keys and environment variables are never renamed.

## Goals

- **Faster and more efficient than stock OpenClaw**: quicker startup, less memory and CPU at rest, less work per request.
- **Chela is the client.** We build for and test against Chela on iOS, Android, desktop and the web. It is built on the Control UI, and the Control UI stays the base on every platform.
- **A good interface for coding**: writing, running and reviewing code with an agent is a primary use case.
- **Deploy anywhere, including older hardware**, from an old laptop or a spare mini PC to a Raspberry Pi.
- **Run a known thing, and ship fixes without waiting** for upstream, while every upstream-fixable change still goes upstream.

## Design principles

- **Stability over the newest thing.** A platform people rely on across their devices has to keep working between upgrades, so we pin a release, move it one release at a time, and gate every change.
- **Small and older hardware is a target, not an afterthought.** A change that grows memory, disk or startup time has to justify the cost, and a lighter way to do the same thing is a reason to diverge from upstream.
- **Performance is measured, not assumed.** A performance patch carries the measurement that justifies it.
- **One client, every device.** We build for Chela on the Control UI rather than separate native interfaces, so a feature lands on every platform at once.
- **Stay mergeable.** Renaming stops at what is seen from outside, so every upstream release still merges cleanly.
- **Test what we change**, and never edit or weaken upstream's tests to get a green.

## Why a distribution at all

We need to run a gateway that carries our fixes without waiting on upstream, and we need to be able to say exactly what is running and reproduce it. A fork alone gives the second only until someone force-pushes; a published upstream image gives neither. So we pin a release, carry our work as a small series on top, and build the artifact ourselves.

## Why the pin is a release tag and not main

main moves constantly and is what upstream tests against. A distribution that tracks it inherits changes other people are still working on, on every deploy, and a broken day upstream becomes a broken day here. We pin to a release, carry our own work as a small series, and move the pin deliberately, one release at a time.

## The patch series

Each patch is recorded in the manifest with its upstream PR number so its status is a lookup rather than a memory. The policy is upstream-first: where upstream has already solved something, we take upstream and drop our change for that file.

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
  manifest plays that role: branch, subject, behaviour and tests.
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

`check`, then each carried patch's own tests, then the image build, which is the one compile of the tree. Upstream already runs its full suite before every release, so we test what our patches change rather than running it again. Anything that can reject the tree runs before the image build, so a failure costs minutes rather than half an hour, and a green log names exactly one commit.

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
