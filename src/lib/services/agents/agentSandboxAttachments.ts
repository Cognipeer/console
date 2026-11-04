/**
 * Files the user attached to the conversation, placed in the agent's sandbox.
 *
 * Session files live in the Document Store; without this the agent could only read their text copy through
 * `read`, never unzip a project or grep it. They are written to `/inputs/` whenever the sandbox
 * is provisioned for a turn, so a file attached in a later turn arrives too. A file already there with the
 * same size is not sent again.
 */

import { shQuote, writeBytes, SEED_MAX_FILE_BYTES, type SeedApplyRunner } from './agentSandboxSeedFiles';

export const ATTACHMENTS_DIR = '/inputs';
/** The newest files win when a conversation holds more than this. */
export const ATTACHMENTS_MAX_FILES = 25;

export interface StageableFile {
    id: string;
    name: string;
    size: number;
    createdAt?: Date | string;
}

export interface StageResult {
    written: string[];
    skipped: string[];
    failed: { path: string; name: string; reason: string }[];
}

/** A file name that stays inside the folder. */
function safeName(name: string): string {
    return name.replace(/[\\/\0]/g, '_').trim().replace(/^\.+$/, '_') || 'file';
}

/** Where each file goes: its own name, or `<id>_<name>` when an earlier file already took that name. */
export function attachmentPaths(files: StageableFile[]): { file: StageableFile; path: string }[] {
    const taken = new Set<string>();
    return files.map((file) => {
        let name = safeName(file.name);
        if (taken.has(name)) name = `${file.id}_${name}`;
        taken.add(name);
        return { file, path: `${ATTACHMENTS_DIR}/${name}` };
    });
}

/** Writes the conversation's files into the sandbox. A failing file is reported, never thrown. */
export async function stageSessionFiles(input: {
    files: StageableFile[];
    runner: SeedApplyRunner;
    readBytes: (file: StageableFile) => Promise<Buffer>;
    signal?: AbortSignal;
    onWarn?: (message: string, meta: Record<string, unknown>) => void;
}): Promise<StageResult> {
    const result: StageResult = { written: [], skipped: [], failed: [] };
    const time = (file: StageableFile) => (file.createdAt ? new Date(file.createdAt).getTime() : 0);
    const newest = [...input.files].sort((a, b) => time(a) - time(b)).slice(-ATTACHMENTS_MAX_FILES);
    for (const { file, path } of attachmentPaths(newest)) {
        try {
            if (file.size > SEED_MAX_FILE_BYTES) throw new Error('larger than 25 MB');
            const probe = await input.runner.exec({
                command: `stat -c %s ${shQuote(path)}`,
                timeoutSec: 30,
                ...(input.signal ? { signal: input.signal } : {}),
            });
            if (probe.exitCode === 0 && Number((probe.stdout ?? '').trim()) === file.size) {
                result.skipped.push(path);
                continue;
            }
            await writeBytes(input, path, await input.readBytes(file));
            result.written.push(path);
        } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            result.failed.push({ path, name: file.name, reason });
            input.onWarn?.('Could not place an attached file in the sandbox', { path, error: reason });
        }
    }
    return result;
}
