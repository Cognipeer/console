/**
 * The password reset mail lists every organization the address belongs to,
 * each with its own reset link. Rendered through the real template; only the
 * SMTP transport is replaced.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';

const sendMail = vi.hoisted(() => vi.fn().mockResolvedValue({}));
vi.mock('nodemailer', () => ({ default: { createTransport: vi.fn(() => ({ sendMail })) } }));

import { getConfigSource, setConfigSource } from '@/lib/core/config';
import { sendEmail } from '@/lib/email/mailer';

const smtp: Record<string, string> = { SMTP_USER: 'mailer', SMTP_PASS: 'not-a-real-secret', SMTP_FROM: 'console@example.com' };

describe('password-reset mail', () => {
  const original = getConfigSource();

  beforeEach(() => {
    sendMail.mockClear();
    setConfigSource({ name: `${original.name}+smtp`, get: (key: string) => smtp[key] ?? original.get(key) });
  });

  afterEach(() => {
    setConfigSource(original);
  });

  it('carries a reset link for every organization, under its name', async () => {
    const sent = await sendEmail('jane@example.com', 'password-reset', {
      expiryTime: '1 hour',
      name: 'Jane',
      organizations: [
        { name: 'Acme', resetUrl: 'https://console.example.com/reset-password?token=for-acme' },
        { name: 'Globex', resetUrl: 'https://console.example.com/reset-password?token=for-globex' },
      ],
    });

    expect(sent).toBe(true);
    const { document } = new JSDOM(sendMail.mock.calls[0][0].html).window;
    const links = [...document.querySelectorAll('a')].map((a) => a.getAttribute('href'));
    expect(links).toEqual([
      'https://console.example.com/reset-password?token=for-acme',
      'https://console.example.com/reset-password?token=for-globex',
    ]);
    expect(document.body.textContent).toContain('Acme');
    expect(document.body.textContent).toContain('Globex');
  });
});
