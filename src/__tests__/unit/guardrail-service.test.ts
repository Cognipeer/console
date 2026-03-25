/**
 * Unit tests — GuardrailService
 * Tests: serializeGuardrail (pure), buildDefaultPresetPolicy (pure),
 *        createGuardrail, updateGuardrail, deleteGuardrail, getGuardrail,
 *        listGuardrails, evaluateGuardrail
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock('@/lib/database', () => ({
  getDatabase: vi.fn(),
}));

// Mock LLM evaluators so evaluateGuardrail tests don't need real LLM calls
// Note: piiDetector is a pure regex-based function — no mock needed
vi.mock('@/lib/services/guardrail/llmEvaluator', () => ({
  runModerationCheck: vi.fn().mockResolvedValue([]),
  runPromptShieldCheck: vi.fn().mockResolvedValue([]),
  runCustomPromptCheck: vi.fn().mockResolvedValue([]),
}));

import { getDatabase } from '@/lib/database';
import { createMockDb } from '../helpers/db.mock';
import {
  serializeGuardrail,
  buildDefaultPresetPolicy,
  createGuardrail,
  updateGuardrail,
  deleteGuardrail,
  getGuardrail,
  listGuardrails,
  evaluateGuardrail,
} from '@/lib/services/guardrail/guardrailService';
import type { IGuardrail } from '@/lib/database/provider.interface';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const TENANT_DB = 'tenant_acme';
const TENANT_ID = 'tenant-1';
const USER_ID = 'user-1';
const PROJECT_ID = 'proj-1';

function makeGuardrail(overrides: Partial<IGuardrail> = {}): IGuardrail {
  return {
    _id: 'grail-1',
    tenantId: TENANT_ID,
    projectId: PROJECT_ID,
    key: 'my-guardrail',
    name: 'My Guardrail',
    type: 'preset',
    target: 'input',
    action: 'block',
    enabled: true,
    createdBy: USER_ID,
    policy: {
      pii: {
        enabled: true,
        action: 'block',
        categories: { email: true, phone: false },
      },
    },
    ...overrides,
  };
}

// ── serializeGuardrail (pure function) ────────────────────────────────────────

describe('serializeGuardrail', () => {
  it('converts _id to string id field', () => {
    const record = makeGuardrail({ _id: 'grail-abc' });
    const view = serializeGuardrail(record);
    expect(view.id).toBe('grail-abc');
    expect((view as unknown as Record<string, unknown>)['_id']).toBeUndefined();
  });

  it('preserves all other fields', () => {
    const record = makeGuardrail();
    const view = serializeGuardrail(record);
    expect(view.key).toBe('my-guardrail');
    expect(view.name).toBe('My Guardrail');
    expect(view.type).toBe('preset');
    expect(view.enabled).toBe(true);
  });

  it('handles ObjectId-like _id', () => {
    const fakeId = { toString: () => 'objectid-abc' };
    const record = makeGuardrail({ _id: fakeId as unknown as string });
    const view = serializeGuardrail(record);
    expect(view.id).toBe('objectid-abc');
  });
});

// ── buildDefaultPresetPolicy (pure function) ──────────────────────────────────

describe('buildDefaultPresetPolicy', () => {
  it('returns an object with pii, moderation, and promptShield sections', () => {
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const policy = buildDefaultPresetPolicy()!;
    expect(policy.pii).toBeDefined();
    expect(policy.moderation).toBeDefined();
    expect(policy.promptShield).toBeDefined();
  });

  it('pii section is enabled with block action', () => {
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const { pii } = buildDefaultPresetPolicy()!;
    expect(pii!.enabled).toBe(true);
    expect(pii!.action).toBe('block');
  });

  it('moderation section is disabled by default', () => {
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const { moderation } = buildDefaultPresetPolicy()!;
    expect(moderation!.enabled).toBe(false);
  });

  it('promptShield section is disabled by default', () => {
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const { promptShield } = buildDefaultPresetPolicy()!;
    expect(promptShield!.enabled).toBe(false);
  });

  it('pii categories is a non-empty object', () => {
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const { pii } = buildDefaultPresetPolicy()!;
    expect(Object.keys(pii!.categories).length).toBeGreaterThan(0);
  });
});

// ── createGuardrail ───────────────────────────────────────────────────────────

describe('createGuardrail', () => {
  let db: ReturnType<typeof createMockDb>;

  beforeEach(() => {
    vi.clearAllMocks();
    db = createMockDb();
    (getDatabase as ReturnType<typeof vi.fn>).mockResolvedValue(db);
    db.findGuardrailByKey.mockResolvedValue(null); // key not taken
    db.createGuardrail.mockResolvedValue(makeGuardrail());
  });

  it('creates a guardrail and returns a serialized view', async () => {
    const result = await createGuardrail(TENANT_DB, TENANT_ID, USER_ID, {
      name: 'My Guardrail',
      type: 'preset',
      target: 'input',
      action: 'block',
      projectId: PROJECT_ID,
    });

    expect(db.createGuardrail).toHaveBeenCalledTimes(1);
    expect(result.id).toBe('grail-1');
    expect(result.key).toBe('my-guardrail');
  });

  it('auto-builds policy for preset type when not provided', async () => {
    await createGuardrail(TENANT_DB, TENANT_ID, USER_ID, {
      name: 'Auto Policy',
      type: 'preset',
      target: 'input',
      action: 'warn',
    });

    const call = db.createGuardrail.mock.calls[0][0];
    expect(call.policy).toBeDefined();
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(call.policy!.pii).toBeDefined();
  });

  it('does not add policy for custom type', async () => {
    db.createGuardrail.mockResolvedValue(
      makeGuardrail({ type: 'custom', policy: undefined, customPrompt: 'Check for hate speech' }),
    );

    await createGuardrail(TENANT_DB, TENANT_ID, USER_ID, {
      name: 'Custom Guardrail',
      type: 'custom',
      target: 'input',
      action: 'block',
      customPrompt: 'Check for hate speech',
    });

    const call = db.createGuardrail.mock.calls[0][0];
    expect(call.policy).toBeUndefined();
    expect(call.customPrompt).toBe('Check for hate speech');
  });
});

// ── updateGuardrail ───────────────────────────────────────────────────────────

describe('updateGuardrail', () => {
  let db: ReturnType<typeof createMockDb>;

  beforeEach(() => {
    vi.clearAllMocks();
    db = createMockDb();
    (getDatabase as ReturnType<typeof vi.fn>).mockResolvedValue(db);
  });

  it('returns updated view when guardrail exists', async () => {
    db.updateGuardrail.mockResolvedValue(makeGuardrail({ name: 'Updated Name' }));

    const result = await updateGuardrail(TENANT_DB, 'grail-1', USER_ID, {
      name: 'Updated Name',
    });

    expect(result).not.toBeNull();
    expect(result!.name).toBe('Updated Name');
  });

  it('returns null when guardrail not found', async () => {
    db.updateGuardrail.mockResolvedValue(null);

    const result = await updateGuardrail(TENANT_DB, 'nonexistent', USER_ID, {
      name: 'X',
    });

    expect(result).toBeNull();
  });

  it('passes updatedBy to db.updateGuardrail', async () => {
    db.updateGuardrail.mockResolvedValue(makeGuardrail());

    await updateGuardrail(TENANT_DB, 'grail-1', 'user-2', { enabled: false });

    const call = db.updateGuardrail.mock.calls[0][1];
    expect(call.updatedBy).toBe('user-2');
  });
});

// ── deleteGuardrail ───────────────────────────────────────────────────────────

describe('deleteGuardrail', () => {
  let db: ReturnType<typeof createMockDb>;

  beforeEach(() => {
    vi.clearAllMocks();
    db = createMockDb();
    (getDatabase as ReturnType<typeof vi.fn>).mockResolvedValue(db);
  });

  it('returns true on successful deletion', async () => {
    db.deleteGuardrail.mockResolvedValue(true);
    const result = await deleteGuardrail(TENANT_DB, 'grail-1');
    expect(result).toBe(true);
  });

  it('returns false when guardrail not found', async () => {
    db.deleteGuardrail.mockResolvedValue(false);
    const result = await deleteGuardrail(TENANT_DB, 'missing');
    expect(result).toBe(false);
  });
});

// ── getGuardrail ──────────────────────────────────────────────────────────────

describe('getGuardrail', () => {
  let db: ReturnType<typeof createMockDb>;

  beforeEach(() => {
    vi.clearAllMocks();
    db = createMockDb();
    (getDatabase as ReturnType<typeof vi.fn>).mockResolvedValue(db);
  });

  it('returns serialized view when found', async () => {
    db.findGuardrailById.mockResolvedValue(makeGuardrail());
    const result = await getGuardrail(TENANT_DB, 'grail-1');
    expect(result).not.toBeNull();
    expect(result!.id).toBe('grail-1');
  });

  it('returns null when not found', async () => {
    db.findGuardrailById.mockResolvedValue(null);
    const result = await getGuardrail(TENANT_DB, 'missing');
    expect(result).toBeNull();
  });
});

// ── listGuardrails ────────────────────────────────────────────────────────────

describe('listGuardrails', () => {
  let db: ReturnType<typeof createMockDb>;

  beforeEach(() => {
    vi.clearAllMocks();
    db = createMockDb();
    (getDatabase as ReturnType<typeof vi.fn>).mockResolvedValue(db);
    db.listGuardrails.mockResolvedValue([makeGuardrail()]);
  });

  it('returns serialized guardrail list', async () => {
    const result = await listGuardrails(TENANT_DB);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('grail-1');
  });

  it('returns empty array when no guardrails exist', async () => {
    db.listGuardrails.mockResolvedValue([]);
    const result = await listGuardrails(TENANT_DB);
    expect(result).toHaveLength(0);
  });

  it('passes filter options to db.listGuardrails', async () => {
    await listGuardrails(TENANT_DB, { type: 'preset', enabled: true, projectId: PROJECT_ID });
    expect(db.listGuardrails).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'preset', enabled: true, projectId: PROJECT_ID }),
    );
  });
});

// ── evaluateGuardrail ─────────────────────────────────────────────────────────

describe('evaluateGuardrail', () => {
  let db: ReturnType<typeof createMockDb>;

  beforeEach(() => {
    vi.clearAllMocks();
    db = createMockDb();
    (getDatabase as ReturnType<typeof vi.fn>).mockResolvedValue(db);
  });

  it('returns passed=true and no findings when guardrail is disabled', async () => {
    db.findGuardrailByKey.mockResolvedValue(makeGuardrail({ enabled: false }));

    const result = await evaluateGuardrail({
      tenantDbName: TENANT_DB,
      tenantId: TENANT_ID,
      guardrailKey: 'my-guardrail',
      text: 'hello world',
    });

    expect(result.passed).toBe(true);
    expect(result.findings).toHaveLength(0);
  });

  it('throws when guardrail key is not found', async () => {
    db.findGuardrailByKey.mockResolvedValue(null);

    await expect(
      evaluateGuardrail({
        tenantDbName: TENANT_DB,
        tenantId: TENANT_ID,
        guardrailKey: 'nonexistent',
        text: 'check me',
      }),
    ).rejects.toThrow('Guardrail with key "nonexistent" not found');
  });

  it('detects PII and returns block finding for "preset" type with pii enabled', async () => {
    db.findGuardrailByKey.mockResolvedValue(
      makeGuardrail({
        enabled: true,
        type: 'preset',
        action: 'block',
        policy: {
          pii: {
            enabled: true,
            action: 'block',
            categories: { email: true },
          },
        },
      }),
    );

    const result = await evaluateGuardrail({
      tenantDbName: TENANT_DB,
      tenantId: TENANT_ID,
      guardrailKey: 'my-guardrail',
      text: 'Contact us at support@example.com for help',
    });

    expect(result.findings.length).toBeGreaterThan(0);
    const emailFinding = result.findings.find((f) => f.category === 'email');
    expect(emailFinding).toBeDefined();
    expect(result.passed).toBe(false);
  });

  it('passes when no PII text is present', async () => {
    db.findGuardrailByKey.mockResolvedValue(
      makeGuardrail({
        enabled: true,
        type: 'preset',
        action: 'block',
        policy: {
          pii: {
            enabled: true,
            action: 'block',
            categories: { email: true },
          },
        },
      }),
    );

    const result = await evaluateGuardrail({
      tenantDbName: TENANT_DB,
      tenantId: TENANT_ID,
      guardrailKey: 'my-guardrail',
      text: 'Hello, how are you doing today?',
    });

    expect(result.passed).toBe(true);
    expect(result.findings).toHaveLength(0);
  });
});
