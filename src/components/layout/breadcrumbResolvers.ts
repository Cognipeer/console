/**
 * Breadcrumb label resolution registry.
 *
 * Standard for adding a new dynamic route to the breadcrumb:
 *
 *   - If the route is `/dashboard/<parent>/<id>(/...)` and there is a GET
 *     endpoint that returns the entity's display name, add a
 *     `createStandardResolver` entry. The dynamic segment's label will be
 *     resolved automatically.
 *
 *   - If the route has multiple dynamic segments or needs a list lookup,
 *     register a `BreadcrumbResolver` in CUSTOM_RESOLVERS with explicit
 *     matching and resolution logic.
 *
 *   - Static labels (the parent segments themselves) live in the
 *     `breadcrumbs.*` i18n bundle, not here.
 *
 *   - Each resolver is responsible for caching its own results via the
 *     shared `ctx.cache` map; the breadcrumb component shares this cache
 *     across renders so labels are fetched once per session.
 */

export type ResolveContext = {
  segments: string[];
  cache: Map<string, string>;
};

export type ResolvedLabel = { index: number; label: string };

export interface BreadcrumbResolver {
  /** Identifier for debugging / dedup. */
  id: string;
  /** Return label entries to set on resolved segment indices. */
  resolve(ctx: ResolveContext): Promise<ResolvedLabel[]>;
}

async function fetchJson<T = unknown>(url: string): Promise<T | undefined> {
  try {
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) return undefined;
    return (await res.json()) as T;
  } catch {
    return undefined;
  }
}

async function cached(
  ctx: ResolveContext,
  key: string,
  fn: () => Promise<string | undefined>,
): Promise<string | undefined> {
  const existing = ctx.cache.get(key);
  if (existing) return existing;
  const value = await fn();
  if (value) ctx.cache.set(key, value);
  return value;
}

/**
 * Build a resolver for routes shaped like:
 *
 *   /dashboard/<path...>/<dynamicSegment>(/...)
 *
 * `path` is everything after `dashboard` and before the dynamic segment.
 * E.g. `path: ['models']` matches `/dashboard/models/:id`, while
 * `path: ['tenant-settings', 'projects']` matches
 * `/dashboard/tenant-settings/projects/:projectId`.
 */
type ApiResponseBody = Record<string, unknown>;

type StandardConfig = {
  path: string[];
  buildUrl: (idOrKey: string) => string;
  pickLabel: (body: ApiResponseBody) => string | undefined;
  excludeValues?: string[];
};

/** Type-safe accessor for nested name/key/label fields on JSON responses. */
function pickString(value: unknown, ...keys: string[]): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  for (const key of keys) {
    const candidate = record[key];
    if (typeof candidate === 'string' && candidate.length > 0) return candidate;
  }
  return undefined;
}

/** Pull `body[wrapper].(name|key|label)` from a wrapped API response. */
function wrappedName(
  body: ApiResponseBody,
  wrapper: string,
  ...fields: string[]
): string | undefined {
  const inner = body[wrapper];
  return pickString(inner, ...(fields.length ? fields : ['name', 'key', 'label']));
}

function createStandardResolver(config: StandardConfig): BreadcrumbResolver {
  const { path, buildUrl, pickLabel, excludeValues } = config;
  const fullPath = ['dashboard', ...path];
  const id = `standard:${path.join('/')}`;

  return {
    id,
    async resolve(ctx) {
      const { segments } = ctx;
      if (segments.length < fullPath.length + 1) return [];
      for (let i = 0; i < fullPath.length; i++) {
        if (segments[i] !== fullPath[i]) return [];
      }

      const valueIdx = fullPath.length;
      const value = segments[valueIdx];
      if (!value) return [];
      if (excludeValues?.includes(value)) return [];

      const label = await cached(ctx, `${id}:${value}`, async () => {
        const body = await fetchJson<ApiResponseBody>(buildUrl(value));
        return body ? pickLabel(body) : undefined;
      });

      return label ? [{ index: valueIdx, label }] : [];
    },
  };
}

/* ----- Standard, single-entity resolvers ---------------------------------- */
const STANDARD_RESOLVERS: BreadcrumbResolver[] = [
  createStandardResolver({
    path: ['models'],
    buildUrl: (id) => `/api/models/${encodeURIComponent(id)}`,
    pickLabel: (b) => wrappedName(b, 'model'),
    excludeValues: ['new'],
  }),
  createStandardResolver({
    path: ['prompts'],
    buildUrl: (id) => `/api/prompts/${encodeURIComponent(id)}`,
    pickLabel: (b) => wrappedName(b, 'prompt'),
    excludeValues: ['new'],
  }),
  createStandardResolver({
    path: ['mcp'],
    buildUrl: (id) => `/api/mcp/${encodeURIComponent(id)}`,
    pickLabel: (b) => wrappedName(b, 'server'),
    excludeValues: ['new'],
  }),
  createStandardResolver({
    path: ['tools'],
    buildUrl: (id) => `/api/tools/${encodeURIComponent(id)}`,
    pickLabel: (b) => wrappedName(b, 'tool'),
    excludeValues: ['new'],
  }),
  createStandardResolver({
    path: ['guardrails'],
    buildUrl: (id) => `/api/guardrails/${encodeURIComponent(id)}`,
    pickLabel: (b) => wrappedName(b, 'guardrail'),
    excludeValues: ['new'],
  }),
  createStandardResolver({
    path: ['agents'],
    buildUrl: (id) => `/api/agents/${encodeURIComponent(id)}`,
    pickLabel: (b) => wrappedName(b, 'agent'),
    excludeValues: ['new'],
  }),
  createStandardResolver({
    path: ['browser'],
    buildUrl: (id) => `/api/browser/browsers/${encodeURIComponent(id)}`,
    pickLabel: (b) => wrappedName(b, 'browser'),
    excludeValues: ['new'],
  }),
  createStandardResolver({
    path: ['config'],
    buildUrl: (id) => `/api/config/groups/${encodeURIComponent(id)}`,
    pickLabel: (b) => wrappedName(b, 'group'),
    excludeValues: ['new'],
  }),
  createStandardResolver({
    path: ['inference-monitoring'],
    buildUrl: (key) => `/api/inference-monitoring/servers/${encodeURIComponent(key)}`,
    pickLabel: (b) => wrappedName(b, 'server'),
    excludeValues: ['new'],
  }),
  createStandardResolver({
    path: ['memory'],
    buildUrl: (key) => `/api/memory/stores/${encodeURIComponent(key)}`,
    // Memory stores endpoint returns the document directly, not under a wrapper.
    pickLabel: (b) => pickString(b, 'name', 'key'),
    excludeValues: ['new'],
  }),
  createStandardResolver({
    path: ['pii'],
    buildUrl: (id) => `/api/pii/policies/${encodeURIComponent(id)}`,
    pickLabel: (b) => wrappedName(b, 'policy'),
    excludeValues: ['new'],
  }),
  createStandardResolver({
    path: ['providers'],
    buildUrl: (id) => `/api/providers/${encodeURIComponent(id)}?scope=tenant`,
    pickLabel: (b) => wrappedName(b, 'provider', 'label', 'name', 'key'),
    excludeValues: ['new'],
  }),
  createStandardResolver({
    path: ['rag'],
    buildUrl: (key) => `/api/rag/modules/${encodeURIComponent(key)}`,
    pickLabel: (b) => wrappedName(b, 'module'),
    excludeValues: ['new'],
  }),
  createStandardResolver({
    path: ['reranker'],
    buildUrl: (key) => `/api/reranker/${encodeURIComponent(key)}`,
    pickLabel: (b) => wrappedName(b, 'reranker'),
    excludeValues: ['new'],
  }),
  createStandardResolver({
    path: ['files'],
    buildUrl: (key) => `/api/files/buckets/${encodeURIComponent(key)}`,
    pickLabel: (b) => wrappedName(b, 'bucket'),
  }),
  createStandardResolver({
    path: ['vector', 'migrations'],
    buildUrl: (key) => `/api/vector/migrations/${encodeURIComponent(key)}`,
    pickLabel: (b) => wrappedName(b, 'migration'),
    excludeValues: ['new'],
  }),
  createStandardResolver({
    path: ['tracing', 'agents'],
    buildUrl: (name) => `/api/tracing/agents/${encodeURIComponent(name)}/overview`,
    pickLabel: (b) => wrappedName(b, 'agent', 'label', 'name', 'key'),
  }),
];

/* ----- Custom resolvers --------------------------------------------------- */
/**
 * Projects: `/dashboard/projects/:id` and `/dashboard/tenant-settings/projects/:id`.
 *
 * There is no GET-by-id endpoint, so we look the project up in the
 * list response.
 */
const projectsResolver: BreadcrumbResolver = {
  id: 'custom:projects',
  async resolve(ctx) {
    const { segments } = ctx;
    const matches: Array<{ index: number; id: string }> = [];

    // Direct: /dashboard/projects/:id
    if (segments[0] === 'dashboard' && segments[1] === 'projects' && segments[2]) {
      matches.push({ index: 2, id: segments[2] });
    }
    // Nested: /dashboard/tenant-settings/projects/:id
    if (
      segments[0] === 'dashboard'
      && segments[1] === 'tenant-settings'
      && segments[2] === 'projects'
      && segments[3]
    ) {
      matches.push({ index: 3, id: segments[3] });
    }

    const filtered = matches.filter((m) => m.id !== 'new');
    if (filtered.length === 0) return [];

    const loaded = await cached(ctx, 'projects:list', async () => {
      const body = await fetchJson<{ projects?: Array<{ _id: string; name: string }> }>(
        '/api/projects',
      );
      if (!body?.projects) return undefined;
      // Stash the list as JSON; the cache holds strings only.
      ctx.cache.set('projects:listJson', JSON.stringify(body.projects));
      return 'loaded';
    });
    if (!loaded) return [];

    const listJson = ctx.cache.get('projects:listJson');
    const list = (listJson ? JSON.parse(listJson) : []) as Array<{ _id: string; name: string }>;

    const out: ResolvedLabel[] = [];
    for (const m of filtered) {
      const p = list.find((entry) => String(entry._id) === String(m.id));
      if (p?.name) out.push({ index: m.index, label: p.name });
    }
    return out;
  },
};

/**
 * Vector indexes: `/dashboard/vector/:providerKey/:externalId`.
 *
 * Resolves both segments — the provider's display label and the index name.
 * Skips the special `migrations` subpath, which has its own resolver.
 */
const vectorIndexResolver: BreadcrumbResolver = {
  id: 'custom:vector-index',
  async resolve(ctx) {
    const { segments } = ctx;
    if (segments[0] !== 'dashboard' || segments[1] !== 'vector') return [];
    const providerKey = segments[2];
    const externalId = segments[3];
    if (!providerKey || !externalId) return [];
    if (providerKey === 'migrations') return [];

    const url = `/api/vector/indexes/${encodeURIComponent(externalId)}?providerKey=${encodeURIComponent(providerKey)}`;
    const body = await cached(ctx, `vector:${providerKey}:${externalId}:json`, async () => {
      const data = await fetchJson<{
        index?: { name?: string };
        provider?: { label?: string };
      }>(url);
      if (!data) return undefined;
      if (data.provider?.label) ctx.cache.set(`vectorProvider:${providerKey}`, data.provider.label);
      if (data.index?.name) ctx.cache.set(`vectorIndexName:${providerKey}:${externalId}`, data.index.name);
      return 'loaded';
    });
    if (!body) return [];

    const out: ResolvedLabel[] = [];
    const providerLabel = ctx.cache.get(`vectorProvider:${providerKey}`);
    const indexName = ctx.cache.get(`vectorIndexName:${providerKey}:${externalId}`);
    if (providerLabel) out.push({ index: 2, label: providerLabel });
    if (indexName) out.push({ index: 3, label: indexName });
    return out;
  },
};

/**
 * Tracing sessions: `/dashboard/tracing/sessions/:id`.
 * Label is `<agentName> session` when the session is found.
 */
const tracingSessionResolver: BreadcrumbResolver = {
  id: 'custom:tracing-session',
  async resolve(ctx) {
    const { segments } = ctx;
    if (
      segments[0] !== 'dashboard'
      || segments[1] !== 'tracing'
      || segments[2] !== 'sessions'
    ) return [];
    const sessionId = segments[3];
    if (!sessionId) return [];

    const label = await cached(ctx, `tracingSession:${sessionId}`, async () => {
      const body = await fetchJson<{ session?: { agentName?: string } }>(
        `/api/tracing/sessions/${encodeURIComponent(sessionId)}`,
      );
      const agentName = body?.session?.agentName;
      return agentName ? `${agentName} session` : 'Session';
    });

    return label ? [{ index: 3, label }] : [];
  },
};

/**
 * Tracing threads: `/dashboard/tracing/threads/:id`.
 * Endpoint has no name field, so synthesize "<agent> thread" from the
 * first agent involved in the thread.
 */
const tracingThreadResolver: BreadcrumbResolver = {
  id: 'custom:tracing-thread',
  async resolve(ctx) {
    const { segments } = ctx;
    if (
      segments[0] !== 'dashboard'
      || segments[1] !== 'tracing'
      || segments[2] !== 'threads'
    ) return [];
    const threadId = segments[3];
    if (!threadId) return [];

    const label = await cached(ctx, `tracingThread:${threadId}`, async () => {
      const body = await fetchJson<{ agents?: string[] }>(
        `/api/tracing/threads/${encodeURIComponent(threadId)}`,
      );
      const first = body?.agents?.[0];
      return first ? `${first} thread` : undefined;
    });

    return label ? [{ index: 3, label }] : [];
  },
};

const CUSTOM_RESOLVERS: BreadcrumbResolver[] = [
  projectsResolver,
  vectorIndexResolver,
  tracingSessionResolver,
  tracingThreadResolver,
];

export const BREADCRUMB_RESOLVERS: BreadcrumbResolver[] = [
  ...STANDARD_RESOLVERS,
  ...CUSTOM_RESOLVERS,
];
