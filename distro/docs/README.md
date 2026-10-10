# Documentation

Shared documentation for Núcleo. One distribution and one set of rules, so anything true of more than one surface is written once here.

| Document                           | Answers                                                                                                        |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| [DESIGN.md](DESIGN.md)             | What Núcleo is, why it is pinned to a release, how the patch series works, and what we deliberately do not do. |
| [RELEASE.md](RELEASE.md)           | What a release is, how a build is versioned and named, and which tag carries what.                             |
| [TESTING.md](TESTING.md)           | The gate: what each step covers, how to run one alone, and what the log is for.                                |
| [CONTRIBUTING.md](CONTRIBUTING.md) | How a change is made here, what every change carries, and where a question goes.                               |
| [DISTRO.md](DISTRO.md)             | How to run, watch, schedule and set up the chain from pin to built image.                                      |
| [PATCHES.md](PATCHES.md)           | The patch series, one row per upstream PR.                                                                     |
| [UPGRADE.md](UPGRADE.md)           | Moving the pin to a newer upstream release.                                                                    |
| [proof/](proof/)                   | Evidence for the claims we make, one directory per claim.                                                      |

The rules for what may publish are in [.github/workflows/CONVENTIONS.md](../.github/workflows/CONVENTIONS.md).
