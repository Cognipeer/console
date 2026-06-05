import { makePiiScanRoute } from '../shared';

/**
 * POST /api/client/v1/pii/scan
 *
 * Scan text against a stored policy and apply the policy's default action, or
 * override it per call.
 *
 * Body:
 *   - policy_key: string (required)
 *   - text: string (required)
 *   - action?: detect | redact | mask | block | tokenize — override the default
 *   - locale?: string
 */
export const POST = makePiiScanRoute();
