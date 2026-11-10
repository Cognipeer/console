/**
 * Crawler webhook delivery goes through the shared guarded fetch.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { safeFetch } = vi.hoisted(() => ({ safeFetch: vi.fn() }));

vi.mock('@/lib/security/outboundFetch', () => ({
  safeFetch,
  OutboundNetworkError: class OutboundNetworkError extends Error {
    retryable = false;
  },
}));
vi.mock('@/lib/services/crawler/engine/ssrf', () => ({
  crawlerGuardOptions: (flag?: boolean) => ({ allowPrivate: Boolean(flag) && false }),
}));

import { OutboundNetworkError } from '@/lib/security/outboundFetch';
import { sendCrawlerWebhook } from '@/lib/services/crawler/crawlerWebhook';

const payload = { tenantId: 't1', jobId: 'j1', data: {} };

beforeEach(() => {
  safeFetch.mockReset();
});

describe('sendCrawlerWebhook', () => {
  it('posts signed JSON through safeFetch without following redirects', async () => {
    safeFetch.mockResolvedValue({ status: 200 });
    await sendCrawlerWebhook({
      webhook: { url: 'https://hook.example.com/x', secret: 's', events: ['completed'] },
      event: 'completed',
      payload,
    });
    expect(safeFetch).toHaveBeenCalledTimes(1);
    const [url, init, opts] = safeFetch.mock.calls[0];
    expect(url).toBe('https://hook.example.com/x');
    expect(init.method).toBe('POST');
    expect(init.headers['x-cognipeer-signature']).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
    expect(opts.followRedirects).toBe(false);
  });

  it('does not retry when the target is refused by the network policy', async () => {
    safeFetch.mockRejectedValue(new OutboundNetworkError('refused'));
    await sendCrawlerWebhook({
      webhook: { url: 'http://10.0.0.1/x', events: ['completed'] },
      event: 'completed',
      payload,
    });
    expect(safeFetch).toHaveBeenCalledTimes(1);
  });

  it('retries when the network error is marked retryable', async () => {
    vi.useFakeTimers();
    try {
      const err = Object.assign(new OutboundNetworkError('resolver error'), { retryable: true });
      safeFetch.mockRejectedValue(err);
      const done = sendCrawlerWebhook({
        webhook: { url: 'https://hook.example.com/x', events: ['completed'] },
        event: 'completed',
        payload,
      });
      await vi.advanceTimersByTimeAsync(10_000);
      await done;
      expect(safeFetch).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('skips events the webhook is not subscribed to', async () => {
    await sendCrawlerWebhook({
      webhook: { url: 'https://hook.example.com/x', events: ['failed'] },
      event: 'page',
      payload,
    });
    expect(safeFetch).not.toHaveBeenCalled();
  });
});
