import { resolve } from 'node:path';
import { api, createSession } from './lib.mjs';

const OUT_DIR = resolve(process.cwd(), 'docs/public/screenshots/inference');

// Find any model so we can capture the playground.
const list = await api('/api/models').then((r) => (r.ok ? r.json() : { models: [] }));
const modelId = list.models?.find((m) => m.category === 'llm')?._id ?? list.models?.[0]?._id;
console.log('using modelId:', modelId);

const sess = await createSession({ outDir: OUT_DIR });

// 01 — Inference Monitoring dashboard
await sess.shot('01-inference-monitoring', async ({ page, gotoStable }) => {
  await gotoStable('/dashboard/inference-monitoring');
  await page.waitForFunction(
    () => /Inference|Servers|Total|Calls|Tokens|Sessions/i.test(document.body.innerText || ''),
    { timeout: 25_000 },
  );
  await page.waitForTimeout(800);
});

// 02 — Model playground tab (the chat sandbox bound to a model)
if (modelId) {
  await sess.shot('02-model-playground', async ({ page, gotoStable }) => {
    await gotoStable(`/dashboard/models/${modelId}`);
    // Wait for tabs.
    await page.waitForFunction(
      () => Array.from(document.querySelectorAll('[role="tab"]')).some((t) => /Playground/i.test(t.textContent || '')),
      { timeout: 25_000 },
    );
    // Click Playground tab.
    await page.locator('[role="tab"]:has-text("Playground")').first().click();
    await page.waitForFunction(
      () => /Send a message|System prompt|Type your message/i.test(document.body.innerText || ''),
      { timeout: 20_000 },
    ).catch(() => {});
    await page.waitForTimeout(900);
  });
}

// 03 — Model logs tab
if (modelId) {
  await sess.shot('03-model-logs', async ({ page, gotoStable }) => {
    await gotoStable(`/dashboard/models/${modelId}`);
    await page.locator('[role="tab"]:has-text("Logs")').first().click();
    await page.waitForTimeout(1500);
  });
}

await sess.close();
console.log('inference capture done');
