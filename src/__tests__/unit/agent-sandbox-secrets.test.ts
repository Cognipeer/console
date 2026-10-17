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
    sealAgentConfigSecrets,
    scrubSecretValues,
    sealAgentSandboxConfig,
} from '@/lib/services/agents/agentSandboxSecrets';
import { openAgentCallbackSecret, sealAgentCallbackConfig } from '@/lib/services/agents/agentCallbackConfig';
import type { IAgentConfig } from '@/lib/database';
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

describe('agent callback secret (config.callback)', () => {
    const URL_ = 'https://hooks.example.com/agent';
    const stored = sealAgentCallbackConfig({ url: URL_, secret: 'agent-callback-secret-1' }, undefined)!;

    it('seals on save and never keeps the plaintext', () => {
        expect(stored.secret).toBeUndefined();
        expect(stored.secretSealed).toBeTruthy();
        expect(JSON.stringify(stored)).not.toContain('agent-callback-secret-1');
        expect(openAgentCallbackSecret(stored)).toBe('agent-callback-secret-1');
    });

    it('masks on read, with no ciphertext', () => {
        const agent = maskAgentSandboxSecrets({ config: { modelKey: 'm', callback: stored } });
        expect(agent.config.callback?.secret).toBe(MASK);
        expect(agent.config.callback?.secretSealed).toBeUndefined();
        expect(JSON.stringify(agent)).not.toContain(stored.secretSealed!);
        // No secret stored → nothing to mask.
        const plain = maskAgentSandboxSecrets({ config: { modelKey: 'm', callback: { url: URL_ } } });
        expect(plain.config.callback).toEqual({ url: URL_ });
    });

    it('update: mask or omission keeps, a new value replaces, empty string removes', () => {
        expect(openAgentCallbackSecret(sealAgentCallbackConfig({ url: URL_, secret: MASK }, stored))).toBe('agent-callback-secret-1');
        expect(openAgentCallbackSecret(sealAgentCallbackConfig({ url: URL_ }, stored))).toBe('agent-callback-secret-1');
        expect(openAgentCallbackSecret(sealAgentCallbackConfig({ url: URL_, secret: 'rotated-secret-value-2' }, stored))).toBe('rotated-secret-value-2');
        const removed = sealAgentCallbackConfig({ url: URL_, secret: '' }, stored)!;
        expect(removed.secretSealed).toBeUndefined();
        expect(openAgentCallbackSecret(removed)).toBeUndefined();
    });

    it('a client cannot supply its own ciphertext through secretSealed', () => {
        const supplied = sealAgentCallbackConfig({ url: URL_, secretSealed: 'client-blob' }, undefined)!;
        expect(supplied.secretSealed).toBeUndefined();
    });

    it('sealAgentConfigSecrets seals the callback alongside sandbox and drops a legacy execution blob', () => {
        const next = sealAgentConfigSecrets(
            { modelKey: 'm', callback: { url: URL_, secret: 'agent-callback-secret-1' }, execution: { defaultMode: 'background' } } as IAgentConfig,
            undefined,
        );
        expect(next.callback?.secret).toBeUndefined();
        expect(openAgentCallbackSecret(next.callback)).toBe('agent-callback-secret-1');
        expect('execution' in next).toBe(false);
    });

    it('a read never returns a legacy execution blob (its sealed secret included)', () => {
        const legacy = { modelKey: 'm', execution: { callbackSecretSealed: 'sealed-legacy-value' } } as unknown as IAgentConfig;
        const agent = maskAgentSandboxSecrets({ config: legacy });
        expect(JSON.stringify(agent)).not.toContain('sealed-legacy-value');
    });

    it('a manifest export carries the URL and a mask, never the sealed secret', () => {
        const manifest = buildAgentManifest(
            { key: 'builder', name: 'Builder', status: 'active' } as never,
            { modelKey: 'm', callback: stored },
        );
        const text = JSON.stringify(manifest);
        expect(text).not.toContain(stored.secretSealed!);
        expect(manifest.spec.callback).toEqual({ url: URL_, secret: MASK });
    });
});
