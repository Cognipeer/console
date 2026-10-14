/**
 * What a limit's resource / provider target points at, per service
 * (`quotaTargetSource`): the registry types searched, the filter, and above all
 * WHICH field is stored, because the guard decides a match with plain equality
 * against whatever the route puts in the quota context.
 *
 * The second half reads the Fastify routes themselves and fails when a route
 * starts (or stops) reporting a resource or provider key, so the table can not
 * go stale without a test saying so.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { isSameTargetKind, quotaTargetSource } from '@/lib/quota/targets';
import { QUOTA_DOMAINS, QUOTA_SCOPES, type QuotaDomain } from '@/lib/quota/types';

/** Services whose guarded calls name a model: the model's `category` is the service. */
const MODEL_SERVICES: QuotaDomain[] = ['llm', 'embedding', 'image', 'stt', 'tts', 'ocr', 'decision', 'moderation'];

describe('resource targets', () => {
  it.each(MODEL_SERVICES)('%s: a model of that category, stored by its key', (domain) => {
    expect(quotaTargetSource(domain, 'resource')).toMatchObject({
      scope: 'resource',
      types: ['model'],
      attributes: { category: [domain] },
      valueField: 'key',
      allowsUnregistered: false,
      noun: 'model',
    });
  });

  it('vector: a vector index, stored by its KEY (the route\'s externalId segment carries the key)', () => {
    expect(quotaTargetSource('vector', 'resource')).toMatchObject({
      types: ['vector-index'],
      valueField: 'key',
      noun: 'vectorIndex',
    });
    expect(quotaTargetSource('vector', 'resource')?.attributes).toBeUndefined();
  });

  it('file: a file bucket, stored by its key', () => {
    expect(quotaTargetSource('file', 'resource')).toMatchObject({ types: ['file-bucket'], valueField: 'key', noun: 'fileBucket' });
  });

  it('agent: an agent, stored by its KEY', () => {
    expect(quotaTargetSource('agent', 'resource')).toMatchObject({ types: ['agent'], valueField: 'key', allowsUnregistered: false, noun: 'agent' });
  });

  it('tracing: an agent, stored by its NAME, and a name the registry does not know is fine', () => {
    expect(quotaTargetSource('tracing', 'resource')).toMatchObject({
      types: ['agent'],
      valueField: 'name',
      allowsUnregistered: true,
      noun: 'agentName',
    });
  });

  it('global: a model, an index or a bucket (the keys every other service reports), by key', () => {
    expect(quotaTargetSource('global', 'resource')).toMatchObject({
      types: ['model', 'vector-index', 'file-bucket'],
      valueField: 'key',
      noun: 'resource',
    });
    // No category filter: a global limit meets the model calls of every service.
    expect(quotaTargetSource('global', 'resource')?.attributes).toBeUndefined();
  });
});

describe('provider targets', () => {
  it('vector and file calls report their provider: only providers of that type are offered', () => {
    expect(quotaTargetSource('vector', 'provider')).toMatchObject({
      types: ['provider'], attributes: { type: ['vector'] }, valueField: 'key', neverApplies: false, noun: 'provider',
    });
    expect(quotaTargetSource('file', 'provider')).toMatchObject({
      types: ['provider'], attributes: { type: ['file'] }, valueField: 'key', neverApplies: false,
    });
  });

  it('a global limit meets both, so both kinds of provider are offered', () => {
    expect(quotaTargetSource('global', 'provider')).toMatchObject({ attributes: { type: ['vector', 'file'] }, neverApplies: false });
  });

  it.each(QUOTA_DOMAINS.filter((d) => !['vector', 'file', 'global'].includes(d)))(
    '%s: no call reports a provider, so a limit on one applies to nothing (and the editor says so)',
    (domain) => {
      expect(quotaTargetSource(domain, 'provider')).toMatchObject({ types: ['provider'], valueField: 'key', neverApplies: true });
      expect(quotaTargetSource(domain, 'provider')?.attributes).toBeUndefined();
    },
  );
});

describe('the sources as a set', () => {
  it('exist for every service, for exactly the two scopes that point at a registry row', () => {
    for (const domain of QUOTA_DOMAINS) {
      for (const scope of QUOTA_SCOPES) {
        const source = quotaTargetSource(domain, scope);
        if (scope === 'resource' || scope === 'provider') expect(source, `${domain}/${scope}`).not.toBeNull();
        else expect(source, `${domain}/${scope}`).toBeNull();
      }
    }
  });

  it('share an id exactly when they offer the same values', () => {
    const byId = new Map<string, string>();
    for (const domain of QUOTA_DOMAINS) {
      for (const scope of ['resource', 'provider'] as const) {
        const source = quotaTargetSource(domain, scope)!;
        const { id, ...rest } = source;
        const shape = JSON.stringify(rest);
        expect(byId.get(id) ?? shape, `${id} stands for two different things`).toBe(shape);
        byId.set(id, shape);
      }
    }
    // ...and two different things never share one.
    const shapes = new Set(byId.values());
    expect(shapes.size).toBe(byId.size);
  });

  it('bounds what a search asks for: few types, few filters', () => {
    for (const domain of QUOTA_DOMAINS) {
      for (const scope of ['resource', 'provider'] as const) {
        const source = quotaTargetSource(domain, scope)!;
        expect(source.types.length).toBeGreaterThan(0);
        expect(source.types.length).toBeLessThanOrEqual(8);
        expect(Object.keys(source.attributes ?? {}).length).toBeLessThanOrEqual(4);
      }
    }
  });
});

describe('a target survives a change of service only when it is the same kind of value', () => {
  it('forgets a model when the service moves to another model category, keeps it when nothing changes', () => {
    expect(isSameTargetKind('resource', 'llm', 'llm')).toBe(true);
    expect(isSameTargetKind('resource', 'llm', 'embedding')).toBe(false);
    expect(isSameTargetKind('resource', 'stt', 'tts')).toBe(false);
  });

  it('forgets a model key chosen for a model service when the service becomes vector, file, tracing or agent runs', () => {
    for (const to of ['vector', 'file', 'tracing', 'agent', 'global'] as const) {
      expect(isSameTargetKind('resource', 'llm', to), `llm -> ${to}`).toBe(false);
    }
  });

  it('tells an agent KEY (agent runs) from an agent NAME (tracing)', () => {
    expect(isSameTargetKind('resource', 'agent', 'tracing')).toBe(false);
    expect(isSameTargetKind('resource', 'tracing', 'agent')).toBe(false);
  });

  it('keeps a provider across services that all offer every provider (none of them can match)', () => {
    expect(isSameTargetKind('provider', 'llm', 'embedding')).toBe(true);
    expect(isSameTargetKind('provider', 'llm', 'vector')).toBe(false);
    expect(isSameTargetKind('provider', 'vector', 'file')).toBe(false);
    expect(isSameTargetKind('provider', 'vector', 'global')).toBe(false);
  });

  it('never forgets a person, a group or a token because the service changed', () => {
    for (const scope of ['user', 'group', 'token', 'tenant'] as const) {
      expect(isSameTargetKind(scope, 'llm', 'vector')).toBe(true);
    }
  });
});

// ── the routes ───────────────────────────────────────────────────────────

const ROOT = path.resolve(__dirname, '../..');
const read = (file: string) => readFileSync(path.join(ROOT, file), 'utf8');

/** The `{ ... }` that contains `at`, braces balanced (the quota contexts are plain object literals). */
function enclosingObject(source: string, at: number): string {
  let depth = 0;
  let start = -1;
  for (let i = at; i >= 0; i--) {
    const c = source[i];
    if (c === '}') depth++;
    else if (c === '{') {
      if (depth === 0) {
        start = i;
        break;
      }
      depth--;
    }
  }
  if (start < 0) return '';
  depth = 0;
  for (let i = start; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  return '';
}

const hasProperty = (block: string, name: string) => new RegExp(`(^|[\\s{,])${name}\\s*(:|,|\\})`).test(block);

interface Reported {
  resource: boolean;
  provider: boolean;
}

/** For every service, whether any guarded route puts a resource / provider key in its quota context. */
function reportedKeys(): Map<QuotaDomain, Reported> {
  const files = [
    ...readdirSync(path.join(ROOT, 'server/api/plugins')).filter((f) => f.endsWith('.ts')).map((f) => `server/api/plugins/${f}`),
    'lib/services/agents/agentQuota.ts',
  ];
  const found = new Map<QuotaDomain, Reported>();
  const literal = new RegExp(`\\bdomain:\\s*'(${QUOTA_DOMAINS.join('|')})'(?!\\s*\\|)`, 'g');
  for (const file of files) {
    const source = read(file);
    for (const match of source.matchAll(literal)) {
      const block = enclosingObject(source, match.index ?? 0);
      // A QuotaContext always names the tenant; anything else with a `domain` field is something else.
      if (!hasProperty(block, 'tenantDbName') || !hasProperty(block, 'tenantId')) continue;
      const domain = match[1] as QuotaDomain;
      const before = found.get(domain) ?? { resource: false, provider: false };
      found.set(domain, {
        resource: before.resource || hasProperty(block, 'resourceKey'),
        provider: before.provider || hasProperty(block, 'providerKey'),
      });
    }
  }
  return found;
}

describe('the routes agree with the table', () => {
  const reported = reportedKeys();

  it('actually found the guarded routes', () => {
    expect([...reported.keys()].sort()).toEqual(
      ['agent', 'decision', 'embedding', 'file', 'global', 'image', 'llm', 'ocr', 'tracing', 'vector'].sort(),
    );
  });

  it('reports a provider key for exactly the services whose provider limits can apply', () => {
    for (const [domain, keys] of reported) {
      if (domain === 'global') continue; // global limits are matched against everyone else's context
      const applies = !quotaTargetSource(domain, 'provider')!.neverApplies;
      expect(keys.provider, `${domain}: routes report a provider key = ${keys.provider}, table says provider limits apply = ${applies}`).toBe(applies);
    }
    // Vector and file are the only ones; global limits meet them.
    expect([...reported].filter(([, k]) => k.provider).map(([d]) => d).sort()).toEqual(['file', 'vector']);
  });

  it('reports a resource key wherever a resource limit is offered', () => {
    for (const [domain, keys] of reported) {
      if (domain === 'global') {
        expect(keys.resource, 'global routes (project / member / token caps) name no resource').toBe(false);
        continue;
      }
      expect(keys.resource, `${domain} routes report a resource key`).toBe(true);
      expect(quotaTargetSource(domain, 'resource')).not.toBeNull();
    }
  });

  it('puts the MODEL KEY in the context of every model call', () => {
    const inference = read('server/api/plugins/client-inference.ts');
    for (const domain of ['llm', 'image', 'embedding']) {
      const at = inference.indexOf(`domain: '${domain}' as const`);
      expect(at, domain).toBeGreaterThan(0);
      expect(enclosingObject(inference, at)).toMatch(/resourceKey:\s*modelKey/);
    }
    // ...and that key is what the caller sent as `model`.
    expect(inference).toMatch(/modelKey = body\.model;/);
    expect(inference).toMatch(/modelKey = anthropicBody\.model as string;/);

    expect(read('server/api/plugins/client-decisions.ts')).toMatch(/resourceKey:\s*modelKey/);
    expect(read('server/api/plugins/client-ocr-jobs.ts')).toMatch(/domain: 'ocr' as const,\s*resourceKey: modelKey/);
    // speech-to-text, text-to-speech and OCR share one guard that takes the service as a parameter.
    const audio = read('server/api/plugins/client-audio-ocr.ts');
    expect(audio).toMatch(/domain: 'stt' \| 'tts' \| 'ocr',\s*modelKey: string/);
    expect(audio).toMatch(/domain,\s*resourceKey: modelKey/);
    // Batch items are guarded as llm / embedding by the model key too.
    expect(read('lib/services/batch/batchRunner.ts')).toMatch(/\('embedding' as const\) : \('llm' as const\)[\s\S]*resourceKey: modelKey/);
  });

  it('names a model service for every model category the runtime enforces, and nothing else', () => {
    // A chat route refuses a model that is not `llm`, the decision route one that is not `decision`...:
    // the category IS the service, which is why the picker filters on it.
    const enforced = new Set(
      ['lib/services/models/inferenceService.ts', 'lib/services/models/gatewayCore.ts', 'lib/services/models/decisionService.ts'].flatMap((file) =>
        [...read(file).matchAll(/model\.category !== '(\w+)'/g)].map((m) => m[1]),
      ),
    );
    expect([...enforced].sort()).toEqual([...MODEL_SERVICES].sort());
  });

  it('puts the INDEX KEY in the context of vector calls: the externalId segment is handed to the service as indexKey', () => {
    for (const file of ['server/api/plugins/client-vector.ts', 'server/api/plugins/vector.ts']) {
      const source = read(file);
      expect(source, file).toMatch(/resourceKey: externalId/);
      expect(source, file).toMatch(/indexKey: externalId/);
    }
  });

  it('puts the BUCKET KEY, and for the dashboard the file provider key, in the context of file calls', () => {
    expect(read('server/api/plugins/client-files.ts')).toMatch(/domain: 'file' as const[\s\S]*?resourceKey: bucketKey/);
    const dashboard = read('server/api/plugins/files.ts');
    expect(dashboard).toMatch(/domain: 'file' as const[\s\S]*?providerKey: \(body\.providerKey as string \| undefined\) \?\? undefined,\s*resourceKey: bucketKey/);
  });

  it('puts the AGENT NAME in the context of tracing calls and the AGENT KEY in the context of agent runs', () => {
    const tracing = read('server/api/plugins/client-tracing.ts');
    expect(tracing).toMatch(/payload\?\.agent\?\.name \|\| sessionId/);
    expect(tracing).toMatch(/firstSession\.agentName \|\| firstSession\.sessionId/);
    expect(tracing).toMatch(/session\.agentName \|\| sessionId/);
    expect(read('lib/services/agents/agentQuota.ts')).toMatch(/resourceKey: caller\.agentKey/);
  });
});
