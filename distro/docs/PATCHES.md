# Patches we carry

One row per patch in `nucleo.json`, which is the machine-readable copy. Upstream numbers are pull requests on openclaw/openclaw; "ours" is distribution tooling or build work that has no upstream counterpart. A fix leaves the series once the release we pin includes it; performance work upstream does not want stays on purpose.

| #   | Upstream | Branch                                         | Subject                                                           |
| --- | -------- | ---------------------------------------------- | ----------------------------------------------------------------- |
| 2   | #163964  | `fix/image-draft-snapshot`                     | image drafts survive a temporary file disappearing                |
| 3   | #151441  | `fix/chat-send-reserved-marker`                | chat.send after a reconnect is no longer rejected                 |
| 4   | #148581  | `fix/openai-nano-platform-route`               | gpt-5.4-nano no longer rejects keys as incompatible               |
| 5   | #144745  | `fix/surface-model-ref-resolution-reason`      | config says why a model ref could not resolve                     |
| 6   | #152205  | `fix/exec-completion-steering`                 | background-exec completions steer into busy sessions              |
| 7   | #161344  | `fix/lobster-llm-adapter-current`              | Lobster runs native LLM stages in embedded workflows              |
| 8   | #162160  | `fix/gateway-startup-health-cold-worker-cache` | bound a cold Vitest worker build                                  |
| 9   | #162144  | `fix/catalog-startup-phase-trace`              | name the startup phase that overruns the catalog deadline         |
| 10  | #162132  | `fix/cron-forced-run-ack-budget`               | cron forced-run ack budget under load                             |
| 11  | #162126  | `fix/subagent-orphan-retry-timer`              | orphan-recovery restart when the retry timer is not yet scheduled |
| 12  | #150246  | `fix/e2e-built-runtime-typed`                  | run the retry-after e2e against the built runtime                 |
| 14  | ours     | `fix/distro-not-upstream-source`               | the fork tooling tree is not scanned as upstream source           |
| 15  | ours     | `fix/boundary-dts-timeout-knob`                | let a slow host raise the boundary dts timeout                    |
| 19  | ours     | `perf/oxlint-extension-chunk-size`             | let any host size serial plugin lint chunks                       |
| 24  | ours     | `fix/typecheck-core-pin`                       | type the WAL timer stub and the Vitest project cache hook         |
| 25  | #155959  | `nucleo/sqlite-snapshot-staging-reuse`         | reuse one staging directory across snapshot retries               |
| 26  | #155300  | `nucleo/session-projection-config-republish`   | stop a republished snapshot from invalidating session rows        |
| 27  | ours     | `nucleo/docker-build-step-cache`               | keep build-all's step cache across image builds                   |

## How a patch is carried

1. Write it on a topic branch cut from the pinned release tag, never from upstream `main`. `sync` reports `authored_off_pin`, and 0 is the healthy number.
2. If it fixes upstream, open it upstream as an issue and a pull request from a topic branch against their `main`, and backport it onto the pin on its own branch here.
3. Add it to the manifest with its upstream number, the behaviour it exists for, and the tests that prove it, so its status is a lookup rather than a memory.
4. Run the chain. A patch is accepted on its behaviour, never on its diff being present.

## Carried and left to upstream

`sync` writes a decision line for every commit it replays. A commit is skipped when replaying it produces an empty change, which means upstream already has it, and a conflict is resolved in our favour only where upstream's copy does not already contain the change.
