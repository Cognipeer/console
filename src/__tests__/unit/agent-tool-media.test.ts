/**
 * Tool media: the run's in-memory image store, and the adapter that turns a
 * tool's `ToolOutput` into what the model reads (text, or a small JSON that
 * names the images the model wrapper then shows).
 */

import { describe, expect, it } from 'vitest';
import { adaptToolResult, createToolMediaStore, withToolMedia, type ToolMediaContext } from '@/lib/services/agents/toolMedia';
import { toolOutput } from '@/lib/services/tools/toolOutput';

const b64 = (bytes: number) => Buffer.alloc(bytes, 7).toString('base64');

function ctx(extra: Partial<ToolMediaContext> = {}): ToolMediaContext {
  return { store: createToolMediaStore(), modelTakesImages: true, maxImageBytes: 5 * 1024 * 1024, ...extra };
}

describe('createToolMediaStore', () => {
  it('hands out tm_<counter>_<6 hex> ids and gives the item back with its raw size', () => {
    const store = createToolMediaStore();
    const a = store.put({ base64: b64(30), mediaType: 'image/png', name: 'a.png' });
    const b = store.put({ base64: b64(10), mediaType: 'image/jpeg', name: 'b.jpg' });
    expect(a.id).toMatch(/^tm_1_[0-9a-f]{6}$/);
    expect(b.id).toMatch(/^tm_2_[0-9a-f]{6}$/);
    expect(a.size).toBe(30);
    expect(store.get(a.id)).toEqual({ base64: b64(30), mediaType: 'image/png', name: 'a.png', size: 30 });
    expect(store.get('tm_9_000000')).toBeNull();
  });

  it('evicts the oldest first when there are too many items', () => {
    const store = createToolMediaStore({ maxItems: 2 });
    const ids = [1, 2, 3].map((n) => store.put({ base64: b64(4), mediaType: 'image/png', name: `${n}.png` }).id);
    expect(store.get(ids[0]!)).toBeNull();
    expect(store.get(ids[1]!)).not.toBeNull();
    expect(store.get(ids[2]!)).not.toBeNull();
  });

  it('evicts the oldest first when the total bytes are over the cap, but never the newest item', () => {
    const store = createToolMediaStore({ maxTotalBytes: 100 });
    const a = store.put({ base64: b64(60), mediaType: 'image/png', name: 'a.png' });
    const b = store.put({ base64: b64(60), mediaType: 'image/png', name: 'b.png' });
    expect(store.get(a.id)).toBeNull();
    expect(store.get(b.id)).not.toBeNull();
    // One item bigger than the whole cap still comes back readable.
    const huge = store.put({ base64: b64(500), mediaType: 'image/png', name: 'huge.png' });
    expect(store.get(huge.id)).not.toBeNull();
    expect(store.get(b.id)).toBeNull();
  });
});

describe('adaptToolResult', () => {
  it('returns anything that is not a ToolOutput exactly as it was', () => {
    const c = ctx();
    const object = { a: 1 };
    expect(adaptToolResult('plain', c)).toBe('plain');
    expect(adaptToolResult(object, c)).toBe(object);
    expect(adaptToolResult(undefined, c)).toBeUndefined();
    expect(adaptToolResult(null, c)).toBeNull();
    expect(adaptToolResult({ kind: 'something_else', content: [] }, c)).toEqual({ kind: 'something_else', content: [] });
  });

  it('a text-only output becomes its text', () => {
    expect(adaptToolResult(toolOutput([{ type: 'text', text: 'one' }, { type: 'text', text: 'two' }]), ctx())).toBe('one\ntwo');
  });

  it('puts resource text and link lines in the text, and structuredContent when there is no text', () => {
    const out = toolOutput([
      { type: 'resource', resource: { uri: 'file:///a.txt', text: 'inside' } },
      { type: 'resource_link', uri: 'https://x.test/doc', name: 'Doc' },
    ]);
    expect(adaptToolResult(out, ctx())).toBe('inside\n[link: Doc <https://x.test/doc>]');
    expect(adaptToolResult(toolOutput([], { structuredContent: { rows: 3 } }), ctx())).toBe('{"rows":3}');
    expect(adaptToolResult(toolOutput([]), ctx())).toBe('');
  });

  it('an error becomes "Error: …" (also with nothing to say)', () => {
    expect(adaptToolResult(toolOutput([{ type: 'text', text: 'boom' }], { isError: true }), ctx())).toBe('Error: boom');
    expect(adaptToolResult(toolOutput([], { isError: true }), ctx())).toBe('Error: the tool reported an error');
  });

  it('stores an image the model can see and names it in attachedImages, with the note', () => {
    const c = ctx();
    const result = adaptToolResult(toolOutput([
      { type: 'text', text: 'Screenshot of https://x.test' },
      { type: 'image', data: b64(100), mimeType: 'image/png', name: 'shot.png', width: 800, height: 600 },
    ]), c) as string;

    const parsed = JSON.parse(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.text).toBe('Screenshot of https://x.test');
    expect(parsed.attachedImages).toHaveLength(1);
    expect(parsed.attachedImages[0]).toMatchObject({ name: 'shot.png', mimeType: 'image/png', width: 800, height: 600 });
    expect(parsed.attachedImages[0].fileId).toMatch(/^tm_1_/);
    expect(parsed.note).toBe('The image is shown to you in the next message.');
    expect(parsed.omitted).toBeUndefined();
    // The base64 is in the store, never in the message.
    expect(result).not.toContain(b64(100));
    expect(c.store.get(parsed.attachedImages[0].fileId)?.base64).toBe(b64(100));
  });

  it('names several images, defaults their names, and uses the plural note', () => {
    const parsed = JSON.parse(adaptToolResult(toolOutput([
      { type: 'image', data: b64(10), mimeType: 'image/png' },
      { type: 'image', data: b64(10), mimeType: 'image/jpeg' },
      { type: 'image', data: b64(10), mimeType: 'image/webp' },
    ]), ctx()) as string);
    expect(parsed.attachedImages.map((i: { name: string }) => i.name)).toEqual(['image-1.png', 'image-2.jpg', 'image-3.webp']);
    expect(parsed.note).toBe('The images are shown to you in the next message.');
  });

  it('an image reference (fileId) is attached as it is, without touching the store, when the tool is trusted', () => {
    const c = ctx({ trustFileIds: true });
    const parsed = JSON.parse(adaptToolResult(toolOutput([
      { type: 'image', fileId: 'file-42', mimeType: 'image/png', name: 'cat.png' },
    ]), c) as string);
    expect(parsed.attachedImages).toEqual([{ fileId: 'file-42', name: 'cat.png', mimeType: 'image/png' }]);
    expect(c.store.get('file-42')).toBeNull();
  });

  it('an untrusted tool cannot attach a session file by id, and a missing mimeType does not crash', () => {
    const parsed = JSON.parse(adaptToolResult(toolOutput([
      { type: 'image', fileId: 'file-42', mimeType: 'image/png', name: 'cat.png' },
      { type: 'image', data: b64(10) } as never,
    ]), ctx()) as string);
    expect(parsed.attachedImages).toBeUndefined();
    expect(parsed.omitted).toHaveLength(2);
  });

  it('omits an image over the provider pixel limit and uses the sniffed type over the declared one', () => {
    const png = (w: number, h: number) => {
      const b = Buffer.alloc(33);
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b);
      b.writeUInt32BE(w, 16);
      b.writeUInt32BE(h, 20);
      return b.toString('base64');
    };
    const tall = JSON.parse(adaptToolResult(toolOutput([{ type: 'image', data: png(1280, 9500), mimeType: 'image/png', name: 'long.png' }]), ctx()) as string);
    expect(tall.omitted[0]).toContain('1280x9500');
    const mislabeled = JSON.parse(adaptToolResult(toolOutput([{ type: 'image', data: png(10, 10), mimeType: 'image/jpeg', name: 'm.jpg' }]), ctx()) as string);
    expect(mislabeled.attachedImages[0]).toMatchObject({ mimeType: 'image/png', width: 10, height: 10 });
  });

  it('a model that cannot see images gets a note instead of the image', () => {
    const c = ctx({ modelTakesImages: false });
    const parsed = JSON.parse(adaptToolResult(toolOutput([
      { type: 'text', text: 'captured' },
      { type: 'image', data: b64(10), mimeType: 'image/png', name: 'shot.png' },
    ]), c) as string);
    expect(parsed.omitted).toEqual(['shot.png: this model cannot view images']);
    expect(parsed.attachedImages).toBeUndefined();
    expect(parsed.note).toBeUndefined();
    expect(parsed.text).toBe('captured');
  });

  it('a format a model request cannot carry is left out with its type named', () => {
    const parsed = JSON.parse(adaptToolResult(toolOutput([{ type: 'image', data: b64(10), mimeType: 'image/bmp', name: 'old.bmp' }]), ctx()) as string);
    expect(parsed.omitted).toEqual(['old.bmp: image/bmp cannot be shown to the model']);
  });

  it('an image over the size limit is left out with both sizes', () => {
    const parsed = JSON.parse(adaptToolResult(
      toolOutput([{ type: 'image', data: b64(3 * 1024 * 1024), mimeType: 'image/png', name: 'big.png' }]),
      ctx({ maxImageBytes: 2 * 1024 * 1024 }),
    ) as string);
    expect(parsed.omitted).toEqual(['big.png: 3 MB is over the 2 MB image limit — make it smaller first']);
  });

  it('audio and binary resources are left out with a reason; the rest still goes through', () => {
    const parsed = JSON.parse(adaptToolResult(toolOutput([
      { type: 'audio', data: 'AAAA', mimeType: 'audio/wav', name: 'voice.wav' },
      { type: 'audio', data: 'AAAA', mimeType: 'audio/wav' },
      { type: 'resource', resource: { uri: 'file:///x.bin', blob: 'AAAA' } },
      { type: 'text', text: 'done' },
    ]), ctx()) as string);
    expect(parsed.omitted).toEqual([
      'voice.wav: audio cannot be played to the model',
      'audio: audio cannot be played to the model',
      'file:///x.bin: binary resource not shown',
    ]);
    expect(parsed.text).toBe('done');
    expect(parsed.ok).toBe(true);
  });

  it('structured content is carried only when there is no text, and an error keeps ok:false', () => {
    const noText = JSON.parse(adaptToolResult(toolOutput(
      [{ type: 'image', data: b64(10), mimeType: 'image/png' }],
      { structuredContent: { url: 'https://x.test' }, isError: true },
    ), ctx()) as string);
    expect(noText.structured).toEqual({ url: 'https://x.test' });
    expect(noText.ok).toBe(false);
    expect(noText.text).toBeUndefined();

    const withText = JSON.parse(adaptToolResult(toolOutput(
      [{ type: 'text', text: 'hello' }, { type: 'image', data: b64(10), mimeType: 'image/png' }],
      { structuredContent: { url: 'https://x.test' } },
    ), ctx()) as string);
    expect(withText.structured).toBeUndefined();
  });
});

describe('withToolMedia', () => {
  const output = toolOutput([{ type: 'text', text: 'hi' }, { type: 'image', data: b64(10), mimeType: 'image/png', name: 's.png' }]);

  it('replaces invoke, call, run and func with one adapter and keeps every other property', async () => {
    const seen: unknown[][] = [];
    const original = async (...args: unknown[]) => { seen.push(args); return output; };
    const tool = {
      name: 'shot',
      description: 'd',
      schema: { any: 1 },
      needsApproval: true,
      invoke: original, call: original, run: original, func: original,
    };
    const wrapped = withToolMedia(tool as never, ctx()) as typeof tool;

    expect(wrapped).not.toBe(tool);
    expect(wrapped.name).toBe('shot');
    expect(wrapped.needsApproval).toBe(true);
    expect(wrapped.schema).toBe(tool.schema);
    expect(new Set([wrapped.invoke, wrapped.call, wrapped.run, wrapped.func]).size).toBe(1);
    for (const alias of ['invoke', 'call', 'run', 'func'] as const) {
      const result = JSON.parse(await (wrapped[alias] as unknown as (a: unknown, ...r: unknown[]) => Promise<string>)({ x: 1 }, { signal: 'ctx' }));
      expect(result.attachedImages).toHaveLength(1);
    }
    // The call's context reaches the tool.
    expect(seen[0]).toEqual([{ x: 1 }, { signal: 'ctx' }]);
    // The original is not mutated.
    expect(tool.invoke).toBe(original);
  });

  it('wraps whichever alias exists, and passes a plain result straight through', async () => {
    const tool = { name: 'plain', func: async () => 'text result' };
    const wrapped = withToolMedia(tool as never, ctx()) as typeof tool & { invoke: () => Promise<unknown> };
    expect(await wrapped.invoke()).toBe('text result');
    expect(wrapped.func).toBe(wrapped.invoke);
  });

  it('returns a tool without any callable unchanged', () => {
    const tool = { name: 'inert' };
    expect(withToolMedia(tool as never, ctx())).toBe(tool);
  });
});
