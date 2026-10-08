# Releases

One release names one version, and every artifact that distributes that version is built from the same commit. What each artifact does with its own package is in its own document; this is the whole version story.

## The version is computed, never committed

The manifest holds the version in development and nothing rewrites it. Every build derives its own name from the tree it is building:

| Tree state                      | Version                       |
| ------------------------------- | ----------------------------- |
| On a `v<version>` tag, clean    | `<version>`                   |
| The distro branch, clean        | `<version>-dev.<build>.<sha>` |
| A tree with uncommitted changes | refused for a build           |

- `<build>` is the count of commits on the distro branch since the pinned tag, so it rises on its own and cannot collide.
- `<sha>` is the short commit of the tree being built.
- The manifest carries two numbers. current is the version a deployment reports today, and version is the one in development, always one apart. So 0.0.0 is current while the first dev builds are 0.0.1-dev.<build>, and the first release will be 0.0.1 as well, after which current becomes 0.0.1 and development moves to 0.0.2.

## Names

- Git, dev: `v<version>-dev.<build>.<sha>`, the same shape chela and cuate tag with.
- Git, release: `v<version>`, cut on the distro branch.
- Image, dev: `nucleo:<version>-dev.<build>`.
- Image, release: `nucleo:<version>` and `nucleo:latest`.
- Registry: ghcr.io/azuretek, and the package stays public, which keeps storage and transfer free.

## Channels

A dev build is the prerelease channel. `latest` follows the newest release and never a dev build. A host running a service pins the version or the digest rather than `latest`, so a later rebuild cannot silently change what is running.

## When a release happens

**A release is a decision, not a schedule.** There is no cadence and no timer. We cut a stable when we judge the accumulated dev builds good enough to stand behind, and only when something that shipped actually changed. Everything a dev build proved still holds: the gate was green for that commit, and the release image is the same tree under a different name.

## The pin moves when upstream releases

The pin is an upstream release tag, and it moves when upstream publishes a release, never when their main moves. A pin bump is a version event: the pin change and the patch adaptation land together, because the whole series is written against the pin.

### At a pin bump

**Nothing is done to the topic branches.** `sync` replays their commits onto the new pin and resolves by policy, which is the same path every assembly already takes. A patch whose replay reports adaptation points is rebased onto the new pin then, and only then, so the cost is paid where it is real instead of rebasing twelve branches on a schedule and carrying the conflicts anyway.

## The image proves its own version

The container build stamps the version and the runtime stage asserts it in three places, against the package, the build info and the CLI. A mismatch fails the build rather than shipping a mislabelled image.
