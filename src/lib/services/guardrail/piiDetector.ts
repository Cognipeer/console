import type { GuardrailAction, IGuardrailPiiPolicy } from '@/lib/database';
import type { GuardrailFinding } from './types';

// ── Regex patterns for PII detection ─────────────────────────────────────

const PATTERNS: Record<string, RegExp> = {
  email: /[a-zA-Z0-9_.+-]+@[a-zA-Z0-9-]+\.[a-zA-Z0-9-.]+/g,
  phone: /(?:\+?\d[\d\s().-]{7,}\d)/g,
  creditCard: /\b(?:\d[ -]*?){13,19}\b/g,
  iban: /\b[A-Z]{2}[0-9A-Z]{13,32}\b/g,
  swift: /\b[A-Z]{4}[A-Z]{2}[A-Z0-9]{2}(?:[A-Z0-9]{3})?\b/g,
  nationalId: /\b\d{3}[-.\s]?\d{2}[-.\s]?\d{4}\b/g,
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

const CATEGORY_MESSAGES: Record<string, string> = {
  email: 'Email address detected',
  phone: 'Phone number detected',
  creditCard: 'Credit card number detected',
  iban: 'IBAN detected',
  swift: 'SWIFT/BIC code detected',
  nationalId: 'National identification number detected',
  passport: 'Passport number detected',
  birthDate: 'Birth date detected',
  address: 'Physical address detected',
  ipAddress: 'IP address detected',
  url: 'URL detected',
  socialHandle: 'Social handle detected',
  apiKey: 'API token or secret detected',
  cryptoWallet: 'Cryptocurrency wallet address detected',
};

function findMatches(text: string, category: string): string[] {
  const pattern = PATTERNS[category];
  if (!pattern) return [];

  const globalPattern = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : pattern.flags + 'g');
  globalPattern.lastIndex = 0;

  const matches: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = globalPattern.exec(text)) !== null) {
    matches.push(match[0]);
  }
  return matches;
}

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

function getMatches(text: string, category: string): string[] {
  const raw = findMatches(text, category);
  if (category === 'phone') return raw.filter(validatePhone);
  if (category === 'creditCard') return raw.filter(validateCreditCard);
  return raw;
}

export function runPiiDetection(
  text: string,
  policy: IGuardrailPiiPolicy,
): GuardrailFinding[] {
  if (!policy.enabled) return [];

  const findings: GuardrailFinding[] = [];
  const action = policy.action ?? 'block';
  const enabledCategories = Object.entries(policy.categories || {})
    .filter(([, enabled]) => enabled)
    .map(([id]) => id);

  for (const category of enabledCategories) {
    const matches = getMatches(text, category);
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
