/**
 * An enterprise overlay built before seam 4 replaces `registry.ts` without
 * exporting `agentSandboxRunner`. That must read as "no sandbox module", not
 * throw — found running a seam-3 console-ee main against seam-4 community.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@/enterprise/registry', () => ({}));
vi.mock('@/lib/license/tenantLicense', () => ({ isTenantEnterpriseLicensed: vi.fn(async () => true) }));

import { resolveSandboxAvailability } from '@/lib/services/agents/agentSandboxTools';

describe('sandbox availability with a pre-seam-4 overlay', () => {
    it('reports "edition" instead of throwing', async () => {
        await expect(resolveSandboxAvailability('t1')).resolves.toEqual({ available: false, reason: 'edition' });
    });
});
