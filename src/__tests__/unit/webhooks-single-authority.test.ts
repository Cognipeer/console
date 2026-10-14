/**
 * The policy engine is the ONLY authority over webhooks. The webhook code scopes data (tenant,
 * project, 404 masking) and asks the engine what the caller holds; it never looks at a role or
 * a membership itself. A second, private authority is how the old checks drifted from IAM (a
 * group-derived project admin was refused, a group-derived tenant admin could not reach
 * tenant-wide endpoints, an explicit grant changed nothing), so this fails if one creeps back.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { getServiceDefinition } from '@/lib/security/rbac';

const ROOT = process.cwd();
const sourceOf = (file: string) => readFileSync(join(ROOT, file), 'utf8');

const WEBHOOK_AUTHORITY_FILES = [
  'src/lib/services/webhooks/webhookEndpointService.ts',
  'src/server/api/plugins/webhook-routes.ts',
  'src/server/api/plugins/webhooks.ts',
  'src/server/api/plugins/client-webhooks.ts',
  // The page: what it shows comes from the engine's answer (`capabilities`), not from the user's role.
  'src/components/settings/WebhookManagement.tsx',
  'src/components/settings/webhooksUi.ts',
];

/** Role names, role tests, the old helper names and membership lookups. */
const PRIVATE_AUTHORITY = /\b(isTenantAdmin|isProjectAdmin|assertCanManage|canAccess)\b|role\s*[=!]==|\.role\b|'project_admin'|'owner'|'admin'\s*\|\|?|findUserProject|userProject|useDashboardUser/;

describe('webhooks: IAM is the only authority', () => {
  it.each(WEBHOOK_AUTHORITY_FILES)('%s contains no role check or membership lookup', (file) => {
    const code = sourceOf(file)
      // comments may name the roles they no longer test
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    const hits = code.split('\n').map((line, i) => ({ line, n: i + 1 })).filter(({ line }) => PRIVATE_AUTHORITY.test(line));
    expect(hits.map(({ n, line }) => `${file}:${n}: ${line.trim()}`)).toEqual([]);
  });

  it('webhooks is an administration service: Read to look, Admin to change', () => {
    expect(getServiceDefinition('webhooks').adminService).toBe(true);
  });
});
