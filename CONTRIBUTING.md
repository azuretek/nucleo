# Contributing

Núcleo is OpenClaw plus a patch series and the tooling that assembles, gates and builds it. A change belongs in one of two places:

- **A change to OpenClaw's source is a patch**: a branch cut from the pinned release tag and listed in `distro/nucleo.json`. Fixes, performance work and the Núcleo rename all go this way.
- **Distribution tooling and repository identity** (`distro/`, the `distro.yml` workflow, this file, the README, `SECURITY.md`, `VISION.md`, `CHANGELOG.md`) change directly on `main` through a pull request.

Why it is built this way is [distro/docs/DESIGN.md](distro/docs/DESIGN.md). How to run the chain is [distro/docs/DISTRO.md](distro/docs/DISTRO.md). Where we are going is [VISION.md](VISION.md).

## How a change lands

**Every change lands as a pull request with an issue.** File or link the issue the change answers, so the problem is tracked apart from the fix. Merge when `checks` is green; nobody merges past a red check.

**`main` is protected.** It cannot be force-pushed or deleted, and it takes changes only through a pull request with a green `checks` job and an approving maintainer review. While there is one maintainer, maintainers may merge without a second review; once there are more, every pull request needs one.

**Commits follow Conventional Commits, and the message says why.** `type(scope): a sentence`, where `type` is one of `feat`, `fix`, `perf`, `refactor`, `docs`, `chore`, `test`, `build`, `ci` or `revert`. Git is where reasoning survives, so the body carries it.

A pull request body carries three things: the problem, the change, and the evidence. `.github/pull_request_template.md` is the shape.

## Patches

1. **Cut the branch from the pinned release tag**, never from upstream `main`. A branch written against unreleased code cannot apply to a release. `sync` reports `authored_off_pin`, and 0 is the healthy number.
2. **Fix it here first.** The patch lands in our tree and ships once it passes the gate. We never wait on upstream.
3. **Then send upstream a version written against their `main`**, when upstream would want it: an issue and a pull request from a topic branch, filed on openclaw/openclaw and never against this fork. Upstream `main` is usually well past our pin, so this is often a separate port of the same change.
4. **List it in `distro/nucleo.json`** with its upstream pull request (`null` when it is ours alone), the behaviour it exists for, and the tests that prove it.
5. **A patch is accepted on its behaviour, never on its diff being present.** Its tests fail without the change and pass with it, and the gate runs them on every build.

A fix leaves the series once the release we pin includes it. Performance work and changes upstream does not want stay on purpose.

**Renaming is a patch too.** What people see from outside the code (the command, the image, the visible product name) becomes Núcleo through a patch. Code internals, configuration keys and environment variables keep their OpenClaw names, so upstream merges stay clean.

## What "the evidence" means

- **A command and its output, pasted.** Not "tests pass".
- **The case that fails without the change**, named, so the test is shown to bite.
- **What was not run**, said plainly. A gap named is a gap; a gap left silent reads as coverage.
- **The measurement that settled a choice.** Performance is a goal here, so a performance change carries its numbers.

## Rules

- **Never edit, skip or weaken an upstream test, and never raise a time limit, to get a green.** A red is a result: find what is slow or broken and fix that.
- **A problem in our own tooling is fixed, not documented.** If something cost time, change the code so it cannot recur, and let the commit message say why.
- **One owner per value.** Every value more than one file needs lives in `distro/nucleo.json`; a host's own paths live in its gitignored `nucleo.local.json`.
- **Delete, don't deprecate.** When something is replaced, remove the old thing in the same change.
- **No em dashes, and no AI attribution**, in code, docs or commit messages.

## Issues

Report problems with Núcleo here. A problem that reproduces on stock OpenClaw also belongs upstream at [openclaw/openclaw](https://github.com/openclaw/openclaw/issues), and we may carry a fix for it here first.

Security problems are never filed as issues. See [SECURITY.md](SECURITY.md).
