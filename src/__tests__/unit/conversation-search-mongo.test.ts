/**
 * Mongo side of conversation search: the query is built from an escaped regex (never the raw input), and it
 * selects the right documents on a real server (mongodb-memory-server) when one is available.
 */
import { createRequire } from 'node:module';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildMongoConversationSearchCondition, escapeRegex } from '@/lib/database/provider/conversationSearch';

const MONGO_AVAILABLE: boolean = (() => {
  try {
    createRequire(import.meta.url).resolve('mongodb-memory-server');
    return true;
  } catch {
    return false;
  }
})();

describe('buildMongoConversationSearchCondition', () => {
  it('searches the title and each message content with a case-insensitive escaped regex', () => {
    const regex = { $regex: 'a\\.b\\(\\*\\)\\[x\\]', $options: 'i' };
    expect(buildMongoConversationSearchCondition('a.b(*)[x]')).toEqual({
      $or: [{ title: regex }, { messages: { $elemMatch: { content: regex } } }],
    });
  });

  it('escapes every regex metacharacter', () => {
    const raw = '.*+?^${}()|[]\\';
    const re = new RegExp(escapeRegex(raw));
    expect(re.test(`x${raw}y`)).toBe(true);
    expect(re.test('x')).toBe(false);
  });
});

describe.runIf(MONGO_AVAILABLE)('condition against a real server', () => {
  let server: { getUri(): string; stop(): Promise<boolean> };
  let client: import('mongodb').MongoClient;
  let coll: import('mongodb').Collection;

  beforeAll(async () => {
    const { MongoMemoryServer } = await import('mongodb-memory-server');
    const { MongoClient } = await import('mongodb');
    server = await MongoMemoryServer.create();
    client = await MongoClient.connect(server.getUri());
    coll = client.db('t').collection('agent_conversations');
    await coll.insertMany([
      { title: 'Budget plan', messages: [{ role: 'user', content: 'hi' }] },
      { title: 'x', messages: [{ role: 'user', content: 'cost is 50% (approx.)' }] },
      { title: 'y', messages: [{ role: 'user', content: 'cost is 500 approxX' }] },
      { title: 'z', messages: [] },
    ]);
  });

  afterAll(async () => {
    await client?.close();
    await server?.stop();
  });

  const titles = async (needle: string) =>
    (await coll.find(buildMongoConversationSearchCondition(needle)).toArray()).map((d) => d.title).sort();

  it('matches title or message text, case-insensitively', async () => {
    expect(await titles('BUDGET')).toEqual(['Budget plan']);
    expect(await titles('cost is')).toEqual(['x', 'y']);
  });

  it('takes metacharacters literally', async () => {
    expect(await titles('50% (approx.)')).toEqual(['x']);
    expect(await titles('.*')).toEqual([]);
  });
});
