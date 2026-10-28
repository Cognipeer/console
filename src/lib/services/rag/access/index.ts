/**
 * Knowledge Engine access control: who may read which documents of a
 * knowledge base. Off unless a module switches it on (`IRagModule.access`).
 */

export * from './principals';
export * from './caller';
export {
  DEFAULT_USER_MATCH,
  MAX_CALLER_PRINCIPALS,
  invalidateRagIdentityCache,
  isUserMatchRule,
  resolveCallerPrincipals,
  resolvePersonPrincipals,
  userMatchRulesOf,
  type PersonIdentityMatch,
  type PersonPrincipals,
} from './identity';
export {
  computeReadableFolders,
  effectiveAclNodeOf,
  invalidateRagAccessTree,
  resolveRagAccess,
  type RagAccessDocument,
  type RagAccessModule,
  type RagAccessScope,
  type ResolveRagAccessInput,
} from './scope';
export * from './vectorPlan';
