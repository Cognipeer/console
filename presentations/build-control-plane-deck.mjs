/**
 * Cognipeer — "Enterprise AI Control Plane" executive deck generator.
 *
 * The deck is styled with the Console design system (src/theme/theme.ts +
 * src/app/globals.css): teal #0fba94 accent, off-white #fbfbfa page, white
 * hairline cards, near-black #0c1118 text, Lexend Deca display + JetBrains
 * Mono eyebrows, pill chips and the teal dot-grid signature on dark slides.
 *
 *   cd presentations && npm install && npm run build
 *
 * Env:
 *   OUT=<path>          output .pptx (default: ./cognipeer-enterprise-ai-control-plane.pptx)
 *   AUDIENCE="Acme Co"  stamps a "Prepared for ..." line on the cover
 *   CONSOLE_ROOT=<path> repo root (for logos + docs screenshots)
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pptxgen from 'pptxgenjs';
import sharp from 'sharp';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.CONSOLE_ROOT || path.resolve(HERE, '..');
const OUT = process.env.OUT || path.join(HERE, 'cognipeer-enterprise-ai-control-plane.pptx');
const AUDIENCE = process.env.AUDIENCE || '';
const TABLER = (() => {
  if (process.env.TABLER_ICONS) return process.env.TABLER_ICONS;
  for (let dir = HERE; ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, 'node_modules', '@tabler', 'icons', 'icons', 'outline');
    if (fs.existsSync(candidate)) return candidate;
    if (dir === path.dirname(dir)) break;
  }
  throw new Error('@tabler/icons not installed — run `npm install` in presentations/');
})();
const SHOTS = path.join(ROOT, 'docs', 'public', 'screenshots');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cognipeer-deck-'));

/* ---------------------------------------------------------------- tokens */

const C = {
  accent: '0FBA94',
  accentStrong: '0A9978',
  accentSoft: 'ECFDF6',
  accentLine: 'A4F3D5',
  text: '0C1118',
  soft: '4A5260',
  muted: '6B7280',
  faint: '98A1AD',
  page: 'FBFBFA',
  surface: 'FFFFFF',
  wash: 'F7F7F4',
  chip: 'F4F4F1',
  border: 'E8E8E3',
  hairline: 'EFEFEA',
  // dark surfaces
  dPage: '0A0E13',
  dRaised: '11161D',
  dSoft: '161C24',
  dBorder: '1D242D',
  dBorderStrong: '2A323D',
  dText: 'ECF1F6',
  dSoftText: 'B4BCC7',
  dMuted: '8A939F',
  dFaint: '5A6473',
};

const SANS = 'Lexend Deca';
const MONO = 'JetBrains Mono';
const W = 13.333;
const H = 7.5;
const M = 0.72;
const CW = W - 2 * M;

const pres = new pptxgen();
pres.layout = 'LAYOUT_WIDE';
pres.author = 'Cognipeer';
pres.company = 'Cognipeer';
pres.title = 'Cognipeer — Enterprise AI Control Plane';
const SH = pres.ShapeType;

/* ----------------------------------------------------------------- assets */

const iconCache = new Map();
async function icon(name, color, px = 220) {
  const key = `${name}:${color}:${px}`;
  if (iconCache.has(key)) return iconCache.get(key);
  const file = path.join(TABLER, `${name}.svg`);
  if (!fs.existsSync(file)) throw new Error(`Tabler icon not found: ${name}`);
  const svg = fs
    .readFileSync(file, 'utf8')
    .replace(/stroke="currentColor"/g, `stroke="#${color}"`)
    .replace(/width="24"/, `width="${px}"`)
    .replace(/height="24"/, `height="${px}"`)
    .replace(/stroke-width="2"/, 'stroke-width="1.7"');
  const buf = await sharp(Buffer.from(svg), { density: 600 }).resize(px, px).png().toBuffer();
  const data = `image/png;base64,${buf.toString('base64')}`;
  iconCache.set(key, data);
  return data;
}

/** Off-white page wash + faint teal bloom, matching --app-bg. */
async function lightBackground() {
  const out = path.join(TMP, 'bg-light.png');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="900">
    <defs><radialGradient id="g" cx="50%" cy="0%" r="72%">
      <stop offset="0%" stop-color="#ECFDF6" stop-opacity="1"/>
      <stop offset="60%" stop-color="#FBFBFA" stop-opacity="0"/>
    </radialGradient></defs>
    <rect width="1600" height="900" fill="#FBFBFA"/>
    <rect width="1600" height="900" fill="url(#g)"/>
  </svg>`;
  await sharp(Buffer.from(svg)).png({ palette: true, colors: 128, effort: 9 }).toFile(out);
  return out;
}

/** Near-black page with the 22px teal dot-grid signature + soft bloom. */
async function darkBackground() {
  const out = path.join(TMP, 'bg-dark.png');
  const step = 26;
  let dots = '';
  for (let y = step / 2; y < 900; y += step) {
    for (let x = step / 2; x < 1600; x += step) {
      dots += `<circle cx="${x}" cy="${y}" r="1.4"/>`;
    }
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="900">
    <defs><radialGradient id="g" cx="76%" cy="8%" r="70%">
      <stop offset="0%" stop-color="#0FBA94" stop-opacity="0.16"/>
      <stop offset="70%" stop-color="#0A0E13" stop-opacity="0"/>
    </radialGradient></defs>
    <rect width="1600" height="900" fill="#0A0E13"/>
    <g fill="#0FBA94" fill-opacity="0.18">${dots}</g>
    <rect width="1600" height="900" fill="url(#g)"/>
  </svg>`;
  await sharp(Buffer.from(svg)).png({ palette: true, colors: 255, dither: 1, effort: 9 }).toFile(out);
  return out;
}

/** Rounded, hairline-framed product screenshot. */
async function framedShot(rel, { top = 0, height, name, width = 1500 }) {
  const out = path.join(TMP, `${name}.png`);
  const meta = await sharp(path.join(SHOTS, rel)).metadata();
  const cropH = Math.min(height || meta.height, meta.height - top);
  const scaled = await sharp(path.join(SHOTS, rel))
    .extract({ left: 0, top, width: meta.width, height: cropH })
    .resize({ width })
    .toBuffer();
  const { width: w, height: h } = await sharp(scaled).metadata();
  const r = 18;
  const mask = Buffer.from(
    `<svg width="${w}" height="${h}"><rect width="${w}" height="${h}" rx="${r}" ry="${r}" fill="#fff"/></svg>`,
  );
  const stroke = Buffer.from(
    `<svg width="${w}" height="${h}"><rect x="1.5" y="1.5" width="${w - 3}" height="${h - 3}" rx="${r - 1}" fill="none" stroke="#D9D9D2" stroke-width="3"/></svg>`,
  );
  await sharp(scaled)
    .composite([
      { input: mask, blend: 'dest-in' },
      { input: stroke, blend: 'over' },
    ])
    .png({ palette: true, colors: 200, effort: 9 })
    .toFile(out);
  return out;
}

/* -------------------------------------------------------------- primitives */

const shadow = () => ({ type: 'outer', color: '141E28', opacity: 0.07, blur: 12, offset: 1.5, angle: 90 });

function card(s, o) {
  const props = {
    x: o.x,
    y: o.y,
    w: o.w,
    h: o.h,
    fill: { color: o.fill ?? C.surface },
    line: { color: o.line ?? C.border, width: o.lw ?? 1 },
    rectRadius: o.r ?? 0.11,
  };
  if (o.shadow) props.shadow = shadow();
  s.addShape(SH.roundRect, props);
}

function pill(s, o) {
  s.addShape(SH.roundRect, {
    x: o.x,
    y: o.y,
    w: o.w,
    h: o.h,
    fill: { color: o.fill ?? C.chip },
    line: { color: o.line ?? C.border, width: 1 },
    rectRadius: o.h / 2,
  });
  s.addText(o.text, {
    x: o.x + (o.pad ?? 0.22),
    y: o.y,
    w: o.w - 2 * (o.pad ?? 0.22),
    h: o.h,
    fontFace: o.mono ? MONO : SANS,
    fontSize: o.size ?? 10.5,
    color: o.color ?? C.soft,
    align: o.align ?? 'center',
    valign: 'middle',
    margin: 0,
    charSpacing: o.mono ? 0.8 : 0,
  });
}

function txt(s, text, o) {
  s.addText(text, { margin: 0, fontFace: SANS, valign: 'top', ...o });
}

function rule(s, { x, y, w, color = C.border }) {
  s.addShape(SH.rect, { x, y, w, h: 0.011, fill: { color }, line: { width: 0 } });
}

function vrule(s, { x, y, h, color = C.border }) {
  s.addShape(SH.rect, { x, y, w: 0.011, h, fill: { color }, line: { width: 0 } });
}

function eyebrow(s, { x, y, text, dark, color }) {
  s.addShape(SH.ellipse, {
    x,
    y: y + 0.078,
    w: 0.077,
    h: 0.077,
    fill: { color: C.accent },
    line: { width: 0 },
  });
  txt(s, text, {
    x: x + 0.16,
    y,
    w: 7,
    h: 0.23,
    fontFace: MONO,
    fontSize: 9.5,
    charSpacing: 1.5,
    color: color ?? (dark ? C.dMuted : C.muted),
    valign: 'middle',
  });
}

let pageNo = 0;
const TOTAL = 13;

function footer(s, dark) {
  pageNo += 1;
  s.addImage({
    path: path.join(ROOT, 'public', 'images', dark ? 'cognipeer-logo-w.png' : 'cognipeer-logo-d.png'),
    x: M,
    y: 6.98,
    w: 0.92,
    h: 0.206,
    transparency: dark ? 20 : 30,
  });
  txt(s, `${String(pageNo).padStart(2, '0')} / ${TOTAL}`, {
    x: W - M - 1.4,
    y: 6.96,
    w: 1.4,
    h: 0.24,
    fontFace: MONO,
    fontSize: 8.5,
    color: dark ? C.dFaint : C.faint,
    align: 'right',
    valign: 'middle',
    charSpacing: 1,
  });
}

async function newSlide({ dark = false, eyebrowText, title, support, notes, chrome = true }) {
  const s = pres.addSlide();
  s.background = { path: dark ? BG_DARK : BG_LIGHT };
  if (eyebrowText) eyebrow(s, { x: M, y: 0.44, text: eyebrowText, dark });
  if (title) {
    txt(s, title, {
      x: M - 0.03,
      y: 0.76,
      w: 10.6,
      h: 0.62,
      fontSize: 30,
      color: dark ? C.dText : C.text,
      charSpacing: -0.3,
      valign: 'middle',
    });
  }
  if (support) {
    txt(s, support, {
      x: M,
      y: 1.42,
      w: 10.6,
      h: 0.3,
      fontSize: 14,
      color: dark ? C.dSoftText : C.muted,
      valign: 'middle',
    });
  }
  if (chrome) footer(s, dark);
  if (notes) s.addNotes(notes);
  return s;
}

/* ------------------------------------------------------------------ build */

const BG_LIGHT = await lightBackground();
const BG_DARK = await darkBackground();
const SHOT_TRACE = await framedShot('tracing/01-tracing-overview.png', { name: 'shot-tracing' });
const SHOT_MODELS = await framedShot('model-hub/01-model-hub-overview.png', { name: 'shot-models' });
const SHOT_SANDBOX = await framedShot('sandbox/10-playground.png', { name: 'shot-sandbox' });
const SHOT_DEMO = SHOT_TRACE;

/* 01 — Cover ------------------------------------------------------------- */
{
  const s = pres.addSlide();
  s.background = { path: BG_DARK };
  pageNo += 1;

  for (const [i, r] of [1.15, 1.85, 2.55].entries()) {
    s.addShape(SH.ellipse, {
      x: 10.65 - r,
      y: 3.5 - r,
      w: r * 2,
      h: r * 2,
      fill: { color: C.dPage, transparency: 100 },
      line: { color: C.accent, width: 0.75, transparency: 62 + i * 10 },
    });
  }
  s.addImage({ data: await icon('topology-star-3', C.accent, 320), x: 10.28, y: 3.13, w: 0.74, h: 0.74 });

  s.addImage({
    path: path.join(ROOT, 'public', 'images', 'cognipeer-logo-w.png'),
    x: M,
    y: 0.95,
    w: 2.1,
    h: 0.47,
  });

  eyebrow(s, { x: M, y: 2.5, text: 'ENTERPRISE AI CONTROL PLANE', color: C.accent });
  txt(s, 'One platform to centrally control, build, operate and optimize enterprise AI workloads.', {
    x: M - 0.03,
    y: 2.92,
    w: 8.2,
    h: 1.85,
    fontSize: 31,
    lineSpacing: 42,
    color: C.dText,
    charSpacing: -0.3,
  });

  const chips = ['Console', 'Agent SDK', 'Agent Server'];
  chips.forEach((t, i) => {
    pill(s, {
      x: M + i * 1.78,
      y: 5.0,
      w: 1.62,
      h: 0.46,
      text: t,
      fill: C.dSoft,
      line: C.dBorder,
      color: C.dSoftText,
      size: 11,
    });
  });

  rule(s, { x: M, y: 6.1, w: 5.9, color: C.dBorder });
  txt(s, 'Open source foundation  ·  Enterprise service model  ·  Full infrastructure control', {
    x: M,
    y: 6.28,
    w: 8.4,
    h: 0.3,
    fontSize: 11.5,
    color: C.dMuted,
  });
  if (AUDIENCE) {
    txt(s, `Prepared for ${AUDIENCE}`, {
      x: M,
      y: 6.66,
      w: 8.4,
      h: 0.3,
      fontFace: MONO,
      fontSize: 9.5,
      charSpacing: 1,
      color: C.dFaint,
    });
  }
  s.addNotes(
    'Opening frame: cognipeer is positioned as an enterprise AI control plane, not another AI tool. Console, Agent SDK and Agent Server are one platform. 10-15 minutes of architecture story, then straight into the live demo.',
  );
}

/* 02 — Enterprise AI is becoming an infrastructure layer ------------------ */
{
  const s = await newSlide({
    eyebrowText: '01 · CONTEXT',
    title: 'Enterprise AI Is Becoming an Infrastructure Layer',
    support: 'AI workloads spread across models, agents, applications, teams, data and infrastructure.',
    notes:
      'Every enterprise reaches the same point: AI stops being a project and becomes an infrastructure layer. Each team picks its own models, agents and data paths. Nothing is centrally governed, measured or attributable — which is an infrastructure problem, not a model problem.',
  });

  card(s, { x: M, y: 2.0, w: 7.05, h: 4.32, shadow: true });
  eyebrow(s, { x: M + 0.36, y: 2.3, text: "TODAY'S ENTERPRISE AI FOOTPRINT" });

  const items = [
    ['cpu', 'Models & Providers', 'OpenAI, Anthropic, Bedrock, vLLM'],
    ['robot', 'AI Agents', 'Per team, per use case'],
    ['layout-dashboard', 'Business Applications', 'Embedded AI features'],
    ['users', 'Teams & Business Units', 'Parallel adoption'],
    ['database', 'Enterprise Data', 'Documents, systems, knowledge'],
    ['plug-connected', 'APIs & Tools', 'Internal and external calls'],
    ['checklist', 'Security & Policies', 'Applied inconsistently'],
    ['report-money', 'Usage & Cost', 'Growing, hard to attribute'],
  ];
  for (const [i, [ic, name, sub]] of items.entries()) {
    const col = i % 2;
    const row = Math.floor(i / 2);
    const x = M + 0.36 + col * 3.24;
    const y = 2.78 + row * 0.83;
    card(s, { x, y, w: 3.0, h: 0.7, fill: C.wash, line: C.hairline, r: 0.09 });
    s.addImage({ data: await icon(ic, C.accentStrong, 200), x: x + 0.18, y: y + 0.2, w: 0.3, h: 0.3 });
    txt(s, name, { x: x + 0.6, y: y + 0.09, w: 2.3, h: 0.26, fontSize: 11, color: C.text, valign: 'middle' });
    txt(s, sub, { x: x + 0.6, y: y + 0.36, w: 2.3, h: 0.24, fontSize: 8.5, color: C.muted, valign: 'middle' });
  }

  s.addImage({ data: await icon('arrow-right', C.accent, 200), x: 7.92, y: 4.02, w: 0.3, h: 0.3 });

  card(s, { x: 8.29, y: 2.0, w: 4.32, h: 4.32, fill: C.text, line: C.text });
  eyebrow(s, { x: 8.65, y: 2.3, text: 'THE QUESTION', color: C.accent });
  txt(s, 'How do you centrally manage enterprise AI workloads?', {
    x: 8.65, y: 2.85, w: 3.6, h: 1.9, fontSize: 24, lineSpacing: 33, color: C.dText, charSpacing: -0.2,
  });
  rule(s, { x: 8.65, y: 4.85, w: 3.6, color: C.dBorderStrong });
  txt(s, 'Models, agents, data, access, policies and cost need one place where they are decided, enforced and observed.', {
    x: 8.65, y: 5.05, w: 3.6, h: 1.0, fontSize: 11, lineSpacing: 17, color: C.dMuted,
  });
}

/* 03 — The Enterprise AI Control Plane ----------------------------------- */
{
  const s = await newSlide({
    dark: true,
    eyebrowText: '02 · ARCHITECTURE',
    title: 'The Enterprise AI Control Plane',
    support: 'One platform to centrally control, build, operate and optimize enterprise AI workloads.',
    notes:
      'The key architecture slide. Consumers on top, foundation at the bottom, and one control plane in between with four capability areas: control and sovereignty, build and run, observe and govern, FinOps. Everything after this slide is a zoom into one of those four.',
  });

  card(s, { x: M, y: 2.02, w: CW, h: 0.74, fill: C.dRaised, line: C.dBorder });
  txt(s, 'CONSUMERS', {
    x: M + 0.34, y: 2.02, w: 2.2, h: 0.74, fontFace: MONO, fontSize: 9, charSpacing: 1.4, color: C.dFaint, valign: 'middle',
  });
  txt(s, 'Applications   ·   Teams   ·   Business Units   ·   Products', {
    x: M + 2.4, y: 2.02, w: CW - 4.8, h: 0.74, fontSize: 13.5, color: C.dSoftText, align: 'center', valign: 'middle',
  });

  s.addImage({ data: await icon('chevron-down', C.dFaint, 160), x: 6.5, y: 2.8, w: 0.33, h: 0.33 });

  card(s, { x: M, y: 3.2, w: CW, h: 2.28, fill: '0C161A', line: C.accentStrong, lw: 1.25 });
  s.addShape(SH.ellipse, { x: M + 0.34, y: 3.52, w: 0.08, h: 0.08, fill: { color: C.accent }, line: { width: 0 } });
  txt(s, 'COGNIPEER  ·  ENTERPRISE AI CONTROL PLANE', {
    x: M + 0.52, y: 3.4, w: 6, h: 0.32, fontFace: MONO, fontSize: 9.5, charSpacing: 1.5, color: C.accent, valign: 'middle',
  });
  txt(s, 'Console  ·  Agent SDK  ·  Agent Server', {
    x: W - M - 4.2, y: 3.4, w: 3.86, h: 0.32, fontSize: 11, color: C.dMuted, align: 'right', valign: 'middle',
  });

  const areas = [
    ['shield-check', 'Control & Sovereignty', 'Models, data, access,\npolicies, deployment'],
    ['rocket', 'Build & Run', 'Sandbox, SDK, runtime,\nserving, versioning'],
    ['eye', 'Observe & Govern', 'Traces, guardrails,\napprovals, runtime policy'],
    ['report-money', 'FinOps & Optimization', 'Usage, cost, budgets,\nrouting, fallback'],
  ];
  for (const [i, [ic, name, sub]] of areas.entries()) {
    const tw = (CW - 0.68 - 3 * 0.22) / 4;
    const x = M + 0.34 + i * (tw + 0.22);
    card(s, { x, y: 3.92, w: tw, h: 1.28, fill: C.dRaised, line: C.dBorderStrong, r: 0.1 });
    s.addImage({ data: await icon(ic, C.accent, 200), x: x + 0.2, y: 4.1, w: 0.29, h: 0.29 });
    txt(s, name, { x: x + 0.2, y: 4.45, w: tw - 0.3, h: 0.26, fontSize: 11.5, color: C.dText, valign: 'middle' });
    txt(s, sub, { x: x + 0.2, y: 4.73, w: tw - 0.28, h: 0.42, fontSize: 8.8, lineSpacing: 12, color: C.dMuted });
  }

  s.addImage({ data: await icon('chevron-down', C.dFaint, 160), x: 6.5, y: 5.52, w: 0.33, h: 0.33 });

  card(s, { x: M, y: 5.92, w: CW, h: 0.74, fill: C.dRaised, line: C.dBorder });
  txt(s, 'FOUNDATION', {
    x: M + 0.34, y: 5.92, w: 2.2, h: 0.74, fontFace: MONO, fontSize: 9, charSpacing: 1.4, color: C.dFaint, valign: 'middle',
  });
  txt(s, 'Models   ·   Agents   ·   Data   ·   Tools   ·   Infrastructure', {
    x: M + 2.4, y: 5.92, w: CW - 4.8, h: 0.74, fontSize: 13.5, color: C.dSoftText, align: 'center', valign: 'middle',
  });
}

/* 04 — Control & Sovereignty --------------------------------------------- */
{
  const s = await newSlide({
    eyebrowText: '03 · CONTROL & SOVEREIGNTY',
    title: 'Control & Sovereignty',
    support: 'Maintain control over your enterprise AI infrastructure.',
    notes:
      'Sovereignty is the entry condition for enterprise AI: which models are allowed, where workloads run, who can access them, which policies apply and where data stays. Self-hosted and on-premise deployment keep that decision with the organization, not with a vendor.',
  });

  card(s, { x: M, y: 2.0, w: 3.95, h: 4.32, shadow: true });
  eyebrow(s, { x: M + 0.32, y: 2.28, text: 'THE ORGANIZATION DECIDES' });
  const decisions = [
    'Which models can be used',
    'Where AI workloads run',
    'Who can access them',
    'Which policies apply',
    'Where enterprise data remains',
    'How AI infrastructure is governed',
  ];
  for (const [i, d] of decisions.entries()) {
    const y = 2.82 + i * 0.55;
    s.addImage({ data: await icon('circle-check', C.accent, 180), x: M + 0.32, y: y + 0.03, w: 0.24, h: 0.24 });
    txt(s, d, { x: M + 0.68, y, w: 2.95, h: 0.32, fontSize: 11.5, color: C.text, valign: 'middle' });
  }

  const RX = 5.05;
  const RW = W - M - RX;
  card(s, { x: RX, y: 2.0, w: RW, h: 0.88, fill: C.accentSoft, line: C.accentLine, shadow: true });
  s.addImage({ data: await icon('shield-check', C.accentStrong, 220), x: RX + 0.3, y: 2.28, w: 0.34, h: 0.34 });
  txt(s, 'cognipeer Control Plane', {
    x: RX + 0.78, y: 2.0, w: 4.0, h: 0.88, fontSize: 15.5, color: C.text, valign: 'middle',
  });
  txt(s, 'ONE POINT OF CONTROL', {
    x: RX + RW - 3.0, y: 2.0, w: 2.7, h: 0.88, fontFace: MONO, fontSize: 9, charSpacing: 1.3, color: C.accentStrong,
    align: 'right', valign: 'middle',
  });

  const pillars = [
    ['cpu', 'Models', 'Providers,\nrouting, limits'],
    ['database', 'Data', 'Residency,\nretention, RAG'],
    ['key', 'Access', 'Projects, roles,\nAPI tokens'],
    ['checklist', 'Policies', 'Guardrails,\nquotas, PII'],
    ['server-cog', 'Infrastructure', 'Self-hosted,\non-premise'],
  ];
  vrule(s, { x: RX + RW / 2, y: 2.88, h: 0.22 });
  rule(s, { x: RX + 0.69, y: 3.1, w: RW - 1.38 });
  for (const [i, [ic, name, sub]] of pillars.entries()) {
    const w = (RW - 4 * 0.14) / 5;
    const x = RX + i * (w + 0.14);
    vrule(s, { x: x + w / 2, y: 3.1, h: 0.22 });
    card(s, { x, y: 3.32, w, h: 1.6 });
    s.addImage({ data: await icon(ic, C.accentStrong, 200), x: x + 0.18, y: 3.52, w: 0.29, h: 0.29 });
    txt(s, name, { x: x + 0.18, y: 3.9, w: w - 0.28, h: 0.28, fontSize: 11, color: C.text, valign: 'middle' });
    txt(s, sub, { x: x + 0.18, y: 4.22, w: w - 0.26, h: 0.5, fontSize: 9, lineSpacing: 12, color: C.muted });
  }

  const deploy = ['Self-hosted', 'On-premise', 'Multi-tenant isolation', 'No vendor lock-in'];
  for (const [i, t] of deploy.entries()) {
    const w = (RW - 3 * 0.14) / 4;
    pill(s, { x: RX + i * (w + 0.14), y: 5.24, w, h: 0.5, text: t, fill: C.surface, size: 9.5, pad: 0.12 });
  }
  txt(s, 'The platform runs where your data, policies and security requirements say it must.', {
    x: RX, y: 5.92, w: RW, h: 0.3, fontSize: 11, color: C.muted, valign: 'middle',
  });
}

/* 05 — Open Source + Service Model --------------------------------------- */
{
  const s = await newSlide({
    eyebrowText: '04 · OPERATING MODEL',
    title: 'Open Source + Service Model',
    support: 'Full control without the operational burden.',
    notes:
      'Open source here is not a pricing argument, it is a sovereignty argument: transparency, extensibility, code-level control, no lock-in. The service model is what makes it enterprise-ready — deployment, integration, customization, upgrades and support stay with us.',
  });

  card(s, { x: M, y: 2.0, w: 5.76, h: 3.42, fill: C.text, line: C.text });
  s.addImage({ data: await icon('brand-open-source', C.accent, 220), x: M + 0.36, y: 2.32, w: 0.34, h: 0.34 });
  txt(s, 'Open Source', { x: M + 0.84, y: 2.3, w: 3.4, h: 0.38, fontSize: 17, color: C.dText, valign: 'middle' });
  txt(s, 'FOUNDATION', {
    x: M + 5.76 - 1.9, y: 2.3, w: 1.55, h: 0.38, fontFace: MONO, fontSize: 8.5, charSpacing: 1.3, color: C.dFaint,
    align: 'right', valign: 'middle',
  });
  const oss = [
    'Transparency',
    'Extensibility',
    'No vendor lock-in',
    'Code-level control',
    'Infrastructure independence',
    'Self-hosted architecture',
  ];
  for (const [i, t] of oss.entries()) {
    const y = 3.04 + i * 0.38;
    s.addShape(SH.ellipse, { x: M + 0.38, y: y + 0.11, w: 0.07, h: 0.07, fill: { color: C.accent }, line: { width: 0 } });
    txt(s, t, { x: M + 0.62, y, w: 4.8, h: 0.3, fontSize: 12, color: C.dSoftText, valign: 'middle' });
  }

  const X2 = M + 6.13;
  card(s, { x: X2, y: 2.0, w: 5.76, h: 3.42, shadow: true });
  s.addImage({ data: await icon('lifebuoy', C.accentStrong, 220), x: X2 + 0.36, y: 2.32, w: 0.34, h: 0.34 });
  txt(s, 'Enterprise Service Model', { x: X2 + 0.84, y: 2.3, w: 3.9, h: 0.38, fontSize: 17, color: C.text, valign: 'middle' });
  txt(s, 'OPERATIONS', {
    x: X2 + 5.76 - 1.9, y: 2.3, w: 1.55, h: 0.38, fontFace: MONO, fontSize: 8.5, charSpacing: 1.3, color: C.faint,
    align: 'right', valign: 'middle',
  });
  const svc = [
    'Deployment',
    'Enterprise support',
    'Integration',
    'Architecture services',
    'Customization',
    'Operational assistance',
    'Platform upgrades',
    'Continuous evolution',
  ];
  for (const [i, t] of svc.entries()) {
    const col = i % 2;
    const row = Math.floor(i / 2);
    const x = X2 + 0.38 + col * 2.72;
    const y = 3.04 + row * 0.5;
    s.addImage({ data: await icon('circle-check', C.accentStrong, 180), x, y: y + 0.04, w: 0.22, h: 0.22 });
    txt(s, t, { x: x + 0.34, y, w: 2.3, h: 0.3, fontSize: 11.5, color: C.soft, valign: 'middle' });
  }

  card(s, { x: M, y: 5.62, w: CW, h: 0.8, fill: C.accentSoft, line: C.accentLine });
  s.addText(
    [
      { text: 'Open Source Foundation', options: { color: C.text } },
      { text: '   +   ', options: { color: C.accentStrong } },
      { text: 'Enterprise Services', options: { color: C.text } },
      { text: '   =   ', options: { color: C.accentStrong } },
      { text: 'Enterprise-Ready AI Infrastructure', options: { color: C.text } },
    ],
    { x: M, y: 5.62, w: CW, h: 0.8, fontFace: SANS, fontSize: 15, align: 'center', valign: 'middle', margin: 0 },
  );
  txt(s, 'Own the platform. Keep the flexibility. Let us operate and evolve it with you.', {
    x: M, y: 6.52, w: CW, h: 0.3, fontSize: 11, color: C.muted, align: 'center', italic: true, valign: 'middle',
  });
}

/* 06 — Build & Run -------------------------------------------------------- */
{
  const s = await newSlide({
    eyebrowText: '05 · BUILD & RUN',
    title: 'Build & Run AI Workloads',
    support: 'From experimentation to production — on one runtime path.',
    notes:
      'The same platform carries a workload from sandbox experiment to production service: build in the sandbox with the SDK, test against traces and guardrails, publish a version, serve it over authenticated APIs with streaming. No rewrite between prototype and production.',
  });

  const stages = [
    ['flask', '01', 'Build', ['Agent Sandbox', 'Agent SDK', 'RAG & Files']],
    ['terminal-2', '02', 'Test', ['Agent Runtime', 'Traces & Replay', 'Guardrails']],
    ['packages', '03', 'Deploy', ['Publish & Version', 'Authentication', 'APIs']],
    ['rocket', '04', 'Run', ['Agent Server', 'Streaming', 'Production Deployment']],
  ];
  const sw = (CW - 3 * 0.3) / 4;
  for (const [i, [ic, num, name, chips]] of stages.entries()) {
    const x = M + i * (sw + 0.3);
    card(s, { x, y: 2.0, w: sw, h: 1.92, shadow: true });
    s.addImage({ data: await icon(ic, C.accentStrong, 200), x: x + 0.24, y: 2.24, w: 0.3, h: 0.3 });
    txt(s, num, {
      x: x + sw - 0.85, y: 2.24, w: 0.6, h: 0.3, fontFace: MONO, fontSize: 9.5, color: C.faint, align: 'right', valign: 'middle',
    });
    txt(s, name, { x: x + 0.24, y: 2.62, w: sw - 0.5, h: 0.34, fontSize: 16, color: C.text, valign: 'middle' });
    for (const [j, c] of chips.entries()) {
      const cy = 3.0 + j * 0.28;
      s.addShape(SH.ellipse, { x: x + 0.26, y: cy + 0.1, w: 0.06, h: 0.06, fill: { color: C.accent }, line: { width: 0 } });
      txt(s, c, { x: x + 0.46, y: cy, w: sw - 0.7, h: 0.26, fontSize: 10, color: C.muted, valign: 'middle' });
    }
    if (i < 3) {
      s.addImage({ data: await icon('arrow-right', C.accent, 180), x: x + sw + 0.03, y: 2.82, w: 0.24, h: 0.24 });
    }
  }

  const roles = [
    ['layout-dashboard', 'Console', 'Manages the AI environment and the infrastructure layer.', 'MODELS · PROJECTS · POLICIES · COST'],
    ['code', 'Agent SDK', 'Controls agent execution and runtime behaviour.', 'RUNTIME · GUARDRAILS · HUMAN-IN-THE-LOOP'],
    ['server-2', 'Agent Server', 'Publishes, versions and serves production agents.', 'REST · SSE · AUTH · VERSIONING'],
  ];
  const rw = (CW - 2 * 0.3) / 3;
  for (const [i, [ic, name, desc, meta]] of roles.entries()) {
    const x = M + i * (rw + 0.3);
    card(s, { x, y: 4.24, w: rw, h: 1.92, fill: C.wash, line: C.border });
    s.addImage({ data: await icon(ic, C.text, 200), x: x + 0.28, y: 4.5, w: 0.3, h: 0.3 });
    txt(s, name, { x: x + 0.7, y: 4.5, w: rw - 1.0, h: 0.3, fontSize: 14.5, color: C.text, valign: 'middle' });
    txt(s, desc, { x: x + 0.28, y: 4.96, w: rw - 0.56, h: 0.6, fontSize: 11, lineSpacing: 16, color: C.soft });
    txt(s, meta, {
      x: x + 0.28, y: 5.66, w: rw - 0.56, h: 0.28, fontFace: MONO, fontSize: 8, charSpacing: 0.9, color: C.faint, valign: 'middle',
    });
  }
}

/* 07 — Observe & Govern --------------------------------------------------- */
{
  const s = await newSlide({
    eyebrowText: '06 · OBSERVE & GOVERN',
    title: 'Observe & Govern',
    support: 'Know and control what every AI workload is doing.',
    notes:
      'Three questions, in order: what happened, why did it happen, can we control it. Tracing answers the first two down to the model request and tool call. Guardrails, human-in-the-loop, interrupt and runtime policies answer the third. This is an operations layer, not a dashboard.',
  });

  const flow = ['Observe', 'Understand', 'Control'];
  for (const [i, t] of flow.entries()) {
    const x = M + i * 2.5;
    pill(s, { x, y: 1.98, w: 2.16, h: 0.52, text: t, fill: C.surface, size: 11.5, color: C.text });
    if (i < 2) {
      s.addImage({ data: await icon('arrow-right', C.accent, 180), x: x + 2.24, y: 2.11, w: 0.26, h: 0.26 });
    }
  }
  txt(s, 'An AI operations and governance layer — not another monitoring dashboard.', {
    x: 8.0, y: 1.98, w: W - M - 8.0, h: 0.52, fontSize: 11, color: C.muted, align: 'right', valign: 'middle',
  });

  const cols = [
    ['activity-heartbeat', 'What happened?', 'Tracing and observability across every run.',
      ['Detailed tracing', 'LLM request tracking', 'Tool call visibility', 'Session & thread view']],
    ['timeline', 'Why did it happen?', 'Execution history, model requests, tool interactions.',
      ['Agent execution traces', 'Model requests & responses', 'Tool interactions', 'Token & latency breakdown']],
    ['hand-stop', 'Can we control it?', 'Guardrails, approvals, interruption, runtime policy.',
      ['Guardrails', 'Human-in-the-loop', 'Interrupt · Pause · Continue', 'Runtime policies & alerts']],
  ];
  const cw2 = (CW - 2 * 0.32) / 3;
  for (const [i, [ic, q, sub, chips]] of cols.entries()) {
    const x = M + i * (cw2 + 0.32);
    card(s, { x, y: 2.78, w: cw2, h: 3.5, shadow: true });
    s.addImage({ data: await icon(ic, C.accentStrong, 220), x: x + 0.3, y: 3.04, w: 0.32, h: 0.32 });
    txt(s, q, { x: x + 0.3, y: 3.5, w: cw2 - 0.6, h: 0.36, fontSize: 17, color: C.text, valign: 'middle' });
    txt(s, sub, { x: x + 0.3, y: 3.92, w: cw2 - 0.6, h: 0.56, fontSize: 10.5, lineSpacing: 15, color: C.muted });
    for (const [j, c] of chips.entries()) {
      pill(s, {
        x: x + 0.3, y: 4.5 + j * 0.4, w: cw2 - 0.6, h: 0.34, text: c, fill: C.wash, line: C.hairline,
        size: 10, align: 'left', pad: 0.24,
      });
    }
  }
}

/* 08 — FinOps & Optimization --------------------------------------------- */
{
  const s = await newSlide({
    eyebrowText: '07 · FINOPS',
    title: 'FinOps & Optimization',
    support: 'Measure, control and optimize AI consumption.',
    notes:
      'AI cost behaves like cloud cost did ten years ago: it grows before anyone can attribute it. Usage is tracked per project and team, cost is attributed, budgets and quotas enforce limits, and routing plus provider fallback optimize what is left.',
  });

  const flow = [
    ['gauge', 'Usage', 'Tokens, requests and\ncalls per workload'],
    ['report-money', 'Cost', 'Attribution by project,\nteam and application'],
    ['adjustments', 'Control', 'Budgets, quotas,\nrate limits, alerts'],
    ['arrows-shuffle', 'Optimization', 'Model routing and\nprovider fallback'],
  ];
  const fw = (CW - 3 * 0.3) / 4;
  for (const [i, [ic, name, sub]] of flow.entries()) {
    const x = M + i * (fw + 0.3);
    card(s, { x, y: 2.0, w: fw, h: 1.5, shadow: true });
    s.addImage({ data: await icon(ic, C.accentStrong, 200), x: x + 0.26, y: 2.22, w: 0.3, h: 0.3 });
    txt(s, name, { x: x + 0.68, y: 2.22, w: fw - 0.9, h: 0.3, fontSize: 14.5, color: C.text, valign: 'middle' });
    txt(s, sub, { x: x + 0.26, y: 2.66, w: fw - 0.5, h: 0.6, fontSize: 10, lineSpacing: 14, color: C.muted });
    if (i < 3) {
      s.addImage({ data: await icon('arrow-right', C.accent, 180), x: x + fw + 0.02, y: 2.63, w: 0.26, h: 0.26 });
    }
  }

  card(s, { x: M, y: 3.78, w: 7.02, h: 2.36, shadow: true });
  eyebrow(s, { x: M + 0.34, y: 4.04, text: 'QUESTIONS THE PLATFORM ANSWERS' });
  const qs = [
    'Which teams consume AI resources?',
    'Which applications generate the highest cost?',
    'Which models are being used, and where?',
    'Where can workloads be routed more efficiently?',
  ];
  for (const [i, q] of qs.entries()) {
    const y = 4.56 + i * 0.4;
    s.addImage({ data: await icon('arrow-right', C.accent, 160), x: M + 0.34, y: y + 0.03, w: 0.22, h: 0.22 });
    txt(s, q, { x: M + 0.66, y, w: 6.1, h: 0.3, fontSize: 11.5, color: C.soft, valign: 'middle' });
  }

  card(s, { x: 8.1, y: 3.78, w: W - M - 8.1, h: 2.36, fill: C.text, line: C.text });
  txt(s, 'AI consumption should be measurable, attributable and controllable.', {
    x: 8.44, y: 4.04, w: 3.85, h: 1.2, fontSize: 17, lineSpacing: 25, color: C.dText,
  });
  rule(s, { x: 8.44, y: 5.24, w: 3.85, color: C.dBorderStrong });
  txt(s, 'BUDGETS · QUOTAS · RATE LIMITS · COST ALERTS', {
    x: 8.44, y: 5.44, w: 3.85, h: 0.5, fontFace: MONO, fontSize: 8.5, lineSpacing: 14, charSpacing: 1, color: C.accent,
  });
}

/* 09 — Key Services ------------------------------------------------------- */
{
  const s = await newSlide({
    eyebrowText: '08 · SERVICES',
    title: 'Key Services',
    support: 'Core services for enterprise AI infrastructure.',
    notes:
      'The service surface behind the four capability areas. Each of these is a production service in the platform today — the demo will move through the gateway, sandbox, tracing and serving paths.',
  });

  const services = [
    ['route', 'LLM Gateway', 'Unified access to multiple models and providers.'],
    ['flask', 'Agent Sandbox', 'Controlled environment to develop and test agents.'],
    ['code', 'Agent SDK', 'Runtime layer for controlled, production-grade agents.'],
    ['files', 'RAG & Files Pipeline', 'Enterprise document ingestion and knowledge grounding.'],
    ['vector-triangle', 'Vector Orchestration', 'Unified management of vector infrastructure.'],
    ['server-2', 'Agent Server', 'Publishing, versioning and serving through secure APIs.'],
    ['timeline', 'Tracing & Observability', 'Central visibility into model and agent execution.'],
    ['message-2', 'Chat UI', 'Production-ready conversational interface for the enterprise.'],
  ];
  const gw = (CW - 3 * 0.28) / 4;
  for (const [i, [ic, name, desc]] of services.entries()) {
    const col = i % 4;
    const row = Math.floor(i / 4);
    const x = M + col * (gw + 0.28);
    const y = 2.05 + row * 2.1;
    card(s, { x, y, w: gw, h: 1.94, shadow: true });
    s.addShape(SH.roundRect, {
      x: x + 0.28, y: y + 0.28, w: 0.56, h: 0.56, fill: { color: C.accentSoft }, line: { color: C.accentLine, width: 1 }, rectRadius: 0.14,
    });
    s.addImage({ data: await icon(ic, C.accentStrong, 200), x: x + 0.42, y: y + 0.42, w: 0.28, h: 0.28 });
    txt(s, name, { x: x + 0.28, y: y + 0.98, w: gw - 0.56, h: 0.32, fontSize: 13, color: C.text, valign: 'middle' });
    txt(s, desc, { x: x + 0.28, y: y + 1.32, w: gw - 0.5, h: 0.5, fontSize: 10, lineSpacing: 14, color: C.muted });
  }
}

/* 10 — Live Demo ---------------------------------------------------------- */
{
  const s = await newSlide({
    dark: true,
    eyebrowText: '09 · DEMO',
    notes:
      'Transition slide. Move into the product: configure a provider and model, build an agent in the sandbox, run it, watch the trace, apply a guardrail or interrupt, then show usage and cost attribution.',
  });

  txt(s, 'Live Demo', { x: M - 0.03, y: 1.05, w: 7, h: 0.9, fontSize: 44, color: C.dText, charSpacing: -0.6, valign: 'middle' });
  txt(s, 'From control plane to running AI workload.', {
    x: M, y: 2.0, w: 7, h: 0.36, fontSize: 15, color: C.dSoftText, valign: 'middle',
  });

  const journey = ['Configure', 'Build', 'Run', 'Observe', 'Control', 'Optimize'];
  for (const [i, t] of journey.entries()) {
    const col = i % 3;
    const row = Math.floor(i / 3);
    pill(s, {
      x: M + col * 2.4, y: 2.95 + row * 0.72, w: 2.16, h: 0.54, text: `${String(i + 1).padStart(2, '0')}  ${t}`,
      fill: C.dSoft, line: C.dBorder, color: C.dSoftText, size: 11, align: 'left', pad: 0.3,
    });
  }
  rule(s, { x: M, y: 4.9, w: 6.4, color: C.dBorder });
  txt(s, 'One platform — configure the infrastructure, build the workload, run it, and see exactly what it did and what it cost.', {
    x: M, y: 5.1, w: 6.4, h: 0.7, fontSize: 11.5, lineSpacing: 18, color: C.dMuted,
  });

  s.addImage({ path: SHOT_DEMO, x: W - M - 4.9, y: 2.4, w: 4.9, h: 3.06 });
  txt(s, 'CONSOLE · AGENT OBSERVABILITY', {
    x: W - M - 4.9, y: 5.6, w: 4.9, h: 0.3, fontFace: MONO, fontSize: 8.5, charSpacing: 1.2, color: C.dFaint, valign: 'middle',
  });
}

/* 11 — Architecture & Deployment Discussion ------------------------------- */
{
  const s = await newSlide({
    eyebrowText: '10 · DISCUSSION',
    title: 'Architecture & Deployment Discussion',
    support: 'How does this fit into your AI architecture?',
    notes:
      'Stop pitching here. Walk through the discussion areas with the team, map their current workloads and constraints, and land on a first pilot scope that is narrow enough to deliver and representative enough to prove the control plane.',
  });

  const areas = [
    ['bolt', 'Existing AI workloads'],
    ['cpu', 'Models & providers'],
    ['cloud-lock', 'Cloud / on-premise'],
    ['lock', 'Security requirements'],
    ['database', 'Enterprise data sources'],
    ['plug-connected', 'Integration points'],
    ['users', 'Teams & projects'],
    ['checklist', 'Governance & policy'],
    ['report-money', 'AI cost management'],
    ['rocket', 'Initial pilot scope'],
  ];
  const aw = (CW - 4 * 0.22) / 5;
  for (const [i, [ic, name]] of areas.entries()) {
    const col = i % 5;
    const row = Math.floor(i / 5);
    const x = M + col * (aw + 0.22);
    const y = 2.1 + row * 1.1;
    card(s, { x, y, w: aw, h: 0.98, shadow: true });
    s.addImage({ data: await icon(ic, C.accentStrong, 200), x: x + 0.22, y: y + 0.2, w: 0.28, h: 0.28 });
    txt(s, name, { x: x + 0.22, y: y + 0.55, w: aw - 0.36, h: 0.3, fontSize: 10.5, color: C.text, valign: 'middle' });
  }

  card(s, { x: M, y: 4.5, w: CW, h: 1.66, fill: C.text, line: C.text });
  eyebrow(s, { x: M + 0.42, y: 4.78, text: 'STARTING POINT', color: C.accent });
  txt(s, 'Which AI workloads would make the best starting point for a centralized control plane?', {
    x: M + 0.42, y: 5.2, w: 8.6, h: 0.7, fontSize: 20, lineSpacing: 28, color: C.dText, charSpacing: -0.2,
  });
  txt(s, 'Pilot scope\nIntegration points\nDeployment model', {
    x: W - M - 3.2, y: 4.9, w: 2.8, h: 1.0, fontFace: MONO, fontSize: 9.5, lineSpacing: 15, charSpacing: 1,
    color: C.dMuted, align: 'right',
  });
}

/* 12 — Appendix: capability map ------------------------------------------ */
{
  const s = await newSlide({
    eyebrowText: 'APPENDIX · A1',
    title: 'Platform Capability Overview',
    support: 'Detail behind the four control-plane capability areas.',
    notes: 'Appendix. Use only if the audience asks for capability-level detail.',
  });

  const cols = [
    ['layout-dashboard', 'Console', ['LLM Gateway', 'RAG & Knowledge Engine', 'Tracing', 'Files pipeline', 'Vector orchestration', 'Cost & budget control', 'Multi-tenant isolation', 'Memory management', 'Alerting']],
    ['code', 'Agent SDK', ['Message-first runtime', 'Pause / continue', 'Human-in-the-loop', 'Structured tracking', 'Interrupt', 'Summarisation', 'Guardrails', 'Planning', 'Multi-agent orchestration']],
    ['server-2', 'Agent Server', ['Multi-agent registry', 'REST API', 'SSE streaming', 'Swagger', 'Authentication', 'Publish & version', 'Storage', 'File upload']],
    ['message-2', 'Chat UI', ['Full chat', 'Streaming UI', 'Tool cards', 'File attachments', 'Themes', 'Hooks API']],
  ];
  const cw3 = (CW - 3 * 0.25) / 4;
  for (const [i, [ic, name, items]] of cols.entries()) {
    const x = M + i * (cw3 + 0.25);
    card(s, { x, y: 2.05, w: cw3, h: 4.2, shadow: true });
    s.addImage({ data: await icon(ic, C.accentStrong, 200), x: x + 0.28, y: 2.32, w: 0.3, h: 0.3 });
    txt(s, name, { x: x + 0.68, y: 2.32, w: cw3 - 0.9, h: 0.3, fontSize: 14, color: C.text, valign: 'middle' });
    rule(s, { x: x + 0.28, y: 2.86, w: cw3 - 0.56, color: C.hairline });
    for (const [j, it] of items.entries()) {
      const y = 3.02 + j * 0.34;
      s.addShape(SH.ellipse, { x: x + 0.3, y: y + 0.11, w: 0.065, h: 0.065, fill: { color: C.accent }, line: { width: 0 } });
      txt(s, it, { x: x + 0.52, y, w: cw3 - 0.74, h: 0.28, fontSize: 10, color: C.soft, valign: 'middle' });
    }
  }
}

/* 13 — Appendix: console in action --------------------------------------- */
{
  const s = await newSlide({
    eyebrowText: 'APPENDIX · A2',
    title: 'Console in Action',
    support: 'The surfaces the live demo moves through.',
    notes: 'Appendix. Backup screenshots in case the live environment is unavailable.',
  });

  const shots = [
    [SHOT_MODELS, 'MODEL HUB', 'Providers, models and routing under one catalogue.'],
    [SHOT_TRACE, 'AGENT OBSERVABILITY', 'Sessions, traces, tool calls and token usage.'],
    [SHOT_SANDBOX, 'AGENT SANDBOX', 'Build and test agents before they reach production.'],
  ];
  const iw = (CW - 2 * 0.3) / 3;
  for (const [i, [p, label, desc]] of shots.entries()) {
    const x = M + i * (iw + 0.3);
    txt(s, label, {
      x, y: 2.05, w: iw, h: 0.28, fontFace: MONO, fontSize: 9, charSpacing: 1.3, color: C.muted, valign: 'middle',
    });
    s.addImage({ path: p, x, y: 2.42, w: iw, h: iw * 0.625 });
    txt(s, desc, { x, y: 2.5 + iw * 0.625, w: iw, h: 0.5, fontSize: 10.5, lineSpacing: 15, color: C.soft });
  }

  card(s, { x: M, y: 5.5, w: CW, h: 0.86, fill: C.accentSoft, line: C.accentLine });
  txt(s, 'The full walkthrough happens live — configure, build, run, observe, control, optimize.', {
    x: M, y: 5.5, w: CW, h: 0.86, fontSize: 13, color: C.text, align: 'center', valign: 'middle',
  });
}

await pres.writeFile({ fileName: OUT });
console.log(`wrote ${OUT}`);
