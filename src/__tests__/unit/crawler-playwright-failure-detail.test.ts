/**
 * A navigation that fails says why. Playwright's own message for a stalled page
 * is "Timeout 10000ms exceeded", which names no cause; the crawler appends what
 * the page was still waiting on and which requests failed, so an error row tells
 * a firewall that drops the page itself from a third-party script that never
 * answers. Driven through the real PlaywrightSession with a fake Chromium page.
 */
import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { chromium } from 'playwright';
import { PlaywrightSession } from '@/lib/services/crawler/engine/playwrightFetcher';

vi.mock('playwright', () => ({ chromium: { launch: vi.fn() } }));

interface FakeRequest {
  url: () => string;
  resourceType: () => string;
  isNavigationRequest: () => boolean;
  failure: () => { errorText: string } | null;
}

const TIMEOUT = 'page.goto: Timeout 10000ms exceeded.\nCall log:\n  - navigating to "https://example.com/", waiting until "domcontentloaded"';

function request(url: string, resourceType = 'script', over: Partial<FakeRequest> = {}): FakeRequest {
  return {
    url: () => url,
    resourceType: () => resourceType,
    isNavigationRequest: () => resourceType === 'document',
    failure: () => null,
    ...over,
  };
}

/** What happens on the page between `goto` starting and failing. */
type Activity = (page: EventEmitter) => void;

async function failedNavigation(activity: Activity, error: Error = new Error(TIMEOUT)): Promise<string> {
  const page = new EventEmitter() as EventEmitter & Record<string, unknown>;
  page.waitForEvent = () => new Promise(() => undefined); // no download ever starts
  page.close = async () => undefined;
  page.goto = async () => {
    activity(page);
    throw error;
  };
  const context = {
    addInitScript: vi.fn(async () => undefined),
    addCookies: vi.fn(async () => undefined),
    route: vi.fn(async () => undefined),
    newPage: vi.fn(async () => page),
  };
  vi.mocked(chromium.launch).mockResolvedValue({
    newContext: vi.fn(async () => context),
    close: vi.fn(async () => undefined),
  } as never);

  const session = new PlaywrightSession({ timeoutMs: 10_000 }, []);
  try {
    await session.fetch('https://example.com/');
  } catch (caught) {
    return (caught as Error).message;
  } finally {
    await session.close();
  }
  throw new Error('expected the navigation to fail');
}

beforeEach(() => {
  vi.mocked(chromium.launch).mockReset();
});

describe('failed navigation — what the page was waiting on', () => {
  it('names a script that never answered, so a stalled third party is visible', async () => {
    const message = await failedNavigation((page) => {
      const doc = request('https://example.com/', 'document');
      page.emit('request', doc);
      page.emit('requestfinished', doc);
      page.emit('request', request('https://consent.example.net/loader.js?site=abc&token=SECRET', 'script'));
    });

    expect(message).toContain('page.goto: Timeout 10000ms exceeded.');
    expect(message).toContain('[navigation chain: https://example.com/]');
    expect(message).toContain('[still waiting on: https://consent.example.net/loader.js (script)]');
    // the finished document is not "waiting"
    expect(message).not.toMatch(/waiting on:[^\]]*https:\/\/example\.com\/ \(document\)/);
  });

  it('names the page itself when its own document never answered', async () => {
    const message = await failedNavigation((page) => {
      page.emit('request', request('https://example.com/', 'document'));
    });

    expect(message).toContain('[still waiting on: https://example.com/ (document)]');
  });

  it('never repeats a query string or fragment, which can carry tokens', async () => {
    const message = await failedNavigation((page) => {
      page.emit('request', request('https://cdn.example.net/a.js?key=SECRET#frag', 'script'));
      page.emit('requestfailed', request('https://api.example.net/x?auth=SECRET2', 'xhr', {
        failure: () => ({ errorText: 'net::ERR_CONNECTION_RESET' }),
      }));
    });

    expect(message).not.toContain('SECRET');
    expect(message).not.toContain('frag');
    expect(message).toContain('https://cdn.example.net/a.js (script)');
    expect(message).toContain('[failed requests: https://api.example.net/x (net::ERR_CONNECTION_RESET)]');
  });

  it('does not list requests that finished or failed', async () => {
    const message = await failedNavigation((page) => {
      const done = request('https://static.example.net/app.css', 'stylesheet');
      page.emit('request', done);
      page.emit('requestfinished', done);
      const failed = request('https://static.example.net/gone.js', 'script', {
        failure: () => ({ errorText: 'net::ERR_NAME_NOT_RESOLVED' }),
      });
      page.emit('request', failed);
      page.emit('requestfailed', failed);
    });

    expect(message).not.toContain('still waiting on');
    expect(message).toContain('[failed requests: https://static.example.net/gone.js (net::ERR_NAME_NOT_RESOLVED)]');
    expect(message).not.toContain('app.css');
  });

  it('ignores the failures the crawler or the browser causes itself', async () => {
    const message = await failedNavigation((page) => {
      for (const errorText of ['net::ERR_BLOCKED_BY_CLIENT', 'net::ERR_ABORTED']) {
        const r = request(`https://t.example.net/${errorText}.js`, 'script', { failure: () => ({ errorText }) });
        page.emit('request', r);
        page.emit('requestfailed', r);
      }
    });

    expect(message).not.toContain('failed requests');
    expect(message).not.toContain('ERR_');
  });

  it('keeps the list short and says how many it left out', async () => {
    const message = await failedNavigation((page) => {
      for (let i = 1; i <= 8; i++) page.emit('request', request(`https://cdn.example.net/chunk-${i}.js`, 'script'));
    });

    expect(message).toContain('chunk-1.js (script)');
    expect(message).toContain('chunk-5.js (script)');
    expect(message).not.toContain('chunk-6.js');
    expect(message).toContain('and 3 more]');
  });

  it('leaves the message as Playwright wrote it when the page did nothing worth reporting', async () => {
    const message = await failedNavigation(() => undefined, new Error('page.goto: net::ERR_CONNECTION_REFUSED at https://example.com/'));

    expect(message).toBe('page.goto: net::ERR_CONNECTION_REFUSED at https://example.com/');
  });

  it('keeps only the first line of Playwright’s message, as before', async () => {
    const message = await failedNavigation((page) => {
      page.emit('request', request('https://example.com/', 'document'));
    });

    expect(message).not.toContain('Call log');
  });
});
