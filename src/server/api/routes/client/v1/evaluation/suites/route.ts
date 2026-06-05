/**
 * GET /api/client/v1/evaluation/suites
 *
 * List the evaluation suites configured for the caller's project. Each suite
 * binds a target + dataset + scorers; trigger one with
 * `POST /api/client/v1/evaluation/suites/{key}/run`.
 */

export { suitesListHandler as GET } from '../shared';
