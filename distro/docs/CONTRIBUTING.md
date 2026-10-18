# Contributing

How a change to this repository is made. What may publish is in [../.github/workflows/CONVENTIONS.md](../.github/workflows/CONVENTIONS.md) and the version story is in [RELEASE.md](RELEASE.md); this file is about the work itself.

## Branch from the pin, not from main

An improvement to the distribution is written against the pinned release tag, because a branch cut from main is authored against unreleased code and cannot apply to a release. A branch that fixes something in upstream OpenClaw is a different thing: it goes upstream as a topic branch against their main, plus an issue, and never as a pull request against our fork.

## One owner per value

Every value more than one file needs lives in `nucleo.json`. A script reads it and never carries its own copy. A host that needs different paths supplies them through the gitignored `nucleo.local.json`, and a placeholder that survives is a refusal rather than a guess.

## What every change carries

- A conventional commit message, and the message carries WHY. Git is the only thing that records reasoning.
- A pull request, and the issue it answers where one exists.
- `node scripts/publish-scan.mjs` exiting 0 before anything is pushed. It refuses an em dash, a real host path, a LAN or tailnet address and any AI attribution, and it ignores what git ignores, because that cannot be published.
- `node scripts/validate-manifest.mjs` exiting 0 whenever `nucleo.json` changes.

## Deleting, not deprecating

When something is replaced, the thing it replaced is removed in the same change, and the commit message says why. A comment explaining a dead path is not a substitute.

## Where a question goes

If a rule here and a rule in the repository disagree, the repository file is the owner and this one is wrong. Fix it in the same pass.
