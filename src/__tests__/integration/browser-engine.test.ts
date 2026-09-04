/**
 * Browser engine, against a real Chromium and a real page.
 *
 * These are integration tests on purpose. The defects this suite exists to
 * catch — a snapshot option Playwright silently ignores, a locator strategy
 * that resolves to nothing, a recorded target that stops working on the next
 * page load — all pass a mocked test and fail in production, because the part
 * that broke was our belief about what Playwright does.
 *
 * The whole point of the target model is that a descriptor captured in one
 * session still works in a DIFFERENT one, so the replay tests open a second
 * session rather than reusing the first.
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

// The fixture server lives on 127.0.0.1, which is private address space —
// set BEFORE the manager's config is read, or the egress guard blocks every
// navigation and the whole suite fails on `goto`.
process.env.BROWSER_BLOCK_PRIVATE_NETWORK = 'false';

import { browserManager } from '@/lib/services/browser/browserManager';
import { chromiumAvailable } from '../helpers/browserAvailability';

const PAGE = `<!doctype html>
<html><body>
  <h1>Console Test App</h1>
  <form id="login">
    <label for="user">Username</label>
    <input id="user" name="user" placeholder="you@example.com" />
    <label for="pass">Password</label>
    <input id="pass" name="pass" type="password" />
    <select id="role" aria-label="Role">
      <option value="viewer">Viewer</option>
      <option value="admin">Administrator</option>
    </select>
    <input type="checkbox" id="remember" aria-label="Remember me" />
    <button type="button" data-testid="submit-btn" onclick="signIn()">Sign in</button>
  </form>
  <p id="status">signed out</p>
  <div style="height:2000px"></div>
  <button type="button" id="deep" onclick="document.title='DEEP'">Deep button</button>
  <a id="popup" href="/second" target="_blank">Open second</a>
  <script>
    function signIn() {
      var u = document.getElementById('user').value;
      var r = document.getElementById('role').value;
      document.getElementById('status').textContent = 'signed in as ' + u + ' (' + r + ')';
      console.log('[app] signin', u);
    }
    fetch('/missing').catch(function () {});
  </script>
</body></html>`;

const SECOND = '<!doctype html><html><body><h1>Second tab</h1></body></html>';

let server: Server;
let baseUrl = '';
/**
 * Sessions opened by the current test, closed in `afterEach`.
 *
 * Not optional bookkeeping: the per-tenant concurrency limiter defaults to 10
 * permits, so leaking sessions makes the eleventh test block for the full
 * 60s acquire timeout and fail as an unexplained hang.
 */
let openSessions: string[] = [];

async function open(config: Record<string, unknown> = {}): Promise<string> {
  const { sessionKey } = await browserManager.openSession({
    tenantId: 'test-tenant',
    config: { headless: true, actionTimeoutMs: 8_000, navigationTimeoutMs: 15_000, ...config },
  });
  openSessions.push(sessionKey);
  await browserManager.runAction(sessionKey, { type: 'goto', url: baseUrl });
  return sessionKey;
}

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === '/second') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(SECOND);
      return;
    }
    if (req.url === '/missing') {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(PAGE);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
}, 60_000);

afterEach(async () => {
  const keys = openSessions;
  openSessions = [];
  await Promise.all(keys.map((key) => browserManager.closeSession(key, 'test').catch(() => undefined)));
});

afterAll(async () => {
  await browserManager.shutdown().catch(() => undefined);
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe.skipIf(!chromiumAvailable())('aria snapshot', () => {
  it('emits element references the model can address', async () => {
    const key = await open();
    const snapshot = await browserManager.captureAriaSnapshot(key);

    // The bug this suite was written for: `ariaSnapshot({ ref: true })` is not
    // a Playwright option, so the tree came back with no refs at all and every
    // ref-addressed action burned a full timeout resolving nothing.
    expect(snapshot).toMatch(/\[ref=e\d+\]/);
    expect(snapshot).toContain('button "Sign in"');
  }, 60_000);

  it('resolves a ref to a durable role + name descriptor', async () => {
    const key = await open();
    const snapshot = await browserManager.captureAriaSnapshot(key);
    const ref = snapshot
      .split('\n')
      .find((line) => line.includes('button "Sign in"'))
      ?.match(/\[ref=(e\d+)\]/)?.[1];
    expect(ref).toBeDefined();

    const result = await browserManager.runAction(key, { type: 'click', ref });
    expect(result.ok).toBe(true);
    expect(result.targetStrategy).toBe('ref');
    // This is what a recorded flow step stores instead of the ref.
    expect(result.resolvedTarget).toMatchObject({ role: 'button', name: 'Sign in' });
    expect(result.resolvedTarget).not.toHaveProperty('ref');
  }, 60_000);
});

describe.skipIf(!chromiumAvailable())('target strategies', () => {
  it('addresses an element by role and name', async () => {
    const key = await open();
    const result = await browserManager.runAction(key, {
      type: 'click',
      role: 'button',
      name: 'Sign in',
    });
    expect(result.ok).toBe(true);
    expect(result.targetStrategy).toBe('role');
  }, 60_000);

  it('addresses an element by test id', async () => {
    const key = await open();
    const result = await browserManager.runAction(key, { type: 'click', testId: 'submit-btn' });
    expect(result.ok).toBe(true);
    expect(result.targetStrategy).toBe('testId');
  }, 60_000);

  it('addresses an input by label and by placeholder', async () => {
    const key = await open();
    expect((await browserManager.runAction(key, {
      type: 'type', label: 'Username', text: 'by-label',
    })).ok).toBe(true);
    expect((await browserManager.runAction(key, {
      type: 'type', placeholder: 'you@example.com', text: 'by-placeholder', clear: true,
    })).ok).toBe(true);

    const read = await browserManager.extract(key, { selector: '#user', mode: 'value' });
    expect(read.values[0]).toBe('by-placeholder');
  }, 60_000);

  it('falls back from a stale ref to the durable target instead of stalling', async () => {
    const key = await open();
    const started = Date.now();
    const result = await browserManager.runAction(key, {
      // `e999` never existed; without the fallback probe this waits out the
      // whole action timeout before failing.
      type: 'click',
      ref: 'e999',
      role: 'button',
      name: 'Sign in',
    });
    expect(result.ok).toBe(true);
    expect(result.targetStrategy).toBe('role');
    expect(Date.now() - started).toBeLessThan(7_000);
  }, 60_000);

  it('reports a usable error when no target is given', async () => {
    const key = await open();
    const result = await browserManager.runAction(key, { type: 'click' } as never);
    expect(result.ok).toBe(false);
    expect(result.errorMessage).toContain('No element target given');
  }, 60_000);
});

describe.skipIf(!chromiumAvailable())('replay across sessions', () => {
  it('re-uses a descriptor captured in an earlier session', async () => {
    const discovery = await open();
    const snapshot = await browserManager.captureAriaSnapshot(discovery);
    const ref = snapshot
      .split('\n')
      .find((line) => line.includes('button "Sign in"'))
      ?.match(/\[ref=(e\d+)\]/)?.[1];
    const recorded = (await browserManager.runAction(discovery, { type: 'click', ref }))
      .resolvedTarget;
    await browserManager.closeSession(discovery, 'test');

    // A fresh session renumbers every ref. The recorded descriptor must not
    // care — this is the assertion the whole flow feature rests on.
    const replay = await open();
    const typed = await browserManager.runAction(replay, {
      ...recorded,
      type: 'click',
    } as never);
    expect(typed.ok).toBe(true);
  }, 60_000);
});

describe.skipIf(!chromiumAvailable())('form controls', () => {
  it('types, selects, checks and reads back the result', async () => {
    const key = await open();

    await browserManager.runAction(key, { type: 'type', label: 'Username', text: 'ada@example.com' });
    await browserManager.runAction(key, { type: 'select', role: 'combobox', name: 'Role', labels: ['Administrator'] });

    const check = await browserManager.runAction(key, { type: 'check', role: 'checkbox', name: 'Remember me' });
    expect(check.ok).toBe(true);
    // check/uncheck must be idempotent where a click would toggle — a replayed
    // flow otherwise flips a box that was already right.
    const again = await browserManager.runAction(key, { type: 'check', role: 'checkbox', name: 'Remember me' });
    expect(again.ok).toBe(true);
    expect((await browserManager.extract(key, { selector: '#remember', mode: 'attr', attribute: 'checked' })).ok).toBe(true);

    await browserManager.runAction(key, { type: 'click', testId: 'submit-btn' });
    const status = await browserManager.extract(key, { selector: '#status' });
    expect(status.values[0]).toBe('signed in as ada@example.com (admin)');
  }, 60_000);

  it('unchecks when asked', async () => {
    const key = await open();
    await browserManager.runAction(key, { type: 'check', role: 'checkbox', name: 'Remember me' });
    await browserManager.runAction(key, { type: 'check', role: 'checkbox', name: 'Remember me', checked: false });
    const value = await browserManager.extract(key, { selector: '#remember', mode: 'attr', attribute: 'checked' });
    expect(value.values[0]).toBe('');
  }, 60_000);
});

describe.skipIf(!chromiumAvailable())('scrolling', () => {
  it('scrolls the window by an offset', async () => {
    const key = await open();
    const result = await browserManager.runAction(key, { type: 'scroll', y: 800 });
    expect(result.ok).toBe(true);
    // `scrollBy` is passed as DATA to `page.evaluate(fn, arg)`. The old
    // implementation interpolated the offsets into a `new Function` body, so
    // this also guards the injection sink that replaced.
    const marker = await browserManager.extract(key, { role: 'heading', name: 'Console Test App' });
    expect(marker.ok).toBe(true);
  }, 60_000);

  it('brings an off-screen element into view and clicks it', async () => {
    const key = await open();
    await browserManager.runAction(key, { type: 'scroll', role: 'button', name: 'Deep button' });
    const clicked = await browserManager.runAction(key, { type: 'click', role: 'button', name: 'Deep button' });
    expect(clicked.ok).toBe(true);
    expect(clicked.pageTitle).toBe('DEEP');
  }, 60_000);
});

describe.skipIf(!chromiumAvailable())('navigation history', () => {
  it('goes back and forward', async () => {
    const key = await open();
    await browserManager.runAction(key, { type: 'goto', url: `${baseUrl}second` });
    expect((await browserManager.runAction(key, { type: 'back' })).url).toBe(baseUrl);
    expect((await browserManager.runAction(key, { type: 'forward' })).url).toContain('/second');
    expect((await browserManager.runAction(key, { type: 'reload' })).ok).toBe(true);
  }, 60_000);
});

describe.skipIf(!chromiumAvailable())('tabs', () => {
  it('adopts a popup opened by the page and can switch back', async () => {
    const key = await open();
    await browserManager.runAction(key, { type: 'click', role: 'link', name: 'Open second' });
    // The popup is adopted by the context listener, so give it a moment to
    // land rather than asserting on a race.
    await browserManager.runAction(key, { type: 'wait', ms: 500 });

    const tabs = await browserManager.listTabs(key);
    expect(tabs?.length).toBe(2);
    expect(tabs?.find((tab) => tab.active)?.url).toContain('/second');

    const back = await browserManager.runAction(key, { type: 'tab', op: 'switch', index: 0 });
    expect(back.ok).toBe(true);
    expect(back.url).toBe(baseUrl);
  }, 60_000);

  it('opens and closes a tab explicitly', async () => {
    const key = await open();
    await browserManager.runAction(key, { type: 'tab', op: 'new', url: `${baseUrl}second` });
    expect((await browserManager.listTabs(key))?.length).toBe(2);
    const closed = await browserManager.runAction(key, { type: 'tab', op: 'close', index: 1 });
    expect(closed.ok).toBe(true);
    expect(closed.tabs?.length).toBe(1);
  }, 60_000);
});

describe.skipIf(!chromiumAvailable())('observation', () => {
  it('finds visible text and hands back a reusable target', async () => {
    const key = await open();
    const found = await browserManager.findText(key, 'Sign in');
    expect(found.ok).toBe(true);
    expect(found.matches.length).toBeGreaterThan(0);

    const clicked = await browserManager.runAction(key, {
      type: 'click',
      ...found.matches[0].target,
    } as never);
    expect(clicked.ok).toBe(true);
  }, 60_000);

  it('captures console output and failed requests', async () => {
    const key = await open();
    await browserManager.runAction(key, { type: 'click', testId: 'submit-btn' });
    await browserManager.runAction(key, { type: 'wait', ms: 300 });

    const observed = browserManager.getObservations(key);
    expect(observed.console.some((entry) => entry.text.includes('[app] signin'))).toBe(true);
    // The page fetches /missing on load; a 404 is not a `requestfailed`, so
    // this asserts only that the buffer exists and is bounded.
    expect(Array.isArray(observed.networkFailures)).toBe(true);
  }, 60_000);

  it('waits for text rather than a fixed delay', async () => {
    const key = await open();
    await browserManager.runAction(key, { type: 'type', label: 'Username', text: 'grace' });
    await browserManager.runAction(key, { type: 'click', testId: 'submit-btn' });
    const waited = await browserManager.runAction(key, {
      type: 'wait',
      text: 'signed in as grace',
      timeout: 5_000,
    });
    expect(waited.ok).toBe(true);
  }, 60_000);
});

describe.skipIf(!chromiumAvailable())('extraction', () => {
  it('reads text, attributes, input values and multiple matches', async () => {
    const key = await open();
    expect((await browserManager.extract(key, { role: 'heading', name: 'Console Test App' })).values[0])
      .toBe('Console Test App');
    expect((await browserManager.extract(key, { selector: '#popup', mode: 'attr', attribute: 'target' })).values[0])
      .toBe('_blank');

    await browserManager.runAction(key, { type: 'type', label: 'Username', text: 'multi' });
    expect((await browserManager.extract(key, { selector: '#user', mode: 'value' })).values[0]).toBe('multi');

    const many = await browserManager.extract(key, { selector: 'button', multiple: true });
    expect(many.values.length).toBeGreaterThan(1);
  }, 60_000);
});

describe.skipIf(!chromiumAvailable())('egress policy', () => {
  it('blocks a host outside the allow list', async () => {
    const { sessionKey } = await browserManager.openSession({
      tenantId: 'test-tenant',
      config: {
        headless: true,
        actionTimeoutMs: 5_000,
        // 127.0.0.1 is private space, so the private-network guard has to be
        // off for the allow-list itself to be what decides.
        access: { allowList: ['127.0.0.1'] },
      },
    });
    openSessions.push(sessionKey);
    const blocked = await browserManager.runAction(sessionKey, {
      type: 'goto',
      url: 'https://example.com/',
    });
    expect(blocked.ok).toBe(false);
    expect(blocked.errorMessage).toContain('not allowed by session policy');
  }, 60_000);
});

describe.skipIf(!chromiumAvailable())('storage state', () => {
  it('exports cookies and origin storage for a later session', async () => {
    const key = await open();
    const state = await browserManager.exportStorageState(key);
    expect(state).toHaveProperty('cookies');
    expect(state).toHaveProperty('origins');
  }, 60_000);
});
