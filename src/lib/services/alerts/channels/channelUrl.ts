/**
 * Save-time checks for channel destinations. The SSRF guard runs again,
 * pinned, on every delivery; this is the early, readable refusal.
 */

import { assertPublicUrl } from '@/lib/security/outboundFetch';

export const MAX_CHANNEL_URL_LENGTH = 2_048;
/** PagerDuty Events API v2 integration (routing) keys are 32 alphanumeric characters. */
export const PAGERDUTY_ROUTING_KEY_PATTERN = /^[A-Za-z0-9]{32}$/;

/** A refusal whose message is safe to show to the person saving the channel. */
export class ChannelUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChannelUrlError';
  }
}

export function isValidPagerDutyRoutingKey(value: unknown): value is string {
  return typeof value === 'string' && PAGERDUTY_ROUTING_KEY_PATTERN.test(value.trim());
}

/**
 * The trimmed URL when it is an https address that resolves to a public host.
 * Throws `ChannelUrlError` otherwise (never echoes the URL back).
 */
export async function assertPublicChannelUrl(value: unknown): Promise<string> {
  if (typeof value !== 'string' || !value.trim()) throw new ChannelUrlError('url is required');
  const url = value.trim();
  if (url.length > MAX_CHANNEL_URL_LENGTH) {
    throw new ChannelUrlError(`url must be at most ${MAX_CHANNEL_URL_LENGTH} characters`);
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ChannelUrlError('url is not a valid URL');
  }
  if (parsed.protocol !== 'https:') throw new ChannelUrlError('url must use https');
  if (parsed.username || parsed.password) throw new ChannelUrlError('url must not contain credentials');
  try {
    await assertPublicUrl(url);
  } catch {
    throw new ChannelUrlError('url must resolve to a public address');
  }
  return url;
}
