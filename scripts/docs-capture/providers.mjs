import { resolve } from 'node:path';
import { api, createSession } from './lib.mjs';

const OUT_DIR = resolve(process.cwd(), 'docs/public/screenshots/providers');

// Resolve a provider id for the detail screenshot.
const provList = await api('/api/providers').then((r) => (r.ok ? r.json() : { providers: [] }));
const providerId = provList.providers?.find((p) => /Model|model/i.test(p.type))?._id ?? provList.providers?.[0]?._id;
console.log('using providerId:', providerId);

const sess = await createSession({ outDir: OUT_DIR });

await sess.shot('01-providers-list', '/dashboard/providers');

await sess.shot('02-add-provider-domain', async ({ page, gotoStable, openModalByButton }) => {
  await gotoStable('/dashboard/providers');
  await openModalByButton('Add provider');
  await page.waitForTimeout(900);
});

await sess.shot('03-add-provider-driver', async ({ page, gotoStable, openModalByButton }) => {
  await gotoStable('/dashboard/providers');
  await openModalByButton('Add provider');
  await page.waitForTimeout(700);
  // The domain dropdown defaults to "All domains" — switch to "Model" to filter.
  const domainSelect = page.locator('[role="dialog"] select, [role="dialog"] [data-domain-select]').first();
  await domainSelect.selectOption({ label: 'Model' }).catch(async () => {
    // Fallback: click into Mantine-style select and pick Model.
    const trigger = page.locator('[role="dialog"] >> text=All domains').first();
    await trigger.click().catch(() => {});
    await page.locator('[role="option"]:has-text("Model")').first().click().catch(() => {});
  });
  await page.waitForTimeout(900);
});

// Provider detail (/dashboard/providers/:id) intentionally skipped — first dev-mode
// compile exceeds 120s and would burn the capture run. List + modal cover the
// 99% case.

await sess.close();
console.log('providers capture done');
