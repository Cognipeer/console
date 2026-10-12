/**
 * A forbid that cannot be evaluated must not be skipped.
 *
 * Cedar evaluates every policy of a set on its own. A policy that ERRORS while it
 * is evaluated (an attribute the entity does not have, a value of the wrong type,
 * an entity that was not sent with the request) takes no part in the decision: it
 * is neither a permit nor a forbid, and only the diagnostics say it happened. For a
 * permit that is the safe side - nothing is granted. For a forbid it is the unsafe
 * one: the rule that was written to BLOCK something silently stops blocking it, and
 * the request is allowed by whatever else matched.
 *
 * So, whenever the verdict is "allow", the forbids that errored are looked at:
 *
 *  - a CUSTOM forbid that errored counts as a deny. The decision names it as the
 *    reason (so the audit trail and the Access check say which rule blocked), and
 *    the evaluation problem stays in `errors`. It is a deny, not an outage: the
 *    rule's author wanted this request refused and the engine cannot show it is
 *    not one of the cases.
 *  - a MANAGED forbid that errored is the engine's own boundary (token scope,
 *    project limit, portal access list) failing: nobody can vouch for an allow
 *    then, so the decision FAILS (the callers answer 503, never an allow).
 *
 * A deny stays a deny: a skipped forbid cannot make it anything else.
 *
 * Pure (no Cedar, no database); shared by the engine and the impact preview, which
 * must judge a request the way the engine will.
 */

export interface ForbidGuardInput {
  allowed: boolean;
  reasons: readonly string[];
  /** `<policy id>: <message>` per policy that errored. */
  errors: readonly string[];
  /** The Cedar ids behind `errors`. */
  errorPolicyIds: readonly string[];
}

export type ForbidGuardOutcome =
  | {
      kind: 'decided';
      allowed: boolean;
      reasons: string[];
      /** Custom forbids that errored and so counted as a deny (empty when the verdict did not change). */
      erroredForbids: string[];
      /** Extra lines for the decision's `errors`, in words. */
      notes: string[];
    }
  | { kind: 'failed'; errors: string[] };

export function guardForbidErrors(decision: ForbidGuardInput, forbids: ReadonlySet<string>): ForbidGuardOutcome {
  if (!decision.allowed) {
    return { kind: 'decided', allowed: false, reasons: [...decision.reasons], erroredForbids: [], notes: [] };
  }
  const errored = [...new Set(decision.errorPolicyIds.filter((id) => forbids.has(id)))].sort();
  if (errored.length === 0) {
    return { kind: 'decided', allowed: true, reasons: [...decision.reasons], erroredForbids: [], notes: [] };
  }
  const managed = errored.filter((id) => id.startsWith('managed:'));
  if (managed.length > 0) {
    return {
      kind: 'failed',
      errors: [...decision.errors, ...managed.map((id) => `${id}: a built-in limit could not be evaluated, so the request is not allowed`)],
    };
  }
  return {
    kind: 'decided',
    allowed: false,
    reasons: errored,
    erroredForbids: errored,
    notes: errored.map((id) => `${id}: this deny rule could not be evaluated for the request, so it counts as a deny`),
  };
}
