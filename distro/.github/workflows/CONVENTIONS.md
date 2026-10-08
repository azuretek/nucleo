# Release rules

How this repository decides that a build may go out. The scripts own the mechanism; this file owns the rule, so the next person changing a trigger does not have to reconstruct from code why publication waits. Chela and Cuate keep their release rules in this same place.

- **A green gate log naming that exact commit.** A re-run of the gate is not evidence about an artifact, so a build refuses without a log for the commit it is building.
- **Publish only from the distro branch**, and only when something that shipped actually changed.
- **Nothing publishes on a red or unrun gate.**
- **Nothing publishes on a failed verify either.** verify is what says whether the series is actually carried, so a failed verify withholds the publication entirely and nothing builds from an assembly we cannot account for.
- **A release is a decision, not a schedule.** No cadence and no timer: a stable is cut when we judge the dev builds good enough to stand behind, and only when something that shipped changed.
- **A roll is deliberate and never automatic**, and it waits for Abi. The previous image tag stays on the host for rollback.
- Keep the last ten published dev images. Never prune a release image, and never replace a published image in place: withdraw a bad one and build again.
- **Upstream-first patches.** A fix that belongs to upstream OpenClaw goes there as an issue plus a PR from a topic branch, never as a PR against our fork. Once upstream takes one we drop our copy for that file, so the series shrinks rather than living forever. Nucleo-only changes stay with us and are recorded as such.
- **Every improvement is written against the pin, never against main.** A branch cut from main is authored against unreleased code and cannot apply to a release, which is what turns every assembly into hand adaptation.
- The distro branch is rebuilt from the manifest each time, never appended to.
- **At a pin bump the topic branches are left alone.** sync replays their commits onto the new pin; a patch that proves expensive to replay is rebased onto it then, and only then.
- Assemble where the history lives, on the pool. Gate and build on the test host, which only ever sees the assembled commit, and put nothing authoritative on it.

- **Our own gate is the check, and this fork carries none of the upstream workflows.** The clearing patch (n=13, `fix/clear-upstream-workflows`) keeps them out of the tree, so a pull request reports only the checks we chose. The one workflow at the root is ours: it validates the manifest and fails loudly if a workflow we did not choose appears, which is the signal to extend the clearing patch. A merge waits on **our gate log for that commit**; a red from anywhere else is noted, not obeyed.
