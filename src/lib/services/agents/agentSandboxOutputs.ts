/**
 * Sandbox outputs as attachments.
 *
 * A sandboxed agent is told to write the files it wants the user to have to
 * `/outputs/`. At the end of each turn the platform lists that folder, saves
 * what is new or changed as session files (origin `agent_output`) and attaches
 * them to the assistant message. Pure and dependency-injected: the sandbox
 * wiring lives in agentSandboxTools.ts, the storage in sessionFiles.ts.
 */

import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import type { IAgentMessageAttachment } from '@/lib/database';

export const SANDBOX_OUTPUTS_DIR = '/outputs';
/** Most files one turn delivers; the rest wait for a later turn's listing. */
export const SANDBOX_OUTPUTS_MAX_FILES = 20;
/** Entries one listing looks at. */
export const SANDBOX_OUTPUTS_MAX_ENTRIES = 500;
/** Wall-clock budget for reading the files of one turn. */
export const SANDBOX_OUTPUTS_READ_BUDGET_MS = 120_000;
/** Bytes per `exec` read: base64 grows it by a third and an exec's stdout is capped near 32 KiB. */
export const SANDBOX_OUTPUTS_CHUNK_BYTES = 18_000;

/** The system-prompt section of an agent whose sandbox is on. */
export const SANDBOX_OUTPUTS_PROMPT = [
    '## Files for the user',
    `Files meant for the user (reports, documents, images, data exports, code archives) must be written to ${SANDBOX_OUTPUTS_DIR}/ in the sandbox (create the directory if needed).`,
    'Use descriptive file names with the right extension. Files in that folder are delivered to the user automatically after your turn, so do not create preview links just to share a file, and mention the file names in your answer.',
    `Everything else (scratch work, build output) belongs in the working directory, not in ${SANDBOX_OUTPUTS_DIR}/.`,
].join('\n');

/** Appends the outputs section to a system prompt. */
export function withSandboxOutputsPrompt(systemPrompt: string | undefined): string {
    return systemPrompt ? `${systemPrompt}\n\n${SANDBOX_OUTPUTS_PROMPT}` : SANDBOX_OUTPUTS_PROMPT;
}

export interface OutputEntry {
    /** Absolute path in the sandbox. */
    path: string;
    size: number;
    /** Modification time (epoch seconds), when the sandbox can tell. */
    mtime?: number;
}

export interface CollectOutputsDeps {
    list: () => Promise<OutputEntry[]>;
    readBytes: (entry: OutputEntry) => Promise<Buffer>;
    store: (file: { name: string; data: Buffer }) => Promise<IAgentMessageAttachment>;
    /** path -> signature of what was delivered before. */
    seen: Record<string, string>;
    maxFiles?: number;
    maxFileBytes: number;
    now?: () => number;
    readBudgetMs?: number;
}

export interface CollectOutputsResult {
    attachments: IAgentMessageAttachment[];
    /** `seen` after this turn; unchanged files keep their entry. */
    seen: Record<string, string>;
    warnings: string[];
}

/** The file name a path under `/outputs` is delivered as: relative, with `/` flattened. */
export function outputFileName(path: string): string {
    const rel = path.startsWith(`${SANDBOX_OUTPUTS_DIR}/`) ? path.slice(SANDBOX_OUTPUTS_DIR.length + 1) : path.replace(/^\/+/, '');
    return rel.replace(/\//g, '_') || 'output';
}

/** Parses `find /outputs -type f -exec stat -c '%Y|%s|%n'` output. */
export function parseStatListing(stdout: string): OutputEntry[] {
    const entries: OutputEntry[] = [];
    for (const line of stdout.split('\n')) {
        const m = /^(\d+)\|(\d+)\|(.+)$/.exec(line.trim());
        if (!m) continue;
        entries.push({ mtime: Number(m[1]), size: Number(m[2]), path: m[3]! });
        if (entries.length >= SANDBOX_OUTPUTS_MAX_ENTRIES) break;
    }
    return entries;
}

export async function collectSandboxOutputs(deps: CollectOutputsDeps): Promise<CollectOutputsResult> {
    const maxFiles = deps.maxFiles ?? SANDBOX_OUTPUTS_MAX_FILES;
    const now = deps.now ?? Date.now;
    const deadline = now() + (deps.readBudgetMs ?? SANDBOX_OUTPUTS_READ_BUDGET_MS);
    const seen = { ...deps.seen };
    const attachments: IAgentMessageAttachment[] = [];
    const warnings: string[] = [];

    let entries: OutputEntry[];
    try {
        entries = (await deps.list()).filter((e) => e.path.startsWith(`${SANDBOX_OUTPUTS_DIR}/`) && !e.path.includes('/../'));
    } catch (error) {
        return { attachments, seen, warnings: [`Could not list ${SANDBOX_OUTPUTS_DIR}: ${error instanceof Error ? error.message : String(error)}`] };
    }
    entries.sort((a, b) => a.path.localeCompare(b.path));

    for (const entry of entries) {
        const quick = entry.mtime !== undefined ? `${entry.size}:${entry.mtime}` : undefined;
        if (quick && seen[entry.path] === quick) continue;
        if (attachments.length >= maxFiles) {
            warnings.push(`More than ${maxFiles} new output files; the rest were not delivered this turn.`);
            break;
        }
        const name = outputFileName(entry.path);
        if (entry.size === 0) continue;
        if (entry.size > deps.maxFileBytes) {
            warnings.push(`Output file "${name}" is larger than the ${Math.floor(deps.maxFileBytes / 1024 / 1024)} MB limit and was not delivered.`);
            continue;
        }
        if (now() > deadline) {
            warnings.push('Reading output files took too long; the rest were not delivered this turn.');
            break;
        }
        try {
            const data = await deps.readBytes(entry);
            if (data.length === 0) continue;
            const signature = quick ?? `${data.length}:h${createHash('sha1').update(data).digest('hex')}`;
            if (seen[entry.path] === signature) continue;
            attachments.push(await deps.store({ name, data }));
            seen[entry.path] = signature;
        } catch (error) {
            warnings.push(`Output file "${name}" could not be saved: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    return { attachments, seen, warnings };
}

/** Quotes a path for `sh -c`. */
export function shQuote(value: string): string {
    return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Reads a sandbox file byte-for-byte through `exec`, in base64 chunks (the
 * runner's `readFile` is utf8-only and capped).
 */
export async function readBytesViaExec(
    exec: (command: string) => Promise<{ exitCode: number; stdout: string; stderr: string }>,
    path: string,
    size: number,
): Promise<Buffer> {
    const parts: Buffer[] = [];
    for (let offset = 0; offset < size; offset += SANDBOX_OUTPUTS_CHUNK_BYTES) {
        const res = await exec(`tail -c +${offset + 1} ${shQuote(path)} | head -c ${SANDBOX_OUTPUTS_CHUNK_BYTES} | base64 | tr -d '\\n'`);
        if (res.exitCode !== 0) throw new Error(res.stderr.trim().slice(0, 200) || `read failed (exit ${res.exitCode})`);
        parts.push(Buffer.from(res.stdout.trim(), 'base64'));
    }
    return Buffer.concat(parts);
}
