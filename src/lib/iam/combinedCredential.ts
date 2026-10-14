/**
 * The combined credential: an application token AND the signed statement about the person a call is for, carried in the
 * one header an SDK lets its caller set.
 *
 *   Authorization: Bearer <api token>~<user token>
 *
 * Most client libraries expose a single "API key" that they place in `Authorization: Bearer <key>` and offer no way to add a
 * second header. Putting both values in the key lets such a client act for a user without changing the client.
 *
 * Why `~`: it is legal in an RFC 6750 bearer credential, needs no escaping anywhere, and cannot occur in either part - an
 * API token is `cpeer_` plus hex, a user token is a JWT (base64url segments joined by `.`). So the split is unambiguous
 * and nothing a token can contain ever moves the boundary.
 *
 * This module only SPLITS. Both halves go on to the checks they always had: the first half is authenticated as an API
 * token, the second is handed to the delegation gate as `X-Cognipeer-User-Token` and verified there. A combined
 * credential is therefore exactly as strong as sending the two headers, and no weaker.
 *
 * Refusals (`CombinedCredentialError`, always 400, `invalid_combined_credential`): an empty half, more than one separator,
 * and a combined credential sent together with an `X-Cognipeer-User-Token` header (two statements about who the call is
 * for - never guess which one wins).
 */

export const COMBINED_CREDENTIAL_SEPARATOR = '~';

export class CombinedCredentialError extends Error {
  readonly status = 400;
  readonly code = 'invalid_combined_credential';

  constructor(message: string) {
    super(message);
    this.name = 'CombinedCredentialError';
  }
}

export interface SplitCredential {
  apiToken: string;
  userToken: string;
}

/**
 * The two halves of a combined `Authorization` value, or `null` when the value is not a combined credential (no
 * separator: an ordinary API token, left exactly as it is). Throws {@link CombinedCredentialError} for a value that
 * has the separator but is not a well-formed pair.
 */
export function splitCombinedAuthorization(authorization: string | undefined | null): SplitCredential | null {
  if (typeof authorization !== 'string') return null;
  if (!/^bearer /i.test(authorization)) return null;
  const credential = authorization.slice('bearer '.length).trim();
  if (!credential.includes(COMBINED_CREDENTIAL_SEPARATOR)) return null;

  const parts = credential.split(COMBINED_CREDENTIAL_SEPARATOR);
  if (parts.length !== 2) {
    throw new CombinedCredentialError('Combined credential must be exactly "<api token>~<user token>"');
  }
  const [apiToken, userToken] = parts;
  if (!apiToken || !userToken) {
    throw new CombinedCredentialError('Combined credential must carry both an API token and a user token');
  }
  return { apiToken, userToken };
}
