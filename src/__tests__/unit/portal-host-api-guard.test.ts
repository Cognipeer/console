import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getConfigSource, setConfigSource } from '@/lib/core/config';
import { portalHostApiGuard } from '@/server/app';

const originalSource = getConfigSource();

describe('a portal host answers only the portal of the API', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    setConfigSource({
      name: 'test',
      get: (key) => ({ APP_URL: 'https://console.cognipeer.test', PORTAL_BASE_DOMAIN: 'portal.cognipeer.test' } as Record<string, string>)[key],
    });
    app = Fastify();
    app.addHook('onRequest', portalHostApiGuard);
    app.get('/api/agents', async () => ({ ok: 'agents' }));
    app.get('/api/portal/:portalKey/info', async () => ({ ok: 'portal' }));
    app.get('/api/portal-host/sign-in', async () => ({ ok: 'sign-in' }));
    app.get('/hr-desk', async () => ({ ok: 'page' }));
    app.get('/api-embed/portal/:portalKey', async () => ({ ok: 'frame' }));
    app.get('/api-embed', async () => ({ ok: 'portal keyed api-embed' }));
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    setConfigSource(originalSource);
  });

  const get = (url: string, host: string, extra: Record<string, string> = {}) =>
    app.inject({ method: 'GET', url, headers: { host, ...extra } });

  it('refuses the Console API on a portal host, whatever the path spelling', async () => {
    const res = await get('/api/agents', 'acme.portal.cognipeer.test');
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ code: 'route_not_found' });
    expect((await get('/api/portal/../agents', 'acme.portal.cognipeer.test')).statusCode).toBe(404);
    expect((await get('/api//agents', 'acme.portal.cognipeer.test')).statusCode).toBe(404);
  });

  it('refuses the embed frame too (it is served by the Console host), but not a portal keyed like it', async () => {
    expect((await get('/api-embed/portal/hr-desk?tenant=acme', 'acme.portal.cognipeer.test')).statusCode).toBe(404);
    expect((await get('/api-embed', 'acme.portal.cognipeer.test')).json()).toEqual({ ok: 'portal keyed api-embed' });
    expect((await get('/api-embed/portal/hr-desk', 'console.cognipeer.test')).json()).toEqual({ ok: 'frame' });
  });

  it('lets the portal runtime, its sign-in and the pages through', async () => {
    expect((await get('/api/portal/hr-desk/info', 'acme.portal.cognipeer.test')).json()).toEqual({ ok: 'portal' });
    expect((await get('/api/portal-host/sign-in', 'acme.portal.cognipeer.test')).json()).toEqual({ ok: 'sign-in' });
    expect((await get('/hr-desk', 'acme.portal.cognipeer.test')).json()).toEqual({ ok: 'page' });
  });

  it('reads the host the proxy forwards', async () => {
    const res = await get('/api/agents', 'pod-1:3000', { 'x-forwarded-host': 'acme.portal.cognipeer.test' });
    expect(res.statusCode).toBe(404);
  });

  it('leaves the Console host alone', async () => {
    expect((await get('/api/agents', 'console.cognipeer.test')).json()).toEqual({ ok: 'agents' });
  });
});
