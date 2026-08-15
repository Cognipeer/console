/**
 * Prescriptions API plugin — automated analysis reports over observed traffic.
 *
 *   GET    /prescriptions                       – list reports (project scope)
 *   POST   /prescriptions                       – enqueue a report → 202
 *   POST   /prescriptions/auto-run              – enqueue for every stale eligible subject → 202
 *   GET    /prescriptions/eligibility           – which subjects have enough data / stale reports
 *   GET    /prescriptions/:id                   – report detail (UI polls this while pending)
 *   DELETE /prescriptions/:id                   – delete a report
 *   PATCH  /prescriptions/:id/findings/:fid     – finding lifecycle (open/applied/dismissed)
 *   POST   /prescriptions/:id/narrative         – LLM narrative over the finished findings
 */

import type { FastifyPluginAsync } from 'fastify';
import { createLogger } from '@/lib/core/logger';
import {
  deletePrescriptionReport,
  generateNarrative,
  getPrescriptionEligibility,
  getPrescriptionReport,
  listPrescriptionReports,
  updateFindingStatus,
  type PrescriptionContext,
} from '@/lib/services/prescriptions/prescriptionService';
import {
  enqueuePrescriptionReport,
  runAutoAnalyses,
} from '@/lib/services/prescriptions/reportJob';
import type { FindingStatus, PrescriptionSubjectKind } from '@/lib/services/prescriptions/types';
import {
  readJsonBody,
  requireProjectContextForRequest,
  sendProjectContextError,
  withApiRequestContext,
} from '../fastify-utils';

const logger = createLogger('api:prescriptions');

const SUBJECT_KINDS: PrescriptionSubjectKind[] = ['agent', 'model', 'workspace'];
const FINDING_STATUSES: FindingStatus[] = ['open', 'applied', 'dismissed'];

function parseSubjectKind(value: unknown): PrescriptionSubjectKind | undefined {
  return SUBJECT_KINDS.includes(value as PrescriptionSubjectKind)
    ? (value as PrescriptionSubjectKind)
    : undefined;
}

export const prescriptionsApiPlugin: FastifyPluginAsync = async (app) => {
  const buildCtx = async (request: Parameters<typeof requireProjectContextForRequest>[0]): Promise<PrescriptionContext> => {
    const { projectId, session } = await requireProjectContextForRequest(request);
    return {
      tenantDbName: session.tenantDbName,
      tenantId: session.tenantId,
      projectId,
      userId: session.userId,
    };
  };

  app.get('/prescriptions', withApiRequestContext(async (request, reply) => {
    try {
      const ctx = await buildCtx(request);
      const query = (request.query ?? {}) as Record<string, string | undefined>;
      const limit = Number.parseInt(query.limit || '50', 10);
      const skip = Number.parseInt(query.skip || '0', 10);
      const result = await listPrescriptionReports(ctx, {
        subjectKind: parseSubjectKind(query.subjectKind),
        subjectName: query.subjectName?.trim() || undefined,
        limit: Number.isFinite(limit) ? limit : 50,
        skip: Number.isFinite(skip) ? skip : 0,
      });
      return reply.code(200).send(result);
    } catch (error) {
      logger.error('List prescription reports error', { error });
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({
          error: error instanceof Error ? error.message : 'Failed to list reports',
        });
    }
  }));

  app.post('/prescriptions', withApiRequestContext(async (request, reply) => {
    try {
      const ctx = await buildCtx(request);
      const body = readJsonBody<{
        subjectKind?: string;
        subjectName?: string;
        windowDays?: number;
      }>(request);
      const subjectKind = parseSubjectKind(body.subjectKind);
      if (!subjectKind) {
        return reply.code(400).send({ error: `subjectKind must be one of: ${SUBJECT_KINDS.join(', ')}` });
      }
      const result = await enqueuePrescriptionReport(ctx, {
        subjectKind,
        subjectName: body.subjectName,
        windowDays: body.windowDays,
      });
      return reply.code(202).send(result);
    } catch (error) {
      logger.error('Enqueue prescription report error', { error });
      return sendProjectContextError(reply, error)
        ?? reply.code(400).send({
          error: error instanceof Error ? error.message : 'Failed to enqueue report',
        });
    }
  }));

  app.post('/prescriptions/auto-run', withApiRequestContext(async (request, reply) => {
    try {
      const ctx = await buildCtx(request);
      const body = readJsonBody<{ windowDays?: number }>(request);
      const result = await runAutoAnalyses(ctx, { windowDays: body.windowDays });
      return reply.code(202).send(result);
    } catch (error) {
      logger.error('Prescription auto-run error', { error });
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({
          error: error instanceof Error ? error.message : 'Auto-run failed',
        });
    }
  }));

  app.get('/prescriptions/eligibility', withApiRequestContext(async (request, reply) => {
    try {
      const ctx = await buildCtx(request);
      const query = (request.query ?? {}) as Record<string, string | undefined>;
      const result = await getPrescriptionEligibility(ctx, {
        windowDays: query.windowDays ? Number(query.windowDays) : undefined,
      });
      return reply.code(200).send(result);
    } catch (error) {
      logger.error('Prescription eligibility error', { error });
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({
          error: error instanceof Error ? error.message : 'Failed to compute eligibility',
        });
    }
  }));

  app.get('/prescriptions/:id', withApiRequestContext(async (request, reply) => {
    try {
      const ctx = await buildCtx(request);
      const { id } = request.params as { id: string };
      const report = await getPrescriptionReport(ctx, id);
      if (!report) return reply.code(404).send({ error: 'Report not found' });
      return reply.code(200).send(report);
    } catch (error) {
      logger.error('Get prescription report error', { error });
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({
          error: error instanceof Error ? error.message : 'Failed to fetch report',
        });
    }
  }));

  app.delete('/prescriptions/:id', withApiRequestContext(async (request, reply) => {
    try {
      const ctx = await buildCtx(request);
      const { id } = request.params as { id: string };
      const deleted = await deletePrescriptionReport(ctx, id);
      if (!deleted) return reply.code(404).send({ error: 'Report not found' });
      return reply.code(200).send({ ok: true });
    } catch (error) {
      logger.error('Delete prescription report error', { error });
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({
          error: error instanceof Error ? error.message : 'Failed to delete report',
        });
    }
  }));

  app.patch('/prescriptions/:id/findings/:findingId', withApiRequestContext(async (request, reply) => {
    try {
      const ctx = await buildCtx(request);
      const { id, findingId } = request.params as { id: string; findingId: string };
      const body = readJsonBody<{ status?: string }>(request);
      if (!FINDING_STATUSES.includes(body.status as FindingStatus)) {
        return reply.code(400).send({ error: `status must be one of: ${FINDING_STATUSES.join(', ')}` });
      }
      const report = await updateFindingStatus(ctx, id, findingId, body.status as FindingStatus);
      if (!report) return reply.code(404).send({ error: 'Report or finding not found' });
      return reply.code(200).send(report);
    } catch (error) {
      logger.error('Update finding status error', { error });
      return sendProjectContextError(reply, error)
        ?? reply.code(400).send({
          error: error instanceof Error ? error.message : 'Failed to update finding',
        });
    }
  }));

  app.post('/prescriptions/:id/narrative', withApiRequestContext(async (request, reply) => {
    try {
      const ctx = await buildCtx(request);
      const { id } = request.params as { id: string };
      const body = readJsonBody<{ modelKey?: string }>(request);
      if (!body.modelKey?.trim()) {
        return reply.code(400).send({ error: 'modelKey is required' });
      }
      const report = await generateNarrative(ctx, id, body.modelKey.trim());
      if (!report) return reply.code(404).send({ error: 'Report not found' });
      return reply.code(200).send(report);
    } catch (error) {
      logger.error('Generate narrative error', { error });
      return sendProjectContextError(reply, error)
        ?? reply.code(400).send({
          error: error instanceof Error ? error.message : 'Failed to generate narrative',
        });
    }
  }));
};
