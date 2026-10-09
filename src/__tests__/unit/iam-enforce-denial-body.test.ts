/**
 * The 403 bodies of enforce mode keep the legacy contract: `error` carries the
 * human-readable reason (SDKs and the dashboard surface `body.error`), worded
 * exactly as legacy mode words it, and the structured fields are additive.
 *
 * The HTTP-level parity (the same denied request answered by the real legacy and
 * enforce gates) is in api/iam-enforce-gate.test.ts; this pins the builders.
 */
import { describe, expect, it } from 'vitest';
import { serviceDenialReason } from '@/lib/iam/denialReason';
import { forbiddenBody, undeclaredRouteBody, type EnforceDecision } from '@/lib/iam/enforce';
import { RBAC_SERVICE_DEFINITIONS, SERVICE_PERMISSION_LEVELS } from '@/lib/security/rbac';

type Denial = Extract<EnforceDecision, { allowed: false }>;

const denial = (service: Denial['service'], required: Denial['required']): Denial => ({
  allowed: false,
  source: 'engine',
  service,
  required,
  decisionId: 'dec-0001',
});

describe('serviceDenialReason', () => {
  it('is the sentence legacy mode has always answered with', () => {
    expect(serviceDenialReason('mcp', 'write')).toBe('Forbidden: mcp requires write permission');
    expect(serviceDenialReason('ldap', 'admin')).toBe('Forbidden: ldap requires admin permission');
  });
});

describe('forbiddenBody (engine denial)', () => {
  it('error and message are the legacy reason; code, service, required and decisionId are additive', () => {
    expect(forbiddenBody(denial('mcp', 'write'))).toEqual({
      error: 'Forbidden: mcp requires write permission',
      code: 'forbidden',
      message: 'Forbidden: mcp requires write permission',
      service: 'mcp',
      required: 'write',
      decisionId: 'dec-0001',
    });
  });

  it('never leaks the audit-only detail of the decision (action, project, reasons, policy ids)', () => {
    const body = forbiddenBody({
      ...denial('agents', 'admin'),
      action: 'agents.admin',
      projectId: 'p1',
      reasons: ['custom:secret-policy'],
      policyIds: ['secret-policy'],
    });
    expect(Object.keys(body).sort()).toEqual(['code', 'decisionId', 'error', 'message', 'required', 'service']);
    expect(JSON.stringify(body)).not.toContain('secret-policy');
  });

  it('for every service and level, `error` is the same sentence the legacy gate builds', () => {
    for (const { id } of RBAC_SERVICE_DEFINITIONS) {
      for (const level of SERVICE_PERMISSION_LEVELS) {
        const body = forbiddenBody(denial(id, level));
        expect(body.error).toBe(serviceDenialReason(id, level));
        expect(body.message).toBe(body.error);
        expect(body.error).toBe(`Forbidden: ${id} requires ${level} permission`);
      }
    }
  });
});

describe('undeclaredRouteBody (route_not_declared)', () => {
  it('error carries the reason itself (there is no legacy wording: legacy never refuses an undeclared route)', () => {
    expect(undeclaredRouteBody()).toEqual({
      error: 'Forbidden: this route has no authorization declaration',
      code: 'route_not_declared',
      message: 'Forbidden: this route has no authorization declaration',
    });
  });
});
