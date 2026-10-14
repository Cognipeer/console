/**
 * The `ssoError` codes the single sign-on flow sends back to /login, and the
 * message each one shows (keys under `login.sso.errors`). The code arrives in
 * the URL, so only the codes listed here pick a message; anything else gets
 * the generic one.
 */
const SSO_ERROR_MESSAGE_KEYS = new Map<string, string>([
  ['not_found', 'notFound'],
  ['unavailable', 'unavailable'],
  ['state_mismatch', 'expired'],
  ['expired', 'expired'],
  ['invalid_request', 'invalidRequest'],
  ['idp_error', 'idpError'],
  ['no_subject', 'noSubject'],
  ['no_email', 'noEmail'],
  ['email_not_verified', 'emailNotVerified'],
  ['account-link-refused', 'accountLinkRefused'],
  ['login-disabled', 'loginDisabled'],
  ['client_auth_method_mismatch', 'clientAuthMethodMismatch'],
  ['client_auth_failed', 'clientAuthFailed'],
  ['callback_failed', 'callbackFailed'],
]);

export const SSO_ERROR_FALLBACK_KEY = 'callbackFailed';

/** Codes only an administrator can resolve (the connection is wrong): retrying will not help. */
const ADMIN_FIX_CODES = new Set(['client_auth_method_mismatch', 'client_auth_failed']);

/** The `login.sso.errors` key for an `ssoError` code. */
export function ssoErrorMessageKey(code: string | null | undefined): string {
  return (code && SSO_ERROR_MESSAGE_KEYS.get(code)) || SSO_ERROR_FALLBACK_KEY;
}

/** Whether the error is one an administrator has to fix, so the message stays until it is read. */
export function ssoErrorNeedsAdmin(code: string | null | undefined): boolean {
  return Boolean(code && ADMIN_FIX_CODES.has(code));
}

/** Every key a code can pick (the fallback included), for checking the message catalog. */
export function ssoErrorMessageKeys(): string[] {
  return [...new Set([...SSO_ERROR_MESSAGE_KEYS.values(), SSO_ERROR_FALLBACK_KEY])];
}
