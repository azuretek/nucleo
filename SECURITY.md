# Security

## Reporting a vulnerability

**Report it privately** through GitHub's private vulnerability reporting on this repository: the **Security** tab, then **Report a vulnerability**. Do not open a public issue or pull request for it.

Include the Núcleo version (`nucleo --version`, or the image tag), what you did, what happened, and what an attacker gains. A report with a reproduction is triaged first.

We aim to acknowledge a report within a week. A confirmed fix ships as a patch in the next dev build, and the advisory is published once a fixed build exists.

## Which project it belongs to

- **A Núcleo patch, our tooling or our image**: report it here.
- **OpenClaw itself**, reproducible on a stock OpenClaw release: report it here and to [OpenClaw](https://github.com/openclaw/openclaw/security). We carry a fix as soon as one exists, whether or not upstream has shipped it.
- **Chela**, the client: report it to [azuretek/chela](https://github.com/azuretek/chela/security).

If you are not sure, report it here and we will route it.

## Trust model

Núcleo keeps OpenClaw's trust model. A gateway serves trusted operators on hardware they control; it is not a boundary between hostile users who share one gateway. Anyone who can operate an agent can make it do anything that agent can do, so separate trust needs separate agents or separate gateways. Prompt injection on its own, scanner output, and attacks that need a hostile user already trusted on the same gateway are not vulnerabilities under this model.

What Núcleo adds:

- **Every image is built from this repository**, from a pinned upstream release plus the patches in `distro/nucleo.json`, and labelled with the commit and pin it came from. Nothing is pulled from a third-party image.
- **Nothing ships without a green gate** naming that exact commit.
- **`main` and release tags are protected** against force-pushes, deletion and unreviewed changes.

## Supported versions

The newest release and the newest dev build are supported. Fixes are not backported to older builds; upgrade to get them.
