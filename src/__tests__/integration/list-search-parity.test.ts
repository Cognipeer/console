/**
 * The search boxes of the lists the console draws (prompts, guardrails, memory stores and items, tools, analysis
 * definitions and conversations) - the contract both database providers must keep (SQLite and MongoDB via
 * mongodb-memory-server):
 *
 *  - what is typed is looked for as typed: `%`, `_` and `\` are characters of a name, never wildcards, and a search
 *    that holds one finds the row that holds it, not the rows a wildcard would reach;
 *  - the case of ASCII letters does not matter;
 *  - tags are looked for as whole tags, whatever characters they hold.
 *
 * The providers are written independently (SQLite `LIKE` reads a backslash as an escape only when the statement says
 * so); the same assertions run on both.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import type { DatabaseProvider } from '@/lib/database';
import { describeForEachProvider } from './db-parity.helper';

const NAMES = {
  underscore: 'my_report',
  decoyOfUnderscore: 'myXreport',
  percent: '100% done',
  decoyOfPercent: '1000 done',
  backslash: 'a\\b',
  decoyOfBackslash: 'ab',
  plain: 'plain text',
};
const ALL = Object.values(NAMES);

interface Searchable {
  label: string;
  /** Creates a row that is found by `name`. */
  create(db: DatabaseProvider, scope: { tenantId: string; projectId: string }, name: string, index: number): Promise<unknown>;
  /** The names of the rows the search finds, sorted. */
  find(db: DatabaseProvider, text: string): Promise<string[]>;
}

const sorted = (values: Array<string | undefined>) => values.filter((value): value is string => typeof value === 'string').sort();

const SEARCHABLES: Searchable[] = [
  {
    label: 'prompts',
    create: (db, { tenantId, projectId }, name, index) => db.createPrompt({
      tenantId, projectId, key: `prompt-${index}`, name, description: `about ${index}`, template: 'Hello', createdBy: 'u1',
    }),
    find: async (db, text) => sorted((await db.listPrompts({ search: text })).map((row) => row.name)),
  },
  {
    label: 'guardrails',
    create: (db, { tenantId, projectId }, name, index) => db.createGuardrail({
      tenantId, projectId, key: `guardrail-${index}`, name, description: `about ${index}`,
      type: 'custom', target: 'input', action: 'block', enabled: true, createdBy: 'u1',
    }),
    find: async (db, text) => sorted((await db.listGuardrails({ search: text })).map((row) => row.name)),
  },
  {
    label: 'memory stores',
    create: (db, { tenantId, projectId }, name, index) => db.createMemoryStore({
      tenantId, projectId, key: `store-${index}`, name, vectorProviderKey: 'vec', vectorIndexKey: 'idx', embeddingModelKey: 'emb',
      config: {} as never, status: 'active', memoryCount: 0, createdBy: 'u1',
    }),
    find: async (db, text) => sorted((await db.listMemoryStores({ search: text })).map((row) => row.name)),
  },
  {
    label: 'memory items (the content)',
    create: (db, { tenantId, projectId }, name, index) => db.createMemoryItem({
      tenantId, projectId, storeKey: 'store', content: name, contentHash: `hash-${index}`, scope: 'global', metadata: {}, tags: [],
      importance: 0.5, accessCount: 0, embeddingVersion: 'v1', vectorId: `vec-${index}`, status: 'active',
    }),
    find: async (db, text) => sorted((await db.listMemoryItems('store', { search: text })).items.map((row) => row.content)),
  },
  {
    label: 'tools',
    create: (db, { tenantId, projectId }, name, index) => db.createTool({
      tenantId, projectId, key: `tool-${index}`, name, description: `about ${index}`, type: 'openapi', status: 'active', actions: [], createdBy: 'u1',
    }),
    find: async (db, text) => sorted((await db.listTools({ search: text })).map((row) => row.name)),
  },
  {
    label: 'analysis definitions',
    create: (db, { tenantId, projectId }, name, index) => db.createAnalysisDefinition({
      tenantId, projectId, key: `definition-${index}`, name, description: `about ${index}`, fieldSet: [], modes: {} as never, createdBy: 'u1',
    }),
    find: async (db, text) => sorted((await db.listAnalysisDefinitions({ search: text })).map((row) => row.name)),
  },
  {
    label: 'analysis conversations',
    create: (db, { tenantId, projectId }, name, index) => db.createAnalysisConversation({
      tenantId, projectId, key: `conversation-${index}`, name, transcript: [], source: 'manual', createdBy: 'u1',
    }),
    find: async (db, text) => sorted((await db.listAnalysisConversations({ search: text })).map((row) => row.name)),
  },
];

describeForEachProvider('List search', (getDb) => {
  let scope: { tenantId: string; projectId: string };

  beforeEach(async () => {
    const slug = `lists-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const dbName = `tenant_${slug}`;
    const db = getDb();
    const tenant = await db.createTenant({ companyName: 'Acme', slug, dbName, licenseType: 'FREE', ownerId: 'pending' });
    await db.switchToTenant(dbName);
    scope = { tenantId: String(tenant._id), projectId: 'proj-1' };
  });

  describe.each(SEARCHABLES)('$label', (searchable) => {
    const seed = async () => {
      for (const [index, name] of ALL.entries()) await searchable.create(getDb(), scope, name, index);
    };
    const found = (text: string) => searchable.find(getDb(), text);

    it('looks for the text as typed: an underscore, a percent sign and a backslash are characters, not wildcards', async () => {
      await seed();
      expect(await found('my_report')).toEqual([NAMES.underscore]);
      expect(await found('_report')).toEqual([NAMES.underscore]);
      expect(await found('100%')).toEqual([NAMES.percent]);
      expect(await found('%')).toEqual([NAMES.percent]);
      expect(await found('a\\b')).toEqual([NAMES.backslash]);
      expect(await found('\\')).toEqual([NAMES.backslash]);
    });

    it('still finds a plain word anywhere in the name, whatever the case of its ASCII letters', async () => {
      await seed();
      expect(await found('REPORT')).toEqual(sorted([NAMES.underscore, NAMES.decoyOfUnderscore]));
      expect(await found('Plain')).toEqual([NAMES.plain]);
      expect(await found('done')).toEqual(sorted([NAMES.percent, NAMES.decoyOfPercent]));
    });

    it('finds nothing for text that no name holds', async () => {
      await seed();
      expect(await found('no-such-name')).toEqual([]);
      expect(await found('_%_')).toEqual([]);
    });
  });

  describe('analysis conversations: the tag', () => {
    const withTags = async () => {
      const db = getDb();
      const make = (index: number, tags: string[]) => db.createAnalysisConversation({
        tenantId: scope.tenantId, projectId: scope.projectId, key: `tagged-${index}`, name: `tagged ${index}`, transcript: [], source: 'manual', tags, createdBy: 'u1',
      });
      await make(1, ['a_b']);
      await make(2, ['aXb']);
      await make(3, ['100%']);
      await make(4, ['1000']);
      await make(5, ['say "hi"']);
      await make(6, ['back\\slash']);
    };
    const named = async (tag: string) => sorted((await getDb().listAnalysisConversations({ tag })).map((row) => row.name));

    it('is a whole tag, and its characters are not wildcards', async () => {
      await withTags();
      expect(await named('a_b')).toEqual(['tagged 1']);
      expect(await named('100%')).toEqual(['tagged 3']);
      expect(await named('1000')).toEqual(['tagged 4']);
      expect(await named('aXb')).toEqual(['tagged 2']);
    });

    it('holds when the tag has a quote or a backslash', async () => {
      await withTags();
      expect(await named('say "hi"')).toEqual(['tagged 5']);
      expect(await named('back\\slash')).toEqual(['tagged 6']);
    });

    it('is not the start or the end of another tag', async () => {
      await withTags();
      expect(await named('a_')).toEqual([]);
      expect(await named('100')).toEqual([]);
    });
  });

  describe('memory items: the tags', () => {
    const itemWith = (index: number, tags: string[]) => getDb().createMemoryItem({
      tenantId: scope.tenantId, projectId: scope.projectId, storeKey: 'store', content: `item ${index}`, contentHash: `hash-${index}`, scope: 'global',
      metadata: {}, tags, importance: 0.5, accessCount: 0, embeddingVersion: 'v1', vectorId: `vec-${index}`, status: 'active',
    });
    const named = async (tags: string[]) => sorted((await getDb().listMemoryItems('store', { tags })).items.map((row) => row.content));

    it('are looked for as whole tags: an underscore or a percent sign is not a wildcard', async () => {
      await itemWith(1, ['a_b']);
      await itemWith(2, ['aXb']);
      await itemWith(3, ['100%']);
      await itemWith(4, ['1000']);
      expect(await named(['a_b'])).toEqual(['item 1']);
      expect(await named(['100%'])).toEqual(['item 3']);
      expect(await named(['a_b', '1000'])).toEqual(['item 1', 'item 4']);
      expect(await named(['a'])).toEqual([]);
    });
  });

  describe('providers of a project', () => {
    it('are the providers that name the project, and a wildcard is not a project', async () => {
      const db = getDb();
      const make = (key: string, projectIds: string[]) => db.createProvider({
        tenantId: scope.tenantId, projectIds, key, type: 'model', driver: 'openai', label: key, status: 'active', credentialsEnc: 'x', settings: {}, createdBy: 'u1',
      } as never);
      await make('for-a', ['proj-a']);
      await make('for-b', ['proj-b']);
      await make('for-ab', ['proj-a', 'proj-b']);

      const keysOf = async (projectId: string) => sorted((await db.listProviders(scope.tenantId, { projectId })).map((row) => row.key));
      expect(await keysOf('proj-a')).toEqual(['for-a', 'for-ab']);
      expect(await keysOf('proj-b')).toEqual(['for-ab', 'for-b']);
      expect(await keysOf('%')).toEqual([]);
      expect(await keysOf('proj-_')).toEqual([]);
      expect(await keysOf('proj')).toEqual([]);
    });
  });
});
