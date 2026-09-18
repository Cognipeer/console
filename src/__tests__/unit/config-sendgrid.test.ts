import { afterEach, describe, expect, it } from 'vitest';
import {
  getConfig,
  getConfigSource,
  setConfigSource,
  type ConfigSource,
} from '@/lib/core/config';

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

describe('email configuration', () => {
  it('uses SendGrid SMTP when no explicit SMTP transport is configured', () => {
    setConfigSource(sourceWith({
      SENDGRID_API_KEY: 'test-sendgrid-key',
      SENDGRID_FROM_EMAIL: 'noreply@example.com',
    }));

    expect(getConfig().smtp).toEqual({
      host: 'smtp.sendgrid.net',
      port: 587,
      secure: false,
      user: 'apikey',
      pass: 'test-sendgrid-key',
      from: 'noreply@example.com',
    });
  });

  it('keeps explicit SMTP credentials ahead of SendGrid', () => {
    setConfigSource(sourceWith({
      SENDGRID_API_KEY: 'test-sendgrid-key',
      SMTP_FROM: 'mail@example.com',
      SMTP_HOST: 'smtp.example.com',
      SMTP_PASS: 'smtp-password',
      SMTP_USER: 'smtp-user',
    }));

    expect(getConfig().smtp).toEqual({
      host: 'smtp.example.com',
      port: 587,
      secure: false,
      user: 'smtp-user',
      pass: 'smtp-password',
      from: 'mail@example.com',
    });
  });
});