import { describe, expect, it } from 'vitest';
import {
  buildReadinessItems,
  hasDirectoryContent,
  parseOverview,
  readinessFixHref,
  readinessSummary,
} from '@/components/projects/detail/overviewModel';

const raw = {
  project: { _id: 'p1', key: 'core', name: 'Core' },
  stats: { members: 2, groups: 1, people: 5, providers: 2, providersByDomain: { model: 1, vector: 1 }, agents: 0, tokens: 3 },
  readiness: { hasModelProvider: true, missingDomains: ['rag'], hasProjectAdmin: false, hasLimits: false },
  admins: [{ userId: 'u1', name: 'Olga', email: 'o@x.io', kind: 'tenant_owner' }],
  directory: {
    rules: [{ source: 'oidc', mode: 'always', applyOn: 'first_sign_in', projects: [{ projectId: 'p1', role: 'member' }] }],
    groups: [{ groupId: 'g1', name: 'Eng', role: 'member', source: 'ldap' }],
  },
  activity: [],
};

describe('project overview model', () => {
  it('parses the overview payload', () => {
    const data = parseOverview(raw);
    expect(data?.project.id).toBe('p1');
    expect(data?.stats.people).toBe(5);
    expect(data?.rules).toHaveLength(1);
    expect(parseOverview({})).toBeNull();
  });

  it('builds readiness rows with one-click fixes', () => {
    const data = parseOverview(raw)!;
    const items = buildReadinessItems(data.readiness, data.stats);
    expect(items.map((i) => `${i.id}:${i.ok}`)).toEqual(['model:true', 'domain:vector:true', 'domain:rag:false', 'admin:false', 'limits:false']);
    expect(readinessSummary(items)).toEqual({ done: 2, total: 5 });
    expect(readinessFixHref('providers', 'p1')).toBe('/dashboard/projects/p1?tab=providers');
    expect(readinessFixHref('members', 'p1')).toBe('/dashboard/projects/p1?tab=members');
    expect(readinessFixHref('limits', 'p1')).toContain('p1');
  });

  it('shows the directory card only with content', () => {
    expect(hasDirectoryContent(parseOverview(raw)!)).toBe(true);
    expect(hasDirectoryContent({ rules: [], groups: [{ groupId: 'g', name: 'x', role: 'member', source: 'local' }] })).toBe(false);
  });
});
