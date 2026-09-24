/**
 * The `@cognipeer/pii` npm package's own category catalog, snapshotted from
 * `require('@cognipeer/pii').categories` (0.1.1) rather than imported at
 * runtime — this file has to stay usable from a plain type/UI context with no
 * database and no tenant, the same reason `services/pii/categories.ts` (the
 * `regex` engine's own catalog) is a static table rather than a live read.
 *
 * A COMPLETELY DIFFERENT id vocabulary from `PII_CATEGORIES`
 * (`services/pii/categories.ts`) — e.g. `tc_kimlik` here, `tckn` there — by
 * design, not oversight: see `PiiEngine`'s own doc comment (types.domain.ts)
 * for why the two engines are not meant to be reconciled into one id space.
 */

import type { CategoryCatalogEntry } from './types';

/** 31 categories, in the package's own manifest order. The last three
 *  (`person`/`organization`/`location`) only ever produce a finding once the
 *  scan runs at `pattern+dictionary` or above — see `cognipeerEngine.ts`. */
export const COGNIPEER_PII_CATEGORIES: CategoryCatalogEntry[] = [
  { id: 'email', label: 'Email address', description: 'Email address', languages: ['global'], severity: 'high', defaultEnabled: true },
  { id: 'phone', label: 'Phone number', description: 'Phone number', languages: ['global'], severity: 'medium', defaultEnabled: true },
  { id: 'creditCard', label: 'Credit card number', description: 'Credit card number', languages: ['global'], severity: 'high', defaultEnabled: true },
  { id: 'iban', label: 'IBAN', description: 'IBAN', languages: ['global'], severity: 'high', defaultEnabled: true },
  { id: 'swift', label: 'SWIFT/BIC code', description: 'SWIFT/BIC code', languages: ['global'], severity: 'medium', defaultEnabled: false },
  { id: 'ipAddress', label: 'IP address', description: 'IP address', languages: ['global'], severity: 'low', defaultEnabled: false },
  { id: 'url', label: 'URL', description: 'URL', languages: ['global'], severity: 'low', defaultEnabled: false },
  { id: 'socialHandle', label: 'Social handle', description: 'Social handle', languages: ['global'], severity: 'low', defaultEnabled: false },
  { id: 'apiKey', label: 'API token or secret', description: 'API token or secret', languages: ['global'], severity: 'high', defaultEnabled: false },
  { id: 'cryptoWallet', label: 'Crypto wallet address', description: 'Crypto wallet address', languages: ['global'], severity: 'medium', defaultEnabled: false },
  { id: 'birthDate', label: 'Date of birth', description: 'Date of birth', languages: ['global'], severity: 'medium', defaultEnabled: false },
  { id: 'address_en', label: 'Street address', description: 'Street address (English)', languages: ['en'], severity: 'medium', defaultEnabled: false },
  { id: 'ssn_us', label: 'US Social Security Number', description: 'US Social Security Number', languages: ['en'], severity: 'high', defaultEnabled: false },
  { id: 'passport_en', label: 'Passport number', description: 'Passport number', languages: ['en'], severity: 'high', defaultEnabled: false },
  { id: 'tc_kimlik', label: 'Turkish National ID (TC Kimlik No)', description: 'Turkish National ID (TC Kimlik No)', languages: ['tr'], severity: 'high', defaultEnabled: true },
  { id: 'tr_phone', label: 'Turkish phone number', description: 'Turkish phone number', languages: ['tr'], severity: 'medium', defaultEnabled: true },
  { id: 'tr_iban', label: 'Turkish IBAN', description: 'Turkish IBAN', languages: ['tr'], severity: 'high', defaultEnabled: true },
  { id: 'tr_vkn', label: 'Turkish Tax ID (VKN)', description: 'Turkish Tax ID (VKN)', languages: ['tr'], severity: 'high', defaultEnabled: false },
  { id: 'tr_plaka', label: 'Turkish license plate', description: 'Turkish license plate', languages: ['tr'], severity: 'medium', defaultEnabled: false },
  { id: 'tr_passport', label: 'Turkish passport number', description: 'Turkish passport number', languages: ['tr'], severity: 'high', defaultEnabled: false },
  { id: 'address_tr', label: 'Turkish street address', description: 'Turkish street address', languages: ['tr'], severity: 'medium', defaultEnabled: false },
  { id: 'de_phone', label: 'German phone number', description: 'German phone number', languages: ['de'], severity: 'medium', defaultEnabled: false },
  { id: 'geoCoordinates', label: 'GPS coordinates', description: 'GPS coordinates', languages: ['global'], severity: 'high', defaultEnabled: true },
  { id: 'username', label: 'Username', description: 'Username', languages: ['global'], severity: 'medium', defaultEnabled: false },
  { id: 'password', label: 'Password', description: 'Password', languages: ['global'], severity: 'high', defaultEnabled: false },
  { id: 'cardCvv', label: 'Card CVV/CVC code', description: 'Card CVV/CVC code', languages: ['global'], severity: 'high', defaultEnabled: true },
  { id: 'pin', label: 'PIN code', description: 'PIN code', languages: ['global'], severity: 'high', defaultEnabled: true },
  { id: 'macAddress', label: 'MAC address', description: 'MAC address', languages: ['global'], severity: 'high', defaultEnabled: true },
  { id: 'person', label: 'Person name', description: 'Person name — needs "pattern+dictionary" mode or above', languages: ['global'], severity: 'high', defaultEnabled: false },
  { id: 'organization', label: 'Organization name', description: 'Organization name — needs "pattern+dictionary" mode or above', languages: ['global'], severity: 'medium', defaultEnabled: false },
  { id: 'location', label: 'Location', description: 'Location — needs "pattern+dictionary" mode or above', languages: ['global'], severity: 'low', defaultEnabled: false },
];

export const COGNIPEER_PII_CATEGORIES_BY_ID: Readonly<Record<string, CategoryCatalogEntry>> =
  Object.fromEntries(COGNIPEER_PII_CATEGORIES.map((c) => [c.id, c]));

export function buildCognipeerDefaultCategories(): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const c of COGNIPEER_PII_CATEGORIES) out[c.id] = c.defaultEnabled;
  return out;
}
