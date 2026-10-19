# Núcleo distro: how to run it

**Núcleo** (accent in branding, `nucleo` in every identifier) is our OpenClaw distribution: OpenClaw pinned to an official upstream release tag, carrying our patches, built from our own source, and gated before any tag moves. The source and code name inside stay OpenClaw so upstream merges keep working; what people see from outside the code is Núcleo.

**Everything shared lives in `nucleo.json`.** The upstream repo, the pinned tag, the distro branch, the patch list, the image and tag scheme, the gate steps and the log directory. Change a value there, never in a script. **Everything about one host lives in `nucleo.local.json`** beside it (see [Setting up a host](#setting-up-a-host)).

**This file is the whole procedure.** Nothing outside this repository is needed to assemble, gate, build or watch the distro.

## Commands

All paths are relative to `distro/`.

```bash
node scripts/pin-and-build.mjs            # dry run: is the branch covered, and what would run
node scripts/pin-and-build.mjs --apply    # run the whole chain below
node scripts/pin-and-build.mjs --idle     # exit 0 only when no run is in progress

node scripts/nucleo.mjs sync    [--dry-run]   # cut or refresh the distro branch at the pin, replay our patches
node scripts/nucleo.mjs verify               # every patch is an ancestor AND its marker is in the source
node scripts/nucleo.mjs gate                 # run the manifest's gates on the RESULT, write a dated log
node scripts/nucleo.mjs build   [--dry-run]  # build the gateway image from the pinned tree
node scripts/nucleo.mjs publish [--dry-run]  # push the tag, only with a green gate log for that commit
node scripts/nucleo.mjs status               # where the pin, the branch and the last gate log stand
```

## The chain, end to end

`pin-and-build.mjs` decides when the chain runs and on which host. The stages belong to `pipeline.mjs`, which writes one run record per run naming the pin, the distro commit and every patch tip; read the record before believing a summary.

1. **Assembly host**, the authoritative checkout: `pipeline.mjs run --only assemble,verify`. `assemble` rebuilds the distro branch as the pin plus the patch series plus the paths the fork owns. `verify` is the acceptance gate: a patch that leaves lines behind passes only when the manifest names its feature or fix and the tests that prove it.
2. **Handoff**: the driver first archives the remote tip it is about to replace as `archive/main-<sha>` and reads it back, so every handoff has a way back. Then `pipeline.mjs run --only handoff` pushes with `--force-with-lease`, inside the workflow guard described below.
3. **GitHub**: the push starts `distro.yml`, which runs the gate, builds the image and publishes the dev pre-release (see [Continuous integration](#continuous-integration)). The driver waits for that run to appear and names it, and its part ends there.

**It runs only when the distro branch is not covered.** Covered means GitHub has a successful `distro.yml` push run for exactly that commit. A run still in progress counts as in hand, so the driver never hands off over a build. A failed run is not covered: assembling again cuts a new commit, and its push is the retry.

**One run at a time.** A lock refuses a second run, because two long git operations in one worktree corrupt the index. A lock whose holder is dead is cleared at once.

## Watching a run

Follow the gate and the build on GitHub, in the run the driver names (`gh run watch <id> --repo azuretek/nucleo`). The driver appends one timestamped line per stage start and end and per result to `events.log` in its log directory, so a finished run can be read afterwards.

**A red gate names its cause in the job log.** When a step fails, the gate prints the reason lines from that step's log (type errors, the failing row of upstream's check summary, failing tests), annotates the run with each one, adds them to the run summary, and folds the end of the step log into the job log. Warnings a step printed into its log are re-emitted as warnings, never as the cause. `scripts/gate-report.mjs` owns which lines count. The full step logs are still kept as the `gate-logs` artifact for 14 days.

## The gate tests our patches, not upstream

The gate runs our own `lint` step, scoped to changed paths, then `tests`. It does not run upstream's `check`: that pipeline covers the whole tree, including upstream's own typecheck and boundary builds, and upstream has already run it before the release we pin. The tree is compiled once, by the image build that follows a green gate: upstream's build ran in the gate and again inside the Dockerfile, so the gate's copy compiled the same code a second time (about 17 minutes) and is gone. A compile error now stops the chain at the image build, still before anything is published. `tests` runs each carried patch's own tests, the ones its upstream PR adds or changes, listed as `tests` in `nucleo.json`. Upstream's full suite does not run here: upstream already runs it before every release, so running it again re-tests code we did not change.

- **Every carried patch names its tests.** A patch whose tests are absent from the tree fails `tests`, so a patch cannot ride along untested.
- **A tooling patch with no test file of its own** names the gate step that exercises it in `coveredBy`. It counts only when that step is in `gates`, or when it names `image`: a Dockerfile change is exercised by the image build, which follows a green gate and stops the chain when it fails.
- **A patch may tighten a pin-owned baseline.** Pin-owned files are taken from the pin after the replay, so a line a patch deletes from one, because its fix made that allowance stale, would come back and fail the ratchet. Lines our patches' own commits delete are removed from the pin copy too. Only deletions are carried, because an addition would loosen a ratchet.
- **Changes that only speed up upstream's tests are not carried.** Making their suite faster is not part of testing our changes.

## Upstream workflows stay in the tree and never run here

Upstream reads its own workflow files as source: a test-worker asset list names one, and about 164 tests parse them, so deleting them kills the test leg before a single test runs. They stay. The handoff switches Actions off, pushes, disables by id every workflow that is not `.github/workflows/distro.yml`, switches Actions back on and disables again. GitHub registers pushed workflows while Actions is off, so none can start; the first run disabled 110 with 0 runs. `distro.yml` fails if any other workflow is active, and a workflow that first appears in a new pin is caught the same way. The driver needs a GitHub token allowed to change the repository's Actions settings.

## What the image carries

The image builds in the plugins listed in `image.extensions`, passed to the Dockerfile as `OPENCLAW_EXTENSIONS`. Upstream publishes those plugins separately and leaves them out of the image otherwise. `lobster` is listed because a carried patch changes it, so the image runs the lobster code the gate tested.

**The image carries two versions, and only one is OpenClaw's.** `OPENCLAW_DOCKER_BUILD_VERSION` is the pin's own version, so `package.json`, `build-info.json` and every plugin compatibility check see exactly what upstream shipped. Núcleo's number travels beside it as `NUCLEO_VERSION`, which is what `nucleo --version` shows and what the release check compares. A build of ours is therefore never mistaken for an upstream version, and the compatibility shim that stood in for it is gone.

The image's update notices name this fork's releases, never the upstream npm package. The build passes `OPENCLAW_UPDATE_GITHUB_REPO` (the fork's `owner/repo`) to the Dockerfile, which keeps it as an environment variable, and `nucleo/update-source` makes the update check read that repository's GitHub releases when it is set. A dev image reports its full version, `<version>-dev.<build>`, so one dev build can see that the next is newer, and a release is never handed to the package auto-updater, because an image is replaced, not updated in place.

## Setting up a host

Copy `nucleo.local.example.json` to `nucleo.local.json` beside the manifest (it is gitignored) and set this host's values: the checkout, the log directory, and optionally an alert script that takes `--subject` and `--body`. The committed manifest carries placeholders on purpose, and every script refuses an unresolved one rather than guessing. The assembly host needs a full, non-shallow clone of the fork, and `gh` signed in with a token allowed to change the repository's Actions settings, for the workflow guard.

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

**The assembly host holds the one authoritative checkout.** `sync` cuts the distro branch and replays the patches there, on durable storage, because that is where history and anything that grows belongs. Tests and builds run on GitHub's hosted runners, which keep nothing between runs except the caches GitHub stores.

The consequence for the code: the shallow-clone refusal guards the operations that replay a patch series (sync and verify), and not gate or build, which need one commit tree rather than its ancestry.

## Continuous integration

Test and build run on GitHub's hosted runners, like Chela and Cuate. `distro.yml` runs the fast checks on every pull request. On every push to `main` it also runs the gate (`check`, then each carried patch's own tests), builds the image with buildx and pushes it to `ghcr.io/azuretek/nucleo-gateway`, and publishes the dev pre-release `v<version>-dev.<build>.<sha>`. Only the newest ten dev pre-releases and images are kept. Docker layers, the pnpm store and the Node compile cache are reused between runs through GitHub's cache. Assembly still runs on the assembly host and hands off by pushing `main`, which starts the build.
