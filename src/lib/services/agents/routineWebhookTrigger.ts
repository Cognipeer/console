/**
 * A routine's webhook trigger as the routines API writes and shows it: the
 * request shape → the stored trigger (with the secret rules of SPEC W1), the
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
import type { AgentRoutineTrigger, AgentRoutineWebhookAuth, AgentRoutineWebhookPreset, AgentRoutineWebhookTrigger } from '@/lib/database';
import { generateWebhookSecret } from '@/lib/services/webhooks/webhookEndpointService';
import { decryptObject, encryptObject } from '@/lib/utils/crypto';
import type { InputIssue } from './agentInputs';
import {
  DEFAULT_WEBHOOK_HEADER_NAME,
  WEBHOOK_PRESET_AUTH,
  WEBHOOK_PRESETS,
  headerNameProblem,
  standardSecretProblem,
} from './routineWebhookAuth';
import { parseFilterRules } from './routineWebhookView';

const logger = createLogger('agent-routine-webhook');

const EVENT_NAME_RE = /^[A-Za-z0-9._:-]{1,64}$/;
const MAX_EVENTS = 50;
export const MAX_ROTATION_GRACE_SECONDS = 86_400;

export function isWebhookTrigger(trigger: AgentRoutineTrigger | null | undefined): trigger is AgentRoutineWebhookTrigger {
  return trigger?.type === 'webhook';
}

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

export type WebhookTriggerWrite =
  | { ok: true; trigger: AgentRoutineWebhookTrigger; /** A new generated secret, shown once. */ secret?: string }
  | { ok: false; errors: InputIssue[] };

/**
 * A webhook trigger from a create / PATCH body. `existing` is the stored
 * trigger when it already is a webhook one: absent fields keep its values,
 * and its hook id and secret stay unless the secret rules replace the secret:
 * moving away from Standard Webhooks generates a new one, moving to it needs
 * the sender's `secret`. A new webhook trigger gets a new hook id and secret.
 */
export function parseWebhookTriggerWrite(value: Record<string, unknown>, existing: AgentRoutineTrigger | null | undefined): WebhookTriggerWrite {
  const prev = isWebhookTrigger(existing) ? existing : null;
  const errors: InputIssue[] = [];
  const issue = (field: string, message: string) => errors.push({ field: `trigger.${field}`, message });

  const preset = (value.preset ?? prev?.preset) as AgentRoutineWebhookPreset | undefined;
  if (!preset || !WEBHOOK_PRESETS.includes(preset)) {
    issue('preset', `preset must be one of: ${WEBHOOK_PRESETS.join(', ')}`);
    return { ok: false, errors };
  }
  const allowed = WEBHOOK_PRESET_AUTH[preset];
  const auth = (value.auth ?? (prev && allowed.includes(prev.auth) ? prev.auth : allowed[0])) as AgentRoutineWebhookAuth;
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
    if (!parsed.ok) errors.push(...parsed.errors.map((item) => ({ field: `trigger.${item.field}`, message: item.message })));
    else filter = parsed.rules;
  }

  let includePayload = prev?.includePayload ?? true;
  if (value.include_payload !== undefined) {
    if (typeof value.include_payload !== 'boolean') issue('include_payload', 'include_payload must be a boolean');
    else includePayload = value.include_payload;
  }

  // The secret (SPEC W1): generated unless the sender's Standard Webhooks secret is pasted in.
  const givenSecret = value.secret;
  let secretFields: Pick<AgentRoutineWebhookTrigger, 'secretSealed' | 'secretHint' | 'secretSource'> | null = null;
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
      issue('secret', 'a Standard Webhooks trigger needs the sender’s secret ("whsec_…")');
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
  const trigger: AgentRoutineWebhookTrigger = {
    type: 'webhook',
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
  return { ok: true, trigger, ...(generated ? { secret: generated } : {}) };
}

const toEpochSeconds = (value: Date | string | null | undefined) => (value ? Math.floor(new Date(value).getTime() / 1000) : null);

/** The previous secret's end, while one is still accepted. */
function previousValidUntil(trigger: AgentRoutineWebhookTrigger, now = new Date()): Date | null {
  if (!trigger.previousSecretSealed || !trigger.previousSecretExpiresAt) return null;
  const until = new Date(trigger.previousSecretExpiresAt);
  return until.getTime() > now.getTime() ? until : null;
}

/** The wire shape (§5.7 + SPEC W6): the URL and a hint of the secret, never a sealed value. */
export function serializeWebhookTrigger(trigger: AgentRoutineWebhookTrigger, tenantId: string): Record<string, unknown> {
  return {
    type: 'webhook',
    url: webhookUrl(tenantId, trigger.hookId),
    preset: trigger.preset,
    auth: trigger.auth,
    header_name: trigger.auth === 'header' ? trigger.headerName ?? DEFAULT_WEBHOOK_HEADER_NAME : null,
    secret_hint: trigger.secretHint,
    secret_source: trigger.secretSource,
    previous_secret_valid_until: toEpochSeconds(previousValidUntil(trigger)),
    events: trigger.events ?? [],
    filter: trigger.filter ?? [],
    include_payload: trigger.includePayload,
  };
}

/**
 * A new secret: generated, or the sender's for Standard Webhooks. With a
 * grace, the current secret stays accepted until then; a grace of 0 also ends
 * any earlier one.
 */
export function rotateWebhookSecret(
  trigger: AgentRoutineWebhookTrigger,
  input: { graceSeconds: number; secret?: unknown },
  now = new Date(),
): { ok: true; trigger: AgentRoutineWebhookTrigger; secret?: string } | { ok: false; field: string; message: string } {
  let replacement: { secretSealed: string; secretHint: string; secretSource: 'generated' | 'provided' };
  let generated: string | undefined;
  if (trigger.auth === 'standard_webhooks') {
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
    trigger: {
      ...trigger,
      ...replacement,
      previousSecretSealed: keepPrevious ? trigger.secretSealed : null,
      previousSecretExpiresAt: keepPrevious ? new Date(now.getTime() + input.graceSeconds * 1000) : null,
    },
    ...(generated ? { secret: generated } : {}),
  };
}

export function rotationAnswer(trigger: AgentRoutineWebhookTrigger, secret?: string) {
  return {
    object: 'agent.routine.webhook_secret' as const,
    ...(secret ? { secret } : {}),
    secret_hint: trigger.secretHint,
    previous_valid_until: toEpochSeconds(previousValidUntil(trigger)),
  };
}

/** A failed decrypt is logged once per routine per hour (the encryption key changed). */
const SECRET_ERROR_LOG_INTERVAL_MS = 60 * 60 * 1000;
const lastSecretErrorAt = new Map<string, number>();

/**
 * The secrets a delivery may prove: the current one, then the previous one
 * while its grace runs. Null when the current one cannot be opened.
 */
export function openWebhookSecrets(routineId: string, trigger: AgentRoutineWebhookTrigger, now = new Date()): string[] | null {
  let current: string;
  try {
    current = decryptObject<string>(trigger.secretSealed);
    if (typeof current !== 'string' || current.length === 0) throw new Error('empty secret');
  } catch (error) {
    const last = lastSecretErrorAt.get(routineId);
    if (last === undefined || now.getTime() - last >= SECRET_ERROR_LOG_INTERVAL_MS) {
      if (lastSecretErrorAt.size > 10_000) lastSecretErrorAt.clear();
      lastSecretErrorAt.set(routineId, now.getTime());
      logger.error('A webhook trigger secret cannot be opened; rotate the secret', {
        routineId, error: error instanceof Error ? error.message : String(error),
      });
    }
    return null;
  }
  const secrets = [current];
  if (previousValidUntil(trigger, now) && trigger.previousSecretSealed) {
    try {
      const previous = decryptObject<string>(trigger.previousSecretSealed);
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
