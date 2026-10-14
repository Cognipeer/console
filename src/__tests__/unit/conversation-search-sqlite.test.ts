/**
 * `searchAgentConversations` on a REAL SQLite provider: title and message text, literal matching (LIKE wildcards
 * and backslashes are plain characters), scope filters, ordering, paging and the match a hit carries.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { SQLiteProvider } from '@/lib/database/sqlite.provider';
import { buildSnippet, normalizeConversationSearch } from '@/lib/database/provider/conversationSearch';

let tmpDir = '';
let db: SQLiteProvider;
const project = 'proj-1';
const wait = () => new Promise((resolve) => setTimeout(resolve, 5));

const msg = (role: string, content: string, id?: string) => ({ ...(id ? { id } : {}), role, content, timestamp: new Date() });

async function make(title: string, messages: ReturnType<typeof msg>[], over: Record<string, unknown> = {}) {
  const row = await db.createAgentConversation({
    tenantId: 't1', projectId: project, agentKey: 'bot-a', title, messages, createdBy: 'ann', ...over,
  } as never);
  await wait();
  return String(row._id);
}

beforeAll(async () => {
  tmpDir = mkdtempSync(path.join(tmpdir(), 'cognipeer-conv-search-'));
  db = new SQLiteProvider(tmpDir, 'conv_search_main');
  await db.connect();
  await db.switchToTenant('conv_search_tenant');
});

afterAll(async () => {
  await db.disconnect();
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

describe('searchAgentConversations (sqlite)', () => {
  it('finds by title and by message text, newest activity first, with the match', async () => {
    const byTitle = await make('Quarterly Budget review', [msg('user', 'hello')]);
    const byMessage = await make('Untitled', [msg('user', 'hi', 'm1'), msg('assistant', 'The budget is approved for next year', 'm2')]);
    await make('Other', [msg('user', 'nothing here')]);

    const hits = await db.searchAgentConversations({ projectId: project, search: 'BUDGET' });
    expect(hits.map((h) => String(h._id))).toEqual([byMessage, byTitle]);
    expect(hits[0]).not.toHaveProperty('messages');
    expect(hits[0].messageCount).toBe(2);
    expect(hits[0].searchMatch).toMatchObject({ field: 'message', messageId: 'm2', role: 'assistant' });
    expect(hits[0].searchMatch?.snippet).toContain('budget is approved');
    expect(hits[1].searchMatch).toEqual({ field: 'title', snippet: 'Quarterly Budget review' });
  });

  it('takes % _ and backslash literally', async () => {
    const pct = await make('Sale 50% off', [msg('user', 'x')]);
    const under = await make('file_name notes', [msg('user', 'x')]);
    const slash = await make('path C:\\temp', [msg('user', 'x')]);
    await make('Sale 500 off', [msg('user', 'x')]);
    await make('fileXname notes', [msg('user', 'x')]);

    const ids = async (search: string) => (await db.searchAgentConversations({ projectId: project, search })).map((h) => String(h._id));
    expect(await ids('50%')).toEqual([pct]);
    expect(await ids('e_n')).toEqual([under]);
    expect(await ids('C:\\t')).toEqual([slash]);
    expect(await ids('% o')).toEqual([pct]);
  });

  it('does not match the JSON of the transcript, only message text', async () => {
    await make('plain', [msg('user', 'abc')]);
    expect(await db.searchAgentConversations({ projectId: project, search: 'timestamp' })).toEqual([]);
    expect(await db.searchAgentConversations({ projectId: project, search: '"role"' })).toEqual([]);
  });

  it('keeps to the project, the agents and the person asked for', async () => {
    const mine = await make('scoped needle', [msg('user', 'x')], { agentKey: 'bot-b', createdBy: 'ann' });
    await make('scoped needle', [msg('user', 'x')], { agentKey: 'bot-b', createdBy: 'bob' });
    await make('scoped needle', [msg('user', 'x')], { agentKey: 'bot-c', createdBy: 'ann' });
    await make('scoped needle', [msg('user', 'x')], { projectId: 'proj-2', agentKey: 'bot-b', createdBy: 'ann' });

    const hits = await db.searchAgentConversations({ projectId: project, search: 'scoped needle', agentKeys: ['bot-b'], createdBy: 'ann' });
    expect(hits.map((h) => String(h._id))).toEqual([mine]);
    expect(await db.searchAgentConversations({ projectId: project, search: 'scoped needle', agentKeys: [] })).toEqual([]);
    expect(await db.searchAgentConversations({ projectId: project, search: 'scoped needle' })).toHaveLength(3);
  });

  it('pages with limit and skip, and ignores a search that is too short', async () => {
    for (let i = 0; i < 4; i += 1) await make(`pageword ${i}`, [msg('user', 'x')], { agentKey: 'bot-p' });
    const all = await db.searchAgentConversations({ projectId: project, search: 'pageword', limit: 10 });
    const second = await db.searchAgentConversations({ projectId: project, search: 'pageword', limit: 2, skip: 2 });
    expect(all).toHaveLength(4);
    expect(second.map((h) => String(h._id))).toEqual(all.slice(2).map((h) => String(h._id)));
    expect(await db.searchAgentConversations({ projectId: project, search: ' a ' })).toEqual([]);
  });

  it('treats an injection-looking search as plain text', async () => {
    expect(await db.searchAgentConversations({ projectId: project, search: "'; DROP TABLE x; --" })).toEqual([]);
    expect((await db.searchAgentConversations({ projectId: project, search: 'plain' })).length).toBe(1);
  });
});

describe('search helpers', () => {
  it('normalises: trims, drops under 2 characters, caps at 200', () => {
    expect(normalizeConversationSearch('  ab ')).toBe('ab');
    expect(normalizeConversationSearch(' a ')).toBeUndefined();
    expect(normalizeConversationSearch(undefined)).toBeUndefined();
    expect(normalizeConversationSearch('x'.repeat(500))).toHaveLength(200);
  });

  it('builds a short collapsed snippet with ellipses at cut ends', () => {
    const text = `${'word '.repeat(80)}NEEDLE\n\n   ${'tail '.repeat(80)}`;
    const snippet = buildSnippet(text, text.indexOf('NEEDLE'), 6);
    expect(snippet.length).toBeLessThanOrEqual(162);
    expect(snippet).toContain('NEEDLE');
    expect(snippet.startsWith('…')).toBe(true);
    expect(snippet.endsWith('…')).toBe(true);
    expect(snippet).not.toMatch(/\s{2,}|\n/);
    expect(buildSnippet('short text', 0, 5)).toBe('short text');
  });
});
