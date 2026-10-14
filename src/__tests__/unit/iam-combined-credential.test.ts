/**
 * The combined credential (src/lib/iam/combinedCredential.ts): `Authorization: Bearer <api token>~<user token>`.
 *
 *   ordinary tokens   no separator -> not combined, left exactly as they are
 *   the pair          split on the one `~`; JWT dots and API token hex never move the boundary
 *   malformed         empty halves and extra separators are refused (400, invalid_combined_credential)
 *   scheme            only a Bearer credential is looked at
 */
import { describe, expect, it } from 'vitest';
import { createApiTokenSecret } from '@/lib/services/apiTokens/tokenHashing';
import {
  CombinedCredentialError,
  splitCombinedAuthorization,
} from '@/lib/iam/combinedCredential';

const JWT = 'eyJhbGciOiJSUzI1NiIsImtpZCI6ImsxIn0.eyJpc3MiOiJodHRwczovL2lkcCIsInN1YiI6InUxIn0.c2ln-_x';

describe('splitCombinedAuthorization', () => {
  it('leaves an ordinary API token alone', () => {
    expect(splitCombinedAuthorization(`Bearer ${createApiTokenSecret()}`)).toBeNull();
  });

  it('splits a real API token secret and a JWT', () => {
    const api = createApiTokenSecret();
    expect(splitCombinedAuthorization(`Bearer ${api}~${JWT}`)).toEqual({ apiToken: api, userToken: JWT });
  });

  it('accepts any case of the scheme and surrounding spaces', () => {
    expect(splitCombinedAuthorization(`bearer  cpeer_ab~${JWT} `)).toEqual({ apiToken: 'cpeer_ab', userToken: JWT });
  });

  it.each(['cpeer_ab~', '~' + JWT, `cpeer_ab~${JWT}~x`, '~'])('refuses %s', (credential) => {
    expect(() => splitCombinedAuthorization(`Bearer ${credential}`)).toThrow(CombinedCredentialError);
  });

  it('ignores other schemes and missing headers', () => {
    expect(splitCombinedAuthorization(`Basic a~b`)).toBeNull();
    expect(splitCombinedAuthorization(undefined)).toBeNull();
    expect(splitCombinedAuthorization('')).toBeNull();
  });
});
