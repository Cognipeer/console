/**
 * Unit tests — GuardrailService
 * Tests: serializeGuardrail (pure), createGuardrail, updateGuardrail, deleteGuardrail, getGuardrail,
 *        listGuardrails, evaluateGuardrail
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks ─────────────────────────────────────────────────────────────────────

// `runWithTenantScope` is mocked alongside `getDatabase` because the hook
// engine resolves every record through it rather than calling `switchToTenant`
// itself — a tenant-scoped read that skips the wrapper is the cross-tenant race
// this repo has already been bitten by. The stub reproduces the real helper's
// contract (resolve the provider, hand it to the callback) against whatever
// `getDatabase` is made to return in a given test.
vi.mock('@/lib/database', () => {
  const getDatabase = vi.fn();
  return {
    getDatabase,
    runWithTenantScope: async (
      _tenantDbName: string,
      fn: (db: unknown) => unknown,
    ) => fn(await getDatabase()),
  };
});

// Mock LLM evaluators so evaluateGuardrail tests don't need real LLM calls
// Note: the PII detector is a pure regex-based function — no mock needed
vi.mock('@/lib/services/guardrail/llmEvaluator', () => ({
  runModerationPolicy: vi.fn().mockResolvedValue([]),
  runPromptShieldPolicy: vi.fn().mockResolvedValue([]),
  runCustomPromptPolicy: vi.fn().mockResolvedValue([]),
}));

import { getDatabase } from '@/lib/database';
import { drainPendingTasks } from '@/lib/core/asyncTask';
import { createMockDb } from '../helpers/db.mock';
import {
  serializeGuardrail,
  createGuardrail,
  updateGuardrail,
  deleteGuardrail,
  getGuardrail,
  listGuardrails,
  evaluateGuardrail,
} from '@/lib/services/guardrail/guardrailService';
import type { IGuardrail, IPiiPolicy } from '@/lib/database/provider.interface';
import type { GuardrailHooksConfig, GuardrailPolicy } from '@/lib/services/guardrail/hooks/contract';
import { resetRecordCaches } from '@/lib/services/guardrail/hooks/recordCache';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const TENANT_DB = 'tenant_acme';
const TENANT_ID = 'tenant-1';
const USER_ID = 'user-1';
const PROJECT_ID = 'proj-1';

const SYNC_BLOCK = { timing: 'sync', onFail: 'block' } as const;

/** A hooks config running `policies` on both model-facing hooks. */
function hooksOf(...policies: GuardrailPolicy[]): GuardrailHooksConfig {
  return {
    contractVersion: 2,
    policies,
    bindings: {
      'input.pre': { enabled: true, schedule: SYNC_BLOCK },
      'output.pre': { enabled: true, schedule: SYNC_BLOCK },
    },
  };
}

function piiPolicy(action: 'block' | 'redact'): GuardrailPolicy {
  return {
    id: 'pii:1',
    family: 'pii',
    enabled: true,
    hooks: ['input.pre', 'output.pre'],
    schedule: SYNC_BLOCK,
    action,
    piiPolicyKey: 'pii-default',
  };
}

function wordFilterPolicy(extra: Record<string, unknown> = {}): GuardrailPolicy {
  return {
    id: 'wf:1',
    family: 'word_filter',
    enabled: true,
    hooks: ['input.pre', 'output.pre'],
    schedule: SYNC_BLOCK,
    action: 'block',
    ...extra,
  } as GuardrailPolicy;
}

function moderationPolicy(): GuardrailPolicy {
  return {
    id: 'mod:1',
    family: 'moderation',
    enabled: true,
    hooks: ['input.pre', 'output.pre'],
    schedule: SYNC_BLOCK,
    categories: { hate: true },
  } as GuardrailPolicy;
}

/** The PII service's policy row the `pii` family reads. */
function piiPolicyRow(): IPiiPolicy {
  return {
    _id: 'pii-row-1',
    tenantId: TENANT_ID,
    key: 'pii-default',
    name: 'Default',
    defaultAction: 'detect',
    categories: { email: true },
    enabled: true,
    createdBy: USER_ID,
  } as unknown as IPiiPolicy;
}

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
    hooks: hooksOf(piiPolicy('block')),
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

describe('serializeGuardrail read shape', () => {
  it('derives a read-only policy summary from the hooks and drops retired columns', () => {
    const record = makeGuardrail({
      hooks: hooksOf(piiPolicy('redact'), wordFilterPolicy({ words: ['x'] })),
    });
    // An older database row may still carry the retired columns.
    (record as unknown as Record<string, unknown>).customPrompt = 'old';
    (record as unknown as Record<string, unknown>).policy = { pii: { enabled: false } };

    const view = serializeGuardrail(record) as unknown as Record<string, unknown>;
    expect(view.customPrompt).toBeUndefined();
    const summary = view.policy as { pii?: { enabled: boolean; action: string }; wordFilter?: { enabled: boolean } };
    // The summary carries the record's own action; per-policy actions live in hooks.
    expect(summary.pii).toMatchObject({ enabled: true, action: 'block' });
    expect(summary.wordFilter?.enabled).toBe(true);
  });

  it('serves no policy summary for a record without hooks', () => {
    const view = serializeGuardrail(makeGuardrail({ hooks: undefined }));
    expect(view.hooks).toBeUndefined();
    expect(view.policy).toBeUndefined();
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
      action: 'block',
      projectId: PROJECT_ID,
    });

    expect(db.createGuardrail).toHaveBeenCalledTimes(1);
    expect(result.id).toBe('grail-1');
    expect(result.key).toBe('my-guardrail');
  });

  it('stores an empty hooks config when none is given', async () => {
    await createGuardrail(TENANT_DB, TENANT_ID, USER_ID, {
      name: 'No Policies Yet',
      action: 'warn',
    });

    const call = db.createGuardrail.mock.calls[0][0];
    expect(call.hooks?.policies).toEqual([]);
    expect(call.hooksVersion).toBe(2);
    expect('policy' in call).toBe(false);
    expect('customPrompt' in call).toBe(false);
  });

  it('stores the given hooks and writes no legacy columns', async () => {
    await createGuardrail(TENANT_DB, TENANT_ID, USER_ID, {
      name: 'Hooked',
      action: 'block',
      hooks: hooksOf(wordFilterPolicy({ words: ['forbidden'] })),
    });

    const call = db.createGuardrail.mock.calls[0][0];
    expect(call.hooks?.policies).toHaveLength(1);
    expect('policy' in call).toBe(false);
    expect('customPrompt' in call).toBe(false);
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
    // The hook engine resolves guardrail, PII-policy and tenant records through
    // a 60s TTL cache. Every case here reuses the key 'my-guardrail' with a
    // DIFFERENT record, so without this every test after the first would assert
    // against the first one's cached row — the disabled guardrail, which runs
    // nothing. Production is invalidated on save; a test suite has no save.
    resetRecordCaches();
    db.findPiiPolicyByKey.mockResolvedValue(piiPolicyRow());
  });

  it('returns passed=true, disabled=true, and no findings when guardrail is disabled', async () => {
    db.findGuardrailByKey.mockResolvedValue(
      makeGuardrail({
        enabled: false,
        // Even with a PII match in the text, a disabled guardrail runs nothing.
        hooks: hooksOf(piiPolicy('block')),
      }),
    );

    const result = await evaluateGuardrail({
      tenantDbName: TENANT_DB,
      tenantId: TENANT_ID,
      guardrailKey: 'my-guardrail',
      text: 'contact me at leak@corp.com',
    });

    expect(result.passed).toBe(true);
    expect(result.disabled).toBe(true);
    expect(result.findings).toHaveLength(0);
  });

  it('does not set disabled on an enabled guardrail', async () => {
    db.findGuardrailByKey.mockResolvedValue(makeGuardrail({ enabled: true }));

    const result = await evaluateGuardrail({
      tenantDbName: TENANT_DB,
      tenantId: TENANT_ID,
      guardrailKey: 'my-guardrail',
      text: 'hello world',
    });

    expect(result.disabled).toBeUndefined();
  });

  it('throws when guardrail key is not found', async () => {
    db.findGuardrailByKey.mockResolvedValue(null);

    await expect(
      evaluateGuardrail({
        tenantDbName: TENANT_DB,
        tenantId: TENANT_ID,
        guardrailKey: 'nonexistent',
        text: 'policy me',
      }),
    ).rejects.toThrow('Guardrail with key "nonexistent" not found');
  });

  it('detects PII and returns block finding for "preset" type with pii enabled', async () => {
    db.findGuardrailByKey.mockResolvedValue(
      makeGuardrail({
        enabled: true,
        action: 'block',
        hooks: hooksOf(piiPolicy('block')),
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
        action: 'block',
        hooks: hooksOf(piiPolicy('block')),
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

  it('applies uploaded custom word lists referenced by customListKeys', async () => {
    const listKey = `custom-list-${Date.now()}`;
    db.findGuardrailByKey.mockResolvedValue(
      makeGuardrail({
        hooks: hooksOf(
          wordFilterPolicy({
            builtinLists: { 'profanity-en': false, 'profanity-tr': false },
            customListKeys: [listKey],
          }),
        ),
      }),
    );
    db.findGuardrailWordListByKey.mockResolvedValue({ key: listKey, words: ['forbiddenbrand'], tenantId: TENANT_ID, name: 'List', createdBy: USER_ID });

    const result = await evaluateGuardrail({
      tenantDbName: TENANT_DB,
      tenantId: TENANT_ID,
      guardrailKey: 'my-guardrail',
      text: 'tell me about ForbiddenBrand products',
    });

    expect(result.passed).toBe(false);
    expect(result.findings[0].type).toBe('word_filter');
  });

  it('blocks profanity via the word filter policy', async () => {
    db.findGuardrailByKey.mockResolvedValue(
      makeGuardrail({
        hooks: hooksOf(wordFilterPolicy()),
      }),
    );

    const result = await evaluateGuardrail({
      tenantDbName: TENANT_DB,
      tenantId: TENANT_ID,
      guardrailKey: 'my-guardrail',
      text: 'this is fucking unacceptable',
    });

    expect(result.passed).toBe(false);
    expect(result.findings[0].type).toBe('word_filter');
  });

  it('returns redactedText and passes when PII action is redact', async () => {
    db.findGuardrailByKey.mockResolvedValue(
      makeGuardrail({
        hooks: hooksOf(piiPolicy('redact')),
      }),
    );

    const result = await evaluateGuardrail({
      tenantDbName: TENANT_DB,
      tenantId: TENANT_ID,
      guardrailKey: 'my-guardrail',
      text: 'Mail me at leak@corp.com please',
    });

    expect(result.passed).toBe(true);
    expect(result.findings.length).toBeGreaterThan(0);
    expect(result.redactedText).toBeDefined();
    expect(result.redactedText).not.toContain('leak@corp.com');
    // `[REDACTED_EMAIL]`, not the guardrail detector's old `[REDACTED:email]`.
    // Redaction now runs through the PII service, so the marker is the one the
    // standalone /v1/pii API, snapshot anonymisation and dataset import have
    // always emitted — the point of collapsing onto one engine is that there is
    // one marker, and this is the one three of the four callers already used.
    expect(result.redactedText).toContain('[REDACTED_EMAIL]');
  });

  it('fails closed when an LLM policy is enabled without any model', async () => {
    db.findGuardrailByKey.mockResolvedValue(
      makeGuardrail({
        modelKey: undefined,
        failMode: 'closed',
        hooks: hooksOf(moderationPolicy()),
      }),
    );

    const result = await evaluateGuardrail({
      tenantDbName: TENANT_DB,
      tenantId: TENANT_ID,
      guardrailKey: 'my-guardrail',
      text: 'anything',
    });

    expect(result.passed).toBe(false);
    expect(result.findings[0].category).toBe('evaluation_error');
  });

  it('fails open (default) when an LLM policy is enabled without any model — passes but surfaces the gap', async () => {
    db.findGuardrailByKey.mockResolvedValue(
      makeGuardrail({
        modelKey: undefined,
        hooks: hooksOf(moderationPolicy()),
      }),
    );

    const result = await evaluateGuardrail({
      tenantDbName: TENANT_DB,
      tenantId: TENANT_ID,
      guardrailKey: 'my-guardrail',
      text: 'anything',
    });

    expect(result.passed).toBe(true);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].category).toBe('evaluation_error');
    expect(result.findings[0].block).toBe(false);
  });

  it('writes an evaluation log with masked values', async () => {
    db.findGuardrailByKey.mockResolvedValue(
      makeGuardrail({
        hooks: hooksOf(piiPolicy('block')),
      }),
    );

    await evaluateGuardrail({
      tenantDbName: TENANT_DB,
      tenantId: TENANT_ID,
      guardrailKey: 'my-guardrail',
      text: 'reach me at secret@corp.com',
      source: 'unit-test',
      requestId: 'req-1',
    });
    await drainPendingTasks();

    expect(db.createGuardrailEvaluationLog).toHaveBeenCalledTimes(1);
    const log = db.createGuardrailEvaluationLog.mock.calls[0][0];
    expect(log.guardrailKey).toBe('my-guardrail');
    expect(log.passed).toBe(false);
    expect(log.source).toBe('unit-test');
    expect(log.requestId).toBe('req-1');
    // Raw PII must never be persisted
    expect(log.inputText).not.toContain('secret@corp.com');
    expect(JSON.stringify(log.findings)).not.toContain('secret@corp.com');
  });

  it('skips logging when skipLogging is set', async () => {
    db.findGuardrailByKey.mockResolvedValue(makeGuardrail());

    await evaluateGuardrail({
      tenantDbName: TENANT_DB,
      tenantId: TENANT_ID,
      guardrailKey: 'my-guardrail',
      text: 'plain text',
      skipLogging: true,
    });
    await drainPendingTasks();

    expect(db.createGuardrailEvaluationLog).not.toHaveBeenCalled();
  });
});
