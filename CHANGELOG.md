# Changelog

Núcleo's own changes, by version. Each version is an upstream OpenClaw release plus the patches listed. For what changed in OpenClaw itself, see the [OpenClaw releases](https://github.com/openclaw/openclaw/releases).

Dev builds are published as GitHub pre-releases, `v<version>-dev.<build>.<sha>`, and carry the same list for their commit.

## Unreleased (0.0.1)

Based on OpenClaw v2026.9.8.

### Fixes

- Image drafts survive a temporary file disappearing. ([openclaw#163964](https://github.com/openclaw/openclaw/pull/163964))
- Chat messages keep sending after a reconnect instead of stopping until the app is relaunched. ([openclaw#151441](https://github.com/openclaw/openclaw/pull/151441))
- gpt-5.4-nano accepts API keys when the Codex plugin is enabled. ([openclaw#148581](https://github.com/openclaw/openclaw/pull/148581))
- Config validation says why a model reference could not resolve. ([openclaw#144745](https://github.com/openclaw/openclaw/pull/144745))
- Background command completions reach a busy session instead of being lost. ([openclaw#152205](https://github.com/openclaw/openclaw/pull/152205))
- Lobster runs native LLM stages in embedded workflows, and is built into the image. ([openclaw#161344](https://github.com/openclaw/openclaw/pull/161344))
- A retried read-only state snapshot reuses one staging directory. ([openclaw#155959](https://github.com/openclaw/openclaw/pull/155959))
- Session lists no longer stall while the gateway republishes an unchanged config. ([openclaw#155300](https://github.com/openclaw/openclaw/pull/155300))

### Build and tests

- The image build keeps its compile cache between builds.
- Test fixes for slow or flaky upstream tests on loaded hosts. ([openclaw#162160](https://github.com/openclaw/openclaw/pull/162160), [#162144](https://github.com/openclaw/openclaw/pull/162144), [#162132](https://github.com/openclaw/openclaw/pull/162132), [#162126](https://github.com/openclaw/openclaw/pull/162126), [#150246](https://github.com/openclaw/openclaw/pull/150246))
