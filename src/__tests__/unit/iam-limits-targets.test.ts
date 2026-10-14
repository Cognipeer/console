/**
 * What the Limits table points at, by NAME: the model, index, bucket or provider
 * a `resource` / `provider` limit stores by KEY is looked up in the resource
 * registry (a few lookups at a time, answers kept for a minute), shown as the
 * name with the key underneath, and called "not found" only when the registry
 * answered completely and has no such row. Also the table's Turkish-aware search.
 */
import { describe, expect, it } from 'vitest';
import {
  applyTargetPatches,
  filterLimitRows,
  parseLimitRow,
  registryLookupOf,
  targetNounOf,
  targetPatchOf,
  type LimitRow,
  type TargetPatchEntry,
} from '@/components/iam/limits/limitsModel';
import {
  createResolutionCache,
  RESOLVE_CONCURRENCY,
  RESOLVE_MAX_LOOKUPS,
  RESOLVE_TTL_MS,
  resolveLimitTargets,
} from '@/components/iam/limits/resolveTargets';
import type { FetchLike } from '@/components/quota/pickerSources';
import { quotaTargetSource } from '@/lib/quota/targets';

const row = (over: Record<string, unknown> = {}): LimitRow => {
  const parsed = parseLimitRow({
    _id: 'p1', scope: 'resource', scopeId: 'gpt-4o', domain: 'llm', priority: 10, enabled: true, limits: {}, projectId: 'proj-1',
    target: { type: 'resource', id: 'gpt-4o', label: 'gpt-4o' }, ...over,
  });
  if (!parsed) throw new Error('fixture did not parse');
  return parsed;
};

const model = (over: Record<string, unknown> = {}) => ({
  type: 'model', id: 'm1', key: 'gpt-4o', name: 'GPT-4o', projectId: 'proj-1', projectName: 'Retail',
  projectDisplay: { kind: 'project', projectId: 'proj-1', projectName: 'Retail' }, status: null,
  attributes: [{ key: 'category', value: 'llm' }], ...over,
});

/** A registry that answers each search from `rows` (an exact key or name comes first), and records the asks. */
function registry(rows: Array<Record<string, unknown>>, status = 200) {
  const asked: string[] = [];
  let inFlight = 0;
  let peak = 0;
  const fetcher: FetchLike = async (url) => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 1));
    inFlight -= 1;
    const q = new URL(url, 'https://console.test').searchParams.get('q') ?? '';
    asked.push(q);
    const items = rows.filter((r) => String(r.key) === q || String(r.name) === q || String(r.key).includes(q));
    return { ok: status < 400, status, json: async () => ({ items, total: items.length }) };
  };
  return { fetcher, asked, peak: () => peak };
}

describe('registryLookupOf', () => {
  it('asks the registry about a model, an index, a bucket and a provider that only have their key', () => {
    expect(registryLookupOf(row())).toMatchObject({ value: 'gpt-4o', projectId: 'proj-1', source: { noun: 'model' } });
    expect(registryLookupOf(row({ domain: 'vector', scopeId: 'docs', target: { type: 'resource', id: 'docs', label: 'docs' } }))?.source.noun).toBe('vectorIndex');
    expect(registryLookupOf(row({ domain: 'file', scopeId: 'uploads', target: { type: 'resource', id: 'uploads', label: 'uploads' } }))?.source.noun).toBe('fileBucket');
    expect(registryLookupOf(row({ scope: 'provider', domain: 'vector', scopeId: 'pg', target: { type: 'provider', id: 'pg', label: 'pg' } }))?.source.noun).toBe('provider');
  });

  it('asks about nothing the quota API already named, found gone, or does not name by key', () => {
    // people, groups, tokens and the tenant itself
    expect(registryLookupOf(row({ scope: 'user', scopeId: 'u1', target: { type: 'user', id: 'u1', label: 'Alice' } }))).toBeNull();
    expect(registryLookupOf(row({ scope: 'tenant', scopeId: undefined, target: { type: 'tenant' } }))).toBeNull();
    // an agent is named (or found gone) by the API
    expect(registryLookupOf(row({ domain: 'agent', scopeId: 'bot', target: { type: 'agent', id: 'bot', label: 'Credit bot', sublabel: 'bot' } }))).toBeNull();
    // the API answered with a name already
    expect(registryLookupOf(row({ target: { type: 'resource', id: 'gpt-4o', label: 'GPT-4o' } }))).toBeNull();
    // ...or called it gone
    expect(registryLookupOf(row({ target: { type: 'resource', id: 'gpt-4o', label: 'gpt-4o', missing: true } }))).toBeNull();
    // a limit with no target at all
    expect(registryLookupOf(row({ scopeId: undefined, target: { type: 'resource' } }))).toBeNull();
  });

  it('shares one lookup between rows that name the same thing in the same project, and no more', () => {
    const a = registryLookupOf(row({ _id: 'a' }));
    const b = registryLookupOf(row({ _id: 'b' }));
    expect(a?.key).toBe(b?.key);
    expect(registryLookupOf(row({ projectId: 'proj-2' }))?.key).not.toBe(a?.key);
    expect(registryLookupOf(row({ domain: 'embedding' }))?.key).not.toBe(a?.key);
    expect(registryLookupOf(row({ scopeId: 'gpt-4o-mini', target: { type: 'resource', id: 'gpt-4o-mini', label: 'gpt-4o-mini' } }))?.key).not.toBe(a?.key);
  });
});

describe('targetNounOf', () => {
  it('says what a resource or provider limit points at', () => {
    expect(targetNounOf({ scope: 'resource', domain: 'llm' })).toBe('model');
    expect(targetNounOf({ scope: 'resource', domain: 'vector' })).toBe('vectorIndex');
    expect(targetNounOf({ scope: 'resource', domain: 'file' })).toBe('fileBucket');
    expect(targetNounOf({ scope: 'resource', domain: 'agent' })).toBe('agent');
    expect(targetNounOf({ scope: 'resource', domain: 'tracing' })).toBe('agentName');
    expect(targetNounOf({ scope: 'resource', domain: 'global' })).toBe('resource');
    expect(targetNounOf({ scope: 'provider', domain: 'vector' })).toBe('provider');
    expect(targetNounOf({ scope: 'user', domain: 'llm' })).toBeNull();
  });
});

describe('targetPatchOf', () => {
  const llm = quotaTargetSource('llm', 'resource')!;
  const tracing = quotaTargetSource('tracing', 'resource')!;
  const option = { id: 'model:m1', type: 'model', value: 'gpt-4o', label: 'GPT-4o', key: 'gpt-4o' };

  it('names what was found and puts the key underneath', () => {
    expect(targetPatchOf(llm, { status: 'found', option })).toEqual({ label: 'GPT-4o', sublabel: 'gpt-4o' });
  });

  it('has no second line when the name IS the key', () => {
    expect(targetPatchOf(llm, { status: 'found', option: { ...option, label: 'gpt-4o' } })).toEqual({ label: 'gpt-4o' });
  });

  it('calls a target missing only when the registry answered and has no such row', () => {
    expect(targetPatchOf(llm, { status: 'missing' })).toEqual({ missing: true });
    expect(targetPatchOf(llm, { status: 'failed' })).toBeNull();
    expect(targetPatchOf(llm, { status: 'unavailable' })).toBeNull();
  });

  it('never calls an agent name missing: an SDK client may report a name nobody registered', () => {
    expect(targetPatchOf(tracing, { status: 'missing' })).toBeNull();
  });
});

describe('applyTargetPatches', () => {
  const entry = (lookupKey: string): TargetPatchEntry => ({ lookupKey, patch: { label: 'GPT-4o', sublabel: 'gpt-4o' } });

  it('lays the name over the target of the row it was found for', () => {
    const r = row();
    const patched = applyTargetPatches([r], new Map([['p1', entry(registryLookupOf(r)!.key)]]));
    expect(patched[0].target).toEqual({ type: 'resource', id: 'gpt-4o', label: 'GPT-4o', sublabel: 'gpt-4o' });
  });

  it('returns the rows themselves when there is nothing to apply', () => {
    const rows = [row()];
    expect(applyTargetPatches(rows, new Map())).toBe(rows);
  });

  it('does not lay a name over a row that has been pointed at something else since', () => {
    const before = row();
    const staleKey = registryLookupOf(before)!.key;
    const after = row({ scopeId: 'gpt-4o-mini', target: { type: 'resource', id: 'gpt-4o-mini', label: 'gpt-4o-mini' } });
    expect(applyTargetPatches([after], new Map([['p1', entry(staleKey)]]))[0].target.label).toBe('gpt-4o-mini');
  });
});

describe('resolveLimitTargets', () => {
  it('names the targets and flags the ones the registry does not have', async () => {
    const { fetcher } = registry([model()]);
    const rows = [row({ _id: 'a' }), row({ _id: 'b', scopeId: 'retired', target: { type: 'resource', id: 'retired', label: 'retired' } })];
    const patches = await resolveLimitTargets(rows, { fetcher });
    expect(patches.get('a')?.patch).toEqual({ label: 'GPT-4o', sublabel: 'gpt-4o' });
    expect(patches.get('b')?.patch).toEqual({ missing: true });
  });

  it('asks once for rows that name the same thing, and not at all for rows the API named', async () => {
    const { fetcher, asked } = registry([model()]);
    const rows = [
      row({ _id: 'a' }),
      row({ _id: 'b' }),
      row({ _id: 'c', scope: 'user', scopeId: 'u1', target: { type: 'user', id: 'u1', label: 'Alice' } }),
    ];
    const patches = await resolveLimitTargets(rows, { fetcher });
    expect(asked).toEqual(['gpt-4o']);
    expect([...patches.keys()].sort()).toEqual(['a', 'b']);
  });

  it('prefers the row in the limit\'s own project when two rows share a key', async () => {
    const docs = (id: string, projectId: string, name: string) => ({
      type: 'vector-index', id, key: 'docs', name, projectId, projectName: projectId, projectDisplay: { kind: 'project', projectId, projectName: projectId }, status: null, attributes: [],
    });
    const { fetcher } = registry([docs('vi-1', 'proj-1', 'Docs (retail)'), docs('vi-2', 'proj-2', 'Docs (wholesale)')]);
    const rows = [
      row({ _id: 'a', domain: 'vector', scopeId: 'docs', projectId: 'proj-1', target: { type: 'resource', id: 'docs', label: 'docs' } }),
      row({ _id: 'b', domain: 'vector', scopeId: 'docs', projectId: 'proj-2', target: { type: 'resource', id: 'docs', label: 'docs' } }),
    ];
    const patches = await resolveLimitTargets(rows, { fetcher });
    expect(patches.get('a')?.patch.label).toBe('Docs (retail)');
    expect(patches.get('b')?.patch.label).toBe('Docs (wholesale)');
  });

  it('keeps answers for a minute: a refresh or a toggle asks nothing again, a later one does', async () => {
    const { fetcher, asked } = registry([model()]);
    const cache = createResolutionCache();
    const clock = 1_000;
    const rows = [row()];
    await resolveLimitTargets(rows, { fetcher, cache, now: () => clock });
    await resolveLimitTargets(rows, { fetcher, cache, now: () => clock + RESOLVE_TTL_MS - 1 });
    expect(asked).toHaveLength(1);
    await resolveLimitTargets(rows, { fetcher, cache, now: () => clock + RESOLVE_TTL_MS + 1 });
    expect(asked).toHaveLength(2);
  });

  it('does not keep "could not ask": the next pass tries again', async () => {
    const failing = registry([model()], 500);
    const cache = createResolutionCache();
    expect((await resolveLimitTargets([row()], { fetcher: failing.fetcher, cache })).size).toBe(0);
    const healthy = registry([model()]);
    expect((await resolveLimitTargets([row()], { fetcher: healthy.fetcher, cache })).size).toBe(1);
    expect(healthy.asked).toHaveLength(1);
  });

  it('never has more than a few lookups in flight, and gives up on a registry the person may not browse', async () => {
    const rows = Array.from({ length: 12 }, (_, i) =>
      row({ _id: `r${i}`, scopeId: `model-${i}`, target: { type: 'resource', id: `model-${i}`, label: `model-${i}` } }),
    );
    const closed = registry([], 403);
    expect((await resolveLimitTargets(rows, { fetcher: closed.fetcher })).size).toBe(0);
    // The first refusals are the answer to the rest: only the lookups already running were made.
    expect(closed.asked.length).toBeLessThanOrEqual(RESOLVE_CONCURRENCY);

    const open = registry(rows.map((r, i) => model({ id: `m${i}`, key: `model-${i}`, name: `Model ${i}` })));
    const patches = await resolveLimitTargets(rows, { fetcher: open.fetcher });
    expect(patches.size).toBe(12);
    expect(open.peak()).toBeLessThanOrEqual(RESOLVE_CONCURRENCY);
    expect(open.peak()).toBeGreaterThan(1);
  });

  it('looks up a bounded number of distinct targets in one pass; the rest keep their keys', async () => {
    const count = RESOLVE_MAX_LOOKUPS + 10;
    const rows = Array.from({ length: count }, (_, i) =>
      row({ _id: `r${i}`, scopeId: `model-${i}`, target: { type: 'resource', id: `model-${i}`, label: `model-${i}` } }),
    );
    const { fetcher, asked } = registry([]);
    await resolveLimitTargets(rows, { fetcher });
    expect(asked).toHaveLength(RESOLVE_MAX_LOOKUPS);
  });

  it('stops asking once the pass is cancelled', async () => {
    const rows = Array.from({ length: 20 }, (_, i) =>
      row({ _id: `r${i}`, scopeId: `model-${i}`, target: { type: 'resource', id: `model-${i}`, label: `model-${i}` } }),
    );
    const { fetcher, asked } = registry([]);
    const controller = new AbortController();
    controller.abort();
    await resolveLimitTargets(rows, { fetcher, signal: controller.signal });
    expect(asked).toHaveLength(0);
  });

  it('names an agent a tracing limit stores by name, but never calls an unregistered name missing', async () => {
    const agent = { type: 'agent', id: 'a1', key: 'sales-ab12cd', name: 'Sales agent', projectId: 'proj-1', status: null, attributes: [] };
    const { fetcher } = registry([agent]);
    const rows = [
      row({ _id: 'known', domain: 'tracing', scopeId: 'Sales agent', target: { type: 'resource', id: 'Sales agent', label: 'Sales agent' } }),
      row({ _id: 'sdk', domain: 'tracing', scopeId: 'external-bot', target: { type: 'resource', id: 'external-bot', label: 'external-bot' } }),
    ];
    const patches = await resolveLimitTargets(rows, { fetcher });
    expect(patches.get('known')?.patch).toEqual({ label: 'Sales agent', sublabel: 'sales-ab12cd' });
    expect(patches.has('sdk')).toBe(false);
  });
});

describe('filterLimitRows (search)', () => {
  const rows = [
    row({ _id: 'istanbul', scope: 'group', scopeId: 'g1', label: 'Şube limitleri', description: 'İstanbul şubeleri', target: { type: 'group', id: 'g1', label: 'İstanbul Şubesi', sublabel: 'Marmara' } }),
    row({ _id: 'isparta', scope: 'group', scopeId: 'g2', label: 'Isparta cap', target: { type: 'group', id: 'g2', label: 'ISPARTA ŞUBESİ' } }),
    row({ _id: 'plain', scope: 'user', scopeId: 'u1', label: 'Alice cap', target: { type: 'user', id: 'u1', label: 'Alice', sublabel: 'alice@acme.test' } }),
  ];
  const ids = (query: string) => filterLimitRows(rows, { scope: 'all', domain: 'all', query }).map((r) => String(r._id));

  it('finds a Turkish name whatever the case of the typed words', () => {
    expect(ids('istanbul')).toEqual(['istanbul']);
    expect(ids('İSTANBUL')).toEqual(['istanbul']);
    expect(ids('şube')).toEqual(['istanbul', 'isparta']);
    expect(ids('ŞUBE')).toEqual(['istanbul', 'isparta']);
    // The dotless capital I of "Isparta" and the dotless small letter find each other.
    expect(ids('ısparta')).toEqual(['isparta']);
    expect(ids('ISPARTA')).toEqual(['isparta']);
    expect(ids('isparta')).toEqual(['isparta']);
  });

  it('still finds English text, e-mail addresses and ids', () => {
    expect(ids('ALICE')).toEqual(['plain']);
    expect(ids('acme.test')).toEqual(['plain']);
    expect(ids('g2')).toEqual(['isparta']);
  });

  it('shows everything for a blank query and nothing for a stranger', () => {
    expect(ids('')).toHaveLength(3);
    expect(ids('   ')).toHaveLength(3);
    expect(ids('zzz')).toEqual([]);
  });
});
