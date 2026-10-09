/**
 * Validation of custom policy TEXT (no database): parse, limits, the reserved
 * `@managed` annotation, and type-checking against the generated schema.
 * Shared by the store (write-time validation), the spec compiler and the
 * compile / preview endpoints.
 */

import { policyAnnotations, policyToJson, splitPolicyText, type CedarMessage } from './cedar';
import { MANAGED_ANNOTATION } from './managedPolicies';
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
 * Only the scope is looked at (a `when` clause is arbitrary logic), so this has
 * no false positives: a statement it flags really cannot apply.
 */
function unreachableScope(json: { action?: ScopeJson; resource?: ScopeJson }): string | null {
  const catalog = new Map(getIamSchema().catalog.map((a) => [a.id, a]));
  const named: string[] = [];
  const action = json.action;
  if (action?.op === '==' && action.entity?.id) named.push(action.entity.id);
  else if (action?.op === 'in') {
    if (action.entity?.id) named.push(action.entity.id);
    for (const e of action.entities ?? []) if (e.id) named.push(e.id);
  }
  if (named.length > 0 && named.every((id) => catalog.get(id)?.kind === 'resource')) {
    return 'only names actions about individual resources, which the request gates do not check yet';
  }
  const resource = json.resource;
  if (resource && (resource.op === '==' || resource.op === 'in') && resource.entity?.type && resource.entity.type !== 'Service') {
    return `is limited to ${resource.entity.type} entities, but the request gates only check whole services`;
  }
  if (resource?.op === 'is' && resource.entity_type && resource.entity_type !== 'Service') {
    return `is limited to ${resource.entity_type} entities, but the request gates only check whole services`;
  }
  return null;
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
    const why = unreachableScope(json.json as unknown as { action?: ScopeJson; resource?: ScopeJson });
    if (!why) return;
    const forbid = json.json.effect === 'forbid';
    (forbid ? errors : warnings).push({
      message: `This ${forbid ? 'forbid' : 'permit'} statement ${why}, so it ${forbid ? 'would never block anything' : 'would never grant anything'}.`
        + (parts.policies.length > 1 ? ` (statement ${i + 1})` : ''),
      policyId: `candidate#${i}`,
    });
  });
  return { valid: errors.length === 0, errors, warnings, statements: parts.policies };
}

