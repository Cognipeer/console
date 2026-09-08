/**
 * Built-in PII categories.
 *
 * Each category ships with:
 *  - a regex pattern (or a discriminating tester function) — OPTIONAL as of
 *    PII v2: `person`/`organization`/`location` have no shape a regex can
 *    anchor on and are only ever raised by the dictionary (L2) or NER (L3)
 *    passes in `detector.ts`. `pattern`-less categories are skipped by the
 *    regex sweep (`pickActiveBuiltins`/`compileBuiltin` in `detector.ts`)
 *    but still selectable via `config.categories` and still carry real
 *    label/mask/severity metadata for those other passes to use.
 *  - the languages/locales it applies to ('global' = language-independent)
 *  - i18n labels per supported locale (falls back to English)
 *  - masking strategy hint for partial obfuscation (e.g. keep-last-4 for cards)
 *  - `baseScore`: this category's own confidence before any context boost
 *    (PII v2 — see `confidence.ts`). A checksum-validated category (IBAN,
 *    TCKN, credit card) starts high; a format-only category (a bare 10-digit
 *    run, a generic date) starts low and needs a context word (`contextWords.ts`)
 *    or another detector's agreement to clear a policy's `minConfidence`.
 *    Every pre-v2 category keeps its old REGEX BEHAVIOUR unchanged — `baseScore`
 *    is a new field, not a filter, until a policy explicitly sets
 *    `detection.minConfidence > 0`.
 *
 * Custom tenant-defined patterns are NOT part of this file — they live on
 * `IPiiPolicy.customPatterns` and are merged at detect time by `detector.ts`.
 */

import type { PiiLanguage } from '@/lib/database';

export type PiiSeverity = 'low' | 'medium' | 'high';

/** How to partially mask a finding when action='mask'. */
export type PiiMaskStrategy =
  | { kind: 'fixed'; replacement: string }
  | { kind: 'keep-edges'; head: number; tail: number; fillChar?: string }
  | { kind: 'keep-domain' } // for emails — keep "@domain.tld", mask local part
  | { kind: 'keep-last'; tail: number; fillChar?: string };

export interface PiiCategoryDefinition {
  /** Stable id used in API requests / DB. */
  id: string;
  /** English fallback label. */
  label: string;
  /** Optional localized labels. */
  labels?: Partial<Record<PiiLanguage, string>>;
  /** Short description (English fallback). */
  description: string;
  /** Optional localized descriptions. */
  descriptions?: Partial<Record<PiiLanguage, string>>;
  /** Languages this pattern applies to. ['global'] = always matches. */
  languages: PiiLanguage[];
  /** Severity to assign on findings. */
  severity: PiiSeverity;
  /** Regex source (global flag enforced by detector). Absent = dictionary/NER-only category (see file header). */
  pattern?: RegExp;
  /** Optional value validator (e.g. Luhn for credit cards). */
  validate?: (value: string) => boolean;
  /** PII v2: this category's own confidence before any context boost. 0 for dictionary/NER-only categories, whose candidates carry their own per-match baseScore instead (see `dictionary.ts`/`ner.ts`). */
  baseScore: number;
  /** Default mask strategy. */
  mask: PiiMaskStrategy;
  /** Whether this category is enabled by default in a new policy. */
  defaultEnabled: boolean;
}

// ── Validators ───────────────────────────────────────────────────────────

function validatePhone(value: string): boolean {
  const digits = value.replace(/\D/g, '');
  return digits.length >= 7 && digits.length <= 15;
}

function validateLuhn(value: string): boolean {
  const digits = value.replace(/\D/g, '');
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  let alternate = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = Number.parseInt(digits[i], 10);
    if (alternate) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alternate = !alternate;
  }
  return sum % 10 === 0;
}

/**
 * Validate a Turkish national ID (TC Kimlik No).
 * Reference algorithm (Wikipedia, GoC's e-government docs):
 *   1) 11 digits, first digit != 0
 *   2) (sum of digits 1,3,5,7,9 × 7) − (sum of digits 2,4,6,8) ≡ digit10 (mod 10)
 *   3) sum of digits 1..10 ≡ digit11 (mod 10)
 */
function validateTcKimlik(value: string): boolean {
  const d = value.replace(/\D/g, '');
  if (d.length !== 11) return false;
  if (d[0] === '0') return false;
  const n = d.split('').map((c) => Number.parseInt(c, 10));
  const oddSum = n[0] + n[2] + n[4] + n[6] + n[8];
  const evenSum = n[1] + n[3] + n[5] + n[7];
  const c10 = (oddSum * 7 - evenSum) % 10;
  if (((c10 + 10) % 10) !== n[9]) return false;
  const totalFirst10 = n.slice(0, 10).reduce((a, b) => a + b, 0);
  if ((totalFirst10 % 10) !== n[10]) return false;
  return true;
}

/**
 * Turkish VKN (Vergi Kimlik Numarası) checksum — a best-effort port of the
 * algorithm commonly published for GİB-issued tax IDs (see e.g.
 * https://github.com/fevziegeyurtsevenler/turkish-pii-redactor for an
 * independent implementation of the same formula). UNLIKE `validateTcKimlik`
 * above, this has NOT been checked against an official test vector in this
 * session — treat a `tr_vkn` finding as context-dependent (a bare passing
 * digit run is still fairly common; see `tr_vkn`'s low `baseScore` and
 * `contextWords.ts`'s "vergi no" list), not checksum-certain, until it's
 * verified against a real VKN.
 */
function validateVkn(value: string): boolean {
  const d = value.replace(/\D/g, '');
  if (d.length !== 10) return false;
  const digits = d.split('').map((c) => Number.parseInt(c, 10));
  let total = 0;
  for (let i = 0; i < 9; i++) {
    const tmp = (digits[i] + (9 - i)) % 10;
    if (tmp === 0) {
      total += 9;
    } else {
      const v = (tmp * 2 ** (9 - i)) % 9;
      total += v === 0 ? 9 : v;
    }
  }
  const check = (10 - (total % 10)) % 10;
  return check === digits[9];
}

/**
 * Calendar-plausibility check shared by `birthDate` and `tr_date`-shaped
 * matches: rejects "31.02.2024"-style dates a bare regex accepts. Not a
 * FUTURE-date check nor an age-plausibility check — deliberately just
 * "could this date exist".
 */
function validateCalendarDate(value: string): boolean {
  const parts = value.split(/[./-]/).map((p) => Number.parseInt(p, 10));
  if (parts.length !== 3 || parts.some((p) => Number.isNaN(p))) return false;
  const [a, b, c] = parts;
  // yyyy-mm-dd if the first group is 4 digits wide, else dd-mm-yyyy.
  const isIso = String(parts[0]).length === 4 || a > 31;
  const year = isIso ? a : c;
  const month = isIso ? b : b;
  const day = isIso ? c : a;
  if (month < 1 || month > 12 || day < 1) return false;
  const isLeap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const daysInMonth = [31, isLeap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= daysInMonth[month - 1];
}

// ── Built-in categories ──────────────────────────────────────────────────

export const PII_CATEGORIES: PiiCategoryDefinition[] = [
  // Global (language-independent) categories
  {
    id: 'email',
    label: 'Email address',
    labels: { tr: 'E-posta adresi', de: 'E-Mail-Adresse', fr: 'Adresse e-mail', es: 'Correo electrónico', it: 'Indirizzo email', pt: 'Endereço de e-mail' },
    description: 'RFC-style email addresses (user@domain.tld).',
    descriptions: { tr: 'RFC formatında e-posta adresleri (kullanici@alanadi.uz).' },
    languages: ['global'],
    severity: 'high',
    pattern: /[a-zA-Z0-9_.+-]+@[a-zA-Z0-9-]+\.[a-zA-Z0-9-.]+/g,
    baseScore: 0.9,
    mask: { kind: 'keep-domain' },
    defaultEnabled: true,
  },
  {
    id: 'phone',
    label: 'Phone number',
    labels: { tr: 'Telefon numarası', de: 'Telefonnummer', fr: 'Numéro de téléphone', es: 'Número de teléfono', it: 'Numero di telefono', pt: 'Número de telefone' },
    description: 'International or local phone numbers (7–15 digits).',
    descriptions: { tr: 'Uluslararası veya yerel telefon numaraları (7–15 hane).' },
    languages: ['global'],
    severity: 'medium',
    pattern: /(?:\+?\d[\d\s().-]{7,}\d)/g,
    validate: validatePhone,
    baseScore: 0.5,
    mask: { kind: 'keep-last', tail: 4 },
    defaultEnabled: true,
  },
  {
    id: 'creditCard',
    label: 'Credit card number',
    labels: { tr: 'Kredi kartı numarası', de: 'Kreditkartennummer', fr: 'Numéro de carte de crédit', es: 'Número de tarjeta de crédito', it: 'Numero di carta di credito', pt: 'Número de cartão de crédito' },
    description: '13–19 digit credit card numbers (Luhn-validated).',
    descriptions: { tr: '13–19 haneli kredi kartı numaraları (Luhn doğrulamalı).' },
    languages: ['global'],
    severity: 'high',
    pattern: /\b(?:\d[ -]*?){13,19}\b/g,
    validate: validateLuhn,
    baseScore: 0.9,
    mask: { kind: 'keep-last', tail: 4 },
    defaultEnabled: true,
  },
  {
    id: 'iban',
    label: 'IBAN',
    labels: { tr: 'IBAN', de: 'IBAN', fr: 'IBAN' },
    description: 'International Bank Account Number.',
    descriptions: { tr: 'Uluslararası Banka Hesap Numarası.' },
    languages: ['global'],
    severity: 'high',
    pattern: /\b[A-Z]{2}[0-9]{2}[0-9A-Z]{11,30}\b/g,
    baseScore: 0.85,
    mask: { kind: 'keep-edges', head: 4, tail: 4 },
    defaultEnabled: true,
  },
  {
    id: 'swift',
    label: 'SWIFT/BIC code',
    labels: { tr: 'SWIFT/BIC kodu' },
    description: 'SWIFT (BIC) bank identifier code.',
    descriptions: { tr: 'SWIFT (BIC) banka kimlik kodu.' },
    languages: ['global'],
    severity: 'medium',
    pattern: /\b[A-Z]{4}[A-Z]{2}[A-Z0-9]{2}(?:[A-Z0-9]{3})?\b/g,
    baseScore: 0.5,
    mask: { kind: 'keep-edges', head: 4, tail: 0 },
    defaultEnabled: false,
  },
  {
    id: 'ipAddress',
    label: 'IP address',
    labels: { tr: 'IP adresi' },
    description: 'IPv4 addresses.',
    descriptions: { tr: 'IPv4 adresleri.' },
    languages: ['global'],
    severity: 'low',
    pattern: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g,
    baseScore: 0.5,
    mask: { kind: 'fixed', replacement: '[IP]' },
    defaultEnabled: false,
  },
  {
    id: 'url',
    label: 'URL',
    labels: { tr: 'URL' },
    description: 'Web URLs (http/https/www).',
    descriptions: { tr: 'Web URL’leri (http/https/www).' },
    languages: ['global'],
    severity: 'low',
    pattern: /\b(?:https?:\/\/|www\.)\S+\b/g,
    baseScore: 0.6,
    mask: { kind: 'fixed', replacement: '[URL]' },
    defaultEnabled: false,
  },
  {
    id: 'socialHandle',
    label: 'Social handle',
    labels: { tr: 'Sosyal medya kullanıcı adı' },
    description: '@handle-style social media usernames.',
    descriptions: { tr: '@kullanici tarzı sosyal medya isimleri.' },
    languages: ['global'],
    severity: 'low',
    pattern: /@[a-zA-Z0-9_]{3,30}\b/g,
    baseScore: 0.4,
    mask: { kind: 'fixed', replacement: '[@handle]' },
    defaultEnabled: false,
  },
  {
    id: 'apiKey',
    label: 'API token or secret',
    labels: { tr: 'API anahtarı veya gizli anahtar' },
    description: 'Long opaque tokens (32+ characters of [A-Za-z0-9_-]).',
    descriptions: { tr: 'Uzun token’lar (32+ karakter, [A-Za-z0-9_-]).' },
    languages: ['global'],
    severity: 'high',
    pattern: /\b[A-Za-z0-9_-]{32,}\b/g,
    baseScore: 0.7,
    mask: { kind: 'keep-edges', head: 4, tail: 4 },
    defaultEnabled: false,
  },
  {
    id: 'cryptoWallet',
    label: 'Crypto wallet address',
    labels: { tr: 'Kripto cüzdan adresi' },
    description: 'Bitcoin or Ethereum wallet addresses.',
    descriptions: { tr: 'Bitcoin veya Ethereum cüzdan adresleri.' },
    languages: ['global'],
    severity: 'medium',
    pattern: /\b(?:0x[a-fA-F0-9]{40}|[13][a-km-zA-HJ-NP-Z1-9]{25,34})\b/g,
    baseScore: 0.6,
    mask: { kind: 'keep-edges', head: 6, tail: 4 },
    defaultEnabled: false,
  },
  {
    id: 'birthDate',
    label: 'Date of birth',
    labels: { tr: 'Doğum tarihi' },
    description: 'Common date formats (dd/mm/yyyy, dd.mm.yyyy, yyyy-mm-dd), calendar-validated.',
    descriptions: { tr: 'Yaygın tarih formatları (gg/aa/yyyy, gg.aa.yyyy, yyyy-aa-gg), takvim doğrulamalı.' },
    languages: ['global'],
    severity: 'medium',
    pattern: /\b\d{2}[./-]\d{2}[./-]\d{4}\b|\b\d{4}[./-]\d{2}[./-]\d{2}\b/g,
    validate: validateCalendarDate,
    baseScore: 0.4,
    mask: { kind: 'fixed', replacement: '[DOB]' },
    defaultEnabled: false,
  },

  // English / US-centric
  {
    id: 'address_en',
    label: 'Street address',
    labels: { en: 'Street address', tr: 'Sokak adresi (İngilizce)' },
    description: 'English-language street addresses (Street, Ave, Blvd, …).',
    descriptions: { tr: 'İngilizce sokak adresleri (Street, Ave, Blvd…).' },
    languages: ['en'],
    severity: 'medium',
    pattern: /\d+\s[A-Za-z]+\s(?:Street|St|Avenue|Ave|Boulevard|Blvd|Road|Rd|Lane|Ln|Drive|Dr|Court|Ct|Square|Sq|Place|Pl|Terrace|Ter|Parkway|Pkwy|Commons|Cmns)\b/gi,
    baseScore: 0.5,
    mask: { kind: 'fixed', replacement: '[ADDRESS]' },
    defaultEnabled: false,
  },
  {
    id: 'ssn_us',
    label: 'US Social Security Number',
    labels: { tr: 'ABD Sosyal Güvenlik Numarası' },
    description: 'US SSN in 123-45-6789 format.',
    descriptions: { tr: '123-45-6789 formatında ABD SGN.' },
    languages: ['en'],
    severity: 'high',
    pattern: /\b\d{3}[-.\s]\d{2}[-.\s]\d{4}\b/g,
    baseScore: 0.55,
    mask: { kind: 'keep-last', tail: 4 },
    defaultEnabled: false,
  },
  {
    id: 'passport_en',
    label: 'Passport number',
    labels: { tr: 'Pasaport numarası' },
    description: 'Common passport number patterns (e.g. A1234567, AB123456).',
    descriptions: { tr: 'Yaygın pasaport numarası kalıpları (A1234567, AB123456).' },
    languages: ['en'],
    severity: 'high',
    pattern: /\b(?:[A-Z]{1}\d{6,8}|[A-Z]{2}\d{6,7})\b/g,
    baseScore: 0.4,
    mask: { kind: 'keep-edges', head: 2, tail: 2 },
    defaultEnabled: false,
  },

  // Turkish
  {
    id: 'tc_kimlik',
    label: 'Turkish National ID (TC Kimlik No)',
    labels: { tr: 'TC Kimlik No' },
    description: '11-digit Turkish national identification number (with checksum).',
    descriptions: { tr: '11 haneli TC Kimlik Numarası (sağlama doğrulamalı).' },
    languages: ['tr'],
    severity: 'high',
    pattern: /\b[1-9]\d{10}\b/g,
    validate: validateTcKimlik,
    baseScore: 0.95,
    mask: { kind: 'keep-last', tail: 4 },
    defaultEnabled: true,
  },
  {
    id: 'tr_phone',
    label: 'Turkish phone number',
    labels: { tr: 'Türkiye telefon numarası' },
    description: 'Turkish mobile (5xx), landline (2xx/3xx/4xx area code), 444 short-code and 0850 numbers (BTK numbering plan).',
    descriptions: { tr: 'Türkiye cep (5xx), sabit hat (2xx/3xx/4xx alan kodu), 444 kısa numara ve 0850 numaraları (BTK numaralandırma planı).' },
    languages: ['tr'],
    severity: 'medium',
    // PII v2: broadened from mobile-only to BTK's actual numbering plan —
    // mobile (5xx), landline (2xx/3xx/4[0-6]x area codes), 0850 non-geographic,
    // and 444 short codes (7 digits total, no area code, handled by the
    // second alternative since it doesn't fit the 3+3+2+2 grouping).
    // 444 short codes are conventionally written "444 D DDD" (a single
    // digit, then three), not as one contiguous 4-digit block — matching
    // \d{4} straight after 444 misses the real-world spacing.
    pattern: /\b(?:\+90[\s.-]?|0)?(?:5\d{2}|4[0-6]\d|3\d{2}|2\d{2}|850)[\s.-]?\d{3}[\s.-]?\d{2}[\s.-]?\d{2}\b|\b444[\s.-]?\d[\s.-]?\d{3}\b/g,
    validate: validatePhone,
    baseScore: 0.55,
    mask: { kind: 'keep-last', tail: 4 },
    defaultEnabled: true,
  },
  {
    id: 'tr_iban',
    label: 'Turkish IBAN',
    labels: { tr: 'Türkiye IBAN' },
    description: 'Turkish IBAN starting with TR followed by 24 digits.',
    descriptions: { tr: 'TR ile başlayan, 24 haneli Türkiye IBAN’ları.' },
    languages: ['tr'],
    severity: 'high',
    pattern: /\bTR\d{2}\s?\d{4}\s?\d{4}\s?\d{4}\s?\d{4}\s?\d{4}\s?\d{2}\b/g,
    baseScore: 0.9,
    mask: { kind: 'keep-edges', head: 4, tail: 4 },
    defaultEnabled: true,
  },
  {
    id: 'tr_vkn',
    label: 'Turkish Tax ID (VKN)',
    labels: { tr: 'Vergi Kimlik Numarası (VKN)' },
    description: '10-digit Turkish tax identification number, checksum-validated. Low base confidence — a random 10-digit run that survives the checksum is still fairly common (~1 in 10), so this category leans on a nearby context word ("vergi no", "VKN") to become a real finding.',
    descriptions: { tr: '10 haneli Türkiye vergi kimlik numarası, sağlama doğrulamalı. Temel güven düşük tutuldu — sağlamayı geçen rastgele 10 hane hâlâ sık (~10 da 1), bu yüzden kategori "vergi no"/"VKN" gibi bir bağlam kelimesine dayanıyor.' },
    languages: ['tr'],
    severity: 'high',
    pattern: /\b\d{10}\b/g,
    validate: validateVkn,
    baseScore: 0.25,
    mask: { kind: 'keep-last', tail: 4 },
    defaultEnabled: false,
  },
  {
    id: 'tr_plaka',
    label: 'Turkish license plate',
    labels: { tr: 'Türkiye araç plakası' },
    description: 'Turkish vehicle plate: 2-digit province code (01–81) + 1–3 letters + 2–5 digits.',
    descriptions: { tr: 'Türkiye araç plakası: 2 haneli il kodu (01–81) + 1–3 harf + 2–5 hane.' },
    languages: ['tr'],
    severity: 'medium',
    pattern: /\b(?:0[1-9]|[1-7]\d|8[01])\s?[A-PR-VYZ]{1,3}\s?\d{2,5}\b/g,
    baseScore: 0.5,
    mask: { kind: 'keep-edges', head: 2, tail: 0 },
    defaultEnabled: false,
  },
  {
    id: 'tr_passport',
    label: 'Turkish passport number',
    labels: { tr: 'Türkiye pasaport numarası' },
    description: 'Current-format Turkish passport number (U + 8 digits).',
    descriptions: { tr: 'Güncel formatta Türkiye pasaport numarası (U + 8 hane).' },
    languages: ['tr'],
    severity: 'high',
    pattern: /\bU\d{8}\b/g,
    baseScore: 0.35,
    mask: { kind: 'keep-edges', head: 1, tail: 2 },
    defaultEnabled: false,
  },
  {
    id: 'address_tr',
    label: 'Turkish street address',
    labels: { tr: 'Türkiye adresi' },
    description: 'Neighbourhood (Mahalle/Mah.) + a following "No:" building number, optionally with Daire/Kat.',
    descriptions: { tr: 'Mahalle/Mah. + ardından gelen "No:" bina numarası, opsiyonel Daire/Kat.' },
    languages: ['tr'],
    severity: 'medium',
    pattern: /(?:[A-ZÇĞİÖŞÜ][\wçğıöşüÇĞİÖŞÜ.]*\s+){1,3}(?:Mahallesi|Mah\.)[^.;\n]{0,80}?No\s*:?\s*\d+(?:[^.;\n]{0,20}?(?:Daire|D\.?|Kat)\s*:?\s*\d+)?/gu,
    baseScore: 0.55,
    mask: { kind: 'fixed', replacement: '[ADRES]' },
    defaultEnabled: false,
  },

  // German
  {
    id: 'de_phone',
    label: 'German phone number',
    labels: { tr: 'Almanya telefon numarası', de: 'Deutsche Telefonnummer' },
    description: 'German phone numbers (+49 / 0 prefix).',
    descriptions: { tr: '+49 / 0 ön ekli Alman telefon numaraları.' },
    languages: ['de'],
    severity: 'medium',
    pattern: /\b(?:\+49[\s-]?|0)\d{2,4}[\s-]?\d{3,4}[\s-]?\d{2,6}\b/g,
    baseScore: 0.5,
    mask: { kind: 'keep-last', tail: 4 },
    defaultEnabled: false,
  },

  // PII v2 — dictionary/NER-only categories. No `pattern`: these are raised
  // exclusively by `dictionary.ts` (L2) and `ner.ts` (L3), each candidate
  // carrying its own `baseScore` (see those modules). `baseScore: 0` here is
  // a placeholder that is never read on this path — kept for type
  // uniformity, not because it means anything for these three ids.
  {
    id: 'person',
    label: 'Person name',
    labels: { tr: 'Kişi adı' },
    description: 'A person\'s name, found by the gazetteer (dictionary) and/or NER passes — not a regex category.',
    descriptions: { tr: 'Sözlük (gazetteer) ve/veya NER geçişiyle bulunan kişi adı — regex kategorisi değildir.' },
    languages: ['global'],
    severity: 'high',
    baseScore: 0,
    mask: { kind: 'fixed', replacement: '[İSİM]' },
    defaultEnabled: false,
  },
  {
    id: 'organization',
    label: 'Organization name',
    labels: { tr: 'Kurum/şirket adı' },
    description: 'A company/organization name, found by the gazetteer and/or NER passes.',
    descriptions: { tr: 'Sözlük ve/veya NER geçişiyle bulunan şirket/kurum adı.' },
    languages: ['global'],
    severity: 'medium',
    baseScore: 0,
    mask: { kind: 'fixed', replacement: '[KURUM]' },
    defaultEnabled: false,
  },
  {
    id: 'location',
    label: 'Location',
    labels: { tr: 'Konum' },
    description: 'A province/district or other place name, found by the gazetteer and/or NER passes.',
    descriptions: { tr: 'Sözlük ve/veya NER geçişiyle bulunan il/ilçe veya diğer yer adı.' },
    languages: ['global'],
    severity: 'low',
    baseScore: 0,
    mask: { kind: 'fixed', replacement: '[KONUM]' },
    defaultEnabled: false,
  },
];

/** Quickly look up a built-in category by id. */
export const PII_CATEGORIES_BY_ID: Record<string, PiiCategoryDefinition> = Object.fromEntries(
  PII_CATEGORIES.map((c) => [c.id, c]),
);

/**
 * Return categories whose `languages` overlap with the requested set.
 * `requested` may include 'global' explicitly or omit it; 'global' categories
 * are ALWAYS returned. An empty `requested` returns every category (no filter).
 */
export function filterCategoriesByLanguages(
  requested: PiiLanguage[] | undefined,
  list: PiiCategoryDefinition[] = PII_CATEGORIES,
): PiiCategoryDefinition[] {
  if (!requested || requested.length === 0) return list;
  const set = new Set<PiiLanguage>(requested);
  return list.filter((c) => c.languages.includes('global') || c.languages.some((l) => set.has(l)));
}

/** Pick a locale-aware label for a category. Falls back to English. */
export function categoryLabel(category: PiiCategoryDefinition, locale: PiiLanguage = 'en'): string {
  return category.labels?.[locale] ?? category.label;
}

export function categoryDescription(category: PiiCategoryDefinition, locale: PiiLanguage = 'en'): string {
  return category.descriptions?.[locale] ?? category.description;
}
