/**
 * The guardrail PII family carries each finding's confidence into its
 * `SafetyFinding` (the contract field existed; the family never filled it), and
 * a policy's `detection.minConfidence` decides what the guardrail sees at all.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  switchToTenant: vi.fn(),
  findPiiPolicyByKey: vi.fn(),
}));

vi.mock('@/lib/database', () => ({
  getDatabase: vi.fn(async () => hoisted),
  runWithTenantScope: vi.fn(async (_tenantDbName: string, fn: (db: typeof hoisted) => unknown) => fn(hoisted)),
}));

vi.mock('@/lib/services/availability/safetySkip', () => ({
  safetyCheckSkipped: vi.fn(async () => false),
}));

import { runPiiPolicy } from '@/lib/services/guardrail/families/pii';
import type { HookScope, HookSubject } from '@/lib/services/guardrail/hooks/contract';

const scope = { tenantId: 't1', tenantDbName: 'tenant_t1', projectId: 'proj-1' } as HookScope;
const subject = (text: string) => ({ text, segments: [{ path: '/messages/0/content', text }] }) as unknown as HookSubject;
const policy = {
  id: 'legacy:pii',
  family: 'pii',
  enabled: true,
  hooks: ['input.pre'],
  piiPolicyKey: 'firstpolicy',
  detectObfuscated: false,
} as unknown as Parameters<typeof runPiiPolicy>[0]['policy'];

function storedPolicy(engine: 'regex' | 'cognipeer', detection?: { minConfidence?: number }) {
  return {
    _id: 'p1', key: 'firstpolicy', name: 'FirstPolicy', tenantId: 't1', enabled: true, createdBy: 'u1',
    defaultAction: 'block', engine, languages: ['tr'], customPatterns: [],
    categories: { email: true, phone: true, tc_kimlik: true, tr_phone: true },
    ...(detection ? { detection } : {}),
  };
}

// No context words, so the scores are the categories' own: TC 0.95, email 0.9, phone 0.5.
const TEXT = 'Kayıt: 10000000146 / 0532 123 45 67 / ayse@example.com';

beforeEach(() => vi.clearAllMocks());

describe.each(['regex', 'cognipeer'] as const)('guardrail pii family · %s engine', (engine) => {
  it('stamps every finding with the detector\'s confidence', async () => {
    hoisted.findPiiPolicyByKey.mockResolvedValue(storedPolicy(engine));
    const { findings } = await runPiiPolicy({ policy, subject: subject(TEXT), hook: 'input.pre', scope, action: 'block' });
    expect(findings.length).toBeGreaterThanOrEqual(3);
    for (const finding of findings) {
      expect(typeof finding.confidence).toBe('number');
      expect(finding.confidence).toBeGreaterThan(0);
      expect(finding.confidence).toBeLessThanOrEqual(1);
    }
    expect(findings.find((f) => f.category === 'tc_kimlik')?.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it('never sees findings below the policy\'s minConfidence', async () => {
    hoisted.findPiiPolicyByKey.mockResolvedValue(storedPolicy(engine, { minConfidence: 0.92 }));
    const { findings } = await runPiiPolicy({ policy, subject: subject(TEXT), hook: 'input.pre', scope, action: 'block' });
    expect(findings.map((f) => f.category)).toEqual(['tc_kimlik']);
  });
});
