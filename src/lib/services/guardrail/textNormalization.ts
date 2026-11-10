// Text normalization for PII detection.
// PII is frequently obfuscated (zero-width characters, fullwidth digits,
// "user (at) example (dot) com"). Detection runs on both the original text
// and a normalized view so simple evasion doesn't slip through. Findings
// carry the value as it appears in the ORIGINAL text whenever possible so
// redaction can locate it.

const ZERO_WIDTH_RE = /[\u200B-\u200D\u2060\uFEFF\u00AD]/g;

/**
 * Folds compatibility forms and strips zero-width characters. Used by
 * `families/pii.ts`, whose obfuscation pass runs this rewrite per subject
 * segment; keeping a single definition means every caller agrees on which
 * strings collapse to the same value.
 */
export function normalizeText(text: string): string {
  // NFKC folds fullwidth/compatibility forms (ｅｘａｍｐｌｅ → example, ① → 1)
  return text.normalize('NFKC').replace(ZERO_WIDTH_RE, '');
}

/**
 * Rewrites spelled-out email obfuscation: "user (at) mail (dot) com" →
 * "user@mail.com". A bare " at " is only rewritten when the domain side uses a
 * spelled-out/bracketed dot, so ordinary sentences ("meet at 5.30") survive.
 */
export function deobfuscateEmails(text: string): string {
  return text
    .replace(/\s*[([{]\s*(?:at|@)\s*[)\]}]\s*/gi, '@')
    .replace(/\s+at\s+(?=[a-z0-9-]+\s*(?:[([{]\s*(?:dot|\.)\s*[)\]}]|\s+dot\s+))/gi, '@')
    .replace(/\s*[([{]\s*(?:dot|\.)\s*[)\]}]\s*/gi, '.')
    .replace(/(?<=@[a-z0-9.-]{1,63})\s+dot\s+/gi, '.');
}
