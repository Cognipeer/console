import { describe, expect, it } from 'vitest';
import {
  canCreateProject,
  createReadiness,
  filterProjectRows,
  groupProvidersByDomain,
  parseProjectFilters,
  parseProjectRows,
  projectFiltersToSearch,
  providerBreakdown,
  quickFilterCounts,
  roleEntries,
  sanitizeListUrl,
  toggleQuickFilter,
  type ProjectListRow,
} from '@/components/projects/projectsListModel';

const row = (over: Partial<ProjectListRow> & { name: string }): ProjectListRow => ({
  _id: over.name,
  key: over.name.toLowerCase(),
  canManage: false,
  directoryDefault: [],
  stats: { members: 1, groups: 0, people: 1, providers: 1, providersByDomain: { model: 1 }, agents: 0, tokens: 0 },
  ...over,
});

describe('parseProjectRows', () => {
  it('reads stats, domains and directory defaults and drops unusable rows', () => {
    const rows = parseProjectRows({
      projects: [
        {
          _id: 'p1',
          name: 'Alpha',
          key: 'alpha',
          canManage: true,
          stats: { members: 2, groups: 1, people: 5, providers: 3, providersByDomain: { model: 2, vector: 1, file: 0 }, agents: 4, tokens: 6 },
          directoryDefault: [{ source: 'oidc', role: 'project_admin', mode: 'always' }, { source: 'bogus' }],
        },
        { name: 'no id' },
        null,
      ],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].stats.people).toBe(5);
    expect(rows[0].stats.providersByDomain).toEqual({ model: 2, vector: 1 });
    expect(rows[0].directoryDefault).toEqual([{ source: 'oidc', role: 'project_admin', mode: 'always' }]);
    expect(rows[0].canManage).toBe(true);
  });

  it('treats a missing stats block as zeros', () => {
    const [r] = parseProjectRows({ projects: [{ _id: 'p', name: 'X' }] });
    expect(r.stats.providers).toBe(0);
    expect(r.canManage).toBe(false);
  });
});

describe('filters', () => {
  const rows = [
    row({ name: 'Alpha', canManage: true }),
    row({ name: 'İstanbul', stats: { members: 0, groups: 0, people: 0, providers: 0, providersByDomain: {}, agents: 0, tokens: 0 } }),
  ];

  it('narrows by quick filters', () => {
    expect(filterProjectRows(rows, { query: '', quick: new Set(['manage']) }).map((r) => r.name)).toEqual(['Alpha']);
    expect(filterProjectRows(rows, { query: '', quick: new Set(['noProvider']) }).map((r) => r.name)).toEqual(['İstanbul']);
    expect(filterProjectRows(rows, { query: '', quick: new Set(['noMembers', 'manage']) })).toEqual([]);
  });

  it('searches name and key with Turkish-aware folding', () => {
    expect(filterProjectRows(rows, { query: 'istanbul', quick: new Set() })).toHaveLength(1);
    expect(filterProjectRows(rows, { query: 'ALP', quick: new Set() })).toHaveLength(1);
  });

  it('counts what each chip would show', () => {
    expect(quickFilterCounts(rows)).toEqual({ manage: 1, noProvider: 1, noMembers: 1 });
  });

  it('round-trips through the address', () => {
    const f = toggleQuickFilter(toggleQuickFilter({ query: 'a b', quick: new Set() }, 'noMembers'), 'manage');
    const search = projectFiltersToSearch(f);
    expect(search).toBe('q=a+b&f=manage%2CnoMembers');
    const back = parseProjectFilters(new URLSearchParams(search));
    expect(back.query).toBe('a b');
    expect([...back.quick]).toEqual(['manage', 'noMembers']);
    expect(projectFiltersToSearch({ query: ' ', quick: new Set() })).toBe('');
    expect(parseProjectFilters(new URLSearchParams('f=nope,manage')).quick.size).toBe(1);
  });
});

describe('providerBreakdown', () => {
  it('orders by count then name', () => {
    expect(providerBreakdown(row({ name: 'a', stats: { members: 0, groups: 0, people: 0, providers: 4, providersByDomain: { vector: 1, model: 2, file: 1 }, agents: 0, tokens: 0 } }))).toEqual([
      ['model', 2],
      ['file', 1],
      ['vector', 1],
    ]);
  });
});

describe('sanitizeListUrl', () => {
  it('accepts only the list itself', () => {
    expect(sanitizeListUrl('/dashboard/projects?q=a')).toBe('/dashboard/projects?q=a');
    expect(sanitizeListUrl('https://evil.example')).toBe('/dashboard/projects');
    expect(sanitizeListUrl('/dashboard/projects-x')).toBe('/dashboard/projects');
    expect(sanitizeListUrl(null)).toBe('/dashboard/projects');
  });
});

describe('create readiness', () => {
  it('warns about a missing model provider and project admin but never blocks on them', () => {
    const items = createReadiness({ name: 'Alpha', providerDomains: ['vector'], roles: ['member'] });
    expect(items.filter((i) => !i.done).map((i) => i.id)).toEqual(['modelProvider', 'projectAdmin']);
    expect(canCreateProject(items)).toBe(true);
  });

  it('blocks only on the name', () => {
    expect(canCreateProject(createReadiness({ name: ' a ', providerDomains: ['model'], roles: ['project_admin'] }))).toBe(false);
    expect(canCreateProject(createReadiness({ name: 'ab', providerDomains: [], roles: [] }))).toBe(true);
  });

  it('builds the request entries and groups providers with models first', () => {
    expect(roleEntries(new Map([['u1', 'project_admin' as const]]), 'userId')).toEqual([{ userId: 'u1', role: 'project_admin' }]);
    const groups = groupProvidersByDomain([
      { type: 'vector', label: 'B' },
      { type: 'model', label: 'z' },
      { type: 'model', label: 'a' },
    ]);
    expect(groups.map((g) => g.domain)).toEqual(['model', 'vector']);
    expect(groups[0].items.map((p) => p.label)).toEqual(['a', 'z']);
  });
});
