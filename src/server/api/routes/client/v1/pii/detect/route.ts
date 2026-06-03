import { makePiiScanRoute } from '../shared';

/**
 * POST /api/client/v1/pii/detect
 *
 * Detect PII against a stored policy without transforming the text.
 *
 * Body: { policy_key: string (required), text: string (required), locale?: string }
 * Categories, custom patterns and languages are taken from the policy.
 */
export const POST = makePiiScanRoute('detect');
