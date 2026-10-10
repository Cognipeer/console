'use client';

/**
 * How a failed people-and-access call is shown. The server answers
 * `{ error, code }` in English; a known `code` is worded in the user's language
 * (`iamDirectory.errors.<code>`), anything else keeps the server's sentence. A
 * refusal of the authorization engine (403) or a request it could not decide
 * (503) names a decision: the notice links to the Access check, which explains
 * it. An outage is never shown as a silent failure.
 */

import Link from 'next/link';
import { Alert, Anchor, Group, Text } from '@mantine/core';
import { IconAlertTriangle } from '@tabler/icons-react';
import { notifications } from '@mantine/notifications';
import { PEOPLE_ERROR_CODES } from '@/lib/iam/identity';
import { IamApiError, iamLinks } from './client';
import { DirectoryApiError } from './directoryApi';
import type { Translate } from './format';

/**
 * Codes with a message of their own: every code the people endpoints can answer
 * with (the server's list, `PEOPLE_ERROR_CODES`) plus the few the directory and the
 * engine add. A new code from the server falls back to its English sentence until a
 * message is added (a test fails until it is).
 */
export const KNOWN_ERROR_CODES = [
  ...PEOPLE_ERROR_CODES,
  'invalid_type',
  'authorization_unavailable',
  'already_in_state',
  'not_a_member',
  'no_pending_invite',
] as const;

const KNOWN = new Set<string>(KNOWN_ERROR_CODES);

export function isKnownErrorCode(code: string | undefined): boolean {
  return !!code && KNOWN.has(code);
}

/** The message of a failure in the user's language; `t` is bound to the `iamDirectory` namespace. */
export function describeError(err: unknown, t: Translate, fallback?: string): string {
  if (err instanceof IamApiError) {
    if (isKnownErrorCode(err.code)) return t(`errors.${err.code}`);
    if (err.status === 401) return t('errors.unauthorized');
    if (err.status === 403) return t('errors.forbidden');
    if (err.status === 404) return t('errors.notFound');
    // A 429 without a code is a limit with its own sentence (the plan's user limit...): say what the server said.
    if (err.status === 429) {
      return err.message && !/^HTTP \d+$/.test(err.message) ? err.message : t('errors.rate_limited');
    }
    if (err.status === 503) return t('errors.authorization_unavailable');
    if (err.message && !/^HTTP \d+$/.test(err.message)) return err.message;
    return fallback ?? t('errors.generic');
  }
  if (err instanceof Error && err.message) return err.message;
  return fallback ?? t('errors.generic');
}

/** The decision id a failure names, when it names one. */
export function decisionOf(err: unknown): string | null {
  return err instanceof DirectoryApiError && err.decisionId ? err.decisionId : null;
}

/** The "Why?" link of a refusal that names a decision; nothing for any other failure. */
export function DecisionLink({ error, t }: { error: unknown; t: Translate }) {
  const decisionId = decisionOf(error);
  if (!decisionId) return null;
  return (
    <Anchor component={Link} href={iamLinks.decision(decisionId)} size="xs">
      {t('errors.why')}
    </Anchor>
  );
}

/** A failure as text plus, when the engine refused or could not decide, a link to the decision. */
export function ErrorText({ error, t, fallback }: { error: unknown; t: Translate; fallback?: string }) {
  const decisionId = decisionOf(error);
  return (
    <Group gap={6} wrap="wrap" align="baseline">
      <Text size="sm" component="span">
        {describeError(error, t, fallback)}
      </Text>
      {decisionId ? (
        <Anchor component={Link} href={iamLinks.decision(decisionId)} size="xs">
          {t('errors.why')}
        </Anchor>
      ) : null}
    </Group>
  );
}

/** A red toast for a failed call (with the decision link when there is one). */
export function notifyError(error: unknown, t: Translate, title: string, fallback?: string): void {
  notifications.show({
    title,
    message: <ErrorText error={error} t={t} fallback={fallback} />,
    color: 'red',
  });
}

/** The inline error of a form: the failure worded for the person, with the decision link when it has one. */
export function FormError({ error, t, title }: { error: unknown; t: Translate; title?: string }) {
  if (!error) return null;
  return (
    <Alert color="red" variant="light" icon={<IconAlertTriangle size={16} />} title={title} role="alert" data-testid="form-error">
      <ErrorText error={error} t={t} />
    </Alert>
  );
}
