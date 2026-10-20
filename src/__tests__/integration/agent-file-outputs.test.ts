/**
 * Files an agent writes without a sandbox — end to end.
 *
 * The same harness as the session-files suite: a REAL SQLite provider, the REAL file-output tools and
 * the REAL agent-sdk loop, driven by a scripted chat model. Faked at the boundary only: the object
 * store (an in-memory blob map behind the file service's own functions; the records are real rows),
 * the model lookup, the queue and the audit write.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const hoisted = vi.hoisted(() => ({
  getDatabase: vi.fn(),
  getModelByKey: vi.fn(),
  buildGatewayChatModel: vi.fn(),
  publish: vi.fn(),
  getUserAuthState: vi.fn(),
  recordAuditLog: vi.fn(),
  db: { current: null as unknown },
  blobs: new Map<string, Buffer>(),
  counter: { n: 0 },
  fileOps: {} as Record<string, (...args: never[]) => unknown>,
}));

vi.mock('@/lib/services/users/userAuthState', () => ({ getUserAuthState: hoisted.getUserAuthState }));
vi.mock('@/lib/core/queue', () => ({ getQueue: vi.fn(async () => ({ publish: hoisted.publish })) }));
vi.mock('@/lib/services/audit/auditService', () => ({ recordAuditLog: hoisted.recordAuditLog }));
vi.mock('@/lib/services/models/modelService', () => ({ getModelByKey: hoisted.getModelByKey }));
vi.mock('@/lib/services/agents/gatewayChatModel', () => ({ buildGatewayChatModel: hoisted.buildGatewayChatModel, isDynamicModel: () => false, }));
vi.mock('@/lib/services/agents/agentSandboxTools', () => ({
  buildAgentSandboxTools: vi.fn(async () => ({ tools: [], definitions: [], cleanup: async () => undefined, collectOutputs: async () => ({ attachments: [], warnings: [] }) })),
  destroyConversationSandbox: vi.fn(),
  resolveSandboxAvailability: vi.fn(),
}));
vi.mock('@/lib/services/files', () => ({
  uploadFile: (...args: unknown[]) => (hoisted.fileOps.uploadFile as (...a: unknown[]) => unknown)(...args),
  downloadFile: (...args: unknown[]) => (hoisted.fileOps.downloadFile as (...a: unknown[]) => unknown)(...args),
  replaceFileContent: (...args: unknown[]) => (hoisted.fileOps.replaceFileContent as (...a: unknown[]) => unknown)(...args),
  deleteFile: (...args: unknown[]) => (hoisted.fileOps.deleteFile as (...a: unknown[]) => unknown)(...args),
  generateFileRelativeKey: (name: string) => `${name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}-${Date.now()}-u${(hoisted.counter.n += 1)}`,
}));
vi.mock('@/lib/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/database')>();
  return {
    ...actual,
    getDatabase: hoisted.getDatabase,
    runWithTenantScope: async (_tenantDbName: string, fn: (db: unknown) => unknown) => fn(hoisted.db.current),
  };
});

import { getDatabase } from '@/lib/database';
import type { IAgentConfig, IAgentConversation, IFileRecord } from '@/lib/database';
import { SQLiteProvider } from '@/lib/database/sqlite.provider';
import { reloadConfig } from '@/lib/core/config';
import { executeAgentChatLocal, executePlaygroundChatLocal } from '@/lib/services/agents/agentService';
import { uploadSessionFile } from '@/lib/services/agents/sessionFiles';
import { destroyCache } from '@/lib/core/cache';

const DB_NAME = 'tenant_outputs';
const PROJECT_ID = 'proj-1';
const BUCKET = 'out-bucket';
const PROVIDER = 'out-files';
const AGENT_KEY = 'writer';
const OWNER = 'user-1';

type Reply = Record<string, unknown>;
type Seen = Array<{ role: string; content: unknown }>;

const usage = { input_tokens: 100, output_tokens: 20, total_tokens: 120 };
const answer = (text = 'done'): Reply => ({ role: 'assistant', content: text, usage_metadata: usage });
/** One assistant message that makes these calls together. */
const calls = (...list: Array<[string, Record<string, unknown>]>): Reply => ({
  role: 'assistant',
  content: '',
  tool_calls: list.map(([name, args], i) => ({ id: `call-${i}-${name}`, type: 'function', function: { name, arguments: JSON.stringify(args) } })),
  usage_metadata: usage,
});

/** A chat model that replies from a script and remembers what it was shown, the tools and their descriptions included. */
class ScriptedModel {
  readonly modelName = 'scripted-model';
  seen: Seen[] = [];
  toolNames: string[] = [];
  described = new Map<string, string>();
  constructor(private readonly script: (call: number, messages: Seen) => Reply) {}
  bindTools(tools: Array<{ name?: string; description?: string; function?: { name?: string; description?: string } }>) {
    this.toolNames = tools.map((tool) => tool.name ?? tool.function?.name ?? '');
    for (const tool of tools) this.described.set(String(tool.function?.name ?? tool.name), String(tool.function?.description ?? tool.description ?? ''));
    return this;
  }
  async invoke(messages: Seen): Promise<Reply> {
    const reply = this.script(this.seen.length, messages);
    this.seen.push(messages);
    return reply;
  }
}

let db: SQLiteProvider;
let tmpDir: string;
let tenantId: string;
let keySeq: number;

function scriptModel(script: (call: number, messages: Seen) => Reply): ScriptedModel {
  const model = new ScriptedModel(script);
  hoisted.buildGatewayChatModel.mockResolvedValue(model);
  return model;
}

/** The text of the last tool result the model was shown. */
const lastToolResult = (messages: Seen) => String([...messages].reverse().find((m) => m.role === 'tool')?.content ?? '');
const toolResults = (messages: Seen) => messages.filter((m) => m.role === 'tool').map((m) => String(m.content));
const systemOf = (messages: Seen) => String(messages.find((m) => m.role === 'system')?.content ?? '');

/** An agent with a files bucket, uploads OFF and the outputs switched on — the files it writes need no uploads. */
async function createAgent(config: Partial<IAgentConfig> = {}, attachments: IAgentConfig['attachments'] | null = { bucketKey: BUCKET, outputs: { enabled: true } }) {
  await db.createAgent({
    tenantId, projectId: PROJECT_ID, key: AGENT_KEY, name: 'Writer',
    config: { modelKey: 'gpt-4o', ...(attachments ? { attachments } : {}), ...config }, status: 'active', createdBy: OWNER,
  });
  return (await db.findAgentByKey(AGENT_KEY, PROJECT_ID))!;
}

async function newConversation(): Promise<IAgentConversation> {
  return db.createAgentConversation({
    tenantId, projectId: PROJECT_ID, agentKey: AGENT_KEY, title: 'New conversation', messages: [],
    metadata: { source: 'console' }, createdBy: OWNER,
  });
}

const chat = (conversationId: string, userMessage: string) => executeAgentChatLocal({
  tenantDbName: DB_NAME, tenantId, projectId: PROJECT_ID, agentKey: AGENT_KEY, conversationId, userMessage, userId: OWNER,
});

const stored = async (id: string) => (await db.findAgentConversationById(id))!;
const filesOf = (id: string) => db.listFileRecordsByConversation(id);
const blobOf = (record: IFileRecord) => hoisted.blobs.get(`${record.bucketKey}/${record.key}`)?.toString('utf8');

beforeEach(async () => {
  vi.clearAllMocks();
  await destroyCache();
  tmpDir = mkdtempSync(path.join(tmpdir(), 'agent-file-outputs-'));
  db = new SQLiteProvider(tmpDir, 'test_main');
  await db.connect();
  hoisted.getDatabase.mockResolvedValue(db);
  hoisted.db.current = db;
  (getDatabase as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(db);
  const tenant = await db.createTenant({
    companyName: 'Acme', slug: 'acme-outputs', dbName: DB_NAME, licenseType: 'FREE', ownerId: 'owner-1',
  });
  tenantId = String(tenant._id);
  await db.switchToTenant(DB_NAME);
  await db.createProvider({
    tenantId, projectId: PROJECT_ID, key: PROVIDER, type: 'file', driver: 'local-filesystem', label: 'Test disk',
    status: 'active', credentialsEnc: '', settings: {}, createdBy: OWNER,
  });
  await db.createFileBucket({ tenantId, projectId: PROJECT_ID, key: BUCKET, name: 'Out bucket', providerKey: PROVIDER, status: 'active', createdBy: OWNER });
  hoisted.getModelByKey.mockResolvedValue({
    key: 'gpt-4o', name: 'GPT-4o', category: 'llm', providerKey: 'openai', providerDriver: 'openai',
    modelId: 'gpt-4o', tenantId, projectId: PROJECT_ID, settings: {}, pricing: { inputTokenPer1M: 1, outputTokenPer1M: 1, currency: 'USD' },
  });
  hoisted.publish.mockResolvedValue(undefined);
  hoisted.getUserAuthState.mockResolvedValue('active');
  hoisted.recordAuditLog.mockResolvedValue(undefined);
  reloadConfig();

  // The object store: a blob map, with the file records in the real database.
  hoisted.blobs.clear();
  keySeq = 0;
  hoisted.fileOps.uploadFile = (async (_db: string, tId: string, pId: string, request: {
    bucketKey: string; fileName: string; contentType?: string; data: Buffer; createdBy: string;
    convertToMarkdown?: boolean; keyHint?: string; recordExtras?: Partial<IFileRecord>;
  }) => {
    keySeq += 1;
    const key = request.keyHint ?? `obj-${keySeq}`;
    hoisted.blobs.set(`${request.bucketKey}/${key}`, request.data);
    const record = await db.createFileRecord({
      tenantId: tId, projectId: pId, providerKey: PROVIDER, bucketKey: request.bucketKey, key,
      name: request.fileName, size: request.data.length, contentType: request.contentType,
      markdownStatus: 'skipped', ...(request.recordExtras ?? {}), createdBy: request.createdBy,
    });
    return { record: { ...record, id: String(record._id) } };
  }) as never;
  hoisted.fileOps.downloadFile = (async (_db: string, _t: string, _p: string, bucketKey: string, key: string) => {
    const blob = hoisted.blobs.get(`${bucketKey}/${key}`);
    if (!blob) throw new Error('File record not found.');
    return { fileName: key, data: blob };
  }) as never;
  hoisted.fileOps.replaceFileContent = (async (_db: string, _t: string, pId: string, bucketKey: string, key: string, input: { data: Buffer; updatedBy: string }) => {
    hoisted.blobs.set(`${bucketKey}/${key}`, input.data);
    const record = (await db.findFileRecordByKey(PROVIDER, bucketKey, key, pId))!;
    const updated = (await db.updateFileRecord(String(record._id), { size: input.data.length, updatedBy: input.updatedBy }))!;
    return { ...updated, id: String(updated._id) };
  }) as never;
  hoisted.fileOps.deleteFile = (async () => true) as never;
});

afterEach(async () => {
  reloadConfig();
  await db.disconnect();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('which runs get the tools', () => {
  it('an agent with a files bucket gets both tools and a prompt section naming them, with its uploads off', async () => {
    await createAgent({ systemPrompt: 'You write reports.' });
    const model = scriptModel(() => answer());
    await chat(String((await newConversation())._id), 'hi');

    expect(model.toolNames).toEqual(expect.arrayContaining(['session_files_create', 'session_files_append']));
    const system = systemOf(model.seen[0]!);
    expect(system).toContain('You write reports.');
    expect(system).toContain('## Files you can create');
    expect(system).toContain('10 new files per turn, 2 MB per file');
    expect(model.described.get('session_files_create')).toContain('Up to 10 files per turn, 2 MB each');
  });

  it('the author’s limits are the ones the model is told', async () => {
    await createAgent({}, { bucketKey: BUCKET, outputs: { enabled: true, maxFilesPerTurn: 3, maxFileSizeMb: 0.5 } });
    const model = scriptModel(() => answer());
    await chat(String((await newConversation())._id), 'hi');
    expect(systemOf(model.seen[0]!)).toContain('3 new files per turn, 0.5 MB per file');
  });

  it('no tools, and no prompt section, without a bucket, with the feature switched off, or on a stateless call', async () => {
    for (const [label, attachments] of [
      ['no attachments setting', null],
      ['no bucket', { enabled: true }],
      ['uploads off and the outputs left at the default', { bucketKey: BUCKET }],
      ['uploads on and the outputs switched off', { enabled: true, bucketKey: BUCKET, outputs: { enabled: false } }],
      ['switched off', { bucketKey: BUCKET, outputs: { enabled: false } }],
    ] as const) {
      const existing = await db.findAgentByKey(AGENT_KEY, PROJECT_ID);
      if (existing) await db.updateAgent(String(existing._id), { config: { modelKey: 'gpt-4o', ...(attachments ? { attachments } : {}) } });
      else await createAgent({}, attachments as never);
      const model = scriptModel(() => answer());
      await chat(String((await newConversation())._id), 'hi');
      expect(model.toolNames.filter((name) => name.startsWith('session_files')), label).toEqual([]);
      expect(systemOf(model.seen[0]!), label).not.toContain('Files you can create');
    }

    await db.updateAgent(String((await db.findAgentByKey(AGENT_KEY, PROJECT_ID))!._id), { config: { modelKey: 'gpt-4o', attachments: { bucketKey: BUCKET, outputs: { enabled: true } } } });
    const model = scriptModel(() => answer());
    await executePlaygroundChatLocal({ tenantDbName: DB_NAME, tenantId, projectId: PROJECT_ID, agentKey: AGENT_KEY, userMessage: 'hi' });
    expect(model.toolNames.filter((name) => name.startsWith('session_files'))).toEqual([]);
  });

  it('no tools when the bucket cannot take a file now', async () => {
    await createAgent({}, { bucketKey: 'ghost', outputs: { enabled: true } });
    const model = scriptModel(() => answer());
    await chat(String((await newConversation())._id), 'hi');
    expect(model.toolNames.filter((name) => name.startsWith('session_files'))).toEqual([]);
  });

  it('with uploads on, the outputs follow them by default: a bucket is all it takes', async () => {
    await createAgent({}, { enabled: true, bucketKey: BUCKET });
    const model = scriptModel(() => answer());
    await chat(String((await newConversation())._id), 'hi');
    expect(model.toolNames).toEqual(expect.arrayContaining(['session_files_create', 'session_files_append']));
  });

  it('the read tools come with the outputs while the session holds a file, uploads off', async () => {
    await createAgent();
    scriptModel((call) => (call === 0 ? calls(['session_files_create', { filename: 'plan.md', content: 'step one' }]) : answer()));
    const id = String((await newConversation())._id);
    await chat(id, 'write a plan');
    const [record] = await filesOf(id);

    // The next turn offers the read tools and they see the agent's own file.
    const model = scriptModel((call, messages) => {
      if (call === 0) return calls(['session_files_list', {}]);
      if (call === 1) return calls(['read', { fileId: String(record!._id) }]);
      return answer(lastToolResult(messages));
    });
    await chat(id, 'what did you write?');
    expect(model.toolNames).toEqual(expect.arrayContaining(['session_files_create', 'session_files_append', 'session_files_list', 'read']));
    const results = model.seen.flatMap(toolResults);
    expect(results.some((text) => text.includes('plan.md'))).toBe(true);
    expect(results.some((text) => text.includes('step one'))).toBe(true);
  });

  it('no read tools without uploads or the outputs, whatever the session holds', async () => {
    await createAgent();
    scriptModel((call) => (call === 0 ? calls(['session_files_create', { filename: 'plan.md', content: 'step one' }]) : answer()));
    const id = String((await newConversation())._id);
    await chat(id, 'write a plan');
    expect(await filesOf(id)).toHaveLength(1);

    // The outputs are left at their default (off with uploads off).
    await db.updateAgent(String((await db.findAgentByKey(AGENT_KEY, PROJECT_ID))!._id), { config: { modelKey: 'gpt-4o', attachments: { bucketKey: BUCKET } } });
    const model = scriptModel(() => answer());
    await chat(id, 'and now?');
    expect(model.toolNames.filter((name) => name.startsWith('session_files'))).toEqual([]);
  });

  it('a tool the host or the author declares under the same name does not shadow them', async () => {
    await createAgent({ clientTools: [{ name: 'session_files_create', description: 'imposter', inputSchema: { type: 'object' } }] } as never);
    const model = scriptModel(() => answer());
    await executePlaygroundChatLocal({
      tenantDbName: DB_NAME, tenantId, projectId: PROJECT_ID, agentKey: AGENT_KEY,
      conversationId: String((await newConversation())._id), userMessage: 'hi', runtimeContext: { userId: OWNER, source: 'playground' },
      embedded: { clientTools: [{ name: 'session_files_append', description: 'imposter too' }] },
    });
    expect(model.toolNames.filter((name) => name === 'session_files_create')).toHaveLength(1);
    expect(model.toolNames.filter((name) => name === 'session_files_append')).toHaveLength(1);
    expect([...model.described.values()].some((text) => text.includes('imposter'))).toBe(false);
  });
});

describe('creating a file', () => {
  it('stores it in the agent’s bucket as the agent’s own output and delivers it on the answer', async () => {
    await createAgent({}, { bucketKey: BUCKET, folder: 'reports', outputs: { enabled: true } });
    const model = scriptModel((call, messages) => (call === 0
      ? calls(['session_files_create', { filename: 'Q1 summary.md', content: '# Q1\n\nAll good.' }])
      : answer(`Wrote it: ${lastToolResult(messages)}`)));
    const conversation = await newConversation();
    const id = String(conversation._id);

    const response = await chat(id, 'write the Q1 summary');

    const [record] = await filesOf(id);
    expect(record).toMatchObject({
      name: 'Q1-summary.md', contentType: 'text/markdown', size: 15, origin: 'agent_output', purpose: 'conversation',
      conversationId: id, agentKey: AGENT_KEY, bucketKey: BUCKET, projectId: PROJECT_ID,
    });
    expect(record.key).toMatch(new RegExp(`^reports/${AGENT_KEY}/${id}/q1-summary-md-`));
    expect(blobOf(record)).toBe('# Q1\n\nAll good.');

    // What the model was told.
    expect(JSON.parse(lastToolResult(model.seen[1]!))).toEqual({
      file_id: String(record._id), filename: 'Q1-summary.md', mime_type: 'text/markdown', size_bytes: 15,
      download_url: `/api/client/v1/agents/sessions/${id}/files/${String(record._id)}/content`,
    });

    // The assistant message carries it.
    const after = await stored(id);
    const assistant = after.messages.at(-1)!;
    expect(assistant.attachments).toEqual([{ fileId: String(record._id), name: 'Q1-summary.md', mimeType: 'text/markdown', size: 15, origin: 'agent_output' }]);
    expect(after.messages[0]).not.toHaveProperty('attachments');

    // What a client reads.
    expect(response.output_files).toEqual([{
      id: String(record._id), name: 'Q1-summary.md', mime_type: 'text/markdown', size: 15,
      download_url: `/api/client/v1/agents/sessions/${id}/files/${String(record._id)}/content`,
    }]);
  });

  it('a name already used in the session gets "-1"', async () => {
    await createAgent();
    scriptModel((call) => (call === 0
      ? calls(['session_files_create', { filename: 'notes.txt', content: 'one' }])
      : call === 1 ? calls(['session_files_create', { filename: 'notes.txt', content: 'two' }]) : answer()));
    const id = String((await newConversation())._id);
    await chat(id, 'go');
    expect((await filesOf(id)).map((record) => record.name).sort()).toEqual(['notes-1.txt', 'notes.txt']);
  });

  it('is not put on the person’s next message: nothing rides along, and no attachment is stored on it', async () => {
    // Uploads on: that is the setting under which files nobody has sent ride along with the next message.
    await createAgent({}, { enabled: true, bucketKey: BUCKET, outputs: { enabled: true } });
    const model = scriptModel((call) => (call === 0 ? calls(['session_files_create', { filename: 'a.csv', content: 'x,y\n1,2' }]) : answer()));
    const id = String((await newConversation())._id);
    await chat(id, 'make a csv');
    // The answer that delivered the file is gone from the transcript (a regenerate or an edit cut it): nothing names the file any more.
    const delivered = await stored(id);
    await db.updateAgentConversation(id, { messages: delivered.messages.map((message) => ({ ...message, attachments: undefined })) });
    const seenBefore = model.seen.length;

    await chat(id, 'thanks');

    const userTurn = model.seen.slice(seenBefore).flat().filter((m) => m.role === 'user').at(-1)!;
    expect(String(userTurn.content)).toBe('thanks');
    const after = await stored(id);
    const users = after.messages.filter((message) => message.role === 'user');
    expect(users.every((message) => !('attachments' in message))).toBe(true);
    // The later turn's answer carries nothing new either.
    expect(after.messages.at(-1)).not.toHaveProperty('attachments');
    // The agent can still find its file with the read tools.
    expect(model.toolNames).toEqual(expect.arrayContaining(['session_files_list', 'read']));
  });

  it('holds the turn to the author’s file count: the files past it are refused with a sentence, the turn goes on', async () => {
    await createAgent({}, { bucketKey: BUCKET, outputs: { enabled: true, maxFilesPerTurn: 2 } });
    const model = scriptModel((call) => (call === 0
      ? calls(
        ['session_files_create', { filename: 'a.md', content: 'a' }],
        ['session_files_create', { filename: 'b.md', content: 'b' }],
        ['session_files_create', { filename: 'c.md', content: 'c' }],
      )
      : answer('ok')));
    const id = String((await newConversation())._id);

    const response = await chat(id, 'three files');

    expect(response.status).toBe('completed');
    expect((await filesOf(id)).map((record) => record.name).sort()).toEqual(['a.md', 'b.md']);
    expect(toolResults(model.seen[1]!).filter((text) => text.includes('At most 2 files can be created in one turn'))).toHaveLength(1);
    expect((await stored(id)).messages.at(-1)!.attachments).toHaveLength(2);
    // A new turn starts the count again.
    scriptModel((call) => (call === 0 ? calls(['session_files_create', { filename: 'd.md', content: 'd' }]) : answer()));
    await chat(id, 'one more');
    expect(await filesOf(id)).toHaveLength(3);
  });

  it('holds a file to the author’s size, and refuses a type or a mime_type that does not fit', async () => {
    await createAgent({}, { bucketKey: BUCKET, outputs: { enabled: true, maxFileSizeMb: 0.01 } });
    const model = scriptModel((call) => (call === 0
      ? calls(
        ['session_files_create', { filename: 'big.txt', content: 'x'.repeat(11_000) }],
        ['session_files_create', { filename: 'run.sh', content: 'echo hi' }],
        ['session_files_create', { filename: 'a.md', content: 'ok', mime_type: 'text/csv' }],
      )
      : answer()));
    const id = String((await newConversation())._id);
    await chat(id, 'try');
    expect(await filesOf(id)).toEqual([]);
    const results = toolResults(model.seen[1]!);
    expect(results[0]).toContain('limit for files an agent writes');
    expect(results[1]).toContain('.md');
    expect(results[2]).toContain('does not match');
    expect(await stored(id)).not.toHaveProperty('messages.1.attachments');
  });

  it('does not use up the person’s own file count', async () => {
    await createAgent({}, { enabled: true, bucketKey: BUCKET, maxFiles: 1, outputs: { enabled: true } });
    scriptModel((call) => (call === 0
      ? calls(['session_files_create', { filename: 'a.md', content: 'a' }], ['session_files_create', { filename: 'b.md', content: 'b' }])
      : answer()));
    const conversation = await newConversation();
    const id = String(conversation._id);
    await chat(id, 'write two');

    const agent = (await db.findAgentByKey(AGENT_KEY, PROJECT_ID))!;
    const mine = await uploadSessionFile({
      scope: { tenantDbName: DB_NAME, tenantId, projectId: PROJECT_ID }, conversation: await stored(id), agentConfig: agent.config,
      fileName: 'mine.txt', contentType: 'text/plain', data: Buffer.from('mine'), actor: { userId: OWNER, licenseType: 'FREE' },
    });
    expect(mine.name).toBe('mine.txt');
    expect(await filesOf(id)).toHaveLength(3);
  });

  it('is not asked about, even when the agent asks before every tool', async () => {
    await createAgent({ humanInTheLoop: { toolApproval: { enabled: true, defaultPolicy: 'always' } } });
    scriptModel((call) => (call === 0 ? calls(['session_files_create', { filename: 'a.md', content: 'a' }]) : answer('done')));
    const id = String((await newConversation())._id);

    const response = await chat(id, 'write');

    expect(response.status).toBe('completed');
    expect(await filesOf(id)).toHaveLength(1);
  });
});

describe('appending to a file', () => {
  it('adds to a file this agent created — in the same turn or a later one — and delivers it again', async () => {
    await createAgent();
    let fileId = '';
    scriptModel((call, messages) => {
      if (call === 0) return calls(['session_files_create', { filename: 'log.md', content: 'part 1' }]);
      if (call === 1) {
        fileId = JSON.parse(lastToolResult(messages)).file_id;
        return calls(['session_files_append', { file_id: fileId, content: ', part 2' }]);
      }
      return answer('done');
    });
    const conversation = await newConversation();
    const id = String(conversation._id);
    await chat(id, 'start the log');

    let [record] = await filesOf(id);
    expect(blobOf(record!)).toBe('part 1, part 2');
    expect(record!.size).toBe(14);
    expect(await filesOf(id)).toHaveLength(1);
    // One file, delivered once, at its final size.
    expect((await stored(id)).messages.at(-1)!.attachments).toEqual([{ fileId, name: 'log.md', mimeType: 'text/markdown', size: 14, origin: 'agent_output' }]);

    // A later turn.
    scriptModel((call) => (call === 0 ? calls(['session_files_append', { file_id: fileId, content: '\npart 3' }]) : answer('more')));
    await chat(id, 'extend it');
    [record] = await filesOf(id);
    expect(blobOf(record!)).toBe('part 1, part 2\npart 3');
    expect((await stored(id)).messages.at(-1)!.attachments).toEqual([{ fileId, name: 'log.md', mimeType: 'text/markdown', size: 21, origin: 'agent_output' }]);
  });

  it('refuses a file the person uploaded, a file of another session and one that does not exist', async () => {
    await createAgent({}, { enabled: true, bucketKey: BUCKET, outputs: { enabled: true } });
    const conversation = await newConversation();
    const other = await newConversation();
    const agent = (await db.findAgentByKey(AGENT_KEY, PROJECT_ID))!;
    const upload = (target: IAgentConversation) => uploadSessionFile({
      scope: { tenantDbName: DB_NAME, tenantId, projectId: PROJECT_ID }, conversation: target, agentConfig: agent.config,
      fileName: 'in.txt', contentType: 'text/plain', data: Buffer.from('original'), actor: { userId: OWNER, licenseType: 'FREE' },
    });
    const uploaded = await upload(conversation);
    const elsewhere = await upload(other);
    const model = scriptModel((call) => (call === 0
      ? calls(
        ['session_files_append', { file_id: uploaded.id, content: 'x' }],
        ['session_files_append', { file_id: elsewhere.id, content: 'x' }],
        ['session_files_append', { file_id: 'nope', content: 'x' }],
      )
      : answer()));
    const id = String(conversation._id);

    await chat(id, 'try');

    const results = toolResults(model.seen[1]!);
    expect(results).toHaveLength(3);
    for (const text of results) expect(text).toContain('Only a file this agent created in this session can be appended to.');
    expect(hoisted.blobs.get(`${BUCKET}/${(await filesOf(id))[0]!.key}`)?.toString()).toBe('original');
    expect(hoisted.blobs.get(`${BUCKET}/${(await filesOf(String(other._id)))[0]!.key}`)?.toString()).toBe('original');
  });

  it('stops at the file size: the file is left as it was', async () => {
    await createAgent({}, { bucketKey: BUCKET, outputs: { enabled: true, maxFileSizeMb: 0.01 } });
    let fileId = '';
    const model = scriptModel((call, messages) => {
      if (call === 0) return calls(['session_files_create', { filename: 'a.txt', content: 'x'.repeat(6000) }]);
      if (call === 1) {
        fileId = JSON.parse(lastToolResult(messages)).file_id;
        return calls(['session_files_append', { file_id: fileId, content: 'y'.repeat(6000) }]);
      }
      return answer();
    });
    const id = String((await newConversation())._id);
    await chat(id, 'go');
    expect(lastToolResult(model.seen[2]!)).toContain('would exceed the 0.01 MB limit');
    const [record] = await filesOf(id);
    expect(blobOf(record!)).toBe('x'.repeat(6000));
  });
});
