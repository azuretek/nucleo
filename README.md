# Núcleo

Núcleo is a faster, leaner distribution of [OpenClaw](https://github.com/openclaw/openclaw), the self-hosted AI assistant gateway. It takes an official OpenClaw release, carries our own fixes and performance work on top, builds its own container image, and ships nothing that has not passed its own gate.

You run it as `nucleo`, from the `nucleo-gateway` image. Inside, it is OpenClaw: the configuration, environment variables, plugins and client protocol are upstream's, so OpenClaw clients, plugins and documentation work unchanged.

## Goals

- **Faster and more efficient than stock OpenClaw.** Quicker startup, less memory and CPU at rest, and less work per request. Performance work is a first-class reason to carry a patch, not only bug fixes.
- **Chela is the client.** [Chela](https://github.com/azuretek/chela) is the client we build for and test against, on iOS, Android, desktop and the web. It is built on OpenClaw's Control UI, and the Control UI stays the base on every platform, so one interface works the same everywhere.
- **A good interface for coding.** Writing, running and reviewing code with an agent is a primary use case, and the interface is built for it: readable diffs, tool output and long-running work you can follow and steer, on any device.
- **Deploy anywhere, including older hardware.** Núcleo should be easy to deploy onto whatever you already own, from an old laptop or a spare mini PC to a Raspberry Pi, and stay responsive there.
- **Run a known thing.** Every image names the upstream release it is built on and every patch it carries, and can be rebuilt from this repository alone.
- **Ship fixes without waiting.** A fix we need runs here as soon as it passes the gate. Fixes that belong upstream also go there as an issue and a pull request, and we drop our copy once upstream releases it.

## Design principles

Where Núcleo deliberately differs from upstream:

- **Stability over the newest thing.** Upstream moves fast and ships features constantly. We pin an upstream release, never upstream `main`, move the pin one release at a time, and gate every change. A platform people rely on across their devices has to keep working between upgrades.
- **Small and older hardware is a target, not an afterthought.** The gateway should run well on older machines and on hardware as small as a Raspberry Pi. A change that grows memory, disk or startup time has to justify the cost, and a lighter way to do the same thing is a reason to diverge from upstream.
- **Performance is measured, not assumed.** A performance patch carries the measurement that justifies it, and the gate keeps it from regressing.
- **One client, every device.** We build for Chela on top of the Control UI rather than maintaining separate native interfaces, so a feature lands on every platform at once.
- **Stay mergeable.** The source stays OpenClaw so every upstream release merges cleanly. Only what you see from outside, the command, the image and the releases, is called Núcleo.
- **Test what we change.** Upstream tests every release before publishing it. Our gate runs upstream's checks plus each carried patch's own tests, and we never edit or weaken upstream's tests to get a green.

## How a build is made

1. **Pin.** `distro/nucleo.json` names the upstream release and every patch we carry, with its upstream issue or pull request and the tests that prove it.
2. **Assemble.** `main` is rebuilt as the pinned release plus each patch in order. Where upstream already solved a problem, upstream's version wins and our change is dropped.
3. **Gate.** Upstream's `check`, then each patch's own tests. A red step stops the chain.
4. **Image.** The image is built from the gated commit. A failed image build also stops the chain.
5. **Release.** A green chain publishes a dev pre-release. A full release is cut by hand.

`distro/docs/DISTRO.md` is the whole procedure, and `distro/docs/DESIGN.md` explains why it is built this way.

## Versions and releases

Núcleo has its own semver version, separate from upstream's.

- **Dev builds** are `v<version>-dev.<build>.<sha>`, published as GitHub pre-releases. The ten newest are kept; older ones and their tags are deleted.
- **Releases** are `v<version>`, cut on a green `main`.
- **Images** are `nucleo-gateway:<version>-dev.<build>` and `nucleo-gateway:<version>`. Pin a version or digest in production, never `latest`.

`distro/docs/RELEASE.md` has the details.

## Patches we carry

`distro/docs/PATCHES.md` lists every patch, its upstream status and the behaviour it exists for. A fix leaves the series once the upstream release we pin includes it. Performance work that upstream does not want stays here on purpose.

## Contributing

Changes to Núcleo land as pull requests with an issue, conventional commits, and a green `distro.yml`. A bug in OpenClaw itself goes upstream first. See `distro/docs/CONTRIBUTING.md`.

## Issues

Report problems with Núcleo here. Problems that reproduce on stock OpenClaw belong upstream at [openclaw/openclaw](https://github.com/openclaw/openclaw/issues).

## License

MIT, the same as OpenClaw. OpenClaw is the work of its authors and contributors; Núcleo adds a patch series and a build around it.
