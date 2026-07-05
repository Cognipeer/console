import { resolve } from 'node:path';
import { createSession } from './lib.mjs';

const OUT_DIR = resolve(process.cwd(), 'docs/public/screenshots/websearch');

const sess = await createSession({ outDir: OUT_DIR });

await sess.shot('01-websearch-list', '/dashboard/websearch');

await sess.shot('02-create-instance', async ({ page, gotoStable, openModalByButton }) => {
  await gotoStable('/dashboard/websearch');
  await openModalByButton('Create instance');
  await page.waitForTimeout(900);
});

await sess.shot('03-instance-playground', async ({ page, gotoStable }) => {
  await gotoStable('/dashboard/websearch/duckduckgo-main');
  const input = page.locator('input[aria-label="Search query"]');
  await input.waitFor({ state: 'visible', timeout: 30_000 });
  await input.fill('open source metasearch engines');
  // Enter submits the playground form; clicking "Search" by text risks hitting
  // the topbar's command-palette trigger instead.
  await input.press('Enter');
  // Wait for live results to render.
  await page.waitForSelector('a:has-text("1.")', { timeout: 45_000 }).catch(() => {});
  await page.waitForTimeout(600);
});

await sess.shot('04-instance-logs', async ({ page, gotoStable }) => {
  await gotoStable('/dashboard/websearch/duckduckgo-main');
  await page.locator('text="Logs"').first().click();
  await page.waitForTimeout(1200);
});

await sess.shot('05-instance-config', async ({ page, gotoStable }) => {
  await gotoStable('/dashboard/websearch/duckduckgo-main');
  await page.locator('text="Configuration"').first().click();
  await page.waitForTimeout(1500);
});

await sess.close();
