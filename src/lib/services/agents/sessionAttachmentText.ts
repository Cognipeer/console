/**
 * The words and the shapes a session's attachments take in the model's input —
 * pure, no storage, so the turn assembler (`sessionFiles.ts`), the transcript
 * fallback (`agentTurnState.ts`) and the model wrapper (`sessionImages.ts`)
 * share ONE wording and one reference format.
 *
 * ── Images travel as references, not bytes ─────────────────────────────────
 * An image in the model's input is `{ type: 'image_url', image_url: { url:
 * 'session-file://<fileId>' }, fileId, name }`. The bytes are read from the
 * bucket only at the model call (`withSessionImages`). The agent's saved state,
 * the traces and the SDK's token estimate therefore never carry base64, and an
 * image can be put back in front of the model on any later turn by id.
 *
 * Every image part has a text handle in front of it
 * (`[Attached image: "name" (id …)]`) — without one the model has nothing to
 * call the picture by once the summarizer flattens the turn, and nothing to ask
 * `session_files_view_image` for.
 *
 * Everything the turn adds to the person's text sits after
 * `ATTACHMENT_BLOCK_MARKER`, so the transcript can keep what the person typed
 * (`stripAttachmentBlock`) while the model works from the full turn.
 */

import type { IAgentMessageAttachment } from '@/lib/database/provider/types.domain';
import {
    SESSION_FILES_LIST_TOOL,
    SESSION_FILES_READ_TOOL,
    SESSION_FILES_VIEW_IMAGE_TOOL,
    isImageMime,
} from './sessionFilesConfig';

export const ATTACHMENT_BLOCK_MARKER = '\n\n<attachments source="session-files">\n';
export const ATTACHMENT_BLOCK_END = '\n</attachments>';

/** What the person typed: the user turn without the block the assembler added. */
export function stripAttachmentBlock(text: string): string {
    const at = text.indexOf(ATTACHMENT_BLOCK_MARKER);
    return at >= 0 ? text.slice(0, at) : text;
}

export function escapeAttribute(value: string): string {
    return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ── Image references ────────────────────────────────────────────────────────

export const SESSION_FILE_URL_PREFIX = 'session-file://';

export function sessionFileUrl(fileId: string): string {
    return `${SESSION_FILE_URL_PREFIX}${fileId}`;
}

/** The file id a `session-file://<id>` URL names, else null. */
export function parseSessionFileUrl(url: unknown): string | null {
    if (typeof url !== 'string' || !url.startsWith(SESSION_FILE_URL_PREFIX)) return null;
    const id = url.slice(SESSION_FILE_URL_PREFIX.length).trim();
    return id.length > 0 ? id : null;
}

/** An image of the session as the model's input carries it. */
export interface ImageReferencePart {
    type: 'image_url';
    image_url: { url: string };
    /** Outside `image_url` on purpose: the SDK keeps the part, a placeholder can name the file. */
    fileId: string;
    name: string;
}

export interface TextPart {
    type: 'text';
    text: string;
}

export type ContentPart = TextPart | ImageReferencePart | { type: string; [key: string]: unknown };

export function imageReferencePart(fileId: string, name: string): ImageReferencePart {
    return { type: 'image_url', image_url: { url: sessionFileUrl(fileId) }, fileId, name };
}

/** How an image is introduced: the person attached it now, sent it earlier, or the agent asked to look again. */
export type ImageAnchorKind = 'attached' | 'earlier' | 'requested';

export function imageAnchorText(name: string, fileId: string, kind: ImageAnchorKind = 'attached'): string {
    const label = kind === 'earlier' ? 'Earlier image' : kind === 'requested' ? 'Image you asked to see' : 'Attached image';
    return `[${label}: "${escapeAttribute(name)}" (id ${fileId})]`;
}

/** The anchor and the reference of one image, in the order the model reads them. */
export function imageParts(fileId: string, name: string, kind: ImageAnchorKind = 'attached'): ContentPart[] {
    return [{ type: 'text', text: imageAnchorText(name, fileId, kind) }, imageReferencePart(fileId, name)];
}

// ── The attachment block ────────────────────────────────────────────────────

function plural(count: number, one: string, many = `${one}s`): string {
    return `${count} ${count === 1 ? one : many}`;
}

export interface AttachmentCounts {
    /** Documents whose text is in the turn. */
    documentsInline: number;
    /** Documents the agent reads with the session file tools. */
    documentsPaged: number;
    /** Documents with no readable text (conversion failed or skipped). */
    documentsUnreadable: number;
    /** Images the model is shown. */
    imagesShown: number;
    /** Images the model is not shown, and why (`cannot read images` / `could not be read`). */
    imagesHidden: number;
}

/**
 * The opening line of the block. It names EVERY attachment by kind, so a model
 * (and the summarizer after it) knows what the person sent even when most of it
 * is in the tools or below as pictures: "The person attached 4 files: 3
 * documents to read with the tools, 1 image shown below."
 */
export function attachmentSummaryLine(counts: AttachmentCounts): string {
    const total = counts.documentsInline + counts.documentsPaged + counts.documentsUnreadable + counts.imagesShown + counts.imagesHidden;
    const parts: string[] = [];
    if (counts.documentsInline > 0) parts.push(`${plural(counts.documentsInline, 'document')} included below`);
    if (counts.documentsPaged > 0) {
        parts.push(`${plural(counts.documentsPaged, 'document')} to read with the tools (${SESSION_FILES_LIST_TOOL}, ${SESSION_FILES_READ_TOOL})`);
    }
    if (counts.documentsUnreadable > 0) parts.push(`${plural(counts.documentsUnreadable, 'document')} whose text could not be extracted`);
    if (counts.imagesShown > 0) parts.push(`${plural(counts.imagesShown, 'image')} shown below`);
    if (counts.imagesHidden > 0) parts.push(`${plural(counts.imagesHidden, 'image')} not shown`);
    return `The person attached ${plural(total, 'file')}: ${parts.join(', ')}.`;
}

export function wrapAttachmentBlock(lines: string[]): string {
    return lines.length > 0 ? `${ATTACHMENT_BLOCK_MARKER}${lines.join('\n')}${ATTACHMENT_BLOCK_END}` : '';
}

// ── Earlier turns (transcript fallback, re-attached images) ─────────────────

/**
 * A user turn rebuilt from what the transcript kept: the text the person typed
 * plus its `attachments` (names and ids — the files themselves are read again
 * only when asked for). Used when the agent's saved state is gone and the
 * session is replayed from the transcript: without it the model would be told
 * about a question and none of the files the question was about.
 *
 * Documents are listed for the session file tools; images become references
 * (the model wrapper reads the bytes) when the model takes images, else a note.
 */
export function rebuildUserTurn(
    text: string,
    attachments: IAgentMessageAttachment[] | undefined,
    options: { supportsVision: boolean },
): string | ContentPart[] {
    if (!attachments || attachments.length === 0) return text;

    const documents = attachments.filter((entry) => !isImageMime(entry.mimeType));
    const images = attachments.filter((entry) => isImageMime(entry.mimeType));
    const shown = options.supportsVision ? images : [];
    const hidden = options.supportsVision ? [] : images;

    const lines: string[] = [
        attachmentSummaryLine({
            documentsInline: 0,
            documentsPaged: documents.length,
            documentsUnreadable: 0,
            imagesShown: shown.length,
            imagesHidden: hidden.length,
        }),
        ...documents.map((entry) => `- "${escapeAttribute(entry.name)}" (id ${entry.fileId})`),
        ...hidden.map((entry) => `[Image "${escapeAttribute(entry.name)}" (id ${entry.fileId}) was attached, but this model cannot read images.]`),
    ];
    const block = wrapAttachmentBlock(lines);
    if (shown.length === 0) return `${text}${block}`;
    return [
        { type: 'text', text: `${text}${block}` },
        ...shown.flatMap((entry) => imageParts(entry.fileId, entry.name)),
    ];
}

/** The text that tells the model a tool result is followed by the image it asked for. */
export function viewImageToolResult(fileId: string, name: string): string {
    return JSON.stringify({
        ok: true,
        fileId,
        name,
        note: `The image is shown to you in the message that follows. (${SESSION_FILES_VIEW_IMAGE_TOOL})`,
    });
}

// ── Images that fell out of the agent's context ─────────────────────────────

/** The file id an image part refers to (its `fileId`, else the id in a `session-file://` URL), or null. */
export function imageFileIdOf(part: unknown): string | null {
    if (!part || typeof part !== 'object') return null;
    const record = part as { type?: unknown; fileId?: unknown; image_url?: unknown };
    if (record.type !== 'image_url') return null;
    if (typeof record.fileId === 'string' && record.fileId) return record.fileId;
    const image = record.image_url;
    if (typeof image === 'string') return parseSessionFileUrl(image);
    if (image && typeof image === 'object') return parseSessionFileUrl((image as { url?: unknown }).url);
    return null;
}

/** File ids of every image reference the messages carry. */
export function referencedImageIds(messages: ReadonlyArray<{ content?: unknown }>): Set<string> {
    const ids = new Set<string>();
    for (const message of messages) {
        if (!Array.isArray(message.content)) continue;
        for (const part of message.content) {
            const id = imageFileIdOf(part);
            if (id) ids.add(id);
        }
    }
    return ids;
}

/**
 * The images of the person's last `turns` image-bearing messages, oldest first.
 * "Image-bearing" because that is what the setting means to a person: the photo
 * they sent a few questions ago, however many text-only turns lie between.
 */
export function recentImageAttachments(
    history: ReadonlyArray<{ role: string; attachments?: IAgentMessageAttachment[] }>,
    turns: number,
): IAgentMessageAttachment[] {
    if (turns <= 0) return [];
    const picked: IAgentMessageAttachment[][] = [];
    for (let i = history.length - 1; i >= 0 && picked.length < turns; i -= 1) {
        const message = history[i]!;
        if (message.role !== 'user') continue;
        const images = (message.attachments ?? []).filter((entry) => isImageMime(entry.mimeType));
        if (images.length > 0) picked.unshift(images);
    }
    return picked.flat();
}

/** A user turn with images of earlier messages shown again after it. */
export function withEarlierImages(
    content: string | ContentPart[],
    images: ReadonlyArray<{ fileId: string; name: string }>,
): string | ContentPart[] {
    if (images.length === 0) return content;
    const parts: ContentPart[] = typeof content === 'string' ? [{ type: 'text', text: content }] : [...content];
    for (const image of images) parts.push(...imageParts(image.fileId, image.name, 'earlier'));
    return parts;
}
