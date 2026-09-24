/**
 * An enterprise overlay built before seam 4 replaces `registry.ts` without
 * exporting `agentSandboxRunner`. That must read as "no sandbox module", not
 * throw — found running a seam-3 console-ee main against seam-4 community.
 */
import { describe, it, expect, vi } from 'vitest';

// The real registry, minus the seam-4 export — what a pre-seam-4 overlay
// looks like to community code.
vi.mock('@/enterprise/registry', async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    agentSandboxRunner: undefined,
}));
vi.mock('@/lib/license/tenantLicense', () => ({ isTenantEnterpriseLicensed: vi.fn(async () => true) }));

import { resolveSandboxAvailability } from '@/lib/services/agents/agentSandboxTools';

describe('sandbox availability with a pre-seam-4 overlay', () => {
    it('reports "edition" instead of throwing', async () => {
        await expect(resolveSandboxAvailability('t1')).resolves.toEqual({ available: false, reason: 'edition' });
    });
});
