/**
 * Files an agent writes without a sandbox (`attachments.outputs`): the settings and their limits,
 * the file-name and MIME rules, the two tools (`session_files_create` / `session_files_append`)
 * with storage faked, the end-of-turn collection and the merge with the sandbox's, the prompt, the
 * approval exemption and the config checks.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

const hoisted = vi.hoisted(() => ({
  save: vi.fn(),
  append: vi.fn(),
  list: vi.fn(),
}));

vi.mock('@/lib/core/logger', () => ({
  createLogger: () => ({ info: vi.fn(), debug: vi.fn(), error: vi.fn(), warn: vi.fn() }),
}));
vi.mock('@/lib/services/agents/sessionFiles', () => ({
  saveAgentOutputFile: hoisted.save,
  appendAgentOutputFile: hoisted.append,
  listSessionFiles: hoisted.list,
}));

import type { IAgentMessageAttachment } from '@/lib/database';
import {
  buildFileOutputTools,
  fileOutputsPrompt,
  mergeOutputCollectors,
  parseOutputFileName,
  resolveOutputMime,
  uniqueOutputName,
} from '@/lib/services/agents/agentFileOutputTools';
import {
  FILE_OUTPUT_EXTENSIONS,
  outputsAvailability,
  resolveOutputsConfig,
} from '@/lib/services/agents/sessionFilesConfig';
import { AgentAttachmentError } from '@/lib/services/agents/agentErrors';
import { HITL_READ_ONLY_TOOLS, isReadOnlyTool, toolApprovalPolicy, resolveHitlConfig } from '@/lib/services/agents/agentHumanInTheLoop';
import { validateAgentConfigShape } from '@/lib/services/agents/agentConfigValidation';
import { patchOutputs, outputsEnabled } from '@/components/agents/studio/filesSettings';

describe('the settings', () => {
  it('have the documented limits, and by default follow the uploads: on with uploads and a bucket, off otherwise', () => {
    const limits = { maxFilesPerTurn: 10, maxFileSizeMb: 2 };
    expect(resolveOutputsConfig(undefined)).toEqual({ enabled: false, ...limits });
    expect(resolveOutputsConfig({ bucketKey: 'docs' })).toEqual({ enabled: false, ...limits });
    expect(resolveOutputsConfig({ enabled: true })).toEqual({ enabled: false, ...limits });
    expect(resolveOutputsConfig({ enabled: true, bucketKey: ' docs ' })).toEqual({ enabled: true, ...limits });
  });

  it('take a stored value over the default, and are held to the most the server allows', () => {
    expect(resolveOutputsConfig({ outputs: { maxFilesPerTurn: 5, maxFileSizeMb: 1.5 } })).toEqual({ enabled: false, maxFilesPerTurn: 5, maxFileSizeMb: 1.5 });
    expect(resolveOutputsConfig({ bucketKey: 'docs', outputs: { enabled: true } }).enabled).toBe(true);
    expect(resolveOutputsConfig({ enabled: true, bucketKey: 'docs', outputs: { enabled: false } }).enabled).toBe(false);
    expect(resolveOutputsConfig({ outputs: { enabled: false } }).enabled).toBe(false);
    expect(resolveOutputsConfig({ outputs: { maxFilesPerTurn: 500, maxFileSizeMb: 500 } })).toMatchObject({ maxFilesPerTurn: 20, maxFileSizeMb: 10 });
    expect(resolveOutputsConfig({ outputs: { maxFilesPerTurn: 0, maxFileSizeMb: -1 } })).toMatchObject({ maxFilesPerTurn: 10, maxFileSizeMb: 2 });
    expect(resolveOutputsConfig({ outputs: { maxFilesPerTurn: 2.9 } }).maxFilesPerTurn).toBe(2);
  });

  it('need a bucket and the switch, not the uploads; a connected agent never has them', () => {
    expect(outputsAvailability({ modelKey: 'm' }).available).toBe(false);
    expect(outputsAvailability({ modelKey: 'm', attachments: { enabled: true } }).available).toBe(false);
    // Uploads off, bucket named: off until switched on, then the agent can hand files back without uploads.
    expect(outputsAvailability({ modelKey: 'm', attachments: { bucketKey: 'docs' } }).available).toBe(false);
    expect(outputsAvailability({ modelKey: 'm', attachments: { bucketKey: ' docs ', outputs: { enabled: true } } })).toMatchObject({ available: true, cfg: { bucketKey: 'docs' } });
    expect(outputsAvailability({ modelKey: 'm', attachments: { outputs: { enabled: true } } }).available).toBe(false);
    // Uploads on with a bucket: on unless switched off.
    expect(outputsAvailability({ modelKey: 'm', attachments: { enabled: true, bucketKey: 'docs' } }).available).toBe(true);
    expect(outputsAvailability({ modelKey: 'm', attachments: { enabled: true, bucketKey: 'docs', outputs: { enabled: false } } }).available).toBe(false);
    expect(outputsAvailability({ modelKey: 'm', kind: 'external', connection: { url: 'https://x' }, attachments: { enabled: true, bucketKey: 'docs' } } as never).available).toBe(false);
    expect(outputsAvailability(undefined).available).toBe(false);
  });

  it('are checked when the config is saved', () => {
    const shape = (outputs: unknown) => validateAgentConfigShape({ modelKey: 'm', attachments: { bucketKey: 'docs', outputs } } as never);
    const fields = (outputs: unknown) => shape(outputs).errors.map((issue) => issue.field);
    expect(fields({ enabled: true, maxFilesPerTurn: 20, maxFileSizeMb: 10 })).toEqual([]);
    // Outputs switched on need a bucket even with uploads off.
    const noBucket = (attachments: unknown) => validateAgentConfigShape({ modelKey: 'm', attachments } as never).errors.map((issue) => issue.field);
    expect(noBucket({ outputs: { enabled: true } })).toEqual(['attachments.bucketKey']);
    expect(noBucket({ outputs: { enabled: false } })).toEqual([]);
    expect(noBucket({ bucketKey: 'docs', outputs: { enabled: true } })).toEqual([]);
    expect(fields({ maxFilesPerTurn: 21 })).toEqual(['attachments.outputs.maxFilesPerTurn']);
    expect(fields({ maxFilesPerTurn: 0 })).toEqual(['attachments.outputs.maxFilesPerTurn']);
    expect(fields({ maxFilesPerTurn: 1.5 })).toEqual(['attachments.outputs.maxFilesPerTurn']);
    expect(fields({ maxFileSizeMb: 11 })).toEqual(['attachments.outputs.maxFileSizeMb']);
    expect(fields({ maxFileSizeMb: 0 })).toEqual(['attachments.outputs.maxFileSizeMb']);
    expect(fields({ maxFileSizeMb: 'big' })).toEqual(['attachments.outputs.maxFileSizeMb']);
    expect(fields({ enabled: 'yes' })).toEqual(['attachments.outputs.enabled']);
    expect(fields('on')).toEqual(['attachments.outputs']);
    expect(fields([])).toEqual(['attachments.outputs']);
  });

  it('are approved like the other session file tools: never asked about unless the author says so', () => {
    expect(HITL_READ_ONLY_TOOLS).toEqual(expect.arrayContaining(['session_files_create', 'session_files_append']));
    expect(isReadOnlyTool('session_files_create')).toBe(true);
    const asking = resolveHitlConfig({ toolApproval: { enabled: true, defaultPolicy: 'always', tools: { session_files_append: 'always' } } });
    expect(toolApprovalPolicy(asking, 'session_files_create')).toBe('never');
    expect(toolApprovalPolicy(asking, 'session_files_append')).toBe('always');
  });
});

describe('the Studio edit of the settings', () => {
  it('stores the switch as chosen (its default follows the uploads) and the limits only when set', () => {
    expect(patchOutputs(undefined, { enabled: true })).toEqual({ outputs: { enabled: true } });
    expect(patchOutputs({ bucketKey: 'docs' }, { enabled: false })).toEqual({ bucketKey: 'docs', outputs: { enabled: false } });
    expect(patchOutputs({ bucketKey: 'docs', outputs: { enabled: false, maxFilesPerTurn: 4 } }, { enabled: true })).toEqual({ bucketKey: 'docs', outputs: { enabled: true, maxFilesPerTurn: 4 } });
    expect(patchOutputs({ outputs: { maxFileSizeMb: 3 } }, { maxFileSizeMb: undefined })).toBeUndefined();
    expect(outputsEnabled(undefined)).toBe(false);
    expect(outputsEnabled({ enabled: true, bucketKey: 'docs' })).toBe(true);
    expect(outputsEnabled({ enabled: true, bucketKey: 'docs', outputs: { enabled: false } })).toBe(false);
    expect(outputsEnabled({ outputs: { enabled: true } })).toBe(true);
  });
});

describe('file names', () => {
  it('keep the extension and make the rest safe: no directories, no odd characters', () => {
    expect(parseOutputFileName('report.md')).toEqual({ stem: 'report', ext: 'md' });
    expect(parseOutputFileName('Q1 Report (final).CSV')).toEqual({ stem: 'Q1-Report-final', ext: 'csv' });
    expect(parseOutputFileName('../../etc/passwd.txt')).toEqual({ stem: 'passwd', ext: 'txt' });
    expect(parseOutputFileName('C:\\temp\\notes.json')).toEqual({ stem: 'notes', ext: 'json' });
    expect(parseOutputFileName('özet-raporu.md')).toEqual({ stem: 'özet-raporu', ext: 'md' });
    expect(parseOutputFileName('a\u0000b\nc.txt')).toEqual({ stem: 'a-b-c', ext: 'txt' });
    expect(parseOutputFileName('..hidden..name...xml')).toEqual({ stem: 'hidden.name', ext: 'xml' });
    expect(parseOutputFileName('---.yml')).toEqual({ stem: 'file', ext: 'yml' });
    expect((parseOutputFileName(`${'x'.repeat(300)}.md`) as { stem: string }).stem).toHaveLength(100);
  });

  it('refuse a name with a type that is not allowed, or none', () => {
    for (const bad of ['run.sh', 'photo.png', 'archive.zip', 'page.htm', 'noext', '.md', '', '   ', 'a.', undefined, 42]) {
      expect(parseOutputFileName(bad), String(bad)).toHaveProperty('error');
    }
    expect((parseOutputFileName('x.exe') as { error: string }).error).toContain('.md');
  });

  it('allow exactly md, csv, txt, json, html, xml, yaml and yml', () => {
    expect(FILE_OUTPUT_EXTENSIONS).toEqual(['md', 'csv', 'txt', 'json', 'html', 'xml', 'yaml', 'yml']);
  });

  it('get a "-1" suffix when the name is taken in this session, whatever the case', () => {
    expect(uniqueOutputName('report', 'md', [])).toBe('report.md');
    expect(uniqueOutputName('report', 'md', ['report.md'])).toBe('report-1.md');
    expect(uniqueOutputName('report', 'md', ['Report.MD', 'report-1.md'])).toBe('report-2.md');
    expect(uniqueOutputName('report', 'md', ['report.csv'])).toBe('report.md');
  });
});

describe('MIME types', () => {
  it('are derived from the extension', () => {
    const derived = Object.fromEntries(FILE_OUTPUT_EXTENSIONS.map((ext) => [ext, (resolveOutputMime(ext, undefined) as { mimeType: string }).mimeType]));
    expect(derived).toEqual({
      md: 'text/markdown', csv: 'text/csv', txt: 'text/plain', json: 'application/json', html: 'text/html',
      xml: 'application/xml', yaml: 'application/yaml', yml: 'application/yaml',
    });
  });

  it('accept a declared type that agrees (parameters and case ignored) and refuse one that does not', () => {
    expect(resolveOutputMime('csv', 'text/csv')).toEqual({ mimeType: 'text/csv' });
    expect(resolveOutputMime('csv', 'Text/CSV; charset=utf-8')).toEqual({ mimeType: 'text/csv' });
    expect(resolveOutputMime('xml', 'text/xml')).toEqual({ mimeType: 'application/xml' });
    expect(resolveOutputMime('yml', 'application/x-yaml')).toEqual({ mimeType: 'application/yaml' });
    expect(resolveOutputMime('md', '')).toEqual({ mimeType: 'text/markdown' });
    for (const [ext, declared] of [['md', 'text/plain'], ['html', 'application/pdf'], ['json', 'text/json'], ['txt', 'image/png'], ['csv', 42]] as const) {
      expect(resolveOutputMime(ext, declared), `${ext} ${declared}`).toHaveProperty('error');
    }
    expect((resolveOutputMime('md', 'text/plain') as { error: string }).error).toContain('text/markdown');
  });
});

describe('the tools', () => {
  const LIMITS = { enabled: true, maxFilesPerTurn: 2, maxFileSizeMb: 1 };
  const policies: string[] = [];
  const guard = {
    protect: <A extends Record<string, unknown>, R>(spec: { name: string; requestedName: string }, execute: (args: A) => Promise<R>) => {
      policies.push(`${spec.name}|${spec.requestedName}`);
      return execute;
    },
  };
  const createToolFn = ((spec: unknown) => spec) as never;
  const attachment = (id: string, name: string, size: number): IAgentMessageAttachment => ({ fileId: id, name, mimeType: 'text/markdown', size, origin: 'agent_output' });

  let seq = 0;
  function build(limits = LIMITS) {
    const built = buildFileOutputTools({
      createToolFn, zod: z, guard,
      scope: { tenantDbName: 'tenant_x', tenantId: 't1', projectId: 'p1' },
      conversation: { _id: 'conv 1', agentKey: 'agent' },
      agentConfig: { modelKey: 'm', attachments: { bucketKey: 'docs' } },
      actorId: 'u1', tokenId: 'tok-1', limits,
    });
    const [create, append] = built.tools as unknown as Array<{ name: string; schema: z.ZodTypeAny; func: (args: Record<string, unknown>) => Promise<string> }>;
    return { built, create: create!, append: append! };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    policies.length = 0;
    seq = 0;
    hoisted.list.mockResolvedValue([]);
    hoisted.save.mockImplementation(async (input: { fileName: string; data: Buffer; turn: { saved: number } }) => {
      seq += 1;
      input.turn.saved += 1;
      return attachment(`f${seq}`, input.fileName, input.data.length);
    });
    hoisted.append.mockImplementation(async (input: { fileId: string; data: Buffer }) => attachment(input.fileId, 'notes.md', 100 + input.data.length));
  });

  it('are named session_files_create and session_files_append, under the policy names agent.session_files.create / .append', () => {
    const { create, append, built } = build();
    expect([create.name, append.name]).toEqual(['session_files_create', 'session_files_append']);
    expect(policies).toEqual(['agent.session_files.create|session_files_create', 'agent.session_files.append|session_files_append']);
    expect(built.definitions.map((d) => d.name)).toEqual(['session_files_create', 'session_files_append']);
    expect(built.definitions[0]!.parameters).toMatchObject({ required: ['filename', 'content'] });
    expect(built.definitions[1]!.parameters).toMatchObject({ required: ['file_id', 'content'] });
  });

  it('take { filename, content, mime_type? } and { file_id, content }', () => {
    const { create, append } = build();
    expect(create.schema.safeParse({ filename: 'a.md', content: 'x' }).success).toBe(true);
    expect(create.schema.safeParse({ filename: 'a.md', content: 'x', mime_type: 'text/markdown' }).success).toBe(true);
    expect(create.schema.safeParse({ filename: 'a.md' }).success).toBe(false);
    expect(append.schema.safeParse({ file_id: 'f1', content: 'x' }).success).toBe(true);
    expect(append.schema.safeParse({ file_id: 'f1' }).success).toBe(false);
  });

  it('create stores the text and answers { file_id, filename, mime_type, size_bytes, download_url }', async () => {
    const { create } = build();
    const out = JSON.parse(await create.func({ filename: 'Q1 report.md', content: 'héllo' }));
    expect(out).toEqual({
      file_id: 'f1', filename: 'Q1-report.md', mime_type: 'text/markdown', size_bytes: 6,
      // The URL a client fetches from the server origin: `/api` included, the session id encoded.
      download_url: '/api/client/v1/agents/sessions/conv%201/files/f1/content',
    });
    const call = hoisted.save.mock.calls[0]![0];
    expect(call).toMatchObject({
      fileName: 'Q1-report.md', contentType: 'text/markdown', actorId: 'u1', tokenId: 'tok-1',
      maxFileBytes: 1024 * 1024, turn: { saved: 1, maxFiles: 2 }, conversation: { _id: 'conv 1', agentKey: 'agent' },
    });
    expect(call.data.toString('utf8')).toBe('héllo');
  });

  it('create gives a taken name a "-1" suffix', async () => {
    hoisted.list.mockResolvedValue([{ name: 'report.md' }, { name: 'Report-1.md' }]);
    const { create } = build();
    expect(JSON.parse(await create.func({ filename: 'report.md', content: 'x' })).filename).toBe('report-2.md');
  });

  it('create refuses, in words, a bad type, a mismatched mime_type or empty content — and stores nothing', async () => {
    const { create } = build();
    expect(await create.func({ filename: 'run.sh', content: 'x' })).toContain('.md');
    expect(await create.func({ filename: 'a.md', content: 'x', mime_type: 'text/csv' })).toContain('does not match');
    expect(await create.func({ filename: 'a.md', content: '' })).toContain('content is required');
    expect(await create.func({ filename: '', content: 'x' })).toContain('filename is required');
    expect(hoisted.save).not.toHaveBeenCalled();
  });

  it('create passes the storage refusals (size, count, quota) to the model as a sentence', async () => {
    const { create } = build();
    hoisted.save.mockRejectedValueOnce(new AgentAttachmentError(413, 'file_too_large', 'The file exceeds the 1 MB limit for files an agent writes.'));
    expect(await create.func({ filename: 'a.md', content: 'x' })).toBe('Could not create the file: The file exceeds the 1 MB limit for files an agent writes.');
    hoisted.save.mockRejectedValueOnce(new Error('S3 exploded with secret details'));
    expect(await create.func({ filename: 'a.md', content: 'x' })).toBe('Could not create the file: the file could not be saved right now.');
  });

  it('the per-turn cap is shared by every call of the run', async () => {
    const { create } = build();
    await create.func({ filename: 'a.md', content: 'x' });
    await create.func({ filename: 'b.md', content: 'x' });
    expect(hoisted.save.mock.calls[1]![0].turn).toBe(hoisted.save.mock.calls[0]![0].turn);
    expect(hoisted.save.mock.calls[1]![0].turn).toEqual({ saved: 2, maxFiles: 2 });
  });

  it('append adds to a file and answers with the same shape', async () => {
    const { append } = build();
    const out = JSON.parse(await append.func({ file_id: ' f9 ', content: 'more' }));
    expect(out).toMatchObject({ file_id: 'f9', filename: 'notes.md', size_bytes: 104, download_url: '/api/client/v1/agents/sessions/conv%201/files/f9/content' });
    expect(hoisted.append.mock.calls[0]![0]).toMatchObject({ fileId: 'f9', actorId: 'u1', tokenId: 'tok-1', maxFileBytes: 1024 * 1024, conversation: { _id: 'conv 1', agentKey: 'agent' } });
    expect(hoisted.append.mock.calls[0]![0].data.toString()).toBe('more');
  });

  it('append refuses what storage refuses (not this agent’s file, too big) and a call without a file or text', async () => {
    const { append } = build();
    hoisted.append.mockRejectedValueOnce(new AgentAttachmentError(404, 'file_not_found', 'Only a file this agent created in this session can be appended to.'));
    expect(await append.func({ file_id: 'u1', content: 'x' })).toBe('Could not append to the file: Only a file this agent created in this session can be appended to.');
    expect(await append.func({ file_id: '', content: 'x' })).toBe('file_id is required.');
    expect(await append.func({ file_id: 'f1', content: '' })).toContain('content is required');
    expect(hoisted.append).toHaveBeenCalledTimes(1);
  });

  it('calls that arrive together run one at a time, so the names stay unique', async () => {
    const taken: string[] = [];
    hoisted.list.mockImplementation(async () => taken.map((name) => ({ name })));
    hoisted.save.mockImplementation(async (input: { fileName: string; data: Buffer; turn: { saved: number } }) => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      taken.push(input.fileName);
      input.turn.saved += 1;
      return attachment(`f-${taken.length}`, input.fileName, 1);
    });
    const { create } = build({ ...LIMITS, maxFilesPerTurn: 5 });
    const names = (await Promise.all([1, 2, 3].map(() => create.func({ filename: 'same.md', content: 'x' })))).map((r) => JSON.parse(r).filename);
    expect(names).toEqual(['same.md', 'same-1.md', 'same-2.md']);
  });

  it('what a turn created or appended to is collected once, with its latest size', async () => {
    const { create, append, built } = build({ ...LIMITS, maxFilesPerTurn: 5 });
    expect(await built.collectOutputs()).toEqual({ attachments: [], warnings: [] });
    await create.func({ filename: 'a.md', content: 'x' });
    await create.func({ filename: 'b.md', content: 'x' });
    await append.func({ file_id: 'f1', content: 'yy' });
    const { attachments, warnings } = await built.collectOutputs();
    expect(warnings).toEqual([]);
    expect(attachments.map((a) => [a.fileId, a.size, a.origin])).toEqual([['f1', 102, 'agent_output'], ['f2', 1, 'agent_output']]);
  });
});

describe('delivery', () => {
  const att = (id: string): IAgentMessageAttachment => ({ fileId: id, name: `${id}.md`, mimeType: 'text/markdown', size: 1, origin: 'agent_output' });

  it('merges the collectors: the sandbox’s files and the tools’ files ride on one answer, a file named twice once', async () => {
    const merged = await mergeOutputCollectors(
      async () => ({ attachments: [att('s1'), att('both')], warnings: ['sandbox warning'] }),
      async () => ({ attachments: [att('t1'), att('both')], warnings: [] }),
    )();
    expect(merged.attachments.map((a) => a.fileId)).toEqual(['s1', 'both', 't1']);
    expect(merged.warnings).toEqual(['sandbox warning']);
    expect(await mergeOutputCollectors()()).toEqual({ attachments: [], warnings: [] });
  });
});

describe('the prompt', () => {
  it('names the tools, the types and the limits', () => {
    const text = fileOutputsPrompt({ enabled: true, maxFilesPerTurn: 7, maxFileSizeMb: 3 });
    expect(text).toContain('session_files_create');
    expect(text).toContain('session_files_append');
    expect(text).toContain('.md .csv .txt .json .html .xml .yaml .yml');
    expect(text).toContain('7 new files per turn');
    expect(text).toContain('3 MB per file');
  });
});
