import { makePiiScanRoute } from '../shared';

/**
 * POST /api/client/v1/pii/redact
 *
 * Redact PII against a stored policy ([REDACTED_<CATEGORY>]).
 *
 * Body: { policy_key: string (required), text: string (required), locale?: string }
 */
export const POST = makePiiScanRoute('redact');
