/**
 * Unit tests — async dataset generation (enqueue + job runner).
 * Verifies the placeholder dataset + queue publish on enqueue, the
 * running→ready status transitions on success, and failed status + rethrow
 * on error. Queue, service CRUD, and the generator are mocked.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const createDataset = vi.fn();
const updateDataset = vi.fn();
vi.mock('@/lib/services/evaluation/service', () => ({
  createDataset: (...a: unknown[]) => createDataset(...a),
  updateDataset: (...a: unknown[]) => updateDataset(...a),
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
  it('marks running then ready with generated items', async () => {
    generateDatasetItems.mockResolvedValue({ items: [{ id: 'gen-1' }, { id: 'gen-2' }] });

    await runDatasetGenerationJob(basePayload);

    // first update = running
    expect(updateDataset.mock.calls[0][3].metadata.generation).toMatchObject({ status: 'running' });
    // last update = ready with items
    const last = updateDataset.mock.calls[updateDataset.mock.calls.length - 1][3];
    expect(last.metadata.generation).toMatchObject({ status: 'ready', generated: 2 });
    expect(last.items).toHaveLength(2);
  });

  it('marks failed and rethrows on generation error', async () => {
    generateDatasetItems.mockRejectedValue(new Error('model down'));

    await expect(runDatasetGenerationJob(basePayload)).rejects.toThrow('model down');

    const last = updateDataset.mock.calls[updateDataset.mock.calls.length - 1][3];
    expect(last.metadata.generation).toMatchObject({ status: 'failed', error: 'model down' });
  });
});
