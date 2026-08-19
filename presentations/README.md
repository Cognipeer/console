# Presentations

Deck generators for Cognipeer. Build tooling only — nothing here is part of the
Console application build or runtime.

## Enterprise AI Control Plane (executive deck)

`build-control-plane-deck.mjs` generates
`cognipeer-enterprise-ai-control-plane.pptx` — a 13-slide, 16:9 executive deck
positioning **Console + Agent SDK + Agent Server** as an Enterprise AI Control
Plane (10 main slides, cover, and two appendix slides).

```bash
cd presentations
npm install
npm run build
```

Options (environment variables):

| Variable | Purpose |
| --- | --- |
| `AUDIENCE` | Stamps a `Prepared for …` line on the cover. Omitted by default — this repository is public, so customer names are never committed. |
| `OUT` | Output path for the `.pptx` (default: `./cognipeer-enterprise-ai-control-plane.pptx`). |
| `CONSOLE_ROOT` | Repository root, used to resolve the logos and docs screenshots (default: the parent directory). |

```bash
AUDIENCE="Acme Corp" OUT=/tmp/acme.pptx npm run build
```

## Design

The deck follows the Console design system (`src/theme/theme.ts`,
`src/app/globals.css`, `docs/design-system.md`) rather than a generic
PowerPoint theme:

- accent teal `#0fba94` / strong `#0a9978`, page `#fbfbfa` light and `#0a0e13` dark
- white cards with hairline `#e8e8e3` borders at radius 10–14, pill chips
- JetBrains Mono uppercase eyebrows with a teal dot; Lexend Deca display type
- the 22px teal dot-grid signature on dark (cover, architecture, demo) slides
- Tabler icons — the same icon set the Console UI uses — rendered to PNG at build time
- product screenshots come from `docs/public/screenshots/`

**Fonts:** the deck references *Lexend Deca* and *JetBrains Mono*. Install both
on the presenting machine (both are free on Google Fonts) or PowerPoint will
substitute them; substitutes are narrower, so nothing overflows either way.

## Verifying a build

```bash
python3 ../../.claude/skills/synced/pptx/scripts/office/validate.py cognipeer-enterprise-ai-control-plane.pptx
soffice --headless --convert-to pdf cognipeer-enterprise-ai-control-plane.pptx
```
