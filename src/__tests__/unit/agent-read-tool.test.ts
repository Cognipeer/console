/**
 * The `read` tool: every flow of it against a fake sandbox runner.
 *
 * The runner's `exec` answers by matching the command, the way the real
 * sandbox's shell would, over a small in-memory file system. That is also how
 * the quoting is checked: the fake PARSES the single-quoted path out of the
 * command, so a path that were not quoted properly would not be found.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createTool } from '@cognipeer/agent-sdk';
import type { AgentSandboxRunner } from '@/enterprise/registry';

const sessionFiles = vi.hoisted(() => ({
  records: new Map<string, Record<string, unknown>>(),
  texts: new Map<string, string | null>(),
  failRead: false,
}));
vi.mock('@/lib/services/agents/sessionFiles', () => ({
  findSessionFileRecord: vi.fn(async (_scope: unknown, _conversationId: string, fileId: string) => sessionFiles.records.get(fileId) ?? null),
  readFileText: vi.fn(async (_scope: unknown, record: { _id: string }) => {
    if (sessionFiles.failRead) throw new Error('bucket down');
    return sessionFiles.texts.get(String(record._id)) ?? null;
  }),
}));

import { buildReadTool, readToolDefinition, READ_TOOL } from '@/lib/services/agents/readTool';
import { createToolMediaStore, adaptToolResult } from '@/lib/services/agents/toolMedia';
import { isToolOutput, type ToolContentBlock, type ToolOutput } from '@/lib/services/tools/toolOutput';

// ── fixtures ────────────────────────────────────────────────────────────────

/** A PNG header with real dimensions, padded to `total` bytes. */
function png(width: number, height: number, total = 64): Buffer {
  const head = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(head, 0);
  head.writeUInt32BE(13, 8);
  head.write('IHDR', 12, 'ascii');
  head.writeUInt32BE(width, 16);
  head.writeUInt32BE(height, 20);
  return Buffer.concat([head, Buffer.alloc(Math.max(0, total - 24), 1)]);
}
// A real BMP file header (reserved bytes zero, 40-byte DIB header); 'BM' alone is also how plain text can start.
const bmp = (total = 64) => {
  const head = Buffer.alloc(18);
  head.write('BM', 0, 'ascii');
  head.writeUInt32LE(40, 14);
  return Buffer.concat([head, Buffer.alloc(Math.max(0, total - 18), 2)]);
};
const pdf = () => Buffer.from('%PDF-1.7\n1 0 obj\n');
const mp4 = () => Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom'), Buffer.alloc(32, 3)]);
const zip = () => Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(40, 5)]);
const wav = () => Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVE'), Buffer.alloc(20, 4)]);

/** Reads the single-quoted word `shQuote` writes, starting at `from`; returns its value and where it ends. */
function readQuoted(command: string, from: number): { value: string; end: number } {
  let value = '';
  let i = from;
  for (;;) {
    if (command[i] === "'") {
      const close = command.indexOf("'", i + 1);
      value += command.slice(i + 1, close);
      i = close + 1;
    } else if (command.startsWith("\\'", i)) {
      value += "'";
      i += 2;
    } else break;
  }
  return { value, end: i };
}

interface FakeOptions {
  /** `ffmpeg` converts, `none` has no converter, `fail` has one that errors. */
  convert?: 'ffmpeg' | 'none' | 'fail';
  /** Pages of every PDF; null = no poppler. */
  pdfPages?: number | null;
  /** Text of each page (index 0 = page 1). */
  pageTexts?: string[];
  /** pdfplumber fallback available (only used without poppler). */
  python?: boolean;
  /** ffmpeg and ffprobe installed. */
  video?: boolean;
  /** What `ffprobe format=duration` prints. */
  duration?: string;
  /** What the packet-count fallback prints. */
  packets?: string;
  /** Not readable by the sandbox user. */
  unreadable?: string[];
  /** The runner has a binary-safe read. */
  readFileBytes?: boolean;
}

function fakeSandbox(options: FakeOptions = {}) {
  const files = new Map<string, Buffer>();
  const dirs = new Set<string>(['/workspace']);
  const commands: string[] = [];
  const reads: string[] = [];
  const removed: string[] = [];
  const opts = { convert: 'ffmpeg', pdfPages: 3, pageTexts: [], python: false, video: true, duration: '10.0', packets: '', unreadable: [], readFileBytes: true, ...options } as Required<FakeOptions>;

  const handle = (command: string): { exitCode: number; stdout: string; stderr: string } => {
    const ok = (stdout: string) => ({ exitCode: 0, stdout, stderr: '' });
    const out = (pattern: RegExp) => pattern.exec(command)?.[1];

    if (command.startsWith('p=')) {
      const { value: path } = readQuoted(command, 2);
      if (dirs.has(path)) return ok('DIR\n');
      const data = files.get(path);
      if (!data) return ok('MISSING\n');
      if (opts.unreadable.includes(path)) return ok('UNREADABLE\n');
      const sample = data.subarray(0, 8192);
      const noNul = sample.filter((byte) => byte !== 0).length;
      return ok(`FILE ${data.length} ${sample.length} ${noNul} ${data.subarray(0, 16).toString('hex')}\n`);
    }
    if (command.includes("awk 'END{print NR}'")) {
      const target = readQuoted(command, command.indexOf("awk 'END{print NR}' ") + "awk 'END{print NR}' ".length).value;
      const lines = files.get(target)!.toString('utf8').split('\n');
      if (lines[lines.length - 1] === '') lines.pop();
      const [, a, b] = /sed -n '(\d+),(\d+)p'/.exec(command)!;
      files.set(out(/o=(\S+)/)!, Buffer.from(`${lines.slice(Number(a) - 1, Number(b)).join('\n')}\n`));
      return ok(`${lines.length}\n`);
    }
    if (command.startsWith('rm -f')) {
      let i = 'rm -f '.length;
      while (i < command.length) {
        const word = readQuoted(command, i);
        removed.push(word.value);
        files.delete(word.value);
        i = word.end + 1;
      }
      return ok('');
    }
    if (command.includes("scale='if(gt(iw,ih)")) {
      if (opts.convert === 'none') return ok('NOTOOL\n');
      if (opts.convert === 'fail') return { exitCode: 1, stdout: '', stderr: 'Invalid data found' };
      const o = out(/o=(\S+)/)!;
      files.set(o, png(1568, 980, 900));
      return ok(`OK ${o}\n`);
    }
    if (command.includes('pdfinfo')) return ok(opts.pdfPages === null ? 'NOPOPPLER\n' : `${opts.pdfPages}\n`);
    if (command.includes('pdftotext')) {
      const from = Number(out(/-f (\d+)/));
      const to = Number(out(/-l (\d+)/));
      const pages = Array.from({ length: to - from + 1 }, (_, i) => opts.pageTexts[from - 1 + i] ?? `text of page ${from + i}`);
      files.set(out(/o=(\S+)/)!, Buffer.from(`${pages.join('\f')}\f`));
      return ok('OK\n');
    }
    if (command.includes('pdftoppm')) {
      const ks = out(/for k in ([\d ]+);/)!.split(' ');
      const prefix = out(/(\/tmp\/\.cognipeer-read\/[0-9a-f]+)-p\$k/)!;
      for (const k of ks) files.set(`${prefix}-p${k}.png`, png(1100, 1400, 500));
      return ok('OK\n');
    }
    if (command.includes('python3 -I')) {
      if (!opts.python) return { exitCode: 127, stdout: '', stderr: '' };
      const afterPath = readQuoted(command, command.indexOf('python3 -I - ') + 'python3 -I - '.length);
      const [a, b] = command.slice(afterPath.end).trim().split(/\s+/).map(Number) as [number, number];
      const texts = a > 0 ? Array.from({ length: b - a + 1 }, (_, i) => opts.pageTexts[a - 1 + i] ?? `py text of page ${a + i}`) : [];
      files.set(out(/o=(\S+)/)!, Buffer.from(JSON.stringify({ pages: opts.pdfPages ?? 12, texts })));
      return ok('OK\n');
    }
    if (command.startsWith('command -v ffprobe')) return ok(opts.video ? '' : 'NOTOOL\n');
    if (command.includes('format=duration')) return ok(opts.duration);
    if (command.includes('count_packets')) return ok(opts.packets);
    if (command.includes('tile=')) {
      files.set(out(/(\S+-sheet\.png)/)!, png(960, 540, 2000));
      return ok('OK\n');
    }
    return { exitCode: 127, stdout: '', stderr: `unexpected command: ${command}` };
  };

  const runner = {
    exec: vi.fn(async (_ref: unknown, _instance: string, input: { command: string }) => {
      commands.push(input.command);
      return handle(input.command);
    }),
    readFile: vi.fn(async (_ref: unknown, _instance: string, path: string) => {
      reads.push(path);
      const data = files.get(path);
      if (!data) throw new Error(`ENOENT ${path}`);
      return data.toString('utf8');
    }),
    ...(opts.readFileBytes
      ? {
        readFileBytes: vi.fn(async (_ref: unknown, _instance: string, path: string) => {
          reads.push(path);
          const data = files.get(path);
          if (!data) throw new Error(`ENOENT ${path}`);
          return data;
        }),
      }
      : {}),
  } as unknown as AgentSandboxRunner;

  return {
    files,
    dirs,
    commands,
    reads,
    removed,
    runner,
    put: (path: string, data: Buffer | string) => files.set(path, Buffer.isBuffer(data) ? data : Buffer.from(data)),
  };
}

type Fake = ReturnType<typeof fakeSandbox>;

function build(fake: Fake | null, extra: { session?: boolean; modelTakesImages?: boolean; media?: ReturnType<typeof createToolMediaStore> | false } = {}) {
  const store = extra.media || createToolMediaStore();
  const tool = buildReadTool({
    createToolFn: createTool,
    zod: z,
    guard: { protect: (_spec, execute) => execute as never },
    ...(fake
      ? {
        sandbox: {
          runner: fake.runner,
          ref: { tenantDbName: 't', tenantId: 't', projectId: 'p', agentKey: 'a' },
          getInstance: async () => 'inst-1',
          resolvePath: (p: string) => (p.startsWith('/') ? p : `/workspace/${p}`),
          scrub: (t: string) => t.replaceAll('hunter2', '••••'),
        },
      }
      : {}),
    ...(extra.session ? { session: { scope: { tenantDbName: 't', tenantId: 't', projectId: 'p' }, conversationId: 'conv-1', readPageChars: 20000 } } : {}),
    ...(extra.media === false ? {} : { media: { store } }),
    modelTakesImages: extra.modelTakesImages ?? true,
  });
  const read = async (args: Record<string, unknown>): Promise<ToolOutput> => {
    const result = await (tool as unknown as { invoke: (a: Record<string, unknown>) => Promise<unknown> }).invoke(args);
    expect(isToolOutput(result)).toBe(true);
    return result as ToolOutput;
  };
  return { tool, read, store };
}

const textOf = (output: ToolOutput) => (output.content.find((block) => block.type === 'text') as { text: string }).text;
const images = (output: ToolOutput) => output.content.filter((block): block is Extract<ToolContentBlock, { type: 'image' }> => block.type === 'image');

beforeEach(() => {
  sessionFiles.records.clear();
  sessionFiles.texts.clear();
  sessionFiles.failRead = false;
});

// ── the tool itself ─────────────────────────────────────────────────────────

describe('what is offered', () => {
  it('is not built without a sandbox and without session files', () => {
    expect(build(null, { media: false }).tool).toBeNull();
    expect(READ_TOOL).toBe('read');
  });

  it('offers path only with a sandbox and fileId only with session files (schema and trace definition)', () => {
    const fake = fakeSandbox();
    const keys = (tool: unknown) => Object.keys(((tool as { schema: { shape?: Record<string, unknown> } }).schema.shape) ?? {});

    expect(keys(build(fake, { media: false }).tool)).toEqual(['path', 'offset', 'limit', 'pages', 'view', 'frames']);
    // Tool images of the run can be re-read by id even when the conversation holds no files.
    expect(keys(build(fake).tool)).toEqual(['path', 'fileId', 'offset', 'limit', 'pages', 'view', 'frames']);
    expect(keys(build(null, { session: true, media: false }).tool)).toEqual(['fileId', 'offset', 'limit']);
    expect(keys(build(fake, { session: true }).tool)).toEqual(['path', 'fileId', 'offset', 'limit', 'pages', 'view', 'frames']);

    const sandbox = {} as never;
    const session = {} as never;
    expect(Object.keys((readToolDefinition({ sandbox }).parameters as { properties: object }).properties)).toEqual(['path', 'offset', 'limit', 'pages', 'view', 'frames']);
    expect(Object.keys((readToolDefinition({ session }).parameters as { properties: object }).properties)).toEqual(['fileId', 'offset', 'limit']);
    expect(readToolDefinition({ sandbox }).name).toBe('read');
  });

  it('wants path or fileId', async () => {
    const { read } = build(fakeSandbox(), { session: true });
    for (const args of [{}, { path: ' ', fileId: '' }]) {
      const out = await read(args);
      expect(out.isError).toBe(true);
      expect(textOf(out)).toBe('Pass path or fileId.');
    }
  });

  // Strict tool calling (OpenAI, Azure) sends every argument; models then fill both, usually with the same value.
  it('with both given, reads the path unless the fileId names a tool image or a conversation file', async () => {
    const fake = fakeSandbox();
    fake.put('/workspace/shot.png', png(800, 600, 4096));
    const store = createToolMediaStore();
    const stored = store.put({ base64: 'QUJD', mediaType: 'image/png', name: 'earlier.png' });
    sessionFiles.records.set('img1', { _id: 'img1', name: 'cat.png', contentType: 'image/png', size: 2048 });
    const { read } = build(fake, { session: true, media: store });
    const filled = { offset: 1, limit: 2000, pages: '1', view: 'auto', frames: 1 };

    const same = await read({ path: '/workspace/shot.png', fileId: '/workspace/shot.png', ...filled });
    expect(same.isError).toBeFalsy();
    expect(textOf(same)).toBe('[/workspace/shot.png — image image/png 800x600, 4 KB]');
    expect(images(same)).toHaveLength(1);

    expect(images(await read({ path: 'shot.png', fileId: stored.id }))[0]).toMatchObject({ fileId: stored.id, name: 'earlier.png' });
    expect(images(await read({ path: 'shot.png', fileId: 'img1' }))[0]).toMatchObject({ fileId: 'img1', name: 'cat.png' });
    // An id that is gone or unknown leaves the path to be read.
    expect(textOf(await read({ path: 'shot.png', fileId: 'tm_7_gone' }))).toMatch(/^\[\/workspace\/shot\.png — image/);
    expect(textOf(await read({ path: 'shot.png', fileId: 'ghost' }))).toMatch(/^\[\/workspace\/shot\.png — image/);
  });

  it('with both given and no sandbox, reads the fileId', async () => {
    sessionFiles.records.set('img1', { _id: 'img1', name: 'cat.png', contentType: 'image/png', size: 2048 });
    const out = await build(null, { session: true }).read({ path: 'img1', fileId: 'img1' });
    expect(images(out)[0]).toMatchObject({ fileId: 'img1', name: 'cat.png' });
  });

  it('says so when the asked-for place does not exist for this agent', async () => {
    expect(textOf(await build(fakeSandbox(), { media: false }).read({ fileId: 'f1' }))).toMatch(/no files to read/);
    // With only the run's image store, an id that is not a tool image has nothing to be found in.
    expect(textOf(await build(fakeSandbox()).read({ fileId: 'f1' }))).toMatch(/no files/);
    expect(textOf(await build(null, { session: true }).read({ path: 'a.txt' }))).toMatch(/no sandbox/);
  });
});

// ── sandbox: shell safety ───────────────────────────────────────────────────

describe('sandbox paths reach the shell single-quoted', () => {
  it('a path with a single quote, spaces and a command substitution is found and never interpolated bare', async () => {
    const fake = fakeSandbox();
    const nasty = "/workspace/it's a $(touch x) `id`; rm -rf.txt";
    fake.put(nasty, 'hello\n');
    const { read } = build(fake);

    const out = await read({ path: nasty });

    expect(textOf(out)).toContain('1\thello');
    const quoted = "'/workspace/it'\\''s a $(touch x) `id`; rm -rf.txt'";
    expect(fake.commands[0]).toContain(`p=${quoted};`);
    // Once the quoted form is removed, none of the dangerous text is left in any command.
    for (const command of fake.commands) {
      const rest = command.split(quoted).join('');
      expect(rest).not.toContain('touch x');
      expect(rest).not.toContain('rm -rf');
      expect(rest).not.toContain('`id`');
    }
  });

  it('a relative path is resolved under /workspace first', async () => {
    const fake = fakeSandbox();
    fake.put('/workspace/src/app.py', 'print(1)\n');
    const { read } = build(fake);
    const out = await read({ path: 'src/app.py' });
    expect(textOf(out)).toContain('[/workspace/src/app.py — lines 1-1 of 1]');
    expect(fake.commands[0]).toContain("p='/workspace/src/app.py';");
  });

  it('the large-file window and the downscale quote the path too', async () => {
    const fake = fakeSandbox({ convert: 'ffmpeg' });
    const big = "/workspace/o'dd name.txt";
    fake.put(big, `${'line\n'.repeat(120_000)}`); // > 512 KiB
    const { read } = build(fake);
    await read({ path: big });
    const windowed = fake.commands.find((command) => command.includes('awk'))!;
    expect(windowed).toContain("'/workspace/o'\\''dd name.txt'");
    expect(windowed.split("'/workspace/o'\\''dd name.txt'").join('')).not.toContain('dd name');

    const pic = '/workspace/$(touch y).bmp';
    fake.put(pic, bmp());
    await read({ path: pic });
    const convert = fake.commands.find((command) => command.includes('ffmpeg -v error -y -i'))!;
    expect(convert).toContain("-i '/workspace/$(touch y).bmp'");
    expect(convert.split("'/workspace/$(touch y).bmp'").join('')).not.toContain('touch y');
  });
});

describe('probe results', () => {
  it('a directory points at sandbox_list_files; a missing file and an unreadable one say so', async () => {
    const fake = fakeSandbox({ unreadable: ['/workspace/secret.txt'] });
    fake.dirs.add('/workspace/src');
    fake.put('/workspace/secret.txt', 'x');
    const { read } = build(fake);

    const dir = await read({ path: 'src' });
    expect(dir.isError).toBe(true);
    expect(textOf(dir)).toBe('/workspace/src is a directory — use sandbox_list_files to see what is in it.');

    const missing = await read({ path: 'nope.txt' });
    expect(missing.isError).toBe(true);
    expect(textOf(missing)).toBe('No such file: /workspace/nope.txt');

    const denied = await read({ path: 'secret.txt' });
    expect(denied.isError).toBe(true);
    expect(textOf(denied)).toMatch(/Permission denied/);
  });

  it('a probe that fails outright is an error naming the problem', async () => {
    const fake = fakeSandbox();
    (fake.runner.exec as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: 'sh: wc: not found' });
    const out = await build(fake).read({ path: 'a.txt' });
    expect(out.isError).toBe(true);
    expect(textOf(out)).toBe('Could not inspect /workspace/a.txt: sh: wc: not found');
  });

  it('scrubs a command\'s message before cutting it, and what the read throws', async () => {
    const fake = fakeSandbox();
    (fake.runner.exec as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: `${'e'.repeat(195)}hunter2` });
    const said = textOf(await build(fake).read({ path: 'a.txt' }));
    expect(said).toContain(`${'e'.repeat(195)}••••`);
    expect(said).not.toContain('hunt');

    class ExecError extends Error {
      constructor(message: string) {
        super(message);
        this.name = 'ExecError';
      }
    }
    (fake.runner.exec as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new ExecError('exec failed: token=hunter2'));
    const failure = await build(fake).read({ path: 'a.txt' }).catch((error: Error) => error) as Error;
    expect(failure.message).toBe('exec failed: token=••••');
    expect(failure.name).toBe('ExecError');
    const plain = new Error('The sandbox is not running (exec)');
    (fake.runner.exec as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(plain);
    await expect(build(fake).read({ path: 'a.txt' })).rejects.toBe(plain);
  });
});

// ── sandbox: text ───────────────────────────────────────────────────────────

describe('sandbox text', () => {
  it('numbers the lines, names the range, and scrubs secrets', async () => {
    const fake = fakeSandbox();
    fake.put('/workspace/a.txt', 'alpha\r\nbeta hunter2\n\ngamma\n');
    const out = await build(fake).read({ path: 'a.txt' });
    expect(textOf(out)).toBe([
      '[/workspace/a.txt — lines 1-4 of 4]',
      '     1\talpha',
      '     2\tbeta ••••',
      '     3\t',
      '     4\tgamma',
    ].join('\n'));
    expect(out.isError).toBeUndefined();
  });

  it('windows with offset and limit and says which offset continues', async () => {
    const fake = fakeSandbox();
    fake.put('/workspace/n.txt', Array.from({ length: 50 }, (_, i) => `row ${i + 1}`).join('\n'));
    const { read } = build(fake);

    const first = textOf(await read({ path: 'n.txt', limit: 10 }));
    expect(first.split('\n')[0]).toBe('[/workspace/n.txt — lines 1-10 of 50; continue with offset=11]');
    expect(first).toContain('    10\trow 10');
    expect(first).not.toContain('row 11');

    const last = textOf(await read({ path: 'n.txt', offset: 41 }));
    expect(last.split('\n')[0]).toBe('[/workspace/n.txt — lines 41-50 of 50]');
  });

  it('an offset past the end and an empty file', async () => {
    const fake = fakeSandbox();
    fake.put('/workspace/n.txt', 'a\nb\n');
    fake.put('/workspace/empty.txt', '');
    const { read } = build(fake);
    const past = await read({ path: 'n.txt', offset: 3 });
    expect(past.isError).toBe(true);
    expect(textOf(past)).toBe('offset 3 is past the end of /workspace/n.txt (2 lines).');
    expect(textOf(await read({ path: 'empty.txt' }))).toBe('[/workspace/empty.txt — empty file]');
  });

  it('cuts a very long line and stops at the character cap with a continue hint', async () => {
    const fake = fakeSandbox();
    fake.put('/workspace/long.txt', `${'x'.repeat(5000)}\nshort\n`);
    const long = textOf(await build(fake).read({ path: 'long.txt' }));
    expect(long).toContain(`${'x'.repeat(2000)}… [line truncated]`);
    expect(long).not.toContain('x'.repeat(2001));

    // Scrubbed before the cut: a secret across the cut is not left half showing.
    const across = fakeSandbox();
    across.put('/workspace/k.txt', `${'x'.repeat(1995)}hunter2\n`);
    const cut = textOf(await build(across).read({ path: 'k.txt' }));
    expect(cut).toContain(`${'x'.repeat(1995)}••••`);
    expect(cut).not.toContain('hunte');

    const wide = fakeSandbox();
    wide.put('/workspace/wide.txt', Array.from({ length: 1000 }, (_, i) => `${i}:${'y'.repeat(300)}`).join('\n'));
    const out = textOf(await build(wide).read({ path: 'wide.txt' }));
    expect(out.length).toBeLessThan(101_000);
    const header = out.split('\n')[0]!;
    expect(header).toMatch(/lines 1-\d+ of 1000; continue with offset=\d+\]$/);
  });

  it('a large file is windowed in the sandbox: only the window crosses, the scratch file is removed', async () => {
    const fake = fakeSandbox();
    const lines = Array.from({ length: 150_000 }, (_, i) => `l${i + 1}`);
    fake.put('/workspace/big.log', `${lines.join('\n')}\n`);
    expect(fake.files.get('/workspace/big.log')!.length).toBeGreaterThan(512 * 1024);
    const { read } = build(fake);

    const out = textOf(await read({ path: 'big.log', offset: 1000, limit: 3 }));

    expect(out).toBe([
      '[/workspace/big.log — lines 1000-1002 of 150000; continue with offset=1003]',
      '  1000\tl1000',
      '  1001\tl1001',
      '  1002\tl1002',
    ].join('\n'));
    expect(fake.reads).toHaveLength(1);
    expect(fake.reads[0]).toMatch(/^\/tmp\/\.cognipeer-read\/[0-9a-f]{8}\.txt$/);
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fake.removed).toEqual(fake.reads);

    const past = await read({ path: 'big.log', offset: 150_001 });
    expect(past.isError).toBe(true);
  });

  it('a small file is fetched whole, never windowed through the shell', async () => {
    const fake = fakeSandbox();
    fake.put('/workspace/s.txt', 'a\nb\n');
    await build(fake).read({ path: 's.txt' });
    expect(fake.commands.some((command) => command.includes('awk'))).toBe(false);
    expect(fake.reads).toEqual(['/workspace/s.txt']);
  });

  it('without a binary-safe read it falls back to the runner readFile for text', async () => {
    const fake = fakeSandbox({ readFileBytes: false });
    fake.put('/workspace/t.txt', 'héllo\n');
    const out = textOf(await build(fake).read({ path: 't.txt' }));
    expect(out).toContain('1\théllo');
  });
});

// ── sandbox: binary kinds ───────────────────────────────────────────────────

describe('sandbox binary files', () => {
  it('an archive, a file with NUL bytes, and audio are described, not dumped', async () => {
    const fake = fakeSandbox();
    fake.put('/workspace/a.zip', zip());
    fake.put('/workspace/data.bin', Buffer.concat([Buffer.from('abc'), Buffer.from([0, 1, 2]), Buffer.from('def')]));
    fake.put('/workspace/clip.wav', wav());
    const { read } = build(fake);

    const archive = textOf(await read({ path: 'a.zip' }));
    expect(archive).toContain('[/workspace/a.zip — binary application/zip, 1 KB]');
    expect(archive).toContain('unzip -l');
    expect(textOf(await read({ path: 'data.bin' }))).toContain('[/workspace/data.bin — binary unknown, 1 KB]');
    expect(textOf(await read({ path: 'clip.wav' }))).toMatch(/audio audio\/wav.*cannot be played/);
    expect(fake.reads).toEqual([]);
  });
});

// ── sandbox: images ─────────────────────────────────────────────────────────

describe('sandbox images', () => {
  it('shows a normal image as it is, with its dimensions', async () => {
    const fake = fakeSandbox();
    const data = png(800, 600, 4096);
    fake.put('/workspace/shot.png', data);
    const out = await build(fake).read({ path: 'shot.png' });

    expect(textOf(out)).toBe('[/workspace/shot.png — image image/png 800x600, 4 KB]');
    expect(images(out)).toEqual([{ type: 'image', data: data.toString('base64'), mimeType: 'image/png', name: 'shot.png', width: 800, height: 600 }]);
    expect(fake.commands.some((command) => command.includes('ffmpeg'))).toBe(false);
  });

  it('a model that cannot see images gets a note and the bytes are never transferred', async () => {
    const fake = fakeSandbox();
    fake.put('/workspace/shot.png', png(800, 600, 4096));
    const out = await build(fake, { modelTakesImages: false }).read({ path: 'shot.png' });
    expect(images(out)).toHaveLength(0);
    expect(textOf(out)).toMatch(/This model cannot view images/);
    expect(fake.reads).toEqual([]);
  });

  it('downscales a format a model request cannot carry (bmp) to a png', async () => {
    const fake = fakeSandbox({ convert: 'ffmpeg' });
    fake.put('/workspace/old.bmp', bmp());
    const out = await build(fake).read({ path: 'old.bmp' });

    expect(images(out)).toHaveLength(1);
    expect(images(out)[0]).toMatchObject({ mimeType: 'image/png', name: 'old.bmp', width: 1568, height: 980 });
    expect(textOf(out)).toBe('[/workspace/old.bmp — image image/png 1568x980, 1 KB, downscaled to fit]');
    const command = fake.commands.find((c) => c.includes('ffmpeg -v error -y -i'))!;
    expect(command).toContain('command -v convert');
    expect(command).toContain("-resize '1568x1568>'");
    // The converted file is cleaned up.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fake.removed.some((path) => /\.png$/.test(path))).toBe(true);
  });

  it('downscales a png over 5 MiB and one with a side over 7900 px', async () => {
    const fake = fakeSandbox();
    fake.put('/workspace/heavy.png', png(2000, 2000, 5 * 1024 * 1024 + 10));
    fake.put('/workspace/tall.png', png(100, 8000, 4096));
    fake.put('/workspace/ok.png', png(7900, 100, 4096));
    const { read } = build(fake);

    expect(textOf(await read({ path: 'heavy.png' }))).toContain('downscaled to fit');
    expect(textOf(await read({ path: 'tall.png' }))).toContain('downscaled to fit');
    expect(textOf(await read({ path: 'ok.png' }))).not.toContain('downscaled');
  });

  it('an image over 12 MiB goes straight to the downscale without being fetched', async () => {
    const fake = fakeSandbox();
    fake.put('/workspace/huge.png', png(9000, 9000, 12 * 1024 * 1024 + 1));
    const out = await build(fake).read({ path: 'huge.png' });
    expect(textOf(out)).toContain('downscaled to fit');
    expect(fake.reads).not.toContain('/workspace/huge.png');
  });

  it('without ffmpeg and ImageMagick (NOTOOL) it says how to resize it', async () => {
    const fake = fakeSandbox({ convert: 'none' });
    fake.put('/workspace/old.bmp', bmp());
    const out = await build(fake).read({ path: 'old.bmp' });
    expect(images(out)).toHaveLength(0);
    expect(textOf(out)).toContain('Resize it first, e.g. `ffmpeg -i in.png -vf scale=1568:-2 out.png`');
    expect(out.isError).toBeUndefined();
  });

  it('a converter that fails is reported with its error', async () => {
    const fake = fakeSandbox({ convert: 'fail' });
    fake.put('/workspace/old.bmp', bmp());
    const out = await build(fake).read({ path: 'old.bmp' });
    expect(images(out)).toHaveLength(0);
    expect(textOf(out)).toContain('Invalid data found');
  });

  it('what the tool returns is handed to the model as an image by the adapter', async () => {
    const fake = fakeSandbox();
    fake.put('/workspace/shot.png', png(800, 600, 4096));
    const { read, store } = build(fake);
    const adapted = JSON.parse(adaptToolResult(await read({ path: 'shot.png' }), { store, modelTakesImages: true, maxImageBytes: 5 * 1024 * 1024 }) as string);
    expect(adapted.attachedImages[0]).toMatchObject({ name: 'shot.png', mimeType: 'image/png', width: 800, height: 600 });
    expect(store.get(adapted.attachedImages[0].fileId)).not.toBeNull();
  });
});

// ── sandbox: video ──────────────────────────────────────────────────────────

describe('sandbox video', () => {
  it('builds ONE contact sheet: frames at the middle of equal slices, in the right grid', async () => {
    const fake = fakeSandbox({ duration: '12.0\n' });
    fake.put('/workspace/run.mp4', mp4());
    const out = await build(fake).read({ path: 'run.mp4', frames: 4 });

    expect(textOf(out)).toBe('[/workspace/run.mp4 — video 12s; contact sheet of 4 frames at 1.5, 4.5, 7.5, 10.5s, left to right, top to bottom]');
    expect(images(out)).toHaveLength(1);
    expect(images(out)[0]).toMatchObject({ mimeType: 'image/png', name: 'run.mp4-sheet.png', width: 960, height: 540 });
    const command = fake.commands.find((c) => c.includes('tile='))!;
    expect(command).toContain('tile=2x2');
    for (const t of ['1.500', '4.500', '7.500', '10.500']) expect(command).toContain(`-ss ${t} -i '/workspace/run.mp4'`);
    expect(command).toMatch(/-f0\.png.*-f1\.png.*-f2\.png.*-f3\.png/);
    expect(command).toContain('-framerate 1 -i');
    expect(command).toContain('-f%d.png');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fake.removed.length).toBe(5); // four frames and the sheet
  });

  it('defaults to 6 frames (3x2), caps at 12 (4x3)', async () => {
    const fake = fakeSandbox({ duration: '60' });
    fake.put('/workspace/v.mp4', mp4());
    const { read } = build(fake);
    await read({ path: 'v.mp4' });
    expect(fake.commands.find((c) => c.includes('tile='))).toContain('tile=3x2');
    fake.commands.length = 0;
    await read({ path: 'v.mp4', frames: 12 });
    expect(fake.commands.find((c) => c.includes('tile='))).toContain('tile=4x3');
  });

  it('without a container duration it counts packets / frame rate', async () => {
    const fake = fakeSandbox({ duration: 'N/A\n', packets: '30/1,150\n' });
    fake.put('/workspace/v.mp4', mp4());
    const out = await build(fake).read({ path: 'v.mp4', frames: 2 });
    expect(textOf(out)).toContain('video 5s; contact sheet of 2 frames at 1.3, 3.8s');
  });

  it('with no usable duration it samples the first 5 seconds', async () => {
    const fake = fakeSandbox({ duration: '', packets: '' });
    fake.put('/workspace/v.mp4', mp4());
    const out = await build(fake).read({ path: 'v.mp4', frames: 1 });
    expect(textOf(out)).toBe('[/workspace/v.mp4 — video, duration unknown; contact sheet of 1 frame from the first 5s at 2.5s, left to right, top to bottom]');
  });

  it('without ffmpeg it says how to get it; a model without image input gets a note first', async () => {
    const fake = fakeSandbox({ video: false });
    fake.put('/workspace/v.mp4', mp4());
    const none = await build(fake).read({ path: 'v.mp4' });
    expect(images(none)).toHaveLength(0);
    expect(textOf(none)).toContain('apt-get install -y ffmpeg');
    expect(textOf(none)).toContain('web-e2e');

    const blind = fakeSandbox();
    blind.put('/workspace/v.mp4', mp4());
    const note = await build(blind, { modelTakesImages: false }).read({ path: 'v.mp4' });
    expect(textOf(note)).toMatch(/cannot view images/);
    expect(blind.commands).toHaveLength(1); // only the probe
  });
});

// ── sandbox: pdf ────────────────────────────────────────────────────────────

describe('sandbox pdf', () => {
  it('a short PDF comes back as text, a section per page', async () => {
    const fake = fakeSandbox({ pdfPages: 2, pageTexts: ['A'.repeat(60), 'B'.repeat(60)] });
    fake.put('/workspace/d.pdf', pdf());
    const out = await build(fake).read({ path: 'd.pdf' });
    expect(textOf(out)).toBe([
      '[/workspace/d.pdf — PDF, 2 pages; pages 1-2]',
      `--- page 1 ---\n${'A'.repeat(60)}`,
      `--- page 2 ---\n${'B'.repeat(60)}`,
    ].join('\n'));
    expect(images(out)).toHaveLength(0);
    expect(fake.commands.some((c) => c.includes('pdftoppm'))).toBe(false);
  });

  it('more than 10 pages without pages asks for pages and runs nothing else', async () => {
    const fake = fakeSandbox({ pdfPages: 40 });
    fake.put('/workspace/d.pdf', pdf());
    const out = await build(fake).read({ path: 'd.pdf' });
    expect(out.isError).toBeUndefined();
    expect(textOf(out)).toBe('This PDF has 40 pages. Call read again with pages (for example pages="1-5"); at most 20 pages per call.');
    expect(fake.commands.some((c) => c.includes('pdftotext'))).toBe(false);
  });

  it('validates pages: bad form, out of range, reversed, more than 20 pages', async () => {
    const fake = fakeSandbox({ pdfPages: 40 });
    fake.put('/workspace/d.pdf', pdf());
    const { read } = build(fake);
    for (const [pages, message] of [
      ['abc', /must be a page number or a range/],
      ['0', /out of range: this PDF has 40 pages/],
      ['5-3', /out of range/],
      ['38-45', /out of range/],
      ['1-21', /At most 20 pages per call/],
    ] as const) {
      const out = await read({ path: 'd.pdf', pages });
      expect(out.isError).toBe(true);
      expect(textOf(out)).toMatch(message);
    }
    const fine = await read({ path: 'd.pdf', pages: '1-20' });
    expect(fine.isError).toBeUndefined();
    expect(textOf(fine)).toContain('[/workspace/d.pdf — PDF, 40 pages; pages 1-20]');
    const single = textOf(await read({ path: 'd.pdf', pages: '7' }));
    expect(single).toContain('pages 7-7]');
    expect(fake.commands.find((c) => c.includes('-f 7 -l 7'))).toBeDefined();
  });

  it('auto: pages with (almost) no text are shown as images, the others only as text', async () => {
    const fake = fakeSandbox({ pdfPages: 4, pageTexts: ['T'.repeat(100), '', 'tiny', 'U'.repeat(100)] });
    fake.put('/workspace/scan.pdf', pdf());
    const out = await build(fake).read({ path: 'scan.pdf' });

    expect(images(out).map((image) => image.name)).toEqual(['page-2.png', 'page-3.png']);
    const body = textOf(out);
    expect(body).toContain('--- page 2 ---\n(page 2 is shown as an image)');
    expect(body).toContain('--- page 3 ---\n(page 3 is shown as an image)\ntiny');
    expect(body).not.toContain('(page 1 is shown');
    const render = fake.commands.find((c) => c.includes('pdftoppm'))!;
    expect(render).toContain('for k in 2 3;');
    expect(render).toContain('-png -r 110 -scale-to 1400 -singlefile');
    expect(render.split('pdftoppm').length - 1).toBe(1); // one exec for every page
  });

  it('auto caps the page images at 6', async () => {
    const fake = fakeSandbox({ pdfPages: 10, pageTexts: [] });
    fake.put('/workspace/blank.pdf', pdf());
    // every page has the default "text of page N" (14 chars < 40): all are sparse
    const out = await build(fake).read({ path: 'blank.pdf' });
    expect(images(out)).toHaveLength(6);
  });

  it("view 'images' shows every requested page (at most 10); view 'text' none", async () => {
    const fake = fakeSandbox({ pdfPages: 30, pageTexts: Array.from({ length: 30 }, () => 'Z'.repeat(100)) });
    fake.put('/workspace/d.pdf', pdf());
    const { read } = build(fake);

    const all = await read({ path: 'd.pdf', pages: '1-12', view: 'images' });
    expect(images(all)).toHaveLength(10);
    expect(textOf(all)).toContain('Only the first 10 of the 12 requested pages are shown as images.');

    const some = await read({ path: 'd.pdf', pages: '2-3', view: 'images' });
    expect(images(some).map((image) => image.name)).toEqual(['page-2.png', 'page-3.png']);

    fake.commands.length = 0;
    const text = await read({ path: 'd.pdf', pages: '1-3', view: 'text' });
    expect(images(text)).toHaveLength(0);
    expect(fake.commands.some((c) => c.includes('pdftoppm'))).toBe(false);
  });

  it('a model that cannot see images gets the text and a note about the blank pages', async () => {
    const fake = fakeSandbox({ pdfPages: 2, pageTexts: ['', 'V'.repeat(100)] });
    fake.put('/workspace/d.pdf', pdf());
    const out = await build(fake, { modelTakesImages: false }).read({ path: 'd.pdf' });
    expect(images(out)).toHaveLength(0);
    expect(textOf(out)).toContain('1 page (1) has little or no text, and this model cannot view images.');
    expect(fake.commands.some((c) => c.includes('pdftoppm'))).toBe(false);
  });

  it('caps the text at 100000 characters and says which pages continue', async () => {
    const fake = fakeSandbox({ pdfPages: 8, pageTexts: Array.from({ length: 8 }, () => 'W'.repeat(30_000)) });
    fake.put('/workspace/d.pdf', pdf());
    const out = textOf(await build(fake).read({ path: 'd.pdf' }));
    expect(out.split('\n')[0]).toBe('[/workspace/d.pdf — PDF, 8 pages; pages 1-3; continue with pages="4-8"]');
    expect(out.length).toBeLessThan(100_100);
  });

  it('scrubs secrets from the text', async () => {
    const fake = fakeSandbox({ pdfPages: 1, pageTexts: ['password is hunter2 and this page has enough text to count'] });
    fake.put('/workspace/d.pdf', pdf());
    expect(textOf(await build(fake).read({ path: 'd.pdf' }))).toContain('password is •••• and');
  });

  it('without poppler it reads the text with pdfplumber (python -I from /), and has no page images', async () => {
    const fake = fakeSandbox({ pdfPages: null, python: true, pageTexts: ['', 'X'.repeat(100)] });
    fake.put('/workspace/d.pdf', pdf());
    // the fake says the PDF has 12 pages via the count run; ask for a range
    const out = await build(fake).read({ path: 'd.pdf', pages: '1-2' });

    expect(textOf(out)).toContain('[/workspace/d.pdf — PDF, 12 pages; pages 1-2]');
    expect(textOf(out)).toContain('--- page 2 ---');
    expect(textOf(out)).toContain('Page images need poppler-utils in the sandbox; only the text is shown.');
    expect(images(out)).toHaveLength(0);
    const python = fake.commands.filter((c) => c.includes('python3 -I'));
    expect(python).toHaveLength(2); // the count, then the text
    expect(python[1]).toContain('cd / && python3 -I - \'/workspace/d.pdf\' 1 2 "$o" <<\'PY\'');
    expect(python[1]).toContain('import pdfplumber');
  });

  it('without poppler and without python/pdfplumber it says which package to install', async () => {
    const fake = fakeSandbox({ pdfPages: null, python: false });
    fake.put('/workspace/d.pdf', pdf());
    const out = await build(fake).read({ path: 'd.pdf' });
    expect(textOf(out)).toContain('No PDF tools in this sandbox (install poppler-utils');
  });

  it('a PDF poppler cannot open is an error, not a crash', async () => {
    const fake = fakeSandbox({ pdfPages: 0 });
    fake.put('/workspace/d.pdf', pdf());
    const out = await build(fake).read({ path: 'd.pdf' });
    expect(out.isError).toBe(true);
    expect(textOf(out)).toMatch(/Could not read \/workspace\/d.pdf as a PDF/);
  });
});

// ── session files ───────────────────────────────────────────────────────────

describe('session files (fileId)', () => {
  const record = (id: string, name: string, contentType: string, size = 100) => {
    sessionFiles.records.set(id, { _id: id, name, contentType, size });
  };

  it('a sendable image becomes an image block that points at the file (no bytes copied)', async () => {
    record('img1', 'cat.png', 'image/png', 2048);
    const out = await build(null, { session: true }).read({ fileId: 'img1' });
    expect(textOf(out)).toBe('[cat.png — image image/png, 2 KB]');
    expect(images(out)).toEqual([{ type: 'image', fileId: 'img1', name: 'cat.png', mimeType: 'image/png' }]);
  });

  it('image/jpg is folded to image/jpeg; a model without image input gets a note', async () => {
    record('img2', 'p.jpg', 'image/jpg');
    const { read } = build(null, { session: true });
    expect(images(await read({ fileId: 'img2' }))[0]!.mimeType).toBe('image/jpeg');
    const blind = await build(null, { session: true, modelTakesImages: false }).read({ fileId: 'img2' });
    expect(images(blind)).toHaveLength(0);
    expect(textOf(blind)).toMatch(/cannot view images/);
  });

  it('an image in a format the model cannot be shown is said so', async () => {
    record('tif', 'scan.tiff', 'image/tiff');
    const out = await build(null, { session: true }).read({ fileId: 'tif' });
    expect(images(out)).toHaveLength(0);
    expect(textOf(out)).toBe('"scan.tiff" is an image in a format (image/tiff) the model cannot be shown; it has no text to read.');
  });

  describe('a picture OCR read at upload', () => {
    const ocrRecord = (id: string, name: string, contentType: string) => {
      sessionFiles.records.set(id, { _id: id, name, contentType, size: 100, markdownStatus: 'succeeded', markdownKey: `${id}.md` });
    };

    it('is still shown to a model that sees images', async () => {
      ocrRecord('p1', 'form.png', 'image/png');
      sessionFiles.texts.set('p1', 'Name: Ada');
      const out = await build(null, { session: true }).read({ fileId: 'p1' });
      expect(images(out)).toEqual([{ type: 'image', fileId: 'p1', name: 'form.png', mimeType: 'image/png' }]);
    });

    it('is read as text by a model that cannot see images', async () => {
      ocrRecord('p2', 'form.png', 'image/png');
      sessionFiles.texts.set('p2', 'Name: Ada\nCity: Izmir');
      const out = await build(null, { session: true, modelTakesImages: false }).read({ fileId: 'p2' });
      expect(images(out)).toHaveLength(0);
      expect(textOf(out)).toContain('     2\tCity: Izmir');
    });

    it('a format no provider takes (tiff) is read as text', async () => {
      ocrRecord('p3', 'scan.tiff', 'image/tiff');
      sessionFiles.texts.set('p3', 'Scanned');
      expect(textOf(await build(null, { session: true }).read({ fileId: 'p3' }))).toContain('Scanned');
    });

    it('with no text found, keeps saying the picture cannot be seen or read', async () => {
      ocrRecord('p4', 'blank.png', 'image/png');
      sessionFiles.texts.set('p4', '  ');
      const blind = await build(null, { session: true, modelTakesImages: false }).read({ fileId: 'p4' });
      expect(textOf(blind)).toBe('[blank.png — image image/png, 1 KB] This model cannot view images, and OCR found no text in it.');
      ocrRecord('p5', 'blank.tiff', 'image/tiff');
      sessionFiles.texts.set('p5', '');
      expect(textOf(await build(null, { session: true }).read({ fileId: 'p5' }))).toContain('OCR found no text in it.');
    });
  });

  it('a document is read as numbered lines, windowed like sandbox text', async () => {
    record('doc1', 'notes.md', 'text/markdown');
    sessionFiles.texts.set('doc1', Array.from({ length: 30 }, (_, i) => `note ${i + 1}`).join('\n'));
    const { read } = build(null, { session: true });
    const first = textOf(await read({ fileId: 'doc1', limit: 5 }));
    expect(first.split('\n')[0]).toBe('[notes.md — lines 1-5 of 30; continue with offset=6]');
    expect(first).toContain('     5\tnote 5');
    const rest = textOf(await read({ fileId: 'doc1', offset: 26 }));
    expect(rest.split('\n')[0]).toBe('[notes.md — lines 26-30 of 30]');
    const past = await read({ fileId: 'doc1', offset: 31 });
    expect(past.isError).toBe(true);
    expect(textOf(past)).toBe('offset 31 is past the end of "notes.md" (30 lines).');
  });

  it('caps one read at the agent page size in characters', async () => {
    record('doc2', 'wide.txt', 'text/plain');
    sessionFiles.texts.set('doc2', Array.from({ length: 200 }, (_, i) => `${i}:${'q'.repeat(500)}`).join('\n'));
    const out = textOf(await build(null, { session: true }).read({ fileId: 'doc2' }));
    expect(out.length).toBeLessThan(20_700);
    expect(out.split('\n')[0]).toMatch(/lines 1-\d+ of 200; continue with offset=\d+\]$/);
  });

  it('pages and view on a session file add a note: page images are for sandbox files', async () => {
    record('doc3', 'a.pdf', 'application/pdf');
    sessionFiles.texts.set('doc3', 'converted text');
    const out = textOf(await build(null, { session: true }).read({ fileId: 'doc3', pages: '1-2' }));
    expect(out.split('\n')[0]).toBe('pages and view (page images) work on sandbox files only; this file is read as text.');
    expect(out).toContain('1\tconverted text');
  });

  it('no text form, an empty file, a failed read and an unknown id', async () => {
    record('bin', 'data.bin', 'application/octet-stream');
    record('empty', 'e.txt', 'text/plain');
    sessionFiles.texts.set('empty', '');
    const { read } = build(null, { session: true });

    expect(textOf(await read({ fileId: 'bin' }))).toBe('"data.bin" has no text form (application/octet-stream).');
    expect(textOf(await read({ fileId: 'empty' }))).toBe('[e.txt — empty file]');

    sessionFiles.failRead = true;
    record('doc4', 'x.txt', 'text/plain');
    const failed = await read({ fileId: 'doc4' });
    expect(failed.isError).toBe(true);
    expect(textOf(failed)).toBe('The file could not be read right now.');

    const missing = await read({ fileId: 'ghost' });
    expect(missing.isError).toBe(true);
    expect(textOf(missing)).toBe('File "ghost" is not attached to this conversation. Use session_files_list to see the files.');
  });
});

describe('tool-media ids (tm_…)', () => {
  it('shows an image an earlier tool result showed, by reference to the run store', async () => {
    const store = createToolMediaStore();
    const stored = store.put({ base64: 'QUJD', mediaType: 'image/png', name: 'shot.png' });
    const out = await build(null, { session: true, media: store }).read({ fileId: stored.id });
    expect(images(out)).toEqual([{ type: 'image', fileId: stored.id, name: 'shot.png', mimeType: 'image/png' }]);
    expect(textOf(out)).toBe('[shot.png — image image/png, 1 KB]');
  });

  it('a tm_ id that is gone (evicted, or from an earlier turn) is an error that says what to do', async () => {
    const out = await build(null, { session: true }).read({ fileId: 'tm_7_abcdef' });
    expect(out.isError).toBe(true);
    expect(textOf(out)).toBe('That image is no longer available — read or capture it again.');
  });

  it('a model without image input gets a note for a tm_ id too', async () => {
    const store = createToolMediaStore();
    const stored = store.put({ base64: 'QUJD', mediaType: 'image/png', name: 'shot.png' });
    const out = await build(null, { session: true, media: store, modelTakesImages: false }).read({ fileId: stored.id });
    expect(images(out)).toHaveLength(0);
    expect(textOf(out)).toMatch(/cannot view images/);
  });
});
