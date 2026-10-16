/**
 * UI model of an alert channel and its conversion to and from the API.
 *
 * The API never returns a secret: a stored channel comes back as id, type and a
 * display hint (`urlHint`, `keyHint`, `hasSecret`). On save, a stored channel is
 * sent as `{ id, type }` and keeps its secret server-side; a secret is sent only
 * when the user chose "Replace" (or typed one into a new channel).
 */

import type { AlertChannelType, ChannelTestResult, MaskedChannel } from './alertTypes';

export interface ChannelItem {
  /** Client-only React key. */
  key: string;
  /** Stored channel id (`ch_` + 12 hex); absent on a channel added in this session. */
  id?: string;
  type: AlertChannelType;
  /** email */
  recipients: string[];
  /** email: also mail the project's admins. */
  audience?: 'project_admins';
  /** Masked hints of a stored channel. */
  urlHint?: string;
  keyHint?: string;
  hasSecret?: boolean;
  /** Write-only values typed this session. */
  url?: string;
  secret?: string;
  routingKey?: string;
  /** A stored secret is being replaced: the inputs are shown instead of the hint. */
  replace?: boolean;
  /** webhook: remove the stored signing secret on save. */
  clearSecret?: boolean;
}

export type ChannelIssue =
  | { code: 'invalidEmail'; value: string }
  | { code: 'urlRequired' }
  | { code: 'urlInvalid' }
  | { code: 'routingKeyRequired' }
  | { code: 'routingKeyInvalid' };

let counter = 0;
const nextKey = () => `channel-${(counter += 1)}`;

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ROUTING_KEY_PATTERN = /^[A-Za-z0-9]{32}$/;

export function newChannelItem(type: AlertChannelType): ChannelItem {
  return { key: nextKey(), type, recipients: [] };
}

/** A reference to a tenant channel library entry (`{ id?, type: 'library', libraryId }`). */
export interface LibraryRef {
  /** The rule-local channel id (kept on an edit so delivery history stays attached). */
  id?: string;
  libraryId: string;
}

function isInlineChannel(channel: MaskedChannel): channel is MaskedChannel & { type: AlertChannelType } {
  return channel.type !== 'library';
}

/** The library references among a rule's stored channels. */
export function libraryRefsFromStored(stored: MaskedChannel[] | null | undefined): LibraryRef[] {
  if (!Array.isArray(stored)) return [];
  return stored
    .filter((channel) => channel.type === 'library' && typeof channel.libraryId === 'string' && channel.libraryId)
    .map((channel) => ({ ...(channel.id ? { id: channel.id } : {}), libraryId: channel.libraryId as string }));
}

export function libraryRefToInput(ref: LibraryRef): Record<string, unknown> {
  return { ...(ref.id ? { id: ref.id } : {}), type: 'library', libraryId: ref.libraryId };
}

/** Stored (masked) channels → editor items (library references are handled by `libraryRefsFromStored`). */
export function channelsFromStored(stored: MaskedChannel[] | null | undefined): ChannelItem[] {
  if (!Array.isArray(stored)) return [];
  return stored.filter(isInlineChannel).map((channel) => ({
    key: nextKey(),
    id: channel.id,
    type: channel.type,
    recipients: [...(channel.recipients ?? [])],
    ...(channel.audience === 'project_admins' ? { audience: 'project_admins' as const } : {}),
    urlHint: channel.urlHint,
    keyHint: channel.keyHint,
    hasSecret: channel.hasSecret,
  }));
}

/** A channel the server already holds (its secret stays there unless replaced). */
export function isStoredChannel(item: ChannelItem): boolean {
  return Boolean(item.id) && item.type !== 'email';
}

/** The inputs are shown for a new channel, or for a stored one being replaced. */
export function channelEditsSecrets(item: ChannelItem): boolean {
  return !isStoredChannel(item) || Boolean(item.replace);
}

export function isValidHttpsUrl(value: string): boolean {
  try {
    return new URL(value.trim()).protocol === 'https:';
  } catch {
    return false;
  }
}

export function isValidEmail(value: string): boolean {
  return value.length <= 254 && EMAIL_PATTERN.test(value);
}

/** The first problem with a channel, or null. */
export function validateChannel(item: ChannelItem): ChannelIssue | null {
  switch (item.type) {
    case 'email': {
      const bad = item.recipients.find((recipient) => !isValidEmail(recipient.trim()));
      return bad !== undefined ? { code: 'invalidEmail', value: bad } : null;
    }
    case 'webhook':
    case 'slack':
    case 'teams': {
      const url = (item.url ?? '').trim();
      // A stored channel keeps its url when the field is left empty.
      if (!url) return isStoredChannel(item) ? null : { code: 'urlRequired' };
      return isValidHttpsUrl(url) ? null : { code: 'urlInvalid' };
    }
    case 'pagerduty': {
      const key = (item.routingKey ?? '').trim();
      if (!key) return isStoredChannel(item) ? null : { code: 'routingKeyRequired' };
      return ROUTING_KEY_PATTERN.test(key) ? null : { code: 'routingKeyInvalid' };
    }
    default:
      return null;
  }
}

export function validateChannels(items: ChannelItem[]): ChannelIssue | null {
  for (const item of items) {
    const issue = validateChannel(item);
    if (issue) return issue;
  }
  return null;
}

/** Item → API input (`AlertChannelInput`). Secret fields are present only when the user supplied them. */
export function channelToInput(item: ChannelItem): Record<string, unknown> {
  const base = item.id ? { id: item.id } : {};
  switch (item.type) {
    case 'email':
      return {
        ...base,
        type: 'email',
        recipients: item.recipients.map((recipient) => recipient.trim()).filter(Boolean),
        ...(item.audience === 'project_admins' ? { audience: 'project_admins' } : {}),
      };
    case 'webhook': {
      const url = item.url?.trim();
      const secret = item.secret?.trim();
      return {
        ...base,
        type: 'webhook',
        ...(url ? { url } : {}),
        // An empty string removes the stored signing secret.
        ...(secret ? { secret } : item.clearSecret ? { secret: '' } : {}),
      };
    }
    case 'slack':
    case 'teams': {
      const url = item.url?.trim();
      return { ...base, type: item.type, ...(url ? { url } : {}) };
    }
    case 'pagerduty': {
      const routingKey = item.routingKey?.trim();
      return { ...base, type: 'pagerduty', ...(routingKey ? { routingKey } : {}) };
    }
  }
}

export function channelsToInput(items: ChannelItem[]): Array<Record<string, unknown>> {
  return items.map(channelToInput);
}

/**
 * Body of `POST /alerts/channels/test` for one item, or null when nothing can be
 * sent yet. A stored channel that was not edited is tested by reference (the
 * server holds its secret); anything else is tested as typed.
 */
export function buildChannelTestBody(
  item: ChannelItem,
  ruleId?: string | null,
): { channel: Record<string, unknown> } | { ruleId: string; channelId: string } | null {
  if (isStoredChannel(item) && !channelEditsSecrets(item) && item.id) {
    return ruleId ? { ruleId, channelId: item.id } : null;
  }
  if (validateChannel(item)) return null;
  if (item.type === 'webhook' || item.type === 'slack' || item.type === 'teams') {
    if (!item.url?.trim()) return ruleId && item.id ? { ruleId, channelId: item.id } : null;
  }
  if (item.type === 'pagerduty' && !item.routingKey?.trim()) {
    return ruleId && item.id ? { ruleId, channelId: item.id } : null;
  }
  return { channel: channelToInput(item) };
}

export function describeTestResult(result: ChannelTestResult | null | undefined): { ok: boolean; message: string } {
  if (!result) return { ok: false, message: '' };
  return { ok: Boolean(result.success), message: result.success ? '' : (result.error ?? '') };
}
