/**
 * Channel secret handling: seal on write, mask on read, unseal for delivery.
 *
 * Stored channels keep their credentials (webhook/Slack/Teams URLs, webhook
 * signing secret, PagerDuty routing key) only inside `sealed`, an
 * `encryptObject` payload. APIs and resource mappers return `maskChannels`
 * output: the stored shape WITHOUT `sealed`, plus a short hint so people can
 * recognise which destination a channel points at. Plaintext is read back only
 * by `unsealChannel`, inside the dispatchers.
 */

import { randomBytes } from 'node:crypto';
import { decryptObject, encryptObject } from '@/lib/utils/crypto';
import type { AlertChannelInput, IAlertChannel } from '@/lib/database';

const CHANNEL_ID_PATTERN = /^ch_[0-9a-f]{12}$/;
const HINT_TAIL = 4;

/** A channel with its credentials in the clear. Internal: never return it from an API. */
export type UnsealedAlertChannel =
  | { id?: string; type: 'email'; recipients: string[] }
  | { id?: string; type: 'webhook'; url: string; secret?: string }
  | { id?: string; type: 'slack'; url: string }
  | { id?: string; type: 'teams'; url: string }
  | { id?: string; type: 'pagerduty'; routingKey: string };

export function newChannelId(): string {
  return `ch_${randomBytes(6).toString('hex')}`;
}

export function isChannelId(value: unknown): value is string {
  return typeof value === 'string' && CHANNEL_ID_PATTERN.test(value);
}

/** `https://hooks.slack.com/…/abcd`: the destination host and the last characters of the path, never the secret part. */
export function urlHint(url: string): string {
  try {
    const parsed = new URL(url);
    const tail = parsed.pathname.replace(/\/+$/, '').slice(-HINT_TAIL);
    return `${parsed.protocol}//${parsed.host}/…/${tail}`;
  } catch {
    return `…${url.trim().slice(-HINT_TAIL)}`;
  }
}

/** `…wxyz` */
export function keyHint(key: string): string {
  return `…${key.trim().slice(-HINT_TAIL)}`;
}

function trimmed(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** Plaintext of a stored channel. Throws when it cannot be decrypted (key rotated away, corrupted payload). */
export function unsealChannel(channel: IAlertChannel): UnsealedAlertChannel {
  switch (channel.type) {
    case 'email':
      return { id: channel.id, type: 'email', recipients: [...(channel.recipients ?? [])] };
    case 'webhook': {
      const sealed = decryptObject<{ url: string; secret?: string }>(channel.sealed);
      return { id: channel.id, type: 'webhook', url: sealed.url, ...(sealed.secret ? { secret: sealed.secret } : {}) };
    }
    case 'slack': {
      const sealed = decryptObject<{ url: string }>(channel.sealed);
      return { id: channel.id, type: 'slack', url: sealed.url };
    }
    case 'teams': {
      const sealed = decryptObject<{ url: string }>(channel.sealed);
      return { id: channel.id, type: 'teams', url: sealed.url };
    }
    case 'pagerduty': {
      const sealed = decryptObject<{ routingKey: string }>(channel.sealed);
      return { id: channel.id, type: 'pagerduty', routingKey: sealed.routingKey };
    }
    default:
      throw new Error(`Unsupported channel type "${(channel as { type?: string }).type}"`);
  }
}

function previousPlaintext(
  existingById: Map<string, IAlertChannel>,
  input: AlertChannelInput,
): UnsealedAlertChannel | null {
  if (!input.id) return null;
  const previous = existingById.get(input.id);
  if (!previous || previous.type !== input.type) return null;
  try {
    return unsealChannel(previous);
  } catch {
    return null;
  }
}

/**
 * Turn API input into stored channels. Every channel gets a stable id (kept
 * when the input names an existing one, generated otherwise). Secret fields
 * left out of the input keep the stored value of the channel with the same id;
 * an empty webhook `secret` removes the signing secret.
 */
export async function sealChannels(
  input: AlertChannelInput[],
  existing: IAlertChannel[] = [],
): Promise<IAlertChannel[]> {
  const existingById = new Map<string, IAlertChannel>();
  for (const channel of existing) {
    if (channel.id) existingById.set(channel.id, channel);
  }

  const usedIds = new Set<string>();
  const out: IAlertChannel[] = [];

  for (const channel of input) {
    let id = isChannelId(channel.id) && !usedIds.has(channel.id) ? channel.id : '';
    if (!id) {
      do {
        id = newChannelId();
      } while (usedIds.has(id));
    }
    usedIds.add(id);
    const withId = { ...channel, id };
    const previous = previousPlaintext(existingById, withId);

    switch (withId.type) {
      case 'email': {
        const recipients = (Array.isArray(withId.recipients) ? withId.recipients : []).map(trimmed).filter(Boolean);
        out.push({ id, type: 'email', recipients });
        break;
      }
      case 'webhook': {
        const prev = previous?.type === 'webhook' ? previous : null;
        const url = trimmed(withId.url) || prev?.url || '';
        if (!url) throw new Error('A webhook channel needs a url');
        const secret = withId.secret === undefined ? prev?.secret : trimmed(withId.secret) || undefined;
        out.push({
          id,
          type: 'webhook',
          urlHint: urlHint(url),
          hasSecret: Boolean(secret),
          sealed: encryptObject({ url, ...(secret ? { secret } : {}) }),
        });
        break;
      }
      case 'slack':
      case 'teams': {
        const prev = previous?.type === withId.type ? previous : null;
        const url = trimmed(withId.url) || (prev && 'url' in prev ? prev.url : '');
        if (!url) throw new Error(`A ${withId.type} channel needs a url`);
        out.push({ id, type: withId.type, urlHint: urlHint(url), sealed: encryptObject({ url }) });
        break;
      }
      case 'pagerduty': {
        const prev = previous?.type === 'pagerduty' ? previous : null;
        const routingKey = trimmed(withId.routingKey) || prev?.routingKey || '';
        if (!routingKey) throw new Error('A pagerduty channel needs a routing key');
        out.push({ id, type: 'pagerduty', keyHint: keyHint(routingKey), sealed: encryptObject({ routingKey }) });
        break;
      }
      default:
        throw new Error(`Unsupported channel type "${(channel as { type?: string }).type}"`);
    }
  }

  return out;
}

/**
 * API-safe view of stored channels: id, type and the display hints, never the
 * `sealed` credentials (the type is kept as IAlertChannel for compatibility, so
 * do not feed masked channels back into `sealChannels` as `existing`: they
 * cannot be unsealed). Built field by field, so nothing else stored on a
 * channel can leak.
 */
export function maskChannels(stored: IAlertChannel[] | null | undefined): IAlertChannel[] {
  if (!Array.isArray(stored)) return [];
  const out: IAlertChannel[] = [];
  for (const channel of stored) {
    const id = channel.id ? { id: channel.id } : {};
    switch (channel.type) {
      case 'email':
        out.push({ ...id, type: 'email', recipients: [...(channel.recipients ?? [])] });
        break;
      case 'webhook':
        out.push({ ...id, type: 'webhook', urlHint: channel.urlHint, hasSecret: Boolean(channel.hasSecret) } as IAlertChannel);
        break;
      case 'slack':
      case 'teams':
        out.push({ ...id, type: channel.type, urlHint: channel.urlHint } as IAlertChannel);
        break;
      case 'pagerduty':
        out.push({ ...id, type: 'pagerduty', keyHint: channel.keyHint } as IAlertChannel);
        break;
      default:
        // A type registered by another module (or a damaged row): keep the
        // entry by id and type only, so an edit never silently deletes it and
        // nothing else stored on it can leak.
        out.push({ ...id, type: (channel as { type: IAlertChannel['type'] }).type } as IAlertChannel);
        break;
    }
  }
  return out;
}
