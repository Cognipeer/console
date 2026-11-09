/**
 * Unit tests — async dataset generation (enqueue + job runner).
 * Verifies the placeholder dataset + queue publish on enqueue, the
 * running→ready status transitions on success, and failed status + rethrow
 * on error. Queue, service CRUD, and the generator are mocked.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const createDataset = vi.fn();
const getDataset = vi.fn();
const listDatasetItems = vi.fn();
const appendDatasetItems = vi.fn();
const patchDatasetMetadata = vi.fn();
vi.mock('@/lib/services/evaluation/service', () => ({
  createDataset: (...a: unknown[]) => createDataset(...a),
  getDataset: (...a: unknown[]) => getDataset(...a),
  listDatasetItems: (...a: unknown[]) => listDatasetItems(...a),
  appendDatasetItems: (...a: unknown[]) => appendDatasetItems(...a),
  patchDatasetMetadata: (...a: unknown[]) => patchDatasetMetadata(...a),
}));
const generateDatasetItems = vi.fn();
vi.mock('@/lib/services/evaluation/datasetGeneration', () => ({
  generateDatasetItems: (...a: unknown[]) => generateDatasetItems(...a),
}));

const publish = vi.fn().mockResolvedValue('job-1');
vi.mock('@/lib/core/queue', () => ({
  getQueue: vi.fn(async () => ({ publish })),
}));

import {
  enqueueDatasetGeneration,
  runDatasetGenerationJob,
  DATASET_GEN_QUEUE,
  DATASET_GEN_JOB,
  type DatasetGenerationJobPayload,
} from '@/lib/services/evaluation/datasetGenerationJob';

const basePayload: DatasetGenerationJobPayload = {
  tenantDbName: 't',
  tenantId: 'tid',
  projectId: 'p',
  datasetId: 'ds1',
  createdBy: 'u1',
  generationModelKey: 'gpt',
  source: { type: 'text', text: 'hello' },
  sourceKind: 'text',
  count: 4,
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('enqueueDatasetGeneration', () => {
  it('creates a pending dataset and publishes a job', async () => {
    createDataset.mockResolvedValue({ id: 'ds1', name: 'My set' });

    const dataset = await enqueueDatasetGeneration({
      tenantDbName: 't',
      tenantId: 'tid',
      projectId: 'p',
      createdBy: 'u1',
      name: 'My set',
      generationModelKey: 'gpt',
      source: { type: 'rag', ragModuleKey: 'kb' },
      sourceKind: 'rag',
      count: 8,
    });

    expect(dataset.id).toBe('ds1');
    const createArg = createDataset.mock.calls[0][3];
    expect(createArg).toMatchObject({ source: 'generated', items: [] });
    expect(createArg.metadata.generation).toMatchObject({ status: 'pending', requested: 8, source: 'rag' });

    expect(publish).toHaveBeenCalledWith(
      DATASET_GEN_QUEUE,
      DATASET_GEN_JOB,
      expect.objectContaining({ datasetId: 'ds1', count: 8, sourceKind: 'rag' }),
      expect.any(Object),
    );
  });
});

describe('runDatasetGenerationJob', () => {
  const generation = (n: number) => patchDatasetMetadata.mock.calls[n][2].generation;
  const lastGeneration = () => generation(patchDatasetMetadata.mock.calls.length - 1);

  beforeEach(() => {
    getDataset.mockResolvedValue({ id: 'ds1', metadata: { generation: { status: 'pending' } } });
    listDatasetItems.mockResolvedValue({ items: [], total: 0 });
    appendDatasetItems.mockResolvedValue({ added: 2, total: 2 });
    patchDatasetMetadata.mockResolvedValue({ id: 'ds1' });
  });

  it('marks running then ready and appends the generated items', async () => {
    generateDatasetItems.mockResolvedValue({ items: [{ id: 'gen-1' }, { id: 'gen-2' }] });

    await runDatasetGenerationJob(basePayload);

    expect(generation(0)).toMatchObject({ status: 'running' });
    expect(appendDatasetItems).toHaveBeenCalledWith('t', 'ds1', [{ id: 'gen-1' }, { id: 'gen-2' }]);
    expect(lastGeneration()).toMatchObject({ status: 'ready', generated: 2 });
  });

  it('records the shortfall warning', async () => {
    generateDatasetItems.mockResolvedValue({ items: [{ id: 'gen-1' }], warning: 'Generated 1 of 4' });

    await runDatasetGenerationJob(basePayload);

    expect(lastGeneration()).toMatchObject({ status: 'ready', warning: 'Generated 1 of 4' });
  });

  it('renames generated ids that clash with items already in the dataset', async () => {
    listDatasetItems.mockResolvedValue({ items: [{ id: 'gen-1', tags: [] }], total: 1 });
    generateDatasetItems.mockResolvedValue({ items: [{ id: 'gen-1' }] });

    await runDatasetGenerationJob(basePayload);

    const appended = appendDatasetItems.mock.calls[0][2];
    expect(appended).toHaveLength(1);
    expect(appended[0].id).not.toBe('gen-1');
  });

  it('passes the dataset creator on with the source', async () => {
    generateDatasetItems.mockResolvedValue({ items: [{ id: 'gen-1' }] });

    await runDatasetGenerationJob({ ...basePayload, source: { type: 'rag', ragModuleKey: 'kb' }, sourceKind: 'rag' });

    expect(generateDatasetItems).toHaveBeenCalledWith(expect.objectContaining({
      createdBy: 'u1',
      source: { type: 'rag', ragModuleKey: 'kb' },
    }));
  });

  it('does nothing when the dataset was deleted', async () => {
    getDataset.mockResolvedValue(null);

    await runDatasetGenerationJob(basePayload);

    expect(generateDatasetItems).not.toHaveBeenCalled();
    expect(patchDatasetMetadata).not.toHaveBeenCalled();
  });

  it('does not generate twice when the job is redelivered after it finished', async () => {
    getDataset.mockResolvedValue({ id: 'ds1', metadata: { generation: { status: 'ready' } } });

    await runDatasetGenerationJob(basePayload);

    expect(generateDatasetItems).not.toHaveBeenCalled();
  });

  it('finalises instead of regenerating when an earlier attempt already appended its items', async () => {
    getDataset.mockResolvedValue({ id: 'ds1', metadata: { generation: { status: 'running', startedAt: 'x' } } });
    listDatasetItems.mockResolvedValue({ items: [{ id: 'gen-1', tags: ['generated'] }], total: 1 });

    await runDatasetGenerationJob(basePayload);

    expect(generateDatasetItems).not.toHaveBeenCalled();
    expect(lastGeneration()).toMatchObject({ status: 'ready', generated: 1 });
  });

  it('writes failed and rethrows on the last attempt', async () => {
    generateDatasetItems.mockRejectedValue(new Error('model down'));

    await expect(runDatasetGenerationJob(basePayload, { attemptsMade: 1 })).rejects.toThrow('model down');

    expect(lastGeneration()).toMatchObject({ status: 'failed', error: 'model down' });
  });

  it('keeps running (no failed write) while a retry is left', async () => {
    generateDatasetItems.mockRejectedValue(new Error('model down'));

    await expect(runDatasetGenerationJob(basePayload, { attemptsMade: 0 })).rejects.toThrow('model down');

    expect(lastGeneration()).toMatchObject({ status: 'running', lastError: 'model down' });
    expect(patchDatasetMetadata.mock.calls.some((c) => c[2].generation.status === 'failed')).toBe(false);
  });
});
