import { resolve } from 'node:path';
import { createSession } from './lib.mjs';

const sess = await createSession({ outDir: resolve(process.cwd(), 'docs/public/screenshots') });

async function captureUntilNoLoading(name, url, expectText) {
  await sess.shot(name, async ({ page, gotoStable }) => {
    await gotoStable(url);
    // Stronger wait: insist on "Loading…" being absent everywhere, AND that the
    // expected page body text is present.
    await page.waitForFunction(
      ({ expect }) => {
        const text = document.body?.innerText || '';
        if (text.includes('Loading…') || text.includes('Loading...')) return false;
        return new RegExp(expect, 'i').test(text);
      },
      { expect: expectText },
      { timeout: 45_000 },
    ).catch(() => {});
    // Wait for any visible spinner inside the main content area to disappear.
    await page.waitForFunction(
      () => !document.querySelector('.mantine-Loader-root'),
      { timeout: 20_000 },
    ).catch(() => {});
    await page.waitForTimeout(1200);
  });
}

await captureUntilNoLoading('prompts/01-prompts-list', '/dashboard/prompts', 'Prompt Studio|Prompts');
await captureUntilNoLoading('rag/01-rag-list', '/dashboard/rag', 'Knowledge Engine|RAG');

await sess.close();
console.log('fixup done');
