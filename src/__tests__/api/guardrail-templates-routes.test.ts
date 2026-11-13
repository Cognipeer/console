/**
 * Guardrail templates over the live routes: list, apply, and a created guardrail
 * that behaves like a hand-written one.
 *
 * Applying a template creates a NEW guardrail in `monitor`, marked with the
 * template it came from, through the same write path as `POST /guardrails`. A
 * template that scans personal data provisions its PII policy in the project
 * once and reuses it on the next apply.
 *
 * Real SQLite, the live Fastify plugins; only the project context is stubbed.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyPluginAsync } from 'fastify';

const tmpRoot = mkdtempSync(path.join(tmpdir(), 'cognipeer-guardrail-templates-'));
process.env.DB_PROVIDER = 'sqlite';
process.env.SQLITE_DATA_DIR = tmpRoot;
process.env.MAIN_DB_NAME = 'guardrail_templates_main';

const PROJECT_ID = 'project-templates';

vi.mock('@/lib/services/projects/projectContext', () => ({
  ProjectContextError: class extends Error {
    status = 400;
  },
  resolveProjectContext: vi.fn(async (ctx: { tenantId: string; userId: string }) => ({
    projectId: PROJECT_ID,
    project: { _id: PROJECT_ID, tenantId: ctx.tenantId, name: 'Templates', key: 'templates', status: 'active' },
    user: { _id: ctx.userId, tenantId: ctx.tenantId, email: 'owner@example.com', role: 'owner', status: 'active' },
    userProject: null,
  })),
  requireProjectContext: vi.fn(),
}));

import { reloadConfig } from '@/lib/core/config';
import { disconnectDatabase, getDatabase } from '@/lib/database';
import { guardrailsApiPlugin } from '@/server/api/plugins/guardrails';
import { piiApiPlugin } from '@/server/api/plugins/pii';
import { GUARDRAIL_TEMPLATES } from '@/lib/services/guardrail/templates/catalog';
import { createFastifyApiTestApp } from '../helpers/fastify-api';

const TENANT_DB_NAME = 'guardrail_templates_tenant';
const TENANT_ID = 'tenant-guardrail-templates';
const HEADERS: Record<string, string> = {
  'x-tenant-db-name': TENANT_DB_NAME,
  'x-tenant-id': TENANT_ID,
  'x-tenant-slug': 'templates',
  'x-user-id': 'pending',
  'x-user-email': 'owner@example.com',
  'x-user-role': 'owner',
  'x-license-type': 'FREE',
};

const plugins: FastifyPluginAsync = async (app) => {
  await app.register(guardrailsApiPlugin);
  await app.register(piiApiPlugin);
};

let app: Awaited<ReturnType<typeof createFastifyApiTestApp>>;

beforeAll(async () => {
  reloadConfig();
  const db = await getDatabase();
  await db.createTenant({ companyName: 'Templates', slug: 'templates', dbName: TENANT_DB_NAME, licenseType: 'FREE', ownerId: 'pending' });
  await db.switchToTenant(TENANT_DB_NAME);
  const owner = await db.createUser({
    tenantId: TENANT_ID, email: 'owner@example.com', name: 'Owner', password: '$2b$10$x', role: 'owner', licenseId: 'FREE', features: [],
  });
  HEADERS['x-user-id'] = String(owner._id);
  app = await createFastifyApiTestApp(plugins);
}, 60_000);

afterAll(async () => {
  vi.restoreAllMocks();
  await app?.close();
  await disconnectDatabase();
  rmSync(tmpRoot, { recursive: true, force: true });
});

type TemplateItem = { key: string; usedBy: number; piiPolicy?: { preset: string; existingKey?: string }; policies: string[] };

const list = async () => {
  const res = await app.inject({ method: 'GET', url: '/api/guardrails/templates', headers: HEADERS });
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as { catalogVersion: number; categories: unknown[]; templates: TemplateItem[] };
};
const apply = (key: string, body: Record<string, unknown> = {}) =>
  app.inject({ method: 'POST', url: `/api/guardrails/templates/${key}/apply`, headers: HEADERS, payload: body });

describe('guardrail templates', () => {
  it('lists the whole catalog, none used yet', async () => {
    const body = await list();
    expect(body.catalogVersion).toBeGreaterThanOrEqual(1);
    expect(body.categories.length).toBeGreaterThan(0);
    expect(body.templates.map((t) => t.key)).toEqual(GUARDRAIL_TEMPLATES.map((t) => t.key));
    expect(body.templates.every((t) => t.usedBy === 0)).toBe(true);
    expect(body.templates.find((t) => t.key === 'kvkk')?.piiPolicy).toEqual({ preset: 'kvkk', name: expect.any(String) });
  });

  it.each(GUARDRAIL_TEMPLATES.map((t) => [t.key]))('applies %s as a new guardrail in monitor', async (key) => {
    const res = await apply(key);
    expect(res.statusCode, res.body).toBe(201);
    const body = res.json();
    expect(body.template).toEqual({ key, version: expect.any(Number) });
    expect(body.guardrail.mode).toBe('monitor');
    expect(body.guardrail.enabled).toBe(true);
    expect(body.guardrail.metadata).toEqual({ template: body.template });
    expect(body.guardrail.hooks.policies.length).toBeGreaterThan(0);
  });

  it('creates a template PII policy once and reuses it', async () => {
    const first = await apply('kvkk', { name: 'KVKK, second copy' });
    expect(first.statusCode, first.body).toBe(201);
    expect(first.json().piiPolicy).toMatchObject({ created: false });
    expect(first.json().guardrail.name).toBe('KVKK, second copy');

    const policies = await app.inject({ method: 'GET', url: '/api/pii/policies', headers: HEADERS });
    expect(policies.statusCode, policies.body).toBe(200);
    const kvkkPolicies = (policies.json().policies as Array<{ key: string; metadata?: Record<string, unknown> }>)
      .filter((p) => p.metadata?.guardrailTemplatePiiPreset === 'kvkk');
    expect(kvkkPolicies).toHaveLength(1);
    expect(first.json().piiPolicy.key).toBe(kvkkPolicies[0].key);

    const kvkk = (await list()).templates.find((t) => t.key === 'kvkk')!;
    expect(kvkk.usedBy).toBe(2);
    expect(kvkk.piiPolicy?.existingKey).toBe(kvkkPolicies[0].key);
  });

  it('a created guardrail masks once it is switched to enforce', async () => {
    const created = (await apply('kvkk', { name: 'KVKK enforce check' })).json();
    const text = 'Bana ali.veli@example.com adresinden yazın.';
    const evaluate = () =>
      app.inject({
        method: 'POST', url: '/api/guardrails/evaluate', headers: HEADERS,
        payload: { guardrail_key: created.guardrail.key, text },
      });

    const monitored = await evaluate();
    expect(monitored.statusCode, monitored.body).toBe(200);
    expect(monitored.json().passed).toBe(true);
    expect(monitored.json().findings.length).toBeGreaterThan(0);
    expect(monitored.json().redacted_text ?? text).toContain('ali.veli@example.com');

    const patched = await app.inject({
      method: 'PATCH', url: `/api/guardrails/${created.guardrail.id}`, headers: HEADERS, payload: { mode: 'enforce' },
    });
    expect(patched.statusCode, patched.body).toBe(200);

    const enforced = await evaluate();
    expect(enforced.statusCode, enforced.body).toBe(200);
    expect(typeof enforced.json().redacted_text).toBe('string');
    expect(enforced.json().redacted_text).not.toContain('ali.veli@example.com');
  });

  it('rejects an unknown template and a bad name', async () => {
    expect((await apply('no-such-template')).statusCode).toBe(404);
    expect((await apply('baseline', { name: '   ' })).statusCode).toBe(400);
    expect((await apply('baseline', { description: 42 })).statusCode).toBe(400);
  });
});
