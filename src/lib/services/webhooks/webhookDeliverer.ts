/**
 * The signed HTTP delivery shared by the agent-run callbacks and the webhook
 * subscriptions: one body, one signature scheme, one SSRF-guarded transport.
 *
 *   x-cognipeer-signature: t=<unix>,v1=<hex HMAC-SHA256(secret, "<t>.<body>")>
 *
 * (the crawler / OCR webhook scheme). The sender never throws: it reports what
 * happened, and each caller decides what that means — a callback job rethrows
 * so the queue retries; a subscription records the attempt and schedules its own.
 */

import crypto from 'node:crypto';
import { safeFetch } from '@/lib/security/outboundFetch';

/** `t=<unix>,v1=<hex HMAC-SHA256(secret, "<t>.<body>")>` */
export function signWebhookBody(secret: string, body: string, timestamp = Math.floor(Date.now() / 1000)): string {
  const signature = crypto.createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
  return `t=${timestamp},v1=${signature}`;
}

/**
 * How an attempt ended.
 *  - `delivered`: a 2xx.
 *  - `redirect`: a 3xx (only reported when redirects are not followed).
 *  - `blocked`: the SSRF guard refused the address.
 *  - `http_error`: any other status.
 *  - `network`: timeout, DNS or connection failure.
 */
export type WebhookSendOutcome = 'delivered' | 'redirect' | 'blocked' | 'http_error' | 'network';

export interface WebhookSendInput {
  url: string;
  /** The exact string that is signed and sent. */
  body: string;
  eventName: string;
  eventId: string;
  userAgent: string;
  /** No secret = unsigned (a run callback registered without one). */
  secret?: string;
  timeoutMs: number;
  /** Follow 3xx responses hop by hop (default). `false` = a 3xx is the answer. */
  followRedirects?: boolean;
  /** Also sent as `webhook-id` (the event id) when set. */
  webhookIdHeader?: boolean;
}

export interface WebhookSendResult {
  outcome: WebhookSendOutcome;
  ok: boolean;
  statusCode?: number;
  durationMs: number;
  error?: string;
}

export async function sendSignedWebhook(input: WebhookSendInput): Promise<WebhookSendResult> {
  const startedAt = Date.now();
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'user-agent': input.userAgent,
    'x-cognipeer-event': input.eventName,
    'x-cognipeer-event-id': input.eventId,
  };
  if (input.webhookIdHeader) headers['webhook-id'] = input.eventId;
  if (input.secret) headers['x-cognipeer-signature'] = signWebhookBody(input.secret, input.body);

  try {
    const response = await safeFetch(
      input.url,
      { method: 'POST', headers, body: input.body },
      { timeoutMs: input.timeoutMs, ...(input.followRedirects === false ? { followRedirects: false } : {}) },
    );
    await response.body?.cancel().catch(() => undefined);
    const durationMs = Date.now() - startedAt;
    const statusCode = response.status;
    if (statusCode >= 200 && statusCode < 300) return { outcome: 'delivered', ok: true, statusCode, durationMs };
    if (statusCode >= 300 && statusCode < 400) {
      return { outcome: 'redirect', ok: false, statusCode, durationMs, error: `Endpoint answered HTTP ${statusCode}` };
    }
    return { outcome: 'http_error', ok: false, statusCode, durationMs, error: `Endpoint answered HTTP ${statusCode}` };
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    // The guard aborts the request when `timeoutMs` runs out, and fetch reports that as a
    // bare "This operation was aborted". This sender passes no signal of its own, so an
    // abort here is the timeout: say so, or a slow receiver looks like a cancelled call.
    const name = (error as { name?: unknown } | null)?.name;
    const message = name === 'AbortError' || name === 'TimeoutError'
      ? `Timed out after ${input.timeoutMs} ms`
      : error instanceof Error ? error.message : String(error);
    // By name, not instanceof: the guard's error class is not importable from every test double of the module.
    // A failed DNS lookup says nothing about the address: it is a transient network
    // failure (retried), not a rejected target.
    const dnsFailure = (error as { code?: unknown } | null)?.code === 'dns_lookup_failed';
    const blocked = error instanceof Error && error.name === 'OutboundNetworkError' && !dnsFailure;
    return { outcome: blocked ? 'blocked' : 'network', ok: false, durationMs, error: message };
  }
}
