# The pinned release compiles from our own source

Claim: the pinned release builds from our own source with no patches applied, so a later failure is attributable to a patch rather than to the tree.

Evidence: the build at the pin, in a worktree clean at `fc23bc864e45`.

- `build_rc=0`, total 31m 47s, on a 4 vCPU guest with 6 GB.
- Slowest phases: `write-unified-entry-dts` 19m 28s, `write-plugin-sdk-entry-dts` 3m 45s, `ui:build` 25.7s.
- Type declaration emission accounts for 23m 13s of the total, which is why the container build skips it.

What it rules out: the missing-export build failures seen earlier came from our patch stack, not from the release itself.
