import { afterEach, describe, expect, it } from 'vitest';
import { jwtVerify } from 'jose';
import {
  getConfig,
  getConfigSource,
  setConfigSource,
  type ConfigSource,
} from '@/lib/core/config';
import {
  createInvitationUrl,
  INVITATION_TOKEN_PURPOSE,
} from '@/lib/services/auth/invitation';

const originalSource = getConfigSource();

function sourceWith(values: Record<string, string>): ConfigSource {
  return {
    name: 'test',
    get: (key) => values[key],
  };
}

afterEach(() => {
  setConfigSource(originalSource);
});

describe('createInvitationUrl', () => {
  it('creates a signed, seven-day password setup link for the invited user', async () => {
    setConfigSource(sourceWith({
      JWT_SECRET: 'test-secret',
      NEXT_PUBLIC_APP_URL: 'https://console.example.com/',
    }));

    const invitationUrl = await createInvitationUrl({
      _id: 'user-1',
      email: 'new@example.com',
    }, 'acme');

    const url = new URL(invitationUrl);
    expect(url.origin).toBe('https://console.example.com');
    expect(url.pathname).toBe('/reset-password');

    const token = url.searchParams.get('token');
    const secret = new TextEncoder().encode(getConfig().auth.jwtSecret);
    const { payload } = await jwtVerify(token!, secret);
    expect(payload).toMatchObject({
      email: 'new@example.com',
      purpose: INVITATION_TOKEN_PURPOSE,
      slug: 'acme',
      sub: 'user-1',
    });
    expect((payload.exp ?? 0) - (payload.iat ?? 0)).toBe(7 * 24 * 60 * 60);
  });
});