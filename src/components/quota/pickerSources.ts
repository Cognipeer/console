/**
 * Where the quota editor's pickers get their candidates (pure: no React).
 *
 * A tenant can have tens of thousands of users, so a picker never loads "all of
 * them": it asks the server to search, and shows the first few matches.
 *
 *  - user / group / token   `GET /api/iam/principals?type=&q=&limit=` (server-side
 *    search and paging). When that endpoint is not available to the caller the
 *    picker falls back to the plain list endpoint and filters in the browser —
 *    slower on a huge tenant, but it keeps working.
 *  - agent                  `GET /api/resources?type=agent&q=` (the resource
 *    registry), which also says which project each agent lives in.
 *  - resource / provider    `GET /api/resources/search?types=&attr=&q=&limit=`
 *    (the same registry, a few types at once, bounded to 50 rows server-side):
 *    a model, a vector index, a file bucket, a provider. WHICH types, which
 *    filter and which field is stored depends on the service the limit is for
 *    and is decided in `@/lib/quota/targets`; this file only builds the query
 *    and reads the answer.
 */
import type { QuotaTargetSource } from '@/lib/quota/targets';

export type PickerType = 'user' | 'group' | 'token' | 'agent';

export interface PickerOption {
  /** What is stored: the user / group / token id, or the agent key. */
  value: string;
  label: string;
  description?: string;
  /** The project the option lives in (agents), which the editor adopts for the policy. */
  projectId?: string;
}

export const PICKER_LIMIT = 20;

type Fetcher = (url: string) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const str = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() !== '' ? value : undefined;

function matches(query: string, ...fields: Array<string | undefined>): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return fields.some((field) => field?.toLowerCase().includes(q));
}

async function readJson(fetcher: Fetcher, url: string): Promise<unknown | null> {
  try {
    const response = await fetcher(url);
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

function fromPrincipals(body: unknown): PickerOption[] {
  return asArray(asRecord(body).items).flatMap((raw): PickerOption[] => {
    const item = asRecord(raw);
    const id = str(item.id);
    if (!id) return [];
    return [{ value: id, label: str(item.label) ?? id, description: str(item.sublabel) }];
  });
}

async function fallback(fetcher: Fetcher, type: 'user' | 'group' | 'token', query: string): Promise<PickerOption[]> {
  if (type === 'user') {
    const body = await readJson(fetcher, '/api/users');
    return asArray(asRecord(body).users)
      .map(asRecord)
      .filter((u) => matches(query, str(u.name), str(u.email)))
      .slice(0, PICKER_LIMIT)
      .map((u) => ({
        value: String(u._id),
        label: str(u.name) ?? str(u.email) ?? String(u._id),
        description: str(u.email),
      }));
  }
  if (type === 'group') {
    const body = await readJson(fetcher, '/api/groups');
    return asArray(asRecord(body).groups)
      .map(asRecord)
      .filter((g) => matches(query, str(g.name), str(g.description)))
      .slice(0, PICKER_LIMIT)
      .map((g) => ({ value: String(g._id), label: str(g.name) ?? String(g._id), description: str(g.description) }));
  }
  const body = await readJson(fetcher, '/api/tokens');
  return asArray(asRecord(body).tokens)
    .map(asRecord)
    .filter((t) => matches(query, str(t.label)))
    .slice(0, PICKER_LIMIT)
    .map((t) => ({ value: String(t._id), label: str(t.label) ?? String(t._id) }));
}

async function searchAgents(fetcher: Fetcher, query: string): Promise<PickerOption[]> {
  const params = new URLSearchParams({ type: 'agent', limit: String(PICKER_LIMIT) });
  if (query.trim()) params.set('q', query.trim());
  const body = asRecord(await readJson(fetcher, `/api/resources?${params.toString()}`));
  const projectNames = new Map(
    asArray(body.projects).map(asRecord).map((p) => [String(p.id), str(p.name) ?? String(p.id)] as const),
  );
  return asArray(body.items).flatMap((raw): PickerOption[] => {
    const item = asRecord(raw);
    const key = str(item.key);
    if (!key) return [];
    const projectId = str(item.projectId);
    const project = projectId ? projectNames.get(projectId) : undefined;
    return [{
      value: key,
      label: str(item.name) ?? key,
      description: [key, project].filter(Boolean).join(' · '),
      ...(projectId ? { projectId } : {}),
    }];
  });
}

/** Candidates matching `query` (server-side where possible), at most `PICKER_LIMIT`. */
export async function searchPickerOptions(
  type: PickerType,
  query: string,
  fetcher: Fetcher = (url) => fetch(url, { cache: 'no-store' }),
): Promise<PickerOption[]> {
  if (type === 'agent') return searchAgents(fetcher, query);

  const params = new URLSearchParams({ type, limit: String(PICKER_LIMIT) });
  if (query.trim()) params.set('q', query.trim());
  const body = await readJson(fetcher, `/api/iam/principals?${params.toString()}`);
  if (body !== null) return fromPrincipals(body);
  return fallback(fetcher, type, query);
}

/**
 * The name behind one stored id (a deep link or a saved limit that arrives with
 * an id only), or undefined when it cannot be resolved. Agents are looked up
 * through the search, which already names them.
 */
export async function resolvePickerOption(
  type: PickerType,
  id: string,
  fetcher: Fetcher = (url) => fetch(url, { cache: 'no-store' }),
): Promise<PickerOption | undefined> {
  if (!id) return undefined;
  if (type === 'agent') return (await searchAgents(fetcher, id)).find((option) => option.value === id);
  const body = asRecord(await readJson(fetcher, `/api/iam/principals/${type}/${encodeURIComponent(id)}`));
  const principal = asRecord(body.principal);
  const label = str(principal.label);
  return label ? { value: id, label, description: str(principal.sublabel) } : undefined;
}

// ── resource / provider targets (the registry's search) ──────────────────────

/** One row of the registry search, as the picker shows it and stores it. */
export interface TargetOption extends PickerOption {
  /**
   * Unique in a result list: the registry ROW (type + id). `value` is not,
   * because two rows can store the same value (an index key used in two projects).
   */
  id: string;
  /** Registry type of the row, e.g. 'model'. */
  type: string;
  /** The row's key, also when what is stored is its name (tracing). */
  key?: string;
}

export type FetchLike = (
  url: string,
  init?: { signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

const browserFetch: FetchLike = (url, init) => fetch(url, { cache: 'no-store', ...init });

/** The server clips a query here too (`SEARCH_MAX_QUERY_LENGTH`); sending more only costs bytes. */
const MAX_QUERY_LENGTH = 100;

/**
 * The query that asks the registry for `query` in `source`: one request, the
 * types searched together, a filter on the display attributes (a model's
 * category, a provider's type), best match first, at most `limit` rows.
 */
export function targetSearchUrl(source: QuotaTargetSource, query: string, limit = PICKER_LIMIT): string {
  const params = new URLSearchParams({ types: source.types.join(','), limit: String(limit) });
  const q = query.trim().slice(0, MAX_QUERY_LENGTH);
  if (q) params.set('q', q);
  for (const [name, values] of Object.entries(source.attributes ?? {})) params.append('attr', `${name}:${values.join(',')}`);
  return `/api/resources/search?${params.toString()}`;
}

/** Facts worth a second line, per registry type (the rest of the row is in the detail page). */
const SECONDARY_ATTRIBUTES: Record<string, readonly string[]> = {
  model: ['category'],
  'vector-index': ['providerKey'],
  'file-bucket': ['providerKey'],
  provider: ['driver', 'type'],
};

function attributeValue(item: Record<string, unknown>, name: string): string | undefined {
  for (const raw of asArray(item.attributes)) {
    const attribute = asRecord(raw);
    if (attribute.key !== name) continue;
    const value = attribute.value;
    if (typeof value === 'string' || typeof value === 'number') return str(String(value));
  }
  return undefined;
}

/** Where the row lives, in words that need no translation: project names, nothing for "no project". */
function projectFacts(item: Record<string, unknown>): { names: string[]; projectId?: string } {
  const display = asRecord(item.projectDisplay);
  if (display.kind === 'project') {
    const projectId = str(display.projectId) ?? str(item.projectId);
    const name = str(display.projectName) ?? str(item.projectName) ?? projectId;
    return { names: name ? [name] : [], ...(projectId ? { projectId } : {}) };
  }
  if (display.kind === 'multi-project') {
    return { names: asArray(display.projectNames).flatMap((n) => (str(n) ? [String(n)] : [])) };
  }
  return { names: [] };
}

function toTargetOption(source: QuotaTargetSource, raw: unknown): TargetOption | undefined {
  const item = asRecord(raw);
  const type = str(item.type);
  const rowId = str(item.id);
  const key = str(item.key);
  const name = str(item.name);
  // WHAT THE GUARD COMPARES: the key for models, indexes, buckets, providers and agent runs; the agent's NAME for tracing.
  const value = source.valueField === 'name' ? name : key;
  if (!type || !rowId || !value) return undefined;

  const label = name ?? value;
  const project = projectFacts(item);
  // A fact the source already pins (every row is an 'llm' model) tells nothing.
  const facts = (SECONDARY_ATTRIBUTES[type] ?? [])
    .filter((attribute) => (source.attributes?.[attribute]?.length ?? 0) !== 1)
    .map((attribute) => attributeValue(item, attribute));
  const description = [key && key !== label ? key : undefined, ...facts, ...project.names].filter(Boolean).join(' · ');

  return {
    id: `${type}:${rowId}`,
    type,
    value,
    label,
    ...(key ? { key } : {}),
    ...(description ? { description } : {}),
    ...(project.projectId ? { projectId: project.projectId } : {}),
  };
}

export type TargetSearchResult =
  | {
      status: 'ok';
      options: TargetOption[];
      total: number;
      /**
       * False when the registry says a searched type failed to load or was cut at
       * its per-type cap: the answer may then be missing rows, so it can show what
       * it found but can not prove that something does not exist.
       */
      complete: boolean;
    }
  /** The caller may not browse the registry (or it is not there): the picker falls back to typing the value. */
  | { status: 'unavailable' }
  | { status: 'failed' };

/** Candidates for `query` in `source`, at most `PICKER_LIMIT`, best match first. */
export async function searchTargetOptions(
  source: QuotaTargetSource,
  query: string,
  fetcher: FetchLike = browserFetch,
  signal?: AbortSignal,
): Promise<TargetSearchResult> {
  let response: Awaited<ReturnType<FetchLike>>;
  try {
    response = await fetcher(targetSearchUrl(source, query), { signal });
  } catch {
    return { status: 'failed' };
  }
  if (response.status === 401 || response.status === 403 || response.status === 404) return { status: 'unavailable' };
  if (!response.ok) return { status: 'failed' };
  let body: Record<string, unknown>;
  try {
    body = asRecord(await response.json());
  } catch {
    return { status: 'failed' };
  }
  const options = asArray(body.items).flatMap((raw): TargetOption[] => {
    const option = toTargetOption(source, raw);
    return option ? [option] : [];
  });
  return {
    status: 'ok',
    options,
    total: typeof body.total === 'number' ? body.total : options.length,
    complete: asArray(body.errors).length === 0 && asArray(body.truncated).length === 0,
  };
}

export type TargetResolution =
  | { status: 'found'; option: TargetOption }
  /** The registry answered and has no such row: a deleted model, a typo, a key from another service. */
  | { status: 'missing' }
  | { status: 'unavailable' }
  /** The registry could not say (it failed, or its answer is incomplete): not the same as "missing". */
  | { status: 'failed' };

/**
 * Whether a STORED value (a saved limit, a deep link) is still a row of the
 * registry, and which. The search puts an exact key (or name) first, so the
 * value is on the first page whatever else matches it. When two rows store the
 * same value (the same key in two projects), the one in `preferProjectId` wins.
 */
export async function resolveTargetOption(
  source: QuotaTargetSource,
  value: string,
  fetcher: FetchLike = browserFetch,
  signal?: AbortSignal,
  preferProjectId?: string,
): Promise<TargetResolution> {
  const result = await searchTargetOptions(source, value, fetcher, signal);
  if (result.status !== 'ok') return { status: result.status };
  const matches = result.options.filter((option) => option.value === value);
  const option = matches.find((o) => preferProjectId && o.projectId === preferProjectId) ?? matches[0];
  if (option) return { status: 'found', option };
  // Only a complete answer can say a value is not there.
  return result.complete ? { status: 'missing' } : { status: 'failed' };
}
