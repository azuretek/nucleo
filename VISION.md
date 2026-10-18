# Vision

Núcleo is OpenClaw for people who want an assistant platform they can depend on every day, on whatever hardware they have.

## Where we are going

**A fast, lean core.** OpenClaw moves quickly and grows with it. Núcleo takes its releases and makes them lighter: quicker to start, smaller in memory and CPU at rest, and less work per request. The bar is a gateway that runs well on an old laptop, a spare mini PC, or a Raspberry Pi, not only on a workstation.

**One client on every device.** [Chela](https://github.com/azuretek/chela) is the client we build for, on iOS, Android, desktop and the web. It is built on OpenClaw's Control UI, and the Control UI stays the base everywhere, so a feature lands on every platform at once instead of being rebuilt per platform.

**A good place to write code.** Working on code with an agent (writing it, running it, reviewing it, following long jobs and steering them) is a primary use, and the interface is shaped around it on every device.

**Stable between upgrades.** People run this across their phones, laptops and servers, and it has to keep working when they are not watching it. We take upstream one release at a time, carry our changes as a gated patch series, and ship nothing that has not passed.

## How we get there

- **Measure, then change.** Performance claims carry numbers, taken on small hardware as well as large, and the gate keeps them from regressing.
- **Diverge where it pays, stay mergeable everywhere else.** A lighter way to do the same job is reason enough to carry a patch. Everything else stays as close to upstream as we can keep it, so each new release merges cleanly.
- **Give back.** A fix upstream would want goes upstream, after it has shipped here.

## What we are not doing

- **Not a rewrite.** The source stays OpenClaw. We change what we need to and carry it as patches.
- **Not tracking upstream `main`.** We build on releases, never on work in progress.
- **Not a multi-tenant service.** Like OpenClaw, a gateway serves trusted operators on their own hardware.
- **Not separate native interfaces per platform.** One interface, Chela on the Control UI, everywhere.
