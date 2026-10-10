/**
 * Redaction of what identifies people in the report.
 *
 * With --redact every email, name, token label and project name is replaced by a
 * short hash (`h:3fa9c01b7e`), the same value everywhere in one report, so the
 * file can be shared without handing over a directory. The salt is random per
 * run unless one is given (--redact-salt): the same salt makes two runs
 * comparable; without it a hash cannot be guessed back from a list of likely
 * addresses.
 */

import { createHash, randomBytes } from 'node:crypto';

export type Redactor = (kind: 'user' | 'token' | 'project' | 'owner', value: string) => string;

export function makeRedactor(enabled: boolean, salt?: string): Redactor {
  if (!enabled) return (_kind, value) => value;
  const secret = salt && salt.length > 0 ? salt : randomBytes(16).toString('hex');
  return (kind, value) => `h:${createHash('sha256').update(`${secret}\u0000${kind}\u0000${value}`).digest('hex').slice(0, 10)}`;
}

/** What the report calls a person: their email (else their name, else their id). */
export function userLabel(
  redact: Redactor,
  user: { id: string; email?: string | null; name?: string | null },
): string {
  return `user:${redact('user', user.email || user.name || user.id)}`;
}

/** What the report calls an API token: its label and the start of its id (the label is not unique). */
export function tokenLabel(redact: Redactor, token: { id: string; label?: string | null }): string {
  const raw = `${token.label || 'token'}#${token.id.slice(0, 6)}`;
  return `token:${redact('token', raw)}`;
}

export function projectLabel(redact: Redactor, project: { id: string; name?: string | null; key?: string | null }): string {
  return redact('project', project.name || project.key || project.id);
}
