/**
 * Sandbox secrets are write-only: sealed on save, masked on every read, and a
 * masked value sent back keeps what is stored.
 */

import { describe, it, expect } from 'vitest';
import {
    AGENT_SANDBOX_SECRET_MASK as MASK,
    maskAgentSandboxConfig,
    maskAgentSandboxSecrets,
    openAgentSandboxSecrets,
    scrubSecretValues,
    sealAgentSandboxConfig,
} from '@/lib/services/agents/agentSandboxSecrets';
import { buildAgentManifest } from '@/lib/services/agents/agentManifest';

describe('sandbox secrets', () => {
    const stored = sealAgentSandboxConfig({ enabled: true, secrets: { A: 'alpha-1', B: 'bravo-2' } }, undefined)!;

    it('seals on save and never keeps the plaintext', () => {
        expect(stored.secrets).toBeUndefined();
        expect(stored.secretsSealed).toBeTruthy();
        expect(JSON.stringify(stored)).not.toMatch(/alpha-1|bravo-2/);
        expect(openAgentSandboxSecrets(stored)).toEqual({ A: 'alpha-1', B: 'bravo-2' });
    });

    it('masks on read: keys visible, values not, no ciphertext', () => {
        const masked = maskAgentSandboxConfig(stored)!;
        expect(masked.secrets).toEqual({ A: MASK, B: MASK });
        expect(masked.secretsSealed).toBeUndefined();
        const agent = maskAgentSandboxSecrets({ config: { modelKey: 'm', sandbox: stored } });
        expect(JSON.stringify(agent)).not.toContain(stored.secretsSealed!);
    });

    it('update: mask keeps, new value replaces, missing key removes', () => {
        const next = sealAgentSandboxConfig({ enabled: true, secrets: { A: MASK, C: 'charlie-3' } }, stored)!;
        expect(openAgentSandboxSecrets(next)).toEqual({ A: 'alpha-1', C: 'charlie-3' });
    });

    it('an update without a `secrets` field keeps the stored secrets', () => {
        const next = sealAgentSandboxConfig({ enabled: false, templateKey: 'x' }, stored)!;
        expect(openAgentSandboxSecrets(next)).toEqual({ A: 'alpha-1', B: 'bravo-2' });
    });

    it('a masked value with nothing stored (another tenant, a new agent) is dropped, not saved as the mask', () => {
        const next = sealAgentSandboxConfig({ enabled: true, secrets: { A: MASK } }, undefined)!;
        expect(openAgentSandboxSecrets(next)).toEqual({});
    });

    it('scrubs secret values out of tool output', () => {
        expect(scrubSecretValues('key=alpha-1 other=ok', { A: 'alpha-1', short: 'ok' })).toBe(`key=${MASK} other=ok`);
    });

    it('an exported manifest carries the secret keys, never the sealed values', () => {
        const manifest = buildAgentManifest(
            { key: 'builder', name: 'Builder', status: 'active' } as never,
            { modelKey: 'm', sandbox: stored },
        );
        const text = JSON.stringify(manifest);
        expect(text).not.toContain(stored.secretsSealed!);
        expect(manifest.spec.sandbox?.secrets).toEqual({ A: MASK, B: MASK });
    });
});
