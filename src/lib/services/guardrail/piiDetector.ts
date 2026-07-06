import type { GuardrailAction, IGuardrailPiiPolicy } from '@/lib/database';
import type { GuardrailFinding } from './types';

// ── Text normalization ────────────────────────────────────────────────────
// PII is frequently obfuscated (zero-width characters, fullwidth digits,
// "user (at) example (dot) com"). Detection runs on both the original text
// and a normalized view so simple evasion doesn't slip through. Findings
// carry the value as it appears in the ORIGINAL text whenever possible so
// redaction can locate it.

const ZERO_WIDTH_RE = /[\u200B-\u200D\u2060\uFEFF\u00AD]/g;

function normalizeText(text: string): string {
  // NFKC folds fullwidth/compatibility forms (ｅｘａｍｐｌｅ → example, ① → 1)
  return text.normalize('NFKC').replace(ZERO_WIDTH_RE, '');
}

/**
 * Rewrites spelled-out email obfuscation: "user (at) mail (dot) com" →
 * "user@mail.com". A bare " at " is only rewritten when the domain side uses a
 * spelled-out/bracketed dot, so ordinary sentences ("meet at 5.30") survive.
 */
function deobfuscateEmails(text: string): string {
  return text
    .replace(/\s*[([{]\s*(?:at|@)\s*[)\]}]\s*/gi, '@')
    .replace(/\s+at\s+(?=[a-z0-9-]+\s*(?:[([{]\s*(?:dot|\.)\s*[)\]}]|\s+dot\s+))/gi, '@')
    .replace(/\s*[([{]\s*(?:dot|\.)\s*[)\]}]\s*/gi, '.')
    .replace(/(?<=@[a-z0-9.-]{1,63})\s+dot\s+/gi, '.');
}

// ── Regex patterns for PII detection ─────────────────────────────────────

const PATTERNS: Record<string, RegExp> = {
  email: /[a-zA-Z0-9_.+-]+@[a-zA-Z0-9-]+\.[a-zA-Z0-9-.]+/g,
  phone: /(?:\+?\d[\d\s().-]{7,}\d)/g,
  creditCard: /\b(?:\d[ -]*?){13,19}\b/g,
  iban: /\b[A-Z]{2}\d{2}[0-9A-Z]{11,30}\b/g,
  swift: /\b[A-Z]{4}[A-Z]{2}[A-Z0-9]{2}(?:[A-Z0-9]{3})?\b/g,
  nationalId: /\b\d{3}[-.\s]?\d{2}[-.\s]?\d{4}\b/g,
  tckn: /\b[1-9]\d{10}\b/g,
  passport: /\b(?:[A-Z]{1}\d{6,8}|[A-Z]{2}\d{6,7})\b/g,
  birthDate: /\b\d{2}[/-]\d{2}[/-]\d{4}\b|\b\d{4}[/-]\d{2}[/-]\d{2}\b/g,
  address:
    /\d+\s[A-Za-z]+\s(?:Street|St|Avenue|Ave|Boulevard|Blvd|Road|Rd|Lane|Ln|Drive|Dr|Court|Ct|Square|Sq|Place|Pl|Terrace|Ter|Parkway|Pkwy|Commons|Cmns)\b/g,
  ipAddress: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g,
  url: /\b(?:https?:\/\/|www\.)\S+\b/g,
  socialHandle: /@[a-zA-Z0-9_]{3,30}\b/g,
  apiKey: /\b[A-Za-z0-9-_]{32,}\b/g,
  cryptoWallet: /\b(?:0x[a-fA-F0-9]{40}|[13][a-km-zA-HJ-NP-Z1-9]{25,34})\b/g,
};

// Well-known credential shapes checked in addition to the generic apiKey
// pattern. These fire regardless of length, so short-but-unmistakable tokens
// (Slack, Stripe, AWS, GitHub, JWTs, private key blocks) are caught even when
// the generic 32-char heuristic misses them.
const KNOWN_SECRET_PATTERNS: RegExp[] = [
  /\b(?:sk|pk|rk)[-_](?:live|test|proj|ant|or)?[-_]?[A-Za-z0-9_-]{16,}\b/g, // Stripe/OpenAI/Anthropic-style
  /\bAKIA[0-9A-Z]{16}\b/g,                                                 // AWS access key id
  /\bgh[oprsu]?p?_[A-Za-z0-9]{30,}\b/g,                                    // GitHub tokens
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,                                     // Slack tokens
  /\bcpeer_[A-Za-z0-9_-]{16,}\b/g,                                         // Console API tokens
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\b/g,     // JWT
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g,                    // PEM private key
];

const CATEGORY_MESSAGES: Record<string, string> = {
  email: 'Email address detected',
  phone: 'Phone number detected',
  creditCard: 'Credit card number detected',
  iban: 'IBAN detected',
  swift: 'SWIFT/BIC code detected',
  nationalId: 'National identification number detected',
  tckn: 'Turkish national ID (TCKN) detected',
  passport: 'Passport number detected',
  birthDate: 'Birth date detected',
  address: 'Physical address detected',
  ipAddress: 'IP address detected',
  url: 'URL detected',
  socialHandle: 'Social handle detected',
  apiKey: 'API token or secret detected',
  cryptoWallet: 'Cryptocurrency wallet address detected',
};

function execAll(pattern: RegExp, text: string): string[] {
  const globalPattern = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : pattern.flags + 'g');
  globalPattern.lastIndex = 0;

  const matches: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = globalPattern.exec(text)) !== null) {
    matches.push(match[0]);
  }
  return matches;
}

function findMatches(text: string, category: string): string[] {
  const pattern = PATTERNS[category];
  if (!pattern) return [];
  const matches = execAll(pattern, text);
  if (category === 'apiKey') {
    for (const secretPattern of KNOWN_SECRET_PATTERNS) {
      matches.push(...execAll(secretPattern, text));
    }
  }
  return matches;
}

// ── Validators (cut false positives, confirm checksums) ──────────────────

function validatePhone(value: string): boolean {
  const digits = value.replace(/\D/g, '');
  return digits.length >= 7 && digits.length <= 15;
}

function validateCreditCard(value: string): boolean {
  const digits = value.replace(/\D/g, '');
  if (digits.length < 13 || digits.length > 19) return false;
  // Luhn algorithm
  let sum = 0;
  let alternate = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = parseInt(digits[i], 10);
    if (alternate) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alternate = !alternate;
  }
  return sum % 10 === 0;
}

/** IBAN mod-97 checksum (ISO 13616). Rejects random uppercase+digit strings. */
function validateIban(value: string): boolean {
  const iban = value.replace(/\s/g, '').toUpperCase();
  if (iban.length < 15 || iban.length > 34) return false;
  const rearranged = iban.slice(4) + iban.slice(0, 4);
  let remainder = 0;
  for (const ch of rearranged) {
    const code = ch >= 'A' && ch <= 'Z' ? String(ch.charCodeAt(0) - 55) : ch;
    for (const digit of code) {
      remainder = (remainder * 10 + Number(digit)) % 97;
    }
  }
  return remainder === 1;
}

/** TCKN checksum: 11 digits, first ≠ 0, digits 10 & 11 derived from the first 9. */
function validateTckn(value: string): boolean {
  const digits = value.replace(/\D/g, '');
  if (digits.length !== 11 || digits[0] === '0') return false;
  const d = digits.split('').map(Number);
  const oddSum = d[0] + d[2] + d[4] + d[6] + d[8];
  const evenSum = d[1] + d[3] + d[5] + d[7];
  const check10 = ((oddSum * 7) - evenSum) % 10;
  if (check10 < 0 || check10 !== d[9]) return false;
  const check11 = d.slice(0, 10).reduce((a, b) => a + b, 0) % 10;
  return check11 === d[10];
}

/**
 * Shannon entropy filter for the generic long-token pattern: real secrets are
 * high-entropy; repeated words, slugs, and hex-like low-variety strings are
 * mostly false positives. Known-prefix secrets bypass this via
 * KNOWN_SECRET_PATTERNS.
 */
function hasSecretEntropy(value: string): boolean {
  if (value.length < 20) return false;
  const freq: Record<string, number> = {};
  for (const ch of value) freq[ch] = (freq[ch] ?? 0) + 1;
  let entropy = 0;
  for (const count of Object.values(freq)) {
    const p = count / value.length;
    entropy -= p * Math.log2(p);
  }
  return entropy >= 3.5;
}

function validateApiKey(value: string): boolean {
  // Known-prefix matches are always secrets; generic 32+ tokens must look random.
  for (const pattern of KNOWN_SECRET_PATTERNS) {
    const single = new RegExp(`^(?:${pattern.source})$`);
    if (single.test(value)) return true;
  }
  return hasSecretEntropy(value);
}

const VALIDATORS: Record<string, (value: string) => boolean> = {
  phone: validatePhone,
  creditCard: validateCreditCard,
  iban: validateIban,
  tckn: validateTckn,
  apiKey: validateApiKey,
};

function getMatches(text: string, category: string): string[] {
  const raw = findMatches(text, category);
  const validator = VALIDATORS[category];
  const filtered = validator ? raw.filter(validator) : raw;
  return [...new Set(filtered)];
}

// ── Redaction ─────────────────────────────────────────────────────────────

/**
 * Masks each finding's matched value in the text, labelling the mask with the
 * finding's category (`[REDACTED:email]`, `[REDACTED:banned_word]`, …). Works
 * for any finding type that carries a `value` — PII, word filter, etc. Longer
 * values are replaced first so overlapping matches (e.g. a URL containing an
 * email) don't leave fragments behind.
 */
export function redactFindings(text: string, findings: GuardrailFinding[]): string {
  const values = [...new Set(findings.map((f) => f.value).filter((v): v is string => Boolean(v)))]
    .sort((a, b) => b.length - a.length);
  let result = text;
  for (const value of values) {
    const finding = findings.find((f) => f.value === value);
    result = result.split(value).join(`[REDACTED:${finding?.category ?? 'pii'}]`);
  }
  return result;
}

// ── Detection entry point ─────────────────────────────────────────────────

export function runPiiDetection(
  text: string,
  policy: IGuardrailPiiPolicy,
): GuardrailFinding[] {
  if (!policy.enabled || !text) return [];

  const findings: GuardrailFinding[] = [];
  const action = policy.action ?? 'block';
  const enabledCategories = Object.entries(policy.categories || {})
    .filter(([, enabled]) => enabled)
    .map(([id]) => id);

  const normalized = normalizeText(text);
  const emailDeobfuscated = enabledCategories.includes('email')
    ? deobfuscateEmails(normalized)
    : normalized;

  for (const category of enabledCategories) {
    const matches = new Set(getMatches(text, category));
    // Second pass over the normalized view catches zero-width/fullwidth and
    // spelled-out obfuscation. Values already found verbatim are not repeated.
    const evasionSource = category === 'email' ? emailDeobfuscated : normalized;
    if (evasionSource !== text) {
      for (const match of getMatches(evasionSource, category)) {
        matches.add(match);
      }
    }
    for (const value of matches) {
      findings.push({
        type: 'pii',
        category,
        severity: 'high',
        message: CATEGORY_MESSAGES[category] || `${category} detected`,
        action: action as GuardrailAction,
        block: action === 'block',
        value,
      });
    }
  }

  return findings;
}
