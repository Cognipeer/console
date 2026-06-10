/**
 * Realtime model service — CRUD for named realtime session presets.
 *
 * A realtime model bundles the chat model, optional STT/TTS models + voice,
 * instructions and turn-detection settings under one stable key that clients
 * (and telephony bridges) connect with.
 */

import { createLogger } from '@/lib/core/logger';
import { getDatabase } from '@/lib/database';
import type { IRealtimeModel } from '@/lib/database';
import { getModelByKey } from '@/lib/services/models/modelService';

const logger = createLogger('realtime:models');

export class RealtimeModelValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RealtimeModelValidationError';
  }
}

export interface RealtimeModelContext {
  tenantDbName: string;
  tenantId: string;
  projectId?: string;
  userId?: string;
}

export interface CreateRealtimeModelInput {
  key?: string;
  name: string;
  description?: string;
  chatModelKey: string;
  instructions?: string;
  temperature?: number;
  maxOutputTokens?: number;
  sttModelKey?: string;
  inputAudioFormat?: string;
  ttsModelKey?: string;
  voice?: string;
  ttsFormat?: string;
  turnSilenceMs?: number;
  turnSilenceThreshold?: number;
  greeting?: string;
  metadata?: Record<string, unknown>;
}

export type UpdateRealtimeModelInput = Partial<CreateRealtimeModelInput> & {
  status?: IRealtimeModel['status'];
};

const KEY_PATTERN = /^[a-z0-9][a-z0-9._-]{1,62}$/;

function slugifyKey(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 63) || 'realtime-model';
}

async function validateModelRefs(
  ctx: RealtimeModelContext,
  input: { chatModelKey?: string; sttModelKey?: string; ttsModelKey?: string; voice?: string },
): Promise<void> {
  const projectId = ctx.projectId ?? '';
  if (input.chatModelKey) {
    const model = await getModelByKey(ctx.tenantDbName, input.chatModelKey, projectId);
    if (!model) throw new RealtimeModelValidationError(`Chat model "${input.chatModelKey}" not found`);
    if (model.category !== 'llm') {
      throw new RealtimeModelValidationError(`Model "${input.chatModelKey}" is not an LLM (category: ${model.category})`);
    }
  }
  if (input.sttModelKey) {
    const model = await getModelByKey(ctx.tenantDbName, input.sttModelKey, projectId);
    if (!model) throw new RealtimeModelValidationError(`STT model "${input.sttModelKey}" not found`);
    if (model.category !== 'stt') {
      throw new RealtimeModelValidationError(`Model "${input.sttModelKey}" is not an STT model (category: ${model.category})`);
    }
  }
  if (input.ttsModelKey) {
    const model = await getModelByKey(ctx.tenantDbName, input.ttsModelKey, projectId);
    if (!model) throw new RealtimeModelValidationError(`TTS model "${input.ttsModelKey}" not found`);
    if (model.category !== 'tts') {
      throw new RealtimeModelValidationError(`Model "${input.ttsModelKey}" is not a TTS model (category: ${model.category})`);
    }
    if (!input.voice) {
      throw new RealtimeModelValidationError('`voice` is required when a TTS model is set');
    }
  }
}

export async function createRealtimeModel(
  ctx: RealtimeModelContext,
  input: CreateRealtimeModelInput,
): Promise<IRealtimeModel> {
  if (!input.name?.trim()) throw new RealtimeModelValidationError('`name` is required');
  if (!input.chatModelKey) throw new RealtimeModelValidationError('`chat_model_key` is required');
  await validateModelRefs(ctx, input);

  const db = await getDatabase();
  await db.switchToTenant(ctx.tenantDbName);

  const key = input.key ? input.key.trim().toLowerCase() : slugifyKey(input.name);
  if (!KEY_PATTERN.test(key)) {
    throw new RealtimeModelValidationError(
      '`key` must be 2-63 chars of lowercase letters, digits, dot, dash, or underscore',
    );
  }
  const existing = await db.findRealtimeModelByKey(key, ctx.projectId);
  if (existing) {
    throw new RealtimeModelValidationError(`A realtime model with key "${key}" already exists`);
  }

  const record = await db.createRealtimeModel({
    tenantId: ctx.tenantId,
    projectId: ctx.projectId,
    key,
    name: input.name.trim(),
    description: input.description,
    status: 'active',
    chatModelKey: input.chatModelKey,
    instructions: input.instructions,
    temperature: input.temperature,
    maxOutputTokens: input.maxOutputTokens,
    sttModelKey: input.sttModelKey,
    inputAudioFormat: input.inputAudioFormat,
    ttsModelKey: input.ttsModelKey,
    voice: input.voice,
    ttsFormat: input.ttsFormat,
    turnSilenceMs: input.turnSilenceMs,
    turnSilenceThreshold: input.turnSilenceThreshold,
    greeting: input.greeting,
    metadata: input.metadata,
    createdBy: ctx.userId ?? 'system',
  });
  logger.info('Realtime model created', { key, tenantId: ctx.tenantId });
  return record;
}

export async function updateRealtimeModel(
  ctx: RealtimeModelContext,
  id: string,
  patch: UpdateRealtimeModelInput,
): Promise<IRealtimeModel | null> {
  const db = await getDatabase();
  await db.switchToTenant(ctx.tenantDbName);
  const record = await db.findRealtimeModelById(id);
  if (!record || record.tenantId !== ctx.tenantId) return null;

  await validateModelRefs(ctx, {
    chatModelKey: patch.chatModelKey,
    sttModelKey: patch.sttModelKey,
    ttsModelKey: patch.ttsModelKey,
    voice: patch.voice ?? record.voice,
  });
  if (patch.key !== undefined && patch.key !== record.key) {
    throw new RealtimeModelValidationError('`key` cannot be changed after creation');
  }

  return db.updateRealtimeModel(id, {
    name: patch.name?.trim(),
    description: patch.description,
    status: patch.status,
    chatModelKey: patch.chatModelKey,
    instructions: patch.instructions,
    temperature: patch.temperature,
    maxOutputTokens: patch.maxOutputTokens,
    sttModelKey: patch.sttModelKey,
    inputAudioFormat: patch.inputAudioFormat,
    ttsModelKey: patch.ttsModelKey,
    voice: patch.voice,
    ttsFormat: patch.ttsFormat,
    turnSilenceMs: patch.turnSilenceMs,
    turnSilenceThreshold: patch.turnSilenceThreshold,
    greeting: patch.greeting,
    metadata: patch.metadata,
    updatedBy: ctx.userId,
  });
}

export async function getRealtimeModel(
  ctx: RealtimeModelContext,
  id: string,
): Promise<IRealtimeModel | null> {
  const db = await getDatabase();
  await db.switchToTenant(ctx.tenantDbName);
  const record = await db.findRealtimeModelById(id);
  if (!record || record.tenantId !== ctx.tenantId) return null;
  return record;
}

export async function getRealtimeModelByKey(
  ctx: Pick<RealtimeModelContext, 'tenantDbName' | 'projectId'>,
  key: string,
): Promise<IRealtimeModel | null> {
  const db = await getDatabase();
  await db.switchToTenant(ctx.tenantDbName);
  return db.findRealtimeModelByKey(key, ctx.projectId);
}

export async function listRealtimeModels(
  ctx: RealtimeModelContext,
  filters?: { status?: string; limit?: number },
): Promise<IRealtimeModel[]> {
  const db = await getDatabase();
  await db.switchToTenant(ctx.tenantDbName);
  return db.listRealtimeModels(ctx.tenantId, {
    projectId: ctx.projectId,
    status: filters?.status,
    limit: filters?.limit,
  });
}

export async function deleteRealtimeModel(
  ctx: RealtimeModelContext,
  id: string,
): Promise<boolean> {
  const db = await getDatabase();
  await db.switchToTenant(ctx.tenantDbName);
  const record = await db.findRealtimeModelById(id);
  if (!record || record.tenantId !== ctx.tenantId) return false;
  return db.deleteRealtimeModel(id);
}
