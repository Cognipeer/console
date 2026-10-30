/**
 * How a trigger's generic webhook checks and reads one delivery: the auth check
 * (header modes before the body is read, signature modes over the raw body),
 * the event name and delivery id (normalized before anything shows or stores
 * them), the headers a filter or template may read (an allow-list) and the
 * material de-duplication keys on. Vendor webhooks (GitHub, GitLab, Azure
 * DevOps) are connector triggers; their old presets only survive as retired,
 * read-only values (`isRetiredWebhook`).
 *
 * Every secret comparison hashes both sides and compares the digests with
 * `timingSafeEqual`, so neither the length nor the content of a guess shows in
 * the time an answer takes.
 */

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type {
  AgentTriggerWebhook,
  AgentTriggerWebhookAuth,
  AgentTriggerWebhookPreset,
  RetiredAgentTriggerWebhookAuth,
  RetiredAgentTriggerWebhookPreset,
} from '@/lib/database';

export const WEBHOOK_PRESETS: readonly AgentTriggerWebhookPreset[] = ['generic'];

/** The auth modes each preset offers; the first is its default. */
export const WEBHOOK_PRESET_AUTH: Record<AgentTriggerWebhookPreset, readonly AgentTriggerWebhookAuth[]> = {
  generic: ['bearer', 'signature', 'header', 'standard_webhooks'],
};

/** Vendor presets and auth modes older triggers were stored with; they can no longer be written or delivered to. */
export const RETIRED_WEBHOOK_PRESETS: readonly RetiredAgentTriggerWebhookPreset[] = ['github', 'gitlab', 'azure_devops'];
export const RETIRED_WEBHOOK_AUTH: readonly RetiredAgentTriggerWebhookAuth[] = ['github_signature', 'gitlab_token', 'basic'];

/** A stored webhook with a retired preset or auth mode: it no longer receives deliveries (convert it to a connector or generic trigger). */
export function isRetiredWebhook(webhook: Pick<AgentTriggerWebhook, 'preset' | 'auth'>): boolean {
  return (RETIRED_WEBHOOK_PRESETS as readonly string[]).includes(webhook.preset)
    || (RETIRED_WEBHOOK_AUTH as readonly string[]).includes(webhook.auth);
}

const HEADER_AUTH: ReadonlySet<AgentTriggerWebhookAuth> = new Set(['bearer', 'header']);

/** Checked from the headers alone, before the body is read. */
export function isHeaderAuth(auth: AgentTriggerWebhookAuth): boolean {
  return HEADER_AUTH.has(auth);
}

export const DEFAULT_WEBHOOK_HEADER_NAME = 'x-cognipeer-token';
const HEADER_NAME_RE = /^x-[a-z0-9-]{1,62}$/;
/** Header names that carry routing, signatures or ids of their own, so they cannot hold the secret. */
const RESERVED_HEADER_NAMES = [
  /^x-request-id$/, /^x-forwarded-/, /^x-real-ip$/, /^x-hub-signature/, /^x-gitlab-/, /^x-github-/,
  /^x-cognipeer-signature$/, /^x-cognipeer-event/, /^x-cpr-hdr-/, /^webhook-/, /^idempotency-key$/,
];

/** Why `name` cannot carry the secret for auth `header`, or null. */
export function headerNameProblem(name: string): string | null {
  if (!HEADER_NAME_RE.test(name)) return 'header_name must look like "x-my-token" (lower-case letters, digits and "-", starting with "x-")';
  if (RESERVED_HEADER_NAMES.some((re) => re.test(name))) return `header_name "${name}" is reserved`;
  return null;
}

// ── Secrets ──────────────────────────────────────────────────────────────

const STANDARD_SECRET_RE = /^whsec_[A-Za-z0-9+/]+={0,2}$/;

/** Why a sender's Standard Webhooks secret cannot be used, or null. */
export function standardSecretProblem(secret: unknown): string | null {
  if (typeof secret !== 'string' || !STANDARD_SECRET_RE.test(secret)) return 'secret must be a Standard Webhooks secret ("whsec_" + base64)';
  const bytes = Buffer.from(secret.slice('whsec_'.length), 'base64').length;
  if (bytes < 24 || bytes > 64) return 'secret must decode to 24 to 64 bytes';
  return null;
}

function digest(value: string | Buffer): Buffer {
  return createHash('sha256').update(value).digest();
}

/** Equal without the comparison time depending on where the values differ. */
export function constantTimeEqual(a: string | Buffer, b: string | Buffer): boolean {
  return timingSafeEqual(digest(a), digest(b));
}

export function sha256Hex(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

// ── Headers ──────────────────────────────────────────────────────────────

export type HeaderBag = Record<string, string | string[] | undefined>;

/** One header's value (several joined with ", "), or undefined. */
export function headerValue(headers: HeaderBag, name: string): string | undefined {
  const value = headers[name];
  if (value === undefined) return undefined;
  return Array.isArray(value) ? value.join(', ') : value;
}

const HEADER_ALLOW_LIST: readonly string[] = ['x-cognipeer-event', 'x-cognipeer-event-id', 'webhook-id', 'idempotency-key', 'user-agent'];

/**
 * The headers a filter or template may read: the allow-list only,
 * lower-cased; a header whose value contains one of the trigger's secrets is
 * left out as well. A null-prototype object.
 */
export function allowedHeaders(headers: HeaderBag, secrets: readonly string[]): Record<string, string> {
  const out = Object.create(null) as Record<string, string>;
  const lower = Object.create(null) as HeaderBag;
  for (const [name, value] of Object.entries(headers)) lower[name.toLowerCase()] = value;
  for (const name of HEADER_ALLOW_LIST) {
    const value = headerValue(lower, name);
    if (value === undefined) continue;
    if (secrets.some((secret) => secret.length > 0 && value.includes(secret))) continue;
    out[name] = value;
  }
  return out;
}

// ── Auth ─────────────────────────────────────────────────────────────────

export type AuthCheck = { ok: true } | { ok: false; reason: string };

const SIGNATURE_WINDOW_SECONDS = 300;
const MISSING_CREDENTIALS: AuthCheck = { ok: false, reason: 'missing credentials' };
const CREDENTIALS_MISMATCH: AuthCheck = { ok: false, reason: 'credentials mismatch' };
const MISSING_SIGNATURE: AuthCheck = { ok: false, reason: 'missing signature' };
const SIGNATURE_MISMATCH: AuthCheck = { ok: false, reason: 'signature mismatch' };
const OUTSIDE_WINDOW: AuthCheck = { ok: false, reason: 'timestamp outside the 5 minute window' };

/** The token a header mode carries, or null when the header is absent or malformed. */
function presentedToken(auth: AgentTriggerWebhookAuth, headers: HeaderBag, headerName: string | null | undefined): string | null {
  switch (auth) {
    case 'header':
      return headerValue(headers, headerName || DEFAULT_WEBHOOK_HEADER_NAME) ?? null;
    case 'bearer': {
      const match = /^bearer[ \t]+(\S+)[ \t]*$/i.exec(headerValue(headers, 'authorization') ?? '');
      return match ? match[1] : null;
    }
    default:
      return null;
  }
}

/** A header mode (`bearer`, `header`): the secret in a header, against each accepted secret. */
export function verifyHeaderAuth(
  auth: AgentTriggerWebhookAuth,
  headers: HeaderBag,
  headerName: string | null | undefined,
  secrets: readonly string[],
): AuthCheck {
  const token = presentedToken(auth, headers, headerName);
  if (token === null || token === '') return MISSING_CREDENTIALS;
  // Every secret is compared (no early exit), so the time does not tell which one matched.
  let matched = false;
  for (const secret of secrets) matched = constantTimeEqual(token, secret) || matched;
  return matched ? { ok: true } : CREDENTIALS_MISMATCH;
}

function hmac(key: string | Buffer, parts: Array<string | Buffer>): Buffer {
  const mac = createHmac('sha256', key);
  for (const part of parts) mac.update(part);
  return mac.digest();
}

const withinWindow = (seconds: number, nowMs: number) => Math.abs(nowMs / 1000 - seconds) <= SIGNATURE_WINDOW_SECONDS;

/** A body mode (`signature`, `standard_webhooks`) over the exact bytes received. */
export function verifyBodyAuth(
  auth: AgentTriggerWebhookAuth,
  headers: HeaderBag,
  body: Buffer,
  secrets: readonly string[],
  nowMs = Date.now(),
): AuthCheck {
  switch (auth) {
    case 'signature': {
      const header = headerValue(headers, 'x-cognipeer-signature');
      if (!header) return MISSING_SIGNATURE;
      let timestamp: string | null = null;
      const signatures: string[] = [];
      for (const part of header.split(',')) {
        const at = part.indexOf('=');
        if (at <= 0) continue;
        const key = part.slice(0, at).trim();
        const value = part.slice(at + 1).trim();
        if (key === 't') timestamp = value;
        else if (key === 'v1') signatures.push(value.toLowerCase());
      }
      if (!timestamp || !/^\d{1,12}$/.test(timestamp) || signatures.length === 0) return MISSING_SIGNATURE;
      if (!withinWindow(Number(timestamp), nowMs)) return OUTSIDE_WINDOW;
      let matched = false;
      for (const secret of secrets) {
        const expected = hmac(secret, [`${timestamp}.`, body]).toString('hex');
        for (const signature of signatures) matched = constantTimeEqual(expected, signature) || matched;
      }
      return matched ? { ok: true } : SIGNATURE_MISMATCH;
    }
    case 'standard_webhooks': {
      const id = headerValue(headers, 'webhook-id');
      const timestamp = headerValue(headers, 'webhook-timestamp');
      const header = headerValue(headers, 'webhook-signature');
      if (!id || !timestamp || !header) return MISSING_SIGNATURE;
      if (!/^\d{1,12}$/.test(timestamp.trim())) return MISSING_SIGNATURE;
      if (!withinWindow(Number(timestamp.trim()), nowMs)) return OUTSIDE_WINDOW;
      const signatures = header.split(' ')
        .map((entry) => entry.trim())
        .filter((entry) => entry.startsWith('v1,'))
        .map((entry) => entry.slice(3));
      if (signatures.length === 0) return MISSING_SIGNATURE;
      let matched = false;
      for (const secret of secrets) {
        const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
        const expected = hmac(key, [`${id}.${timestamp.trim()}.`, body]).toString('base64');
        for (const signature of signatures) matched = constantTimeEqual(expected, signature) || matched;
      }
      return matched ? { ok: true } : SIGNATURE_MISMATCH;
    }
    default:
      return SIGNATURE_MISMATCH;
  }
}

// ── Event name and delivery id ───────────────────────────────────────────

const EVENT_RE = /^[A-Za-z0-9._:-]{1,64}$/;
const DELIVERY_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;

const asString = (value: unknown): string | undefined => (typeof value === 'string' && value.length > 0 ? value : undefined);
const field = (payload: unknown, key: string): unknown =>
  (payload !== null && typeof payload === 'object' && !Array.isArray(payload) && Object.prototype.hasOwnProperty.call(payload, key)
    ? (payload as Record<string, unknown>)[key]
    : undefined);

export interface DeliveryIdentity {
  /** Normalized: only values matching `^[A-Za-z0-9._:-]{1,64}$` (else absent). */
  event?: string;
  /** Normalized: `^[A-Za-z0-9._:-]{1,128}$` (else absent). */
  deliveryId?: string;
  /** The sender named an event that does not normalize. */
  invalidEvent: boolean;
  /** The delivery-id header as received (de-duplication only; never shown or stored). */
  rawDeliveryHeader?: string;
}

/** The event name and delivery id of a delivery (SPEC W3). */
export function deliveryIdentity(headers: HeaderBag, payload: unknown): DeliveryIdentity {
  const event = asString(field(payload, 'event')) ?? asString(field(payload, 'type')) ?? headerValue(headers, 'x-cognipeer-event');
  const deliveryHeader = headerValue(headers, 'x-cognipeer-event-id') ?? headerValue(headers, 'webhook-id') ?? headerValue(headers, 'idempotency-key');
  const normalizedEvent = event !== undefined && EVENT_RE.test(event) ? event : undefined;
  return {
    ...(normalizedEvent ? { event: normalizedEvent } : {}),
    ...(deliveryHeader !== undefined && DELIVERY_ID_RE.test(deliveryHeader) ? { deliveryId: deliveryHeader } : {}),
    invalidEvent: event !== undefined && !normalizedEvent,
    ...(deliveryHeader !== undefined ? { rawDeliveryHeader: deliveryHeader } : {}),
  };
}

// ── De-duplication ───────────────────────────────────────────────────────

/**
 * What identifies "the same delivery" for this auth mode (raw values), or null
 * when the delivery cannot be told apart from an intended repeat (a sender
 * without a delivery id: no de-duplication).
 */
export function dedupMaterial(auth: AgentTriggerWebhookAuth, headers: HeaderBag, body: Buffer): string | null {
  if (auth === 'standard_webhooks') {
    // Signed, so the sender's id is trustworthy.
    return headerValue(headers, 'webhook-id') ?? sha256Hex(body);
  }
  const deliveryId = headerValue(headers, 'x-cognipeer-event-id') ?? headerValue(headers, 'webhook-id') ?? headerValue(headers, 'idempotency-key');
  return deliveryId ? `${deliveryId}\n${sha256Hex(body)}` : null;
}

/** The idempotency key of a delivery's first attempt: `hook:<triggerId>:<40 hex>`. */
export function deliveryKeyBase(triggerId: string, material: string): string {
  return `hook:${triggerId}:${sha256Hex(material).slice(0, 40)}`;
}

/** The same for a connector event: `ctrig:<triggerId>:<40 hex of the subscription id and the event's material>`. */
export function connectorDeliveryKeyBase(triggerId: string, subscriptionId: string, material: string): string {
  return `ctrig:${triggerId}:${sha256Hex(`${subscriptionId}\n${material}`).slice(0, 40)}`;
}

/** First attempt, then `:r2` … `:r5`: a redelivery of a failed delivery runs again, at most five times. */
export const DELIVERY_ATTEMPTS = 5;

export function deliveryAttemptKeys(base: string): string[] {
  return Array.from({ length: DELIVERY_ATTEMPTS }, (_, index) => (index === 0 ? base : `${base}:r${index + 1}`));
}
