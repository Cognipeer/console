/**
 * The `consoleIdentity` namespace: the "Console identity" upstream auth option of MCP servers and
 * connected agents (lib/iam/consoleIdentity.ts). Turkish counterpart in consoleIdentity.tr.ts must
 * keep the same keys.
 */

export const consoleIdentityEn = {
  optionLabel: 'Console identity',
  summary:
    'Console sends a short-lived token for the person behind each call (Authorization: Bearer, signed RS256, valid five minutes, audience = the URL configured here). Nothing secret is stored; a call made without a signed-in person is refused.',
  verifyHint: 'Give these to the team that runs the server; it verifies each token against the key set.',
  issuer: 'Issuer',
  jwks: 'Key set (JWKS)',
  copy: 'Copy',
  copied: 'Copied',
  learnMore: 'How to verify the token',
};
