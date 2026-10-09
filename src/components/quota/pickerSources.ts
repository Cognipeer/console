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
 */

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
