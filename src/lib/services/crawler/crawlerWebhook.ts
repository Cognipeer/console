/**
 * Outbound webhook delivery.
 *
 * Faz 1: best-effort POST with HMAC signature and in-process retry
 * (3 attempts, 1s/2s/4s backoff). Persistent delivery log + per-event
 * DB record arrives in Faz 2.
 */

import crypto from 'node:crypto';
import axios from 'axios';
import { createLogger } from '@/lib/core/logger';
import type { ICrawlerWebhookConfig, CrawlerWebhookEvent } from '@/lib/database';
import { assertSafeUrl } from './engine/ssrf';

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
  event: CrawlerWebhookEvent;
  payload: Omit<WebhookPayload<T>, 'id' | 'event' | 'createdAt'>;
}

export async function sendCrawlerWebhook<T>(input: SendWebhookInput<T>): Promise<void> {
  const url = input.overrideUrl ?? input.webhook?.url;
  if (!url) return;
  const events = input.webhook?.events ?? ['page', 'completed', 'failed'];
  if (!events.includes(input.event)) return;

  // Webhooks always target external systems the tenant owns — never allow
  // delivery to private/loopback/link-local/metadata hosts (SSRF hardening).
  // Unlike crawl targets, there is no legitimate opt-in here.
  try {
    assertSafeUrl(url);
  } catch (err) {
    log.warn('Refusing to deliver webhook to private/loopback host', {
      url,
      event: input.event,
      jobId: input.payload.jobId,
      error: err instanceof Error ? err.message : String(err),
    });
    return;
  }

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
      await axios.post(url, body, {
        headers,
        timeout: DEFAULT_TIMEOUT_MS,
        validateStatus: (s) => s >= 200 && s < 300,
        // Do not follow redirects: a public URL could 3xx to a private/
        // metadata host, bypassing the assertSafeUrl check above (SSRF via
        // redirect). Webhook receivers should respond directly.
        maxRedirects: 0,
      });
      return;
    } catch (err) {
      lastErr = err;
      if (attempt < DEFAULT_ATTEMPTS - 1) {
        await new Promise((r) => setTimeout(r, 1000 * Math.pow(2, attempt)));
      }
    }
  }
  log.warn('Webhook delivery failed after retries', {
    url,
    event: body.event,
    jobId: input.payload.jobId,
    error: lastErr instanceof Error ? lastErr.message : String(lastErr),
  });
}
