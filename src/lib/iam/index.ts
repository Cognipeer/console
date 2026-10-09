/**
 * Policy engine public surface (SERVER ONLY — loads Cedar WASM lazily).
 *
 *   import { authorize, authorizeGate, resolveUserPrincipal, ... } from '@/lib/iam';
 *
 * UIs that only need labels/levels import from '@/lib/iam/actions' (pure, no WASM).
 */
export * from './actions';
export * from './events';
export * from './entities';
export * from './managedPolicies';
export { getIamSchema, ensureSchemaPreparsed } from './schemaState';
export { buildSchema, IAM_CONTEXT_ATTRS } from './schema';
export * from './groupGrants';
export * from './principalCache';
export * from './store';
export * from './context';
export * from './settings';
export {
  compileSpec,
  compileSpecToCedar,
  parsePolicySpec,
  verifySpecReferences,
  type CompileOutcome,
  type PolicyEffect,
  type PolicyIssue,
  type PolicySpec,
  type PolicySpecConditions,
  type PolicySpecPrincipals,
  type PolicySpecResources,
} from './policySpec';
export {
  authorize,
  authorizeGate,
  configureIamEngine,
  customPolicyIdsOf,
  describeTenantPolicySet,
  getIamEngineStats,
  invalidateTenantPolicySet,
  VERSION_CHECK_MS,
  type AuthorizeGateInput,
  type AuthorizeInput,
  type AuthorizeResult,
  type IamEngineConfig,
  type IamEngineStats,
  type IamTenantRef,
} from './engine';
