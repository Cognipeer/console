/**
 * API tests — the prompt library's render endpoint.
 * `POST /api/client/v1/prompts/:key/render` hands back text a client passes to a
 * model, so a value is inserted exactly as sent: no HTML entities for `&`, `<`,
 * `>` or quotes (Mustache's default), whichever tag style the template uses.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/database', () => {
  const getDatabase = vi.fn();
  return {
    getDatabase,
    runWithTenantScope: async (_tenantDbName: string, fn: (db: unknown) => unknown) => fn(await getDatabase()),
  };
});

vi.mock('@/lib/services/apiTokenAuth', () => {
  class ApiTokenAuthError extends Error {
    status: number;
    constructor(message: string, status = 401) {
      super(message);
      this.name = 'ApiTokenAuthError';
      this.status = status;
    }
  }
  return {
    ApiTokenAuthError,
    requireApiTokenFromHeader: vi.fn(),
  };
});

vi.mock('@/lib/services/prompts', () => ({
  activatePromptDeployment: vi.fn(),
  comparePromptVersions: vi.fn(),
  createPrompt: vi.fn(),
  deletePrompt: vi.fn(),
  getPromptByKey: vi.fn(),
  listPromptDeployments: vi.fn(),
  listPrompts: vi.fn(),
  listPromptVersions: vi.fn(),
  planPromptDeployment: vi.fn(),
  promotePromptVersion: vi.fn(),
  resolvePromptForEnvironment: vi.fn(),
  rollbackPromptDeployment: vi.fn(),
  setPromptLatestVersion: vi.fn(),
  updatePrompt: vi.fn(),
}));

import { clientPromptsApiPlugin } from '@/server/api/plugins/client-prompts';
import { resolvePromptForEnvironment } from '@/lib/services/prompts';
import { requireApiTokenFromHeader } from '@/lib/services/apiTokenAuth';
import { getDatabase } from '@/lib/database';
import { createMockDb } from '../helpers/db.mock';
import { createFastifyApiTestApp, parseJsonBody } from '../helpers/fastify-api';

const AUTH_CTX = {
  token: 'tok_abc',
  tokenRecord: { _id: 'tok-1', userId: 'user-1' },
  tenant: { licenseType: 'PROFESSIONAL' },
  tenantId: 'tenant-1',
  tenantSlug: 'acme',
  tenantDbName: 'tenant_acme',
  projectId: 'proj-1',
  user: { _id: 'user-1', role: 'owner', tenantId: 'tenant-1', servicePermissions: {} },
};

const NASTY = `Tom & Jerry <b>"quoted"</b> it's a/b`;

function promptWith(template: string) {
  return { prompt: { key: 'welcome', name: 'Welcome', template, currentVersion: 2 } };
}

beforeEach(() => {
  vi.clearAllMocks();
  (getDatabase as ReturnType<typeof vi.fn>).mockResolvedValue(createMockDb());
  (requireApiTokenFromHeader as ReturnType<typeof vi.fn>).mockResolvedValue(AUTH_CTX);
});

async function render(template: string, payload: object) {
  (resolvePromptForEnvironment as ReturnType<typeof vi.fn>).mockResolvedValue(promptWith(template));
  const app = await createFastifyApiTestApp(clientPromptsApiPlugin);
  const res = await app.inject({
    method: 'POST',
    url: '/api/client/v1/prompts/welcome/render?environment=prod',
    headers: { authorization: 'Bearer tok_abc', 'content-type': 'application/json' },
    payload: JSON.stringify(payload),
  });
  return { res, body: parseJsonBody<{ rendered: string; prompt: { key: string; version: number } }>(res.body) };
}

describe('POST /api/client/v1/prompts/:key/render', () => {
  it('inserts values under data exactly as sent (no HTML entities)', async () => {
    const { res, body } = await render('Hello {{name}}!', { data: { name: NASTY } });
    expect(res.statusCode).toBe(200);
    expect(body.rendered).toBe(`Hello ${NASTY}!`);
    expect(body.prompt).toMatchObject({ key: 'welcome', version: 2 });
  });

  it('reads a body without data as the variable map, also verbatim', async () => {
    const { body } = await render('{{a}} | {{b}}', { a: 'x < y', b: '"q" & \'r\'' });
    expect(body.rendered).toBe('x < y | "q" & \'r\'');
  });

  it('renders {{{x}}} and {{&x}} the same way', async () => {
    const { body } = await render('{{{x}}} {{&x}} {{x}}', { data: { x: '<&>' } });
    expect(body.rendered).toBe('<&> <&> <&>');
  });
});
