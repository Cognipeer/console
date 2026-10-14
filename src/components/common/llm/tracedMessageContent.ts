/**
 * A traced message's content, as parts the request inspector can draw.
 *
 * Since agent-sdk 0.10.6 a message section that carries a picture, audio or a
 * file has its structured `parts` (text parts included, in order) beside the
 * `content` string, which then only names the attachment (`[image: photo.png]`).
 * Those parts are drawn as they are.
 *
 * Recordings made by an older SDK keep a message's content as ONE string. For plain
 * text that is the text itself; for a message made of content parts (the text, the
 * attachment note, a picture) the recorder flattened each part with
 * `JSON.stringify(part, null, 2)` and joined them with newlines, so the
 * inspector showed
 *
 *     {
 *       "type": "text",
 *       "text": "look at these files…"
 *     }
 *
 * where the person's message and the pictures were. For such a recording the
 * flattened text is read back: every top-level JSON object that is
 * a content part becomes that part again, anything else stays text. A recording
 * that was cut short in the middle of a part (tracing truncates long sections)
 * still yields a text part up to the cut, and a picture is named as such rather
 * than printed.
 *
 * Nothing here fetches or trusts an address: the parts only go to the same
 * drawing code as any other request (`messageImageViews`).
 */

type Part = Record<string, unknown>;

/** Part types that name something to draw or list besides text. */
const MEDIA_TYPES = new Set(['image_url', 'input_image', 'image', 'file', 'input_file', 'input_audio', 'audio']);
const TEXT_TYPES = new Set(['text', 'input_text', 'output_text']);

function isRecord(value: unknown): value is Part {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isContentPart(value: unknown): value is Part {
    if (!isRecord(value) || typeof value.type !== 'string') return false;
    if (TEXT_TYPES.has(value.type)) return typeof value.text === 'string';
    return MEDIA_TYPES.has(value.type);
}

/** Index just past the `}` that closes the object opening at `start`, or -1 when the text ends first. */
function objectEnd(text: string, start: number): number {
    let depth = 0;
    let inString = false;
    for (let index = start; index < text.length; index += 1) {
        const char = text[index];
        if (inString) {
            if (char === '\\') index += 1;
            else if (char === '"') inString = false;
        } else if (char === '"') {
            inString = true;
        } else if (char === '{') {
            depth += 1;
        } else if (char === '}') {
            depth -= 1;
            if (depth === 0) return index + 1;
        }
    }
    return -1;
}

/**
 * What can be said about a part that was cut off: its text up to the cut, or
 * that it was a picture / file (never its raw characters).
 */
function salvageCut(tail: string): Part | null {
    const kind = /^\{\s*"type"\s*:\s*"([a-z_]+)"/.exec(tail)?.[1];
    if (!kind) return null;
    if (TEXT_TYPES.has(kind)) {
        const body = /"text"\s*:\s*"((?:[^"\\]|\\.)*)/.exec(tail)?.[1];
        if (body === undefined) return null;
        let text = body;
        // A cut can leave half an escape at the end; drop it, then decode what is there.
        for (let drop = 0; drop < 7; drop += 1) {
            try {
                text = JSON.parse(`"${body.slice(0, body.length - drop)}"`) as string;
                break;
            } catch { /* try one character shorter */ }
        }
        return { type: 'text', text: `${text}…` };
    }
    if (MEDIA_TYPES.has(kind)) {
        const name = /"(?:name|filename)"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(tail)?.[1];
        const fileId = /"(?:fileId|file_id)"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(tail)?.[1];
        return {
            type: kind === 'file' || kind === 'input_file' ? 'input_file' : 'input_image',
            ...(name ? { name } : {}),
            ...(fileId ? { fileId } : {}),
            // A cut picture has no address to draw; the inspector lists it by what is left of its name.
            ...(!fileId && !name ? { name: kind === 'file' || kind === 'input_file' ? 'File' : 'Image' } : {}),
            truncated: true,
        };
    }
    return null;
}

/**
 * The parts a flattened content string was made of, or null when it holds no
 * JSON part (plain text — show it as it is).
 */
export function parseFlattenedParts(text: string): Part[] | null {
    if (!text.includes('"type"')) return null;
    const parts: Part[] = [];
    let found = false;
    let plain = '';
    const flush = () => {
        const trimmed = plain.trim();
        if (trimmed) parts.push({ type: 'text', text: trimmed });
        plain = '';
    };

    let index = 0;
    while (index < text.length) {
        // A part starts at the beginning of a line.
        const atLineStart = index === 0 || text[index - 1] === '\n';
        if (text[index] === '{' && atLineStart) {
            const end = objectEnd(text, index);
            if (end > 0) {
                let parsed: unknown;
                try { parsed = JSON.parse(text.slice(index, end)); } catch { parsed = undefined; }
                if (isContentPart(parsed)) {
                    flush();
                    parts.push(parsed);
                    found = true;
                    index = end;
                    continue;
                }
            } else {
                const salvaged = salvageCut(text.slice(index));
                if (salvaged) {
                    flush();
                    parts.push(salvaged);
                    found = true;
                    index = text.length;
                    continue;
                }
            }
        }
        // Copy up to the next line start that could open a part (the newline itself is copied on its own,
        // so the `{` after it is looked at as a line start).
        const next = text.indexOf('\n{', index);
        const stop = next < 0 ? text.length : next === index ? index + 1 : next + 1;
        plain += text.slice(index, stop);
        index = stop;
    }
    if (!found) return null;
    flush();
    return parts;
}

function partsField(section: Record<string, unknown>): Part[] | null {
    for (const key of ['parts', 'contentParts', 'content_parts']) {
        const value = section[key];
        if (Array.isArray(value) && value.length > 0) {
            const parts = value.filter((entry): entry is Part => isRecord(entry));
            if (parts.length > 0) return parts;
        }
    }
    return null;
}

/**
 * The content to hand to the request inspector for a traced message section:
 * the structured parts when the SDK recorded them (`parts`), the parts read back
 * from the flattened text of an older recording otherwise, else the content
 * exactly as it came.
 */
export function tracedMessageContent(section: { content?: unknown; [key: string]: unknown }): unknown {
    const content = section.content;
    if (Array.isArray(content)) return content;

    // The structured parts carry everything `content` says (it only names the attachments): they win.
    const structured = partsField(section);
    if (structured) return structured;
    if (typeof content === 'string') return parseFlattenedParts(content) ?? content;
    return content;
}
