/**
 * GET /api/client/v1/evaluation/runs
 *
 * List runs newest-first. Optional query: `suite_key` (filter), `limit`
 * (1–200). Returns run summaries (aggregate only); fetch a single run by id
 * for the per-item scores.
 */

export { runsListHandler as GET } from '../shared';
