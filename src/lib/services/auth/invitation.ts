import { SignJWT } from 'jose';
import { getConfig } from '@/lib/core/config';
import type { IUser } from '@/lib/database';

export const INVITATION_TOKEN_PURPOSE = 'user-invitation';

const INVITATION_TOKEN_EXPIRY_SECONDS = 7 * 24 * 60 * 60;

export async function createInvitationUrl(
  user: Pick<IUser, '_id' | 'email'>,
  slug: string,
): Promise<string> {
  if (!user._id) {
    throw new Error('Cannot create an invitation link without a user id');
  }

  const issuedAt = Math.floor(Date.now() / 1000);
  const secret = new TextEncoder().encode(getConfig().auth.jwtSecret);
  const token = await new SignJWT({
    email: user.email,
    purpose: INVITATION_TOKEN_PURPOSE,
    slug,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(String(user._id))
    .setIssuedAt(issuedAt)
    .setExpirationTime(issuedAt + INVITATION_TOKEN_EXPIRY_SECONDS)
    .sign(secret);

  return `${getConfig().app.url.replace(/\/$/, '')}/reset-password?token=${encodeURIComponent(token)}`;
}