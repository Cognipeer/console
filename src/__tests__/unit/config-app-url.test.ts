import { afterEach, describe, expect, it } from 'vitest';
import {
  getConfig,
  getConfigSource,
  setConfigSource,
  type ConfigSource,
  validateConfig,
} from '@/lib/core/config';

const originalSource = getConfigSource();

function sourceWith(values: Record<string, string | undefined>): ConfigSource {
  return {
    name: 'test',
    get: (key) => values[key],
  };
}

function productionValues(overrides: Record<string, string | undefined> = {}) {
  return {
    JWT_SECRET: 'a'.repeat(32),
    NODE_ENV: 'production',
    PROVIDER_ENCRYPTION_SECRET: 'b'.repeat(32),
    ...overrides,
  };
}

afterEach(() => {
  setConfigSource(originalSource);
});

describe('application URL configuration', () => {
  it('prefers the server-side APP_URL over the legacy public variable', () => {
    setConfigSource(sourceWith({
      APP_URL: 'https://console.cognipeer.com',
      NEXT_PUBLIC_APP_URL: 'https://legacy.example.test',
    }));

    expect(getConfig().app.url).toBe('https://console.cognipeer.com');
  });

  it('uses NEXT_PUBLIC_APP_URL only as a backwards-compatible fallback', () => {
    setConfigSource(sourceWith({
      NEXT_PUBLIC_APP_URL: 'https://legacy.example.test',
    }));

    expect(getConfig().app.url).toBe('https://legacy.example.test');
  });

  it('fails production validation when the URL would fall back to localhost', () => {
    setConfigSource(sourceWith(productionValues()));

    expect(validateConfig(getConfig())).toContainEqual(expect.objectContaining({
      key: 'APP_URL',
      message: expect.stringContaining('loopback'),
    }));
  });

  it('fails production validation for a malformed server URL', () => {
    setConfigSource(sourceWith(productionValues({ APP_URL: 'console.cognipeer.com' })));

    expect(validateConfig(getConfig())).toContainEqual(expect.objectContaining({
      key: 'APP_URL',
      message: expect.stringContaining('absolute http(s) URL'),
    }));
  });

  it('accepts a public APP_URL in production', () => {
    setConfigSource(sourceWith(productionValues({ APP_URL: 'https://console.cognipeer.com' })));

    expect(validateConfig(getConfig())).not.toContainEqual(expect.objectContaining({
      key: 'APP_URL',
    }));
  });
});