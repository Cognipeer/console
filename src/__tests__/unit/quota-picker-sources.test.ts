/**
 * Where the limit editor's resource / provider pickers get their candidates
 * (pure: no React): the query that is built for each kind of target, what is
 * kept from the registry's answer, which field is the stored value, and how a
 * saved value is told from one that no longer exists.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  PICKER_LIMIT,
  resolveTargetOption,
  searchPickerOptions,
  searchTargetOptions,
  targetSearchUrl,
  type FetchLike,
} from '@/components/quota/pickerSources';
import { quotaTargetSource } from '@/lib/quota/targets';
import type { QuotaDomain, QuotaScope } from '@/lib/quota/types';

const source = (domain: QuotaDomain, scope: QuotaScope = 'resource') => {
  const found = quotaTargetSource(domain, scope);
  if (!found) throw new Error('no source');
  return found;
};

const answer = (body: unknown, status = 200): FetchLike => async () => ({ ok: status >= 200 && status < 300, status, json: async () => body });

const project = (id: string, name: string) => ({ projectId: id, projectName: name, projectDisplay: { kind: 'project', projectId: id, projectName: name } });

const model = (over: Record<string, unknown> = {}) => ({
  type: 'model', id: 'm1', key: 'gpt-4o', name: 'GPT-4o', ...project('p1', 'Retail'), status: null,
  attributes: [{ key: 'category', value: 'llm' }, { key: 'providerKey', value: 'openai-prod' }], ...over,
});

describe('targetSearchUrl', () => {
  it('asks for one kind of model by its category', () => {
    expect(targetSearchUrl(source('llm'), '')).toBe(`/api/resources/search?types=model&limit=${PICKER_LIMIT}&attr=category%3Allm`);
    expect(targetSearchUrl(source('embedding'), '')).toBe(`/api/resources/search?types=model&limit=20&attr=category%3Aembedding`);
  });

  it('asks for several types at once and no filter for a global limit', () => {
    expect(targetSearchUrl(source('global'), '')).toBe('/api/resources/search?types=model%2Cvector-index%2Cfile-bucket&limit=20');
  });

  it('asks for the providers of the type the service reports', () => {
    expect(targetSearchUrl(source('vector', 'provider'), '')).toBe('/api/resources/search?types=provider&limit=20&attr=type%3Avector');
    expect(targetSearchUrl(source('file', 'provider'), '')).toBe('/api/resources/search?types=provider&limit=20&attr=type%3Afile');
    expect(targetSearchUrl(source('global', 'provider'), '')).toBe('/api/resources/search?types=provider&limit=20&attr=type%3Avector%2Cfile');
    // ...and every provider where none can match.
    expect(targetSearchUrl(source('llm', 'provider'), '')).toBe('/api/resources/search?types=provider&limit=20');
  });

  it('puts the typed text in q: trimmed, encoded, never empty and never longer than the server takes', () => {
    const url = (query: string) => new URL(targetSearchUrl(source('llm'), query), 'https://console.test');
    expect(url('  gpt 4o ').searchParams.get('q')).toBe('gpt 4o');
    expect(url('a&b=c#d').searchParams.get('q')).toBe('a&b=c#d');
    expect(url('   ').searchParams.has('q')).toBe(false);
    expect(url('').searchParams.has('q')).toBe(false);
    expect(url('x'.repeat(500)).searchParams.get('q')).toHaveLength(100);
  });

  it('asks for a page of at most the picker limit unless told a smaller one', () => {
    expect(new URL(targetSearchUrl(source('llm'), ''), 'https://console.test').searchParams.get('limit')).toBe('20');
    expect(new URL(targetSearchUrl(source('llm'), '', 5), 'https://console.test').searchParams.get('limit')).toBe('5');
  });
});

describe('searchTargetOptions', () => {
  it('stores the KEY of a model and shows its name, with the key and the project underneath', async () => {
    const fetcher = vi.fn(answer({ items: [model()], total: 1 }));
    const result = await searchTargetOptions(source('llm'), 'gpt', fetcher);
    expect(result).toEqual({
      status: 'ok',
      total: 1,
      complete: true,
      options: [{ id: 'model:m1', type: 'model', value: 'gpt-4o', label: 'GPT-4o', key: 'gpt-4o', description: 'gpt-4o · Retail', projectId: 'p1' }],
    });
    expect(fetcher).toHaveBeenCalledWith(targetSearchUrl(source('llm'), 'gpt'), { signal: undefined });
  });

  it('says the model category only when the service does not already pin it', async () => {
    const global = await searchTargetOptions(source('global'), '', answer({ items: [model()], total: 1 }));
    expect(global.status === 'ok' && global.options[0].description).toBe('gpt-4o · llm · Retail');
    const pinned = await searchTargetOptions(source('llm'), '', answer({ items: [model()], total: 1 }));
    expect(pinned.status === 'ok' && pinned.options[0].description).toBe('gpt-4o · Retail');
  });

  it('stores the KEY of a vector index or a bucket and says which provider holds it', async () => {
    const index = { type: 'vector-index', id: 'vi-1', key: 'docs', name: 'Docs', ...project('p1', 'Retail'), status: null, attributes: [{ key: 'providerKey', value: 'pg-main' }, { key: 'dimension', value: 1536 }] };
    const bucket = { type: 'file-bucket', id: 'fb-1', key: 'uploads', name: 'Uploads', ...project('p2', 'Wholesale'), status: 'active', attributes: [{ key: 'providerKey', value: 'disk' }] };
    const indexes = await searchTargetOptions(source('vector'), '', answer({ items: [index], total: 1 }));
    expect(indexes.status === 'ok' && indexes.options[0]).toMatchObject({ value: 'docs', label: 'Docs', description: 'docs · pg-main · Retail', projectId: 'p1' });
    const buckets = await searchTargetOptions(source('file'), '', answer({ items: [bucket], total: 1 }));
    expect(buckets.status === 'ok' && buckets.options[0]).toMatchObject({ value: 'uploads', label: 'Uploads', description: 'uploads · disk · Wholesale', projectId: 'p2' });
  });

  it('stores the KEY of a provider, shows its driver, and leaves the project open when it has several', async () => {
    const single = { type: 'provider', id: 'p-pg', key: 'pg-main', name: 'Postgres main', ...project('p1', 'Retail'), status: 'active', attributes: [{ key: 'type', value: 'vector' }, { key: 'driver', value: 'pgvector' }] };
    const several = {
      type: 'provider', id: 'p-disk', key: 'disk', name: 'Local disk', projectId: 'p1', projectName: 'Retail',
      projectDisplay: { kind: 'multi-project', projectIds: ['p1', 'p2'], projectNames: ['Retail', 'Wholesale'] },
      status: 'active', attributes: [{ key: 'type', value: 'file' }, { key: 'driver', value: 'local' }],
    };
    const result = await searchTargetOptions(source('global', 'provider'), '', answer({ items: [single, several], total: 2 }));
    expect(result.status === 'ok' && result.options).toEqual([
      // A global limit meets vector AND file providers, so the type is worth saying.
      { id: 'provider:p-pg', type: 'provider', value: 'pg-main', label: 'Postgres main', key: 'pg-main', description: 'pg-main · pgvector · vector · Retail', projectId: 'p1' },
      // A provider in several projects follows none of them: no project is adopted.
      { id: 'provider:p-disk', type: 'provider', value: 'disk', label: 'Local disk', key: 'disk', description: 'disk · local · file · Retail · Wholesale' },
    ]);
    // ...while the vector service pins the type, which then goes unsaid.
    const vector = await searchTargetOptions(source('vector', 'provider'), '', answer({ items: [single], total: 1 }));
    expect(vector.status === 'ok' && vector.options[0].description).toBe('pg-main · pgvector · Retail');
  });

  it('stores the agent NAME, not its key, for a tracing limit', async () => {
    const agent = { type: 'agent', id: 'a1', key: 'sales-ab12cd', name: 'Sales agent', ...project('p1', 'Retail'), status: 'active', attributes: [] };
    const tracing = await searchTargetOptions(source('tracing'), '', answer({ items: [agent], total: 1 }));
    expect(tracing.status === 'ok' && tracing.options[0]).toEqual({
      id: 'agent:a1', type: 'agent', value: 'Sales agent', label: 'Sales agent', key: 'sales-ab12cd', description: 'sales-ab12cd · Retail', projectId: 'p1',
    });
    // The agent-run service stores the key.
    const runs = await searchTargetOptions(source('agent'), '', answer({ items: [agent], total: 1 }));
    expect(runs.status === 'ok' && runs.options[0]).toMatchObject({ value: 'sales-ab12cd', label: 'Sales agent' });
  });

  it('keeps two rows that store the same key, telling them apart by their row', async () => {
    const docs = (id: string, projectId: string, name: string) => ({ type: 'vector-index', id, key: 'docs', name: 'Docs', ...project(projectId, name), status: null, attributes: [] });
    const result = await searchTargetOptions(source('vector'), 'docs', answer({ items: [docs('vi-1', 'p1', 'Retail'), docs('vi-2', 'p2', 'Wholesale')], total: 2 }));
    expect(result.status === 'ok' && result.options.map((o) => [o.id, o.value, o.projectId])).toEqual([
      ['vector-index:vi-1', 'docs', 'p1'],
      ['vector-index:vi-2', 'docs', 'p2'],
    ]);
  });

  it('skips what it can not use: no id, no type, no value to store', async () => {
    const result = await searchTargetOptions(
      source('llm'),
      '',
      answer({ items: [model({ id: undefined }), model({ type: undefined }), model({ key: null }), model({ key: '' }), 'junk', null, model({ id: 'ok' })], total: 7 }),
    );
    expect(result.status === 'ok' && result.options.map((o) => o.id)).toEqual(['model:ok']);
    // The server's count is kept, so the picker still says there are more than it shows.
    expect(result.status === 'ok' && result.total).toBe(7);
  });

  it('falls back to what it holds when the answer carries no count, and to nothing for a stray shape', async () => {
    const counted = await searchTargetOptions(source('llm'), '', answer({ items: [model()] }));
    expect(counted.status === 'ok' && counted.total).toBe(1);
    expect(await searchTargetOptions(source('llm'), '', answer({ nope: true }))).toEqual({ status: 'ok', options: [], total: 0, complete: true });
    expect(await searchTargetOptions(source('llm'), '', answer(null))).toEqual({ status: 'ok', options: [], total: 0, complete: true });
  });

  it.each([401, 403, 404])('is "unavailable" (not an error) when the registry answers %s', async (status) => {
    expect(await searchTargetOptions(source('llm'), '', answer({ error: 'no' }, status))).toEqual({ status: 'unavailable' });
  });

  it.each([400, 500, 502])('is "failed" when the registry answers %s', async (status) => {
    expect(await searchTargetOptions(source('llm'), '', answer({ error: 'no' }, status))).toEqual({ status: 'failed' });
  });

  it('is "failed" when the network is down, the body is not JSON, or the request is aborted', async () => {
    expect(await searchTargetOptions(source('llm'), '', async () => { throw new Error('offline'); })).toEqual({ status: 'failed' });
    expect(await searchTargetOptions(source('llm'), '', async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('x'); } }))).toEqual({ status: 'failed' });
    const controller = new AbortController();
    controller.abort();
    const aborted: FetchLike = async (_url, init) => {
      if (init?.signal?.aborted) throw new DOMException('aborted', 'AbortError');
      return { ok: true, status: 200, json: async () => ({ items: [] }) };
    };
    expect(await searchTargetOptions(source('llm'), '', aborted, controller.signal)).toEqual({ status: 'failed' });
  });
});

describe('resolveTargetOption', () => {
  it('finds the row a saved value stands for, asking the registry for exactly that value', async () => {
    const fetcher = vi.fn(answer({ items: [model({ id: 'm2', key: 'gpt-4o-mini', name: 'GPT-4o mini' }), model()], total: 2 }));
    const result = await resolveTargetOption(source('llm'), 'gpt-4o', fetcher);
    expect(result).toMatchObject({ status: 'found', option: { value: 'gpt-4o', label: 'GPT-4o', id: 'model:m1' } });
    expect(new URL(fetcher.mock.calls[0][0], 'https://console.test').searchParams.get('q')).toBe('gpt-4o');
  });

  it('is "missing" when the registry answers but nothing has exactly that value', async () => {
    // A near match is not the value: a limit on `gpt-4o` does not apply to `gpt-4o-mini`.
    const result = await resolveTargetOption(source('llm'), 'gpt-4o', answer({ items: [model({ id: 'm2', key: 'gpt-4o-mini', name: 'GPT-4o mini' })], total: 1 }));
    expect(result).toEqual({ status: 'missing' });
    expect(await resolveTargetOption(source('llm'), 'gone', answer({ items: [], total: 0 }))).toEqual({ status: 'missing' });
  });

  it('never calls a value missing on the strength of an answer that may lack rows', async () => {
    const empty = { items: [], total: 0 };
    // A type that failed to load, or that the registry cut at its per-type cap, may hold the value.
    expect(await resolveTargetOption(source('llm'), 'gone', answer({ ...empty, errors: [{ type: 'model', message: 'x' }] }))).toEqual({ status: 'failed' });
    expect(await resolveTargetOption(source('llm'), 'gone', answer({ ...empty, truncated: [{ type: 'model', limit: 5000 }] }))).toEqual({ status: 'failed' });
    // ...but a value that is there is still found, and an empty list of problems changes nothing.
    expect(await resolveTargetOption(source('llm'), 'gpt-4o', answer({ items: [model()], total: 1, errors: [{ type: 'model', message: 'x' }] }))).toMatchObject({ status: 'found' });
    expect(await resolveTargetOption(source('llm'), 'gone', answer({ ...empty, errors: [], truncated: [] }))).toEqual({ status: 'missing' });
    // The picker reports the same thing to whoever asks.
    const search = await searchTargetOptions(source('llm'), '', answer({ ...empty, errors: [{ type: 'model', message: 'x' }] }));
    expect(search.status === 'ok' && search.complete).toBe(false);
  });

  it('is case sensitive, like the guard\'s equality', async () => {
    expect(await resolveTargetOption(source('llm'), 'GPT-4O', answer({ items: [model()], total: 1 }))).toEqual({ status: 'missing' });
  });

  it('compares a tracing limit\'s value with the agent NAME', async () => {
    const agent = { type: 'agent', id: 'a1', key: 'sales-ab12cd', name: 'Sales agent', status: null, attributes: [] };
    const fetcher = answer({ items: [agent], total: 1 });
    expect(await resolveTargetOption(source('tracing'), 'Sales agent', fetcher)).toMatchObject({ status: 'found', option: { value: 'Sales agent' } });
    // The key is not what a trace reports.
    expect(await resolveTargetOption(source('tracing'), 'sales-ab12cd', fetcher)).toEqual({ status: 'missing' });
    expect(await resolveTargetOption(source('agent'), 'sales-ab12cd', fetcher)).toMatchObject({ status: 'found' });
  });

  it('picks the row in the limit\'s project when two rows store the same value', async () => {
    const docs = (id: string, projectId: string, name: string) => ({ type: 'vector-index', id, key: 'docs', name: 'Docs', ...project(projectId, name), status: null, attributes: [] });
    const fetcher = answer({ items: [docs('vi-1', 'p1', 'Retail'), docs('vi-2', 'p2', 'Wholesale')], total: 2 });
    expect(await resolveTargetOption(source('vector'), 'docs', fetcher, undefined, 'p2')).toMatchObject({ option: { id: 'vector-index:vi-2' } });
    expect(await resolveTargetOption(source('vector'), 'docs', fetcher, undefined, 'p1')).toMatchObject({ option: { id: 'vector-index:vi-1' } });
    // No project to prefer, or one that has no such row: the first.
    expect(await resolveTargetOption(source('vector'), 'docs', fetcher)).toMatchObject({ option: { id: 'vector-index:vi-1' } });
    expect(await resolveTargetOption(source('vector'), 'docs', fetcher, undefined, 'p9')).toMatchObject({ option: { id: 'vector-index:vi-1' } });
  });

  it('passes "unavailable" and "failed" on instead of calling a value missing it could not check', async () => {
    expect(await resolveTargetOption(source('llm'), 'gpt-4o', answer({}, 403))).toEqual({ status: 'unavailable' });
    expect(await resolveTargetOption(source('llm'), 'gpt-4o', answer({}, 500))).toEqual({ status: 'failed' });
  });
});

describe('searchPickerOptions (people, groups, tokens)', () => {
  /** A server where the directory search is closed to the caller (403) and only the plain lists answer. */
  function plainListsOnly(lists: Record<string, unknown>) {
    const asked: string[] = [];
    const fetcher = async (url: string) => {
      asked.push(url);
      const path = url.split('?')[0];
      if (path in lists) return { ok: true, status: 200, json: async () => lists[path] };
      return { ok: false, status: 403, json: async () => ({ error: 'Forbidden' }) };
    };
    return { fetcher, asked };
  }

  it('asks the directory search first, with the typed words and the picker\'s page size', async () => {
    const asked: string[] = [];
    const fetcher = async (url: string) => {
      asked.push(url);
      return { ok: true, status: 200, json: async () => ({ items: [{ id: 'u1', label: 'Ann Lee', sublabel: 'ann@acme.test' }] }) };
    };
    expect(await searchPickerOptions('user', ' ann ', fetcher)).toEqual([{ value: 'u1', label: 'Ann Lee', description: 'ann@acme.test' }]);
    expect(asked).toEqual([`/api/iam/principals?type=user&limit=${PICKER_LIMIT}&q=ann`]);
  });

  it('falls back to the plain lists and finds a Turkish name whatever its case', async () => {
    const { fetcher } = plainListsOnly({
      '/api/users': { users: [
        { _id: 'u1', name: 'İlker Işık', email: 'ilker@acme.test' },
        { _id: 'u2', name: 'ISPARTA Bölge', email: 'isparta@acme.test' },
        { _id: 'u3', name: 'Ann Lee', email: 'ann@acme.test' },
      ] },
      '/api/groups': { groups: [
        { _id: 'g1', name: 'Şube Müdürleri', description: 'İstanbul' },
        { _id: 'g2', name: 'Sales' },
      ] },
    });
    expect((await searchPickerOptions('user', 'ilker', fetcher)).map((o) => o.value)).toEqual(['u1']);
    expect((await searchPickerOptions('user', 'IŞIK', fetcher)).map((o) => o.value)).toEqual(['u1']);
    expect((await searchPickerOptions('user', 'ısparta', fetcher)).map((o) => o.value)).toEqual(['u2']);
    expect((await searchPickerOptions('user', 'ISPARTA', fetcher)).map((o) => o.value)).toEqual(['u2']);
    expect((await searchPickerOptions('user', 'ANN@ACME', fetcher)).map((o) => o.value)).toEqual(['u3']);
    expect((await searchPickerOptions('group', 'ŞUBE', fetcher)).map((o) => o.value)).toEqual(['g1']);
    expect((await searchPickerOptions('group', 'istanbul', fetcher)).map((o) => o.value)).toEqual(['g1']);
    expect((await searchPickerOptions('group', '', fetcher)).map((o) => o.value)).toEqual(['g1', 'g2']);
  });

  it('asks for every token of the project in the fallback, not only the caller\'s own', async () => {
    const { fetcher, asked } = plainListsOnly({
      '/api/tokens': { tokens: [{ _id: 't1', label: 'CI Pipeline' }, { _id: 't2', label: 'Nightly job' }] },
    });
    expect((await searchPickerOptions('token', 'ci', fetcher)).map((o) => o.value)).toEqual(['t1']);
    expect(asked.at(-1)).toBe('/api/tokens?scope=project');
  });
});
