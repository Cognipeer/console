/**
 * `read`: one tool to look at any file the agent can reach.
 *
 * It replaces `sandbox_read_file`, `session_files_read` and
 * `session_files_view_image`. The file decides how it is shown:
 *
 *  - text comes back with line numbers, in windows (`offset` / `limit`);
 *  - an image is shown to the model (downscaled in the sandbox when it is too
 *    big or in a format a model request cannot carry);
 *  - a PDF comes back as text, plus the pages that have no text as images (or
 *    every page with `view: 'images'`);
 *  - a video comes back as ONE contact sheet of frames;
 *  - anything else is described, not dumped.
 *
 * Two places hold files: the sandbox (`path`) and the conversation (`fileId`,
 * or a `tm_…` id of an image an earlier tool result showed). The result is a
 * `ToolOutput`; `toolMedia.ts` turns its images into the message the model sees.
 *
 * Every path that reaches a shell goes through `shQuote` (single quotes), numbers
 * are validated integers, and scratch files live in one hidden directory and are
 * removed best-effort — user input is never interpolated unquoted.
 */

import { randomBytes } from 'node:crypto';
import { Buffer } from 'node:buffer';
import type { createTool as CreateSdkTool, ToolInterface as AgentSdkToolInterface } from '@cognipeer/agent-sdk';
import type { z } from 'zod';
import type { AgentSandboxRef, AgentSandboxRunner } from '@/enterprise/registry';
import { createLogger } from '@/lib/core/logger';
import { currentTurnSignal } from '@/lib/core/turnSignal';
import type { TraceToolDefinition } from '@/lib/services/tracingToolDefinitions';
import { toolOutput, isModelImageMime, type ToolContentBlock, type ToolOutput } from '@/lib/services/tools/toolOutput';
import { basenameOf, imageDimensions, sniffMedia } from '@/lib/services/tools/mediaSniff';
import { readBytesViaExec, shQuote } from './agentSandboxOutputs';
import { READ_TOOL, SESSION_FILES_LIST_TOOL, isImageMime, sendableImageType } from './sessionFilesConfig';
import { findSessionFileRecord, readFileText, type SessionFileScope } from './sessionFiles';
import { TOOL_MEDIA_ID_PREFIX, type ToolMediaStore } from './toolMedia';

export { READ_TOOL };

const logger = createLogger('agent-read-tool');

const SCRATCH = '/tmp/.cognipeer-read';
/** A text file up to this size is fetched whole; a bigger one is windowed in the sandbox first. */
const TEXT_DIRECT_MAX = 512 * 1024;
const DEFAULT_LIMIT = 2000;
const MAX_LINE_CHARS = 2000;
const SANDBOX_TEXT_CHARS = 100_000;
/** Largest image fetched to look at; a bigger one is downscaled in the sandbox first. */
const IMAGE_FETCH_MAX = 12 * 1024 * 1024;
const IMAGE_SEND_MAX = 5 * 1024 * 1024;
const IMAGE_EDGE_MAX = 7900;
const PDF_DIRECT_PAGES = 10;
const PDF_MAX_PAGES = 20;
const PDF_MAX_IMAGE_PAGES = 10;
const PDF_AUTO_IMAGE_PAGES = 6;
/** A page with less text than this is scanned or drawn: it is worth looking at. */
const PDF_SPARSE_TEXT = 40;
const VIDEO_DEFAULT_FRAMES = 6;
const VIDEO_MAX_FRAMES = 12;
const VIDEO_FALLBACK_SECONDS = 5;

type CreateToolFn = typeof CreateSdkTool;

export interface ReadToolDeps {
    createToolFn: CreateToolFn;
    zod: typeof z;
    guard: {
        protect<A extends Record<string, unknown>, R>(
            spec: { name: string; requestedName: string },
            execute: (safeArgs: A, ...rest: unknown[]) => Promise<R>,
        ): (args: A, ...rest: unknown[]) => Promise<R | string>;
    };
    sandbox?: {
        runner: AgentSandboxRunner;
        ref: AgentSandboxRef;
        getInstance(): Promise<string>;
        resolvePath(path: string): string;
        scrub(text: string): string;
    };
    session?: { scope: SessionFileScope; conversationId: string; readPageChars: number };
    media?: { store: ToolMediaStore };
    modelTakesImages: boolean;
}

// A type literal, not an interface: the guard's argument type needs an index signature.
type ReadArgs = {
    path?: string;
    fileId?: string;
    offset?: number;
    limit?: number;
    pages?: string;
    view?: 'auto' | 'text' | 'images';
    frames?: number;
};

const DESCRIPTION = 'Read a file and see it the way it is best understood: text comes back with line numbers, images are shown to you, '
    + 'PDFs come back as text (plus page images when a page has no text, or with view=images) and videos as a contact sheet of frames. '
    + 'Use it for any file you need to look at — screenshots, test reports, recordings, uploads.';

const PATH_HELP = 'A file in your sandbox. Relative paths are under /workspace.';
const FILE_ID_HELP = `A conversation file id (from ${SESSION_FILES_LIST_TOOL} or an [Attached …] handle), or an image id from an earlier tool result.`;

function text(value: string): ToolOutput {
    return toolOutput([{ type: 'text', text: value }]);
}

function fail(value: string): ToolOutput {
    return toolOutput([{ type: 'text', text: value }], { isError: true });
}

function size(bytes: number): string {
    if (bytes >= 1024 * 1024) return `${(Math.round((bytes / (1024 * 1024)) * 10) / 10).toString()} MB`;
    return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function integer(value: unknown, fallback: number, min: number, max: number): number {
    const n = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : fallback;
    return Math.min(max, Math.max(min, n));
}

function toLines(content: string): string[] {
    const lines = content.split('\n');
    if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    return lines.map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line));
}

/**
 * Numbered lines under a one-line header that says which lines these are and
 * how to continue. Stops early at `charCap` so one call never floods the context.
 */
function renderLines(label: string, lines: string[], first: number, total: number, charCap: number): string {
    const rows: string[] = [];
    let chars = 0;
    let last = first - 1;
    for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i]!.length > MAX_LINE_CHARS ? `${lines[i]!.slice(0, MAX_LINE_CHARS)}… [line truncated]` : lines[i]!;
        const row = `${String(first + i).padStart(6)}\t${line}`;
        if (rows.length > 0 && chars + row.length + 1 > charCap) break;
        rows.push(row);
        chars += row.length + 1;
        last = first + i;
    }
    const more = last < total;
    return `[${label} — lines ${first}-${last} of ${total}${more ? `; continue with offset=${last + 1}` : ''}]\n${rows.join('\n')}`;
}

function gridFor(frames: number): { cols: number; rows: number } {
    if (frames <= 1) return { cols: 1, rows: 1 };
    if (frames === 2) return { cols: 2, rows: 1 };
    if (frames === 3) return { cols: 3, rows: 1 };
    if (frames === 4) return { cols: 2, rows: 2 };
    if (frames <= 6) return { cols: 3, rows: 2 };
    if (frames <= 9) return { cols: 3, rows: 3 };
    return { cols: 4, rows: 3 };
}

function randomId(): string {
    return randomBytes(4).toString('hex');
}

type Sandbox = NonNullable<ReadToolDeps['sandbox']>;

/** What a sandbox read throws reaches the model and the trace, so it is masked like what it returns; its kind is kept. */
function maskedError(sandbox: Sandbox, error: unknown): unknown {
    const message = error instanceof Error ? error.message : String(error);
    const clean = sandbox.scrub(message);
    if (clean === message) return error;
    const masked = new Error(clean);
    if (error instanceof Error) masked.name = error.name;
    return masked;
}

/** One file of the sandbox, read the way its content calls for. */
async function readSandboxFile(sandbox: Sandbox, args: ReadArgs, modelTakesImages: boolean): Promise<ToolOutput> {
    const instanceId = await sandbox.getInstance();
    const path = sandbox.resolvePath(String(args.path));
    const Q = shQuote(path);
    const signal = currentTurnSignal();
    const run = (command: string, timeoutSec = 30) => sandbox.runner.exec(sandbox.ref, instanceId, {
        command,
        timeoutSec,
        ...(signal ? { signal } : {}),
    });
    /** A command's own message, masked before it is cut so that a cut cannot leave part of a value showing. */
    const said = (stream: string, max = 200) => sandbox.scrub(stream.trim()).slice(0, max);
    /** Best effort, never awaited: a scratch file left behind is in a hidden directory of a throwaway machine. */
    const cleanup = (...files: string[]) => {
        void Promise.resolve().then(() => run(`rm -f ${files.map(shQuote).join(' ')}`, 10)).catch(() => undefined);
    };
    const readBytes = async (file: string, fileSize: number, binary: boolean): Promise<Buffer> => {
        if (sandbox.runner.readFileBytes) return Buffer.from(await sandbox.runner.readFileBytes(sandbox.ref, instanceId, file));
        if (!binary) return Buffer.from(await sandbox.runner.readFile(sandbox.ref, instanceId, file), 'utf8');
        // Scratch outputs are passed with size 0: stat them, or the chunked read would return nothing.
        let total = fileSize;
        if (total <= 0) {
            const stat = await run(`wc -c < ${shQuote(file)} | tr -d ' '`, 30);
            total = Number.parseInt(stat.stdout.trim(), 10) || 0;
        }
        return readBytesViaExec((command) => run(command, 60), file, total);
    };

    // ── What is it? One cheap probe: kind, size, a look at the first bytes ──
    const probeCommand = `p=${Q}; if [ -d "$p" ]; then echo DIR; elif [ ! -e "$p" ]; then echo MISSING; elif [ ! -r "$p" ]; then echo UNREADABLE; `
        + `else printf 'FILE %s %s %s ' "$(wc -c < "$p" | tr -d ' ')" "$(head -c 8192 "$p" | wc -c | tr -d ' ')" `
        + `"$(head -c 8192 "$p" | tr -d '\\000' | wc -c | tr -d ' ')"; head -c 32 "$p" | od -An -tx1 | tr -d ' \\n'; echo; fi`;
    const probe = await run(probeCommand);
    const first = probe.stdout.trim();
    if (first === 'DIR') return fail(`${path} is a directory — use sandbox_list_files to see what is in it.`);
    if (first === 'MISSING') return fail(`No such file: ${path}`);
    if (first === 'UNREADABLE') return fail(`Permission denied: ${path}`);
    // An empty file has no hex at all, and the trim above took the space before it.
    const match = /^FILE (\d+) (\d+) (\d+)(?: ([0-9a-f]*))?/.exec(first);
    if (probe.exitCode !== 0 || !match) {
        return fail(`Could not inspect ${path}${probe.stderr.trim() ? `: ${said(probe.stderr)}` : '.'}`);
    }
    const fileSize = Number(match[1]);
    const hasNul = match[2] !== match[3];
    const head = Uint8Array.from(Buffer.from(match[4] ?? '', 'hex'));
    const sniffed = sniffMedia(head);
    const label = path;

    if (sniffed.kind === 'image') return readSandboxImage();
    if (sniffed.kind === 'pdf') return readSandboxPdf();
    if (sniffed.kind === 'video') return readSandboxVideo();
    if (sniffed.kind === 'audio') {
        return text(`[${label} — audio ${sniffed.mimeType ?? ''}, ${size(fileSize)}] It cannot be played to you. Transcribe it in the sandbox if you need its content.`);
    }
    if (sniffed.kind === 'archive' || hasNul) {
        return text(`[${label} — binary ${sniffed.mimeType ?? 'unknown'}, ${size(fileSize)}] It is not text. Inspect it in the sandbox with sandbox_exec (for an archive, for example \`unzip -l\` or \`tar -tf\`).`);
    }
    return readSandboxText();

    // ── text ────────────────────────────────────────────────────────────────
    async function readSandboxText(): Promise<ToolOutput> {
        if (fileSize === 0) return text(`[${label} — empty file]`);
        const offset = integer(args.offset, 1, 1, Number.MAX_SAFE_INTEGER);
        const limit = integer(args.limit, DEFAULT_LIMIT, 1, DEFAULT_LIMIT);
        let lines: string[];
        let total: number;
        if (fileSize <= TEXT_DIRECT_MAX) {
            // Masked before the lines are cut (a long line, the character cap), for the same reason as `said`.
            const all = toLines(sandbox.scrub((await readBytes(path, fileSize, false)).toString('utf8')));
            total = all.length;
            if (offset > total) return fail(`offset ${offset} is past the end of ${path} (${total} line${total === 1 ? '' : 's'}).`);
            lines = all.slice(offset - 1, offset - 1 + limit);
        } else {
            // Too big to fetch whole: cut the window out in the sandbox and fetch that.
            const id = randomId();
            const out = `${SCRATCH}/${id}.txt`;
            const res = await run(
                `mkdir -p ${SCRATCH} && o=${out} && total=$(awk 'END{print NR}' ${Q}) && sed -n '${offset},${offset + limit - 1}p' ${Q} | head -c 2000000 > "$o" && echo "$total"`,
                60,
            );
            total = Number.parseInt(res.stdout.trim(), 10);
            if (res.exitCode !== 0 || !Number.isFinite(total)) return fail(`Could not read ${path}${res.stderr.trim() ? `: ${said(res.stderr)}` : '.'}`);
            if (offset > total) return fail(`offset ${offset} is past the end of ${path} (${total} line${total === 1 ? '' : 's'}).`);
            lines = toLines(sandbox.scrub((await readBytes(out, 0, false)).toString('utf8')));
            cleanup(out);
        }
        return text(renderLines(label, lines, offset, total, SANDBOX_TEXT_CHARS));
    }

    // ── image ───────────────────────────────────────────────────────────────
    async function readSandboxImage(): Promise<ToolOutput> {
        const mime = sniffed.mimeType ?? 'image/png';
        if (!modelTakesImages) {
            return text(`[${label} — image ${mime}, ${size(fileSize)}] This model cannot view images, so it was not loaded. Inspect it in the sandbox instead (for example with Python).`);
        }
        let bytes: Buffer | null = null;
        let dims: { width: number; height: number } | null = null;
        if (fileSize <= IMAGE_FETCH_MAX) {
            bytes = await readBytes(path, fileSize, true);
            dims = imageDimensions(bytes, mime);
        }
        const longEdge = dims ? Math.max(dims.width, dims.height) : 0;
        const needsDownscale = !bytes || !isModelImageMime(mime) || bytes.length > IMAGE_SEND_MAX || longEdge > IMAGE_EDGE_MAX;
        let outMime = mime;
        let downscaled = false;
        if (needsDownscale) {
            const id = randomId();
            const out = `${SCRATCH}/${id}.png`;
            const res = await run(
                `mkdir -p ${SCRATCH} && o=${out} && if command -v ffmpeg >/dev/null 2>&1; then ffmpeg -v error -y -i ${Q} -vf "scale='if(gt(iw,ih),min(1568,iw),-2)':'if(gt(iw,ih),-2,min(1568,ih))'" -frames:v 1 "$o" && echo "OK $o"; `
                + `elif command -v convert >/dev/null 2>&1; then convert ${Q}'[0]' -resize '1568x1568>' "$o" && echo "OK $o"; else echo NOTOOL; fi`,
                60,
            );
            if (!res.stdout.includes('OK ')) {
                const reason = res.stdout.includes('NOTOOL') ? '' : ` (${said(res.stderr || 'the conversion failed')})`;
                return text(`[${label} — image ${mime}, ${size(fileSize)}] It is too large to show, or in a format that cannot be shown, and the sandbox could not convert it${reason}. `
                    + 'Resize it first, e.g. `ffmpeg -i in.png -vf scale=1568:-2 out.png`, then read the result.');
            }
            bytes = await readBytes(out, 0, true);
            dims = imageDimensions(bytes, 'image/png');
            outMime = 'image/png';
            downscaled = true;
            cleanup(out);
        }
        const name = basenameOf(path);
        const dimsText = dims ? ` ${dims.width}x${dims.height}` : '';
        return toolOutput([
            { type: 'text', text: `[${label} — image ${outMime}${dimsText}, ${size(bytes!.length)}${downscaled ? ', downscaled to fit' : ''}]` },
            { type: 'image', data: bytes!.toString('base64'), mimeType: outMime, name, ...(dims ? { width: dims.width, height: dims.height } : {}) },
        ]);
    }

    // ── pdf ─────────────────────────────────────────────────────────────────
    async function readSandboxPdf(): Promise<ToolOutput> {
        const view = args.view ?? 'auto';
        const countRun = await run(
            `if command -v pdfinfo >/dev/null 2>&1; then pdfinfo ${Q} 2>/dev/null | sed -n 's/^Pages:[[:space:]]*//p'; else echo NOPOPPLER; fi`,
        );
        const poppler = !countRun.stdout.includes('NOPOPPLER');
        const noTools = text(`[${label} — PDF, ${size(fileSize)}] No PDF tools in this sandbox (install poppler-utils: apt-get install -y poppler-utils).`);
        // Without poppler pdfplumber (if installed) can still give the text. `-I` and `cd /` keep a repo file named pdfplumber.py from hijacking the import.
        const python = (from: number, to: number, out: string) => `mkdir -p ${SCRATCH} && o=${out} && command -v python3 >/dev/null 2>&1 && cd / && python3 -I - ${Q} ${from} ${to} "$o" <<'PY'\n`
            + 'import sys, json\n'
            + 'try:\n    import pdfplumber\nexcept Exception:\n    sys.exit(3)\n'
            + 'path, a, b, out = sys.argv[1], int(sys.argv[2]), int(sys.argv[3]), sys.argv[4]\n'
            + 'with pdfplumber.open(path) as pdf:\n'
            + '    n = len(pdf.pages)\n'
            + '    texts = []\n'
            + '    if a > 0:\n'
            + '        for i in range(a - 1, min(b, n)):\n'
            + '            texts.append(pdf.pages[i].extract_text() or "")\n'
            + '    with open(out, "w") as f:\n'
            + '        json.dump({"pages": n, "texts": texts}, f)\n'
            + 'print("OK")\nPY\n';

        let pageTotal: number;
        if (poppler) {
            pageTotal = Number.parseInt(countRun.stdout.trim(), 10);
            if (!Number.isFinite(pageTotal) || pageTotal < 1) return fail(`Could not read ${path} as a PDF${countRun.stderr.trim() ? `: ${said(countRun.stderr)}` : ' (is it damaged or encrypted?).'}`);
        } else {
            const out = `${SCRATCH}/${randomId()}.json`;
            const res = await run(python(0, 0, out), 60);
            if (!res.stdout.includes('OK')) return noTools;
            pageTotal = (JSON.parse((await readBytes(out, 0, false)).toString('utf8')) as { pages: number }).pages;
            cleanup(out);
        }

        // Which pages: asked for, or all of a short document.
        let from: number;
        let to: number;
        if (args.pages === undefined || args.pages === '') {
            if (pageTotal > PDF_DIRECT_PAGES) {
                return text(`This PDF has ${pageTotal} pages. Call read again with pages (for example pages="1-5"); at most ${PDF_MAX_PAGES} pages per call.`);
            }
            from = 1;
            to = pageTotal;
        } else {
            const range = /^\s*(\d+)\s*(?:-\s*(\d+))?\s*$/.exec(args.pages);
            if (!range) return fail(`pages must be a page number or a range such as "3" or "2-6" (got "${args.pages}").`);
            from = Number(range[1]);
            to = range[2] ? Number(range[2]) : from;
            if (from < 1 || to < from || to > pageTotal) return fail(`pages "${args.pages}" is out of range: this PDF has ${pageTotal} page${pageTotal === 1 ? '' : 's'}.`);
            if (to - from + 1 > PDF_MAX_PAGES) return fail(`At most ${PDF_MAX_PAGES} pages per call; pages "${args.pages}" asks for ${to - from + 1}.`);
        }

        // Text of those pages.
        let texts: string[];
        if (poppler) {
            const out = `${SCRATCH}/${randomId()}.txt`;
            const res = await run(`mkdir -p ${SCRATCH} && o=${out} && pdftotext -f ${from} -l ${to} -layout ${Q} "$o" && echo OK`, 60);
            if (!res.stdout.includes('OK')) return fail(`Could not extract the text of ${path}${res.stderr.trim() ? `: ${said(res.stderr)}` : '.'}`);
            const sections = (await readBytes(out, 0, false)).toString('utf8').split('\f');
            if (sections.length > 1 && sections[sections.length - 1]!.trim() === '') sections.pop();
            texts = sections;
            cleanup(out);
        } else {
            const out = `${SCRATCH}/${randomId()}.json`;
            const res = await run(python(from, to, out), 60);
            if (!res.stdout.includes('OK')) return noTools;
            texts = (JSON.parse((await readBytes(out, 0, false)).toString('utf8')) as { texts: string[] }).texts;
            cleanup(out);
        }
        const pageNumbers = Array.from({ length: to - from + 1 }, (_, i) => from + i);
        const pageText = (k: number) => (texts[k - from] ?? '').trim();

        // Pages worth looking at.
        const notes: string[] = [];
        let wanted: number[] = [];
        if (view === 'images') {
            wanted = pageNumbers.slice(0, PDF_MAX_IMAGE_PAGES);
            if (pageNumbers.length > wanted.length) notes.push(`Only the first ${PDF_MAX_IMAGE_PAGES} of the ${pageNumbers.length} requested pages are shown as images.`);
        } else if (view === 'auto') {
            wanted = pageNumbers.filter((k) => pageText(k).length < PDF_SPARSE_TEXT).slice(0, PDF_AUTO_IMAGE_PAGES);
        }
        if (wanted.length > 0 && !modelTakesImages) {
            notes.push(`${wanted.length} page${wanted.length === 1 ? '' : 's'} (${wanted.join(', ')}) ${wanted.length === 1 ? 'has' : 'have'} little or no text, and this model cannot view images.`);
            wanted = [];
        }
        if (wanted.length > 0 && !poppler) {
            notes.push('Page images need poppler-utils in the sandbox; only the text is shown.');
            wanted = [];
        }
        const images: ToolContentBlock[] = [];
        if (wanted.length > 0) {
            const id = randomId();
            const res = await run(
                `mkdir -p ${SCRATCH} && for k in ${wanted.join(' ')}; do pdftoppm -f $k -l $k -png -r 110 -scale-to 1400 -singlefile ${Q} ${SCRATCH}/${id}-p$k || exit 1; done; echo OK`,
                120,
            );
            if (!res.stdout.includes('OK')) {
                notes.push(`The page images could not be rendered${res.stderr.trim() ? ` (${said(res.stderr, 120)})` : ''}.`);
                wanted = [];
            } else {
                for (const k of wanted) {
                    const file = `${SCRATCH}/${id}-p${k}.png`;
                    const bytes = await readBytes(file, 0, true);
                    const dims = imageDimensions(bytes, 'image/png');
                    images.push({ type: 'image', data: bytes.toString('base64'), mimeType: 'image/png', name: `page-${k}.png`, ...(dims ? { width: dims.width, height: dims.height } : {}) });
                }
                cleanup(...wanted.map((k) => `${SCRATCH}/${id}-p${k}.png`));
            }
        }

        // Assemble: a section per page, capped.
        const sections: string[] = [];
        let chars = 0;
        let lastShown = from - 1;
        for (const k of pageNumbers) {
            const body = pageText(k);
            const section = `--- page ${k} ---${wanted.includes(k) ? `\n(page ${k} is shown as an image)` : ''}${body ? `\n${body}` : ''}`;
            if (sections.length > 0 && chars + section.length > SANDBOX_TEXT_CHARS) break;
            sections.push(section);
            chars += section.length + 1;
            lastShown = k;
        }
        const header = `[${label} — PDF, ${pageTotal} page${pageTotal === 1 ? '' : 's'}; pages ${from}-${lastShown}${lastShown < to ? `; continue with pages="${lastShown + 1}-${to}"` : ''}]`;
        const body = sandbox.scrub([header, ...notes, ...sections].join('\n'));
        return toolOutput([{ type: 'text', text: body }, ...images]);
    }

    // ── video ───────────────────────────────────────────────────────────────
    async function readSandboxVideo(): Promise<ToolOutput> {
        if (!modelTakesImages) {
            return text(`[${label} — video ${sniffed.mimeType ?? ''}, ${size(fileSize)}] This model cannot view images, so a contact sheet of frames would be of no use. Inspect it in the sandbox instead.`);
        }
        const tools = await run('command -v ffprobe >/dev/null 2>&1 && command -v ffmpeg >/dev/null 2>&1 || echo NOTOOL');
        if (tools.stdout.includes('NOTOOL')) {
            return text(`[${label} — video ${sniffed.mimeType ?? ''}, ${size(fileSize)}] The sandbox has no ffmpeg, so it cannot be shown. Install it (apt-get install -y ffmpeg) or use the web-e2e sandbox template.`);
        }
        let duration = Number.parseFloat((await run(`ffprobe -v error -show_entries format=duration -of default=nw=1:nk=1 ${Q}`)).stdout.trim());
        if (!Number.isFinite(duration) || duration <= 0) {
            // Containers like webm often carry no duration: count the packets instead.
            const counted = (await run(`ffprobe -v error -select_streams v:0 -count_packets -show_entries stream=nb_read_packets,r_frame_rate -of csv=p=0 ${Q}`, 60)).stdout.trim();
            const fields = counted.split(',').map((field) => field.trim());
            const rate = fields.find((field) => field.includes('/'));
            const packets = Number.parseInt(fields.find((field) => /^\d+$/.test(field)) ?? '', 10);
            const [num, den] = (rate ?? '').split('/').map(Number);
            const fps = num && den ? num / den : Number.NaN;
            duration = Number.isFinite(packets) && Number.isFinite(fps) && fps > 0 ? packets / fps : Number.NaN;
        }
        const known = Number.isFinite(duration) && duration > 0;
        const span = known ? duration : VIDEO_FALLBACK_SECONDS;
        const frames = integer(args.frames, VIDEO_DEFAULT_FRAMES, 1, VIDEO_MAX_FRAMES);
        const times = Array.from({ length: frames }, (_, i) => ((i + 0.5) * span) / frames);
        const id = randomId();
        const { cols, rows } = gridFor(frames);
        const frameCommands = times.map((t, i) => `ffmpeg -v error -y -ss ${t.toFixed(3)} -i ${Q} -frames:v 1 -vf scale=480:-2 ${SCRATCH}/${id}-f${i}.png`);
        const sheet = `${SCRATCH}/${id}-sheet.png`;
        const res = await run(
            `mkdir -p ${SCRATCH} && ${frameCommands.join(' && ')} && ffmpeg -v error -y -framerate 1 -i ${SCRATCH}/${id}-f%d.png -vf tile=${cols}x${rows} -frames:v 1 ${sheet} && echo OK`,
            120,
        );
        const frameFiles = times.map((_, i) => `${SCRATCH}/${id}-f${i}.png`);
        if (!res.stdout.includes('OK')) {
            cleanup(...frameFiles, sheet);
            return fail(`Could not extract frames from ${path}${res.stderr.trim() ? `: ${said(res.stderr)}` : '.'}`);
        }
        const bytes = await readBytes(sheet, 0, true);
        cleanup(...frameFiles, sheet);
        const dims = imageDimensions(bytes, 'image/png');
        const stamps = times.map((t) => t.toFixed(1)).join(', ');
        const lead = known
            ? `[${label} — video ${(Math.round(duration * 10) / 10).toString()}s; contact sheet of ${frames} frame${frames === 1 ? '' : 's'} at ${stamps}s, left to right, top to bottom]`
            : `[${label} — video, duration unknown; contact sheet of ${frames} frame${frames === 1 ? '' : 's'} from the first ${VIDEO_FALLBACK_SECONDS}s at ${stamps}s, left to right, top to bottom]`;
        return toolOutput([
            { type: 'text', text: lead },
            { type: 'image', data: bytes.toString('base64'), mimeType: 'image/png', name: `${basenameOf(path)}-sheet.png`, ...(dims ? { width: dims.width, height: dims.height } : {}) },
        ]);
    }
}

/** A file of the conversation, or an image an earlier tool result showed. */
async function readSessionFile(deps: ReadToolDeps, args: ReadArgs): Promise<ToolOutput> {
    const fileId = String(args.fileId).trim();
    const { media, modelTakesImages } = deps;

    if (fileId.startsWith(TOOL_MEDIA_ID_PREFIX)) {
        const item = media?.store.get(fileId);
        if (!item) return fail('That image is no longer available — read or capture it again.');
        if (!modelTakesImages) return text(`[${item.name} — image ${item.mediaType}, ${size(item.size)}] This model cannot view images.`);
        return toolOutput([
            { type: 'text', text: `[${item.name} — image ${item.mediaType}, ${size(item.size)}]` },
            { type: 'image', fileId, name: item.name, mimeType: item.mediaType },
        ]);
    }

    const session = deps.session;
    if (!session) return fail(`"${fileId}" is not an image from an earlier tool result, and this conversation has no files.`);
    const record = await findSessionFileRecord(session.scope, session.conversationId, fileId);
    if (!record) return fail(`File "${fileId}" is not attached to this conversation. Use ${SESSION_FILES_LIST_TOOL} to see the files.`);
    const sandboxOnly = args.pages !== undefined || args.view !== undefined
        ? 'pages and view (page images) work on sandbox files only; this file is read as text.\n'
        : '';

    // A picture whose text OCR read at upload (a converted copy exists) can be read as text where it cannot be shown.
    const pictureHasText = record.markdownStatus === 'succeeded' && Boolean(record.markdownKey);
    const imageType = sendableImageType(record.contentType);
    if (imageType && !(pictureHasText && !modelTakesImages)) {
        if (!modelTakesImages) return text(`[${record.name} — image ${imageType}, ${size(record.size)}] This model cannot view images.`);
        return toolOutput([
            { type: 'text', text: `[${record.name} — image ${imageType}, ${size(record.size)}]` },
            { type: 'image', fileId: String(record._id), name: record.name, mimeType: imageType },
        ]);
    }
    if (!imageType && isImageMime(record.contentType) && !pictureHasText) {
        return text(`"${record.name}" is an image in a format (${record.contentType}) the model cannot be shown; it has no text to read.`);
    }

    let content: string | null;
    try {
        content = await readFileText(session.scope, record);
    } catch (error) {
        logger.warn('read failed', { fileId, error: error instanceof Error ? error.message : String(error) });
        return fail('The file could not be read right now.');
    }
    if (content === null) return text(`"${record.name}" has no text form (${record.contentType}).`);
    // OCR found no text in a picture the model cannot be shown: say that, not "empty file".
    if (isImageMime(record.contentType) && content.trim().length === 0) {
        return text(imageType
            ? `[${record.name} — image ${imageType}, ${size(record.size)}] This model cannot view images, and OCR found no text in it.`
            : `"${record.name}" is an image in a format (${record.contentType}) the model cannot be shown, and OCR found no text in it.`);
    }
    if (content.length === 0) return text(`[${record.name} — empty file]`);

    const lines = toLines(content);
    const offset = integer(args.offset, 1, 1, Number.MAX_SAFE_INTEGER);
    const limit = integer(args.limit, DEFAULT_LIMIT, 1, DEFAULT_LIMIT);
    if (offset > lines.length) return fail(`offset ${offset} is past the end of "${record.name}" (${lines.length} line${lines.length === 1 ? '' : 's'}).`);
    const window = lines.slice(offset - 1, offset - 1 + limit);
    return text(`${sandboxOnly}${renderLines(record.name, window, offset, lines.length, session.readPageChars)}`);
}

/**
 * Whether `args` asks for a sandbox path or a conversation file. Strict tool
 * calling (OpenAI, Azure) sends every argument, and a model then often fills
 * `path` and `fileId` both, usually with the same value: the fileId is read
 * when it names an image of an earlier tool result or a file of this
 * conversation, else the path.
 */
async function pickSource(deps: ReadToolDeps, args: ReadArgs): Promise<'path' | 'fileId' | null> {
    const path = typeof args.path === 'string' ? args.path.trim() : '';
    const fileId = typeof args.fileId === 'string' ? args.fileId.trim() : '';
    if (!path || !fileId) return path ? 'path' : fileId ? 'fileId' : null;
    if (!deps.sandbox) return 'fileId';
    const named = fileId.startsWith(TOOL_MEDIA_ID_PREFIX)
        ? Boolean(deps.media?.store.get(fileId))
        : Boolean(deps.session && await findSessionFileRecord(deps.session.scope, deps.session.conversationId, fileId));
    return named ? 'fileId' : 'path';
}

export function buildReadTool(deps: ReadToolDeps): AgentSdkToolInterface | null {
    if (!deps.sandbox && !deps.session) return null;
    const { zod: zd } = deps;

    const shape: Record<string, z.ZodTypeAny> = {};
    if (deps.sandbox) shape.path = zd.string().min(1).optional().describe(PATH_HELP);
    if (deps.session || deps.media) shape.fileId = zd.string().min(1).optional().describe(FILE_ID_HELP);
    shape.offset = zd.number().int().min(1).optional().describe('First line to read (text files), starting at 1.');
    shape.limit = zd.number().int().min(1).max(DEFAULT_LIMIT).optional().describe(`Lines to read (text files). Default and maximum ${DEFAULT_LIMIT}.`);
    if (deps.sandbox) {
        shape.pages = zd.string().optional().describe(`PDF page range such as "3" or "2-6"; at most ${PDF_MAX_PAGES} pages per call. Required when the PDF has more than ${PDF_DIRECT_PAGES} pages.`);
        shape.view = zd.enum(['auto', 'text', 'images']).optional().describe('PDF only. auto (default): text, plus page images for pages with (almost) no text; images: every requested page as an image; text: text only.');
        shape.frames = zd.number().int().min(1).max(VIDEO_MAX_FRAMES).optional().describe(`Video: frames sampled into one contact sheet (default ${VIDEO_DEFAULT_FRAMES}, at most ${VIDEO_MAX_FRAMES}).`);
    }

    return deps.createToolFn({
        name: READ_TOOL,
        description: DESCRIPTION,
        schema: zd.object(shape),
        func: deps.guard.protect(
            { name: 'agent.read', requestedName: READ_TOOL },
            async (args: ReadArgs): Promise<ToolOutput> => {
                const source = await pickSource(deps, args);
                if (!source) return fail(`Pass ${[deps.sandbox ? 'path' : '', deps.session || deps.media ? 'fileId' : ''].filter(Boolean).join(' or ')}.`);
                if (source === 'path') {
                    if (!deps.sandbox) return fail('This agent has no sandbox, so there are no sandbox paths to read. Use fileId.');
                    const sandbox = deps.sandbox;
                    return readSandboxFile(sandbox, args, deps.modelTakesImages).catch((error: unknown) => {
                        throw maskedError(sandbox, error);
                    });
                }
                if (!deps.session && !deps.media) return fail('This conversation has no files to read. Use path to read a file of your sandbox.');
                return readSessionFile(deps, args);
            },
        ),
    }) as AgentSdkToolInterface;
}

export function readToolDefinition(deps: Pick<ReadToolDeps, 'sandbox' | 'session' | 'media'>): TraceToolDefinition {
    const properties: Record<string, unknown> = {};
    if (deps.sandbox) properties.path = { type: 'string', description: PATH_HELP };
    if (deps.session || deps.media) properties.fileId = { type: 'string', description: FILE_ID_HELP };
    properties.offset = { type: 'integer', minimum: 1, description: 'First line to read (text files).' };
    properties.limit = { type: 'integer', minimum: 1, maximum: DEFAULT_LIMIT, description: 'Lines to read (text files).' };
    if (deps.sandbox) {
        properties.pages = { type: 'string', description: 'PDF page range such as "3" or "2-6".' };
        properties.view = { type: 'string', enum: ['auto', 'text', 'images'], description: 'PDF only: text, page images, or both as needed.' };
        properties.frames = { type: 'integer', minimum: 1, maximum: VIDEO_MAX_FRAMES, description: 'Video: frames in the contact sheet.' };
    }
    return { name: READ_TOOL, description: DESCRIPTION, parameters: { type: 'object', properties } };
}
