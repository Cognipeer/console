/**
 * Shared Fastify auth, request-context, parsing and cookie helpers.
 *
 * The implementation lives in `./utils/*`; this module keeps the import path
 * (`@/server/api/fastify-utils`) and the exact export surface. Re-exports are
 * explicit so module-internal helpers shared between the `utils` modules never
 * become part of the public surface.
 */
export {
  applyStreamHeaders,
  getAuthzClientIp,
  getClientIp,
  getHeaderValue,
  parseBooleanQuery,
  parseCsvQuery,
  readJsonBody,
  readJsonObjectBody,
  readOptionalJsonObjectBody,
  safeReadJsonBody,
  trustsEveryHop,
} from './utils/request';
export { RbacAuthorizationError } from './utils/rbacError';
export {
  clearSessionCookies,
  getSessionContext,
  rejectInactiveSessionAccount,
  requireProjectContextForRequest,
  requireSessionContext,
  resolveSessionRbacContext,
  sendProjectContextError,
  setSessionCookies,
} from './utils/session';
export type { ApiSessionContext } from './utils/session';
export {
  authorizationRefusalOf,
  authorizeResourceForRequest,
  authorizeServiceForRequest,
  refreshRequestPrincipal,
  resourceRefusalError,
  serviceActionAllowedForRequest,
  serviceLevelForRequest,
  serviceOffRefusal,
  serviceRefusalError,
} from './utils/rbac';
export type { ResourceRefusalInput, ResourceRequestAuthzInput } from './utils/rbac';
export {
  getApiTokenContextForRequest,
  requireApiTokenContext,
  sendApiTokenError,
} from './utils/apiToken';
export {
  withAnthropicApiRequestContext,
  withClientApiRequestContext,
  withOpenAiApiRequestContext,
} from './utils/clientApiContext';
export type { ClientApiContextOptions, ClientApiErrorStyle } from './utils/clientApiContext';
export { withApiRequestContext } from './utils/withApiRequestContext';
