/**
 * Generated Cedar schema + action catalog + managed policies.
 * The schema must validate with ZERO errors, and the managed policies must
 * type-check against it (Cedar's validate answers "success" with a non-empty
 * validationErrors list, so zero is asserted explicitly).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { RBAC_SERVICE_DEFINITIONS } from '@/lib/security/rbac';
import {
  ACTION_LEVEL_GROUPS,
  buildActionCatalog,
  describeActions,
  gateActionId,
  methodToActionLevel,
  resourceEntityTypeName,
} from '@/lib/iam/actions';
import { validatePolicies, validateSchema, getCedarVersion, preparsePolicySet, splitPolicyText } from '@/lib/iam/cedar';
import { MANAGED_POLICIES } from '@/lib/iam/managedPolicies';
import { buildSchema } from '@/lib/iam/schema';
import { getIamSchema, resetSchemaStateForTests } from '@/lib/iam/schemaState';
import { validateCustomPolicyText } from '@/lib/iam/store';

beforeEach(() => resetSchemaStateForTests());

describe('Cedar runtime', () => {
  it('loads lazily and reports its versions', () => {
    const v = getCedarVersion();
    expect(v.sdk).toBe('4.13.0');
    expect(v.language).toMatch(/^4\./);
  });
});

describe('action catalog', () => {
  const types = [
    { type: 'agent', service: 'agents' as const },
    { type: 'rag-module', service: 'rag' as const },
    { type: 'mcp-server', service: 'mcp' as const },
    { type: 'tool', service: 'tools' as const },
    { type: 'model', service: 'models' as const },
  ];
  const catalog = buildActionCatalog(types);

  it('has Read/Write/Admin groups and read|write|admin actions for EVERY PermissionService', () => {
    for (const group of ACTION_LEVEL_GROUPS) {
      expect(catalog.find((a) => a.id === group && a.kind === 'group')).toBeTruthy();
    }
    for (const def of RBAC_SERVICE_DEFINITIONS) {
      for (const level of ['read', 'write', 'admin'] as const) {
        const action = catalog.find((a) => a.id === `${def.id}.${level}`);
        expect(action, `${def.id}.${level}`).toBeTruthy();
        expect(action!.kind).toBe('service');
        expect(action!.group).toBe(level[0].toUpperCase() + level.slice(1));
        expect(action!.resourceEntityTypes).toEqual(['Service']);
      }
    }
  });

  it('derives per-type verbs from the registry and adds the execution verbs', () => {
    const ids = new Set(catalog.map((a) => a.id));
    for (const t of types) {
      for (const verb of ['get', 'list', 'create', 'update', 'delete']) expect(ids.has(`${t.type}.${verb}`)).toBe(true);
    }
    for (const id of ['agent.invoke', 'tool.execute', 'mcp-server.call', 'rag-module.query', 'model.infer', 'portal.use']) {
      expect(ids.has(id), id).toBe(true); // portal comes from the always-present extras
    }
    expect(catalog.find((a) => a.id === 'agent.get')!.group).toBe('Read');
    expect(catalog.find((a) => a.id === 'agent.update')!.group).toBe('Write');
    expect(catalog.find((a) => a.id === 'portal.use')!.group).toBe('Read');
  });

  it('maps HTTP methods like getRequiredPermissionLevel (read/write split)', () => {
    expect(methodToActionLevel('GET')).toBe('read');
    expect(methodToActionLevel('head')).toBe('read');
    expect(methodToActionLevel('OPTIONS')).toBe('read');
    expect(methodToActionLevel('POST')).toBe('write');
    expect(methodToActionLevel('PURGE')).toBe('write');
    expect(gateActionId('agents', 'DELETE')).toBe('agents.write');
  });

  it('exposes UI metadata (label keys + level groups)', () => {
    const described = describeActions(catalog);
    expect(described.map((g) => g.group)).toEqual(['Read', 'Write', 'Admin']);
    for (const action of catalog) {
      expect(action.labelKey).toMatch(/^iam\.action\./);
    }
  });

  it('turns registry type ids into valid, non-colliding Cedar entity names', () => {
    expect(resourceEntityTypeName('rag-module')).toBe('RagModule');
    expect(resourceEntityTypeName('mcp-server')).toBe('McpServer');
    expect(resourceEntityTypeName('agent')).toBe('Agent');
    expect(resourceEntityTypeName('group')).toBe('GroupResource'); // would collide with the Group principal entity
  });
});

describe('generated schema', () => {
  it('parses and validates with 0 errors against the real registry', () => {
    const { schema, catalog } = getIamSchema();
    expect(validateSchema(schema)).toEqual({ ok: true });
    expect(catalog.length).toBeGreaterThan(41 * 3);
  });

  it('declares the documented entities and attributes', () => {
    const { schema } = buildSchema([{ type: 'agent', service: 'agents' }]);
    const ns = (schema as unknown as Record<string, { entityTypes: Record<string, any> }>)[''];
    expect(Object.keys(ns.entityTypes)).toEqual(
      expect.arrayContaining(['Tenant', 'Project', 'Group', 'User', 'ApiToken', 'Service', 'Agent', 'Portal']),
    );
    expect(Object.keys(ns.entityTypes.User.shape.attributes).sort()).toEqual(
      ['adminProjects', 'adminSvcs', 'projects', 'readSvcs', 'role', 'writeSvcs'],
    );
    expect(ns.entityTypes.User.memberOfTypes).toEqual(['Group']);
    expect(ns.entityTypes.Project.memberOfTypes).toEqual(['Tenant']);
    expect(ns.entityTypes.Group.memberOfTypes).toEqual(['Group']);
    const token = ns.entityTypes.ApiToken.shape.attributes;
    expect(Object.keys(token).sort()).toEqual(['capAdmin', 'capRead', 'capWrite', 'owner', 'project', 'scoped']);
    expect(token.project.required).toBe(false);
    expect(Object.keys(ns.entityTypes.Service.shape.attributes).sort()).toEqual(['adminService', 'service']);
    expect(ns.entityTypes.Agent.memberOfTypes).toEqual(['Project']);
    expect(Object.keys(ns.entityTypes.Agent.shape.attributes).sort()).toEqual(['adminService', 'key', 'service', 'tags']);
  });

  it('the six managed policies parse and type-check against it (0 validation errors)', () => {
    const { schema } = getIamSchema();
    expect(Object.keys(MANAGED_POLICIES)).toHaveLength(6);
    const result = validatePolicies(schema, { ...MANAGED_POLICIES });
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
    for (const [id, text] of Object.entries(MANAGED_POLICIES)) {
      expect(id.startsWith('managed:rbac:')).toBe(true);
      expect(text.startsWith('@managed("rbac")')).toBe(true);
    }
    expect(preparsePolicySet('test:managed', { ...MANAGED_POLICIES })).toEqual({ ok: true });
  });

  it('changes (new hash) when a resource type is added, and is stable otherwise', () => {
    const a = buildSchema([{ type: 'agent', service: 'agents' }]);
    const b = buildSchema([{ type: 'agent', service: 'agents' }]);
    const c = buildSchema([{ type: 'agent', service: 'agents' }, { type: 'sandbox-volume', service: 'sandbox' }]);
    expect(a.signature).toBe(b.signature);
    expect(c.signature).not.toBe(a.signature);
    expect(validateSchema(c.schema)).toEqual({ ok: true });
  });
});

describe('custom policy validation', () => {
  it('accepts a well-typed policy and reports its statements', () => {
    const v = validateCustomPolicyText(
      '@guardrail("strict") permit(principal is User, action == Action::"agent.invoke", resource is Agent) when { resource.service == "agents" };',
    );
    expect(v.errors).toEqual([]);
    expect(v.valid).toBe(true);
    expect(v.statements).toHaveLength(1);
  });

  it('accepts several statements and rejects any invalid one', () => {
    const ok = validateCustomPolicyText(
      'forbid(principal, action == Action::"agent.delete", resource is Agent);\nforbid(principal, action == Action::"tool.delete", resource is Tool);',
    );
    expect(ok.valid).toBe(true);
    expect(ok.statements).toHaveLength(2);
    expect(
      validateCustomPolicyText('forbid(principal, action == Action::"agent.delete", resource is Agent);\nforbid(principal, action == Action::"nope.nope", resource);').valid,
    ).toBe(false);
  });

  it('rejects unknown attributes, unknown entity types, wrong types and parse errors', () => {
    expect(validateCustomPolicyText('permit(principal is User, action, resource) when { principal.nonexistent == "x" };').valid).toBe(false);
    expect(validateCustomPolicyText('permit(principal is Spaceship, action, resource);').valid).toBe(false);
    expect(validateCustomPolicyText('permit(principal is User, action, resource) when { principal.role == 1 };').valid).toBe(false);
    expect(validateCustomPolicyText('permit(principal is User action resource)').valid).toBe(false);
  });

  it('rejects empty text, templates, the reserved @managed annotation and oversized text', () => {
    expect(validateCustomPolicyText('').valid).toBe(false);
    expect(validateCustomPolicyText('   ').valid).toBe(false);
    expect(validateCustomPolicyText(undefined).valid).toBe(false);
    expect(validateCustomPolicyText('permit(principal == ?principal, action, resource);').valid).toBe(false);
    const managed = validateCustomPolicyText('@managed("rbac") permit(principal is User, action, resource);');
    expect(managed.valid).toBe(false);
    expect(managed.errors[0].message).toMatch(/reserved/);
    expect(validateCustomPolicyText(`// ${'x'.repeat(70_000)}\npermit(principal, action, resource);`).valid).toBe(false);
  });

  it('flags `x in ["a","b"]` over strings (a runtime error in Cedar) — authors must use .contains()', () => {
    const bad = validateCustomPolicyText('permit(principal is User, action, resource) when { resource.service in ["a", "b"] };');
    expect(bad.valid).toBe(false);
    const good = validateCustomPolicyText('permit(principal is User, action, resource) when { ["a", "b"].contains(resource.service) };');
    expect(good.valid).toBe(true);
  });

  it('splitPolicyText splits statements', () => {
    const r = splitPolicyText('permit(principal, action, resource);\nforbid(principal, action, resource);');
    expect(r.ok && r.policies.length).toBe(2);
  });
});
