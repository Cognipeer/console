/**
 * Outbound JSON POST shared by the chat and paging channels. Always through
 * `safeFetch` (private ranges blocked, DNS pinned, no redirects). Failures are
 * returned, never thrown, and the error text is scrubbed of the credentials of
 * the channel so nothing secret reaches an event record or a log line.
 */

import { getConfig } from '@/lib/core/config';
import { createLogger } from '@/lib/core/logger';
import { safeFetch } from '@/lib/security/outboundFetch';
import type { IAlertChannel } from '@/lib/database';
import { unsealChannel, type UnsealedAlertChannel } from './channelSecrets';
import type { DispatchResult } from './types';

export interface PostJsonResult {
  ok: boolean;
  status?: number;
  /** First characters of the response body (error responses only). */
  detail?: string;
  error?: string;
}

const MAX_DETAIL_CHARS = 160;

export function channelTimeoutMs(): number {
  try {
    return getConfig().health.alertChannelTimeoutMs;
  } catch {
    return 10_000;
  }
}

/** Replace every occurrence of a credential (and its URL-encoded form) with a marker. */
export function scrubSecrets(text: string, secrets: Array<string | undefined | null>): string {
  let out = text;
  for (const secret of secrets) {
    if (!secret || secret.length < 4) continue;
    for (const variant of new Set([secret, encodeURI(secret), encodeURIComponent(secret)])) {
      out = out.split(variant).join('[redacted]');
    }
  }
  return out;
}

export function errorMessage(error: unknown, secrets: Array<string | undefined | null> = []): string {
  const name = (error as { name?: unknown } | null)?.name;
  const message = name === 'AbortError' || name === 'TimeoutError'
    ? `Timed out after ${channelTimeoutMs()} ms`
    : error instanceof Error ? error.message : String(error);
  return scrubSecrets(message, secrets).slice(0, 300);
}

export async function postJson(
  url: string,
  body: unknown,
  options: {
    headers?: Record<string, string>;
    secrets?: Array<string | undefined | null>;
    /**
     * Echo the first characters of a non-2xx body. Only for fixed provider
     * hosts: user-chosen URLs (Slack, Teams) must not reflect their answer.
     */
    includeDetail?: boolean;
  } = {},
): Promise<PostJsonResult> {
  const secrets = [url, ...(options.secrets ?? [])];
  try {
    const response = await safeFetch(
      url,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'user-agent': 'Cognipeer-Alerts/1',
          ...options.headers,
        },
        body: JSON.stringify(body),
      },
      { followRedirects: false, timeoutMs: channelTimeoutMs() },
    );
    const status = response.status;
    if (status >= 200 && status < 300) {
      await response.body?.cancel().catch(() => undefined);
      return { ok: true, status };
    }
    let detail = '';
    if (options.includeDetail) {
      try {
        detail = (await response.text()).slice(0, MAX_DETAIL_CHARS);
      } catch {
        /* the status is the answer */
      }
    } else {
      await response.body?.cancel().catch(() => undefined);
    }
    const label = status >= 300 && status < 400 ? 'redirected (redirects are not followed)' : 'answered';
    return {
      ok: false,
      status,
      detail: scrubSecrets(detail, secrets),
      error: `Endpoint ${label} HTTP ${status}`,
    };
  } catch (error) {
    return { ok: false, error: errorMessage(error, secrets) };
  }
}

export function toDispatchResult(type: string, target: string, result: { ok: boolean; error?: string; detail?: string }): DispatchResult {
  if (result.ok) return { type, target, success: true };
  const error = [result.error, result.detail].filter(Boolean).join(': ') || 'Delivery failed';
  return { type, target, success: false, error };
}

const log = createLogger('alert-channels');

/** What a stored channel is called in a result or a log line: its hint, never its credential. */
export function channelTarget(channel: IAlertChannel): string {
  switch (channel.type) {
    case 'email':
      return (channel.recipients ?? []).join(', ') || '(owners and admins)';
    case 'pagerduty':
      return `pagerduty ${channel.keyHint ?? ''}`.trim();
    default:
      return channel.urlHint || channel.type;
  }
}

/** The channel's plaintext credentials, or a failed result when they cannot be read (rotated key, damaged payload). */
export function unsealOrFail<T extends UnsealedAlertChannel['type']>(
  channel: IAlertChannel,
  type: T,
): { channel: Extract<UnsealedAlertChannel, { type: T }> } | { failure: DispatchResult } {
  let cause: string | undefined;
  try {
    const plain = unsealChannel(channel);
    if (plain.type === type) return { channel: plain as Extract<UnsealedAlertChannel, { type: T }> };
    cause = 'type mismatch';
  } catch (e) {
    // the error name only, never its message (it could echo payload fragments)
    cause = e instanceof Error ? e.name : typeof e;
  }
  log.warn('Alert channel credentials could not be read', { channelId: channel.id, type: channel.type, cause });
  return {
    failure: {
      type: channel.type,
      target: channelTarget(channel),
      success: false,
      error: 'Channel credentials could not be read; save the channel again',
    },
  };
}

export function logDelivery(channel: IAlertChannel, result: DispatchResult): void {
  if (result.success) return;
  log.warn('Alert channel delivery failed', { channelId: channel.id, type: channel.type, error: result.error });
}
