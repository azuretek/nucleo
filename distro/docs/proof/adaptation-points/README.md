# Every adaptation point is known before a build

Claim: porting the patch series onto the pin can be sized before anything is built.

Evidence: `scripts/port.mjs` replays our own commits with a three-way apply and reports every rejection.

- 74 adaptation points across 51 files on the current series.
- The twelve branches were authored against main, sitting 862 to 2942 commits past the pin, which is why a whole-branch diff refuses to apply.
- Cost: about two minutes to report, against roughly one MISSING_EXPORT per ten minute build when the same information is discovered by building.

What it rules out: discovering an adaptation by watching a build fail.
