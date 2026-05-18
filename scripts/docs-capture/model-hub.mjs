import { resolve } from 'node:path';
import { api, createSession } from './lib.mjs';

const OUT_DIR = resolve(process.cwd(), 'docs/public/screenshots/model-hub');

// Resolve a model id from the project so detail/edit shots aren't blank.
const list = await api('/api/models').then((r) => (r.ok ? r.json() : { models: [] }));
const preferred = list.models?.find((m) => /gpt-4o|gpt-5|gpt-4/i.test(m.name || m.key || ''));
const modelId = preferred?._id ?? list.models?.[0]?._id;
if (!modelId) {
  console.error('No models in project — cannot capture detail/edit.');
  process.exit(1);
}
console.log('using modelId:', modelId);

const sess = await createSession({ outDir: OUT_DIR });

// 01 — Overview (list page)
await sess.shot('01-model-hub-overview', '/dashboard/models');

// 02 — Providers
await sess.shot('02-providers', '/dashboard/providers');

// 03 — Create-model modal (click button on list page)
await sess.shot('03-create-model-modal', async ({ page, gotoStable }) => {
  await gotoStable('/dashboard/models');
  // Use Playwright's native click — it dispatches real mouse events that React
  // event delegation handles reliably (plain el.click() sometimes fails when
  // the event bubbles through Mantine's portal-aware listeners).
  const createBtn = page.locator('button:has-text("Create Model")').first();
  await createBtn.waitFor({ state: 'visible', timeout: 20_000 });
  await createBtn.click();
  await page.waitForSelector('[role="dialog"][aria-modal="true"]', { timeout: 15_000 });
  // Wait for the "Deploy model" title to actually render inside it.
  await page.waitForFunction(
    () => {
      const dlg = document.querySelector('[role="dialog"][aria-modal="true"]');
      return !!dlg && /Deploy model/i.test(dlg.textContent || '');
    },
    { timeout: 8_000 },
  ).catch(() => {});
  await page.waitForTimeout(900);
});

// 04 — Model detail (deep link). Wait for the Overview tab content to render.
await sess.shot('04-model-detail', async ({ page, gotoStable }) => {
  await gotoStable(`/dashboard/models/${modelId}`);
  // The detail page renders a tab list ("Overview", "Playground", ...).
  // Wait for it to appear instead of relying on networkidle.
  await page.waitForFunction(
    () => {
      const tabs = Array.from(document.querySelectorAll('[role="tab"]'));
      return tabs.some((t) => /Overview|Genel/i.test(t.textContent || ''));
    },
    { timeout: 25_000 },
  );
  // Then wait for the Performance card title to render — that's a strong signal
  // the data has arrived.
  await page.waitForFunction(
    () => /Performance|Performans/i.test(document.body.innerText || ''),
    { timeout: 25_000 },
  );
  await page.waitForTimeout(600);
});

// 05 — Edit model
await sess.shot('05-model-edit', async ({ page, gotoStable }) => {
  await gotoStable(`/dashboard/models/${modelId}/edit`);
  await page.waitForFunction(
    () => /Edit |Düzenle|Save changes|Kaydet/i.test(document.body.innerText || ''),
    { timeout: 20_000 },
  );
  await page.waitForTimeout(500);
});

await sess.close();
console.log('model-hub capture done');
