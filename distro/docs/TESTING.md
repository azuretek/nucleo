# Testing and the gate

The gate is three steps, run in this order, with a build behind all three. Anything that can reject the tree runs before a build, so a failure costs minutes rather than half an hour.

| step    | what it covers                                                                                                                                                                                                 |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `check` | the pinned repo aggregate check: guard preflights, typecheck, the full lint including the type-aware pass, and policy guards. It runs `scripts/run-lint.mts` itself, so a separate `lint` step would repeat it |
| `test`  | the behaviour suites                                                                                                                                                                                           |
| `build` | the compile, and the last thing to run                                                                                                                                                                         |

## Run it

- The whole gate: `node scripts/nucleo.mjs gate`, which runs the manifest steps in order, stops at the first failure, and writes a dated log under the manifest logs directory stamped GREEN or RED with the commit.
- One step alone: `pnpm run <step>` in the checkout.
- The plain build: `pnpm run build`, which is what the image build wraps.

## What the log is for

**A green log names exactly one commit.** A re-run of the gate is not evidence about an artifact, so a build refuses without a log for the commit it is building and a tag bump is refused without one. That is the point of writing it down rather than watching a terminal.

## Two traps already paid for

- **The type-aware lint pass is memory hungry.** One worker was seen holding 5.3 GB resident on a guest with 6 GB, which swapped instead of working. Give the host headroom, or keep the gate and a docker build off the same host at the same time.
- **A gate step that does not exist is a false red.** The manifest once named `typecheck`, which the pinned repo has no script for, so every run failed on a missing script rather than on the code. The manifest now names `check`.
