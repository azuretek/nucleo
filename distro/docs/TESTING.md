# Testing and the gate

The gate runs two steps in order, and the image build follows a green gate. Upstream tests every release before publishing it, so the gate does not run upstream's full suite again; it tests what our patches change.

| step    | what it covers                                                                                                                                                                                                                                    |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lint`  | distro lint scoped to changed source paths                                                                                                                                                                                                        |
| `tests` | each carried patch's own tests, the ones its upstream PR adds or changes, listed as `tests` in `nucleo.json`. Distro `*.test.mjs` files use Node's test runner; upstream tests use Vitest. Build-only patches are listed in `buildSteps[].covers` |

The image build is the one compile of the tree. A compile error stops the chain there, before anything is published.

## Run it

- The whole gate: `node scripts/nucleo.mjs gate`, which runs the manifest steps in order, stops at the first failure, and writes a dated log under the manifest logs directory stamped GREEN or RED with the commit.
- One step alone: `node distro/scripts/nucleo.mjs gate lint`, or `node distro/scripts/patch-tests.mjs <checkout> [patchNumber]`.
- Patches 14, 15 and 24 execute duplicate-source fixture scanning, boundary preparation timeout fixtures, and strict typechecking of the actual WAL test support and Vitest config helper. Image compilation does not cover these contracts.

## What the log is for

**A green log names exactly one commit.** A re-run of the gate is not evidence about an artifact, so a tag bump is refused without a log for that exact commit. That is the point of writing it down rather than watching a terminal.

## Rules

- **Never edit, skip or weaken an upstream test, and never raise a time limit, to get a green.** A red is a result: find what is slow or broken and fix that.
- **The type-aware lint pass is memory hungry.** One worker was seen holding 5.3 GB resident on a guest with 6 GB. Give the host headroom, and keep the gate and an image build off the same host at the same time.
- **A coverage label is not a test.** A named image build covers Dockerfile changes, not script behavior or source trees excluded from production compilation.
