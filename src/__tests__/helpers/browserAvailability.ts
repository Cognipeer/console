/**
 * Is a real Chromium available to run browser integration tests against?
 *
 * The browser suites are integration tests on purpose — the defects they
 * exist to catch (a Playwright option that is silently ignored, a locator
 * that resolves to nothing, a recorded target that stops working on the next
 * page load) all pass a mocked test and fail in production. That means they
 * need a browser binary, which CI installs explicitly and a developer's
 * checkout may not have.
 *
 * Missing browsers SKIP rather than fail: a developer who has not run
 * `npx playwright install chromium` should see a clear skip, not 34 red
 * tests that say nothing about their change. CI installs the binary, so the
 * coverage is real where it counts.
 */

let cached: boolean | undefined;

export function chromiumAvailable(): boolean {
  if (cached !== undefined) return cached;
  try {
    // `executablePath()` resolves the browser Playwright would launch and
    // throws when the download is missing — cheaper and more accurate than
    // probing the cache directory ourselves.
    const { chromium } = require('playwright') as {
      chromium: { executablePath(): string };
    };
    const path = chromium.executablePath();
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    cached = Boolean(path) && (require('node:fs') as typeof import('node:fs')).existsSync(path);
  } catch {
    cached = false;
  }
  if (!cached) {
    console.warn(
      '[browser tests] Skipped: no Chromium available. Run `npx playwright install chromium` to run them.',
    );
  }
  return cached;
}
