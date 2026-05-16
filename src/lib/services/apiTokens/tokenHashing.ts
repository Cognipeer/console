import { createHash, randomBytes } from 'node:crypto';

const TOKEN_PREFIX_LENGTH = 16;

export function createApiTokenSecret(): string {
  return `cpeer_${randomBytes(32).toString('hex')}`;
}

export function hashApiToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function getApiTokenPrefix(token: string): string {
  return token.slice(0, TOKEN_PREFIX_LENGTH);
}
