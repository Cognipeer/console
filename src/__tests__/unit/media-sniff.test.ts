import { describe, it, expect } from 'vitest';
import { sniffMedia, imageDimensions, looksLikeText, basenameOf } from '@/lib/services/tools/mediaSniff';

const u = (...n: number[]) => new Uint8Array(n);
const asc = (s: string) => Array.from(s).map((c) => c.charCodeAt(0));
const pad = (arr: number[], len: number) => u(...arr, ...new Array(Math.max(0, len - arr.length)).fill(0));

function png(w: number, h: number) {
    const b = pad([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, ...asc('IHDR')], 33);
    const dv = new DataView(b.buffer);
    dv.setUint32(16, w);
    dv.setUint32(20, h);
    return b;
}

function webp(kind: 'VP8 ' | 'VP8L' | 'VP8X', w: number, h: number) {
    const b = pad([...asc('RIFF'), 0, 0, 0, 0, ...asc('WEBP'), ...asc(kind)], 40);
    if (kind === 'VP8 ') {
        b[26] = w & 0xff; b[27] = (w >> 8) & 0x3f;
        b[28] = h & 0xff; b[29] = (h >> 8) & 0x3f;
    } else if (kind === 'VP8L') {
        const bits = ((w - 1) & 0x3fff) | (((h - 1) & 0x3fff) << 14);
        b[21] = bits & 0xff; b[22] = (bits >> 8) & 0xff; b[23] = (bits >> 16) & 0xff; b[24] = (bits >>> 24) & 0xff;
    } else {
        const ww = w - 1, hh = h - 1;
        b[24] = ww & 0xff; b[25] = (ww >> 8) & 0xff; b[26] = (ww >> 16) & 0xff;
        b[27] = hh & 0xff; b[28] = (hh >> 8) & 0xff; b[29] = (hh >> 16) & 0xff;
    }
    return b;
}

describe('sniffMedia', () => {
    it('detects images', () => {
        expect(sniffMedia(png(1, 1))).toEqual({ kind: 'image', mimeType: 'image/png' });
        expect(sniffMedia(u(0xff, 0xd8, 0xff, 0xe0))).toEqual({ kind: 'image', mimeType: 'image/jpeg' });
        expect(sniffMedia(u(...asc('GIF89a'), 1, 0, 1, 0)).mimeType).toBe('image/gif');
        expect(sniffMedia(u(...asc('GIF87a'), 1, 0, 1, 0)).mimeType).toBe('image/gif');
        expect(sniffMedia(webp('VP8 ', 1, 1)).mimeType).toBe('image/webp');
        expect(sniffMedia(u(...asc('BM'), 0, 0)).mimeType).toBe('image/bmp');
        // A real header: reserved bytes zero, DIB header size 40 at offset 14.
        expect(sniffMedia(u(...asc('BM'), 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 40, 0, 0, 0)).mimeType).toBe('image/bmp');
        // Text that merely starts with "BM" is not a bitmap.
        expect(sniffMedia(u(...asc('BMI,age,height\n'))).kind).toBe('unknown');
        expect(sniffMedia(u(...asc('BMW 3 series notes, long enough line'))).kind).toBe('unknown');
        expect(sniffMedia(u(0x49, 0x49, 0x2a, 0)).mimeType).toBe('image/tiff');
        expect(sniffMedia(u(0x4d, 0x4d, 0, 0x2a)).mimeType).toBe('image/tiff');
    });

    it('detects RIFF containers', () => {
        expect(sniffMedia(u(...asc('RIFF'), 0, 0, 0, 0, ...asc('AVI ')))).toEqual({ kind: 'video', mimeType: 'video/x-msvideo' });
        expect(sniffMedia(u(...asc('RIFF'), 0, 0, 0, 0, ...asc('WAVE')))).toEqual({ kind: 'audio', mimeType: 'audio/wav' });
        expect(sniffMedia(u(...asc('RIFF'), 0, 0, 0, 0, ...asc('XXXX'))).kind).toBe('unknown');
    });

    it('detects pdf, video, audio, archives', () => {
        expect(sniffMedia(u(...asc('%PDF-1.7')))).toEqual({ kind: 'pdf', mimeType: 'application/pdf' });
        expect(sniffMedia(u(0, 0, 0, 24, ...asc('ftypisom'))).mimeType).toBe('video/mp4');
        expect(sniffMedia(u(0, 0, 0, 24, ...asc('ftypqt  '))).mimeType).toBe('video/quicktime');
        expect(sniffMedia(u(0, 0, 0, 24, ...asc('ftypM4A '))).kind).toBe('audio');
        expect(sniffMedia(u(0x1a, 0x45, 0xdf, 0xa3, 1))).toEqual({ kind: 'video', mimeType: 'video/webm' });
        expect(sniffMedia(u(...asc('OggS'), 0)).mimeType).toBe('audio/ogg');
        expect(sniffMedia(u(...asc('ID3'), 4)).mimeType).toBe('audio/mpeg');
        for (const x of [0xfb, 0xf3, 0xf2]) expect(sniffMedia(u(0xff, x, 0)).mimeType).toBe('audio/mpeg');
        expect(sniffMedia(u(0x50, 0x4b, 3, 4))).toEqual({ kind: 'archive', mimeType: 'application/zip' });
        expect(sniffMedia(u(0x1f, 0x8b, 8))).toEqual({ kind: 'archive', mimeType: 'application/gzip' });
    });

    it('returns unknown for text and short input', () => {
        expect(sniffMedia(u(...asc('hello world'))).kind).toBe('unknown');
        expect(sniffMedia(u()).kind).toBe('unknown');
        expect(sniffMedia(u(0xff)).kind).toBe('unknown');
    });
});

describe('imageDimensions', () => {
    it('reads png', () => expect(imageDimensions(png(320, 200), 'image/png')).toEqual({ width: 320, height: 200 }));

    it('reads gif', () => {
        expect(imageDimensions(u(...asc('GIF89a'), 0x40, 0x01, 0xc8, 0x00), 'image/gif')).toEqual({ width: 320, height: 200 });
    });

    it('reads jpeg SOF0 after other segments and fill bytes', () => {
        const jpeg = u(
            0xff, 0xd8,
            0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, // APP0, len 4
            0xff, 0xff, 0xfe, 0x00, 0x03, 0x41, // fill + COM len 3
            0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0xc8, 0x01, 0x40, 0x03, 0, 0, 0, 0, 0, 0, 0, 0, 0,
        );
        expect(imageDimensions(jpeg, 'image/jpeg')).toEqual({ width: 320, height: 200 });
    });

    it('skips standalone markers in jpeg', () => {
        const jpeg = u(0xff, 0xd8, 0xff, 0x01, 0xff, 0xc2, 0, 0x11, 8, 0, 10, 0, 20, 3, 0, 0, 0);
        expect(imageDimensions(jpeg, 'image/jpeg')).toEqual({ width: 20, height: 10 });
    });

    it('reads the three webp variants', () => {
        expect(imageDimensions(webp('VP8 ', 123, 45), 'image/webp')).toEqual({ width: 123, height: 45 });
        expect(imageDimensions(webp('VP8L', 640, 480), 'image/webp')).toEqual({ width: 640, height: 480 });
        expect(imageDimensions(webp('VP8X', 5000, 3000), 'image/webp')).toEqual({ width: 5000, height: 3000 });
    });

    it('returns null for malformed or unsupported input without throwing', () => {
        expect(imageDimensions(u(0x89, 0x50), 'image/png')).toBeNull();
        expect(imageDimensions(u(0xff, 0xd8, 0xff, 0xe0, 0x00), 'image/jpeg')).toBeNull();
        expect(imageDimensions(u(0xff, 0xd8, 0x00, 0x00), 'image/jpeg')).toBeNull();
        expect(imageDimensions(u(0xff, 0xd8, 0xff, 0xc0, 0, 0x11, 8, 0), 'image/jpeg')).toBeNull();
        expect(imageDimensions(webp('VP8 ', 1, 1).subarray(0, 20), 'image/webp')).toBeNull();
        expect(imageDimensions(u(...asc('RIFF'), 0, 0, 0, 0, ...asc('WEBP'), ...asc('ZZZZ'), 0, 0), 'image/webp')).toBeNull();
        expect(imageDimensions(png(0, 5), 'image/png')).toBeNull();
        expect(imageDimensions(png(1, 1), 'image/bmp')).toBeNull();
    });
});

describe('looksLikeText', () => {
    it('accepts utf-8 and rejects NUL / invalid bytes', () => {
        expect(looksLikeText(new TextEncoder().encode('héllo\nworld'))).toBe(true);
        expect(looksLikeText(u(0x68, 0, 0x69))).toBe(false);
        expect(looksLikeText(u(0xff, 0xfe, 0xfd, 0xfc, 0xfb))).toBe(false);
    });
    it('tolerates a cut multibyte char at the end', () => {
        const bytes = new TextEncoder().encode('abcdef€');
        expect(looksLikeText(bytes.subarray(0, bytes.length - 1))).toBe(true);
    });
    it('rejects a too-short invalid sample', () => expect(looksLikeText(u(0xff))).toBe(false));
});

describe('basenameOf', () => {
    it('returns the last segment', () => {
        expect(basenameOf('/a/b/c.png')).toBe('c.png');
        expect(basenameOf('c.png')).toBe('c.png');
        expect(basenameOf('/a/b/')).toBe('b');
    });
});
