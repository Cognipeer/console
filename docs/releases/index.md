# Release Notes

What shipped, when, and whether it affects you.

Every entry here is written from the release tags themselves, so the dates are
the dates the build actually went out — not the dates the work started.

## Two release channels

Console ships as two editions from two tag sequences.

| Channel | Tag format | What it is |
| --- | --- | --- |
| **Community** | `vX.Y.Z-community` | The open-source edition, AGPL-3.0. Everything in the core platform. |
| **Enterprise** | `vX.Y.Z-saas` | The community edition plus the enterprise modules layered on top. |

The order is fixed: **community is released first, and the enterprise build is
layered onto an already-released community tag.** An enterprise release never
picks up community work that only exists in a branch. If you are cutting a
release yourself, [Releasing](/guide/releasing) is the runbook.

The practical consequence for readers: when a change is listed under a community
release, enterprise installations get it too — in the next enterprise release
that pins that community tag or a later one. Changes listed under an enterprise
release stay enterprise-only.

## Reading the version numbers

Two things about the numbering are worth knowing before you go looking for a
version that does not exist.

**The community edition renumbered once.** Its first public release was
`v1.0.0-community` (June 2026). After that it stopped keeping its own count and
adopted the platform's version line, resuming at `v1.2.14-community`. There is
no `v1.1.x-community`; those numbers were never used.

**The enterprise sequence is independent.** It ran from `v1.0.1-saas` through
`v1.0.81-saas` on its own count, then aligned onto the platform line at
`v1.2.20-saas`. An enterprise version number does not tell you which community
version it contains — the compatibility pin shipped with each build does.

## Where to look

| Page | Covers |
| --- | --- |
| [1.2 line](/releases/1.2) | June 2026 – present. Agent Sandbox, the open-source split, tenant isolation, Web Search, MCP Hubs, Cost & Optimization. |
| [1.1 line](/releases/1.1) | May – June 2026. Audio and OCR, the design system, container hardening. |
| [1.0 line](/releases/1.0) | April – May 2026. Browser automation, the crawler, PII and reranking, agent tracing. |
| [Enterprise releases](/releases/enterprise) | The `-saas` sequence: LDAP/SSO, realtime voice, Agent Sandbox, GPU Fleet, Aegis, Cost & Optimization. |

## Scope of these notes

These pages document **what changed in the product**. They deliberately leave out
build pipeline internals, deployment environments and release automation — those
belong in internal operations documentation, not in a public changelog. Release
tags that only carried packaging or CI changes are folded into the nearest
feature release and called out as such, rather than being listed as if something
shipped.

::: tip Looking for the old changelog?
The previous `Changelog` page described the community edition's original
`1.0.0`/`1.1.0` numbering, which was retired when the edition adopted the
platform version line. Its content is preserved in the
[1.0 line](/releases/1.0#community-edition) entry for the initial open-source
release.
:::
