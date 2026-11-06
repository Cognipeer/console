/**
 * Reversible PII protection around a model call: the model sees a token in place
 * of every value the PII policy finds, and the caller gets the original values
 * back in the answer.
 *
 *   "TCKN 12345678950"  ->  model sees "TCKN [TC_KIMLIK_qhzkfmwa]"
 *   model answers "[TC_KIMLIK_qhzkfmwa] ..."  ->  caller gets "12345678950 ..."
 *
 * TOKENS ARE KEYED, NOT NUMBERED. A token is the category plus eight letters of
 * HMAC-SHA256(key, category, value). The same value under the same key is the
 * same token in every call, so nothing has to be stored between calls: an
 * agent's transcript keeps the real values, and every model call tokenizes the
 * whole history again into the SAME tokens (stable prompt-cache prefix, and the
 * model's earlier answers still line up with what it is shown now). The key is
 * scoped by the caller (`deriveRoundTripKey`): one agent session, or one model.
 * Letters only, so a token never looks like a number to the detectors when the
 * history is scanned again.
 *
 * WHAT IS SCANNED: every text the model would read — system prompt, every turn,
 * tool results, the arguments of earlier tool calls. A part that cannot be
 * scanned (image, file, audio) is refused rather than sent: a protected model
 * must not receive content nobody looked at.
 *
 * WHAT IS RESTORED: the answer text and the tool-call arguments (JSON-escaped, so
 * the arguments stay valid JSON). Reasoning is never rewritten in either
 * direction: signed thinking blocks must be replayed byte for byte, so they keep
 * the tokens the model wrote.
 */

import { createHash, createHmac, hkdfSync } from 'crypto';
import type { PiiFinding } from './types';

/** A token as it appears in text, brackets optional: a model sometimes drops them. */
const TOKEN_PATTERN = /\[?(?<![A-Za-z0-9_])([A-Z][A-Z0-9_]*_[a-z]{8,16})(?![a-z])\]?/g;
/** The longest tail a stream holds back while it may still grow into a token. */
const MAX_PENDING = 64;
/** A tail that may be the start of a token: "[", "[TC_KIM", "TC_KIMLIK_qh". */
const PENDING_TAIL = /\[?(?:[A-Z][A-Z0-9_]*(?:_[a-z]{0,16})?)?$/;

const SCAN_CACHE_LIMIT = 2000;
/** Findings by policy version and text: an agent re-sends its whole history on every call. */
const scanCache = new Map<string, PiiFinding[]>();

function cachedScan(version: string, text: string, scan: (text: string) => Promise<PiiFinding[]>): Promise<PiiFinding[]> {
  const key = `${version}\u0000${createHash('sha256').update(text).digest('base64')}`;
  const hit = scanCache.get(key);
  if (hit) {
    scanCache.delete(key);
    scanCache.set(key, hit);
    return Promise.resolve(hit);
  }
  return scan(text).then((findings) => {
    scanCache.set(key, findings);
    if (scanCache.size > SCAN_CACHE_LIMIT) scanCache.delete(scanCache.keys().next().value as string);
    return findings;
  });
}

/** Test seam. */
export function clearRoundTripScanCache(): void {
  scanCache.clear();
}

/**
 * The HMAC key of one scope, derived with HKDF-SHA256 from the server's
 * encryption secret (input key material), bound to the tenant and the scope
 * (info). Without the secret a token cannot be reversed, or a value confirmed
 * by computing its token, by anyone who sees only the model traffic.
 */
export function deriveRoundTripKey(secret: string, tenant: string, scope: string): Buffer {
  return Buffer.from(hkdfSync('sha256', secret, 'pii-round-trip:v1', `${tenant}\u0000${scope}`, 32));
}

function tokenPrefix(category: string): string {
  const prefix = category.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'PII';
  // TOKEN_PATTERN and PENDING_TAIL need a token to start with a letter, so a category id that starts with a digit gets one.
  return /^[0-9]/.test(prefix) ? `C_${prefix}` : prefix;
}

function letters(mac: Buffer, from: number, count: number): string {
  let out = '';
  for (let i = from; i < from + count; i++) out += String.fromCharCode(97 + (mac[i] % 26));
  return out;
}

export class PiiUnscannableContentError extends Error {
  constructor(readonly partType: string) {
    super(
      `PII protection is on for this call, and a "${partType}" part cannot be scanned for personal data. ` +
        'Send its text instead, or turn PII protection off for this model or agent.',
    );
    this.name = 'PiiUnscannableContentError';
  }
}

export interface PiiRoundTripOptions {
  key: Buffer;
  /** The policy's identity for the scan cache (`key@updatedAt`). */
  version: string;
  scan: (text: string) => Promise<PiiFinding[]>;
}

export class PiiRoundTrip {
  /** Bare token (no brackets) -> original value. */
  private readonly values = new Map<string, string>();

  constructor(private readonly options: PiiRoundTripOptions) {}

  /** How many distinct values this call has tokenized so far. */
  get size(): number {
    return this.values.size;
  }

  private tokenFor(category: string, value: string): string {
    const mac = createHmac('sha256', this.options.key).update(`${category}\u0000${value}`).digest();
    const prefix = tokenPrefix(category);
    // Eight letters (26^8) per category; a clash with a DIFFERENT value takes more.
    for (const length of [8, 12, 16]) {
      const bare = `${prefix}_${letters(mac, 0, length)}`;
      const taken = this.values.get(bare);
      if (taken === undefined || taken === value) {
        this.values.set(bare, value);
        return `[${bare}]`;
      }
    }
    throw new Error('PII token space exhausted for one value');
  }

  /** `text` with every finding replaced by its token. Tokens already in the text are left alone. */
  async protectText(text: string): Promise<string> {
    if (!text) return text;
    const findings = await cachedScan(this.options.version, text, this.options.scan);
    if (findings.length === 0) return text;
    const existing: Array<[number, number]> = [];
    for (const m of text.matchAll(TOKEN_PATTERN)) existing.push([m.index!, m.index! + m[0].length]);
    const inToken = (f: PiiFinding) => existing.some(([s, e]) => f.start < e && s < f.end);

    let out = '';
    let cursor = 0;
    for (const f of [...findings].sort((a, b) => a.start - b.start)) {
      if (f.start < cursor || inToken(f)) continue;
      out += text.slice(cursor, f.start) + this.tokenFor(f.category, f.value);
      cursor = f.end;
    }
    return out + text.slice(cursor);
  }

  /**
   * `text` with every known token replaced by its value. `json`: the text is (part
   * of) a JSON document — tool-call arguments, a JSON answer — and the value is
   * escaped so the document stays valid. Unknown tokens are left as they are.
   */
  restoreText(text: string, json = false): string {
    if (!text || this.values.size === 0) return text;
    return text.replace(TOKEN_PATTERN, (match, bare: string) => {
      const value = this.values.get(bare);
      if (value === undefined) return match;
      return json ? JSON.stringify(value).slice(1, -1) : value;
    });
  }

  /** A restorer for text that arrives in pieces: it holds back a tail that may still become a token. */
  streamRestorer(json = false): StreamRestorer {
    return new StreamRestorer(this, json);
  }
}

export class StreamRestorer {
  private pending = '';

  constructor(private readonly roundTrip: PiiRoundTrip, private readonly json: boolean) {}

  push(piece: string): string {
    const text = this.pending + piece;
    const window = text.slice(-MAX_PENDING);
    const tail = PENDING_TAIL.exec(window);
    const hold = tail && tail[0].length > 0 ? tail[0].length : 0;
    this.pending = hold > 0 ? text.slice(text.length - hold) : '';
    return this.roundTrip.restoreText(hold > 0 ? text.slice(0, text.length - hold) : text, this.json);
  }

  flush(): string {
    const out = this.roundTrip.restoreText(this.pending, this.json);
    this.pending = '';
    return out;
  }
}
