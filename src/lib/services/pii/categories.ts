/**
 * Built-in PII categories.
 *
 * Each category ships with:
 *  - a regex pattern (or a discriminating tester function)
 *  - the languages/locales it applies to ('global' = language-independent)
 *  - i18n labels per supported locale (falls back to English)
 *  - masking strategy hint for partial obfuscation (e.g. keep-last-4 for cards)
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
  /** Regex source (global flag enforced by detector). */
  pattern: RegExp;
  /** Optional value validator (e.g. Luhn for credit cards). */
  validate?: (value: string) => boolean;
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
    mask: { kind: 'keep-edges', head: 6, tail: 4 },
    defaultEnabled: false,
  },
  {
    id: 'birthDate',
    label: 'Date of birth',
    labels: { tr: 'Doğum tarihi' },
    description: 'Common date formats (dd/mm/yyyy, yyyy-mm-dd).',
    descriptions: { tr: 'Yaygın tarih formatları (gg/aa/yyyy, yyyy-aa-gg).' },
    languages: ['global'],
    severity: 'medium',
    pattern: /\b\d{2}[/-]\d{2}[/-]\d{4}\b|\b\d{4}[/-]\d{2}[/-]\d{2}\b/g,
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
    mask: { kind: 'keep-last', tail: 4 },
    defaultEnabled: true,
  },
  {
    id: 'tr_phone',
    label: 'Turkish phone number',
    labels: { tr: 'Türkiye telefon numarası' },
    description: 'Turkish phone numbers with +90 country code or 0 prefix.',
    descriptions: { tr: '+90 ülke kodlu veya 0 ile başlayan Türkiye telefon numaraları.' },
    languages: ['tr'],
    severity: 'medium',
    pattern: /\b(?:\+90[\s-]?|0)5\d{2}[\s-]?\d{3}[\s-]?\d{2}[\s-]?\d{2}\b/g,
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
    mask: { kind: 'keep-edges', head: 4, tail: 4 },
    defaultEnabled: true,
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
    mask: { kind: 'keep-last', tail: 4 },
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
