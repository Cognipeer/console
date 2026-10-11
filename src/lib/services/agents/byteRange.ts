/**
 * HTTP `Range` for the bytes of a stored file — see `parseByteRange`. Kept apart from
 * the file service so a route can use it without loading storage.
 */

/** What a `Range` header asks of a body of `size` bytes. `end` is inclusive. */
export type ByteRangeRequest =
    /** No usable `Range`: send the whole body (200). */
    | { kind: 'whole' }
    | { kind: 'partial'; start: number; end: number }
    /** The range lies past the end of the body (416). */
    | { kind: 'unsatisfiable' };

/**
 * Reads a `Range: bytes=…` header for ONE range (RFC 9110 §14): `a-b`, `a-` and
 * the suffix `-n`. Anything else — another unit, several ranges, a malformed
 * value — is ignored and the whole body is sent, which a server may always do.
 * A single range that starts past the end answers 416.
 */
export function parseByteRange(header: string | string[] | undefined, size: number): ByteRangeRequest {
    const raw = Array.isArray(header) ? header[0] : header;
    if (typeof raw !== 'string') return { kind: 'whole' };
    const match = /^\s*bytes\s*=\s*(\d*)\s*-\s*(\d*)\s*$/i.exec(raw);
    if (!match) return { kind: 'whole' };
    const [, first, last] = match;
    if (first === '' && last === '') return { kind: 'whole' };
    if (first === '') {
        const suffix = Number(last);
        if (!Number.isSafeInteger(suffix)) return { kind: 'whole' };
        if (suffix === 0 || size === 0) return { kind: 'unsatisfiable' };
        return { kind: 'partial', start: Math.max(0, size - suffix), end: size - 1 };
    }
    const start = Number(first);
    const requestedEnd = last === '' ? undefined : Number(last);
    if (!Number.isSafeInteger(start) || (requestedEnd !== undefined && (!Number.isSafeInteger(requestedEnd) || requestedEnd < start))) {
        return { kind: 'whole' };
    }
    if (start >= size) return { kind: 'unsatisfiable' };
    return { kind: 'partial', start, end: Math.min(requestedEnd ?? size - 1, size - 1) };
}
