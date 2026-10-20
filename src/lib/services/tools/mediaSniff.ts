/**
 * Magic-byte sniffing for files a tool reads. Pure, bounds-checked, never throws.
 */

export type MediaKind = 'image' | 'pdf' | 'video' | 'audio' | 'archive' | 'unknown';

function startsWith(b: Uint8Array, sig: number[], offset = 0): boolean {
    if (b.length < offset + sig.length) return false;
    for (let i = 0; i < sig.length; i++) {
        if (b[offset + i] !== sig[i]) return false;
    }
    return true;
}

function ascii(b: Uint8Array, offset: number, text: string): boolean {
    if (b.length < offset + text.length) return false;
    for (let i = 0; i < text.length; i++) {
        if (b[offset + i] !== text.charCodeAt(i)) return false;
    }
    return true;
}

// 'BM' alone is a 2-byte magic that plain text ("BMI,age", "BMW ...") also starts with, so check the
// file header: reserved bytes 6-9 are zero and the DIB header size at offset 14 is a known one.
function looksLikeBmpHeader(head: Uint8Array): boolean {
    if (head.length >= 10 && (head[6] !== 0 || head[7] !== 0 || head[8] !== 0 || head[9] !== 0)) return false;
    if (head.length >= 18) {
        const dib = head[14] | (head[15] << 8) | (head[16] << 16) | (head[17] << 24);
        return [12, 40, 52, 56, 64, 108, 124].includes(dib);
    }
    return true;
}

export function sniffMedia(head: Uint8Array): { kind: MediaKind; mimeType?: string } {
    if (!head || head.length < 2) return { kind: 'unknown' };
    if (startsWith(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { kind: 'image', mimeType: 'image/png' };
    if (startsWith(head, [0xff, 0xd8, 0xff])) return { kind: 'image', mimeType: 'image/jpeg' };
    if (ascii(head, 0, 'GIF87a') || ascii(head, 0, 'GIF89a')) return { kind: 'image', mimeType: 'image/gif' };
    if (ascii(head, 0, 'RIFF')) {
        if (ascii(head, 8, 'WEBP')) return { kind: 'image', mimeType: 'image/webp' };
        if (ascii(head, 8, 'AVI ')) return { kind: 'video', mimeType: 'video/x-msvideo' };
        if (ascii(head, 8, 'WAVE')) return { kind: 'audio', mimeType: 'audio/wav' };
    }
    if (ascii(head, 0, 'BM') && looksLikeBmpHeader(head)) return { kind: 'image', mimeType: 'image/bmp' };
    if (startsWith(head, [0x49, 0x49, 0x2a, 0x00]) || startsWith(head, [0x4d, 0x4d, 0x00, 0x2a])) {
        return { kind: 'image', mimeType: 'image/tiff' };
    }
    if (ascii(head, 0, '%PDF-')) return { kind: 'pdf', mimeType: 'application/pdf' };
    if (ascii(head, 4, 'ftyp')) {
        if (ascii(head, 8, 'qt  ')) return { kind: 'video', mimeType: 'video/quicktime' };
        if (ascii(head, 8, 'M4A')) return { kind: 'audio', mimeType: 'audio/mp4' };
        return { kind: 'video', mimeType: 'video/mp4' };
    }
    if (startsWith(head, [0x1a, 0x45, 0xdf, 0xa3])) return { kind: 'video', mimeType: 'video/webm' };
    if (ascii(head, 0, 'OggS')) return { kind: 'audio', mimeType: 'audio/ogg' };
    if (ascii(head, 0, 'ID3')) return { kind: 'audio', mimeType: 'audio/mpeg' };
    if (head[0] === 0xff && (head[1] === 0xfb || head[1] === 0xf3 || head[1] === 0xf2)) {
        return { kind: 'audio', mimeType: 'audio/mpeg' };
    }
    if (startsWith(head, [0x50, 0x4b, 0x03, 0x04])) return { kind: 'archive', mimeType: 'application/zip' };
    if (startsWith(head, [0x1f, 0x8b])) return { kind: 'archive', mimeType: 'application/gzip' };
    return { kind: 'unknown' };
}

const be32 = (b: Uint8Array, o: number) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
const be16 = (b: Uint8Array, o: number) => (b[o] << 8) | b[o + 1];
const le16 = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8);
const le24 = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8) | (b[o + 2] << 16);

function valid(w: number, h: number): { width: number; height: number } | null {
    return w > 0 && h > 0 ? { width: w, height: h } : null;
}

const SOF_MARKERS = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

function jpegDimensions(b: Uint8Array): { width: number; height: number } | null {
    let i = 2;
    while (i < b.length) {
        if (b[i] !== 0xff) return null;
        while (i < b.length && b[i] === 0xff) i++; // fill bytes
        if (i >= b.length) return null;
        const marker = b[i];
        if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
            i += 1;
            continue;
        }
        if (SOF_MARKERS.has(marker)) {
            // i is the marker byte (after the 0xFF): len @ i+1, precision @ i+3, height @ i+4, width @ i+6
            if (i + 7 >= b.length) return null;
            return valid(be16(b, i + 6), be16(b, i + 4));
        }
        if (i + 2 >= b.length) return null;
        const len = be16(b, i + 1);
        if (len < 2) return null;
        i += 1 + len;
    }
    return null;
}

export function imageDimensions(bytes: Uint8Array, mimeType: string): { width: number; height: number } | null {
    try {
        const b = bytes;
        const mime = (mimeType || '').split(';')[0].trim().toLowerCase();
        if (mime === 'image/png') {
            if (b.length < 24) return null;
            return valid(be32(b, 16), be32(b, 20));
        }
        if (mime === 'image/gif') {
            if (b.length < 10) return null;
            return valid(le16(b, 6), le16(b, 8));
        }
        if (mime === 'image/jpeg') {
            return jpegDimensions(b);
        }
        if (mime === 'image/webp') {
            if (b.length < 16) return null;
            if (ascii(b, 12, 'VP8 ')) {
                if (b.length < 30) return null;
                return valid(le16(b, 26) & 0x3fff, le16(b, 28) & 0x3fff);
            }
            if (ascii(b, 12, 'VP8L')) {
                if (b.length < 25) return null;
                const bits = (b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24)) >>> 0;
                return valid((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
            }
            if (ascii(b, 12, 'VP8X')) {
                if (b.length < 30) return null;
                return valid(le24(b, 24) + 1, le24(b, 27) + 1);
            }
            return null;
        }
        return null;
    } catch {
        return null;
    }
}

export function looksLikeText(sample: Uint8Array): boolean {
    if (sample.includes(0)) return false;
    const decoder = new TextDecoder('utf-8', { fatal: true });
    try {
        decoder.decode(sample);
        return true;
    } catch {
        if (sample.length <= 3) return false;
        try {
            // A multibyte character may have been cut at the end of the sample.
            decoder.decode(sample.subarray(0, sample.length - 3));
            return true;
        } catch {
            return false;
        }
    }
}

export function basenameOf(path: string): string {
    const trimmed = path.replace(/\/+$/, '');
    const idx = trimmed.lastIndexOf('/');
    return idx === -1 ? trimmed : trimmed.slice(idx + 1);
}
