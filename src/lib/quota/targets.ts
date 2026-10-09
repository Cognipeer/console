/**
 * What a limit's `resource` / `provider` target points at, per service (pure:
 * no React, no I/O; the editor, its tests and the API tests all read it).
 *
 * The guard decides a match with plain equality (`matchesScope` in
 * quotaGuard.ts):
 *
 *     scope 'resource'  ->  policy.scopeId === context.resourceKey
 *     scope 'provider'  ->  policy.scopeId === context.providerKey
 *
 * so what an editor must STORE is whatever the route of that service puts in
 * the context. It differs by service, and it is not always the id:
 *
 *   service                         resourceKey (route)                       providerKey
 *   ------------------------------  ----------------------------------------  --------------------------
 *   llm, embedding, image           the model key (`body.model`)              never set
 *   stt, tts, ocr, decision         the model key                             never set
 *   moderation                      the model key (no route is guarded yet)   never set
 *   vector                          the index KEY (the URL's `externalId`     the vector provider's key
 *                                   segment carries the key, not the
 *                                   provider's external id)
 *   file                            the bucket key                            the file provider's key
 *                                                                             (dashboard uploads only)
 *   tracing                         the agent NAME the SDK reports            never set
 *                                   (`payload.agent.name`, else the session
 *                                   id)
 *   agent                           the agent KEY                             never set
 *   global                          whichever of the above the request has    vector / file provider key
 *
 * `global` limits are matched against every service's context but the agent
 * domain's (see `DOMAINS_WITHOUT_GLOBAL_FALLBACK`), hence the three registry
 * types. A provider scope under a service that never reports a provider can not
 * match anything: `neverApplies` lets the editor say so instead of saving a
 * limit that sits there inert.
 *
 * Keep this table in step with the call sites; unit/quota-targets.test.ts reads
 * the Fastify plugins and fails when a route starts (or stops) putting one of
 * these keys in its quota context.
 */
import type { QuotaDomain, QuotaScope } from './types';

/** The word a person would use for what is picked; the editor turns it into labels and hints. */
export type QuotaTargetNoun = 'model' | 'vectorIndex' | 'fileBucket' | 'agent' | 'agentName' | 'provider' | 'resource';

export interface QuotaTargetSource {
  /**
   * Identity of the KIND of value on offer: two sources with the same id offer
   * interchangeable values, so a chosen value survives a switch between them;
   * different ids do not (a model key is not an index key).
   */
  id: string;
  scope: 'resource' | 'provider';
  /** Resource registry types searched together. */
  types: readonly string[];
  /** Registry attributes a row must carry: every name, any of its values (a model's `category`, a provider's `type`). */
  attributes?: Readonly<Record<string, readonly string[]>>;
  /** Which field of the registry row is the string the guard compares with `scopeId`. */
  valueField: 'key' | 'name';
  /** The value may be one the registry does not know (tracing: agent names reported by SDK clients). */
  allowsUnregistered: boolean;
  /** Provider scope only: this service never reports a provider, so a limit on one applies to nothing. */
  neverApplies: boolean;
  noun: QuotaTargetNoun;
}

/** Services whose guarded calls name a MODEL: the registry's `category` of that model is the service itself. */
const MODEL_SERVICES: ReadonlySet<QuotaDomain> = new Set<QuotaDomain>([
  'llm',
  'embedding',
  'image',
  'stt',
  'tts',
  'ocr',
  'decision',
  'moderation',
]);

/** Services whose guarded calls report a provider key (vector and file operations), and the registry `type` of those providers. */
const REPORTED_PROVIDER_TYPES: Partial<Record<QuotaDomain, readonly string[]>> = {
  vector: ['vector'],
  file: ['file'],
  // A global limit is matched against vector and file calls too.
  global: ['vector', 'file'],
};

function resourceSource(domain: QuotaDomain): QuotaTargetSource {
  const common = { scope: 'resource', valueField: 'key', allowsUnregistered: false, neverApplies: false } as const;
  if (MODEL_SERVICES.has(domain)) {
    return { ...common, id: `model:${domain}`, types: ['model'], attributes: { category: [domain] }, noun: 'model' };
  }
  switch (domain) {
    case 'vector':
      return { ...common, id: 'vector-index', types: ['vector-index'], noun: 'vectorIndex' };
    case 'file':
      return { ...common, id: 'file-bucket', types: ['file-bucket'], noun: 'fileBucket' };
    case 'agent':
      return { ...common, id: 'agent:key', types: ['agent'], noun: 'agent' };
    case 'tracing':
      // The name an SDK client reports; console agents report their own name.
      return { ...common, id: 'agent:name', types: ['agent'], valueField: 'name', allowsUnregistered: true, noun: 'agentName' };
    case 'global':
    default:
      return { ...common, id: 'global', types: ['model', 'vector-index', 'file-bucket'], noun: 'resource' };
  }
}

function providerSource(domain: QuotaDomain): QuotaTargetSource {
  const common = { scope: 'provider', valueField: 'key', allowsUnregistered: false, noun: 'provider', types: ['provider'] } as const;
  const providerTypes = REPORTED_PROVIDER_TYPES[domain];
  if (providerTypes) {
    return { ...common, id: `provider:${providerTypes.join('+')}`, attributes: { type: providerTypes }, neverApplies: false };
  }
  // No filter: every provider of the tenant, since none of them can match.
  return { ...common, id: 'provider:any', neverApplies: true };
}

/**
 * Where the target of a `resource` / `provider` limit in `domain` is searched
 * and which value is stored; null for the scopes that name a person, a group,
 * a token, or nobody.
 */
export function quotaTargetSource(domain: QuotaDomain, scope: QuotaScope): QuotaTargetSource | null {
  if (scope === 'resource') return resourceSource(domain);
  if (scope === 'provider') return providerSource(domain);
  return null;
}

/**
 * Whether a target chosen under one service is still the right KIND of value
 * under another (`from` and `to` share the scope): the editor keeps it when so,
 * and forgets it when not. Scopes without a registry target never conflict.
 */
export function isSameTargetKind(scope: QuotaScope, from: QuotaDomain, to: QuotaDomain): boolean {
  const a = quotaTargetSource(from, scope);
  const b = quotaTargetSource(to, scope);
  return a?.id === b?.id;
}
