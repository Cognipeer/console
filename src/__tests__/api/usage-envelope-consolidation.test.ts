/**
 * Usage-envelope consolidation guard.
 *
 * Usage accounting is consolidated on `recordUsageEvent` in
 * lib/services/usage/usageEvents.ts: it resolves the attribution envelope
 * (userId/apiTokenId/actorType) from the request context and feeds the
 * cross-service `usage_daily` rollup. Every service writer must go through
 * it; route plugins must never write raw usage logs themselves.
 *
 * If this test fails on your new code: call `recordUsageEvent(...)` in the
 * service-layer writer and stamp the returned attribution onto the raw log
 * row — do not call the DB `create*Log` methods from a plugin.
 */

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const SRC = path.resolve(__dirname, '../..');

/** Service-layer writers that MUST reference recordUsageEvent. */
const ENVELOPE_WRITERS = [
  'lib/services/models/usageLogger.ts',
  'lib/services/guardrail/guardrailService.ts',
  'lib/services/webSearch/webSearchService.ts',
  'lib/services/mcp/mcpService.ts',
  'lib/services/tools/toolService.ts',
  'lib/services/rag/ragService.ts',
  'lib/services/reranker/rerankerService.ts',
  'lib/services/browser/browserSessionService.ts',
  'lib/services/batch/batchRunner.ts',
  'lib/services/ocrJobs/ocrJobRunner.ts',
  'lib/services/agentTracing.ts',
];

/**
 * Raw usage-log create methods that only the service layer may call.
 * (Plugins call the service writers instead.)
 */
const RAW_LOG_CREATORS = [
  'createModelUsageLog',
  'createGuardrailEvaluationLog',
  'createWebSearchRunLog',
  'createMcpRequestLog',
  'createToolRequestLog',
  'createRagQueryLog',
  'createRerankerRunLog',
  'createBrowserSessionEvent',
  'incrementUsageDaily',
];

function listFilesRecursive(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFilesRecursive(full));
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

describe('usage envelope consolidation', () => {
  it('every service usage writer goes through recordUsageEvent', () => {
    const missing: string[] = [];
    for (const rel of ENVELOPE_WRITERS) {
      const content = readFileSync(path.join(SRC, rel), 'utf8');
      if (
        !content.includes('recordUsageEvent') &&
        !content.includes('resolveUsageAttribution')
      ) {
        missing.push(rel);
      }
    }
    expect(missing, `writers not using the usage envelope: ${missing.join(', ')}`).toEqual([]);
  });

  it('crawler service stamps attribution and emits the rollup event', () => {
    // Crawler splits creation (attribution stamp) and completion (rollup
    // event) across two files; require the envelope in at least one each.
    const create = readFileSync(
      path.join(SRC, 'lib/services/crawler/crawlerService.ts'),
      'utf8',
    );
    const finalize = readFileSync(
      path.join(SRC, 'lib/services/crawler/crawlerJobService.ts'),
      'utf8',
    );
    expect(
      create.includes('resolveUsageAttribution') || create.includes('recordUsageEvent'),
    ).toBe(true);
    expect(finalize.includes('recordUsageEvent')).toBe(true);
  });

  it('route plugins never call raw usage-log creators directly', () => {
    const pluginDir = path.join(SRC, 'server/api/plugins');
    const offenders: string[] = [];
    for (const file of listFilesRecursive(pluginDir)) {
      const content = readFileSync(file, 'utf8');
      for (const method of RAW_LOG_CREATORS) {
        // Match ".createXxx(" so type imports / comments don't trip it.
        if (new RegExp(`\\.${method}\\s*\\(`).test(content)) {
          offenders.push(`${path.relative(SRC, file)} → ${method}`);
        }
      }
    }
    expect(
      offenders,
      `plugins must call the service writer, not the raw log creator: ${offenders.join(', ')}`,
    ).toEqual([]);
  });

  it('the shared attribution envelope keeps its contract fields', () => {
    const types = readFileSync(
      path.join(SRC, 'lib/database/provider/types.base.ts'),
      'utf8',
    );
    expect(types).toContain('interface IUsageAttributionFields');
    for (const field of ['userId?', 'apiTokenId?', 'actorType?']) {
      expect(types.includes(field), `IUsageAttributionFields lost ${field}`).toBe(true);
    }
    // No `source` on raw logs by design — origin is derivable from actorType
    // and several logs carry their own service-specific `source` column.
    const envelope = types.slice(
      types.indexOf('interface IUsageAttributionFields'),
      types.indexOf('interface IModelUsageCostSnapshot'),
    );
    expect(envelope.includes('source?')).toBe(false);
  });
});
