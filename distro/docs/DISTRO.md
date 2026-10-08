# Núcleo distro: how to run it

# Núcleo

**Núcleo** (accent in branding, `nucleo` in every identifier) is our OpenClaw distribution: OpenClaw pinned to an
official upstream release tag, carrying our patches, built from our own source, and gated before any tag moves.
The product and code name inside stays OpenClaw so upstream merges keep working.

**Everything shared lives in `nucleo.json`.** The upstream repo, the pinned tag, the distro branch, the patch
list, the image and tag scheme, the gate steps and the log directory. Change a value there, never in a script.

## Commands

```bash
node scripts/nucleo.mjs sync    [--dry-run]   # cut or refresh the distro branch at the pin, replay our patches
node scripts/nucleo.mjs verify               # every patch is an ancestor AND its marker is in the source
node scripts/nucleo.mjs gate                 # run the manifest's gates on the RESULT, write a dated log
node scripts/nucleo.mjs build   [--dry-run]  # build the gateway image from the pinned tree
node scripts/nucleo.mjs publish [--dry-run]  # push the tag, only with a green gate log for that commit
node scripts/nucleo.mjs status               # where the pin, the branch and the last gate log stand
```

## The traps this exists to avoid, all measured

- **★ A shallow clone cannot carry a patch series.** `git apply -3` fails with "repository lacks the necessary
  blob to perform 3-way merge", which reads like a code problem and is not. `sync` refuses a shallow checkout.
- **★ Our patch branches are based on `main`, which is far ahead of any release tag.** Replaying them onto a tag
  conflicts, typically one file at each patch's first commit. So `sync` resolves by POLICY and logs every
  decision rather than reporting a conflict and stopping.
- **★ The policy is upstream-first**: where upstream already solved the issue, take upstream and drop our change
  for that file; otherwise keep our fix and integrate it. `gate` decides whether the integration was sound.
- **★ Never run two long git operations in one worktree.** A second `reset --hard` races the first, corrupts the
  index, and makes `git apply -3` report success while changing nothing. Verify `HEAD` and `git status` between
  runs.
- **★ A green gate log is per COMMIT.** A tag bump is refused without a log naming that exact commit, because a
  re-run of the gates is not evidence about the artifact.
- **Ancestry alone is not verification.** A commit can be an ancestor while its change is absent from the tree,
  which is why `verify` checks a marker in the source as well.

## Base every improvement on the PIN, never on main

**★ Cut an improvement branch from the pinned release tag.** The strategy is to improve a stable release so we
never fall far behind upstream, and a branch cut from `main` is authored against unreleased code: it cannot
apply to the release, so every assembly becomes hand-adaptation. Measured on our first set (2026-10-04):
**12 of 12 branches were off-pin**, with bases sitting 862 to 2942 commits past the pin, against `main` being
3232 past it. `sync` now reports `authored_off_pin` for exactly this reason, and 0 is the only healthy number.

## Ownership

The build and the roll are deliberate and never automatic, because they replace a running service. The check half
is safe to run on a timer so drift appears on its own. Logs land under the manifest's `logs` directory.

## Host roles

**★ azurevm1 is the TEST AND BUILD host. Nothing authoritative lives there.** It carries test
builds, the gate, the container build, docker layers and cache, and disposable worktrees, all of
which can be recreated. The authoritative checkout of the fork, where sync cuts the distro branch
and replays the patches, lives on the pool at azureserve1, because that is where history and
anything that grows belongs. Growing the VM disk buys scratch room for builds, never a permanent
clone.

The consequence for the code: the shallow-clone refusal guards the operations that replay a patch
series (sync and verify), and not gate or build, which need one commit tree rather than its
ancestry. A build host can therefore take the assembled commit alone.
