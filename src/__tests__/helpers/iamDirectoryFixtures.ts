/**
 * Contract-shaped payloads of the people-and-access API, for the UI tests: a
 * small workspace (an owner, an admin, a person, a directory account, a service
 * account), its groups and tokens, and the routes that answer from them.
 */

import { jsonResponse, type RouteHandler } from './iamCenterUi';

export const ME = { userId: 'u-admin', role: 'admin' };

export const CAPS_ADMIN = {
  me: ME,
  policies: { manage: true },
  people: { manage: true, grantAdmin: true, assignableRoles: ['admin', 'project_admin', 'user'] },
  tokens: { manageOthers: true },
};

export const CAPS_READ_ONLY = {
  me: { userId: 'u-reader', role: 'user' },
  policies: { manage: false },
  people: { manage: false, grantAdmin: false, assignableRoles: [] },
  tokens: { manageOthers: false },
};

export const PEOPLE = [
  { type: 'user', id: 'u-owner', label: 'Olive Owner', sublabel: 'olive@example.com', email: 'olive@example.com', role: 'owner', status: 'active', kind: 'person', authProvider: 'local', managed: false, createdAt: '2026-01-02T10:00:00.000Z', policyCount: 0 },
  { type: 'user', id: 'u-admin', label: 'Ada Admin', sublabel: 'ada@example.com', email: 'ada@example.com', role: 'admin', status: 'active', kind: 'person', authProvider: 'local', managed: false, createdAt: '2026-02-03T10:00:00.000Z', policyCount: 1 },
  { type: 'user', id: 'u-ann', label: 'Ann Lee', sublabel: 'ann@example.com', email: 'ann@example.com', role: 'user', status: 'active', kind: 'person', authProvider: 'local', managed: false, createdAt: '2026-03-04T10:00:00.000Z', policyCount: 0 },
  { type: 'user', id: 'u-invited', label: 'Ivy Invited', sublabel: 'ivy@example.com', email: 'ivy@example.com', role: 'user', status: 'invited', kind: 'person', authProvider: 'local', managed: false, createdAt: '2026-03-05T10:00:00.000Z', invitedAt: '2026-03-05T10:00:00.000Z', policyCount: 0 },
  { type: 'user', id: 'u-sso', label: 'Sam Sso', sublabel: 'sam@example.com', email: 'sam@example.com', role: 'user', status: 'active', kind: 'person', authProvider: 'oidc', managed: true, createdAt: '2026-03-06T10:00:00.000Z', policyCount: 0 },
  { type: 'user', id: 'u-bot', label: 'ci-pipeline', sublabel: '', email: '', role: 'user', status: 'active', kind: 'service', authProvider: 'local', managed: false, createdAt: '2026-03-07T10:00:00.000Z', policyCount: 0 },
] as const;

export const GROUPS = [
  { type: 'group', id: 'g-eng', label: 'Engineering', sublabel: 'Builders', source: 'local', tenantRole: 'user', memberCount: 12, policyCount: 1 },
  { type: 'group', id: 'g-dir', label: 'Directory staff', sublabel: '', source: 'ldap', tenantRole: 'admin', memberCount: 40, policyCount: 0 },
] as const;

export const TOKENS = [
  { type: 'token', id: 't-ci', label: 'ci-token', sublabel: 'cp_8f2a…', prefix: 'cp_8f2a', status: 'active', ownerId: 'u-ann', ownerLabel: 'Ann Lee', ownerKind: 'person', ownerDisabled: false, projectId: 'p-a', projectName: 'Alpha', scoped: true, expiresAt: '2027-01-01T00:00:00.000Z', lastUsedAt: null, createdAt: '2026-04-01T00:00:00.000Z', policyCount: 0 },
  { type: 'token', id: 't-bot', label: 'bot-token', sublabel: 'cp_77aa…', prefix: 'cp_77aa', status: 'expired', ownerId: 'u-bot', ownerLabel: 'ci-pipeline', ownerKind: 'service', ownerDisabled: true, projectId: 'p-b', projectName: 'Beta', scoped: false, expiresAt: '2026-01-01T00:00:00.000Z', lastUsedAt: '2026-02-01T00:00:00.000Z', createdAt: '2026-01-01T00:00:00.000Z', policyCount: 0 },
] as const;

export const PROJECTS = {
  activeProjectId: 'p-a',
  projects: [
    { _id: 'p-a', name: 'Alpha' },
    { _id: 'p-b', name: 'Beta' },
  ],
};

const ALL = (allowed: string[]) => Object.fromEntries(allowed.map((a) => [a, { allowed: true }]));

/** A person's detail, as an admin sees it. */
export function personDetail(id: string, patch: Record<string, unknown> = {}) {
  const row = PEOPLE.find((p) => p.id === id) ?? PEOPLE[2];
  const owner = row.role === 'owner';
  const self = row.id === ME.userId;
  const managed = row.managed;
  const deny = (reason: string) => ({ allowed: false, reason });
  return {
    principal: {
      type: 'user',
      id: row.id,
      label: row.label,
      sublabel: row.email,
      role: row.role,
      status: row.status === 'invited' ? 'active' : row.status,
      email: row.email,
      authProvider: row.authProvider,
      canLogin: row.kind !== 'service',
      kind: row.kind,
      createdAt: row.createdAt,
      invitedAt: row.status === 'invited' ? row.createdAt : null,
      pendingInvite: row.status === 'invited',
      servicePermissions: owner ? {} : { models: 'read' },
      managed: { directory: managed, provider: managed ? row.authProvider : null, readOnly: managed ? ['name', 'email', 'password'] : [] },
    },
    effective: [{ service: 'models', level: 'read', sources: [{ kind: 'direct', label: 'Direct permission', level: 'read' }] }],
    groups: [{ id: 'g-eng', name: 'Engineering', source: 'local', tenantRole: 'user', removable: true }],
    projects: owner || row.role === 'admin' ? [{ id: 'p-a', name: 'Alpha', role: 'project_admin', via: 'implicit', removable: false }] : [{ id: 'p-a', name: 'Alpha', role: 'member', via: 'direct', removable: true }],
    policies: [],
    tokens: [{ id: 't-ci', label: 'ci-token', prefix: 'cp_8f2a', projectId: 'p-a', scoped: true, status: 'active', expiresAt: null, lastUsedAt: null, createdAt: '2026-04-01T00:00:00.000Z' }],
    tokensHidden: false,
    tokensTruncated: false,
    tokensTotal: 1,
    allowedActions: {
      ...ALL(['copyInvitationLink', 'manageGroups', 'manageProjects', 'mintToken', 'revokeTokens']),
      // an admin reaches nothing of the owner's but the owner's own page
      ...(owner
        ? {
            copyInvitationLink: deny('owner_immutable'),
            manageGroups: deny('owner_immutable'),
            manageProjects: deny('owner_immutable'),
            mintToken: deny('higher_privileges'),
            revokeTokens: deny('higher_privileges'),
          }
        : {}),
      editProfile: managed ? deny('directory_managed') : owner ? deny('owner_immutable') : { allowed: true },
      changeRole: owner ? deny('owner_immutable') : self ? deny('self') : { allowed: true },
      editPermissions: owner ? deny('owner_immutable') : { allowed: true },
      disable: owner ? deny('owner_immutable') : self ? deny('self') : { allowed: true },
      enable: { allowed: true },
      delete: owner ? deny('owner_immutable') : self ? deny('self') : managed ? deny('directory_managed') : { allowed: true },
    },
    assignableRoles: ['admin', 'project_admin', 'user'],
    ...patch,
  };
}

export function groupDetail(id: string, patch: Record<string, unknown> = {}) {
  const row = GROUPS.find((g) => g.id === id) ?? GROUPS[0];
  return {
    principal: {
      type: 'group',
      id: row.id,
      label: row.label,
      sublabel: row.sublabel,
      memberCount: row.memberCount,
      policyCount: row.policyCount,
      source: row.source,
      tenantRole: row.tenantRole,
      servicePermissions: { agents: 'read' },
    },
    effective: [],
    groups: [],
    projects: [{ id: 'p-a', name: 'Alpha', role: 'member', via: 'group', groupName: row.label }],
    policies: [],
    tokens: null,
    allowedActions: {
      edit: { allowed: true },
      delete: row.source === 'local' ? { allowed: true } : { allowed: false, reason: 'directory_managed' },
      manageMembers: row.source === 'local' ? { allowed: true } : { allowed: false, reason: 'directory_managed' },
      manageProjects: { allowed: true },
    },
    ...patch,
  };
}

export function tokenDetail(id: string, patch: Record<string, unknown> = {}) {
  const row = TOKENS.find((t) => t.id === id) ?? TOKENS[0];
  return {
    principal: { type: 'token', id: row.id, label: row.label, sublabel: row.sublabel, ownerId: row.ownerId, ownerLabel: row.ownerLabel, projectId: row.projectId, projectName: row.projectName, scope: row.scoped ? { models: 'read' } : null, expiresAt: row.expiresAt, lastUsedAt: row.lastUsedAt, status: row.status },
    effective: [],
    groups: [],
    projects: [],
    policies: [],
    tokens: null,
    tokenRow: { _id: row.id, label: row.label, tokenPrefix: row.prefix, userId: row.ownerId, createdAt: row.createdAt, expiresAt: row.expiresAt, canEdit: true, canDelete: true, allowedIpRanges: [] },
    allowedActions: { edit: { allowed: true }, revoke: { allowed: true } },
    ...patch,
  };
}

export interface ListLog {
  query: Record<string, string>;
}

const QUERY_FILTERS: Record<string, (row: Record<string, unknown>, value: string) => boolean> = {
  q: (row, v) => `${row.label} ${row.sublabel ?? ''}`.toLowerCase().includes(v.toLowerCase()),
  status: (row, v) => row.status === v,
  kind: (row, v) => row.kind === v,
  role: (row, v) => v.split(',').includes(String(row.role)),
  source: (row, v) => row.source === v || row.authProvider === v,
  ownerId: (row, v) => row.ownerId === v,
  projectId: (row, v) => row.projectId === v,
  scoped: (row, v) => String(row.scoped) === v,
};

/** What the server says the signed-in admin may do to each row (the same verdicts as the detail). */
export function rowActions(row: Record<string, unknown>): Record<string, unknown> {
  if (row.type === 'group') return groupDetail(String(row.id)).allowedActions;
  if (row.type === 'token') return tokenDetail(String(row.id)).allowedActions;
  return personDetail(String(row.id)).allowedActions;
}

/**
 * The list route: filters, a stable page boundary and the exact total on request. Rows carry their
 * `allowedActions` unless asked not to (an older server that does not send them).
 */
export function listHandler(options: { withActions?: boolean } = {}): RouteHandler {
  const withActions = options.withActions ?? true;
  return (call) => {
    const type = call.query.type ?? 'user';
    const base: ReadonlyArray<Record<string, unknown>> = type === 'group' ? GROUPS : type === 'token' ? TOKENS : PEOPLE;
    const rows = base
      .filter((row) =>
        Object.entries(call.query).every(([key, value]) => !QUERY_FILTERS[key] || QUERY_FILTERS[key]!(row, value)),
      )
      .map((row) => (withActions ? { ...row, allowedActions: rowActions(row) } : row));
    const limit = Number(call.query.limit ?? 25);
    const offset = call.query.cursor ? Number(call.query.cursor) : 0;
    const page = rows.slice(offset, offset + limit);
    const more = offset + limit < rows.length;
    return {
      items: page,
      nextCursor: more ? String(offset + limit) : null,
      ...(call.query.count === '1' ? { total: rows.length } : {}),
    };
  };
}

export function directoryRoutes(caps: unknown = CAPS_ADMIN): Array<[string, string | RegExp, RouteHandler]> {
  return [
    ['GET', '/api/iam/capabilities', () => caps],
    ['GET', '/api/iam/principals', listHandler()],
    [
      'GET',
      /^\/api\/iam\/principals\/(user|group|token)\/[^/]+$/,
      (c) => {
        const [, , , , type, rawId] = c.path.split('/');
        const id = decodeURIComponent(rawId ?? '');
        if (type === 'group') return groupDetail(id);
        if (type === 'token') return tokenDetail(id);
        return personDetail(id);
      },
    ],
    ['GET', '/api/projects', () => PROJECTS],
    ['GET', '/api/iam/catalog', () => jsonResponse({ error: 'not under test' }, 404)],
  ];
}
