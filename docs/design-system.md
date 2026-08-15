# Cognipeer Design System

Console's `--ds-*` token values, defined in `src/theme/`, are the canonical source. The rules below
summarise how they are meant to be used; when the two disagree, the token definitions win.

Core rules:
- Accent teal `#0fba94` (strong `#0a9978`); page `#fbfbfa` light / `#0a0e13` dark; never pure `#000`.
- All colors via `var(--token)`; raw hex only in token definitions.
- Lexend Deca (display weight 500, never 700) + JetBrains Mono; eyebrow = mono 11.5px uppercase with teal dot.
- Semantic status colors: ok `#0a9978`, warn `#c87b15`, err `#c93b3b`, info `#2a6fdb`.
- Auth/landing primary CTA = black pill (`background: var(--text)`, radius 999); in-app primaries stay teal with white (`--accent-fg: #ffffff`) foreground — `#062a23` only on pale teal washes (::selection).
- Buttons/chips are pills (radius 999); cards use hairline borders, radius 10-14; one easing `cubic-bezier(.2,.7,.2,1)`.
- 22px teal dot-grid is the auth/landing background signature; in-app surfaces stay plain.
