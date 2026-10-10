# Patches we carry

Each entry names the upstream PR, the branch in `azuretek/openclaw`, and what it does. The manifest is the
machine-readable copy; this file is the human one.

| #   | Upstream | Branch                                         | Subject                                                           |
| --- | -------- | ---------------------------------------------- | ----------------------------------------------------------------- |
| 1   | #155959  | `fix/sqlite-snapshot-staging-reuse`            | read-only state snapshots reuse one staging directory             |
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

## Carried and left-to-upstream

Measured while assembling the first Núcleo branch against `v2026.9.8`: the twelve branches hold **161 commits**
between them, and a large share of those are **already upstream**, so the policy skips them rather than carrying
duplicates. `sync` writes a decision line for every commit it processes, and `verify` reports how many commits
of each patch were carried versus left to upstream.

A commit is skipped when replaying it produces an empty change, which means upstream already has it. A conflict
is resolved in our favour only where upstream's copy does not already contain the change.
