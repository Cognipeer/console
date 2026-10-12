/**
 * The model wrapper that turns `session-file://` references into bytes at the
 * model call, and the pure helpers around it (the transcript replay, the images
 * carried to a new message).
 */

import { describe, expect, it, vi } from 'vitest';
import {
  expandViewedImages,
  withSessionImages,
  type SessionImageSource,
} from '@/lib/services/agents/sessionImages';
import {
  imageFileIdOf,
  parseSessionFileUrl,
  rebuildUserTurn,
  recentImageAttachments,
  referencedImageIds,
  withEarlierImages,
  wrapAttachmentBlock,
} from '@/lib/services/agents/sessionAttachmentText';
import { buildTurnInputState } from '@/lib/services/agents/agentTurnState';

const EARLIER_BLOCK = wrapAttachmentBlock(['Pictures from earlier messages of this session are shown again below.']);
const ref = (fileId: string, name = `${fileId}.png`) => ({ type: 'image_url', image_url: { url: `session-file://${fileId}` }, fileId, name });

/** A source over a map of files: id → { name, size, bytes }. */
function source(files: Record<string, { name: string; size: number } | null>) {
  const find = vi.fn(async (id: string) => files[id] ?? null);
  const read = vi.fn(async (id: string) => ({ base64: `B64(${id})`, mediaType: 'image/png' }));
  return { find, read } satisfies SessionImageSource;
}

/** A model that records what it receives, with the three entry points the SDK uses. */
function fakeModel() {
  const calls: unknown[][] = [];
  const model = {
    modelName: 'fake',
    invoke: vi.fn(async (messages: unknown[]) => { calls.push(messages); return { role: 'assistant', content: 'ok' }; }),
    stream: async function* (messages: unknown[]) { calls.push(messages); yield { content: 'o' }; yield { content: 'k' }; },
    bindTools: vi.fn((_tools?: unknown) => model),
  };
  return { model, calls };
}

const options = (src: SessionImageSource, extra: Partial<{ maxImages: number; maxBytes: number; viewImageTool: boolean }> = {}) => ({
  source: src, maxImages: 6, maxBytes: 12_000_000, ...extra,
});

describe('withSessionImages', () => {
  it('turns a reference into the SDK image and leaves everything else as it was', async () => {
    const { model, calls } = fakeModel();
    const src = source({ a: { name: 'a.png', size: 10 } });
    const wrapped = withSessionImages(model, options(src));
    const original = [
      { role: 'system', content: 'be brief' },
      { role: 'user', content: [{ type: 'text', text: 'look' }, ref('a')] },
    ];

    await wrapped.invoke(original);

    expect(calls[0]).toEqual([
      { role: 'system', content: 'be brief' },
      { role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image_url', image_url: { base64: 'B64(a)', media_type: 'image/png' } }] },
    ]);
    // The messages the SDK holds are not touched.
    expect(JSON.stringify(original)).toContain('session-file://a');
    expect(JSON.stringify(original)).not.toContain('B64');
  });

  it('passes a request with no reference straight through, without touching storage', async () => {
    const { model, calls } = fakeModel();
    const src = source({});
    const wrapped = withSessionImages(model, options(src));
    const messages = [{ role: 'user', content: 'plain' }];
    await wrapped.invoke(messages);
    expect(calls[0]).toBe(messages);
    expect(src.find).not.toHaveBeenCalled();
  });

  it('works for stream and for the model bindTools returns, sharing one read per file for the whole run', async () => {
    const { model, calls } = fakeModel();
    const src = source({ a: { name: 'a.png', size: 10 } });
    const wrapped = withSessionImages(model, options(src));
    const messages = [{ role: 'user', content: [ref('a')] }];

    await wrapped.invoke(messages);
    const chunks: unknown[] = [];
    for await (const chunk of wrapped.stream(messages)) chunks.push(chunk);
    const bound = wrapped.bindTools([]);
    await bound.invoke(messages);

    expect(chunks).toHaveLength(2);
    expect(calls).toHaveLength(3);
    for (const call of calls) expect(JSON.stringify(call)).toContain('B64(a)');
    expect(src.read).toHaveBeenCalledTimes(1);
    expect(src.find).toHaveBeenCalledTimes(1);
  });

  it('keeps the newest maxImages and says which older ones were left out', async () => {
    const { model, calls } = fakeModel();
    const src = source({ a: { name: 'a.png', size: 1 }, b: { name: 'b "x".png', size: 1 }, c: { name: 'c.png', size: 1 } });
    const wrapped = withSessionImages(model, options(src, { maxImages: 2, viewImageTool: true }));

    await wrapped.invoke([{ role: 'user', content: [ref('a'), ref('b'), ref('c')] }]);

    const parts = (calls[0][0] as { content: Array<{ type: string; text?: string }> }).content;
    expect(parts.map((part) => part.type)).toEqual(['text', 'image_url', 'image_url']);
    expect(parts[0].text).toBe('[Image "a.png" (id a) is not shown: a request carries at most 2 images / 12 MB, and newer images took the room. Use session_files_view_image to look at it again.]');
    expect(src.read).toHaveBeenCalledTimes(2);
    expect(src.read).not.toHaveBeenCalledWith('a');
  });

  it('keeps inside maxBytes by the stored sizes, newest first, without reading what it drops', async () => {
    const { model, calls } = fakeModel();
    const src = source({ a: { name: 'a.png', size: 60 }, b: { name: 'b.png', size: 60 } });
    const wrapped = withSessionImages(model, options(src, { maxBytes: 100 }));

    await wrapped.invoke([{ role: 'user', content: [ref('a')] }, { role: 'user', content: [ref('b')] }]);

    const flat = JSON.stringify(calls[0]);
    expect(flat).toContain('B64(b)');
    expect(flat).not.toContain('B64(a)');
    expect(flat).toContain('is not shown');
    expect(flat).not.toContain('session_files_view_image'); // the tool is not offered here
    expect(src.read).toHaveBeenCalledTimes(1);
  });

  it('a file that is gone, or cannot be read, is a note naming it — never a failed call', async () => {
    const { model, calls } = fakeModel();
    const src = source({ gone: null, broken: { name: 'broken.png', size: 5 } });
    src.read.mockRejectedValueOnce(new Error('bucket unreachable'));
    const wrapped = withSessionImages(model, options(src));

    await wrapped.invoke([{ role: 'user', content: [ref('gone', 'old "pic".png'), ref('broken')] }]);

    const parts = (calls[0][0] as { content: Array<{ text?: string }> }).content;
    expect(parts.map((part) => part.text)).toEqual(['[Image "old &quot;pic&quot;.png" is no longer available]', '[Image "broken.png" is no longer available]']);
  });

  it('does not touch a picture a caller already put in as bytes', async () => {
    const { model, calls } = fakeModel();
    const src = source({});
    const wrapped = withSessionImages(model, options(src));
    const messages = [{ role: 'user', content: [{ type: 'image_url', image_url: { base64: 'AAA', media_type: 'image/png' } }] }];
    await wrapped.invoke(messages);
    expect(calls[0]).toEqual(messages);
    expect(src.find).not.toHaveBeenCalled();
  });
});

describe('expandViewedImages', () => {
  const viewResult = (fileId: string, name = 'cat.png') => ({
    role: 'tool', name: 'session_files_view_image', tool_call_id: `t-${fileId}`, content: JSON.stringify({ ok: true, fileId, name }),
  });

  it('puts a user message with the picture after the whole run of tool results', () => {
    const out = expandViewedImages([
      { role: 'user', content: 'show me' },
      { role: 'assistant', content: '', tool_calls: [{ id: 't-a' }, { id: 'x' }] },
      viewResult('a'),
      { role: 'tool', name: 'other', tool_call_id: 'x', content: 'fine' },
      { role: 'assistant', content: 'done' },
    ]) as Array<{ role: string; content: unknown }>;

    expect(out.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'tool', 'user', 'assistant']);
    const parts = out[4].content as Array<{ type: string; text?: string }>;
    expect(parts[1].text).toBe('[Image you asked to see: "cat.png" (id a)]');
    expect(parts[2]).toMatchObject({ type: 'image_url', fileId: 'a' });
  });

  it('works when the results end the request, and shows each picture once', () => {
    const out = expandViewedImages([
      { role: 'assistant', content: '', tool_calls: [{ id: 't-a' }, { id: 't-a2' }] },
      viewResult('a'),
      { ...viewResult('a'), tool_call_id: 't-a2' },
    ]) as Array<{ role: string; content: Array<{ type: string }> }>;
    expect(out.map((m) => m.role)).toEqual(['assistant', 'tool', 'tool', 'user']);
    expect(out[3].content.filter((part) => part.type === 'image_url')).toHaveLength(1);
  });

  it('leaves a refusal alone, and returns the same array when nothing is viewed', () => {
    const messages = [
      { role: 'assistant', content: '', tool_calls: [{ id: 't' }] },
      { role: 'tool', name: 'session_files_view_image', tool_call_id: 't', content: 'File "x" is not attached to this conversation.' },
    ];
    expect(expandViewedImages(messages)).toBe(messages);
  });
});

describe('references and the transcript replay', () => {
  it('reads a file id from a part, a url, or nothing', () => {
    expect(parseSessionFileUrl('session-file://abc')).toBe('abc');
    expect(parseSessionFileUrl('https://x/y.png')).toBeNull();
    expect(parseSessionFileUrl('session-file://')).toBeNull();
    expect(imageFileIdOf(ref('abc'))).toBe('abc');
    expect(imageFileIdOf({ type: 'image_url', image_url: { url: 'session-file://zzz' } })).toBe('zzz');
    expect(imageFileIdOf({ type: 'image_url', image_url: 'session-file://str' })).toBe('str');
    expect(imageFileIdOf({ type: 'text', text: 'x' })).toBeNull();
    expect(referencedImageIds([{ content: 'x' }, { content: [ref('a'), { type: 'text', text: 't' }] }, { content: [ref('b')] }])).toEqual(new Set(['a', 'b']));
  });

  const attachments = [
    { fileId: 'd1', name: 'report.pdf', mimeType: 'application/pdf', size: 10 },
    { fileId: 'i1', name: 'cat.png', mimeType: 'image/png', size: 20 },
  ];

  it('rebuilds a user turn with its attachments: the block, the document list, the picture behind a handle', () => {
    const turn = rebuildUserTurn('what are these?', attachments, { supportsVision: true }) as Array<{ type: string; text?: string }>;
    expect(turn[0].text).toBe(
      'what are these?\n\n<attachments source="session-files">\n'
      + 'The person attached 2 files: 1 document to read with the tools (session_files_list, session_files_read), 1 image shown below.\n'
      + '- "report.pdf" (id d1)\n</attachments>',
    );
    expect(turn[1]).toEqual({ type: 'text', text: '[Attached image: "cat.png" (id i1)]' });
    expect(turn[2]).toEqual(ref('i1', 'cat.png'));
  });

  it('is a plain string for a model that cannot read images, and for a message without attachments', () => {
    const turn = rebuildUserTurn('hi', attachments, { supportsVision: false });
    expect(typeof turn).toBe('string');
    expect(turn).toContain('1 image not shown');
    expect(turn).toContain('"cat.png" (id i1) was attached, but this model cannot read images.');
    expect(rebuildUserTurn('hi', undefined, { supportsVision: true })).toBe('hi');
    expect(rebuildUserTurn('hi', [], { supportsVision: true })).toBe('hi');
  });

  it('picks the images of the last N picture-bearing user messages, oldest first', () => {
    const img = (id: string) => ({ fileId: id, name: `${id}.png`, mimeType: 'image/png', size: 1 });
    const history = [
      { role: 'user', attachments: [img('a')] },
      { role: 'assistant' },
      { role: 'user', attachments: [{ fileId: 'd', name: 'd.txt', mimeType: 'text/plain', size: 1 }] },
      { role: 'user', attachments: [img('b'), img('c')] },
      { role: 'user' },
    ];
    expect(recentImageAttachments(history, 1).map((a) => a.fileId)).toEqual(['b', 'c']);
    expect(recentImageAttachments(history, 2).map((a) => a.fileId)).toEqual(['a', 'b', 'c']);
    expect(recentImageAttachments(history, 0)).toEqual([]);
    expect(withEarlierImages('now', [img('a')])).toEqual([
      { type: 'text', text: `now${EARLIER_BLOCK}` },
      { type: 'text', text: '[Earlier image: "a.png" (id a)]' },
      ref('a', 'a.png'),
    ]);
    expect(withEarlierImages('now', [])).toBe('now');
  });
});

describe('buildTurnInputState with earlier attachments', () => {
  const img = { fileId: 'i1', name: 'cat.png', mimeType: 'image/png', size: 1 };
  const transcript = [
    { role: 'user', content: 'what is this?', attachments: [img] },
    { role: 'assistant', content: 'a cat' },
  ];

  it('without the option, a transcript replay is the plain text as before', () => {
    const state = buildTurnInputState({ carried: null, transcript, userMessage: 'and?' });
    expect(state.messages).toEqual([
      { role: 'user', content: 'what is this?' },
      { role: 'assistant', content: 'a cat' },
      { role: 'user', content: 'and?' },
    ]);
  });

  it('with it, the replay rebuilds the attachments and nothing is carried a second time', () => {
    const state = buildTurnInputState({
      carried: null, transcript, userMessage: 'and?', attachments: { supportsVision: true, carryRecentImages: 2 },
    });
    const first = state.messages[0] as { content: Array<{ type: string }> };
    expect(first.content.map((part) => part.type)).toEqual(['text', 'text', 'image_url']);
    expect(state.messages.at(-1)).toEqual({ role: 'user', content: 'and?' });
  });

  it('a carried state that lost the picture gets it back with the new message — unless its file is gone', () => {
    const carried = { messages: [{ role: 'user', content: 'what is this? [summary]' }, { role: 'assistant', content: 'a cat' }] };
    const back = buildTurnInputState({
      carried: carried as never, transcript, userMessage: 'and?', attachments: { supportsVision: true, carryRecentImages: 2 },
    });
    expect((back.messages.at(-1) as { content: unknown }).content).toEqual([
      { type: 'text', text: `and?${EARLIER_BLOCK}` },
      { type: 'text', text: '[Earlier image: "cat.png" (id i1)]' },
      ref('i1', 'cat.png'),
    ]);

    const gone = buildTurnInputState({
      carried: carried as never, transcript, userMessage: 'and?',
      attachments: { supportsVision: true, carryRecentImages: 2, availableFileIds: new Set() },
    });
    expect((gone.messages.at(-1) as { content: unknown }).content).toBe('and?');

    const textOnly = buildTurnInputState({
      carried: carried as never, transcript, userMessage: 'and?', attachments: { supportsVision: false, carryRecentImages: 2 },
    });
    expect((textOnly.messages.at(-1) as { content: unknown }).content).toBe('and?');
  });
});
