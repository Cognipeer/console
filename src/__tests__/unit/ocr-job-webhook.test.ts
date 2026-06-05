/**
 * Unit tests — OCR job outbound webhook (`sendOcrJobWebhook`).
 * Covers delivery gating (no URL / event not subscribed), the `job.completed`
 * default subscription, HMAC signing, and the payload envelope shape.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('axios', () => ({
  default: { post: vi.fn() },
}));

import axios from 'axios';
import { sendOcrJobWebhook } from '@/lib/services/ocrJobs/ocrJobWebhook';

const post = axios.post as unknown as ReturnType<typeof vi.fn>;

function job(overrides: Record<string, unknown> = {}) {
  return {
    _id: 'job-1',
    tenantId: 'tenant-1',
    projectId: 'proj-1',
    callbackUrl: 'https://hook.example.com/ocr',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  post.mockResolvedValue({ status: 200, data: {} });
});

describe('sendOcrJobWebhook', () => {
  it('skips delivery (returns false) when the job has no callbackUrl', async () => {
    const ok = await sendOcrJobWebhook({
      job: job({ callbackUrl: undefined }),
      event: 'item.succeeded',
      data: {},
    });
    expect(ok).toBe(false);
    expect(post).not.toHaveBeenCalled();
  });

  it('skips delivery when the event is not in callbackEvents', async () => {
    const ok = await sendOcrJobWebhook({
      job: job({ callbackEvents: ['item.failed'] }),
      event: 'item.succeeded',
      data: {},
    });
    expect(ok).toBe(false);
    expect(post).not.toHaveBeenCalled();
  });

  it('delivers item.succeeded and returns true on a 2xx response', async () => {
    const ok = await sendOcrJobWebhook({
      job: job(),
      event: 'item.succeeded',
      data: { itemId: 'i-1' },
    });
    expect(ok).toBe(true);
    expect(post).toHaveBeenCalledTimes(1);
    const [url, body] = post.mock.calls[0];
    expect(url).toBe('https://hook.example.com/ocr');
    expect(body.event).toBe('ocr.item.succeeded');
    expect(body.jobId).toBe('job-1');
    expect(body.tenantId).toBe('tenant-1');
    expect(body.data).toEqual({ itemId: 'i-1' });
    expect(typeof body.id).toBe('string');
    expect(typeof body.createdAt).toBe('string');
  });

  it('delivers job.completed by default (no explicit callbackEvents)', async () => {
    const ok = await sendOcrJobWebhook({
      job: job(),
      event: 'job.completed',
      data: { itemsTotal: 3, itemsProcessed: 2, itemsFailed: 1 },
    });
    expect(ok).toBe(true);
    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0][1].event).toBe('ocr.job.completed');
  });

  it('attaches an HMAC signature header when a callbackSecret is set', async () => {
    await sendOcrJobWebhook({
      job: job({ callbackSecret: 's3cr3t' }),
      event: 'job.completed',
      data: {},
    });
    const headers = post.mock.calls[0][2].headers as Record<string, string>;
    expect(headers['x-cognipeer-signature']).toMatch(/^t=\d+,v1=[a-f0-9]{64}$/);
  });

  it('omits the signature header when no secret is configured', async () => {
    await sendOcrJobWebhook({ job: job(), event: 'item.succeeded', data: {} });
    const headers = post.mock.calls[0][2].headers as Record<string, string>;
    expect(headers['x-cognipeer-signature']).toBeUndefined();
  });
});
