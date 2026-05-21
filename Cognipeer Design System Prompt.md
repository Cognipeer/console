# Cognipeer Design System — Reusable Prompt

> Copy-paste this entire document as a system prompt / context block into any AI design tool (Claude, ChatGPT, Cursor, etc.) before asking it to design a page, slide, prototype, or app. It encodes the full visual language of the Cognipeer developer site so the output stays on-brand across projects.

---

## 1. Design Philosophy

You are designing in the **Cognipeer** visual language: a **premium developer-docs aesthetic** that signals open infrastructure for serious AI work. The tone is:

- **Calm, confident, technical.** Not playful, not corporate-stiff. Think Linear / Vercel / Stripe docs, but with a teal-forward identity.
- **Editorial over decorative.** Generous whitespace, clear typographic hierarchy, hairline borders instead of heavy chrome. Letterspacing is tight on headings (`-0.02em` to `-0.03em`).
- **Monospace as a structural element.** Eyebrow labels, metadata, package names, code chips, terminal cards — all use JetBrains Mono. It earns trust by reading like real source.
- **Color used sparingly.** The teal accent is a punctuation mark, not a wash. Most surface area is off-white (`#fbfbfa`) or near-black (`#0a0e13`), with the accent reserved for active states, dots, eyebrows, and key CTAs.
- **No AI slop.** No gradient blobs everywhere, no emoji, no purple-and-pink hero, no SVG illustrations made of generic shapes. Iconography is line-style 1.8 stroke SVG. Imagery is restrained.

**Forbidden tropes:** rainbow gradients, glassmorphism overload, "AI-generated" floating orbs, oversized stat counters with confetti, hero sections with 5 CTAs, marketing-deck pictograms, decorative emoji, left-border-accent containers.

---

## 2. Color Tokens

Every color comes from this token set. **Never hardcode raw hex values in components — always use `var(--token)`.** Both themes ship together; pick by setting `data-theme="light"` or `data-theme="dark"` on `<html>`.

### Brand teal scale (shared)
```css
--teal-50:  #ecfdf6;
--teal-100: #d1faea;
--teal-200: #a4f3d5;
--teal-300: #6ce7bc;
--teal-400: #2fd49e;
--teal-500: #0fba94;   /* accent (default) */
--teal-600: #0a9978;   /* accent-strong */
--teal-700: #0a7b62;
--teal-800: #0b6151;
--teal-900: #0a4a40;
```

### Light theme (default)
```css
--bg:            #fbfbfa;     /* page */
--bg-elev:       #ffffff;     /* cards, nav, code-card head */
--bg-soft:       #f4f4f1;     /* chips, hover wash, soft fills */
--bg-code:       #0f1419;     /* terminal/code surfaces */
--bg-code-text:  #e6edf3;

--border:        #e8e8e3;
--border-strong: #d9d9d2;
--hairline:      #efefea;     /* dividers, table rows */

--text:          #0c1118;
--text-soft:     #4a5260;     /* body */
--text-muted:    #6b7280;     /* meta, captions */
--text-faint:    #98a1ad;

--accent:        var(--teal-500);
--accent-strong: var(--teal-600);
--accent-soft:   var(--teal-50);
--link:          var(--accent-strong);

--grid-line:     rgba(15,186,148,.06);
```

### Dark theme
```css
--bg:            #0a0e13;
--bg-elev:       #11161d;
--bg-soft:       #161c24;
--bg-code:       #060a0f;
--bg-code-text:  #d5dde6;

--border:        #1d242d;
--border-strong: #2a323d;
--hairline:      #181e26;

--text:          #ecf1f6;
--text-soft:     #b4bcc7;
--text-muted:    #8a939f;
--text-faint:    #5a6473;

--accent-soft:   rgba(15,186,148,.10);
--link:          var(--teal-300);
--grid-line:     rgba(15,186,148,.08);
```

### Secondary accents (use sparingly, never inventing new hues)
- **Indigo (SDK / runtime)** `#6957ff` — second-flagship accent. Light-on-dark: `#a99dff`.
- **Amber (in-progress / warnings)** `#f0b86c` background, `#c87b15` light text, `#f0b86c` dark text.
- **Orange (runtime category)** `#d97746`, dark `#f0b389`.

### Shadows (light)
```css
--shadow-sm: 0 1px 0 rgba(20,30,40,.04), 0 1px 2px rgba(20,30,40,.04);
--shadow-md: 0 4px 12px rgba(20,30,40,.06), 0 1px 2px rgba(20,30,40,.04);
--shadow-lg: 0 24px 48px -16px rgba(20,30,40,.18), 0 2px 8px rgba(20,30,40,.06);
```

### Selection
```css
::selection { background: var(--teal-200); color: #062a23; }
[data-theme="dark"] ::selection { background: var(--teal-700); color: #e8fff7; }
```

---

## 3. Typography

```css
--font-sans: "Lexend Deca", ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
--font-mono: "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
```

Load both from Google Fonts:
```html
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Lexend+Deca:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">
```

### Body
- `font-size: 15.5px`, `line-height: 1.55`, `font-weight: 400`, `letter-spacing: -0.005em`.
- Body color: `var(--text-soft)`. Headings: `var(--text)`.

### Scale
| Element | Size | Weight | Tracking | Notes |
|---|---|---|---|---|
| `h1` | `clamp(40px, 5.5vw, 64px)` | **500** | `-0.03em` | line-height 1.04, `text-wrap: balance` |
| `h2` | `clamp(28px, 3.6vw, 40px)` | **500** | `-0.02em` | line-height 1.12 |
| `h3` | `20px` | 600 | `-0.02em` | line-height 1.35 |
| `h4` | `15px` | 600 | `-0.02em` | line-height 1.4 |
| Section `h2` (in-section) | `clamp(28px, 3.4vw, 38px)` | **500** | | |
| Product hero `h1` | `clamp(32px, 4vw, 44px)` | 500 | | |
| Article hero `h1` | `clamp(36px, 4.5vw, 52px)` | 500 | line-height 1.08 |

**Heading rule:** display weight is **500**, not 700. Body weight is **400**. Bold text inside paragraphs is also 500 (never 700) — bold reads as a subtle emphasis, not a shout.

### Eyebrow (the signature label)
A small monospace uppercase label used above every section heading and as section breadcrumbs.
```css
.eyebrow {
  display: inline-flex; align-items: center; gap: 8px;
  font-family: var(--font-mono);
  font-size: 11.5px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--text-muted);
  font-weight: 500;
}
.eyebrow::before {
  content: "";
  width: 6px; height: 6px;
  border-radius: 50%;
  background: var(--accent);
  box-shadow: 0 0 0 4px var(--accent-soft);
}
.eyebrow.plain::before { display: none; }
```

Use it everywhere: hero kicker, section kickers, "Flagship · Control plane" labels, metadata strips. The teal dot is the brand's most-repeated graphic element.

---

## 4. Spacing, Radii, Layout

### Radii
```css
--r-xs: 6px;   --r-sm: 8px;    --r-md: 10px;
--r-lg: 14px;  --r-xl: 18px;   --r-2xl: 22px;
```
- Cards: `--r-md` or `--r-lg`.
- Flagship/hero cards: `--r-xl`.
- Pills, buttons, chips: `999px` (fully rounded).

### Container
```css
--maxw: 1200px;
--pad-x: clamp(20px, 4vw, 40px);
.container { max-width: var(--maxw); margin: 0 auto; padding: 0 var(--pad-x); }
```

### Section padding (density-aware)
```css
[data-density="compact"] { --pad-section-y: 64px; }
[data-density="default"] { --pad-section-y: 96px; }
[data-density="airy"]    { --pad-section-y: 128px; }
:root { --pad-section-y: 96px; }

section.section { padding: var(--pad-section-y) 0; }
.section-head { margin-bottom: 48px; max-width: 720px; }
.section-head .eyebrow { margin-bottom: 16px; }
.section-head p { margin-top: 14px; font-size: 16px; color: var(--text-soft); max-width: 600px; }
```

### Easing
```css
--ease: cubic-bezier(.2, .7, .2, 1);
```
All hover transitions use `.15s–.25s var(--ease)`. Never use the browser default ease.

---

## 5. Component Patterns

### 5.1 Buttons
Pill-shaped. Three variants. Two sizes besides default.
```css
.btn {
  --bh: 40px;
  height: var(--bh);
  display: inline-flex; align-items: center; gap: 8px;
  padding: 0 16px;
  border-radius: 999px;
  font: 500 14px/1 var(--font-sans);
  letter-spacing: -0.005em;
  border: 1px solid transparent;
  transition: all .18s var(--ease);
  cursor: pointer; white-space: nowrap; text-decoration: none;
}
.btn svg { width: 14px; height: 14px; }

.btn-primary { background: var(--text); color: var(--bg); border-color: var(--text); }
.btn-primary:hover { transform: translateY(-1px); }
/* dark mode flips primary to near-white */

.btn-accent  { background: var(--accent); color: #062a23; border-color: var(--accent); }
.btn-accent:hover { background: var(--accent-strong); transform: translateY(-1px); }

.btn-ghost   { background: transparent; color: var(--text); border-color: var(--border-strong); }
.btn-ghost:hover { border-color: var(--text); }

.btn-sm { --bh: 32px; font-size: 13px; padding: 0 12px; }
.btn-lg { --bh: 46px; font-size: 14.5px; padding: 0 20px; }
```

**Pattern:** primary CTA in hero is `.btn-lg.btn-primary`, secondary is `.btn-lg.btn-ghost`. Use `.btn-accent` (teal) for in-product / dashboard-style CTAs, not marketing CTAs.

### 5.2 Chips
```css
.chip {
  display: inline-flex; align-items: center; gap: 6px;
  height: 24px; padding: 0 10px;
  border-radius: 999px;
  background: var(--chip-bg);          /* --bg-soft */
  color: var(--chip-text);             /* --text-soft variant */
  border: 1px solid var(--chip-border);
  font: 500 12px var(--font-mono);
  letter-spacing: 0.01em;
}
.chip.accent {
  background: var(--accent-soft);
  color: var(--accent-strong);
  border-color: rgba(15,186,148,.20);
}
```
Use chips for: tech stack labels under cards, recipe tags, package badges.

### 5.3 Card patterns

**Flagship card** (large product hero card):
- `padding: 36px`, `border-radius: var(--r-xl)`, `background: var(--bg-elev)`.
- Subtle radial gradient overlay top-right corner using `--accent-soft` (or indigo for secondary flagship).
- Top-right corner: small arrow icon (`↗`) at `top:36px; right:36px`.
- Hover: `border-color: var(--text)` and `transform: translateY(-2px)`.

**Product card** (grid item):
- Grid uses `gap: 1px; background: var(--hairline)` to draw hairline separators between cells.
- Card surface `var(--bg-elev)`; hover swaps to `var(--bg)`.
- 36×36 icon tile with `--accent-soft` background, accent-strong color.
- Heading 17px/500. Meta in mono 12px muted. Description 13.5px soft.
- Bottom row: dashed `border-top: 1px dashed var(--hairline)`, mono package name with `#` icon.

**Use-case / recipe card:**
- 22px padding, `--r-md`, `var(--bg-elev)`.
- Mono uppercase meta row at top, 17px/500 heading, 13.5px description, tags row at bottom.
- Hover: `transform: translateY(-2px)` and a subtle arrow appears bottom-right.

### 5.4 Code surfaces (the brand's hero element)

**Inline code:**
```css
code {
  background: var(--bg-soft);
  padding: 1px 6px;
  border-radius: 4px;
  font-size: 12.5px;
  border: 1px solid var(--hairline);
  color: var(--text);
  font-family: var(--font-mono);
}
```

**Code card (terminal):** dark surface even in light mode. Header bar with tabs, body with `$` prompt, optional copy button.
```css
.code-card {
  background: var(--bg-elev);
  border: 1px solid var(--border);
  border-radius: var(--r-lg);
  box-shadow: var(--shadow-md);
  overflow: hidden;
  font: 13px var(--font-mono);
}
.code-card-head { display:flex; align-items:center; border-bottom:1px solid var(--hairline); padding:0 6px; }
.code-tab { padding:10px 12px; font-size:12px; color:var(--text-muted); border-bottom:2px solid transparent; background:transparent; border-top:0; border-left:0; border-right:0; }
.code-tab.active { color:var(--text); border-bottom-color:var(--accent); }
.code-card-body {
  background: var(--bg-code);
  color: var(--bg-code-text);
  padding: 16px 18px;
  display: flex; align-items: center; gap: 12px;
  min-height: 56px;
}
.code-card-body .prompt { color: var(--teal-400); user-select: none; }
.code-card-body .pkg    { color: #f0b86c; }
```

**Multi-line code block** (with line numbers):
```css
.code-block {
  background: var(--bg-code); color: var(--bg-code-text);
  border-radius: var(--r-md);
  padding: 20px 22px;
  font: 12.5px/1.65 var(--font-mono);
  border: 1px solid var(--border);
}
.code-block .line-num { color: rgba(255,255,255,0.18); width:28px; display:inline-block; user-select:none; }
.code-block .cb-kw   { color: #ff7b9c; }   /* keywords */
.code-block .cb-fn   { color: var(--teal-400); }
.code-block .cb-str  { color: #a5d6a4; }
.code-block .cb-key  { color: #79c0ff; }
.code-block .cb-prop { color: #d2a8ff; }
.code-block .cb-num  { color: #f0b86c; }
.code-block .cb-com  { color: #6e8a92; font-style: italic; }
```

### 5.5 Sticky nav
- `height: 60px`, `position: sticky; top: 0`, blurred background via `color-mix(in srgb, var(--bg) 80%, transparent)` + `backdrop-filter: saturate(180%) blur(12px)`.
- Bottom border `1px solid var(--hairline)`.
- Logo (22×22 dot-cluster SVG) + product name + mono "tag" badge.
- Nav links: 13.5px, soft color, active link gets a 2px teal underline pinned 16px below.

### 5.6 Hero
- Padding `clamp(60px,10vw,120px) 0 var(--pad-section-y)`.
- Two-column grid (`1.1fr .9fr`, gap 80px) — left: copy & CTAs, right: code/terminal card.
- Background: radial gradient `ellipse 80% 40% at 50% 0%` of `--accent-soft` + a 48px grid (using `--grid-line`) masked by a radial gradient.
- H1 uses an accent span with a clipped teal gradient (`linear-gradient(135deg, var(--teal-500), var(--teal-700))`).

### 5.7 Impact band (stat row)
- 4-column grid, hairline dividers between cells, no gap.
- Each cell: mono uppercase label · big 28–36px number with optional small "unit" sub-text · 12.5px muted sub.
- Background: `var(--bg-elev)` with top + bottom hairline borders.

### 5.8 Logo wall (industries / clients)
- 28px padding band, hairline top/bottom.
- Left: mono uppercase label. Right: row of plain text labels separated by `·`, 15px/500, opacity .7 — **no logo images**.

### 5.9 Roadmap lanes
- 3-column grid of cards, each with a colored mono pill (live / next / soon), a heading, and a list of items with circular check icons. Completed items get a teal-filled check with a small checkmark drawn via CSS rotated borders.

### 5.10 Changelog
- Two-column inside the section: 300px label column / 1fr items.
- Each item: mono date + uppercase mono tag in accent color + 18px/500 title + 14px soft body. Hairline divider top.

---

## 6. Iconography

- **All icons are line-style SVG, stroke 1.8, stroke-linecap/linejoin round, no fills.** 24×24 viewBox is default; 16×16 for inline / button icons.
- Custom set, drawn fresh — never use generic Material/Heroicons in their default form unless restyled to match.
- Logo: a six-circle constellation (one large center dot + concentric ring of smaller dots at decreasing opacities). Treat it as the only piece of "art" in the system.
- Icons inside cards live in a 36×36 rounded tile (`--r-sm`) with `--accent-soft` background and `--accent-strong` color.

---

## 7. Animation & Interaction

- **One easing:** `cubic-bezier(.2,.7,.2,1)`.
- Card hover: `translateY(-1px)` to `-2px`, plus a border-color upgrade to `var(--text)` (light) or `var(--teal-400)` (dark).
- Buttons lift `translateY(-1px)` on hover.
- Live dot: 6px teal circle pulsing opacity .4 ↔ 1 on a 2s loop.
- Arrows ("↗") that sit on cards translate `(4px, -4px)` and fade `.5 → 1` on hover.
- No bounces, no spring, no parallax. Movement is short and decelerated.

---

## 8. Layout Patterns

- **Sections alternate surface tone:** plain `--bg` for one, `--bg-elev` with hairline top+bottom borders for the next. Never two adjacent sections at the same elevation.
- **Section header always reads:** small eyebrow → `h2` (display weight 500) → short paragraph (max-width 600px, `text-soft`).
- **Right-aligned controls:** filter tabs and "All →" links live on the right of the section header in a wrap-flex row.
- **Grids:** product cards = 3-up (2-up at 940, 1-up at 640). Use cases = 3-up. Roadmap = 3-up. Flagships = 2-up. Impact = 4-up (2×2 at 820).
- **Docs shell:** `240px / 1fr / 220px` with sticky left sidebar (sections) and sticky right TOC. TOC active state = 2px teal left border on the link.

---

## 9. Voice & Copy

- Sentence case for everything except mono uppercase labels (eyebrows, meta, tags).
- Headings are statements, not features ("Two products carry the platform." not "Our Products").
- Body paragraphs stay under ~3 sentences. Never marketing-speak ("revolutionary", "game-changing").
- Mono is used for: package names (`@cognipeer/agent-sdk`), commands (`npm install`), file paths, identifiers, metadata labels, version strings, dates in changelog.

---

## 10. Tweaks panel (when designing interactively)

Expose: **Theme** (Light / Dark), **Accent** (curated swatches: `#0fba94`, `#6957ff`, `#d97746`, `#e11d6b`, `#0ea5e9`), **Density** (Compact / Default / Airy).
Apply by setting `data-theme`, `data-density` on `<html>` and overriding `--accent`, `--accent-strong`.

---

## 11. Quick Checklist (use before shipping any screen)

- [ ] Page uses Lexend Deca for sans and JetBrains Mono for mono — nothing else.
- [ ] Every color came from a `var(--*)` token, never a literal hex.
- [ ] Each section has an eyebrow + display-500 heading + soft paragraph.
- [ ] No emoji. No gradient blobs. No purple-pink hero. No oversized icons.
- [ ] Card hover lifts -1/-2px, border upgrades, transition uses `--ease`.
- [ ] At least one piece of mono used per section (label, meta, chip, package).
- [ ] Dark theme tested — and the teal accent shifts to `--teal-300/400` where it sat against light surfaces.
- [ ] Headings respect `text-wrap: balance` and `letter-spacing: -0.02em` (or -0.03em for h1).
- [ ] Buttons are pill-shaped, no rectangular CTAs.

---

## 12. Drop-in CSS Starter

When you need to bootstrap a new project, copy this minimal block:

```html
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Lexend+Deca:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">
<style>
:root {
  --teal-50:#ecfdf6; --teal-100:#d1faea; --teal-200:#a4f3d5; --teal-300:#6ce7bc;
  --teal-400:#2fd49e; --teal-500:#0fba94; --teal-600:#0a9978; --teal-700:#0a7b62;
  --teal-800:#0b6151; --teal-900:#0a4a40;
  --accent:var(--teal-500); --accent-strong:var(--teal-600); --accent-soft:var(--teal-50);
  --font-sans:"Lexend Deca",ui-sans-serif,system-ui,sans-serif;
  --font-mono:"JetBrains Mono",ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  --r-xs:6px; --r-sm:8px; --r-md:10px; --r-lg:14px; --r-xl:18px; --r-2xl:22px;
  --maxw:1200px; --pad-x:clamp(20px,4vw,40px);
  --ease:cubic-bezier(.2,.7,.2,1);
  --pad-section-y:96px;
}
[data-theme="light"], :root {
  --bg:#fbfbfa; --bg-elev:#fff; --bg-soft:#f4f4f1; --bg-code:#0f1419; --bg-code-text:#e6edf3;
  --border:#e8e8e3; --border-strong:#d9d9d2; --hairline:#efefea;
  --text:#0c1118; --text-soft:#4a5260; --text-muted:#6b7280; --text-faint:#98a1ad;
  --link:var(--accent-strong);
  --chip-bg:#f4f4f1; --chip-text:#525a66; --chip-border:#e2e2dc;
  --shadow-sm:0 1px 0 rgba(20,30,40,.04),0 1px 2px rgba(20,30,40,.04);
  --shadow-md:0 4px 12px rgba(20,30,40,.06),0 1px 2px rgba(20,30,40,.04);
  --shadow-lg:0 24px 48px -16px rgba(20,30,40,.18),0 2px 8px rgba(20,30,40,.06);
  --grid-line:rgba(15,186,148,.06);
}
[data-theme="dark"] {
  --bg:#0a0e13; --bg-elev:#11161d; --bg-soft:#161c24; --bg-code:#060a0f; --bg-code-text:#d5dde6;
  --border:#1d242d; --border-strong:#2a323d; --hairline:#181e26;
  --text:#ecf1f6; --text-soft:#b4bcc7; --text-muted:#8a939f; --text-faint:#5a6473;
  --link:var(--teal-300); --accent-soft:rgba(15,186,148,.10);
  --chip-bg:#161c24; --chip-text:#b8c0cc; --chip-border:#232a34;
  --shadow-sm:0 1px 0 rgba(0,0,0,.4);
  --shadow-md:0 4px 16px rgba(0,0,0,.35);
  --shadow-lg:0 24px 48px -16px rgba(0,0,0,.55);
  --grid-line:rgba(15,186,148,.08);
}
*,*::before,*::after{box-sizing:border-box;}
html,body{margin:0;padding:0;}
body{
  font-family:var(--font-sans); background:var(--bg); color:var(--text);
  font-size:15.5px; line-height:1.55; font-weight:400; letter-spacing:-0.005em;
  -webkit-font-smoothing:antialiased;
}
h1,h2,h3,h4{margin:0; color:var(--text); letter-spacing:-0.02em; text-wrap:balance;}
h1{font-size:clamp(40px,5.5vw,64px); line-height:1.04; letter-spacing:-0.03em; font-weight:500;}
h2{font-size:clamp(28px,3.6vw,40px); line-height:1.12; font-weight:500;}
h3{font-size:20px; line-height:1.35; font-weight:600;}
p{margin:0; color:var(--text-soft);}
a{color:var(--link); text-decoration:none;}
.container{max-width:var(--maxw); margin:0 auto; padding:0 var(--pad-x);}
.eyebrow{
  display:inline-flex; align-items:center; gap:8px;
  font:500 11.5px var(--font-mono); text-transform:uppercase; letter-spacing:0.08em;
  color:var(--text-muted);
}
.eyebrow::before{
  content:""; width:6px; height:6px; border-radius:50%;
  background:var(--accent); box-shadow:0 0 0 4px var(--accent-soft);
}
.btn{
  --bh:40px; height:var(--bh);
  display:inline-flex; align-items:center; gap:8px;
  padding:0 16px; border-radius:999px;
  font:500 14px/1 var(--font-sans); letter-spacing:-0.005em;
  border:1px solid transparent; cursor:pointer; text-decoration:none; white-space:nowrap;
  transition:all .18s var(--ease);
}
.btn-primary{background:var(--text); color:var(--bg); border-color:var(--text);}
.btn-primary:hover{transform:translateY(-1px);}
.btn-ghost{background:transparent; color:var(--text); border-color:var(--border-strong);}
.btn-ghost:hover{border-color:var(--text);}
.btn-lg{--bh:46px; font-size:14.5px; padding:0 20px;}
.chip{
  display:inline-flex; align-items:center; gap:6px;
  height:24px; padding:0 10px; border-radius:999px;
  background:var(--chip-bg); color:var(--chip-text); border:1px solid var(--chip-border);
  font:500 12px var(--font-mono); letter-spacing:0.01em;
}
section.section{padding:var(--pad-section-y) 0;}
.section-head{margin-bottom:48px; max-width:720px;}
.section-head .eyebrow{margin-bottom:16px;}
.section-head p{margin-top:14px; font-size:16px; color:var(--text-soft); max-width:600px;}
</style>
```

---

**End of design system prompt.** When using this with an AI tool, finish your message with the actual task (e.g. "Now design a pricing page using this system" or "Build a landing for X product following this exact aesthetic").
