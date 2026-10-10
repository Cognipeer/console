/**
 * Session files — end to end.
 *
 * A REAL SQLite provider, the REAL session-file service and the REAL agent-sdk
 * loop, driven by a scripted chat model that remembers what it was shown. Faked
 * at the boundary only: the object store (an in-memory blob map behind the file
 * service's own functions — the records are real rows), the model lookup, the
 * queue and the audit write.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const hoisted = vi.hoisted(() => ({
  getDatabase: vi.fn(),
  getModelByKey: vi.fn(),
  buildModelRuntime: vi.fn(),
  publish: vi.fn(),
  getUserAuthState: vi.fn(),
  recordAuditLog: vi.fn(),
  db: { current: null as unknown },
  blobs: new Map<string, Buffer>(),
  fileOps: {} as Record<string, (...args: never[]) => unknown>,
}));

vi.mock('@/lib/services/users/userAuthState', () => ({ getUserAuthState: hoisted.getUserAuthState }));
vi.mock('@/lib/core/queue', () => ({ getQueue: vi.fn(async () => ({ publish: hoisted.publish })) }));
vi.mock('@/lib/services/audit/auditService', () => ({ recordAuditLog: hoisted.recordAuditLog }));
vi.mock('@/lib/services/models/modelService', () => ({ getModelByKey: hoisted.getModelByKey }));
vi.mock('@/lib/services/models/runtimeService', () => ({ buildModelRuntime: hoisted.buildModelRuntime }));
vi.mock('@/lib/services/agents/agentSandboxTools', () => ({
  buildAgentSandboxTools: vi.fn(async () => ({ tools: [], definitions: [], cleanup: async () => undefined })),
  destroyConversationSandbox: vi.fn(),
  resolveSandboxAvailability: vi.fn(),
}));
vi.mock('@/lib/services/providers/builtinProviders', () => ({
  BUILTIN_FILE_PROVIDER_KEY: 'builtin-files',
  ensureBuiltinProviders: vi.fn(async () => undefined),
}));
vi.mock('@/lib/services/files', () => ({
  uploadFile: (...args: unknown[]) => (hoisted.fileOps.uploadFile as (...a: unknown[]) => unknown)(...args),
  downloadFile: (...args: unknown[]) => (hoisted.fileOps.downloadFile as (...a: unknown[]) => unknown)(...args),
  deleteFile: (...args: unknown[]) => (hoisted.fileOps.deleteFile as (...a: unknown[]) => unknown)(...args),
  createFileBucket: (...args: unknown[]) => (hoisted.fileOps.createFileBucket as (...a: unknown[]) => unknown)(...args),
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
import {
  createConversation,
  deleteConversation,
  executeAgentChatLocal,
  executePlaygroundChatLocal,
} from '@/lib/services/agents/agentService';
import { classifyAgentRunError } from '@/lib/services/agents/agentErrors';
import {
  CONVERSATION_FILES_BUCKET_KEY,
  cleanupExpiredSessionFiles,
  deleteSessionFile,
  listSessionFiles,
  uploadSessionFile,
} from '@/lib/services/agents/sessionFiles';
import { destroyCache } from '@/lib/core/cache';

const DB_NAME = 'tenant_files';
const PROJECT_ID = 'proj-1';
const AGENT_KEY = 'doc-agent';
const OWNER = 'user-1';

type Reply = Record<string, unknown>;
type Seen = Array<{ role: string; content: unknown }>;

const usage = { input_tokens: 100, output_tokens: 20, total_tokens: 120 };
const answer = (text = 'done'): Reply => ({ role: 'assistant', content: text, usage_metadata: usage });
const toolCall = (name: string, args: Record<string, unknown>): Reply => ({
  role: 'assistant',
  content: '',
  tool_calls: [{ id: `call-${name}-${JSON.stringify(args)}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
  usage_metadata: usage,
});

/** A chat model that replies from a script and remembers the messages and tools it was shown. */
class ScriptedModel {
  readonly modelName = 'scripted-model';
  seen: Seen[] = [];
  toolNames: string[] = [];
  constructor(private readonly script: (call: number, messages: Seen) => Reply) {}
  bindTools(tools: Array<{ name?: string; function?: { name?: string } }>) {
    this.toolNames = tools.map((tool) => tool.name ?? tool.function?.name ?? '');
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
  hoisted.buildModelRuntime.mockResolvedValue({ runtime: { createChatModel: () => model } });
  return model;
}

function setModel(extra: Record<string, unknown> = {}) {
  hoisted.getModelByKey.mockResolvedValue({
    key: 'gpt-4o', name: 'GPT-4o', category: 'llm', providerKey: 'openai', providerDriver: 'openai',
    modelId: 'gpt-4o', tenantId, projectId: PROJECT_ID, settings: {}, pricing: { inputTokenPer1M: 1, outputTokenPer1M: 1, currency: 'USD' },
    ...extra,
  });
}

async function createAgent(config: Partial<IAgentConfig> = {}) {
  await db.createAgent({
    tenantId, projectId: PROJECT_ID, key: AGENT_KEY, name: 'Docs', config: { modelKey: 'gpt-4o', ...config },
    status: 'active', createdBy: OWNER,
  });
  return (await db.findAgentByKey(AGENT_KEY, PROJECT_ID))!;
}

async function newConversation(): Promise<IAgentConversation> {
  return db.createAgentConversation({
    tenantId, projectId: PROJECT_ID, agentKey: AGENT_KEY, title: 'New conversation', messages: [],
    metadata: { source: 'console' }, createdBy: OWNER,
  });
}

const scope = () => ({ tenantDbName: DB_NAME, tenantId, projectId: PROJECT_ID });

async function attach(conversation: IAgentConversation, name: string, data: string | Buffer, contentType: string, config?: IAgentConfig) {
  const agent = await db.findAgentByKey(AGENT_KEY, PROJECT_ID);
  return uploadSessionFile({
    scope: scope(),
    conversation,
    agentConfig: config ?? agent!.config,
    fileName: name,
    contentType,
    data: Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8'),
    actor: { userId: OWNER, licenseType: 'FREE' },
  });
}

const chat = (conversationId: string, userMessage: string, attachments?: string[]) => executeAgentChatLocal({
  tenantDbName: DB_NAME, tenantId, projectId: PROJECT_ID, agentKey: AGENT_KEY, conversationId, userMessage, userId: OWNER,
  ...(attachments ? { attachments } : {}),
});

const stored = async (id: string) => (await db.findAgentConversationById(id))!;
const userTurn = (messages: Seen) => messages.filter((m) => m.role === 'user').at(-1)!;
const textOf = (content: unknown) => (typeof content === 'string'
  ? content
  : (content as Array<{ type: string; text?: string }>).filter((p) => p.type === 'text').map((p) => p.text).join('\n'));

beforeEach(async () => {
  vi.clearAllMocks();
  await destroyCache();
  tmpDir = mkdtempSync(path.join(tmpdir(), 'agent-files-'));
  db = new SQLiteProvider(tmpDir, 'test_main');
  await db.connect();
  hoisted.getDatabase.mockResolvedValue(db);
  hoisted.db.current = db;
  (getDatabase as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(db);
  const tenant = await db.createTenant({
    companyName: 'Acme', slug: 'acme-files', dbName: DB_NAME, licenseType: 'FREE', ownerId: 'owner-1',
  });
  tenantId = String(tenant._id);
  await db.switchToTenant(DB_NAME);
  setModel();
  hoisted.publish.mockResolvedValue(undefined);
  hoisted.getUserAuthState.mockResolvedValue('active');
  hoisted.recordAuditLog.mockResolvedValue(undefined);
  reloadConfig();

  // The object store: a blob map, with the file records in the real database.
  hoisted.blobs.clear();
  keySeq = 0;
  hoisted.fileOps.uploadFile = (async (_db: string, tId: string, pId: string, request: {
    bucketKey: string; fileName: string; contentType?: string; data: Buffer; createdBy: string;
    convertToMarkdown?: boolean; recordExtras?: Partial<IFileRecord>;
  }) => {
    keySeq += 1;
    const key = `obj-${keySeq}`;
    hoisted.blobs.set(`${request.bucketKey}/${key}`, request.data);
    const isText = request.contentType?.startsWith('text/') ?? false;
    const converted = request.convertToMarkdown !== false;
    if (converted && isText) hoisted.blobs.set(`${request.bucketKey}/${key}.md`, request.data);
    const record = await db.createFileRecord({
      tenantId: tId, projectId: pId, providerKey: 'builtin-files', bucketKey: request.bucketKey, key,
      name: request.fileName, size: request.data.length, contentType: request.contentType,
      markdownStatus: !converted ? 'skipped' : isText ? 'succeeded' : 'failed',
      ...(converted && isText ? { markdownKey: `${key}.md`, markdownSize: request.data.length } : {}),
      ...(request.recordExtras ?? {}),
      createdBy: request.createdBy,
    });
    return { record: { ...record, id: String(record._id) } };
  }) as never;
  hoisted.fileOps.downloadFile = (async (_db: string, _t: string, _p: string, bucketKey: string, key: string, options?: { variant?: string }) => {
    const blob = hoisted.blobs.get(`${bucketKey}/${options?.variant === 'markdown' ? `${key}.md` : key}`);
    if (!blob) throw new Error('File record not found.');
    return { fileName: key, data: blob };
  }) as never;
  hoisted.fileOps.deleteFile = (async (_db: string, _t: string, _p: string, bucketKey: string, key: string) => {
    hoisted.blobs.delete(`${bucketKey}/${key}`);
    hoisted.blobs.delete(`${bucketKey}/${key}.md`);
    const record = await db.findFileRecordByKey('builtin-files', bucketKey, key, PROJECT_ID);
    return record ? db.deleteFileRecord(String(record._id)) : false;
  }) as never;
  hoisted.fileOps.createFileBucket = (async (_db: string, tId: string, pId: string, input: { key: string; name: string; providerKey: string; createdBy: string }) => {
    return db.createFileBucket({ tenantId: tId, projectId: pId, status: 'active', ...input });
  }) as never;
});

afterEach(async () => {
  reloadConfig();
  await db.disconnect();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('uploading to a session', () => {
  it('stores the file in the system conversation-files bucket, tagged with its session and an expiry', async () => {
    await createAgent({ attachments: { retentionDays: 7 } });
    const conversation = await newConversation();

    const view = await attach(conversation, 'notes.txt', 'hello notes', 'text/plain');

    expect(view).toMatchObject({ name: 'notes.txt', mimeType: 'text/plain', size: 11, conversionStatus: 'succeeded' });
    const [record] = await db.listFileRecordsByConversation(String(conversation._id));
    expect(record).toMatchObject({
      bucketKey: CONVERSATION_FILES_BUCKET_KEY, purpose: 'conversation', conversationId: String(conversation._id),
      agentKey: AGENT_KEY, uploadedBy: OWNER, projectId: PROJECT_ID,
    });
    // retentionDays is the agent's own setting.
    expect(record.expiresAt!.getTime() - Date.now()).toBeGreaterThan(6.9 * 86_400_000);
    expect(record.expiresAt!.getTime() - Date.now()).toBeLessThan(7.1 * 86_400_000);
    // The bucket was created on first use, on the built-in provider.
    expect(await db.findFileBucketByKey(tenantId, CONVERSATION_FILES_BUCKET_KEY, PROJECT_ID)).toMatchObject({ providerKey: 'builtin-files' });
    expect((await listSessionFiles(scope(), String(conversation._id))).map((f) => f.name)).toEqual(['notes.txt']);
  });

  it('uses the bucket the agent names instead of the system one', async () => {
    await createAgent({ attachments: { bucketKey: 'my-bucket' } });
    const conversation = await newConversation();
    await attach(conversation, 'a.txt', 'a', 'text/plain');
    const [record] = await db.listFileRecordsByConversation(String(conversation._id));
    expect(record.bucketKey).toBe('my-bucket');
    expect(await db.findFileBucketByKey(tenantId, CONVERSATION_FILES_BUCKET_KEY, PROJECT_ID)).toBeNull();
  });

  it('refuses by the agent’s own limits: size, count, type, empty and switched off', async () => {
    await createAgent({ attachments: { maxFileSizeMb: 0.001, maxFiles: 2, allowedMimeTypes: ['text/plain', 'image/*'] } });
    const conversation = await newConversation();
    const refusal = async (name: string, data: string | Buffer, type: string) => classifyAgentRunError(
      await attach(conversation, name, data, type).catch((error) => error),
    );

    expect(await refusal('big.txt', 'x'.repeat(2000), 'text/plain')).toMatchObject({ status: 413, error: { code: 'file_too_large' } });
    expect(await refusal('doc.pdf', 'pdf', 'application/pdf')).toMatchObject({ status: 415, error: { code: 'unsupported_file_type' } });
    expect(await refusal('empty.txt', '', 'text/plain')).toMatchObject({ status: 400, error: { code: 'empty_file' } });

    await attach(conversation, 'one.txt', 'one', 'text/plain');
    await attach(conversation, 'pic.png', Buffer.from([1, 2, 3]), 'image/png'); // image/* wildcard
    expect(await refusal('three.txt', 'three', 'text/plain')).toMatchObject({ status: 409, error: { code: 'too_many_files' } });

    const off = await createAgentWithKey('off-agent', { attachments: { enabled: false } });
    expect(classifyAgentRunError(
      await uploadSessionFile({ scope: scope(), conversation, agentConfig: off.config, fileName: 'a.txt', contentType: 'text/plain', data: Buffer.from('a'), actor: { userId: OWNER, licenseType: 'FREE' } }).catch((e) => e),
    )).toMatchObject({ status: 403, error: { code: 'attachments_disabled' } });
  });

  it('guesses the type from the file name when the upload says octet-stream', async () => {
    await createAgent();
    const conversation = await newConversation();
    const view = await attach(conversation, 'data.csv', 'a,b\n1,2', 'application/octet-stream');
    expect(view.mimeType).toBe('text/csv');
  });

  it('deletes a file of the session, and only of that session', async () => {
    await createAgent();
    const a = await newConversation();
    const b = await newConversation();
    const file = await attach(a, 'a.txt', 'a', 'text/plain');

    expect(await deleteSessionFile(scope(), String(b._id), file.id, OWNER)).toBe(false);
    expect(await listSessionFiles(scope(), String(a._id))).toHaveLength(1);
    expect(await deleteSessionFile(scope(), String(a._id), file.id, OWNER)).toBe(true);
    expect(await listSessionFiles(scope(), String(a._id))).toHaveLength(0);
    expect(hoisted.blobs.size).toBe(0);
  });
});

async function createAgentWithKey(key: string, config: Partial<IAgentConfig>) {
  const created = await db.createAgent({
    tenantId, projectId: PROJECT_ID, key, name: key, config: { modelKey: 'gpt-4o', ...config }, status: 'active', createdBy: OWNER,
  });
  return created;
}

describe('a turn with attachments', () => {
  it('puts a document that fits inline, keeps the person’s own text in the transcript, and records the attachment', async () => {
    await createAgent();
    const model = scriptModel(() => answer('It says hello.'));
    const conversation = await newConversation();
    const id = String(conversation._id);
    const file = await attach(conversation, 'notes "q1".txt', 'Quarterly notes: revenue up.', 'text/plain');

    const response = await chat(id, 'What do the notes say?', [file.id]);

    expect(response.status).toBe('completed');
    const shown = userTurn(model.seen[0]);
    expect(typeof shown.content).toBe('string');
    expect(shown.content).toContain('What do the notes say?');
    expect(shown.content).toContain(`<document name="notes &quot;q1&quot;.txt" id="${file.id}">`);
    expect(shown.content).toContain('Quarterly notes: revenue up.');
    // Inline: nothing to page through, but the tools exist once the session holds a file.
    expect(shown.content).not.toContain('too long to include');
    expect(model.toolNames).toEqual(expect.arrayContaining(['session_files_list', 'session_files_read']));

    const after = await stored(id);
    // The transcript holds what the person typed — not the document.
    expect(after.messages[0]).toMatchObject({
      role: 'user',
      content: 'What do the notes say?',
      attachments: [{ fileId: file.id, name: 'notes "q1".txt', mimeType: 'text/plain', size: 28 }],
    });
    expect(after.messages[0].content).not.toContain('Quarterly');
    expect(after.title).toBe('What do the notes say?');
  });

  it('keeps the document in the agent’s state, so the next turn still has it', async () => {
    await createAgent();
    const model = scriptModel(() => answer());
    const conversation = await newConversation();
    const id = String(conversation._id);
    const file = await attach(conversation, 'a.txt', 'secret-number-4711', 'text/plain');
    await chat(id, 'remember this', [file.id]);
    await chat(id, 'what was the number?');

    expect(JSON.stringify(model.seen[1])).toContain('secret-number-4711');
    // The second message attached nothing.
    expect((await stored(id)).messages[2]).not.toHaveProperty('attachments');
  });

  it('points a long document at the paging tools, and the agent reads it page by page', async () => {
    await createAgent({ attachments: { inlineMaxTokens: 100, readPageChars: 500 } });
    const conversation = await newConversation();
    const id = String(conversation._id);
    const body = Array.from({ length: 40 }, (_, i) => `Line ${String(i).padStart(2, '0')} of the long report.`).join('\n'); // ~1.4k chars
    const file = await attach(conversation, 'report.txt', body, 'text/plain');
    const pages = Math.ceil(body.length / 500);
    expect(pages).toBeGreaterThan(2);

    const model = scriptModel((call, messages) => {
      if (call === 0) return toolCall('session_files_read', { fileId: file.id, page: 2 });
      if (call === 1) return toolCall('session_files_read', { fileId: file.id, page: pages + 5 });
      return answer(`read: ${JSON.stringify(messages.filter((m) => m.role === 'tool').map((m) => m.content))}`);
    });

    const response = await chat(id, 'Summarise the report', [file.id]);

    const shown = userTurn(model.seen[0]).content as string;
    expect(shown).toContain('too long to include');
    expect(shown).toContain(`id ${file.id}, ${pages} pages`);
    expect(shown).not.toContain('Line 05');
    expect(model.toolNames).toEqual(expect.arrayContaining(['session_files_list', 'session_files_read']));

    const toolResults = model.seen[2].filter((m) => m.role === 'tool').map((m) => String(m.content));
    const page2 = JSON.parse(toolResults[0]) as { text: string; page: number; pages: number };
    expect(page2).toEqual({ text: body.slice(500, 1000), page: 2, pages });
    expect(JSON.parse(toolResults[1])).toEqual({ error: `Page ${pages + 5} is out of range.`, pages });
    expect(response.status).toBe('completed');
    // The persisted user message is still only the typed text.
    expect((await stored(id)).messages[0].content).toBe('Summarise the report');
  });

  it('session_files_list shows the session’s files to a later turn that attaches nothing', async () => {
    await createAgent();
    const conversation = await newConversation();
    const id = String(conversation._id);
    const file = await attach(conversation, 'old.txt', 'old text', 'text/plain');
    const model = scriptModel((call, messages) => (call === 0
      ? toolCall('session_files_list', {})
      : answer(String(messages.filter((m) => m.role === 'tool').at(-1)?.content))));

    const response = await chat(id, 'which files do I have?');

    const listed = JSON.parse(String(model.seen[1].filter((m) => m.role === 'tool').at(-1)?.content)) as Array<Record<string, unknown>>;
    expect(listed).toEqual([{ fileId: file.id, name: 'old.txt', mimeType: 'text/plain', size: 8, readable: true }]);
    expect(response.status).toBe('completed');
  });

  it('refuses an attachment that is not a file of this session — another session’s, or an unknown id', async () => {
    await createAgent();
    const mine = await newConversation();
    const other = await newConversation();
    const foreign = await attach(other, 'theirs.txt', 'x', 'text/plain');
    const model = scriptModel(() => answer());

    const stolen = await chat(String(mine._id), 'use it', [foreign.id]).catch((e) => e);
    expect(classifyAgentRunError(stolen)).toMatchObject({ status: 404, error: { code: 'attachment_not_found' } });
    const unknown = await chat(String(mine._id), 'use it', ['nope']).catch((e) => e);
    expect(classifyAgentRunError(unknown)).toMatchObject({ status: 404, error: { code: 'attachment_not_found' } });
    // Refused before anything ran: no model call, nothing written to the session.
    expect(model.seen).toHaveLength(0);
    expect((await stored(String(mine._id))).messages).toHaveLength(0);
  });

  it('refuses attachments for an agent that does not take them', async () => {
    await createAgent({ attachments: { enabled: false } });
    const conversation = await newConversation();
    scriptModel(() => answer());
    const refused = await chat(String(conversation._id), 'hi', ['whatever']).catch((e) => e);
    expect(classifyAgentRunError(refused)).toMatchObject({ status: 403, error: { code: 'attachments_disabled' } });
  });

  it('is the same on the dashboard (playground) path', async () => {
    await createAgent();
    const model = scriptModel(() => answer('ok'));
    const conversation = await newConversation();
    const id = String(conversation._id);
    const file = await attach(conversation, 'p.txt', 'playground text', 'text/plain');

    await executePlaygroundChatLocal({
      tenantDbName: DB_NAME, tenantId, projectId: PROJECT_ID, agentKey: AGENT_KEY, conversationId: id,
      userMessage: 'read it', attachments: [file.id],
    });

    expect(userTurn(model.seen[0]).content).toContain('playground text');
    expect((await stored(id)).messages[0]).toMatchObject({
      role: 'user', content: 'read it', attachments: [{ fileId: file.id, name: 'p.txt' }],
    });
    // A stateless playground call has no session to hold files.
    const stateless = await executePlaygroundChatLocal({
      tenantDbName: DB_NAME, tenantId, projectId: PROJECT_ID, agentKey: AGENT_KEY, userMessage: 'x', attachments: [file.id],
    }).catch((e) => e);
    expect(classifyAgentRunError(stateless)).toMatchObject({ status: 400, error: { code: 'attachment_not_found' } });
  });
});

describe('images', () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);

  it('become image parts when the model accepts images', async () => {
    setModel({ isMultimodal: true });
    await createAgent();
    const model = scriptModel(() => answer('a cat'));
    const conversation = await newConversation();
    const id = String(conversation._id);
    const file = await attach(conversation, 'cat.png', png, 'image/png');
    expect(file.conversionStatus).toBe('skipped'); // an image is read as it is, not converted

    await chat(id, 'what is this?', [file.id]);

    const content = userTurn(model.seen[0]).content as Array<Record<string, unknown>>;
    expect(Array.isArray(content)).toBe(true);
    expect(content[0]).toMatchObject({ type: 'text' });
    expect(textOf(content)).toContain('what is this?');
    // The provider adapter turns the SDK's `{ base64, media_type }` into the wire data URL.
    const image = content.find((part) => part.type === 'image_url') as { image_url: { url: string } };
    expect(image.image_url.url).toBe(`data:image/png;base64,${png.toString('base64')}`);
    // The transcript holds neither the bytes nor any note.
    expect((await stored(id)).messages[0]).toMatchObject({ content: 'what is this?', attachments: [{ name: 'cat.png', mimeType: 'image/png' }] });
  });

  it('become a text note when the model cannot read images', async () => {
    setModel({ isMultimodal: false });
    await createAgent();
    const model = scriptModel(() => answer('cannot see'));
    const conversation = await newConversation();
    const file = await attach(conversation, 'cat.png', png, 'image/png');

    await chat(String(conversation._id), 'what is this?', [file.id]);

    const content = userTurn(model.seen[0]).content;
    expect(typeof content).toBe('string');
    expect(content).toContain('cannot read images');
    expect(content).toContain('cat.png');
    expect(JSON.stringify(model.seen[0])).not.toContain('image_url');
  });
});

describe('back-compat: no attachments', () => {
  it('shows the model the plain message, offers no file tools, and writes no attachments field', async () => {
    await createAgent();
    const model = scriptModel(() => answer('hi'));
    const conversation = await newConversation();
    const id = String(conversation._id);

    const response = await chat(id, 'hello there');

    expect(response.status).toBe('completed');
    expect(userTurn(model.seen[0]).content).toBe('hello there');
    expect(model.toolNames.filter((name) => name.startsWith('session_files'))).toEqual([]);
    const after = await stored(id);
    expect(after.messages[0]).not.toHaveProperty('attachments');
    expect(after.messages[0].content).toBe('hello there');
  });

  it('an agent saved before attachments existed accepts them with the defaults', async () => {
    const agent = await createAgent();
    expect(agent.config.attachments).toBeUndefined();
    const conversation = await newConversation();
    await expect(attach(conversation, 'a.txt', 'a', 'text/plain')).resolves.toMatchObject({ name: 'a.txt' });
  });
});

describe('approvals do not gate reading a file', () => {
  it('session_files_read runs without pausing even when every tool needs approval', async () => {
    await createAgent({
      humanInTheLoop: { toolApproval: { enabled: true, defaultPolicy: 'always' } },
      attachments: { inlineMaxTokens: 100, readPageChars: 500 },
    });
    const conversation = await newConversation();
    const file = await attach(conversation, 'big.txt', 'word '.repeat(400), 'text/plain');
    scriptModel((call) => (call === 0 ? toolCall('session_files_read', { fileId: file.id }) : answer('read it')));

    const response = await chat(String(conversation._id), 'read the file', [file.id]);

    expect(response.status).toBe('completed');
    expect(await db.listAgentPendingActions?.(String(conversation._id)) ?? []).toHaveLength(0);
  });
});

describe('retention and deletion', () => {
  it('the cleanup deletes expired session files (object, markdown and row) and leaves the rest', async () => {
    await createAgent();
    const conversation = await newConversation();
    const expired = await attach(conversation, 'old.txt', 'old', 'text/plain');
    const kept = await attach(conversation, 'new.txt', 'new', 'text/plain');
    await db.updateFileRecord(expired.id, { expiresAt: new Date(Date.now() - 1000) });

    const deleted = await cleanupExpiredSessionFiles(db, DB_NAME, new Date());

    expect(deleted).toBe(1);
    expect((await listSessionFiles(scope(), String(conversation._id))).map((f) => f.id)).toEqual([kept.id]);
    // old.txt's object and its markdown are gone; new.txt's remain.
    expect([...hoisted.blobs.keys()].sort()).toEqual([`${CONVERSATION_FILES_BUCKET_KEY}/obj-2`, `${CONVERSATION_FILES_BUCKET_KEY}/obj-2.md`]);
  });

  it('keeps going past a file that cannot be deleted, and tries it again next time', async () => {
    await createAgent();
    const conversation = await newConversation();
    const stuck = await attach(conversation, 'stuck.txt', 's', 'text/plain');
    const fine = await attach(conversation, 'fine.txt', 'f', 'text/plain');
    await db.updateFileRecord(stuck.id, { expiresAt: new Date(Date.now() - 2000) });
    await db.updateFileRecord(fine.id, { expiresAt: new Date(Date.now() - 1000) });
    const realDelete = hoisted.fileOps.deleteFile;
    let failOnce = true;
    hoisted.fileOps.deleteFile = (async (...args: never[]) => {
      if (failOnce) { failOnce = false; throw new Error('storage unavailable'); }
      return (realDelete as (...a: never[]) => unknown)(...args);
    }) as never;

    expect(await cleanupExpiredSessionFiles(db, DB_NAME, new Date(), { maxBatches: 1 })).toBe(1);
    expect((await listSessionFiles(scope(), String(conversation._id))).map((f) => f.id)).toEqual([stuck.id]);
    expect(await cleanupExpiredSessionFiles(db, DB_NAME, new Date())).toBe(1);
    expect(await listSessionFiles(scope(), String(conversation._id))).toHaveLength(0);
  });

  it('deleting the conversation deletes its files', async () => {
    await createAgent();
    const kept = await newConversation();
    const gone = await newConversation();
    await attach(kept, 'keep.txt', 'k', 'text/plain');
    await attach(gone, 'drop.txt', 'd', 'text/plain');
    await attach(gone, 'drop.png', Buffer.from([1]), 'image/png');

    expect(await deleteConversation(DB_NAME, String(gone._id))).toBe(true);

    expect(await db.listFileRecordsByConversation(String(gone._id))).toHaveLength(0);
    expect(await db.listFileRecordsByConversation(String(kept._id))).toHaveLength(1);
    expect([...hoisted.blobs.keys()].every((key) => key.startsWith(`${CONVERSATION_FILES_BUCKET_KEY}/obj-1`))).toBe(true);
  });

  it('createConversation + upload round trip works for a fresh session id', async () => {
    await createAgent();
    const created = await createConversation(DB_NAME, tenantId, PROJECT_ID, OWNER, AGENT_KEY);
    await expect(attach(created, 'x.txt', 'x', 'text/plain')).resolves.toMatchObject({ name: 'x.txt' });
  });
});
