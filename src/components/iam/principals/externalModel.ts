/** Validation and wording for the "external identity" form (pure, unit-tested). */

export interface ExternalDraft {
  issuer: string | null;
  subject: string;
  name: string;
  email: string;
  active: boolean;
}

export const EXTERNAL_SUBJECT_MAX = 256;
const EMAIL_PATTERN = /^\S+@\S+\.\S+$/;

export interface ExternalChecks {
  issuer: boolean;
  subject: boolean;
  email: boolean;
  ready: boolean;
}

/** Issuer and subject are required; the email may be empty, but not malformed. */
export function checkExternal(draft: ExternalDraft): ExternalChecks {
  const issuer = Boolean(draft.issuer);
  const subject = draft.subject.trim().length > 0 && draft.subject.trim().length <= EXTERNAL_SUBJECT_MAX;
  const email = draft.email.trim() === '' || EMAIL_PATTERN.test(draft.email.trim());
  return { issuer, subject, email, ready: issuer && subject && email };
}

/** The request body: blank optional fields are left out. */
export function buildExternalBody(draft: ExternalDraft, groupIds: readonly string[]) {
  const name = draft.name.trim();
  const email = draft.email.trim();
  return {
    issuer: draft.issuer ?? '',
    subject: draft.subject.trim(),
    ...(name ? { name } : {}),
    ...(email ? { email } : {}),
    ...(groupIds.length > 0 ? { groupIds: [...groupIds] } : {}),
    active: draft.active,
  };
}

/** Which field a 409 belongs to (`identity_taken` -> subject, `email_taken` -> email). */
export function conflictField(code: string | undefined): 'subject' | 'email' | null {
  if (code === 'identity_taken') return 'subject';
  if (code === 'email_taken') return 'email';
  return null;
}
