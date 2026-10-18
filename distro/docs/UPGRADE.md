# Adopting a new upstream release

1. **Set the pin.** Edit `pinnedTag` in `nucleo.json`, and point `distroBranch` at the matching branch.
2. **Sync.** Run `nucleo sync`. It fetches tags, cuts the branch from the new pin, replays our patch series,
   and writes a decision log naming every commit it carried, every commit it left to upstream, and every file
   where a conflict was resolved. Read that log; it is the record of what this release means.
3. **Verify.** Run `nucleo verify`. Every patch must report either carried commits whose lines are present in
   the tree, or zero carried commits with the note that upstream solved it.
4. **Gate.** Run `nucleo gate` on the result, not on either parent. It runs the checks from the manifest and
   writes a dated log naming the exact commit.
5. **Build.** Run `nucleo build`. The image carries the upstream tag and commit so the running container can
   report what it is.
6. **Roll deliberately.** Swapping the image replaces a running service. Keep the previous tag on the host for
   the way back, and do it when nobody is mid-session.
7. **Publish** the tag only with a green gate log for that commit, and only after the roll has been observed
   working.

## The way back

The previous image tag stays on the host. Rolling back is pointing the compose file at it and recreating the
stack, which is the same operation as shipping, in reverse.
