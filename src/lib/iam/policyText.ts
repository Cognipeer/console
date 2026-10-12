/**
 * Validation of custom policy TEXT (no database): parse, limits, the reserved
 * `@managed` annotation, and type-checking against the generated schema.
 * Shared by the store (write-time validation), the spec compiler and the
 * compile / preview endpoints.
 */

import { policyAnnotations, policyToJson, splitPolicyText, type CedarMessage } from './cedar';
import { RUNTIME_ENFORCED_ACTIONS, impliedLevelActionIds } from './actions';
import { askedGateActions } from './gateActions';
import { MANAGED_ANNOTATION } from './managedPolicies';
import { isRuntimeEnforced } from './runtimeEnforced';
import { getIamSchema, validateAgainstSchema } from './schemaState';

export const MAX_POLICY_TEXT_BYTES = 64 * 1024;
export const MAX_STATEMENTS_PER_POLICY = 50;

/**
 * Bounds on a tenant's WHOLE custom policy set. The per-policy limits above
 * alone allow 500 x 50 statements (4.5 MB of Cedar): measured with the real
 * engine that is ~67 ms of event-loop time per decision, ~5 s of blocked loop
 * on every node whenever a policy is written, and a policy list of tens of MB.
 * At these caps a decision costs ~1.4 ms and a reload ~100 ms, which is what
 * the hot path is sized for.
 */
export const MAX_POLICIES_PER_TENANT = 500;
export const MAX_STATEMENTS_PER_TENANT = 500;
export const MAX_TENANT_POLICY_BYTES = 256 * 1024;

export interface PolicyValidation {
  valid: boolean;
  errors: CedarMessage[];
  warnings: CedarMessage[];
  /** The parsed statements (empty when the text does not parse). */
  statements: string[];
}

// ── statements that can never meet a gate decision ──────────────────────

interface ScopeJson {
  op?: string;
  entity?: { type?: string; id?: string };
  entities?: Array<{ type?: string; id?: string }>;
  entity_type?: string;
}

/** The action ids a statement's action scope names (`== Action::"x"`, `in Action::"x"`, `in [..]`). */
function namedActions(action: ScopeJson | undefined): string[] {
  const named: string[] = [];
  if (action?.op === '==' && action.entity?.id) named.push(action.entity.id);
  else if (action?.op === 'in') {
    if (action.entity?.id) named.push(action.entity.id);
    for (const e of action.entities ?? []) if (e.id) named.push(e.id);
  }
  return named;
}

/** Entity types the runtimes ask about: the portal, the agent (run through a portal, answered, or a session's), and the project the agent is in. */
const RUNTIME_PLANE_TYPES: ReadonlySet<string> = new Set(['Portal', 'Agent', 'Project', 'FileBucket']);

/**
 * Can a statement with this action scope match a decision of a runtime of this build
 * (the portal's, the agent routes')? An action scope that names nothing is every action;
 * the Read and Write levels contain the runtime actions of that level (`portal.use` and
 * `agent.session_view_others` in Read; `agent.invoke`, `agent.approve` and
 * `agent.session_manage_others` in Write).
 */
function mayReachRuntime(named: readonly string[]): boolean {
  const runtimeIds = Object.keys(RUNTIME_ENFORCED_ACTIONS).filter((id) => isRuntimeEnforced(id));
  if (named.length === 0) return runtimeIds.length > 0;
  const catalog = new Map(getIamSchema().catalog.map((a) => [a.id, a]));
  return named.some((id) => isRuntimeEnforced(id) || runtimeIds.some((runtimeId) => catalog.get(runtimeId)?.group === id));
}

/**
 * Why the SCOPE of a statement (its `action` and `resource` heads) can never
 * match a decision the server takes, or null. The request gates only ask about
 * service-level actions on `Service::"<id>"` entities (see gateReach in
 * policySpec.ts), and a Service entity has no parent, so:
 *
 *  - an action scope that names only resource-level actions (`agent.delete`)
 *    never matches a gate action;
 *  - a resource scope `== / in / is` of any entity type other than Service
 *    (`Agent::"x"`, `Project::"p"`) never matches a Service.
 *
 * The exceptions are the runtimes: the portal runtime, where it exists, asks `portal.use`
 * about a Portal and `agent.invoke` / `agent.approve` about an Agent that is `in` the portal
 * and in its project; the agent routes ask `agent.approve` and the session actions about
 * the Agent of a session. A statement that can match those is not flagged.
 *
 * Only the scope is looked at (a `when` clause is arbitrary logic), so this has
 * no false positives: a statement it flags really cannot apply.
 */
function unreachableScope(json: { action?: ScopeJson; resource?: ScopeJson }): string | null {
  const catalog = new Map(getIamSchema().catalog.map((a) => [a.id, a]));
  const named = namedActions(json.action);
  if (named.length > 0 && named.every((id) => catalog.get(id)?.kind === 'resource' && !isRuntimeEnforced(id))) {
    return 'only names actions about individual resources, which the request gates do not check yet';
  }
  const resource = json.resource;
  const entityType = resource && (resource.op === '==' || resource.op === 'in') ? resource.entity?.type
    : resource?.op === 'is' ? resource.entity_type
      : undefined;
  if (entityType && entityType !== 'Service') {
    if (RUNTIME_PLANE_TYPES.has(entityType) && mayReachRuntime(named)) return null;
    return `is limited to ${entityType} entities, but the request gates only check whole services`;
  }
  return null;
}

/**
 * Why a statement whose action scope names only service-level actions can never
 * apply: nothing in this build asks for any of them (`models.admin` when only
 * Read and Write are ever checked on `models`). Only a WARNING - what counts as
 * "asked" is read from the routes the server registered (gateActions.ts), and
 * is unknown (null) before they are.
 */
function unaskedScope(json: { action?: ScopeJson }): string | null {
  const asked = askedGateActions();
  if (!asked) return null;
  const catalog = new Map(getIamSchema().catalog.map((a) => [a.id, a]));
  const named = namedActions(json.action);
  if (named.length === 0 || !named.every((id) => catalog.get(id)?.kind === 'service')) return null;
  if (named.some((id) => asked.has(id))) return null;
  const list = named.slice(0, 6).join(', ') + (named.length > 6 ? ', ...' : '');
  return `only names actions that nothing in the product checks yet (${list})`;
}

/**
 * A permit written as text that names a higher level without the lower ones (`webhooks.admin` without `webhooks.write`
 * and `webhooks.read`; `Write` without `Read`). The guided editor adds the lower levels to every allow rule - levels add
 * up - but Cedar does not: the statement grants exactly what it names, so whoever it is for could administer a service
 * and still not read it. A warning, never a refusal (a rule may mean exactly that); null when nothing is missing.
 */
function levelsNotAddedUp(json: { action?: ScopeJson }): string | null {
  const catalog = new Map(getIamSchema().catalog.map((a) => [a.id, a]));
  const named = namedActions(json.action).filter((id) => catalog.has(id));
  const have = new Set(named);
  const missing: string[] = [];
  for (const id of named) {
    const def = catalog.get(id);
    if (!def) continue;
    for (const lower of impliedLevelActionIds(def)) {
      if (catalog.has(lower) && !have.has(lower) && !missing.includes(lower)) missing.push(lower);
    }
  }
  if (missing.length === 0) return null;
  const list = (ids: readonly string[]) => ids.slice(0, 6).join(', ') + (ids.length > 6 ? ', ...' : '');
  return `names ${list(named)} but not ${list(missing)}. In policy text levels do not add up (Admin does not include Write or Read, Write does not include Read), so it grants only what it names. List the lower levels too, or build the rule in the guided editor, which adds them`;
}

/** Validate Cedar text as a custom policy against the generated schema. Pure: touches no store. */
export function validateCustomPolicyText(cedar: unknown, options: { reachability?: boolean } = {}): PolicyValidation {
  const fail = (message: string): PolicyValidation => ({
    valid: false,
    errors: [{ message }],
    warnings: [],
    statements: [],
  });
  if (typeof cedar !== 'string' || cedar.trim() === '') return fail('Policy text is empty');
  if (Buffer.byteLength(cedar, 'utf8') > MAX_POLICY_TEXT_BYTES) {
    return fail(`Policy text exceeds ${MAX_POLICY_TEXT_BYTES} bytes`);
  }
  const parts = splitPolicyText(cedar);
  if (!parts.ok) return { valid: false, errors: parts.errors, warnings: [], statements: [] };
  if (parts.templates.length > 0) return fail('Policy templates are not supported');
  if (parts.policies.length === 0) return fail('Policy text contains no permit/forbid statement');
  if (parts.policies.length > MAX_STATEMENTS_PER_POLICY) {
    return fail(`A policy may contain at most ${MAX_STATEMENTS_PER_POLICY} statements`);
  }
  for (const statement of parts.policies) {
    const annotations = policyAnnotations(statement);
    if (annotations && MANAGED_ANNOTATION in annotations) {
      return fail(`The @${MANAGED_ANNOTATION} annotation is reserved for built-in policies`);
    }
  }
  const record: Record<string, string> = {};
  parts.policies.forEach((statement, i) => {
    record[`candidate#${i}`] = statement;
  });
  const result = validateAgainstSchema(record);
  if (!result.valid) {
    return { valid: false, errors: result.errors, warnings: result.warnings, statements: parts.policies };
  }

  // A deny rule that cannot match any request the gates take is refused (it would
  // look like protection and be none); a permit like that only gets a warning.
  // (The spec compiler judges its own output on the spec, with better words.)
  const errors = [...result.errors];
  const warnings = [...result.warnings];
  if (options.reachability === false) {
    return { valid: errors.length === 0, errors, warnings, statements: parts.policies };
  }
  parts.policies.forEach((statement, i) => {
    const json = policyToJson(statement);
    if (!json.ok) return;
    const scope = json.json as unknown as { action?: ScopeJson; resource?: ScopeJson };
    const forbid = json.json.effect === 'forbid';
    const lowerLevels = forbid ? null : levelsNotAddedUp(scope);
    // Said after the statement's reachability warnings (those are the more fundamental problem).
    const sayLowerLevels = () => {
      if (!lowerLevels) return;
      warnings.push({
        message: `This permit statement ${lowerLevels}.` + (parts.policies.length > 1 ? ` (statement ${i + 1})` : ''),
        policyId: `candidate#${i}`,
      });
    };
    const why = unreachableScope(scope);
    if (why) {
      (forbid ? errors : warnings).push({
        message: `This ${forbid ? 'forbid' : 'permit'} statement ${why}, so it ${forbid ? 'would never block anything' : 'would never grant anything'}.`
          + (parts.policies.length > 1 ? ` (statement ${i + 1})` : ''),
        policyId: `candidate#${i}`,
      });
      sayLowerLevels();
      return;
    }
    // Not provably unreachable, but nothing asks for its actions: say so, never refuse it.
    const unasked = unaskedScope(scope);
    if (unasked) {
      warnings.push({
        message: `This ${forbid ? 'forbid' : 'permit'} statement ${unasked}, so it ${forbid ? 'would never block anything' : 'would never grant anything'}.`
          + (parts.policies.length > 1 ? ` (statement ${i + 1})` : ''),
        policyId: `candidate#${i}`,
      });
    }
    sayLowerLevels();
  });
  return { valid: errors.length === 0, errors, warnings, statements: parts.policies };
}

