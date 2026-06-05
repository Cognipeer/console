/**
 * POST /api/client/v1/evaluation/suites/{key}/run
 *
 * Trigger a synchronous run of a named suite over its dataset and return the
 * scored result (aggregate + per-item scores). The suite, its target and its
 * dataset must already exist (configured on the dashboard).
 */

export { suiteRunHandler as POST } from '../../../shared';
