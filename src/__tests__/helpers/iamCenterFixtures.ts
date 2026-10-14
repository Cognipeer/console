/** Contract-shaped payloads of the IAM center API, for the UI tests. */

import { jsonResponse, type RouteHandler } from './iamCenterUi';

export const CATALOG = {
  services: [
    { id: 'models', labelKey: 'iamApi.services.models', adminService: false, label: 'Model Hub', category: 'build' },
    { id: 'agents', labelKey: 'iamApi.services.agents', adminService: false, label: 'Agents', category: 'build' },
    { id: 'tools', labelKey: 'iamApi.services.tools', adminService: false, label: 'Agent Tools', category: 'build' },
    { id: 'config', labelKey: 'iamApi.services.config', adminService: true, label: 'Config Management', category: 'admin' },
    { id: 'iam', labelKey: 'iamApi.services.iam', adminService: true, label: 'Authorization Engine', category: 'admin' },
    { id: 'aegis', labelKey: 'iamApi.services.aegis', adminService: false, label: 'Aegis (legacy)', category: 'operate', deprecated: true },
  ],
  actions: [
    { id: 'Read', kind: 'group', level: 'read', labelKey: 'iamApi.action.group.read', labelParams: {} },
    { id: 'Write', kind: 'group', level: 'write', labelKey: 'iamApi.action.group.write', labelParams: {} },
    { id: 'Admin', kind: 'group', level: 'admin', labelKey: 'iamApi.action.group.admin', labelParams: {} },
    ...['models', 'agents', 'tools', 'config', 'iam', 'aegis'].flatMap((service) =>
      (['read', 'write', 'admin'] as const).map((level) => ({
        id: `${service}.${level}`,
        kind: 'service',
        level,
        service,
        labelKey: `iamApi.action.service.${level}`,
        labelParams: { service },
      })),
    ),
    { id: 'agent.get', kind: 'resource', level: 'read', service: 'agents', resourceType: 'agent', verb: 'get', labelKey: 'iamApi.action.verb.get', labelParams: { type: 'agent' } },
    { id: 'agent.invoke', kind: 'resource', level: 'write', service: 'agents', resourceType: 'agent', verb: 'invoke', labelKey: 'iamApi.action.verb.invoke', labelParams: { type: 'agent' } },
    { id: 'tool.execute', kind: 'resource', level: 'write', service: 'tools', resourceType: 'tool', verb: 'execute', labelKey: 'iamApi.action.verb.execute', labelParams: { type: 'tool' } },
  ],
  resourceTypes: [
    { type: 'agent', service: 'agents', labelKey: 'resources.types.agent' },
    { type: 'tool', service: 'tools', labelKey: 'resources.types.tool' },
  ],
  contextAttrs: ['projectId', 'channel', 'ip', 'now', 'method', 'path'],
  channels: ['dashboard', 'api', 'portal'],
};

export const MANAGED = [
  {
    id: 'managed:rbac:user-read',
    name: 'Members can view what their access allows',
    description: 'A member may view a service when their role gives them at least view access to it.',
    nameKey: 'iamApi.managed.rbac-user-read.name',
    descriptionKey: 'iamApi.managed.rbac-user-read.description',
    group: 'rbac',
    effect: 'permit',
    cedar: '@managed("rbac") permit(principal is User, action in Action::"Read", resource);',
  },
  {
    id: 'managed:rbac:token-write',
    name: 'API tokens change what their owner and their scope allow',
    description: 'An API token may change things in a service when its owner can and the scope allows it.',
    nameKey: 'iamApi.managed.rbac-token-write.name',
    descriptionKey: 'iamApi.managed.rbac-token-write.description',
    group: 'rbac',
    effect: 'permit',
    cedar: '@managed("rbac") permit(principal is ApiToken, action in Action::"Write", resource);',
  },
  {
    id: 'managed:boundary:token-cap-write',
    name: 'Token scope limit (change)',
    description: 'An API token with a scope can never change a service outside that scope.',
    nameKey: 'iamApi.managed.boundary-token-cap-write.name',
    descriptionKey: 'iamApi.managed.boundary-token-cap-write.description',
    group: 'boundary',
    effect: 'forbid',
    cedar: '@managed("boundary") forbid(principal is ApiToken, action in Action::"Write", resource);',
  },
  {
    id: 'managed:boundary:project-read',
    name: 'Project limit (view)',
    description: 'When the active project denies viewing a service, no custom policy can grant it.',
    nameKey: 'iamApi.managed.boundary-project-read.name',
    descriptionKey: 'iamApi.managed.boundary-project-read.description',
    group: 'boundary',
    effect: 'forbid',
    cedar: '@managed("boundary") forbid(principal, action in Action::"Read", resource);',
  },
];

export const SPEC_FORBID_GROUP = {
  effect: 'forbid',
  principals: { groups: ['g-contractors'] },
  actions: ['Write'],
  resources: { services: ['agents', 'tools'] },
  conditions: { channels: ['api'] },
};

/** An enabled deny rule. */
export const POLICY_CONTRACTORS = {
  policyId: 'p-contractors',
  name: 'Contractors cannot write',
  description: 'Contractors may look but not touch',
  effect: 'forbid',
  enabled: true,
  spec: SPEC_FORBID_GROUP,
  cedar: 'forbid (principal in Group::"g-contractors", action in Action::"Write", resource) when { resource.service in ["agents","tools"] };',
  statementCount: 1,
  createdAt: '2026-10-01T10:00:00.000Z',
  updatedAt: '2026-10-08T10:00:00.000Z',
  updatedBy: 'u-admin',
  updatedByLabel: 'Ada Admin',
};

/** An enabled allow rule. */
export const POLICY_ANALYSTS = {
  policyId: 'p-analysts',
  name: 'Analysts read cost',
  description: '',
  effect: 'permit',
  enabled: true,
  spec: {
    effect: 'permit',
    principals: { groups: ['g-analysts'], anyToken: true },
    actions: ['models.read'],
    resources: { any: true },
  },
  cedar: 'permit (principal in Group::"g-analysts", action == Action::"models.read", resource);',
  statementCount: 1,
  createdAt: '2026-10-02T10:00:00.000Z',
  updatedAt: '2026-10-07T10:00:00.000Z',
  updatedBy: 'u-admin',
};

/** A disabled rule written as raw Cedar. */
export const POLICY_RAW = {
  policyId: 'p-raw',
  name: 'Hand written',
  description: '',
  effect: 'mixed',
  enabled: false,
  spec: null,
  cedar: 'permit (principal, action, resource);\nforbid (principal, action, resource);',
  statementCount: 2,
  createdAt: '2026-10-03T10:00:00.000Z',
  updatedAt: '2026-10-03T10:00:00.000Z',
  updatedBy: 'u-admin',
};

export const GROUPS = {
  items: [
    { type: 'group', id: 'g-contractors', label: 'Contractors', sublabel: '40 members', memberCount: 40, policyCount: 1 },
    { type: 'group', id: 'g-analysts', label: 'Analysts', sublabel: '12 members', memberCount: 12, policyCount: 1 },
    { type: 'group', id: 'g-sales', label: 'Sales', sublabel: '300 members', memberCount: 300, policyCount: 0 },
  ],
  nextCursor: null,
};

export const USERS = {
  items: [
    { type: 'user', id: 'u-ann', label: 'Ann Lee', sublabel: 'ann@example.com', role: 'user', status: 'active', policyCount: 0 },
    { type: 'user', id: 'u-bob', label: 'Bob Ray', sublabel: 'bob@example.com', role: 'admin', status: 'active', policyCount: 1 },
  ],
  nextCursor: null,
};

export const TOKENS = {
  items: [{ type: 'token', id: 't-ci', label: 'ci-pipeline', sublabel: 'owner ann@example.com', policyCount: 0 }],
  nextCursor: null,
};

export const PROJECTS = {
  activeProjectId: 'proj-a',
  projects: [
    { _id: 'proj-a', name: 'Alpha' },
    { _id: 'proj-b', name: 'Beta' },
  ],
};

export function principalDetail(type: string, id: string) {
  const known: Record<string, string> = {
    'user:u-ann': 'Ann Lee',
    'user:u-bob': 'Bob Ray',
    'group:g-contractors': 'Contractors',
    'group:g-analysts': 'Analysts',
    'group:g-sales': 'Sales',
    'token:t-ci': 'ci-pipeline',
  };
  return {
    principal: { type, id, label: known[`${type}:${id}`] ?? id },
    effective: [],
    groups: [],
    projects: [],
    policies: [],
  };
}

/** Default routes: a workspace with three custom policies (a small stateful store). */
export function defaultRoutes(): Array<[string, string | RegExp, RouteHandler]> {
  let custom: Array<Record<string, unknown>> = [POLICY_CONTRACTORS, POLICY_ANALYSTS, POLICY_RAW];
  const idOf = (path: string) => decodeURIComponent(path.split('/').pop() ?? '');
  return [
    ['GET', '/api/iam/catalog', () => CATALOG],
    ['GET', '/api/iam/policies', () => ({ managed: MANAGED, custom })],
    ['GET', '/api/projects', () => PROJECTS],
    [
      'GET',
      '/api/iam/principals',
      (c) => {
        const base = c.query.type === 'group' ? GROUPS : c.query.type === 'token' ? TOKENS : USERS;
        const q = (c.query.q ?? '').toLowerCase();
        return q ? { ...base, items: base.items.filter((i) => i.label.toLowerCase().includes(q)) } : base;
      },
    ],
    ['GET', /^\/api\/iam\/principals\/(user|group|token)\/[^/]+$/, (c) => {
      const [, , , , type, id] = c.path.split('/');
      return principalDetail(type, decodeURIComponent(id));
    }],
    [
      'POST',
      '/api/iam/policies/compile',
      (c) => {
        const b = c.body as { spec?: { actions?: string[] }; cedar?: string };
        if (b.cedar !== undefined) {
          // comments are not statements
          return /permit|forbid/.test(b.cedar.replace(/\/\/.*$/gm, ''))
            ? { cedar: b.cedar, ok: true, errors: [], warnings: [] }
            : { cedar: b.cedar, ok: false, errors: [{ message: 'Policy text contains no permit/forbid statement', line: 1, col: 1 }], warnings: [] };
        }
        return { cedar: `permit (principal, action, resource) /* ${b.spec?.actions?.join(',')} */;`, ok: true, errors: [], warnings: [] };
      },
    ],
    [
      'POST',
      '/api/iam/policies/preview',
      () => ({
        evaluated: 840,
        truncated: false,
        principals: { evaluated: 120, targeted: 120 },
        flips: { allowToDeny: 4, denyToAllow: 0 },
        samples: [
          { principal: { type: 'user', id: 'u-ann', label: 'Ann Lee' }, action: 'agents.write', resource: { kind: 'service', service: 'agents' }, before: true, after: false },
        ],
      }),
    ],
    [
      'POST',
      '/api/iam/policies',
      (c) => {
        const row = { ...POLICY_CONTRACTORS, ...(c.body as object), policyId: 'p-new', cedar: 'permit (principal, action, resource);', statementCount: 1, effect: 'permit' };
        custom = [...custom, row];
        return jsonResponse(row, 201);
      },
    ],
    [
      'PUT',
      /^\/api\/iam\/policies\/[^/]+$/,
      (c) => {
        const row = { ...POLICY_CONTRACTORS, ...(c.body as object), policyId: idOf(c.path) };
        custom = custom.map((p) => (p.policyId === row.policyId ? row : p));
        return row;
      },
    ],
    [
      'DELETE',
      /^\/api\/iam\/policies\/[^/]+$/,
      (c) => {
        custom = custom.filter((p) => p.policyId !== idOf(c.path));
        return undefined;
      },
    ],
  ];
}
