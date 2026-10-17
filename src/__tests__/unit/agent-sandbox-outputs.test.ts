import { Buffer } from 'node:buffer';
import { describe, expect, it, vi } from 'vitest';
import {
  collectSandboxOutputs,
  outputFileName,
  parseStatListing,
  scrubTextFile,
  readBytesViaExec,
  withSandboxOutputsPrompt,
  type OutputEntry,
} from '@/lib/services/agents/agentSandboxOutputs';
import { toClientOutputFiles, toFileAnnotations } from '@/lib/services/agents/clientWire';

const att = (name: string, size: number) => ({ fileId: `f_${name}`, name, mimeType: 'text/plain', size, origin: 'agent_output' as const });

function deps(entries: OutputEntry[], over: Record<string, unknown> = {}) {
  const store = vi.fn(async (f: { name: string; data: Buffer }) => att(f.name, f.data.length));
  return {
    store,
    d: {
      list: async () => entries,
      readBytes: async (e: OutputEntry) => Buffer.alloc(e.size, 1),
      store,
      seen: {} as Record<string, string>,
      maxFileBytes: 1000,
      ...over,
    },
  };
}

describe('collectSandboxOutputs', () => {
  it('stores new files and names them from the path', async () => {
    const { d, store } = deps([{ path: '/outputs/sub/report.csv', size: 5, mtime: 10 }]);
    const r = await collectSandboxOutputs(d);
    expect(r.attachments).toHaveLength(1);
    expect(store.mock.calls[0]![0]).toMatchObject({ name: 'sub_report.csv' });
    expect(r.seen['/outputs/sub/report.csv']).toBe('5:10');
  });

  it('does not re-save an unchanged file but saves a changed one', async () => {
    const { d, store } = deps([{ path: '/outputs/a.txt', size: 5, mtime: 10 }, { path: '/outputs/b.txt', size: 6, mtime: 20 }],
      { seen: { '/outputs/a.txt': '5:10', '/outputs/b.txt': '6:19' } });
    const r = await collectSandboxOutputs(d);
    expect(r.attachments.map((a) => a.name)).toEqual(['b.txt']);
    expect(store).toHaveBeenCalledTimes(1);
  });

  it('dedupes by content hash when the sandbox reports no mtime', async () => {
    const first = deps([{ path: '/outputs/a.bin', size: 4 }]);
    const r1 = await collectSandboxOutputs(first.d);
    const second = deps([{ path: '/outputs/a.bin', size: 4 }], { seen: r1.seen });
    expect((await collectSandboxOutputs(second.d)).attachments).toHaveLength(0);
  });

  it('caps files per turn and skips oversize or empty files', async () => {
    const entries = Array.from({ length: 5 }, (_, i) => ({ path: `/outputs/f${i}.txt`, size: 3, mtime: 1 }));
    entries.push({ path: '/outputs/big.bin', size: 5000, mtime: 1 }, { path: '/outputs/empty.txt', size: 0, mtime: 1 });
    const { d } = deps(entries, { maxFiles: 2 });
    const r = await collectSandboxOutputs(d);
    expect(r.attachments).toHaveLength(2);
    expect(r.warnings.join(' ')).toMatch(/rest were not delivered/);
    const { d: d2 } = deps(entries.slice(5));
    const r2 = await collectSandboxOutputs(d2);
    expect(r2.attachments).toHaveLength(0);
    expect(r2.warnings.join(' ')).toMatch(/larger than/);
  });

  it('isolates failures: a bad file or a failed listing never throws', async () => {
    const { d } = deps([{ path: '/outputs/a.txt', size: 3, mtime: 1 }, { path: '/outputs/b.txt', size: 3, mtime: 1 }], {
      readBytes: async (e: OutputEntry) => { if (e.path.endsWith('a.txt')) throw new Error('boom'); return Buffer.alloc(3, 1); },
    });
    const r = await collectSandboxOutputs(d);
    expect(r.attachments.map((a) => a.name)).toEqual(['b.txt']);
    expect(r.warnings[0]).toMatch(/a\.txt.*boom/);
    const failing = await collectSandboxOutputs({ ...d, list: async () => { throw new Error('no sandbox'); } });
    expect(failing.attachments).toEqual([]);
    expect(failing.warnings[0]).toMatch(/no sandbox/);
  });

  it('scrubs text files before they are stored and leaves binary files alone', async () => {
    const bytes: Record<string, Buffer> = {
      '/outputs/a.txt': Buffer.from('key=top-secret-1 and top-secret-1'),
      '/outputs/b.png': Buffer.concat([Buffer.from([0x89, 0, 1]), Buffer.from('top-secret-1')]),
      '/outputs/c.csv': Buffer.from('nothing here'),
    };
    const entries = Object.entries(bytes).map(([path, data]) => ({ path, size: data.length, mtime: 1 }));
    const scrub = (text: string) => text.split('top-secret-1').join('••••••');
    const { d, store } = deps(entries, { readBytes: async (e: OutputEntry) => bytes[e.path]!, scrub });
    await collectSandboxOutputs(d);
    const stored = Object.fromEntries(store.mock.calls.map(([f]) => [f.name, f.data]));
    expect(stored['a.txt']!.toString('utf8')).toBe('key=•••••• and ••••••');
    expect(stored['b.png']!.equals(bytes['/outputs/b.png']!)).toBe(true);
    expect(stored['c.csv']!.toString('utf8')).toBe('nothing here');
  });

  it('scrubTextFile treats invalid UTF-8 as binary and returns an unchanged file as is', () => {
    const scrub = (t: string) => t.replace('x', 'y');
    const invalid = Buffer.from([0xff, 0xfe, 0x78]);
    expect(scrubTextFile(invalid, scrub)).toBe(invalid);
    const plain = Buffer.from('no match');
    expect(scrubTextFile(plain, scrub)).toBe(plain);
  });

  it('ignores paths outside /outputs', async () => {
    const { d } = deps([{ path: '/etc/passwd', size: 3, mtime: 1 }, { path: '/outputs/../etc/x', size: 3, mtime: 1 }]);
    expect((await collectSandboxOutputs(d)).attachments).toHaveLength(0);
  });
});

describe('helpers', () => {
  it('parses stat listings', () => {
    expect(parseStatListing('12|34|/outputs/a b.txt\ngarbage\n')).toEqual([{ mtime: 12, size: 34, path: '/outputs/a b.txt' }]);
    expect(outputFileName('/outputs/x/y.png')).toBe('x_y.png');
  });

  it('reads binary files byte-exactly in chunks', async () => {
    const bytes = Buffer.from(Array.from({ length: 40_000 }, (_, i) => (i * 7) % 256));
    const exec = vi.fn(async (command: string) => {
      const off = Number(/tail -c \+(\d+)/.exec(command)![1]) - 1;
      return { exitCode: 0, stdout: `${bytes.subarray(off, off + 18_000).toString('base64')}\n`, stderr: '' };
    });
    const out = await readBytesViaExec(exec, "/outputs/it's.bin", bytes.length);
    expect(out.equals(bytes)).toBe(true);
    expect(exec).toHaveBeenCalledTimes(3);
    expect(exec.mock.calls[0]![0]).toContain(`'/outputs/it'\\''s.bin'`);
  });

  it('adds the prompt section', () => {
    expect(withSandboxOutputsPrompt('Be nice.')).toMatch(/^Be nice\.\n\n## Files for the user[\s\S]*\/outputs\//);
    expect(withSandboxOutputsPrompt(undefined)).toMatch(/^## Files for the user/);
  });
});

describe('wire', () => {
  it('maps only agent outputs to output_files and file_path annotations', () => {
    const files = toClientOutputFiles('conv1', [att('r.pdf', 9), { fileId: 'u1', name: 'upload.txt', mimeType: 'text/plain', size: 1 }]);
    expect(files).toEqual([{ id: 'f_r.pdf', name: 'r.pdf', mime_type: 'text/plain', size: 9, download_url: '/client/v1/agents/sessions/conv1/files/f_r.pdf/content' }]);
    expect(toFileAnnotations(files)).toEqual([{ type: 'file_path', file_id: 'f_r.pdf', filename: 'r.pdf' }]);
    expect(toClientOutputFiles('c', undefined)).toEqual([]);
  });
});
