/**
 * Tool media — end to end.
 *
 * A tool that returns a `ToolOutput` with an image: the model sees the image in
 * the NEXT request (a user message after the tool results — a tool message is
 * text on every provider's wire), the tool message itself carries no base64, and
 * what is not shown is said. A REAL SQLite provider, the REAL agent-sdk loop and
 * the REAL `read` tool over the session's files, driven by a scripted chat model
 * that remembers what it was shown. Faked at the boundary only (as
 * agent-session-files.test.ts does): the object store, the model lookup, the
 * queue and the audit write; and the sandbox module, which here just hands the
 * run a screenshot tool.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { z } from 'zod';
import { createTool } from '@cognipeer/agent-sdk';
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
  sandboxTools: [] as unknown[],
}));

vi.mock('@/lib/services/users/userAuthState', () => ({ getUserAuthState: hoisted.getUserAuthState }));
vi.mock('@/lib/core/queue', () => ({ getQueue: vi.fn(async () => ({ publish: hoisted.publish })) }));
vi.mock('@/lib/services/audit/auditService', () => ({ recordAuditLog: hoisted.recordAuditLog }));
vi.mock('@/lib/services/models/modelService', () => ({ getModelByKey: hoisted.getModelByKey }));
vi.mock('@/lib/services/agents/gatewayChatModel', () => ({ buildGatewayChatModel: hoisted.buildGatewayChatModel, isDynamicModel: () => false, }));
vi.mock('@/lib/services/agents/agentSandboxTools', () => ({
  buildAgentSandboxTools: vi.fn(async () => ({ tools: hoisted.sandboxTools, definitions: [], cleanup: async () => undefined, collectOutputs: async () => ({ attachments: [], warnings: [] }), promptNote: '' })),
  destroyConversationSandbox: vi.fn(),
  resolveSandboxAvailability: vi.fn(),
}));
vi.mock('@/lib/services/files', () => ({
  uploadFile: (...args: unknown[]) => (hoisted.fileOps.uploadFile as (...a: unknown[]) => unknown)(...args),
  downloadFile: (...args: unknown[]) => (hoisted.fileOps.downloadFile as (...a: unknown[]) => unknown)(...args),
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
import { decodeStoredState } from '@/lib/services/agents/agentTurnState';
import { destroyCache } from '@/lib/core/cache';
import { toolOutput } from '@/lib/services/tools/toolOutput';

const DB_NAME = 'tenant_files';
const PROJECT_ID = 'proj-1';
// Files live in a bucket the agent names; the tests configure one explicitly, as an operator would.
const BUCKET = 'test-bucket';
const PROVIDER = 'test-files';
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

/**
 * What a provider puts on the wire for the SDK's `{ type: 'image', source: { base64 } }` part: an
 * `image_url` data URL. The model below remembers messages in that form, as a provider would send them.
 */
function asWire(messages: Seen): Seen {
  return messages.map((message) => {
    if (!Array.isArray(message.content)) return message;
    return {
      ...message,
      content: (message.content as Array<Record<string, any>>).map((part) => (
        part.type === 'image' && part.source?.type === 'base64'
          ? { type: 'image_url', image_url: { url: `data:${part.source.mediaType};base64,${part.source.data}` } }
          : part
      )),
    };
  }) as Seen;
}

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
    this.seen.push(asWire(messages));
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

function setModel(extra: Record<string, unknown> = {}) {
  hoisted.getModelByKey.mockResolvedValue({
    key: 'gpt-4o', name: 'GPT-4o', category: 'llm', providerKey: 'openai', providerDriver: 'openai',
    modelId: 'gpt-4o', tenantId, projectId: PROJECT_ID, settings: {}, pricing: { inputTokenPer1M: 1, outputTokenPer1M: 1, currency: 'USD' },
    ...extra,
  });
}

/** An agent that takes files: switched on, with the test bucket, plus whatever the test overrides. */
const withFiles = (config: Partial<IAgentConfig> = {}): Partial<IAgentConfig> => ({
  ...config,
  attachments: { enabled: true, bucketKey: BUCKET, ...config.attachments },
});

async function createAgent(config: Partial<IAgentConfig> = {}) {
  await db.createAgent({
    tenantId, projectId: PROJECT_ID, key: AGENT_KEY, name: 'Docs', // These tests are about what a tool's output does, not about approval: the agent runs its tools unasked.
    config: { modelKey: 'gpt-4o', humanInTheLoop: { toolApproval: { enabled: false } }, ...withFiles(config) },
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
  // The storage a project has to set up: a file provider and a bucket on it.
  await db.createProvider({
    tenantId, projectId: PROJECT_ID, key: PROVIDER, type: 'file', driver: 'local-filesystem', label: 'Test disk',
    status: 'active', credentialsEnc: '', settings: {}, createdBy: OWNER,
  });
  await db.createFileBucket({ tenantId, projectId: PROJECT_ID, key: BUCKET, name: 'Test bucket', providerKey: PROVIDER, status: 'active', createdBy: OWNER });
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
    convertToMarkdown?: boolean; keyHint?: string; recordExtras?: Partial<IFileRecord>;
  }) => {
    keySeq += 1;
    const key = request.keyHint ?? `obj-${keySeq}`;
    hoisted.blobs.set(`${request.bucketKey}/${key}`, request.data);
    const isText = request.contentType?.startsWith('text/') ?? false;
    const converted = request.convertToMarkdown !== false;
    if (converted && isText) hoisted.blobs.set(`${request.bucketKey}/${key}.md`, request.data);
    const record = await db.createFileRecord({
      tenantId: tId, projectId: pId, providerKey: PROVIDER, bucketKey: request.bucketKey, key,
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
    const record = await db.findFileRecordByKey(PROVIDER, bucketKey, key, PROJECT_ID);
    return record ? db.deleteFileRecord(String(record._id)) : false;
  }) as never;
});

afterEach(async () => {
  reloadConfig();
  await db.disconnect();
  rmSync(tmpDir, { recursive: true, force: true });
});

/** Distinct bytes behind a PNG signature, so a base64 copy cannot hide in a repeated pattern. */
const photo = (bytes = 4096) => {
  // Signature + a real IHDR (800x600): the adapter reads the dimensions off the bytes.
  const head = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(head);
  head.writeUInt32BE(13, 8);
  head.write('IHDR', 12, 'ascii');
  head.writeUInt32BE(800, 16);
  head.writeUInt32BE(600, 20);
  return Buffer.concat([head, Buffer.from(Array.from({ length: bytes }, (_, i) => (i * 31 + 7) % 251))]);
};
const b64 = (buffer: Buffer) => buffer.toString('base64');
const dataUrl = (buffer: Buffer, mime = 'image/png') => `data:${mime};base64,${b64(buffer)}`;
type Part = { type: string; text?: string; image_url?: { url?: string } };
const partsOf = (message: { content: unknown }) => (Array.isArray(message.content) ? message.content as Part[] : []);
const imageUrls = (messages: Seen) => messages.flatMap((m) => partsOf(m))
  .filter((part) => part.type === 'image_url').map((part) => part.image_url?.url);
const toolMessages = (messages: Seen) => messages.filter((m) => m.role === 'tool').map((m) => String(m.content));
const snapshotOf = async (id: string) => decodeStoredState((await db.findAgentConversationState(id))!.snapshot);

/** A tool that returns a screenshot the way the browser tools do: text, an image block, structured data. */
function screenshotTool(image: Buffer, name = 'screenshot') {
  return createTool({
    name,
    description: 'Take a screenshot',
    schema: z.object({ url: z.string().optional() }),
    func: async () => toolOutput(
      [
        { type: 'text', text: 'Screenshot of https://app.test (800x600)' },
        { type: 'image', data: b64(image), mimeType: 'image/png', name: 'screenshot.png', width: 800, height: 600 },
      ],
      { structuredContent: { url: 'https://app.test', width: 800, height: 600 } },
    ),
  });
}

async function vision(config: Partial<IAgentConfig> = {}, model: Record<string, unknown> = {}) {
  setModel({ isMultimodal: true, ...model });
  await createAgent(config);
}

describe('a tool that returns an image', () => {
  it('shows it to the model in the next request, after the tool result, without base64 in the tool message', async () => {
    await vision();
    const image = photo();
    hoisted.sandboxTools = [screenshotTool(image)];
    const model = scriptModel((call, messages) => (call === 0
      ? toolCall('screenshot', { url: 'https://app.test' })
      : answer(`I see it: ${toolMessages(messages).length} result`)));
    const conversation = await newConversation();
    const id = String(conversation._id);

    const response = await chat(id, 'what does the page look like?');

    expect(response.status).toBe('completed');
    const second = model.seen[1];
    expect(second.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'tool', 'user']);
    // The tool message names the image; the bytes are not in it.
    const [result] = toolMessages(second);
    const parsed = JSON.parse(result) as { ok: boolean; text: string; attachedImages: Array<{ fileId: string; name: string; mimeType: string; width: number; height: number }>; note: string };
    expect(parsed).toMatchObject({ ok: true, text: 'Screenshot of https://app.test (800x600)', note: 'The image is shown to you in the next message.' });
    expect(parsed.attachedImages).toHaveLength(1);
    expect(parsed.attachedImages[0]).toMatchObject({ name: 'screenshot.png', mimeType: 'image/png', width: 800, height: 600 });
    expect(parsed.attachedImages[0].fileId).toMatch(/^tm_1_[0-9a-f]{6}$/);
    expect(result).not.toContain(b64(image).slice(0, 64));
    // The model's request carries the picture in the user message after the results.
    const shown = second[4];
    expect(partsOf(shown).map((part) => part.type)).toEqual(['text', 'text', 'image_url']);
    expect(partsOf(shown)[0].text).toBe('Here is the image you asked to look at.');
    expect(partsOf(shown)[1].text).toBe(`[Image you asked to see: "screenshot.png" (id ${parsed.attachedImages[0].fileId})]`);
    expect(imageUrls(second)).toEqual([dataUrl(image)]);
    // The first request had no picture, and nothing of it is saved: not in the state, not in the transcript.
    expect(imageUrls(model.seen[0])).toEqual([]);
    expect(await snapshotOf(id)).not.toContain(b64(image).slice(0, 64));
    expect(JSON.stringify((await db.findAgentConversationById(id))!.messages)).not.toContain(b64(image).slice(0, 64));
  });

  it('is gone in a later turn (tool images are working material of one run), without noise', async () => {
    await vision();
    hoisted.sandboxTools = [screenshotTool(photo())];
    const model = scriptModel((call) => (call === 0 ? toolCall('screenshot', {}) : answer('ok')));
    const conversation = await newConversation();
    const id = String(conversation._id);
    await chat(id, 'look');

    const later = scriptModel(() => answer('still there?'));
    await chat(id, 'and now?');

    expect(model.seen).toHaveLength(2);
    // The earlier tool message is still in the history; its image is not put back, and no placeholder says so.
    expect(imageUrls(later.seen[0])).toEqual([]);
    expect(JSON.stringify(later.seen[0])).not.toContain('no longer available');
    expect(JSON.stringify(later.seen[0])).not.toContain('Image you asked to see');
  });

  it('a model that cannot see images gets a note in the tool result and no picture', async () => {
    await vision({}, { isMultimodal: false, modelId: 'in-house-llm-7b' });
    hoisted.sandboxTools = [screenshotTool(photo())];
    const model = scriptModel((call) => (call === 0 ? toolCall('screenshot', {}) : answer('cannot see it')));
    const conversation = await newConversation();

    await chat(String(conversation._id), 'what does the page look like?');

    const second = model.seen[1];
    expect(second.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'tool']);
    const parsed = JSON.parse(toolMessages(second)[0]) as Record<string, unknown>;
    expect(parsed).toEqual({
      ok: true,
      text: 'Screenshot of https://app.test (800x600)',
      omitted: ['screenshot.png: this model cannot view images'],
    });
    expect(imageUrls(second)).toEqual([]);
  });

  it('works for a stateless run (no conversation) too', async () => {
    await vision();
    const image = photo(2048);
    hoisted.sandboxTools = [screenshotTool(image)];
    const model = scriptModel((call) => (call === 0 ? toolCall('screenshot', {}) : answer('seen')));

    await executePlaygroundChatLocal({
      tenantDbName: DB_NAME, tenantId, projectId: PROJECT_ID, agentKey: AGENT_KEY, userMessage: 'screenshot it',
    });

    expect(model.seen[1].map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'tool', 'user']);
    expect(imageUrls(model.seen[1])).toEqual([dataUrl(image)]);
    expect(toolMessages(model.seen[1])[0]).not.toContain(b64(image).slice(0, 64));
  });

  it('two screenshots in one assistant turn arrive together, once each, after both results', async () => {
    await vision();
    const first = photo(1000);
    const second = photo(1500);
    hoisted.sandboxTools = [screenshotTool(first, 'shot_a'), screenshotTool(second, 'shot_b')];
    const model = scriptModel((call) => (call === 0
      ? {
        role: 'assistant', content: '', usage_metadata: usage,
        tool_calls: [
          { id: 'ca', type: 'function', function: { name: 'shot_a', arguments: '{}' } },
          { id: 'cb', type: 'function', function: { name: 'shot_b', arguments: '{}' } },
        ],
      }
      : answer('both')));
    const conversation = await newConversation();

    await chat(String(conversation._id), 'two views');

    const request = model.seen[1];
    expect(request.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'tool', 'tool', 'user']);
    expect(partsOf(request[5])[0].text).toBe('Here are the images you asked to look at.');
    expect(imageUrls(request)).toEqual([dataUrl(first), dataUrl(second)]);
  });
});

describe('the read tool on a session image', () => {
  it('shows a conversation picture by file id, in a message after the result', async () => {
    await vision({ attachments: { maxImages: 1 } });
    const conversation = await newConversation();
    const id = String(conversation._id);
    const old = photo(2000);
    const cat = await attach(conversation, 'cat.png', old, 'image/png');
    const dog = await attach(conversation, 'dog.png', photo(3000), 'image/png');
    scriptModel(() => answer('seen the cat'));
    await chat(id, 'first', [cat.id]);

    // maxImages 1: the dog (newest) wins, the cat is a placeholder — until the agent reads it.
    const model = scriptModel((call) => (call === 0 ? toolCall('read', { fileId: cat.id }) : answer('looked')));
    await chat(id, 'now the dog', [dog.id]);

    expect(model.toolNames).toEqual(expect.arrayContaining(['session_files_list', 'read']));
    const second = model.seen[1];
    const toolAt = second.map((m) => m.role).lastIndexOf('tool');
    expect(second[toolAt + 1].role).toBe('user');
    const parsed = JSON.parse(toolMessages(second).at(-1)!) as { attachedImages: Array<{ fileId: string; name: string }> };
    expect(parsed.attachedImages).toEqual([{ fileId: cat.id, name: 'cat.png', mimeType: 'image/png' }]);
    expect(partsOf(second[toolAt + 1]).some((part) => part.text === `[Image you asked to see: "cat.png" (id ${cat.id})]`)).toBe(true);
    expect(imageUrls(second)).toContain(dataUrl(old));
    // Nothing of the synthetic message is saved.
    expect(await snapshotOf(id)).not.toContain('Image you asked to see');
  });

  it('shows a tool image again by its tm_ id within the run (the model decides per call)', async () => {
    await vision();
    const image = photo(2500);
    hoisted.sandboxTools = [screenshotTool(image)];
    const model = scriptModel((call, messages) => {
      if (call === 0) return toolCall('screenshot', {});
      if (call === 1) {
        const named = JSON.parse(toolMessages(messages).at(-1)!) as { attachedImages: Array<{ fileId: string }> };
        return toolCall('read', { fileId: named.attachedImages[0].fileId });
      }
      return answer('done');
    });
    const conversation = await newConversation();
    await attach(conversation, 'notes.txt', 'text', 'text/plain'); // the session holds a file, so `read` is offered

    await chat(String(conversation._id), 'screenshot, then look at it again');

    expect(model.toolNames).toContain('read');
    // Each run of tool results gets the picture it names (the first screenshot, then the read of it).
    const third = model.seen[2];
    expect(third.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'tool', 'user', 'assistant', 'tool', 'user']);
    expect(imageUrls(third)).toEqual([dataUrl(image), dataUrl(image)]);
    expect(toolMessages(third)).toHaveLength(2);
  });
});
