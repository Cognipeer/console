/**
 * (Client-safe: no node imports — the editor validates paths with it.)
 *
 * Sandbox seed files: files the operator preloads into an agent's sandbox
 * (a presentation template, a data file) that are written when the sandbox
 * starts, before the agent works.
 *
 * Bytes live in the Document Store under `agent-assets/<agentKey>/`; the agent
 * config holds the reference and the destination path. Everything here is
 * runner-agnostic: it writes through `exec` (binary-safe chunked base64), so it
 * works with any sandbox module.
 */

import type { IAgentSandboxSeedFile } from '@/lib/database';

export const SEED_MAX_FILES = 25;
export const SEED_MAX_FILE_BYTES = 25 * 1024 * 1024;
export const SEED_MAX_TOTAL_BYTES = 100 * 1024 * 1024;
export const SEED_DEFAULT_DIR = '/workspace/templates';
/** Raw bytes per exec: ~80 KB of base64, under the 128 KB single-argument limit. */
const CHUNK_BYTES = 60_000;

const FORBIDDEN_ROOTS = ['/proc', '/sys', '/dev', '/etc', '/bin', '/sbin', '/usr', '/lib'];

export function seedObjectPrefix(agentKey: string): string {
    return `agent-assets/${agentKey}/`;
}

export function defaultSeedPath(fileName: string): string {
    const base = fileName.replace(/[\\/\0]/g, '_').trim() || 'file';
    return `${SEED_DEFAULT_DIR}/${base}`;
}

/** A refusal sentence for a destination path, or null when it is fine. */
export function validateSeedPath(path: unknown): string | null {
    if (typeof path !== 'string' || !path.trim()) return 'Enter a destination path.';
    if (path.includes('\0')) return 'The path must not contain NUL characters.';
    if (!path.startsWith('/')) return 'The path must be absolute (start with /).';
    if (path.length > 512) return 'The path is too long (512 characters at most).';
    if (path.endsWith('/')) return 'The path must include the file name.';
    if (path.split('/').includes('..')) return 'The path must not contain "..".';
    if (path.split('/').slice(1).some((segment) => segment === '' || segment === '.')) return 'The path must be normalized (no "//" or "./").';
    for (const root of FORBIDDEN_ROOTS) {
        if (path === root || path.startsWith(`${root}/`)) return `Files cannot be placed under ${root}.`;
    }
    return null;
}

export function validateSeedMode(mode: unknown): string | null {
    if (mode === undefined || mode === '') return null;
    return typeof mode === 'string' && /^0?[0-7]{3,4}$/.test(mode) ? null : 'The mode must be octal, e.g. 0644.';
}

export interface SeedValidationIssue { field: string; message: string }

/** Save-time check of the whole list: shape, paths, duplicates, ownership of the object keys and the limits. */
export function validateSeedFiles(files: unknown, agentKey?: string): SeedValidationIssue[] {
    if (files === undefined) return [];
    const issues: SeedValidationIssue[] = [];
    if (!Array.isArray(files)) return [{ field: 'sandbox.seedFiles', message: 'must be a list' }];
    if (files.length > SEED_MAX_FILES) issues.push({ field: 'sandbox.seedFiles', message: `at most ${SEED_MAX_FILES} files` });
    const seen = new Set<string>();
    let total = 0;
    files.forEach((raw, index) => {
        const field = `sandbox.seedFiles[${index}]`;
        const file = raw as Partial<IAgentSandboxSeedFile> | null;
        if (!file || typeof file !== 'object') { issues.push({ field, message: 'must be an object' }); return; }
        const pathIssue = validateSeedPath(file.path);
        if (pathIssue) issues.push({ field: `${field}.path`, message: pathIssue });
        else if (seen.has(file.path!)) issues.push({ field: `${field}.path`, message: `Duplicate destination path ${file.path}.` });
        else seen.add(file.path!);
        const modeIssue = validateSeedMode(file.mode);
        if (modeIssue) issues.push({ field: `${field}.mode`, message: modeIssue });
        if (typeof file.id !== 'string' || !file.id || typeof file.name !== 'string' || !file.name) {
            issues.push({ field, message: 'id and name are required' });
        }
        const ref = file.fileRef;
        if (!ref || typeof ref.objectKey !== 'string' || typeof ref.bucketKey !== 'string' || !ref.bucketKey) {
            issues.push({ field: `${field}.fileRef`, message: 'must name a bucket and an object' });
        } else if (!isOwnedObjectKey(ref.objectKey, agentKey)) {
            issues.push({ field: `${field}.fileRef`, message: 'must be a file uploaded for this agent' });
        }
        if (typeof file.size !== 'number' || !(file.size >= 0)) issues.push({ field: `${field}.size`, message: 'must be a number' });
        else {
            if (file.size > SEED_MAX_FILE_BYTES) issues.push({ field: `${field}.size`, message: 'File is larger than 25 MB.' });
            total += file.size;
        }
    });
    if (total > SEED_MAX_TOTAL_BYTES) issues.push({ field: 'sandbox.seedFiles', message: 'Seed files are larger than 100 MB in total.' });
    return issues;
}

/** An object key under `agent-assets/<agentKey>/` (any agent's when `agentKey` is unknown), without climbing out. */
export function isOwnedObjectKey(objectKey: string, agentKey?: string): boolean {
    if (objectKey.includes('..') || objectKey.includes('\0')) return false;
    return agentKey ? objectKey.startsWith(seedObjectPrefix(agentKey)) : /^agent-assets\/[^/]+\/./.test(objectKey);
}

/** Single-quote a string for POSIX sh. */
export function shQuote(value: string): string {
    return `'${value.replace(/'/g, `'\\''`)}'`;
}

export interface SeedApplyRunner {
    exec(input: { command: string; cwd?: string; timeoutSec?: number; signal?: AbortSignal }): Promise<{ exitCode: number; stdout?: string; stderr?: string }>;
}

export interface SeedApplyResult {
    written: string[];
    skipped: string[];
    failed: { path: string; name: string; reason: string }[];
}

export interface ApplySeedFilesInput {
    files: IAgentSandboxSeedFile[];
    agentKey: string;
    runner: SeedApplyRunner;
    readBytes: (file: IAgentSandboxSeedFile) => Promise<Buffer>;
    signal?: AbortSignal;
    onWarn?: (message: string, meta: Record<string, unknown>) => void;
}

/**
 * Writes every seed file that is missing or changed. A file that fails is
 * reported, never thrown: one bad file must not fail the turn.
 */
export async function applySeedFiles(input: ApplySeedFilesInput): Promise<SeedApplyResult> {
    const result: SeedApplyResult = { written: [], skipped: [], failed: [] };
    for (const file of input.files) {
        try {
            const pathIssue = validateSeedPath(file.path);
            if (pathIssue) throw new Error(pathIssue);
            if (!isOwnedObjectKey(file.fileRef.objectKey, input.agentKey)) throw new Error('file reference does not belong to this agent');
            if (file.sha256 && await remoteSha256(input, file.path) === file.sha256) {
                result.skipped.push(file.path);
                continue;
            }
            const bytes = await input.readBytes(file);
            await writeBytes(input, file.path, bytes, file.mode);
            result.written.push(file.path);
        } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            result.failed.push({ path: file.path, name: file.name, reason });
            input.onWarn?.('Could not write a sandbox seed file', { path: file.path, error: reason });
        }
    }
    return result;
}

async function remoteSha256(input: ApplySeedFilesInput, path: string): Promise<string | null> {
    const out = await input.runner.exec({
        command: `test -f ${shQuote(path)} && sha256sum -- ${shQuote(path)} | cut -d' ' -f1`,
        timeoutSec: 30,
        ...(input.signal ? { signal: input.signal } : {}),
    });
    return out.exitCode === 0 ? (out.stdout ?? '').trim() || null : null;
}

async function run(input: ApplySeedFilesInput, command: string): Promise<void> {
    const out = await input.runner.exec({ command, timeoutSec: 120, ...(input.signal ? { signal: input.signal } : {}) });
    if (out.exitCode !== 0) throw new Error((out.stderr ?? '').trim().slice(0, 300) || `exit code ${out.exitCode}`);
}

async function writeBytes(input: ApplySeedFilesInput, path: string, bytes: Buffer, mode?: string): Promise<void> {
    const tmp = `${path}.seed-tmp`;
    await run(input, `mkdir -p ${shQuote((path.slice(0, path.lastIndexOf('/')) || '/'))} && : > ${shQuote(tmp)}`);
    for (let offset = 0; offset < bytes.length; offset += CHUNK_BYTES) {
        const chunk = bytes.subarray(offset, offset + CHUNK_BYTES).toString('base64');
        await run(input, `printf %s '${chunk}' | base64 -d >> ${shQuote(tmp)}`);
    }
    const chmod = mode ? ` && chmod ${mode.replace(/^0?/, '0')} ${shQuote(path)}` : '';
    await run(input, `mv -f ${shQuote(tmp)} ${shQuote(path)}${chmod}`);
}

/** The "Preloaded files" block for the system prompt; failures are listed so the agent does not rely on them. */
export function buildSeedPromptNote(files: IAgentSandboxSeedFile[] | undefined, failed: SeedApplyResult['failed'] = []): string {
    if (!files || files.length === 0) return '';
    const bad = new Set(failed.map((f) => f.path));
    const lines = files.filter((f) => !bad.has(f.path)).map((f) => `- ${f.path} — ${f.name}`);
    const out = [`Preloaded files (placed in your sandbox before you start):\n${lines.join('\n')}`];
    if (failed.length > 0) {
        out.push(`These preloaded files could NOT be written and are not available:\n${failed.map((f) => `- ${f.path} — ${f.name} (${f.reason})`).join('\n')}`);
    }
    return out.join('\n\n');
}
