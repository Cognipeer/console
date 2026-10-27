/**
 * The page header in a real Chromium with the app's own globals.css: the
 * actions stay beside the title while there is room, even under a subtitle
 * long enough to fill a line, and drop below only on a narrow header.
 *
 * Without a flex basis on the title block, the header's flex line breaks at
 * the title's one-line (max-content) width, so a long subtitle pushed the
 * actions under the title on any screen narrower than ~1440px.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser } from 'playwright';

const css = readFileSync(path.join(process.cwd(), 'src/app/globals.css'), 'utf8');

// Mirrors PageHeader's markup (src/components/common/ui/PageContainer.tsx).
const html = `<!doctype html><html><head><style>${css}</style>
<style>body { margin: 0; } .ds-page { padding: 0 24px; } button { padding: 6px 12px; white-space: nowrap; }</style></head>
<body><div class="ds-page"><header class="ds-page-header">
  <div>
    <div class="ds-eyebrow">Build · Agent</div>
    <h1 class="ds-h1">Cognipeer Engineer</h1>
    <p class="ds-muted" style="margin-top: 4px; font-size: 13.5px; max-width: 720px">Develops features and fixes across every Cognipeer
    repository in its own sandbox: branch, implement, test, open a PR. Fans out to sub-agents for broad investigation and self-review.</p>
  </div>
  <div class="ds-row ds-gap-sm" id="actions" style="flex-shrink: 0">
    <button>Compare</button><button>Start session</button><button>Published v6</button><button>Publish</button>
  </div>
</header></div></body></html>`;

let browser: Browser;

beforeAll(async () => {
  browser = await chromium.launch();
}, 60_000);

afterAll(async () => {
  await browser?.close();
});

async function actionsBesideTitle(width: number): Promise<boolean> {
  const page = await browser.newPage({ viewport: { width, height: 600 } });
  try {
    await page.setContent(html);
    return await page.evaluate(() => {
      const title = document.querySelector('.ds-page-header > :first-child')!.getBoundingClientRect();
      const actions = document.getElementById('actions')!.getBoundingClientRect();
      return Math.abs(actions.top - title.top) < 2;
    });
  } finally {
    await page.close();
  }
}

describe('page header actions', () => {
  it('stay beside a title with a long subtitle while the header has room', async () => {
    expect(await actionsBesideTitle(1440)).toBe(true);
    expect(await actionsBesideTitle(1200)).toBe(true);
    expect(await actionsBesideTitle(1000)).toBe(true);
  }, 60_000);

  it('drop below the title on a narrow header', async () => {
    expect(await actionsBesideTitle(560)).toBe(false);
  }, 60_000);
});
