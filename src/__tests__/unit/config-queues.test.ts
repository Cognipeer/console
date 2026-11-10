import { afterEach, describe, expect, it } from 'vitest';
import { getConfig, getConfigSource, setConfigSource, type ConfigSource } from '@/lib/core/config';

const originalSource = getConfigSource();

function sourceWith(values: Record<string, string | undefined>): ConfigSource {
  return { name: 'test', get: (key) => values[key] };
}

afterEach(() => {
  setConfigSource(originalSource);
});

describe('config queues block', () => {
  it('uses the defaults when nothing is set', () => {
    setConfigSource(sourceWith({}));
    expect(getConfig().queues).toEqual({
      redteamScanConcurrency: 2,
      datasetGenConcurrency: 2,
      evaluationRunConcurrency: 2,
      analysisRunConcurrency: 2,
      analysisMaxRunConversations: 5000,
      ragIngestConcurrency: 2,
      ragIngestBootResumeMax: 500,
      ragReindexConcurrency: 1,
      vectorMigrationConcurrency: 2,
      crawlerRunConcurrency: 2,
      crawlerRestartOrphanedRuns: true,
      browserActionConcurrency: 4,
      batchItemConcurrency: 4,
      batchMaxRequests: 10_000,
      snapshotJobConcurrency: 2,
      mcpInvokeConcurrency: 4,
    });
  });

  it('reads the existing env var names', () => {
    setConfigSource(sourceWith({
      REDTEAM_SCAN_CONCURRENCY: '7',
      BATCH_MAX_REQUESTS: '25',
      MCP_INVOKE_CONCURRENCY: '9',
      CRAWLER_RESTART_ORPHANED_RUNS: 'false',
    }));
    const q = getConfig().queues;
    expect(q.redteamScanConcurrency).toBe(7);
    expect(q.batchMaxRequests).toBe(25);
    expect(q.mcpInvokeConcurrency).toBe(9);
    expect(q.crawlerRestartOrphanedRuns).toBe(false);
  });

  it('falls back to the default for zero and non-numeric values', () => {
    setConfigSource(sourceWith({ RAG_INGEST_CONCURRENCY: '0', BROWSER_ACTION_CONCURRENCY: 'abc' }));
    const q = getConfig().queues;
    expect(q.ragIngestConcurrency).toBe(2);
    expect(q.browserActionConcurrency).toBe(4);
  });
});

describe('config flags moved from direct env reads', () => {
  it('defaults are off / direct', () => {
    setConfigSource(sourceWith({}));
    const cfg = getConfig();
    expect(cfg.database.tenantScopeStrict).toBe(false);
    expect(cfg.iam.validateRequests).toBe(false);
    expect(cfg.evaluation.invoker).toBe('direct');
  });

  it('honours the existing env var names', () => {
    setConfigSource(sourceWith({
      TENANT_SCOPE_STRICT: '1',
      IAM_VALIDATE_REQUESTS: '1',
      EVALUATION_INVOKER: 'gateway',
    }));
    const cfg = getConfig();
    expect(cfg.database.tenantScopeStrict).toBe(true);
    expect(cfg.iam.validateRequests).toBe(true);
    expect(cfg.evaluation.invoker).toBe('gateway');
  });
});
