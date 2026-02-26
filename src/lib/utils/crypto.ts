import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';
import { getConfig } from '@/lib/core/config';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // 96 bits for GCM
const AUTH_TAG_LENGTH = 16;

function resolveSecret(): Buffer {
  const cfg = getConfig();
  const secret = cfg.auth.providerEncryptionSecret;

  if (!secret) {
    throw new Error(
      'Encryption secret is not configured. Set PROVIDER_ENCRYPTION_SECRET or JWT_SECRET.',
    );
  }

  return createHash('sha256').update(secret).digest();
}

export function encryptObject(value: unknown): string {
  const key = resolveSecret();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const payload = Buffer.from(JSON.stringify(value), 'utf8');
  const encrypted = Buffer.concat([cipher.update(payload), cipher.final()]);
  const authTag = cipher.getAuthTag();
  const buffer = Buffer.concat([iv, authTag, encrypted]);
  return buffer.toString('base64');
}

export function decryptObject<T = unknown>(payload: string): T {
  const buffer = Buffer.from(payload, 'base64');
  const iv = buffer.subarray(0, IV_LENGTH);
  const authTag = buffer.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
  const ciphertext = buffer.subarray(IV_LENGTH + AUTH_TAG_LENGTH);
  const key = resolveSecret();
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);
  return JSON.parse(decrypted.toString('utf8')) as T;
}
