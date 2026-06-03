import { makePiiScanRoute } from '../shared';

/**
 * POST /api/client/v1/pii/tokenize
 *
 * Reversible masking against a stored policy: replace each PII match with a
 * unique token ([EMAIL_1]) and return a `vault` mapping every token back to its
 * original value. Categories, custom patterns and languages come from the
 * policy. Pair with /api/client/v1/pii/detokenize to restore originals after an
 * LLM round-trip. The vault is returned to the caller, never persisted.
 *
 * Body: { policy_key: string (required), text: string (required), locale?: string }
 */
export const POST = makePiiScanRoute('tokenize');
