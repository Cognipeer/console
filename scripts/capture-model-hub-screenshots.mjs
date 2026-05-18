import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

const BASE_URL = process.env.BASE_URL || 'http://localhost:3030';
const EMAIL = process.env.DEMO_EMAIL || 'kamil@kamil.com';
const PASSWORD = process.env.DEMO_PASSWORD || 'P@ssword1!';
const OUT_DIR = resolve(process.cwd(), 'docs/public/screenshots/model-hub');

await mkdir(OUT_DIR, { recursive: true });

const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 2,
  colorScheme: 'dark',
});

// Login via API, then attach cookies to the browser context.
const loginRes = await fetch(`${BASE_URL}/api/auth/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
});

if (!loginRes.ok) {
  throw new Error(`Login failed: ${loginRes.status} ${await loginRes.text()}`);
}

const setCookies = loginRes.headers.getSetCookie?.() ?? [];
const cookies = setCookies.map((raw) => {
  const [pair, ...attrs] = raw.split(';').map((s) => s.trim());
  const eq = pair.indexOf('=');
  return {
    name: pair.slice(0, eq),
    value: pair.slice(eq + 1),
    domain: 'localhost',
    path: '/',
    httpOnly: attrs.some((a) => a.toLowerCase() === 'httponly'),
    sameSite: 'Lax',
  };
});
await ctx.addCookies(cookies);

const page = await ctx.newPage();

async function warmup(url) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await page.goto(`${BASE_URL}${url}`, { waitUntil: 'networkidle', timeout: 60_000 });
      if (res && res.ok()) return;
    } catch {}
    await page.waitForTimeout(2500);
  }
}

async function shot(name, url, { closeDocs = true, waitMs = 1600, scrollTo } = {}) {
  await warmup(url);
  await page.waitForTimeout(waitMs);
  if (closeDocs) {
    try {
      const closed = await page.evaluate(() => {
        const btn = document.querySelector('button[aria-label="Close documentation"]');
        if (btn) { btn.click(); return true; }
        return false;
      });
      if (closed) await page.waitForTimeout(350);
    } catch {}
  }
  if (scrollTo != null) {
    await page.evaluate((y) => window.scrollTo(0, y), scrollTo);
    await page.waitForTimeout(250);
  }
  const file = resolve(OUT_DIR, `${name}.png`);
  await page.screenshot({ path: file, fullPage: false });
  console.log(`saved ${file}`);
}

await shot('02-providers', '/dashboard/providers');

// Create-model dialog: click the "Create Model" button on the list page to open the modal.
await page.goto(`${BASE_URL}/dashboard/models`, { waitUntil: 'networkidle' });
// Wait for the project switcher to stop showing "Loading…" (uses ellipsis char).
await page.waitForFunction(
  () => {
    const text = document.body.innerText || '';
    return !text.includes('Loading…') && !text.includes('Loading...');
  },
  { timeout: 30_000 },
).catch(() => {});
// Wait for the page to have finished its initial data fetch (count card shows a number).
await page.waitForTimeout(2500);
try {
  await page.evaluate(() => {
    const btn = document.querySelector('button[aria-label="Close documentation"]');
    if (btn) btn.click();
  });
  await page.waitForTimeout(400);
} catch {}
// Try clicking the Create Model button. Force a click via evaluate as a fallback.
const opened = await page.evaluate(() => {
  const all = Array.from(document.querySelectorAll('button'));
  const btn = all.find((b) => /Create Model|Yeni Model/i.test(b.textContent || ''));
  if (btn) { btn.click(); return true; }
  return false;
});
console.log('create button click attempt:', opened);
await page.locator('[role="dialog"]').first().waitFor({ state: 'visible', timeout: 10_000 }).catch(() => {});
await page.waitForTimeout(1000);
await page.screenshot({ path: resolve(OUT_DIR, '03-create-model-modal.png'), fullPage: false });
console.log('saved 03-create-model-modal.png');
await page.keyboard.press('Escape').catch(() => {});
await page.waitForTimeout(400);

// Create one model via API so we have data for populated screenshots.
// Reuse the cookie jar via fetch with raw header.
const cookieHeader = setCookies
  .map((c) => c.split(';')[0])
  .join('; ');

// Look for an existing model provider (per-project scope).
const provRes = await fetch(`${BASE_URL}/api/models/providers`, {
  headers: { Cookie: cookieHeader },
});
const provJson = provRes.ok ? await provRes.json() : null;
console.log('model providers:', JSON.stringify(provJson)?.slice(0, 200));

let providerKey = provJson?.providers?.[0]?.key ?? null;
if (!providerKey) {
  const installRes = await fetch(`${BASE_URL}/api/models/providers`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookieHeader },
    body: JSON.stringify({
      key: 'openai-docs',
      driver: 'openai',
      label: 'OpenAI (docs demo)',
      credentials: { apiKey: 'sk-DEMO-PLACEHOLDER-NOT-REAL' },
      settings: {},
      status: 'active',
    }),
  });
  console.log('install status:', installRes.status);
  if (installRes.ok) {
    const installed = await installRes.json();
    providerKey = installed?.provider?.key ?? 'openai-docs';
  } else {
    console.log('install body:', (await installRes.text()).slice(0, 300));
  }
}

// Resolve a model id to use for detail/edit screenshots: prefer an existing one,
// only create a new one if the project has none. This keeps repeat runs idempotent.
let modelId = null;
const existingList = await fetch(`${BASE_URL}/api/models`, { headers: { Cookie: cookieHeader } });
if (existingList.ok) {
  const list = await existingList.json();
  const preferred = list?.models?.find((m) => /gpt-4o-mini|gpt-4|gpt-5/i.test(m.name || m.key || ''));
  modelId = preferred?._id ?? list?.models?.[0]?._id ?? null;
}
if (!modelId && providerKey) {
  const createRes = await fetch(`${BASE_URL}/api/models`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookieHeader },
    body: JSON.stringify({
      name: 'GPT-4o mini',
      key: 'gpt-4o-mini',
      providerKey,
      category: 'llm',
      modelId: 'gpt-4o-mini',
      description: 'Cost-efficient general-purpose model for documentation demo.',
      isMultimodal: false,
      supportsToolCalls: true,
      pricing: {
        inputTokenPer1M: 0.15,
        outputTokenPer1M: 0.6,
        cachedTokenPer1M: 0.075,
        currency: 'USD',
      },
      settings: { temperature: 0.7, maxTokens: 4096 },
    }),
  });
  console.log('create model status:', createRes.status);
  if (createRes.ok) {
    const m = await createRes.json();
    modelId = m?.model?._id ?? m?.model?.id ?? m?._id ?? m?.id;
  }
}
console.log('using modelId:', modelId);

await shot('01-model-hub-overview', '/dashboard/models');

if (modelId) {
  await shot('04-model-detail', `/dashboard/models/${modelId}`);
  await shot('05-model-edit', `/dashboard/models/${modelId}/edit`);
}

await browser.close();
console.log('done');
