import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import { createSession, BASE_URL } from './lib.mjs';

const OUT_DIR = resolve(process.cwd(), 'docs/public/screenshots/getting-started');
await mkdir(OUT_DIR, { recursive: true });

// Login screenshot is anonymous — no cookies, no project context.
{
  const browser = await chromium.launch();
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
    colorScheme: 'light',
  });
  const page = await ctx.newPage();
  await page.goto(`${BASE_URL}/login`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => /Sign in|Welcome back|E-?mail/i.test(document.body.innerText || ''),
    { timeout: 20_000 },
  );
  await page.waitForTimeout(800);
  await page.screenshot({ path: resolve(OUT_DIR, '01-login.png'), fullPage: false });
  console.log('saved 01-login.png');

  await page.goto(`${BASE_URL}/register`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => /Create your workspace|Register|Sign up|Company name/i.test(document.body.innerText || ''),
    { timeout: 20_000 },
  ).catch(() => {});
  await page.waitForTimeout(600);
  await page.screenshot({ path: resolve(OUT_DIR, '02-register.png'), fullPage: false });
  console.log('saved 02-register.png');

  await browser.close();
}

// Authenticated screenshots.
const sess = await createSession({ outDir: OUT_DIR });

// 03 — Dashboard overview after login.
await sess.shot('03-dashboard-overview', async ({ page, gotoStable }) => {
  await gotoStable('/dashboard');
  // Wait for overview header.
  await page.waitForFunction(
    () => /Overview|Dashboard|Welcome/i.test(document.body.innerText || ''),
    { timeout: 25_000 },
  );
  await page.waitForTimeout(800);
});

// 04 — Services launcher (the "App Switcher" grid).
await sess.shot('04-services-launcher', async ({ page, gotoStable }) => {
  await gotoStable('/dashboard');
  // Click the services launcher button in the header.
  const launcher = page.locator('button:has-text("Services"), button[aria-label="All services"]').first();
  await launcher.waitFor({ state: 'visible', timeout: 10_000 });
  await launcher.click();
  await page.waitForTimeout(800);
});

await sess.close();
console.log('getting-started capture done');
