/**
 * The pictures inside a chat message, found in its content parts, so a request
 * inspector can show them instead of the word "[image]".
 *
 * Content arrives in several dialects — Chat Completions (`image_url` with a
 * `{ url }` or a string), the Responses API (`input_image`), Anthropic (`image`
 * with a base64 `source`) — and, for a session file, as a reference
 * (`session-file://<id>`) rather than the bytes. Only what a request already
 * carries is drawn: an inline `data:image/…` picture becomes a thumbnail, a
 * session-file reference a muted chip, and an address on another site a link to
 * click. The page never fetches an image address a caller put in a request —
 * that would send the viewer's browser to wherever the request pointed.
 *
 * The one address it does draw from is its own: when the trace is a session's, the
 * caller says which (`sessionFiles`) and a `session-file://` reference becomes a
 * thumbnail from that session's content route — a route of this app, under the
 * session's own access check. If the route refuses the viewer or the file is gone,
 * the thumbnail gives way to the named chip (`fallbackToChip`).
 */

import { sessionFileLinks, type AttachmentView } from '@/components/agents/session/sessionFilesUi';

/** The most pictures drawn for one message; a request can hold hundreds. */
export const MAX_MESSAGE_IMAGES = 24;

/** The session a trace belongs to: where its `session-file://` pictures can be fetched from. */
export interface TraceSessionFiles {
  agentId: string;
  sessionId: string;
}

export interface MessageImageOptions {
  /** Set when the trace is an agent session's; without it a session-file reference stays a named chip. */
  sessionFiles?: TraceSessionFiles | null;
}

const SESSION_FILE_SCHEME = 'session-file://';
const DATA_IMAGE = /^data:(image\/[a-z0-9.+-]+)(?:;[a-z0-9=.+-]+)*?(;base64)?,/i;

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** The address of a part: `image_url` is a string or `{ url }`, `source.url` for URL sources. */
function partAddress(part: Record<string, unknown>): string | undefined {
  const direct = part.image_url;
  if (typeof direct === 'string') return direct;
  if (direct && typeof direct === 'object') return asString((direct as { url?: unknown }).url);
  const source = part.source;
  if (source && typeof source === 'object') {
    const record = source as { type?: unknown; url?: unknown; media_type?: unknown; data?: unknown };
    if (record.type === 'base64' && typeof record.data === 'string') {
      return `data:${asString(record.media_type) ?? 'image/png'};base64,${record.data}`;
    }
    return asString(record.url);
  }
  return undefined;
}

/** Bytes behind a base64 payload, from its length. */
function base64Bytes(address: string): number | undefined {
  const comma = address.indexOf(',');
  if (comma < 0) return undefined;
  const payload = address.slice(comma + 1);
  const padding = payload.endsWith('==') ? 2 : payload.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((payload.length * 3) / 4) - padding);
}

function hostOf(address: string): string {
  try {
    const { host, pathname } = new URL(address);
    const last = pathname.split('/').filter(Boolean).pop();
    return last ? `${host}/…/${last}` : host;
  } catch {
    return address.slice(0, 40);
  }
}

/** A document part (`file` / `input_file`) as a chip: only what the request names, never a download. */
function fileViewOf(part: Record<string, unknown>, index: number): AttachmentView | null {
  const file = part.file && typeof part.file === 'object' ? (part.file as Record<string, unknown>) : {};
  const fileId = asString(part.fileId) ?? asString(part.file_id) ?? asString(file.file_id);
  const name = asString(part.name) ?? asString(part.filename) ?? asString(file.filename);
  if (!fileId && !name) return null;
  return { fileId: fileId ?? `file-${index + 1}`, name: name ?? fileId!, mimeType: 'application/octet-stream', reference: true };
}

/** One image or file part as something to draw, or null when it is not one this can show. */
function viewOf(part: Record<string, unknown>, index: number, options?: MessageImageOptions): AttachmentView | null {
  const type = part.type;
  if (type === 'file' || type === 'input_file') return fileViewOf(part, index);
  if (type !== 'image_url' && type !== 'input_image' && type !== 'image') return null;

  const address = partAddress(part);
  const fileId = asString(part.fileId) ?? asString(part.file_id);
  const name = asString(part.name) ?? asString(part.filename);

  if (address?.startsWith(SESSION_FILE_SCHEME) || (!address && fileId)) {
    const id = fileId ?? address!.slice(SESSION_FILE_SCHEME.length);
    const session = options?.sessionFiles;
    if (session && id) {
      // The trace is this session's: draw the picture from its content route. The route decides whether the
      // viewer may see it; when it says no (or the file is gone) the thumbnail becomes the named chip.
      return {
        fileId: id,
        name: name ?? id,
        mimeType: 'image/*',
        ...sessionFileLinks(session.agentId, session.sessionId, id),
        fallbackToChip: true,
      };
    }
    return { fileId: id, name: name ?? id, mimeType: 'image/*', reference: true };
  }
  // A picture that is only a name (a recording cut off inside it): listed, with nothing to open.
  if (!address && name) return { fileId: `image-${index + 1}`, name, mimeType: 'image/*' };
  if (!address) return null;

  const inline = DATA_IMAGE.exec(address);
  if (inline) {
    return {
      fileId: fileId ?? `image-${index + 1}`,
      name: name ?? `Image ${index + 1}`,
      mimeType: inline[1].toLowerCase(),
      size: inline[2] ? base64Bytes(address) : undefined,
      url: address,
    };
  }
  if (/^https?:\/\//i.test(address)) {
    return {
      fileId: fileId ?? `image-${index + 1}`,
      name: name ?? hostOf(address),
      mimeType: 'image/*',
      url: address,
      external: true,
    };
  }
  return null;
}

/** The pictures and files of a message's content (an array of parts); a plain string holds none. */
export function messageImageViews(content: unknown, options?: MessageImageOptions): AttachmentView[] {
  if (!Array.isArray(content)) return [];
  const views: AttachmentView[] = [];
  content.forEach((part, index) => {
    if (views.length >= MAX_MESSAGE_IMAGES || !part || typeof part !== 'object') return;
    const view = viewOf(part as Record<string, unknown>, index, options);
    if (view) views.push(view);
  });
  return views;
}

/**
 * The content without the parts that `messageImageViews` draws, for the text
 * above them: a picture is shown once, as a picture, not also as "[image]".
 * Parts it cannot draw stay, so the text still says something was there.
 */
export function contentWithoutDrawnParts(content: unknown): unknown {
  if (!Array.isArray(content)) return content;
  let drawn = 0;
  return content.filter((part, index) => {
    if (!part || typeof part !== 'object') return true;
    if (drawn >= MAX_MESSAGE_IMAGES) return true;
    const isDrawn = viewOf(part as Record<string, unknown>, index) !== null;
    if (isDrawn) drawn += 1;
    return !isDrawn;
  });
}
