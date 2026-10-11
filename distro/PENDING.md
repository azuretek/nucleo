# Pending adaptation

The release pin is `v2026.9.8`. Every improvement branch was cut from `main`, which is 3232 commits
past that release, so an off-pin improvement cannot apply to the pin and has to be adapted to it.

## Carried now (apply to the pin as they stand)

- `fix/chat-send-reserved-marker`
- `fix/surface-model-ref-resolution-reason`
- `fix/gateway-startup-health-cold-worker-cache`
- `fix/catalog-startup-phase-trace`
- `fix/subagent-orphan-retry-timer`

## Pending adaptation (seven)

Bases ranged from 862 to 2942 commits past the pin.

- `fix/cron-forced-run-ack-budget` (+5, one file)
- `fix/image-draft-snapshot` (+75, the Chela #143 fix, branch tip `3cb04ea6d88`)
- `fix/sqlite-snapshot-staging-reuse` (+166, expects an `expectedSourceIdentity` parameter the pin does not have)
- `fix/openai-nano-platform-route` (+608)
- `fix/e2e-built-runtime-typed` (+902)
- `fix/lobster-llm-adapter-current` (+2268)
- `fix/exec-completion-steering` (+4276)

## Rule going forward

Cut every improvement branch from the pinned release tag, never from `main`. `sync` reports
`authored_off_pin`, and 0 is the only healthy number.
