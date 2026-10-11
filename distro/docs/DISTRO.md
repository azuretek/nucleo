# Núcleo distro: how to run it

**Núcleo** (accent in branding, `nucleo` in every identifier) is our OpenClaw distribution: OpenClaw pinned to an official upstream release tag, carrying our patches, built from our own source, and gated before any tag moves. The product and code name inside stays OpenClaw so upstream merges keep working.

**Everything shared lives in `nucleo.json`.** The upstream repo, the pinned tag, the distro branch, the patch list, the image and tag scheme, the gate steps and the log directory. Change a value there, never in a script. **Everything about one host lives in `nucleo.local.json`** beside it (see [Setting up a host](#setting-up-a-host)).

**This file is the whole procedure.** Nothing outside this repository is needed to assemble, gate, build or watch the distro.

## Commands

All paths are relative to `distro/`.

```bash
node scripts/pin-and-build.mjs            # dry run: is the branch covered, and what would run
node scripts/pin-and-build.mjs --apply    # run the whole chain below
node scripts/pin-and-build.mjs --idle     # exit 0 only when no run is in progress
node scripts/chain-status.mjs             # live snapshot of a run
node scripts/chain-status.mjs --watch     # follow a run until it ends

node scripts/nucleo.mjs sync    [--dry-run]   # cut or refresh the distro branch at the pin, replay our patches
node scripts/nucleo.mjs verify               # every patch is an ancestor AND its marker is in the source
node scripts/nucleo.mjs gate                 # run the manifest's gates on the RESULT, write a dated log
node scripts/nucleo.mjs build   [--dry-run]  # build the gateway image from the pinned tree
node scripts/nucleo.mjs publish [--dry-run]  # push the tag, only with a green gate log for that commit
node scripts/nucleo.mjs status               # where the pin, the branch and the last gate log stand
```

## The chain, end to end

`pin-and-build.mjs` decides when the chain runs and on which host. The stages belong to `pipeline.mjs`, which writes one run record per run naming the pin, the distro commit and every patch tip; read the record before believing a summary.

1. **Assembly host**, the authoritative checkout: `pipeline.mjs run --only assemble,verify`. `assemble` rebuilds the distro branch as the pin plus the patch series plus the paths the fork owns. `verify` is the acceptance gate: a patch that leaves lines behind passes only when the manifest names its behaviour and the tests that prove it.
2. **Handoff**: the driver first archives the remote tip it is about to replace as `archive/main-<sha>` and reads it back, so every handoff has a way back. Then `pipeline.mjs run --only handoff` pushes with `--force-with-lease`, inside the workflow guard described below.
3. **Build machine**: `pipeline.mjs run --only gate,build` over `ssh -tt`, so a driver that is killed ends its remote gate too. It force-fetches the distro branch first, because the handoff rewrites it and a plain fetch is rejected, which would gate stale content. Each gate step streams to its own log file, so output has no size cap and the log can be read while it runs. Then the image build.

**It runs only when the distro branch is not covered.** Covered means a run record for exactly that commit whose stages all passed and which included a build. A green chain writes that record on the assembly host against the commit it handed off, so a green run is never repeated and a commit that lands during a run is never mistaken for built.

**One run at a time.** A lock refuses a second run, because two long git operations in one worktree corrupt the index. A lock whose holder is dead is cleared at once.

## Watching a run

Watch with `chain-status.mjs`, never a polling loop. The driver and the gate each append one timestamped line per stage and per step start and end to `events.log` in their log directory, and `chain-status.mjs` follows both with `tail -F`.

- Without flags it prints the lock holder, the recent events on both hosts and the tail of the live step's log.
- `--watch` streams events and exits 0 on `chain GREEN` or `chain COVERED`, 1 on `chain RED`, 3 the moment the driver dies without a result, and 2 if nothing is running. `--watch --until=change` exits at the next event of any kind.

## Upstream workflows stay in the tree and never run here

Upstream reads its own workflow files as source: a test-worker asset list names one, and about 164 tests parse them, so deleting them kills the test leg before a single test runs. They stay. The handoff switches Actions off, pushes, disables by id every workflow that is not `.github/workflows/distro.yml`, switches Actions back on and disables again. GitHub registers pushed workflows while Actions is off, so none can start; the first run disabled 110 with 0 runs. `distro.yml` fails if any other workflow is active, and a workflow that first appears in a new pin is caught the same way. The driver needs a GitHub token allowed to change the repository's Actions settings.

## Slow-host timeouts

Upstream's timeouts assume CI hardware. The driver raises these on the build machine only. Each is a knob upstream exposes, or one our patch series adds, so none changes behaviour.

| Variable                                             | Upstream default | Set to | Why                                                                                 |
| ---------------------------------------------------- | ---------------- | ------ | ----------------------------------------------------------------------------------- |
| `OPENCLAW_OXLINT_SHARD_TIMEOUT_MS`                   | 15 min           | 45 min | one oxlint shard overran 15 minutes and failed the lint leg                         |
| `OPENCLAW_BOUNDARY_DTS_TIMEOUT_MS`                   | 5 min            | 30 min | added by `fix/boundary-dts-timeout-knob` for the package boundary units             |
| `OPENCLAW_PLUGIN_SDK_BOUNDARY_ROOT_SHIMS_TIMEOUT_MS` | 5 min            | 30 min | the plugin-sdk unit reads only this knob, so the general one leaves it at 5 minutes |

## Setting up a host

Copy `nucleo.local.example.json` to `nucleo.local.json` beside the manifest (it is gitignored) and set this host's values: the checkout, the log directory, the build machine's ssh target, checkout and log directory, and optionally an alert script that takes `--subject` and `--body`. The committed manifest carries placeholders on purpose, and every script refuses an unresolved one rather than guessing. The build machine needs Git 2.45 or newer (the frozen bundle contract reads selected sources without a lazy fetch, and its docker helper tests refuse an older Git; Ubuntu 24.04 ships 2.43, so use the git-core PPA), at least 12 GB of memory it does not have to compete for (a Hyper-V guest belongs on fixed memory: under dynamic memory a Linux guest swaps before the balloon grows), the same repository with dependencies installed, and its checkout and every ancestor must not be group- or world-writable, because the node host refuses a temp workspace under one (the driver runs the machine stage with `umask 022` for what the gate creates); it may be shallow, because gate and build need one commit tree rather than history.

## A newer upstream release is reported, never applied

The driver names a newer upstream release and leaves it alone. A pin change lands together with its patch adaptation, which is a judgement rather than a step; [UPGRADE.md](UPGRADE.md) covers it.

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

## The build is automatic; the roll is not

The chain builds an image on its own. Publishing a tag and rolling it out stay deliberate, because they replace a running service, and `pin-and-build.mjs` never publishes. Logs land under the manifest's `logs` directory.

## Host roles

**The build machine is for tests and builds, and nothing authoritative lives there.** It carries test builds, the gate, the container build, docker layers and cache, and disposable worktrees, all of which can be recreated. The authoritative checkout of the fork, where `sync` cuts the distro branch and replays the patches, lives on the assembly host's durable storage, because that is where history and anything that grows belongs. Growing the build machine's disk buys scratch room, never a permanent clone.

The consequence for the code: the shallow-clone refusal guards the operations that replay a patch series (sync and verify), and not gate or build, which need one commit tree rather than its ancestry. A build machine can therefore take the assembled commit alone.
