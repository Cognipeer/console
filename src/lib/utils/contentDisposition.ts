/**
 * `Content-Disposition` for a file name that comes from the outside.
 *
 * The header carries the name twice (RFC 6266): `filename="..."` for clients that read only that, limited
 * to printable ASCII, and `filename*=UTF-8''...` (RFC 8187) with the real name, percent-encoded, which every
 * current browser prefers. Whatever the name holds - line breaks, quotes, separators, lone surrogates, a script
 * the ASCII form cannot spell - cannot end the header value, add a parameter or make the encoding throw.
 */

export type ContentDispositionType = 'attachment' | 'inline';

/** The longest name kept, in characters (not UTF-16 units: a name is never cut inside a character). */
const MAX_NAME_CHARACTERS = 180;

/** C0 and C1 controls and DEL: line breaks among them, which would end the header. */
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/g;

/** A UTF-16 unit that is half of a surrogate pair with no other half. */
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;

/** The name as it is shown to the user: no controls, no path separators, never empty, never over-long. */
function cleanFileName(fileName: string): string {
  const cleaned = String(fileName ?? '')
    .replace(CONTROL_CHARACTERS, '')
    .replace(LONE_SURROGATE, '�')
    .replace(/[\\/]/g, '_')
    .trim();
  return Array.from(cleaned).slice(0, MAX_NAME_CHARACTERS).join('').trim() || 'file';
}

/** Printable ASCII only: accents are dropped to their base letter, any other character becomes one `_`. */
function asciiFallback(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\x20-\x7e]/gu, '_')
    .replace(/["%;\\]/g, '_');
}

/** RFC 8187 `value-chars`: `encodeURIComponent` leaves `' ( ) *` alone, which the header grammar does not allow. */
function encodeExtendedValue(name: string): string {
  return encodeURIComponent(name).replace(/['()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

export function contentDisposition(fileName: string, type: ContentDispositionType = 'attachment'): string {
  const name = cleanFileName(fileName);
  return `${type}; filename="${asciiFallback(name)}"; filename*=UTF-8''${encodeExtendedValue(name)}`;
}
