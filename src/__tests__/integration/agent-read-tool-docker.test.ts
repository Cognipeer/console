/**
 * The `read` tool against a REAL sandbox container (docker exec).
 *
 * Opt-in: set READ_TOOL_DOCKER_IMAGE to an image that has the toolbox the read
 * tool uses (cognipeer/sandbox-base with poppler, optionally ffmpeg), e.g.
 *
 *   READ_TOOL_DOCKER_IMAGE=cognipeer/sandbox-base:tool-media-test \
 *     npx vitest run src/__tests__/integration/agent-read-tool-docker.test.ts --maxWorkers=1
 *
 * READ_TOOL_DOCKER_WEB_E2E=1 additionally runs the UI-test loop proof (needs the
 * web-e2e image: global Playwright + Chromium + ffmpeg).
 *
 * The test starts its own container (`cpr-readtool-<random>`) and removes only that.
 */

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { Buffer } from 'node:buffer';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createTool } from '@cognipeer/agent-sdk';
import type { AgentSandboxRunner } from '@/enterprise/registry';

// The sandbox flows never touch the conversation's files.
vi.mock('@/lib/services/agents/sessionFiles', () => ({
  findSessionFileRecord: vi.fn(async () => null),
  readFileText: vi.fn(async () => null),
}));

import { buildReadTool } from '@/lib/services/agents/readTool';
import { createToolMediaStore } from '@/lib/services/agents/toolMedia';
import { isToolOutput, type ToolContentBlock, type ToolOutput } from '@/lib/services/tools/toolOutput';
import { imageDimensions, sniffMedia } from '@/lib/services/tools/mediaSniff';

const IMAGE = process.env.READ_TOOL_DOCKER_IMAGE;
const WEB_E2E = process.env.READ_TOOL_DOCKER_WEB_E2E === '1';
const NAME = `cpr-readtool-${randomBytes(4).toString('hex')}`;

// ── docker plumbing ─────────────────────────────────────────────────────────

interface Proc { code: number; stdout: Buffer; stderr: Buffer }

function docker(args: string[], stdin?: Buffer, timeoutMs = 120_000): Promise<Proc> {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`docker ${args.slice(0, 3).join(' ')} timed out`)); }, timeoutMs);
    child.stdout.on('data', (c: Buffer) => out.push(c));
    child.stderr.on('data', (c: Buffer) => err.push(c));
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code: code ?? -1, stdout: Buffer.concat(out), stderr: Buffer.concat(err) }); });
    child.stdin.on('error', () => undefined);
    if (stdin) child.stdin.end(stdin); else child.stdin.end();
  });
}

const sh = (command: string, timeoutMs?: number) => docker(['exec', NAME, 'bash', '-lc', command], undefined, timeoutMs);

/** Writes bytes to a path of the container (the path is a positional argument, never interpolated). */
async function put(path: string, data: Buffer | string): Promise<void> {
  const res = await docker(['exec', '-i', NAME, 'bash', '-c', 'mkdir -p "$(dirname "$1")" && cat > "$1"', '_', path], Buffer.from(data));
  if (res.code !== 0) throw new Error(`put ${path}: ${res.stderr.toString()}`);
}

type Ref = Parameters<AgentSandboxRunner['exec']>[0];
type ExecInput = Parameters<AgentSandboxRunner['exec']>[2];

const runner: AgentSandboxRunner = {
  async exec(_ref: Ref, _instance: string, input: ExecInput) {
    const res = await docker(['exec', NAME, 'bash', '-lc', input.command], undefined, ((input.timeoutSec ?? 30) + 5) * 1000);
    return { exitCode: res.code, stdout: res.stdout.toString('utf8'), stderr: res.stderr.toString('utf8') };
  },
  async readFile(_ref: Ref, _instance: string, path: string) {
    const res = await docker(['exec', NAME, 'cat', path]);
    if (res.code !== 0) throw new Error(res.stderr.toString());
    return res.stdout.toString('utf8');
  },
  async readFileBytes(_ref: Ref, _instance: string, path: string) {
    const res = await docker(['exec', NAME, 'cat', path]);
    if (res.code !== 0) throw new Error(res.stderr.toString());
    return res.stdout;
  },
} as unknown as AgentSandboxRunner;

function buildRead() {
  const tool = buildReadTool({
    createToolFn: createTool,
    zod: z,
    guard: { protect: (_spec, execute) => execute as never },
    sandbox: {
      runner,
      ref: { tenantDbName: 't', tenantId: 't', projectId: 'p', agentKey: 'a' },
      getInstance: async () => 'inst',
      resolvePath: (p: string) => (p.startsWith('/') ? p : `/workspace/${p}`),
      scrub: (t: string) => t,
    },
    media: { store: createToolMediaStore() },
    modelTakesImages: true,
  });
  if (!tool) throw new Error('no read tool');
  return async (args: Record<string, unknown>): Promise<ToolOutput> => {
    const result = await (tool as unknown as { invoke: (a: Record<string, unknown>) => Promise<unknown> }).invoke(args);
    expect(isToolOutput(result)).toBe(true);
    return result as ToolOutput;
  };
}

const textOf = (out: ToolOutput) => out.content.filter((b): b is Extract<ToolContentBlock, { type: 'text' }> => b.type === 'text').map((b) => b.text).join('\n');
const imagesOf = (out: ToolOutput) => out.content.filter((b): b is Extract<ToolContentBlock, { type: 'image' }> => b.type === 'image');

// ── fixtures generated in-test ──────────────────────────────────────────────

const CRC = (() => {
  const table: number[] = [];
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table.push(c >>> 0);
  }
  return table;
})();
function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
/** A solid-colour RGB PNG; compresses to almost nothing even when it is huge. */
function solidPng(width: number, height: number, rgb: [number, number, number]): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2;
  const row = Buffer.alloc(1 + width * 3);
  for (let x = 0; x < width; x += 1) { row[1 + x * 3] = rgb[0]; row[2 + x * 3] = rgb[1]; row[3 + x * 3] = rgb[2]; }
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

/** A hand-written PDF: one text page per entry, `null` = a blank page. */
function buildPdf(pages: Array<string | null>): Buffer {
  const objects: string[] = [];
  const pageIds = pages.map((_, i) => 4 + i * 2);
  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[2] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pages.length} >>`;
  objects[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';
  pages.forEach((content, i) => {
    const pageId = 4 + i * 2;
    const stream = content === null ? '' : `BT /F1 18 Tf 50 700 Td (${content}) Tj ET`;
    objects[pageId] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${pageId + 1} 0 R >>`;
    objects[pageId + 1] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  });
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (let id = 1; id < objects.length; id += 1) {
    offsets[id] = Buffer.byteLength(out, 'latin1');
    out += `${id} 0 obj\n${objects[id]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let id = 1; id < objects.length; id += 1) out += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

// ── the tests ───────────────────────────────────────────────────────────────

describe.skipIf(!IMAGE)('read tool against a real container', () => {
  let read: ReturnType<typeof buildRead>;
  let hasFfmpeg = false;
  let hasPoppler = false;
  const timings: Record<string, number> = {};

  const timed = async <T>(label: string, fn: () => Promise<T>): Promise<T> => {
    const start = Date.now();
    try { return await fn(); } finally { timings[label] = Date.now() - start; }
  };

  beforeAll(async () => {
    const run = await docker(['run', '-d', '--name', NAME, IMAGE!, 'sleep', 'infinity'], undefined, 300_000);
    if (run.code !== 0) throw new Error(`docker run failed: ${run.stderr.toString()}`);
    expect((await sh('mkdir -p /workspace/out')).code).toBe(0);
    hasFfmpeg = (await sh('command -v ffmpeg && command -v ffprobe')).code === 0;
    hasPoppler = (await sh('command -v pdfinfo && command -v pdftoppm && command -v pdftotext')).code === 0;
    console.info(`[read-tool-docker] image=${IMAGE} ffmpeg=${hasFfmpeg} poppler=${hasPoppler} container=${NAME}`);
    read = buildRead();
  }, 360_000);

  afterAll(async () => {
    // Only the container this test created.
    await docker(['rm', '-fv', NAME]);
    console.info(`[read-tool-docker] timings(ms) ${JSON.stringify(timings)}`);
  }, 60_000);

  it('windows a text file with line numbers and continues with offset', async () => {
    const lines = Array.from({ length: 5000 }, (_, i) => `line ${i + 1} of the file`);
    await put('/workspace/lines.txt', `${lines.join('\n')}\n`);
    const out = await timed('text-window', () => read({ path: 'lines.txt', offset: 10, limit: 5 }));
    const t = textOf(out);
    expect(out.isError).toBeFalsy();
    expect(t).toContain('lines 10-14 of 5000; continue with offset=15');
    expect(t).toContain('    10\tline 10 of the file');
    expect(t).toContain('    14\tline 14 of the file');
    expect(t).not.toContain('line 15 of the file');
    expect(t).not.toContain('line 9 of the file');
  }, 60_000);

  it('windows a file bigger than 512 KiB inside the sandbox', async () => {
    const lines = Array.from({ length: 30000 }, (_, i) => `row ${String(i + 1).padStart(6, '0')} ${'x'.repeat(30)}`);
    const body = `${lines.join('\n')}\n`;
    expect(body.length).toBeGreaterThan(512 * 1024);
    await put('/workspace/big.txt', body);
    const out = await timed('text-big-window', () => read({ path: 'big.txt', offset: 25000, limit: 3 }));
    const t = textOf(out);
    expect(t).toContain('lines 25000-25002 of 30000');
    expect(t).toContain('row 025000');
    expect(t).toContain('row 025002');
    expect(t).not.toContain('row 025003');
    // The scratch file is cleaned up (best effort, asynchronous).
    await new Promise((r) => setTimeout(r, 1500));
    const left = await sh('ls /tmp/.cognipeer-read 2>/dev/null | wc -l');
    console.info(`[read-tool-docker] scratch files left: ${left.stdout.toString().trim()}`);
  }, 60_000);

  it('survives a file name with a quote, spaces and a command substitution', async () => {
    const evil = "/workspace/it's a $(touch /tmp/pwned) `touch /tmp/pwned2` file.txt";
    await put(evil, 'hello from the evil name\nsecond line\n');
    const out = await timed('evil-name', () => read({ path: evil }));
    expect(out.isError).toBeFalsy();
    expect(textOf(out)).toContain('hello from the evil name');
    const probe = await sh('test -e /tmp/pwned -o -e /tmp/pwned2 && echo PWNED || echo SAFE');
    expect(probe.stdout.toString().trim()).toBe('SAFE');
    // A missing file with the same kind of name is a clean error, not an execution.
    const missing = await read({ path: "/workspace/nope'; touch /tmp/pwned; '" });
    expect(missing.isError).toBe(true);
    expect((await sh('test -e /tmp/pwned && echo PWNED || echo SAFE')).stdout.toString().trim()).toBe('SAFE');
  }, 60_000);

  it('reports a directory and a missing file', async () => {
    const dir = await read({ path: '/workspace' });
    expect(dir.isError).toBe(true);
    expect(textOf(dir)).toMatch(/directory/);
    const missing = await read({ path: '/workspace/does-not-exist.txt' });
    expect(missing.isError).toBe(true);
    expect(textOf(missing)).toMatch(/No such file/);
  }, 60_000);

  it('shows a PNG with its dimensions', async () => {
    const png = solidPng(320, 200, [200, 30, 30]);
    await put('/workspace/red.png', png);
    const out = await timed('png', () => read({ path: 'red.png' }));
    const [image] = imagesOf(out);
    expect(image).toBeDefined();
    expect(image!.mimeType).toBe('image/png');
    expect(image!.width).toBe(320);
    expect(image!.height).toBe(200);
    expect(image!.name).toBe('red.png');
    expect(textOf(out)).toContain('320x200');
    const bytes = Buffer.from(image!.data!, 'base64');
    expect(sniffMedia(bytes).kind).toBe('image');
    expect(imageDimensions(bytes, 'image/png')).toEqual({ width: 320, height: 200 });
  }, 60_000);

  it('downscales an image whose edge is over the model limit, or says how when no converter exists', async () => {
    const hasConverter = (await sh('command -v ffmpeg || command -v convert')).code === 0;
    await put('/workspace/wide.png', solidPng(9000, 120, [10, 120, 200]));
    const out = await timed('png-downscale', () => read({ path: 'wide.png' }));
    if (hasConverter) {
      const [image] = imagesOf(out);
      expect(image).toBeDefined();
      expect(Math.max(image!.width ?? 0, image!.height ?? 0)).toBeLessThanOrEqual(1568);
      console.info(`[read-tool-docker] downscaled 9000x120 -> ${image!.width}x${image!.height}`);
    } else {
      expect(imagesOf(out)).toHaveLength(0);
      expect(textOf(out)).toMatch(/Resize it first/);
    }
  }, 90_000);

  describe('PDF', () => {
    const pages = Array.from({ length: 12 }, (_, i) => ((i + 1) % 4 === 0 ? null : `Page ${i + 1} body text for the read tool integration test, long enough to count as text`));
    // blank pages: 4, 8, 12

    it('asks for pages when there are more than 10, then reads a range as text', async () => {
      if (!hasPoppler) { console.info('[read-tool-docker] no poppler in image: skipping PDF assertions'); return; }
      await put('/workspace/twelve.pdf', buildPdf(pages));
      const guidance = await timed('pdf-guidance', () => read({ path: 'twelve.pdf' }));
      expect(textOf(guidance)).toContain('This PDF has 12 pages');
      expect(textOf(guidance)).toContain('pages=');
      expect(imagesOf(guidance)).toHaveLength(0);

      const range = await timed('pdf-text-1-3', () => read({ path: 'twelve.pdf', pages: '1-3' }));
      const t = textOf(range);
      expect(range.isError).toBeFalsy();
      expect(t).toContain('--- page 1 ---');
      expect(t).toContain('Page 1 body text');
      expect(t).toContain('Page 3 body text');
      expect(imagesOf(range)).toHaveLength(0);
    }, 120_000);

    it('auto view renders blank pages as images and keeps text for the others', async () => {
      if (!hasPoppler) return;
      await put('/workspace/twelve.pdf', buildPdf(pages));
      const out = await timed('pdf-auto-3-5', () => read({ path: 'twelve.pdf', pages: '3-5' }));
      const t = textOf(out);
      const images = imagesOf(out);
      expect(t).toContain('Page 3 body text');
      expect(t).toContain('Page 5 body text');
      expect(images.map((i) => i.name)).toEqual(['page-4.png']);
      expect(t).toMatch(/page 4 is shown as an image/);
      expect(sniffMedia(Buffer.from(images[0]!.data!, 'base64')).kind).toBe('image');
      console.info(`[read-tool-docker] pdf page image ${images[0]!.width}x${images[0]!.height} ${Math.round(Buffer.from(images[0]!.data!, 'base64').length / 1024)} KB`);
    }, 120_000);

    it('view=images renders every requested page', async () => {
      if (!hasPoppler) return;
      await put('/workspace/twelve.pdf', buildPdf(pages));
      const out = await timed('pdf-images-1-2', () => read({ path: 'twelve.pdf', pages: '1-2', view: 'images' }));
      expect(imagesOf(out).map((i) => i.name)).toEqual(['page-1.png', 'page-2.png']);
    }, 120_000);

    it('rejects a range outside the document', async () => {
      if (!hasPoppler) return;
      await put('/workspace/twelve.pdf', buildPdf(pages));
      const out = await read({ path: 'twelve.pdf', pages: '10-14' });
      expect(out.isError).toBe(true);
      expect(textOf(out)).toMatch(/out of range/);
    }, 60_000);
  });

  describe('video', () => {
    it('is one contact sheet with ffmpeg, a hint without', async () => {
      if (hasFfmpeg) {
        const gen = await sh('ffmpeg -v error -y -f lavfi -i testsrc=duration=3:size=320x240:rate=10 -pix_fmt yuv420p /workspace/clip.mp4');
        expect(gen.code).toBe(0);
        const out = await timed('video', () => read({ path: 'clip.mp4' }));
        const images = imagesOf(out);
        expect(images).toHaveLength(1);
        expect(textOf(out)).toMatch(/video 3(\.\d+)?s; contact sheet of 6 frames/);
        // 6 frames -> 3x2 grid of 480-wide frames
        expect(images[0]!.width).toBe(1440);
        console.info(`[read-tool-docker] video sheet ${images[0]!.width}x${images[0]!.height} ${Math.round(Buffer.from(images[0]!.data!, 'base64').length / 1024)} KB`);
      } else {
        // A video head is enough for the sniffer; no ffmpeg in this image.
        await put('/workspace/clip.mp4', Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom'), Buffer.alloc(64, 3)]));
        const out = await timed('video-notool', () => read({ path: 'clip.mp4' }));
        expect(imagesOf(out)).toHaveLength(0);
        expect(textOf(out)).toMatch(/ffmpeg/);
        expect(textOf(out)).toMatch(/apt-get install -y ffmpeg|web-e2e/);
      }
    }, 120_000);
  });

  describe.skipIf(!WEB_E2E)('UI test loop (web-e2e image)', () => {
    it('drives a page with Playwright and reads the screenshot, video and PDF back', async () => {
      const script = `
const http = require('http');
const fs = require('fs');
const { chromium } = require('playwright');
const html = '<!doctype html><html><body style="font-family:sans-serif"><h1 id="t">Hello read tool</h1><button id="b" onclick="document.getElementById(\\'t\\').textContent=\\'Clicked!\\'">Click me</button><p>A tiny page served from 127.0.0.1 inside the sandbox.</p></body></html>';
const server = http.createServer((req, res) => { res.setHeader('content-type', 'text/html'); res.end(html); });
server.listen(0, '127.0.0.1', async () => {
  const url = 'http://127.0.0.1:' + server.address().port + '/';
  fs.mkdirSync('/workspace/out/video', { recursive: true });
  const browser = await chromium.launch({ args: ['--disable-dev-shm-usage', '--no-sandbox'] });
  const context = await browser.newContext({ viewport: { width: 800, height: 500 }, recordVideo: { dir: '/workspace/out/video', size: { width: 800, height: 500 } } });
  const page = await context.newPage();
  await page.goto(url);
  await page.waitForTimeout(400);
  await page.click('#b');
  await page.waitForTimeout(600);
  await page.screenshot({ path: '/workspace/out/shot.png' });
  await page.pdf({ path: '/workspace/out/page.pdf' });
  const video = page.video();
  await context.close();
  fs.renameSync(await video.path(), '/workspace/out/run.webm');
  await browser.close();
  server.close();
  console.log('DONE');
});
`;
      await put('/workspace/ui.js', script);
      const run = await timed('ui-script', () => sh('cd /workspace && node ui.js', 150_000));
      expect(run.stdout.toString(), run.stderr.toString()).toContain('DONE');

      const ls = await sh('ls -l /workspace/out');
      console.info(`[read-tool-docker] out dir:\n${ls.stdout.toString()}`);

      const shot = await timed('ui-read-png', () => read({ path: '/workspace/out/shot.png' }));
      expect(imagesOf(shot)).toHaveLength(1);
      expect(imagesOf(shot)[0]!.width).toBe(800);
      expect(imagesOf(shot)[0]!.height).toBe(500);
      console.info(`[read-tool-docker] screenshot ${Math.round(Buffer.from(imagesOf(shot)[0]!.data!, 'base64').length / 1024)} KB`);

      const video = await timed('ui-read-webm', () => read({ path: '/workspace/out/run.webm' }));
      expect(imagesOf(video)).toHaveLength(1);
      console.info(`[read-tool-docker] video sheet ${imagesOf(video)[0]!.width}x${imagesOf(video)[0]!.height} ${Math.round(Buffer.from(imagesOf(video)[0]!.data!, 'base64').length / 1024)} KB; ${textOf(video)}`);

      const pdf = await timed('ui-read-pdf', () => read({ path: '/workspace/out/page.pdf', view: 'images' }));
      expect(imagesOf(pdf).length).toBeGreaterThanOrEqual(1);
      expect(textOf(pdf)).toContain('Clicked!');
    }, 300_000);
  });
});
