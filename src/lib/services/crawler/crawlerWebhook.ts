/**
 * Outbound webhook delivery.
 *
 * Faz 1: best-effort POST with HMAC signature and in-process retry
 * (3 attempts, 1s/2s/4s backoff). Persistent delivery log + per-event
 * DB record arrives in Faz 2.
 */

import crypto from 'node:crypto';
import { createLogger } from '@/lib/core/logger';
import type { ICrawlerWebhookConfig, CrawlerWebhookEvent } from '@/lib/database';
import { OutboundNetworkError, safeFetch } from '@/lib/security/outboundFetch';
import { crawlerGuardOptions } from './engine/ssrf';

const log = createLogger('crawler:webhook');

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_ATTEMPTS = 3;

export interface WebhookPayload<T = unknown> {
  id: string;
  event: `crawl.${CrawlerWebhookEvent}`;
  createdAt: string;
  tenantId: string;
  projectId?: string;
  crawlerKey?: string;
  jobId: string;
  data: T;
}

export interface SendWebhookInput<T = unknown> {
  webhook: ICrawlerWebhookConfig | undefined;
  /** Per-run override; if provided, used instead of `webhook.url`. */
  overrideUrl?: string;
  /** Secret used for signing when `webhook` is missing but overrideUrl is set. */
  overrideSecret?: string;
  /**
   * Mirrors the crawler's own `http.allowPrivateNetwork` opt-in: a tenant
   * that has explicitly accepted the risk of crawling private/internal
   * hosts is trusted to also receive webhooks there (e.g. an internal
   * notification service on the same network).
   */
  allowPrivateNetwork?: boolean;
  event: CrawlerWebhookEvent;
  payload: Omit<WebhookPayload<T>, 'id' | 'event' | 'createdAt'>;
}

export async function sendCrawlerWebhook<T>(input: SendWebhookInput<T>): Promise<void> {
  const url = input.overrideUrl ?? input.webhook?.url;
  if (!url) return;
  const events = input.webhook?.events ?? ['page', 'completed', 'failed'];
  if (!events.includes(input.event)) return;

  const secret = input.overrideSecret ?? input.webhook?.secret;

  const body: WebhookPayload<T> = {
    id: `evt_${crypto.randomUUID().replace(/-/g, '')}`,
    event: `crawl.${input.event}` as WebhookPayload<T>['event'],
    createdAt: new Date().toISOString(),
    ...input.payload,
  };

  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'user-agent': 'cognipeer-crawler/1.0',
  };
  if (secret) {
    const t = Math.floor(Date.now() / 1000);
    const bodyJson = JSON.stringify(body);
    const sig = crypto
      .createHmac('sha256', secret)
      .update(`${t}.${bodyJson}`)
      .digest('hex');
    headers['x-cognipeer-signature'] = `t=${t},v1=${sig}`;
  }

  let lastErr: unknown;
  for (let attempt = 0; attempt < DEFAULT_ATTEMPTS; attempt++) {
    try {
      // safeFetch resolves the host, pins the connection to the validated
      // address and does not follow redirects here: receivers respond directly.
      const response = await safeFetch(
        url,
        { method: 'POST', headers, body: JSON.stringify(body) },
        {
          ...crawlerGuardOptions(input.allowPrivateNetwork),
          timeoutMs: DEFAULT_TIMEOUT_MS,
          followRedirects: false,
        },
      );
      if (response.status >= 200 && response.status < 300) return;
      lastErr = new Error(`Webhook responded with status ${response.status}`);
    } catch (err) {
      lastErr = err;
      // A refused target will not change between attempts; transient
      // failures (for example a resolver error) are retried.
      if (err instanceof OutboundNetworkError && !err.retryable) break;
    }
    if (attempt < DEFAULT_ATTEMPTS - 1) {
      await new Promise((r) => setTimeout(r, 1000 * Math.pow(2, attempt)));
    }
  }
  log.warn('Webhook delivery failed after retries', {
    url,
    event: body.event,
    jobId: input.payload.jobId,
    error: lastErr instanceof Error ? lastErr.message : String(lastErr),
  });
}
