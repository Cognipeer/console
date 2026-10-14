/**
 * applyCorsHeaders (the API plugin's CORS): a browser app on an allowed origin can read the
 * X-Decision-Id header that names an enforce-mode refusal (the dashboard hands it to
 * IAM center > Access check). A browser hides every response header it was not told to
 * expose, so the id would be invisible to cross-origin callers without this.
 */
import { describe, expect, it, vi } from 'vitest';

const config = vi.hoisted(() => ({ cors: { enabled: true, allowedOrigins: ['https://app.example.com'], maxAge: 600 } }));

vi.mock('@/lib/core/config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/core/config')>()),
  getConfig: () => config,
}));

import type { FastifyReply, FastifyRequest } from 'fastify';
import { applyCorsHeaders } from '@/server/api/cors';

function call(origin: string | undefined) {
  const headers: Record<string, string> = {};
  const reply = {
    header(name: string, value: string) {
      headers[name] = value;
      return reply;
    },
  };
  const applied = applyCorsHeaders({ headers: origin ? { origin } : {} } as unknown as FastifyRequest, reply as unknown as FastifyReply);
  return { applied, headers };
}

describe('applyCorsHeaders', () => {
  it('lets an allowed origin read X-Decision-Id', () => {
    const { applied, headers } = call('https://app.example.com');
    expect(applied).toBe(true);
    expect(headers['Access-Control-Allow-Origin']).toBe('https://app.example.com');
    expect(headers['Access-Control-Expose-Headers']).toBe('X-Decision-Id');
  });

  it('adds nothing for an origin that is not allowed, or for a request without one', () => {
    for (const origin of ['https://evil.example.net', 'null', undefined]) {
      const { applied, headers } = call(origin);
      expect(applied, String(origin)).toBe(false);
      expect(headers).toEqual({});
    }
  });

  it('adds nothing when CORS is switched off', () => {
    config.cors.enabled = false;
    try {
      const { applied, headers } = call('https://app.example.com');
      expect(applied).toBe(false);
      expect(headers).toEqual({});
    } finally {
      config.cors.enabled = true;
    }
  });
});
