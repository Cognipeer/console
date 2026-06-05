import { makePiiScanRoute } from '../shared';

/**
 * POST /api/client/v1/pii/mask
 *
 * Partially mask PII against a stored policy (j***@gmail.com).
 *
 * Body: { policy_key: string (required), text: string (required), locale?: string }
 */
export const POST = makePiiScanRoute('mask');
