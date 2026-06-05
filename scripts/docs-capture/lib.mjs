import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

const BASE_URL = process.env.BASE_URL || 'http://localhost:3030';
const EMAIL = process.env.DEMO_EMAIL || 'kamil@kamil.com';
const PASSWORD = process.env.DEMO_PASSWORD || 'P@ssword1!';

let _cookieHeader = null;
let _setCookies = null;

async function loginOnce() {
  if (_cookieHeader) return { cookieHeader: _cookieHeader, setCookies: _setCookies };
  const res = await fetch(`${BASE_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  if (!res.ok) throw new Error(`Login failed: ${res.status} ${await res.text()}`);
  _setCookies = res.headers.getSetCookie?.() ?? [];
  _cookieHeader = _setCookies.map((c) => c.split(';')[0]).join('; ');
  return { cookieHeader: _cookieHeader, setCookies: _setCookies };
}

export async function api(path, init = {}) {
  const { cookieHeader } = await loginOnce();
  return fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: { ...(init.headers || {}), Cookie: cookieHeader },
  });
}

export async function createSession({ outDir, viewport = { width: 1440, height: 900 }, colorScheme = 'light' }) {
  await mkdir(outDir, { recursive: true });
  const { setCookies } = await loginOnce();
  const browser = await chromium.launch();
  const ctx = await browser.newContext({
    viewport,
    deviceScaleFactor: 2,
    colorScheme,
  });
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
  let hadFatalError = false;
  page.on('console', (msg) => {
    if (msg.type() === 'error') console.log('[page error]', msg.text().slice(0, 200));
  });
  page.on('pageerror', (e) => {
    console.log('[page exception]', e.message.slice(0, 200));
    if (/Invalid or unexpected token|ChunkLoadError|Cannot read properties of undefined/i.test(e.message || '')) {
      hadFatalError = true;
    }
  });

  async function gotoStable(url, { timeout = 90_000 } = {}) {
    let attempt = 0;
    while (attempt < 3) {
      attempt++;
      hadFatalError = false;
      try {
        await page.goto(`${BASE_URL}${url}`, { waitUntil: 'domcontentloaded', timeout });
        // Detect Next.js "Application error" screen and reload if we hit it.
        const isCrashed = await page.evaluate(
          () => /Application error: a client-side exception/i.test(document.body?.innerText || ''),
        );
        if (isCrashed || hadFatalError) {
          console.log(`[gotoStable] client-side exception on ${url}, reloading…`);
          await page.waitForTimeout(2000);
          await page.reload({ waitUntil: 'domcontentloaded', timeout }).catch(() => {});
          continue;
        }
        // Wait for project switcher's "Loading…" placeholder to clear.
        await page.waitForFunction(
          () => {
            const text = document.body?.innerText || '';
            return !text.includes('Loading…') && !text.includes('Loading...');
          },
          { timeout: 30_000 },
        ).catch(() => {});
        await page.waitForTimeout(900);
        // Close docs panel.
        await page.evaluate(() => {
          const btn = document.querySelector('button[aria-label="Close documentation"]');
          if (btn) btn.click();
        }).catch(() => {});
        await page.waitForTimeout(250);
        return;
      } catch (e) {
        if (attempt >= 3) throw e;
        await page.waitForTimeout(2500);
      }
    }
  }

  async function dismissOverlays() {
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(200);
  }

  // Click a button by visible text and wait for a Mantine/FormShell modal to open.
  // Retries the whole sequence (click + wait) because the page sometimes
  // re-renders right when the click lands and the first event gets dropped.
  async function openModalByButton(text, { timeout = 15_000, retries = 3 } = {}) {
    for (let i = 0; i < retries; i++) {
      try {
        const btn = page.locator(`button:has-text("${text}")`).first();
        await btn.waitFor({ state: 'visible', timeout: 15_000 });
        // Move mouse over the button to dispatch hover (matches real user gesture).
        await btn.hover().catch(() => {});
        await page.waitForTimeout(80);
        await btn.click({ force: true });
        await page.waitForSelector('[role="dialog"][aria-modal="true"]', { timeout });
        return;
      } catch (e) {
        if (i === retries - 1) {
          try {
            await page.screenshot({ path: '/tmp/openModal-fail.png' });
            const buttons = await page.evaluate(() => Array.from(document.querySelectorAll('button')).map((b) => b.textContent?.trim()).filter(Boolean).slice(0, 30));
            console.log('[openModalByButton fail] visible buttons:', JSON.stringify(buttons));
          } catch {}
          throw e;
        }
        await page.waitForTimeout(2000);
      }
    }
  }

  async function shot(name, urlOrAction, opts = {}) {
    if (typeof urlOrAction === 'string') {
      await gotoStable(urlOrAction);
    } else {
      await urlOrAction({ page, gotoStable, dismissOverlays, openModalByButton });
    }
    if (opts.afterLoad) await opts.afterLoad({ page, gotoStable, dismissOverlays, openModalByButton });
    if (opts.scrollTo != null) {
      await page.evaluate((y) => window.scrollTo(0, y), opts.scrollTo);
      await page.waitForTimeout(250);
    }
    const filePath = resolve(outDir, `${name}.png`);
    await page.screenshot({ path: filePath, fullPage: !!opts.fullPage });
    console.log(`saved ${filePath}`);
    return filePath;
  }

  return {
    page,
    browser,
    ctx,
    shot,
    gotoStable,
    dismissOverlays,
    openModalByButton,
    close: async () => browser.close(),
  };
}

export { BASE_URL };
