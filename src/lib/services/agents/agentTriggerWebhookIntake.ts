/**
 * A trigger's `webhook` settings as the triggers API writes and shows them: the
 * request shape → the stored settings (with the secret rules of SPEC W1), the
 * wire shape (never a sealed secret), the public URL, secret rotation and
 * opening the stored secrets for a delivery.
 *
 * The secret is generated here and shown once (in the answer that created or
 * replaced it), except with Standard Webhooks, where the sender generates it
 * and it is pasted in. Only the sealed form is stored.
 */

import { randomBytes } from 'node:crypto';
import { getConfig } from '@/lib/core/config';
import { createLogger } from '@/lib/core/logger';
import type { AgentTriggerWebhook, AgentTriggerWebhookAuth, AgentTriggerWebhookPreset } from '@/lib/database';
import { generateWebhookSecret } from '@/lib/services/webhooks/webhookEndpointService';
import { decryptObject, encryptObject } from '@/lib/utils/crypto';
import type { VariableIssue } from './agentVariables';
import {
  DEFAULT_WEBHOOK_HEADER_NAME,
  RETIRED_WEBHOOK_PRESETS,
  WEBHOOK_PRESET_AUTH,
  WEBHOOK_PRESETS,
  headerNameProblem,
  isRetiredWebhook,
  standardSecretProblem,
} from './agentTriggerWebhookAuth';
import { parseFilterRules } from './agentTriggerWebhookView';

const logger = createLogger('agent-trigger-webhook');

const EVENT_NAME_RE = /^[A-Za-z0-9._:-]{1,64}$/;
const MAX_EVENTS = 50;
export const MAX_ROTATION_GRACE_SECONDS = 86_400;

/** `wh_` + 18 random bytes: the URL's locator. */
export function newHookId(): string {
  return `wh_${randomBytes(18).toString('base64url')}`;
}

/** The public URL a sender posts to. */
export function webhookUrl(tenantId: string, hookId: string): string {
  return `${getConfig().app.url.replace(/\/+$/, '')}/api/public/hooks/${tenantId}/${hookId}`;
}

const hintOf = (secret: string) => secret.slice(-4);

function sealed(secret: string, source: 'generated' | 'provided') {
  return { secretSealed: encryptObject(secret), secretHint: hintOf(secret), secretSource: source };
}

export type WebhookWrite =
  | { ok: true; webhook: AgentTriggerWebhook; /** A new generated secret, shown once. */ secret?: string }
  | { ok: false; errors: VariableIssue[] };

/**
 * The `webhook` settings from a create / PATCH body's `webhook` object.
 * `existing` is the stored `webhook` when the trigger already is a webhook
 * one: absent fields keep its values, and its hook id and secret stay unless
 * the secret rules replace the secret: moving away from Standard Webhooks
 * generates a new one, moving to it needs the sender's `secret`. A trigger that
 * becomes a webhook one gets a new hook id and secret; so does one stored with
 * a retired vendor preset (it is rewritten as a generic webhook, not edited in place).
 */
export function parseWebhookWrite(value: Record<string, unknown>, existing: AgentTriggerWebhook | null | undefined): WebhookWrite {
  const retired = Boolean(existing && isRetiredWebhook(existing));
  const prev = retired ? null : existing ?? null;
  const errors: VariableIssue[] = [];
  const issue = (field: string, message: string) => errors.push({ field: `webhook.${field}`, message });

  const given = (value.preset ?? prev?.preset) as AgentTriggerWebhookPreset | undefined;
  if (typeof given === 'string' && (RETIRED_WEBHOOK_PRESETS as readonly string[]).includes(given)) {
    issue('preset', `preset "${given}" is retired: use a connector trigger for that service, or the "generic" preset`);
    return { ok: false, errors };
  }
  // A retired trigger that is rewritten without naming the preset becomes a generic one.
  const preset = given ?? (retired ? 'generic' : undefined);
  if (!preset || !WEBHOOK_PRESETS.includes(preset)) {
    issue('preset', `preset must be one of: ${WEBHOOK_PRESETS.join(', ')}`);
    return { ok: false, errors };
  }
  const allowed = WEBHOOK_PRESET_AUTH[preset];
  const auth = (value.auth ?? (prev && allowed.includes(prev.auth as AgentTriggerWebhookAuth) ? prev.auth : allowed[0])) as AgentTriggerWebhookAuth;
  if (!allowed.includes(auth)) {
    issue('auth', `auth for preset "${preset}" must be one of: ${allowed.join(', ')}`);
    return { ok: false, errors };
  }

  let headerName: string | null = null;
  if (auth === 'header') {
    const given = value.header_name ?? prev?.headerName ?? DEFAULT_WEBHOOK_HEADER_NAME;
    if (typeof given !== 'string') issue('header_name', 'header_name must be a string');
    else {
      headerName = given.trim().toLowerCase();
      const problem = headerNameProblem(headerName);
      if (problem) issue('header_name', problem);
    }
  }

  let events: string[] = prev?.events ?? [];
  if (value.events !== undefined) {
    if (value.events === null) events = [];
    else if (!Array.isArray(value.events) || value.events.length > MAX_EVENTS
      || !value.events.every((event) => typeof event === 'string' && EVENT_NAME_RE.test(event))) {
      issue('events', `events must be a list of at most ${MAX_EVENTS} event names (letters, digits and . _ : -)`);
    } else events = [...new Set(value.events as string[])];
  }

  let filter = prev?.filter ?? [];
  if (value.filter !== undefined) {
    const parsed = parseFilterRules(value.filter);
    if (!parsed.ok) errors.push(...parsed.errors.map((item) => ({ field: `webhook.${item.field}`, message: item.message })));
    else filter = parsed.rules;
  }

  let includePayload = prev?.includePayload ?? true;
  if (value.include_payload !== undefined) {
    if (typeof value.include_payload !== 'boolean') issue('include_payload', 'include_payload must be a boolean');
    else includePayload = value.include_payload;
  }

  // The secret (SPEC W1): generated unless the sender's Standard Webhooks secret is pasted in.
  const givenSecret = value.secret;
  let secretFields: Pick<AgentTriggerWebhook, 'secretSealed' | 'secretHint' | 'secretSource'> | null = null;
  let generated: string | undefined;
  let clearPrevious = false;
  if (auth === 'standard_webhooks') {
    if (givenSecret !== undefined && givenSecret !== null && givenSecret !== '') {
      const problem = standardSecretProblem(givenSecret);
      if (problem) issue('secret', problem);
      else {
        secretFields = sealed(givenSecret as string, 'provided');
        clearPrevious = true;
      }
    } else if (!prev || prev.auth !== 'standard_webhooks') {
      issue('secret', 'a Standard Webhooks webhook needs the sender’s secret ("whsec_…")');
    }
  } else {
    if (givenSecret !== undefined && givenSecret !== null && givenSecret !== '') {
      issue('secret', 'the secret is generated for this auth mode; use rotate-secret to replace it');
    } else if (!prev || prev.auth === 'standard_webhooks') {
      generated = generateWebhookSecret();
      secretFields = sealed(generated, 'generated');
      clearPrevious = true;
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  const webhook: AgentTriggerWebhook = {
    hookId: prev?.hookId ?? newHookId(),
    preset,
    auth,
    headerName,
    secretSealed: secretFields?.secretSealed ?? prev!.secretSealed,
    secretHint: secretFields?.secretHint ?? prev!.secretHint,
    secretSource: secretFields?.secretSource ?? prev!.secretSource,
    previousSecretSealed: clearPrevious ? null : prev?.previousSecretSealed ?? null,
    previousSecretExpiresAt: clearPrevious ? null : prev?.previousSecretExpiresAt ?? null,
    events,
    filter,
    includePayload,
  };
  return { ok: true, webhook, ...(generated ? { secret: generated } : {}) };
}

const toEpochSeconds = (value: Date | string | null | undefined) => (value ? Math.floor(new Date(value).getTime() / 1000) : null);

/** The previous secret's end, while one is still accepted. */
function previousValidUntil(webhook: AgentTriggerWebhook, now = new Date()): Date | null {
  if (!webhook.previousSecretSealed || !webhook.previousSecretExpiresAt) return null;
  const until = new Date(webhook.previousSecretExpiresAt);
  return until.getTime() > now.getTime() ? until : null;
}

/** The wire shape of a trigger's `webhook` (§5.7 + SPEC W6): the URL and a hint of the secret, never a sealed value. */
export function serializeWebhook(webhook: AgentTriggerWebhook, tenantId: string): Record<string, unknown> {
  return {
    url: webhookUrl(tenantId, webhook.hookId),
    preset: webhook.preset,
    auth: webhook.auth,
    header_name: webhook.auth === 'header' ? webhook.headerName ?? DEFAULT_WEBHOOK_HEADER_NAME : null,
    secret_hint: webhook.secretHint,
    secret_source: webhook.secretSource,
    previous_secret_valid_until: toEpochSeconds(previousValidUntil(webhook)),
    events: webhook.events ?? [],
    filter: webhook.filter ?? [],
    include_payload: webhook.includePayload,
    // A retired vendor preset: read-only legacy, convert it to a connector or generic trigger.
    retired: isRetiredWebhook(webhook),
  };
}

/**
 * A new secret: generated, or the sender's for Standard Webhooks. With a
 * grace, the current secret stays accepted until then; a grace of 0 also ends
 * any earlier one.
 */
export function rotateWebhookSecret(
  webhook: AgentTriggerWebhook,
  input: { graceSeconds: number; secret?: unknown },
  now = new Date(),
): { ok: true; webhook: AgentTriggerWebhook; secret?: string } | { ok: false; field: string; message: string } {
  let replacement: { secretSealed: string; secretHint: string; secretSource: 'generated' | 'provided' };
  let generated: string | undefined;
  if (webhook.auth === 'standard_webhooks') {
    const problem = standardSecretProblem(input.secret);
    if (problem) return { ok: false, field: 'secret', message: problem };
    replacement = sealed(input.secret as string, 'provided');
  } else {
    if (input.secret !== undefined && input.secret !== null && input.secret !== '') {
      return { ok: false, field: 'secret', message: 'the secret is generated for this auth mode' };
    }
    generated = generateWebhookSecret();
    replacement = sealed(generated, 'generated');
  }
  const keepPrevious = input.graceSeconds > 0;
  return {
    ok: true,
    webhook: {
      ...webhook,
      ...replacement,
      previousSecretSealed: keepPrevious ? webhook.secretSealed : null,
      previousSecretExpiresAt: keepPrevious ? new Date(now.getTime() + input.graceSeconds * 1000) : null,
    },
    ...(generated ? { secret: generated } : {}),
  };
}

export function rotationAnswer(webhook: AgentTriggerWebhook, secret?: string) {
  return {
    object: 'agent.trigger.webhook_secret' as const,
    ...(secret ? { secret } : {}),
    secret_hint: webhook.secretHint,
    previous_valid_until: toEpochSeconds(previousValidUntil(webhook)),
  };
}

/** A failed decrypt is logged once per trigger per hour (the encryption key changed). */
const SECRET_ERROR_LOG_INTERVAL_MS = 60 * 60 * 1000;
const lastSecretErrorAt = new Map<string, number>();

/**
 * The secrets a delivery may prove: the current one, then the previous one
 * while its grace runs. Null when the current one cannot be opened.
 */
export function openWebhookSecrets(triggerId: string, webhook: AgentTriggerWebhook, now = new Date()): string[] | null {
  let current: string;
  try {
    current = decryptObject<string>(webhook.secretSealed);
    if (typeof current !== 'string' || current.length === 0) throw new Error('empty secret');
  } catch (error) {
    const last = lastSecretErrorAt.get(triggerId);
    if (last === undefined || now.getTime() - last >= SECRET_ERROR_LOG_INTERVAL_MS) {
      if (lastSecretErrorAt.size > 10_000) lastSecretErrorAt.clear();
      lastSecretErrorAt.set(triggerId, now.getTime());
      logger.error('A webhook secret cannot be opened; rotate the secret', {
        triggerId, error: error instanceof Error ? error.message : String(error),
      });
    }
    return null;
  }
  const secrets = [current];
  if (previousValidUntil(webhook, now) && webhook.previousSecretSealed) {
    try {
      const previous = decryptObject<string>(webhook.previousSecretSealed);
      if (typeof previous === 'string' && previous.length > 0) secrets.push(previous);
    } catch {
      // The previous secret is only a grace; the current one still works.
    }
  }
  return secrets;
}

/** Test seam. */
export function resetWebhookSecretErrorLog(): void {
  lastSecretErrorAt.clear();
}
