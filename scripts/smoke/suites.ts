/**
 * Per-module smoke suites.
 *
 * Every dashboard module gets, at minimum, a read ("happy path" GET → 200) so
 * we prove the full stack works end to end: cookie-session auth hook → RBAC →
 * service layer → SQLite. Modules whose create path is fully self-contained
 * (no external provider/credentials, no network egress) additionally run a real
 * create → read → delete lifecycle. Modules whose create requires external
 * infrastructure are exercised at the read + validation-contract level.
 *
 * Each suite receives a `SmokeClient` whose cookie jar already holds the
 * registered session (see run.ts). `ctx` carries values produced by earlier
 * suites (e.g. the API token minted by the tokens suite) so later suites can
 * reuse them.
 */
import type { SmokeClient } from './client';

export interface SuiteContext {
  /** Unique suffix so repeated runs never collide on unique keys. */
  stamp: string;
  /** A raw API token value minted by the tokens suite, for client-API checks. */
  apiToken?: string;
  /** Key of a PII policy left in place for the policy-based client PII API. */
  piiPolicyKey?: string;
}

export interface Suite {
  module: string;
  run: (c: SmokeClient, ctx: SuiteContext) => Promise<void>;
}

const OK = [200];
const CREATED = [200, 201];
const VALIDATION = [400, 422];

/**
 * Pull an identifier out of a create response. `prefer` controls which field
 * wins, because some resources are routed by `_id` and others by `key`/
 * `externalId`. Handles both flat (`{_id}`) and wrapped (`{reranker:{key}}`)
 * shapes.
 */
function pick(
  body: unknown,
  fields: string[],
): string | undefined {
  if (!body || typeof body !== 'object') {
    return undefined;
  }
  const obj = body as Record<string, unknown>;
  for (const field of fields) {
    if (obj[field] != null) {
      return String(obj[field]);
    }
  }
  for (const value of Object.values(obj)) {
    if (value && typeof value === 'object') {
      const nested = value as Record<string, unknown>;
      for (const field of fields) {
        if (nested[field] != null) {
          return String(nested[field]);
        }
      }
    }
  }
  return undefined;
}

const idOf = (body: unknown) => pick(body, ['_id', 'id', 'key']);
const keyOf = (body: unknown) => pick(body, ['key', '_id', 'id']);

export const suites: Suite[] = [
  {
    module: 'dashboard',
    run: async (c) => {
      await c.step('overview', 'GET', '/api/dashboard', OK);
    },
  },

  {
    module: 'projects',
    run: async (c, ctx) => {
      await c.step('list projects', 'GET', '/api/projects', OK);
      const created = await c.step(
        'create project',
        'POST',
        '/api/projects',
        CREATED,
        { body: { name: `Smoke Project ${ctx.stamp}` } },
      );
      const id = idOf(created?.body);
      if (id) {
        await c.step('rename project', 'PATCH', `/api/projects/${id}`, OK, {
          body: { description: 'updated by smoke test' },
        });
      } else {
        c.skip('rename project', 'no project id returned');
      }
    },
  },

  {
    module: 'providers',
    run: async (c) => {
      await c.step('list providers', 'GET', '/api/providers', OK);
      await c.step('list drivers', 'GET', '/api/providers/drivers', OK);
    },
  },

  {
    module: 'models',
    run: async (c) => {
      await c.step('list models', 'GET', '/api/models', OK);
      await c.step('list model drivers', 'GET', '/api/models/providers/drivers', OK);
      await c.step('models dashboard', 'GET', '/api/models/dashboard', OK);
      await c.step('reject empty model', 'POST', '/api/models', VALIDATION, {
        body: {},
      });
    },
  },

  {
    module: 'vector',
    run: async (c, ctx) => {
      await c.step('vector dashboard', 'GET', '/api/vector/dashboard', OK);
      await c.step('list vector drivers', 'GET', '/api/vector/providers/drivers', OK);
      await c.step('list vector providers', 'GET', '/api/vector/providers', OK);
      // Listing indexes is provider-scoped; without ?providerKey it's a 400 by
      // contract. We assert that, then do a full lifecycle against a provider.
      await c.step('list indexes requires providerKey', 'GET', '/api/vector/indexes', VALIDATION);

      // Deep, fully-local lifecycle using the built-in SQLite vector store.
      const providerKey = `smk_vec_${ctx.stamp}`;
      const basePath = process.env.SMOKE_VECTOR_DIR ?? './data/vectors';
      const provider = await c.step(
        'create sqlite vector provider',
        'POST',
        '/api/vector/providers',
        CREATED,
        {
          body: {
            key: providerKey,
            driver: 'sqlite-vector',
            label: 'Smoke SQLite Vectors',
            credentials: {},
            settings: { basePath },
          },
        },
      );
      if (!provider) {
        c.skip('vector index lifecycle', 'provider create failed');
        return;
      }
      await c.step(
        'list indexes by provider',
        'GET',
        `/api/vector/indexes?providerKey=${providerKey}`,
        OK,
      );
      const index = await c.step(
        'create index',
        'POST',
        '/api/vector/indexes',
        CREATED,
        {
          body: {
            name: `smoke-index-${ctx.stamp}`,
            providerKey,
            dimension: 4,
            metric: 'cosine',
          },
        },
      );
      // The :externalId route param is resolved as the index `key` by the
      // upsert/query/delete handlers (they pass it through as `indexKey`).
      const indexKey = pick(index?.body, ['key', 'externalId', '_id', 'id']);
      if (indexKey) {
        const q = `?providerKey=${providerKey}`;
        await c.step(
          'upsert vectors',
          'POST',
          `/api/vector/indexes/${indexKey}/upsert${q}`,
          OK,
          {
            body: {
              vectors: [
                { id: 'a', values: [0.1, 0.2, 0.3, 0.4], metadata: { tag: 'x' } },
                { id: 'b', values: [0.2, 0.1, 0.4, 0.3], metadata: { tag: 'y' } },
              ],
            },
          },
        );
        await c.step(
          'query vectors',
          'POST',
          `/api/vector/indexes/${indexKey}/query${q}`,
          OK,
          { body: { query: { vector: [0.1, 0.2, 0.3, 0.4], topK: 2 } } },
        );
        await c.step(
          'delete index',
          'DELETE',
          `/api/vector/indexes/${indexKey}${q}`,
          OK,
        );
      } else {
        c.skip('vector index lifecycle', 'index create returned no key');
      }
    },
  },

  {
    module: 'memory',
    run: async (c) => {
      await c.step('list memory stores', 'GET', '/api/memory/stores', OK);
      await c.step('reject empty store', 'POST', '/api/memory/stores', VALIDATION, {
        body: {},
      });
    },
  },

  {
    module: 'rag',
    run: async (c) => {
      await c.step('list rag modules', 'GET', '/api/rag/modules', OK);
      await c.step('reject empty module', 'POST', '/api/rag/modules', VALIDATION, {
        body: {},
      });
    },
  },

  {
    module: 'prompts',
    run: async (c, ctx) => {
      await c.step('list prompts', 'GET', '/api/prompts', OK);
      await c.step('prompt stats', 'GET', '/api/prompts/stats', OK);
      const created = await c.step('create prompt', 'POST', '/api/prompts', CREATED, {
        body: {
          name: `Smoke Prompt ${ctx.stamp}`,
          template: 'Hello {{name}}, welcome to {{place}}.',
        },
      });
      const id = idOf(created?.body);
      if (id) {
        await c.step('get prompt', 'GET', `/api/prompts/${id}`, OK);
        await c.step('list versions', 'GET', `/api/prompts/${id}/versions`, OK);
        await c.step('delete prompt', 'DELETE', `/api/prompts/${id}`, OK);
      } else {
        c.skip('prompt lifecycle', 'no prompt id returned');
      }
    },
  },

  {
    module: 'guardrails',
    run: async (c, ctx) => {
      await c.step('list guardrails', 'GET', '/api/guardrails', OK);
      const created = await c.step(
        'create guardrail',
        'POST',
        '/api/guardrails',
        CREATED,
        {
          body: {
            name: `Smoke Guardrail ${ctx.stamp}`,
            type: 'custom',
            customPrompt: 'Flag any message that contains the word "forbidden".',
          },
        },
      );
      const id = idOf(created?.body);
      if (id) {
        await c.step('get guardrail', 'GET', `/api/guardrails/${id}`, OK);
        await c.step('delete guardrail', 'DELETE', `/api/guardrails/${id}`, OK);
      } else {
        c.skip('guardrail lifecycle', 'no guardrail id returned');
      }
    },
  },

  {
    module: 'pii',
    run: async (c, ctx) => {
      await c.step('pii categories', 'GET', '/api/pii/categories', OK);
      await c.step('list pii policies', 'GET', '/api/pii/policies', OK);
      await c.step('detect pii', 'POST', '/api/pii/detect', OK, {
        body: { text: 'Contact me at john.doe@example.com or +1-202-555-0147.' },
      });
      await c.step('redact pii', 'POST', '/api/pii/redact', OK, {
        body: { text: 'My email is jane@example.com.' },
      });
      const created = await c.step(
        'create pii policy',
        'POST',
        '/api/pii/policies',
        CREATED,
        {
          // Omit `categories` so the server applies its default catalog
          // (`buildDefaultPolicyCategories`), which covers email/phone/etc.
          body: { name: `Smoke PII Policy ${ctx.stamp}`, defaultAction: 'mask' },
        },
      );
      // Keep this policy alive — the policy-based client PII API needs its key.
      // Cleanup happens in the cleanup suite.
      ctx.piiPolicyKey = keyOf(created?.body);
      if (created) {
        await c.step('get pii policy', 'GET', `/api/pii/policies/${idOf(created.body)}`, OK);
      }
    },
  },

  {
    module: 'tracing',
    run: async (c) => {
      await c.step('tracing dashboard', 'GET', '/api/tracing/dashboard', OK);
      await c.step('list sessions', 'GET', '/api/tracing/sessions', OK);
      await c.step('list threads', 'GET', '/api/tracing/threads', OK);
    },
  },

  {
    module: 'evaluations',
    run: async (c, ctx) => {
      await c.step('list targets', 'GET', '/api/evaluation/targets', OK);
      await c.step('list datasets', 'GET', '/api/evaluation/datasets', OK);
      await c.step('list suites', 'GET', '/api/evaluation/suites', OK);
      await c.step('list runs', 'GET', '/api/evaluation/runs', OK);
      const dataset = await c.step(
        'create dataset',
        'POST',
        '/api/evaluation/datasets',
        CREATED,
        {
          body: {
            name: `Smoke Dataset ${ctx.stamp}`,
            items: [{ input: 'What is 2+2?', expected: '4' }],
          },
        },
      );
      const id = idOf(dataset?.body);
      if (id) {
        await c.step('get dataset', 'GET', `/api/evaluation/datasets/${id}`, OK);
        await c.step('delete dataset', 'DELETE', `/api/evaluation/datasets/${id}`, OK);
      } else {
        c.skip('dataset lifecycle', 'no dataset id returned');
      }
    },
  },

  {
    module: 'analysis',
    run: async (c, ctx) => {
      await c.step('list definitions', 'GET', '/api/analysis/definitions', OK);
      await c.step('list conversations', 'GET', '/api/analysis/conversations', OK);
      await c.step('list runs', 'GET', '/api/analysis/runs', OK);
      const def = await c.step(
        'create definition',
        'POST',
        '/api/analysis/definitions',
        CREATED,
        {
          body: {
            name: `Smoke Analysis ${ctx.stamp}`,
            fieldSet: [
              { key: 'sentiment', type: 'enum', enumValues: ['positive', 'negative'] },
              { key: 'summary', type: 'string' },
            ],
          },
        },
      );
      const id = idOf(def?.body);
      if (id) {
        await c.step('get definition', 'GET', `/api/analysis/definitions/${id}`, OK);
        await c.step('delete definition', 'DELETE', `/api/analysis/definitions/${id}`, OK);
      } else {
        c.skip('definition lifecycle', 'no definition id returned');
      }
    },
  },

  {
    module: 'redteam',
    run: async (c) => {
      await c.step('list probes', 'GET', '/api/redteam/probes', OK);
      await c.step('list campaigns', 'GET', '/api/redteam/campaigns', OK);
      await c.step('list runs', 'GET', '/api/redteam/runs', OK);
    },
  },

  {
    module: 'reranker',
    run: async (c, ctx) => {
      await c.step('list rerankers', 'GET', '/api/reranker', OK);
      const created = await c.step('create reranker', 'POST', '/api/reranker', CREATED, {
        body: {
          name: `Smoke Reranker ${ctx.stamp}`,
          strategy: 'heuristic',
          config: {},
        },
      });
      const key = keyOf(created?.body);
      if (key) {
        await c.step('get reranker', 'GET', `/api/reranker/${key}`, OK);
        await c.step('delete reranker', 'DELETE', `/api/reranker/${key}`, OK);
      } else {
        c.skip('reranker lifecycle', 'no reranker key returned');
      }
    },
  },

  {
    module: 'alerts',
    run: async (c, ctx) => {
      await c.step('list rules', 'GET', '/api/alerts/rules', OK);
      await c.step('list history', 'GET', '/api/alerts/history', OK);
      await c.step('list incidents', 'GET', '/api/alerts/incidents', OK);
      const created = await c.step('create rule', 'POST', '/api/alerts/rules', CREATED, {
        body: {
          name: `Smoke Alert ${ctx.stamp}`,
          module: 'models',
          metric: 'error_rate',
          condition: { operator: 'gt', threshold: 0.5 },
          windowMinutes: 15,
        },
      });
      const id = idOf(created?.body);
      if (id) {
        await c.step('toggle rule', 'PATCH', `/api/alerts/rules/${id}`, OK, {
          body: { enabled: false },
        });
        await c.step('delete rule', 'DELETE', `/api/alerts/rules/${id}`, OK);
      } else {
        c.skip('rule lifecycle', 'no rule id returned');
      }
    },
  },

  {
    module: 'audit',
    run: async (c) => {
      await c.step('list audit logs', 'GET', '/api/audit/logs', OK);
      await c.step('list audit services', 'GET', '/api/audit/services', OK);
    },
  },

  {
    module: 'automations',
    run: async (c) => {
      await c.step('list automations', 'GET', '/api/automations', OK);
    },
  },

  {
    module: 'cluster',
    run: async (c) => {
      await c.step('cluster overview', 'GET', '/api/cluster/overview', OK);
      await c.step('cluster instances', 'GET', '/api/cluster/instances', OK);
    },
  },

  {
    module: 'config',
    run: async (c, ctx) => {
      await c.step('list config groups', 'GET', '/api/config/groups', OK);
      await c.step('list config items', 'GET', '/api/config/items', OK);
      const group = await c.step('create group', 'POST', '/api/config/groups', CREATED, {
        body: { name: `Smoke Config ${ctx.stamp}` },
      });
      const id = idOf(group?.body);
      if (id) {
        await c.step('add config item', 'POST', `/api/config/groups/${id}/items`, CREATED, {
          body: { name: 'API_BASE', value: 'https://example.com' },
        });
        await c.step('delete group', 'DELETE', `/api/config/groups/${id}`, OK);
      } else {
        c.skip('config group lifecycle', 'no group id returned');
      }
    },
  },

  {
    module: 'crawler',
    run: async (c) => {
      await c.step('list crawlers', 'GET', '/api/crawler/crawlers', OK);
      await c.step('list crawler jobs', 'GET', '/api/crawler/jobs', OK);
    },
  },

  {
    module: 'browser',
    run: async (c) => {
      await c.step('list browsers', 'GET', '/api/browser/browsers', OK);
      await c.step('list browser sessions', 'GET', '/api/browser/sessions', OK);
    },
  },

  {
    module: 'files',
    run: async (c) => {
      await c.step('files dashboard', 'GET', '/api/files/dashboard', OK);
      await c.step('list file drivers', 'GET', '/api/files/providers/drivers', OK);
      await c.step('list file providers', 'GET', '/api/files/providers', OK);
      await c.step('list buckets', 'GET', '/api/files/buckets', OK);
    },
  },

  {
    module: 'inference-monitoring',
    run: async (c) => {
      await c.step('list servers', 'GET', '/api/inference-monitoring/servers', OK);
      await c.step('monitoring dashboard', 'GET', '/api/inference-monitoring/dashboard', OK);
    },
  },

  {
    module: 'license',
    run: async (c) => {
      await c.step('get license', 'GET', '/api/license', OK);
    },
  },

  {
    module: 'mcp',
    run: async (c) => {
      await c.step('list mcp servers', 'GET', '/api/mcp', OK);
    },
  },

  {
    module: 'ocr-jobs',
    run: async (c) => {
      await c.step('list ocr jobs', 'GET', '/api/ocr-jobs', OK);
    },
  },

  {
    module: 'quota',
    run: async (c) => {
      await c.step('quota defaults', 'GET', '/api/quota/defaults', OK);
      await c.step('list quota policies', 'GET', '/api/quota/policies', OK);
    },
  },

  {
    module: 'sandbox',
    run: async (c) => {
      await c.step('list runners', 'GET', '/api/sandbox/runners', OK);
      await c.step('list templates', 'GET', '/api/sandbox/templates', OK);
      await c.step('list volumes', 'GET', '/api/sandbox/volumes', OK);
      await c.step('list instances', 'GET', '/api/sandbox/instances', OK);
    },
  },

  {
    module: 'tools',
    run: async (c) => {
      await c.step('list tools', 'GET', '/api/tools', OK);
    },
  },

  {
    module: 'users',
    run: async (c, ctx) => {
      await c.step('list users', 'GET', '/api/users', OK);
      await c.step('rbac services', 'GET', '/api/users/permissions/services', OK);
      const invited = await c.step('invite user', 'POST', '/api/users/invite', CREATED, {
        body: {
          name: 'Smoke Invitee',
          email: `invitee-${ctx.stamp}@smoke.test`,
          role: 'user',
        },
      });
      const id = idOf(invited?.body);
      if (id) {
        await c.step('delete invited user', 'DELETE', `/api/users/${id}`, OK);
      } else {
        c.skip('delete invited user', 'no user id returned');
      }
    },
  },

  {
    module: 'tokens',
    run: async (c, ctx) => {
      await c.step('list tokens', 'GET', '/api/tokens', OK);
      const created = await c.step('create token', 'POST', '/api/tokens', CREATED, {
        body: { label: `Smoke Token ${ctx.stamp}` },
      });
      // Capture the raw token for the client-API + metrics suites. The plaintext
      // token is only returned once, at creation time.
      if (created?.body && typeof created.body === 'object') {
        const obj = created.body as Record<string, unknown>;
        const raw =
          (typeof obj.token === 'string' && obj.token) ||
          (typeof obj.apiToken === 'string' && obj.apiToken) ||
          (typeof obj.value === 'string' && obj.value) ||
          undefined;
        if (raw) {
          ctx.apiToken = raw;
        }
      }
      // NOTE: we intentionally do NOT delete this token here — later suites
      // (metrics, client-api) reuse it. Cleanup happens in the cleanup suite.
    },
  },

  {
    module: 'metrics',
    run: async (c, ctx) => {
      if (!ctx.apiToken) {
        c.skip('prometheus metrics', 'no api token available');
        return;
      }
      await c.step('prometheus metrics', 'GET', '/api/metrics', OK, {
        headers: { authorization: `Bearer ${ctx.apiToken}` },
      });
    },
  },

  {
    // Exercises the OpenAI-compatible Bearer-token client surface
    // (`/api/client/v1/*`) end to end, using the API token minted above.
    module: 'client-api',
    run: async (c, ctx) => {
      if (!ctx.apiToken) {
        c.skip('client api', 'no api token available');
        return;
      }
      const auth = { authorization: `Bearer ${ctx.apiToken}` };
      await c.step('client: missing bearer → 401', 'GET', '/api/client/v1/prompts', [401]);
      await c.step('client: list prompts', 'GET', '/api/client/v1/prompts', OK, {
        headers: auth,
      });
      if (ctx.piiPolicyKey) {
        await c.step('client: policy-based pii detect', 'POST', '/api/client/v1/pii/detect', OK, {
          headers: auth,
          body: { policy_key: ctx.piiPolicyKey, text: 'Reach me at agent@example.com' },
        });
      } else {
        c.skip('client: policy-based pii detect', 'no pii policy key available');
      }
    },
  },

  {
    // Final cleanup: remove the long-lived resources earlier suites kept alive
    // (the API token + the PII policy used by the client-API suite).
    module: 'cleanup',
    run: async (c, ctx) => {
      if (ctx.piiPolicyKey) {
        // The policy is fetched/deleted by _id; resolve it from the list.
        const policies = await c.step('list pii policies for cleanup', 'GET', '/api/pii/policies', OK);
        const arr =
          policies?.body && typeof policies.body === 'object'
            ? ((policies.body as Record<string, unknown>).policies as
                | Array<Record<string, unknown>>
                | undefined)
            : undefined;
        const match = (arr ?? []).find(
          (p) =>
            String(p.key) === ctx.piiPolicyKey ||
            String(p.name ?? '').startsWith('Smoke PII Policy'),
        );
        const policyId = match ? (match._id ?? match.id ?? match.key) : undefined;
        if (policyId) {
          await c.step('delete pii policy', 'DELETE', `/api/pii/policies/${policyId}`, OK);
        } else {
          c.skip('delete pii policy', 'policy not found in list');
        }
      }
      const list = await c.step('list tokens for cleanup', 'GET', '/api/tokens', OK);
      const tokens =
        list?.body && typeof list.body === 'object'
          ? ((list.body as Record<string, unknown>).tokens as
              | Array<Record<string, unknown>>
              | undefined)
          : undefined;
      const smokeTokens = (tokens ?? []).filter((t) =>
        String(t.label ?? '').startsWith('Smoke Token'),
      );
      if (smokeTokens.length === 0) {
        c.skip('delete smoke tokens', 'none found');
        return;
      }
      for (const t of smokeTokens) {
        await c.step('delete smoke token', 'DELETE', `/api/tokens/${t._id}`, OK);
      }
    },
  },
];
