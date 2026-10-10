/**
 * IAM center (policies + access check): the pure logic behind the UI. Nothing
 * here renders React; the components are thin shells over these functions.
 */

import { describe, expect, it } from 'vitest';
import type { IamCatalog, PolicyRow, PolicySpec } from '@/components/iam/api';
import { indexCatalog, matchesQuery, serviceCategory, sortActionIds } from '@/components/iam/catalogModel';
import {
  applyAction,
  applyPrincipalType,
  defaultChannel,
  emptyForm,
  formToRequest,
  requestToForm,
  validateForm,
  type CheckForm,
} from '@/components/iam/check/checkModel';
import { isValidIPv4, isValidIPv6, isValidIp, parseCidr } from '@/components/iam/ipRanges';
import {
  checkHref,
  iamHref,
  newPolicyHref,
  parseCheckParams,
  parsePolicyParams,
  parseTabId,
  policyHref,
} from '@/components/iam/links';
import {
  copyName,
  draftFromRow,
  draftSignature,
  draftToSpec,
  emptyDraft,
  specToDraft,
  summarizeSpec,
  validateDraft,
  withPrincipal,
  type PolicyDraft,
} from '@/components/iam/policies/specModel';
import { describeSpec, listWithMore } from '@/components/iam/policies/specSummary';
import { formatRelative } from '@/components/iam/timeFormat';
import { buildLabels, managedSlug } from '@/components/iam/useIamLabels';

// ── fixtures ─────────────────────────────────────────────────────────────

const catalog: IamCatalog = {
  services: [
    { id: 'agents', labelKey: 'iam.service.agents', adminService: false },
    { id: 'tools', labelKey: 'iam.service.tools', adminService: false },
    { id: 'config', labelKey: 'iam.service.config', adminService: true },
    { id: 'aegis', labelKey: 'iam.service.aegis', adminService: false },
  ],
  actions: [
    { id: 'Read', kind: 'group', level: 'read', labelKey: 'iam.action.group.read', labelParams: {} },
    { id: 'Write', kind: 'group', level: 'write', labelKey: 'iam.action.group.write', labelParams: {} },
    { id: 'Admin', kind: 'group', level: 'admin', labelKey: 'iam.action.group.admin', labelParams: {} },
    { id: 'agents.read', kind: 'service', level: 'read', service: 'agents', labelKey: 'k', labelParams: { service: 'agents' } },
    { id: 'agents.write', kind: 'service', level: 'write', service: 'agents', labelKey: 'k', labelParams: { service: 'agents' } },
    { id: 'agents.admin', kind: 'service', level: 'admin', service: 'agents', labelKey: 'k', labelParams: { service: 'agents' } },
    { id: 'config.read', kind: 'service', level: 'read', service: 'config', labelKey: 'k', labelParams: { service: 'config' } },
    { id: 'aegis.read', kind: 'service', level: 'read', service: 'aegis', labelKey: 'k', labelParams: { service: 'aegis' } },
    {
      id: 'agent.invoke',
      kind: 'resource',
      level: 'write',
      service: 'agents',
      resourceType: 'agent',
      verb: 'invoke',
      labelKey: 'iam.action.verb.invoke',
      labelParams: { type: 'agent' },
    },
    {
      id: 'agent.get',
      kind: 'resource',
      level: 'read',
      service: 'agents',
      resourceType: 'agent',
      verb: 'get',
      labelKey: 'iam.action.verb.get',
      labelParams: { type: 'agent' },
    },
  ],
  resourceTypes: [{ type: 'agent', service: 'agents', labelKey: 'resources.types.agent' }],
  contextAttrs: ['projectId', 'channel', 'ip', 'now'],
  channels: ['dashboard', 'api', 'portal'],
};

const fullSpec: PolicySpec = {
  effect: 'forbid',
  principals: { groups: ['g1', 'g2'], users: ['u1'], anyToken: true },
  actions: ['Write', 'agent.invoke'],
  resources: { services: ['agents', 'tools'] },
  conditions: { validFrom: '2026-01-01T00:00:00.000Z', ipRanges: ['10.0.0.0/8'], channels: ['api'] },
};

// ── ipRanges ─────────────────────────────────────────────────────────────

describe('ip validation', () => {
  it('accepts well-formed IPv4 and rejects the rest', () => {
    for (const ok of ['0.0.0.0', '10.1.2.3', '255.255.255.255', '192.168.0.1']) expect(isValidIPv4(ok)).toBe(true);
    for (const bad of ['', '1.2.3', '1.2.3.4.5', '256.1.1.1', '01.2.3.4', '1.2.3.-4', 'a.b.c.d', '1..2.3', ' 1.2.3.4']) {
      expect(isValidIPv4(bad)).toBe(false);
    }
  });

  it('accepts IPv6 forms (compression, embedded IPv4) and rejects malformed ones', () => {
    for (const ok of ['::', '::1', '1::', '2001:db8::1', '1:2:3:4:5:6:7:8', '1:2:3:4:5:6:7::', '::ffff:1.2.3.4', '1:2:3:4:5:6:1.2.3.4', 'fe80::1']) {
      expect(isValidIPv6(ok), ok).toBe(true);
    }
    for (const bad of ['', ':', ':::', '1::2::3', '12345::', '::g', 'fe80::1%eth0', '1:2:3:4:5:6:7:8:9', '1:2:3:4:5:6:7:8::', ':1:2:3:4:5:6:7', '1:2:3:4:5:6:7:', '1.2.3.4']) {
      expect(isValidIPv6(bad), bad).toBe(false);
    }
  });

  it('isValidIp trims', () => {
    expect(isValidIp(' 203.0.113.7 ')).toBe(true);
    expect(isValidIp('not an ip')).toBe(false);
  });
});

describe('parseCidr', () => {
  it('keeps CIDR and turns a bare address into a single-host range', () => {
    expect(parseCidr('10.0.0.0/8')).toEqual({ ok: true, normalized: '10.0.0.0/8', family: 4 });
    expect(parseCidr(' 192.168.1.5 ')).toEqual({ ok: true, normalized: '192.168.1.5/32', family: 4 });
    expect(parseCidr('2001:db8::/32')).toEqual({ ok: true, normalized: '2001:db8::/32', family: 6 });
    expect(parseCidr('::1')).toEqual({ ok: true, normalized: '::1/128', family: 6 });
  });

  it('rejects bad addresses and prefixes with a reason', () => {
    expect(parseCidr('')).toEqual({ ok: false, reason: 'empty' });
    expect(parseCidr('300.0.0.0/8')).toEqual({ ok: false, reason: 'address' });
    expect(parseCidr('10.0.0.0/33')).toEqual({ ok: false, reason: 'prefix' });
    expect(parseCidr('10.0.0.0/')).toEqual({ ok: false, reason: 'prefix' });
    expect(parseCidr('10.0.0.0/-1')).toEqual({ ok: false, reason: 'prefix' });
    expect(parseCidr('10.0.0.0/8/9')).toEqual({ ok: false, reason: 'prefix' });
    expect(parseCidr('2001:db8::/129')).toEqual({ ok: false, reason: 'prefix' });
    // Cedar's ip() takes no IPv4 embedded in IPv6
    expect(parseCidr('::ffff:10.0.0.1')).toEqual({ ok: false, reason: 'address' });
    expect(parseCidr('::ffff:10.0.0.1/104')).toEqual({ ok: false, reason: 'address' });
  });
});

// ── links ────────────────────────────────────────────────────────────────

describe('deep links', () => {
  it('builds and parses every link of the center', () => {
    expect(iamHref('policies')).toBe('/dashboard/iam?tab=policies');
    expect(iamHref('check', { a: 'x y', b: undefined, c: '' })).toBe('/dashboard/iam?tab=check&a=x+y');
    expect(checkHref({ decisionId: 'dec_1' })).toBe('/dashboard/iam?tab=check&decisionId=dec_1');
    expect(checkHref({ principalType: 'token', principalId: 't1', action: 'agents.read' })).toBe(
      '/dashboard/iam?tab=check&principalType=token&principalId=t1&action=agents.read',
    );
    expect(newPolicyHref({ principalType: 'group', principalId: 'g1' })).toBe(
      '/dashboard/iam?tab=policies&new=1&principalType=group&principalId=g1',
    );
    expect(newPolicyHref()).toBe('/dashboard/iam?tab=policies&new=1');
    expect(policyHref('p-abc')).toBe('/dashboard/iam?tab=policies&policyId=p-abc');
  });

  it('round-trips through the parsers', () => {
    const sp = new URLSearchParams('tab=check&principalType=token&principalId=t1&action=agents.read');
    expect(parseCheckParams(sp)).toEqual({
      decisionId: undefined,
      principalType: 'token',
      principalId: 't1',
      action: 'agents.read',
    });
    const np = new URLSearchParams('tab=policies&new=1&principalType=group&principalId=g1');
    expect(parsePolicyParams(np)).toEqual({ isNew: true, policyId: undefined, principalType: 'group', principalId: 'g1' });
    // a principal type without an id (or the reverse) is dropped rather than half-applied
    expect(parsePolicyParams(new URLSearchParams('new=1&principalType=user'))).toMatchObject({ isNew: true, principalType: undefined, principalId: undefined });
    expect(parsePolicyParams(new URLSearchParams('new=1&principalId=u1'))).toMatchObject({ principalType: undefined, principalId: undefined });
    // group is not a requestable principal for an access check
    expect(parseCheckParams(new URLSearchParams('principalType=group&principalId=g1')).principalType).toBeUndefined();
    expect(parsePolicyParams(new URLSearchParams('policyId=p1'))).toMatchObject({ isNew: false, policyId: 'p1' });
  });

  it('falls back to the overview for an unknown tab', () => {
    expect(parseTabId('policies')).toBe('policies');
    expect(parseTabId('nope')).toBe('overview');
    expect(parseTabId(null)).toBe('overview');
  });
});

// ── catalog model ────────────────────────────────────────────────────────

describe('catalog model', () => {
  const index = indexCatalog(catalog);

  it('groups actions and hides retired services from the offered list', () => {
    expect(index.groupActions.map((a) => a.id)).toEqual(['Read', 'Write', 'Admin']);
    expect(index.serviceActions.get('agents')?.write?.id).toBe('agents.write');
    expect(index.resourceActions.get('agents')?.map((a) => a.id)).toEqual(['agent.invoke', 'agent.get']);
    expect(index.services.map((s) => s.id)).not.toContain('aegis');
    // ...but a retired service still resolves (stored grants, old policies)
    expect(index.serviceById.get('aegis')?.id).toBe('aegis');
  });

  it('matches queries word by word, case-insensitively', () => {
    expect(matchesQuery('Agents · Invoke agent.invoke', 'invoke agents')).toBe(true);
    expect(matchesQuery('Agents · Read', 'WRITE')).toBe(false);
    expect(matchesQuery('anything', '   ')).toBe(true);
  });

  it('keeps selected actions in catalog order', () => {
    expect(sortActionIds(['agent.get', 'Read', 'zzz', 'agents.read'], catalog)).toEqual(['Read', 'agents.read', 'agent.get', 'zzz']);
  });
});

// ── labels ───────────────────────────────────────────────────────────────

describe('labels', () => {
  const own: Record<string, string> = {
    'levels.read': 'Read',
    'levels.write': 'Write',
    'verbs.invoke': 'Invoke',
    'actionGroups.write': 'All write actions',
    'effects.forbid': 'Deny',
    'resourceKinds.project': 'Project',
  };
  const rootMap: Record<string, string> = { 'resources.types.agent': 'Agents' };
  const t = (key: string) => own[key] ?? `iamCenter.${key}`;
  const root = (key: string) => rootMap[key] ?? key;
  const labels = buildLabels(t, root, catalog);

  it('composes action labels from service, level and verb', () => {
    expect(labels.action('Write')).toBe('All write actions');
    expect(labels.action('agents.read')).toBe('Agents · Read'); // service label from the built-in definitions
    expect(labels.action('agent.invoke')).toBe('Agents · Invoke');
    expect(labels.action('unknown.action')).toBe('unknown.action');
  });

  it('never prints a raw key', () => {
    expect(labels.level('admin')).toBe('Admin'); // no translation -> title case, not "iamCenter.levels.admin"
    expect(labels.channel('dashboard')).toBe('Dashboard');
    expect(labels.resourceType('rag-module')).toBe('Rag module');
    expect(labels.service('definitely-not-a-service')).toBe('Definitely not a service');
  });

  it('describes whatever resource shape the server sends', () => {
    expect(labels.resource('agent:abc')).toBe('agent:abc');
    expect(labels.resource({ kind: 'service', service: 'agents' })).toBe('Agents');
    expect(labels.resource({ kind: 'resource', type: 'agent', id: 'a1' })).toBe('Agents: a1');
    expect(labels.resource({ kind: 'project', projectId: 'p1' })).toBe('Project: p1');
    expect(labels.resource({ type: 'agent', id: 'a2' })).toBe('Agents: a2');
    expect(labels.resource(null)).toBe('—');
  });
});

describe('built-in policy texts', () => {
  const none = (k: string) => `iamCenter.${k}`;

  it('derives the key segment the server uses for a built-in policy', () => {
    expect(managedSlug('managed:rbac:user-read')).toBe('rbac-user-read');
    expect(managedSlug('managed:boundary:token-cap-write')).toBe('boundary-token-cap-write');
  });

  it('prefers the translated text and falls back to the server text', () => {
    const labels = buildLabels(none, (k) => ({ 'iamApi.managed.rbac-user-read.name': 'Üyeler okuyabilir' })[k] ?? k, catalog);
    expect(labels.managedName('managed:rbac:user-read', 'Members can view')).toBe('Üyeler okuyabilir');
    expect(labels.managedName('managed:boundary:x', 'Server text')).toBe('Server text');
    expect(labels.lookup('iamApi.not.there')).toBeUndefined();
    expect(labels.lookup(undefined)).toBeUndefined();
  });

  it('uses the English label the server sends before the built-in one', () => {
    const labels = buildLabels(none, (k) => k, {
      ...catalog,
      services: [{ id: 'tools', labelKey: 'iamApi.services.tools', adminService: false, label: 'Server Tools' }],
    });
    expect(labels.service('tools')).toBe('Server Tools');
  });

  it('groups a service by the category the server sends, else the built-in one', () => {
    expect(serviceCategory('agents', 'data')).toBe('data');
    expect(serviceCategory('agents')).toBe('build');
    expect(serviceCategory('agents', 'something-new')).toBe('build');
    expect(serviceCategory('not-a-service')).toBe('other');
  });

  it('hides a service the server marks as retired', () => {
    const index = indexCatalog({
      ...catalog,
      services: [...catalog.services, { id: 'legacy-x', labelKey: 'k', adminService: false, deprecated: true }],
    });
    expect(index.services.map((s) => s.id)).not.toContain('legacy-x');
  });
});

// ── spec model ───────────────────────────────────────────────────────────

describe('policy draft <-> spec', () => {
  it('starts empty and enabled: nothing chosen, and no mode to choose', () => {
    const d = emptyDraft();
    expect(d).not.toHaveProperty('mode');
    expect(d.enabled).toBe(true);
    expect(validateDraft(d).map((i) => i.code)).toEqual(['name', 'actions', 'who']);
  });

  it('round-trips a full spec', () => {
    const draft = specToDraft(fullSpec, { name: 'n', description: 'd', enabled: true }, { groups: new Map([['g1', 'Sales']]) });
    expect(draft.groups).toEqual([
      { id: 'g1', label: 'Sales' },
      { id: 'g2', label: 'g2' },
    ]);
    expect(draft.whereMode).toBe('services');
    expect(draftToSpec(draft)).toEqual(fullSpec);
  });

  it('writes {any:true} for everyone and for anywhere, and drops empty conditions', () => {
    const draft: PolicyDraft = { ...emptyDraft(), name: 'x', whoAny: true, actions: ['Read'] };
    expect(draftToSpec(draft)).toEqual({
      effect: 'permit',
      principals: { any: true },
      actions: ['Read'],
      resources: { any: true },
    });
  });

  it('only sends the active restriction kind and de-duplicates', () => {
    const base = { ...emptyDraft(), name: 'x', anyUser: true, actions: ['Read', 'Read'] };
    const spec = draftToSpec({
      ...base,
      whereMode: 'projects',
      services: ['agents'], // stale value from another mode: must not leak
      projects: ['p1', 'p1', 'p2'],
      users: [
        { id: 'u1', label: 'A' },
        { id: 'u1', label: 'A again' },
      ],
    });
    expect(spec.resources).toEqual({ projects: ['p1', 'p2'] });
    expect(spec.actions).toEqual(['Read']);
    expect(spec.principals).toEqual({ anyUser: true, users: ['u1'] });
  });

  it('keeps a stored spec that combines several restrictions', () => {
    const spec: PolicySpec = {
      effect: 'permit',
      principals: { any: true },
      actions: ['Read'],
      resources: { services: ['agents'], projects: ['p1'], resources: [{ type: 'agent', id: 'a1' }] },
    };
    const draft = specToDraft(spec, { name: 'n', description: '', enabled: true });
    expect(draft.whereMode).toBe('multiple');
    expect(draftToSpec(draft).resources).toEqual(spec.resources);
    expect(summarizeSpec(spec).whereMode).toBe('multiple');
  });

  it('turns a raw-Cedar row into a basics-only draft', () => {
    const row = { name: 'raw', description: 'd', enabled: false, spec: null } as unknown as PolicyRow;
    expect(draftFromRow(row)).toMatchObject({ name: 'raw', description: 'd', enabled: false, actions: [] });
  });

  it('prefills the principal from a deep link', () => {
    expect(withPrincipal(emptyDraft(), 'group', { id: 'g1', label: 'Sales' }).groups).toEqual([{ id: 'g1', label: 'Sales' }]);
    expect(withPrincipal(emptyDraft(), 'user', { id: 'u1', label: 'Ann' }).users).toEqual([{ id: 'u1', label: 'Ann' }]);
    expect(withPrincipal(emptyDraft(), 'token', { id: 't1', label: 'ci' }).tokens).toEqual([{ id: 't1', label: 'ci' }]);
  });

  it('names a copy without overflowing the name limit', () => {
    expect(copyName('Block writes', 'copy')).toBe('Block writes (copy)');
    expect(copyName('x'.repeat(200), 'copy').length).toBeLessThanOrEqual(120);
  });
});

describe('draft validation', () => {
  const ok: PolicyDraft = { ...emptyDraft(), name: 'n', anyUser: true, actions: ['Read'] };

  it('accepts a complete draft', () => {
    expect(validateDraft(ok)).toEqual([]);
  });

  it('requires a restriction when one kind is chosen', () => {
    expect(validateDraft({ ...ok, whereMode: 'services' }).map((i) => i.code)).toEqual(['services']);
    expect(validateDraft({ ...ok, whereMode: 'projects' }).map((i) => i.code)).toEqual(['projects']);
    expect(validateDraft({ ...ok, whereMode: 'resources' }).map((i) => i.code)).toEqual(['resources']);
    expect(validateDraft({ ...ok, whereMode: 'multiple' }).map((i) => i.code)).toEqual(['resources']);
  });

  it('checks the time window order and every IP range', () => {
    expect(
      validateDraft({ ...ok, validFrom: '2026-02-01T00:00:00Z', validUntil: '2026-01-01T00:00:00Z' }).map((i) => i.code),
    ).toEqual(['timeOrder']);
    expect(validateDraft({ ...ok, validFrom: '2026-01-01T00:00:00Z', validUntil: '2026-02-01T00:00:00Z' })).toEqual([]);
    expect(validateDraft({ ...ok, ipRanges: ['10.0.0.0/8', 'bogus'] })).toEqual([{ code: 'ip', value: 'bogus' }]);
  });

  it('treats everyone as a valid subject', () => {
    expect(validateDraft({ ...ok, anyUser: false, whoAny: true })).toEqual([]);
    expect(validateDraft({ ...ok, anyUser: false })).toEqual([{ code: 'who' }]);
  });

  it('has an order-insensitive signature that ignores display labels', () => {
    const a = { ...ok, users: [{ id: 'u1', label: 'Ann' }, { id: 'u2', label: 'Bob' }] };
    const b = { ...ok, users: [{ id: 'u2', label: 'resolved name' }, { id: 'u1', label: 'resolved name' }] };
    expect(draftSignature(a)).toBe(draftSignature(b));
    expect(draftSignature(a)).not.toBe(draftSignature({ ...a, effect: 'forbid' }));
  });
});

describe('spec summary', () => {
  const labels = buildLabels(
    (k) => ({ 'levels.write': 'Write', 'actionGroups.write': 'All write actions', 'verbs.invoke': 'Invoke', 'channels.api': 'API' }[k] ?? `iamCenter.${k}`),
    (k) => k,
    catalog,
  );
  // A translator that echoes the key and its values keeps the assertions about structure, not wording.
  const t = (key: string, values?: Record<string, string | number | undefined | null>) =>
    values ? `${key}(${Object.entries(values).map(([k, v]) => `${k}=${v}`).join(',')})` : key;

  it('uses group names when all are known and counts otherwise', () => {
    const named = describeSpec(fullSpec, { t, labels, groupNames: new Map([['g1', 'Sales'], ['g2', 'Support']]), formatDate: () => 'D' });
    expect(named.who).toBe('summary.anyToken · summary.groups(names=Sales, Support) · summary.usersCount(count=1)');
    const partial = describeSpec(fullSpec, { t, labels, groupNames: new Map([['g1', 'Sales']]), formatDate: () => 'D' });
    expect(partial.who).toContain('summary.groupsCount(count=2)');
    expect(named.what).toBe('All write actions, Agent · Invoke');
    expect(named.where).toBe('summary.whereServices(names=Agents, Agent Tools)'); // built-in service labels
    expect(named.when).toBe('summary.from(date=D) · summary.ip(ranges=10.0.0.0/8) · summary.channels(names=API)');
  });

  it('describes everyone / anywhere / no condition', () => {
    const lines = describeSpec(
      { effect: 'permit', principals: { any: true }, actions: ['Read'], resources: { any: true } },
      { t, labels },
    );
    expect(lines.who).toBe('summary.everyone');
    expect(lines.where).toBe('summary.whereAny');
    expect(lines.when).toBeNull();
  });

  it('shortens long lists', () => {
    expect(listWithMore(['a', 'b', 'c', 'd', 'e'], 3)).toBe('a, b, c +2');
    expect(listWithMore(['a', 'b'], 3)).toBe('a, b');
  });
});

// ── access check model ───────────────────────────────────────────────────

describe('access check form', () => {
  const index = indexCatalog(catalog);

  it('is incomplete until a principal, action and resource are chosen', () => {
    const form = emptyForm();
    expect(validateForm(form)).toEqual(['principal', 'action', 'service']);
    expect(formToRequest(form)).toBeNull();
  });

  it('builds the simulate request, with context only when set', () => {
    let form = emptyForm('user');
    form.principal = { id: 'u1', label: 'Ann' };
    form = applyAction(form, index.actionById.get('agents.write'));
    expect(form.resourceKind).toBe('service');
    expect(form.service).toBe('agents');
    expect(formToRequest(form)).toEqual({
      principal: { type: 'user', id: 'u1' },
      action: 'agents.write',
      resource: { kind: 'service', service: 'agents' },
      context: { channel: 'dashboard' },
    });
    form.ctxProjectId = 'p1';
    form.ip = '203.0.113.7';
    form.at = '2026-03-01T10:00:00.000Z';
    form.channel = null;
    expect(formToRequest(form)?.context).toEqual({ projectId: 'p1', ip: '203.0.113.7', at: '2026-03-01T10:00:00.000Z' });
  });

  it('checks a resource action on a resource of its type', () => {
    let form = emptyForm('token');
    form.principal = { id: 't1', label: 'ci' };
    form = applyAction(form, index.actionById.get('agent.invoke'));
    expect(form).toMatchObject({ resourceKind: 'resource', resourceType: 'agent', resource: null });
    expect(validateForm(form)).toEqual(['resource']);
    form.resource = { type: 'agent', id: 'a1', label: 'Support bot' };
    expect(formToRequest(form)?.resource).toEqual({ kind: 'resource', type: 'agent', id: 'a1' });
    expect(formToRequest(form)?.context).toEqual({ channel: 'api' });
  });

  it('always checks a service action on its own service', () => {
    let form = emptyForm();
    form.service = 'config';
    form = applyAction(form, index.actionById.get('agents.read'));
    expect(form).toMatchObject({ resourceKind: 'service', service: 'agents' });
  });

  it('turns the project target of a service action into project context', () => {
    let form = emptyForm();
    form.resourceKind = 'project';
    form.projectResource = 'proj-a';
    form = applyAction(form, index.actionById.get('agents.read'));
    expect(form).toMatchObject({ resourceKind: 'service', projectResource: null, ctxProjectId: 'proj-a' });
  });

  it('keeps a new-in-project target when the resource action changes', () => {
    let form = emptyForm();
    form.resourceKind = 'project';
    form.projectResource = 'proj-a';
    form = applyAction(form, index.actionById.get('agent.invoke'));
    expect(form).toMatchObject({ resourceKind: 'project', resourceType: 'agent', projectResource: 'proj-a' });
    expect(formToRequest({ ...form, principal: { id: 'u1', label: 'A' } })?.resource).toEqual({ kind: 'project', projectId: 'proj-a' });
  });

  it('keeps a still-fitting resource when the action changes', () => {
    let form = emptyForm();
    form.principal = { id: 'u1', label: 'Ann' };
    form = applyAction(form, index.actionById.get('agent.invoke'));
    form.resource = { type: 'agent', id: 'a1', label: 'A' };
    form = applyAction(form, index.actionById.get('agent.get'));
    expect(form.resource?.id).toBe('a1');
  });

  it('rejects an invalid IP before sending', () => {
    const form = emptyForm();
    form.principal = { id: 'u1', label: 'Ann' };
    form.action = 'agents.read';
    form.service = 'agents';
    form.ip = '999.1.1.1';
    expect(validateForm(form)).toEqual(['ip']);
    expect(formToRequest(form)).toBeNull();
  });

  it('switching the principal type resets the principal and the default channel only', () => {
    let form = emptyForm('user');
    form.principal = { id: 'u1', label: 'Ann' };
    form.action = 'agents.read';
    form = applyPrincipalType(form, 'token');
    expect(form.principal).toBeNull();
    expect(form.action).toBe('agents.read');
    expect(form.channel).toBe('api');
    // a channel the user chose on purpose survives
    let custom: CheckForm = { ...emptyForm('user'), channel: 'portal' };
    custom = applyPrincipalType(custom, 'token');
    expect(custom.channel).toBe('portal');
    expect(defaultChannel('user')).toBe('dashboard');
  });

  it('rebuilds the form from a decision input', () => {
    const form = requestToForm(
      {
        principal: { type: 'token', id: 't9' },
        action: 'agent.invoke',
        resource: { kind: 'resource', type: 'agent', id: 'a9' },
        context: { projectId: 'p1', channel: 'api', ip: '10.1.1.1', at: '2026-03-01T10:00:00.000Z' },
      },
      { principal: 'ci-token' },
    );
    expect(form).toMatchObject({
      principalType: 'token',
      principal: { id: 't9', label: 'ci-token' },
      action: 'agent.invoke',
      resourceKind: 'resource',
      resourceType: 'agent',
      resource: { id: 'a9' },
      ctxProjectId: 'p1',
      channel: 'api',
      ip: '10.1.1.1',
    });
    // and it converts back to the same request
    expect(formToRequest(form)).toEqual({
      principal: { type: 'token', id: 't9' },
      action: 'agent.invoke',
      resource: { kind: 'resource', type: 'agent', id: 'a9' },
      context: { projectId: 'p1', channel: 'api', ip: '10.1.1.1', at: '2026-03-01T10:00:00.000Z' },
    });
  });
});

// ── time ─────────────────────────────────────────────────────────────────

describe('relative time', () => {
  const now = Date.parse('2026-10-09T12:00:00Z');
  it('speaks in the largest sensible unit', () => {
    expect(formatRelative('2026-10-09T10:00:00Z', 'en', now)).toBe('2 hours ago');
    expect(formatRelative('2026-10-06T12:00:00Z', 'en', now)).toBe('3 days ago');
    expect(formatRelative('2026-10-09T12:30:00Z', 'en', now)).toBe('in 30 minutes');
    expect(formatRelative(null)).toBe('—');
    expect(formatRelative('garbage')).toBe('garbage');
  });
});
