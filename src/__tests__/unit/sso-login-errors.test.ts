/**
 * The `ssoError` code comes from the URL, so /login only shows a message the
 * catalog has for a code the SSO flow actually sends; anything else gets the
 * generic one.
 */
import { describe, expect, it } from 'vitest';
import { SSO_ERROR_FALLBACK_KEY, ssoErrorMessageKey, ssoErrorMessageKeys, ssoErrorNeedsAdmin } from '@/lib/auth/ssoLoginErrors';
import { en } from '@/lib/i18n/messages/en';
import { tr } from '@/lib/i18n/messages/tr';

const messages = (catalog: typeof en) => catalog.login.sso.errors as Record<string, string>;

describe('the SSO error messages on /login', () => {
  it('has a message in every catalog for every key a code can pick', () => {
    for (const key of ssoErrorMessageKeys()) {
      expect(messages(en)[key], key).toEqual(expect.any(String));
      expect(messages(tr)[key], key).toEqual(expect.any(String));
    }
  });

  it('says what an administrator has to fix when the IdP refused the console client, and keeps it on screen', () => {
    expect(messages(en)[ssoErrorMessageKey('client_auth_method_mismatch')]).toMatch(/client_secret_post.*client_secret_basic/);
    expect(messages(en)[ssoErrorMessageKey('client_auth_failed')]).toMatch(/client secret/);
    expect(ssoErrorNeedsAdmin('client_auth_method_mismatch')).toBe(true);
    expect(ssoErrorNeedsAdmin('client_auth_failed')).toBe(true);
    expect(ssoErrorNeedsAdmin('callback_failed')).toBe(false);
    expect(ssoErrorNeedsAdmin('expired')).toBe(false);
  });

  it('gives any other value of the URL parameter the generic message', () => {
    for (const code of [null, undefined, '', 'unknown', 'constructor', '__proto__', 'toString', 'sso.errors.x']) {
      expect(ssoErrorMessageKey(code)).toBe(SSO_ERROR_FALLBACK_KEY);
      expect(ssoErrorNeedsAdmin(code)).toBe(false);
    }
    expect(messages(en)[SSO_ERROR_FALLBACK_KEY]).toBe('Single sign-on failed. Please try again.');
  });
});
