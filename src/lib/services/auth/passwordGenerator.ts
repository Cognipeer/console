/**
 * CSPRNG-based generator for temporary/generated user passwords.
 *
 * Guarantees the output satisfies `passwordPolicy.ts`'s `validatePassword()`:
 * min 8 chars, at least one uppercase, one lowercase, one digit, and one
 * special (non-alphanumeric) character. Uses `node:crypto`'s `randomInt`
 * exclusively — `Math.random` is not a CSPRNG and is disallowed in this
 * codebase's security-sensitive code paths.
 */

import { randomInt } from 'node:crypto';

const UPPERCASE = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const LOWERCASE = 'abcdefghijkmnpqrstuvwxyz';
const DIGITS = '23456789';
const SPECIAL = '!@#$%^&*()-_=+[]{}';
const ALL_CHARS = UPPERCASE + LOWERCASE + DIGITS + SPECIAL;

function randomChar(charset: string): string {
  return charset[randomInt(0, charset.length)];
}

/** CSPRNG-based Fisher-Yates shuffle. Mutates and returns `chars`. */
function shuffle(chars: string[]): string[] {
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomInt(0, i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars;
}

/**
 * Generates a random password guaranteed to pass `validatePassword()`.
 * One character from each required class is placed first, the remainder is
 * filled from the combined charset, then the whole string is shuffled so the
 * guaranteed characters aren't predictably positioned.
 */
export function generateSecurePassword(length = 16): string {
  const minLength = 8;
  const targetLength = Math.max(length, minLength);

  const chars: string[] = [
    randomChar(UPPERCASE),
    randomChar(LOWERCASE),
    randomChar(DIGITS),
    randomChar(SPECIAL),
  ];

  for (let i = chars.length; i < targetLength; i++) {
    chars.push(randomChar(ALL_CHARS));
  }

  return shuffle(chars).join('');
}
