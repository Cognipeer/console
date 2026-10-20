/**
 * The size of an upload's `data` before it is decoded.
 *
 * The quotas and the rate limit are asked about this number, so it has to be what the file service will really store:
 * the service decodes with `Buffer.from(text, 'base64')`, which skips every character outside the base64 alphabet (a
 * comma, a space, a letter of some other word). A size worked out any other way can be made to count less than is
 * written.
 */

/** A data URL: the payload is what follows `;base64,`; the head (`data:image/png`) is not part of it. */
export const DATA_URL_PATTERN = /^data:.*?;base64,([\s\S]*)$/;

/** The base64 text of an upload: the part after the head of a data URL, else the whole text. */
export function base64TextOf(payload: string): string {
    const trimmed = payload.trim();
    const dataUrl = DATA_URL_PATTERN.exec(trimmed);
    return dataUrl ? dataUrl[1]! : trimmed;
}

/**
 * The bytes `Buffer.from(base64TextOf(payload), 'base64')` holds - or, where the decoder stops early (it does at a
 * padding sign that is followed by more text), a little more - counted without decoding.
 * Exact for base64 in either alphabet, with or without padding and line breaks.
 */
export function decodedByteLength(payload: string): number {
    const text = base64TextOf(payload);
    let symbols = 0;
    for (let index = 0; index < text.length; index += 1) {
        const code = text.charCodeAt(index);
        if (
            (code >= 48 && code <= 57) // 0-9
            || (code >= 65 && code <= 90) // A-Z
            || (code >= 97 && code <= 122) // a-z
            || code === 43 || code === 47 // + /
            || code === 45 || code === 95 // - _ (the URL-safe alphabet)
        ) {
            symbols += 1;
        }
    }
    return Math.floor((symbols * 3) / 4);
}
