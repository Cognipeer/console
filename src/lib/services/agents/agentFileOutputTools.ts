/**
 * Files an agent writes itself, without a sandbox: `session_files_create` and
 * `session_files_append` (`attachments.outputs`, on by default for an agent that has a files bucket).
 *
 * The agent hands the person a text document (report, export, notes) in one call; a long one is
 * created and then appended to in parts. The files are stored as session files of origin
 * `agent_output` (sessionFiles.ts: `saveAgentOutputFile` / `appendAgentOutputFile`, which hold them
 * to the same size, count and project quota limits an upload meets) and delivered at the end of the
 * turn on the assistant message, the way a sandbox's `/outputs/` files are (`mergeOutputCollectors`).
 */

import { Buffer } from 'node:buffer';
import type { createTool as CreateSdkTool, ToolInterface as AgentSdkToolInterface } from '@cognipeer/agent-sdk';
import type { IAgentConfig, IAgentConversation, IAgentMessageAttachment } from '@/lib/database';
import { createLogger } from '@/lib/core/logger';
import type { TraceToolDefinition } from '@/lib/services/tracingToolDefinitions';
import { AgentAttachmentError } from './agentErrors';
import { sessionFileDownloadUrl } from './clientWire';
import {
    FILE_OUTPUT_EXTENSIONS,
    FILE_OUTPUT_MIME_ALIASES,
    FILE_OUTPUT_TYPES,
    SESSION_FILES_APPEND_TOOL,
    SESSION_FILES_CREATE_TOOL,
    type ResolvedOutputsConfig,
} from './sessionFilesConfig';
import {
    appendAgentOutputFile,
    listSessionFiles,
    saveAgentOutputFile,
    type AgentOutputTurn,
    type SessionFileScope,
} from './sessionFiles';

const logger = createLogger('agent-file-outputs');

/** Longest file name stem (before the extension) kept. */
const MAX_STEM_LENGTH = 100;

/**
 * A file name from the model as a safe stem and one of the allowed extensions. Directories are
 * dropped, anything but letters, digits and `. _ -` becomes `-`, so no name can address a path.
 */
export function parseOutputFileName(raw: unknown): { stem: string; ext: string } | { error: string } {
    if (typeof raw !== 'string' || raw.trim() === '') return { error: 'filename is required.' };
    const base = raw.trim().split(/[\\/]/).pop() ?? '';
    const dot = base.lastIndexOf('.');
    const ext = dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
    if (!FILE_OUTPUT_TYPES[ext]) {
        return { error: `The file name needs one of these extensions: ${FILE_OUTPUT_EXTENSIONS.map((e) => `.${e}`).join(' ')}.` };
    }
    const stem = base.slice(0, dot)
        .normalize('NFC')
        .replace(/[^\p{L}\p{N}._-]+/gu, '-')
        .replace(/\.{2,}/g, '.')
        .replace(/^[-.]+|[-.]+$/g, '')
        .slice(0, MAX_STEM_LENGTH) || 'file';
    return { stem, ext };
}

/** The MIME type a file is stored as: derived from the extension; a declared `mime_type` that disagrees is refused. */
export function resolveOutputMime(ext: string, declared: unknown): { mimeType: string } | { error: string } {
    const mimeType = FILE_OUTPUT_TYPES[ext]!;
    if (declared === undefined || declared === null || declared === '') return { mimeType };
    const given = typeof declared === 'string' ? declared.split(';')[0]!.trim().toLowerCase() : '';
    if (given === mimeType || FILE_OUTPUT_MIME_ALIASES[ext]?.includes(given)) return { mimeType };
    return { error: `mime_type "${String(declared)}" does not match .${ext} files (${mimeType}). Leave mime_type out to use it.` };
}

/** `name.ext`, or `name-1.ext`, `name-2.ext`… when a file of that name (any case) is already in the session. */
export function uniqueOutputName(stem: string, ext: string, taken: Iterable<string>): string {
    const used = new Set([...taken].map((name) => name.toLowerCase()));
    let name = `${stem}.${ext}`;
    for (let n = 1; used.has(name.toLowerCase()); n += 1) name = `${stem}-${n}.${ext}`;
    return name;
}

export interface OutputCollection {
    attachments: IAgentMessageAttachment[];
    warnings: string[];
}

/** Runs several end-of-turn collectors (sandbox `/outputs/`, the file tools) and merges what they found. */
export function mergeOutputCollectors(...collectors: Array<() => Promise<OutputCollection>>): () => Promise<OutputCollection> {
    return async () => {
        const merged: OutputCollection = { attachments: [], warnings: [] };
        const seen = new Set<string>();
        for (const collect of collectors) {
            const found = await collect();
            for (const attachment of found.attachments) {
                if (seen.has(attachment.fileId)) continue;
                seen.add(attachment.fileId);
                merged.attachments.push(attachment);
            }
            merged.warnings.push(...found.warnings);
        }
        return merged;
    };
}

/** The system-prompt section naming the tools and their limits. */
export function fileOutputsPrompt(limits: ResolvedOutputsConfig): string {
    return [
        '## Files you can create',
        `To give the user a document (report, export, notes), call ${SESSION_FILES_CREATE_TOOL}({ filename, content }). Allowed file types: ${FILE_OUTPUT_EXTENSIONS.map((e) => `.${e}`).join(' ')}.`,
        `To add to a file you created earlier in this conversation, call ${SESSION_FILES_APPEND_TOOL}({ file_id, content }); build a long file in parts that way.`,
        `Limits: ${limits.maxFilesPerTurn} new files per turn, ${limits.maxFileSizeMb} MB per file. Files are delivered to the user automatically after your turn, so mention the file names in your answer instead of pasting the content.`,
    ].join('\n');
}

export interface FileOutputToolDeps {
    createToolFn: typeof CreateSdkTool;
    zod: typeof import('zod').z;
    guard: {
        protect<A extends Record<string, unknown>, R>(
            spec: { name: string; requestedName: string },
            execute: (safeArgs: A) => Promise<R>,
        ): (args: A) => Promise<R | string>;
    };
    scope: SessionFileScope;
    conversation: Pick<IAgentConversation, '_id' | 'agentKey'>;
    agentConfig: IAgentConfig;
    actorId: string;
    tokenId?: string;
    limits: ResolvedOutputsConfig;
}

export interface FileOutputTools {
    tools: AgentSdkToolInterface[];
    definitions: TraceToolDefinition[];
    /** The files this run created or appended to, for the end of the turn. Never throws. */
    collectOutputs: () => Promise<OutputCollection>;
}

export function buildFileOutputTools(deps: FileOutputToolDeps): FileOutputTools {
    const { createToolFn, zod, guard, scope, conversation, limits } = deps;
    const conversationId = String(conversation._id);
    const maxFileBytes = Math.floor(limits.maxFileSizeMb * 1024 * 1024);
    const turn: AgentOutputTurn = { saved: 0, maxFiles: limits.maxFilesPerTurn };
    const touched = new Map<string, IAgentMessageAttachment>();

    // Calls of one turn can arrive together: one at a time keeps names unique, the turn's count true
    // and an append from reading a file another append is still writing.
    let chain: Promise<unknown> = Promise.resolve();
    const serial = <T>(fn: () => Promise<T>): Promise<T> => {
        const run = chain.then(fn, fn);
        chain = run.catch(() => undefined);
        return run;
    };

    const result = (file: IAgentMessageAttachment) => JSON.stringify({
        file_id: file.fileId,
        filename: file.name,
        mime_type: file.mimeType,
        size_bytes: file.size,
        download_url: sessionFileDownloadUrl(conversationId, file.fileId),
    });

    const refusal = (error: unknown, what: string): string => {
        if (error instanceof AgentAttachmentError) return `${what}: ${error.message}`;
        logger.warn('A file the agent wrote could not be saved', { error: error instanceof Error ? error.message : String(error) });
        return `${what}: the file could not be saved right now.`;
    };

    const create = createToolFn({
        name: SESSION_FILES_CREATE_TOOL,
        description: [
            'Create a text file for the user (report, export, notes). It is delivered to them after your turn.',
            `Allowed types: ${FILE_OUTPUT_EXTENSIONS.map((e) => `.${e}`).join(' ')}. Up to ${limits.maxFilesPerTurn} files per turn, ${limits.maxFileSizeMb} MB each.`,
            'Returns { file_id, filename, mime_type, size_bytes, download_url }. A name already used in this conversation gets a "-1" style suffix.',
        ].join(' '),
        schema: zod.object({
            filename: zod.string().describe('File name with its extension, e.g. "report.md". Directories are ignored.'),
            content: zod.string().describe('The full text of the file.'),
            mime_type: zod.string().optional().describe('Optional; must match the extension (it is derived from it when left out).'),
        }),
        func: guard.protect(
            { name: 'agent.session_files.create', requestedName: SESSION_FILES_CREATE_TOOL },
            (args: { filename?: unknown; content?: unknown; mime_type?: unknown }) => serial(async () => {
                const parsed = parseOutputFileName(args.filename);
                if ('error' in parsed) return parsed.error;
                const mime = resolveOutputMime(parsed.ext, args.mime_type);
                if ('error' in mime) return mime.error;
                if (typeof args.content !== 'string' || args.content.length === 0) return 'content is required and cannot be empty.';
                try {
                    const taken = (await listSessionFiles(scope, conversationId)).map((file) => file.name);
                    const file = await saveAgentOutputFile({
                        scope,
                        conversation,
                        agentConfig: deps.agentConfig,
                        fileName: uniqueOutputName(parsed.stem, parsed.ext, taken),
                        contentType: mime.mimeType,
                        data: Buffer.from(args.content, 'utf8'),
                        actorId: deps.actorId,
                        ...(deps.tokenId ? { tokenId: deps.tokenId } : {}),
                        maxFileBytes,
                        turn,
                    });
                    touched.set(file.fileId, file);
                    return result(file);
                } catch (error) {
                    return refusal(error, 'Could not create the file');
                }
            }),
        ),
    }) as AgentSdkToolInterface;

    const append = createToolFn({
        name: SESSION_FILES_APPEND_TOOL,
        description: [
            'Add text to the end of a file you created earlier in this conversation with session_files_create.',
            `The file stays within ${limits.maxFileSizeMb} MB. Returns { file_id, filename, mime_type, size_bytes, download_url }.`,
        ].join(' '),
        schema: zod.object({
            file_id: zod.string().describe('The file_id returned by session_files_create.'),
            content: zod.string().describe('The text to add after the current end of the file.'),
        }),
        func: guard.protect(
            { name: 'agent.session_files.append', requestedName: SESSION_FILES_APPEND_TOOL },
            (args: { file_id?: unknown; content?: unknown }) => serial(async () => {
                if (typeof args.file_id !== 'string' || args.file_id.trim() === '') return 'file_id is required.';
                if (typeof args.content !== 'string' || args.content.length === 0) return 'content is required and cannot be empty.';
                try {
                    const file = await appendAgentOutputFile({
                        scope,
                        conversation,
                        fileId: args.file_id.trim(),
                        data: Buffer.from(args.content, 'utf8'),
                        actorId: deps.actorId,
                        ...(deps.tokenId ? { tokenId: deps.tokenId } : {}),
                        maxFileBytes,
                    });
                    touched.set(file.fileId, file);
                    return result(file);
                } catch (error) {
                    return refusal(error, 'Could not append to the file');
                }
            }),
        ),
    }) as AgentSdkToolInterface;

    return {
        tools: [create, append],
        definitions: [
            {
                name: SESSION_FILES_CREATE_TOOL,
                description: 'Create a text file for the user; delivered after the turn.',
                parameters: {
                    type: 'object',
                    properties: {
                        filename: { type: 'string', description: 'File name with extension.' },
                        content: { type: 'string', description: 'The full text of the file.' },
                        mime_type: { type: 'string', description: 'Optional; must match the extension.' },
                    },
                    required: ['filename', 'content'],
                },
            },
            {
                name: SESSION_FILES_APPEND_TOOL,
                description: 'Add text to the end of a file this agent created in this conversation.',
                parameters: {
                    type: 'object',
                    properties: {
                        file_id: { type: 'string', description: 'The file_id from session_files_create.' },
                        content: { type: 'string', description: 'The text to add.' },
                    },
                    required: ['file_id', 'content'],
                },
            },
        ],
        collectOutputs: async () => ({ attachments: [...touched.values()], warnings: [] }),
    };
}
