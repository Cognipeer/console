/**
 * External Eval-Import API plugin — turn LLM logs exported from other stacks
 * (OpenAI / gateways / Bedrock / Langfuse) into an evaluation dataset,
 * behind the mandatory anonymization gate.
 *
 *   POST /dataset-import/detect – sniff the export format + parse preview
 *                                 (first 5 items, RAW — never persisted)
 *   POST /dataset-import/fetch  – SSRF-guarded server-side fetch of an export
 *                                 URL (text only, 10 MB cap)
 *   POST /dataset-import        – parse + anonymize + create the dataset
 *                                 (refuses without `anonymize`)
 *
 * The pseudonym salt is accepted from the caller (deterministic tokens across
 * multiple imports) or generated per request when absent; it is never
 * persisted and never echoed back.
 *
 * Imported data is for evaluation ONLY — this surface never writes
 * usage_daily / cost rows; measured costs come later from eval replay.
 *
 * NOTE: registration in plugin.ts is done by the integration orchestrator —
 * see .integration-handoff/dataset-import-core.md.
 */

import { randomBytes } from 'node:crypto';
import type { FastifyPluginAsync } from 'fastify';
import { createLogger } from '@/lib/core/logger';
import type { IPiiCustomPattern } from '@/lib/database';
import {
  ImportTooLargeError,
  MAX_IMPORT_BYTES,
  createImportedDataset,
  detectImportFormat,
  parseImportItems,
} from '@/lib/services/datasetImport/datasetImport';
import { IMPORT_FORMATS, type ImportFormat } from '@/lib/services/datasetImport/types';
import { safeFetch } from '@/lib/security/outboundFetch';
import {
  readJsonBody,
  requireProjectContextForRequest,
  sendProjectContextError,
  withApiRequestContext,
} from '../fastify-utils';

const logger = createLogger('api:dataset-import');

/** Preview rows returned by /detect (raw parse output, never persisted). */
const PREVIEW_ITEMS = 5;

interface DatasetImportRequestBody {
  content?: string;
  url?: string;
  format?: string;
  name?: string;
  sourceLabel?: string;
  anonymize?: {
    categories?: string[];
    strategy?: string;
    salt?: string;
    customPatterns?: IPiiCustomPattern[];
  };
}

function parseFormat(value: unknown): ImportFormat | undefined {
  return IMPORT_FORMATS.includes(value as ImportFormat) ? (value as ImportFormat) : undefined;
}

export const datasetImportApiPlugin: FastifyPluginAsync = async (app) => {
  app.post('/dataset-import/detect', withApiRequestContext(async (request, reply) => {
    try {
      await requireProjectContextForRequest(request);
      const body = readJsonBody<DatasetImportRequestBody>(request);
      if (typeof body.content !== 'string' || body.content.trim().length === 0) {
        return reply.code(400).send({ error: '`content` is required' });
      }

      const format = detectImportFormat(body.content);
      if (!format) {
        return reply.code(200).send({
          preview: { items: [], counts: { parsed: 0, skipped: {} } },
        });
      }

      // Preview is the raw parse output — NOT anonymized, and never persisted.
      const { items, skipped } = parseImportItems(body.content, format);
      return reply.code(200).send({
        format,
        preview: {
          items: items.slice(0, PREVIEW_ITEMS).map((item) => ({
            input: item.input,
            ...(item.tools ? { tools: item.tools } : {}),
            ...(item.expected ? { expected: item.expected } : {}),
          })),
          counts: { parsed: items.length, skipped },
        },
      });
    } catch (error) {
      if (error instanceof ImportTooLargeError) {
        return reply.code(413).send({ error: error.message });
      }
      logger.error('Dataset import detect error', { error });
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({ error: error instanceof Error ? error.message : 'Internal error' });
    }
  }));

  app.post('/dataset-import/fetch', withApiRequestContext(async (request, reply) => {
    try {
      await requireProjectContextForRequest(request);
      const body = readJsonBody<DatasetImportRequestBody>(request);
      const url = typeof body.url === 'string' ? body.url.trim() : '';
      if (!url) {
        return reply.code(400).send({ error: '`url` is required' });
      }

      let response: Response;
      try {
        response = await safeFetch(url, {
          method: 'GET',
          headers: { Accept: 'application/json, application/x-ndjson, text/plain, */*' },
        });
      } catch (err) {
        return reply.code(400).send({
          error: `Could not fetch export: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
      if (!response.ok) {
        return reply.code(400).send({ error: `Remote server responded with ${response.status}` });
      }

      const content = await response.text();
      if (Buffer.byteLength(content, 'utf8') > MAX_IMPORT_BYTES) {
        return reply.code(413).send({ error: 'Export exceeds the 10 MB limit' });
      }
      return reply.code(200).send({ content });
    } catch (error) {
      logger.error('Dataset import fetch error', { error });
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({ error: error instanceof Error ? error.message : 'Internal error' });
    }
  }));

  app.post('/dataset-import', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const body = readJsonBody<DatasetImportRequestBody>(request);

      if (typeof body.content !== 'string' || body.content.trim().length === 0) {
        return reply.code(400).send({ error: '`content` is required' });
      }
      const format = parseFormat(body.format);
      if (!format) {
        return reply.code(400).send({ error: `\`format\` must be one of: ${IMPORT_FORMATS.join(', ')}` });
      }
      if (typeof body.name !== 'string' || !body.name.trim()) {
        return reply.code(400).send({ error: '`name` is required' });
      }
      if (!body.anonymize || typeof body.anonymize !== 'object') {
        return reply.code(400).send({ error: '`anonymize` is required — imports must pass the anonymization gate' });
      }
      const strategy = body.anonymize.strategy;
      if (strategy !== 'mask' && strategy !== 'pseudonym') {
        return reply.code(400).send({ error: '`anonymize.strategy` must be "mask" or "pseudonym"' });
      }

      const result = await createImportedDataset(
        { tenantDbName: session.tenantDbName, tenantId: session.tenantId, projectId, userId: session.userId },
        {
          name: body.name.trim(),
          content: body.content,
          format,
          sourceLabel: typeof body.sourceLabel === 'string' && body.sourceLabel.trim()
            ? body.sourceLabel.trim()
            : undefined,
          anonymize: {
            categories: Array.isArray(body.anonymize.categories) ? body.anonymize.categories : [],
            strategy,
            // Caller-supplied salt keeps pseudonyms stable across imports;
            // otherwise a fresh per-request salt (never persisted/echoed).
            salt: typeof body.anonymize.salt === 'string' && body.anonymize.salt.length > 0
              ? body.anonymize.salt
              : randomBytes(16).toString('hex'),
            customPatterns: Array.isArray(body.anonymize.customPatterns)
              ? body.anonymize.customPatterns
              : undefined,
          },
        },
      );
      return reply.code(201).send({
        datasetId: result.datasetId,
        created: result.created,
        skipped: result.skipped,
        piiFindings: result.piiFindings,
      });
    } catch (error) {
      if (error instanceof ImportTooLargeError) {
        return reply.code(413).send({ error: error.message });
      }
      if (error instanceof Error && /required|must/.test(error.message)) {
        return reply.code(400).send({ error: error.message });
      }
      logger.error('Dataset import create error', { error });
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({ error: error instanceof Error ? error.message : 'Internal error' });
    }
  }));
};
