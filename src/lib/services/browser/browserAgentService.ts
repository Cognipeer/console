/**
 * BrowserAgentService
 *
 * - CRUD on persisted IBrowserAgent definitions.
 * - `runBrowserAgent`: spins up a session, drives an agent-sdk SmartAgent
 *   with the configured model + browser tools, persists transcript events,
 *   and returns the final response together with the session reference.
 */

import slugify from 'slugify';
import { createSmartAgent, fromLangchainModel } from '@cognipeer/agent-sdk';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { createLogger } from '@/lib/core/logger';
import { getDatabase, type DatabaseProvider } from '@/lib/database';
import { buildModelRuntime } from '@/lib/services/models/runtimeService';
import {
  createBrowserSession as createBrowserSessionRecord,
  captureScreenshot,
} from './browserSessionService';
import { buildBrowserAgentTools } from './agentTools';
import type {
  BrowserAgentRunInput,
  BrowserAgentRunResult,
  BrowserAgentView,
  CreateBrowserAgentInput,
  UpdateBrowserAgentInput,
} from './types';
import type { IBrowserAgent } from '@/lib/database';

const logger = createLogger('browser:agent-service');

async function withTenantDb(tenantDbName: string): Promise<DatabaseProvider> {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);
  return db;
}

function serializeAgent(record: IBrowserAgent): BrowserAgentView {
  const { _id, ...rest } = record;
  return { ...rest, id: typeof _id === 'string' ? _id : _id?.toString() ?? '' };
}

interface AgentCtx {
  tenantDbName: string;
  tenantId: string;
  projectId?: string;
}

const KEY_OPTIONS = { lower: true, strict: true, trim: true };

async function generateUniqueAgentKey(
  db: DatabaseProvider,
  tenantId: string,
  desired: string | undefined,
  projectId?: string,
): Promise<string> {
  const base = slugify(desired && desired.trim().length ? desired : 'browser-agent', KEY_OPTIONS) || 'browser-agent';
  let candidate = base;
  let attempt = 0;
  while (attempt < 50) {
    const existing = await db.findBrowserAgentByKey(tenantId, candidate, projectId);
    if (!existing) return candidate;
    attempt += 1;
    candidate = `${base}-${attempt + 1}`;
  }
  throw new Error('Could not generate unique browser agent key');
}

export async function createBrowserAgent(
  ctx: AgentCtx,
  input: CreateBrowserAgentInput,
): Promise<BrowserAgentView> {
  const db = await withTenantDb(ctx.tenantDbName);
  // Resolve parent Browser to inherit defaults
  const browser = await db.findBrowserById(input.browserId);
  if (!browser || browser.tenantId !== ctx.tenantId) {
    throw new Error(`Browser not found: ${input.browserId}`);
  }
  if (browser.status !== 'active') {
    throw new Error(`Browser ${browser.key} is not active`);
  }
  const modelKey = input.modelKey ?? browser.defaultModelKey;
  if (!modelKey) {
    throw new Error('modelKey is required (no default on parent browser)');
  }
  const browserConfig = { ...(browser.defaultSessionConfig ?? {}), ...(input.browserConfig ?? {}) };
  const artifactBucketKey = input.artifactBucketKey ?? browser.artifactBucketKey;
  const runOptions = { ...(browser.defaultRunOptions ?? {}), ...(input.runOptions ?? {}) };

  const key = await generateUniqueAgentKey(db, ctx.tenantId, input.key ?? input.name, ctx.projectId);
  const created = await db.createBrowserAgent({
    tenantId: ctx.tenantId,
    projectId: ctx.projectId,
    browserId: input.browserId,
    key,
    name: input.name,
    description: input.description,
    modelKey,
    systemPrompt: input.systemPrompt,
    browserConfig,
    artifactBucketKey,
    runOptions,
    status: input.status ?? 'active',
    metadata: input.metadata,
    createdBy: input.createdBy,
  });
  return serializeAgent(created);
}

export async function listBrowserAgents(
  ctx: AgentCtx,
  filters?: { status?: string; browserId?: string; search?: string },
): Promise<BrowserAgentView[]> {
  const db = await withTenantDb(ctx.tenantDbName);
  const records = await db.listBrowserAgents(ctx.tenantId, {
    projectId: ctx.projectId,
    ...filters,
  });
  return records.map(serializeAgent);
}

export async function getBrowserAgent(
  ctx: AgentCtx,
  agentId: string,
): Promise<BrowserAgentView | null> {
  const db = await withTenantDb(ctx.tenantDbName);
  const record = await db.findBrowserAgentById(agentId);
  if (!record || record.tenantId !== ctx.tenantId) return null;
  return serializeAgent(record);
}

export async function updateBrowserAgent(
  ctx: AgentCtx,
  agentId: string,
  data: UpdateBrowserAgentInput,
): Promise<BrowserAgentView | null> {
  const db = await withTenantDb(ctx.tenantDbName);
  const existing = await db.findBrowserAgentById(agentId);
  if (!existing || existing.tenantId !== ctx.tenantId) return null;
  const updated = await db.updateBrowserAgent(agentId, data);
  return updated ? serializeAgent(updated) : null;
}

export async function deleteBrowserAgent(
  ctx: AgentCtx,
  agentId: string,
): Promise<boolean> {
  const db = await withTenantDb(ctx.tenantDbName);
  const existing = await db.findBrowserAgentById(agentId);
  if (!existing || existing.tenantId !== ctx.tenantId) return false;
  return db.deleteBrowserAgent(agentId);
}

// ─────────────────────────────────────────────────────────────────────────
// Run flow
// ─────────────────────────────────────────────────────────────────────────

const DRIVER_TO_PROVIDER_TYPE: Record<string, string> = {
  openai: 'openai',
  anthropic: 'anthropic',
  azure: 'azure',
  'azure-openai': 'azure',
  bedrock: 'bedrock',
  vertex: 'vertex',
  'google-vertex': 'vertex',
  'openai-compatible': 'openai-compatible',
  ollama: 'openai-compatible',
  together: 'openai-compatible',
};

interface BuiltModel {
  model: ReturnType<typeof fromLangchainModel>;
  modelId: string;
}

async function buildAgentModel(
  ctx: AgentCtx,
  modelKey: string,
): Promise<BuiltModel> {
  const db = await withTenantDb(ctx.tenantDbName);
  const modelRecord = await db.findModelByKey(modelKey, ctx.projectId);
  if (!modelRecord) {
    throw new Error(`Model not found for key: ${modelKey}`);
  }
  if (modelRecord.category !== 'llm') {
    throw new Error(`Model ${modelKey} is not an LLM (category=${modelRecord.category}).`);
  }

  const { runtime } = await buildModelRuntime(
    ctx.tenantDbName,
    ctx.tenantId,
    modelRecord.providerKey,
    ctx.projectId,
  );

  if (!runtime.createChatModel) {
    throw new Error(`Provider for model ${modelKey} does not implement chat completions.`);
  }

  const chatModel = (await runtime.createChatModel({
    modelId: modelRecord.modelId,
    category: 'llm',
    modelSettings: modelRecord.settings ?? {},
    options: { streaming: false },
  })) as BaseChatModel;

  const model = fromLangchainModel(chatModel);
  return { model, modelId: modelRecord.modelId };
}

const DEFAULT_SYSTEM_PROMPT = `You are an autonomous browser-automation agent.
You drive a real browser through tools. Operate decisively and complete the task without asking the user follow-up questions.

Behaviour rules:
1. Act first. Do NOT ask the user clarifying questions. If the task is reasonably clear, infer sensible defaults and proceed.
2. Make plausible assumptions when details are missing (search engine, region, locale, sort order, etc.) and state them in the final summary.
3. Only return early with a question if the task is impossible to interpret without additional information that cannot be inferred (e.g. missing credentials, missing target identifier with no candidate). In that case respond with a single concise question and nothing else.
4. After every navigation call \`browser_snapshot\` once to learn the page structure, then prefer aria refs from the snapshot over raw CSS selectors.
5. Take a \`browser_screenshot\` after meaningful milestones so the user gets visual progress.
6. Never invent URLs – only navigate to URLs given by the user or links visible in the current page.
7. Stop as soon as the requested information / action is achieved. Do not keep browsing for extra context the user did not request.
8. When done, reply with a concise plain-text answer that lists what you did, the key facts you found, and any assumptions you made. Use short bullet points if helpful.
9. Call \`browser_close\` only when explicitly instructed to clean up.`;

export async function runBrowserAgent(
  ctx: AgentCtx,
  agentIdOrKey: string,
  input: BrowserAgentRunInput & { createdBy: string },
): Promise<BrowserAgentRunResult> {
  const db = await withTenantDb(ctx.tenantDbName);

  const agentRecord =
    (await db.findBrowserAgentById(agentIdOrKey).catch(() => null)) ??
    (await db.findBrowserAgentByKey(ctx.tenantId, agentIdOrKey, ctx.projectId));

  if (!agentRecord || agentRecord.tenantId !== ctx.tenantId) {
    throw new Error(`Browser agent not found: ${agentIdOrKey}`);
  }
  if (agentRecord.status !== 'active') {
    throw new Error(`Browser agent ${agentRecord.key} is not active`);
  }

  const requestedSessionKey = input.sessionKey?.trim();
  const sessionView = requestedSessionKey
    ? await (async () => {
        const existingSession = await db.findBrowserSessionByKey(ctx.tenantId, requestedSessionKey, ctx.projectId);
        if (!existingSession || existingSession.tenantId !== ctx.tenantId) {
          throw new Error(`Browser session not found: ${requestedSessionKey}`);
        }
        if (existingSession.browserId !== agentRecord.browserId) {
          throw new Error(`Session ${requestedSessionKey} does not belong to browser ${agentRecord.browserId}`);
        }
        if (!['pending', 'idle', 'running'].includes(existingSession.status)) {
          throw new Error(`Session ${requestedSessionKey} is not reusable (status=${existingSession.status})`);
        }

        const sessionId = existingSession._id ? String(existingSession._id) : '';
        await db.updateBrowserSession(sessionId, {
          agentId: String(agentRecord._id ?? ''),
          agentKey: agentRecord.key,
          name: existingSession.name ?? `${agentRecord.name} run`,
          lastActivityAt: new Date(),
        });

        return {
          id: sessionId,
          sessionKey: existingSession.sessionKey,
        };
      })()
    : await createBrowserSessionRecord(ctx, {
        browserId: agentRecord.browserId,
        name: `${agentRecord.name} run`,
        agentId: String(agentRecord._id ?? ''),
        agentKey: agentRecord.key,
        artifactBucketKey: agentRecord.artifactBucketKey,
        config: { ...agentRecord.browserConfig, ...input.sessionConfig },
        metadata: input.metadata,
        createdBy: input.createdBy,
      });

  const sessionKey = sessionView.sessionKey;
  let toolCalls = 0;
  const start = Date.now();

  try {
    const { model } = await buildAgentModel(ctx, agentRecord.modelKey);
    const tools = buildBrowserAgentTools({
      tenantDbName: ctx.tenantDbName,
      tenantId: ctx.tenantId,
      projectId: ctx.projectId,
      sessionKey,
      createdBy: input.createdBy,
      onToolCall: () => {
        toolCalls += 1;
      },
    });

    const agent = createSmartAgent({
      model,
      tools,
      systemPrompt: agentRecord.systemPrompt
        ? `${DEFAULT_SYSTEM_PROMPT}\n\n${agentRecord.systemPrompt}`
        : DEFAULT_SYSTEM_PROMPT,
      runtimeProfile: (agentRecord.runOptions?.runtimeProfile as 'fast' | 'balanced' | 'deep' | 'research' | undefined) ?? 'balanced',
      limits: {
        maxToolCalls: agentRecord.runOptions?.maxSteps ?? 25,
      },
    });

    // Best-effort: take an initial screenshot before the agent starts working.
    await captureScreenshot(ctx, sessionKey, { fullPage: false, createdBy: input.createdBy }).catch(() => undefined);

    const result = await agent.invoke({
      messages: [{ role: 'user', content: input.prompt }],
    });

    const output = extractAgentText(result);

    return {
      sessionKey,
      sessionId: sessionView.id,
      output,
      toolCalls,
      durationMs: Date.now() - start,
      status: 'success',
    };
  } catch (err) {
    logger.error('Browser agent run failed', {
      sessionKey,
      error: err instanceof Error ? err.message : err,
    });
    return {
      sessionKey,
      sessionId: sessionView.id,
      output: '',
      toolCalls,
      durationMs: Date.now() - start,
      status: 'error',
      errorMessage: err instanceof Error ? err.message : String(err),
    };
  } finally {
    // Leave the session open so users can inspect / continue / take more
    // screenshots. The reaper will close it on idle timeout.
  }
}

function extractAgentText(result: unknown): string {
  if (!result || typeof result !== 'object') return String(result ?? '');
  const r = result as Record<string, unknown>;
  if (typeof r.content === 'string') return r.content;
  if (Array.isArray(r.messages) && r.messages.length > 0) {
    const last = r.messages[r.messages.length - 1] as Record<string, unknown>;
    if (typeof last.content === 'string') return last.content;
  }
  if (typeof r.output === 'string') return r.output;
  return JSON.stringify(result);
}
