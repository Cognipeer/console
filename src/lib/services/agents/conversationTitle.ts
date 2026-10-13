/**
 * A short, readable title for a conversation, written by a model after the first
 * exchange — instead of the first 80 characters of whatever was typed.
 *
 * The call is small and cheap, but it is a model call: it is recorded like any
 * other (a usage row tagged `purpose: 'title'`, debited to the tenant's spend
 * limits and attributed to the person who started the conversation), and it
 * never fails the conversation it names — any problem is "no generated title".
 *
 * A chat surface decides WHETHER to name conversations this way (a stored
 * setting: `off`, the agent's own model, or a chosen model key); this module is
 * the service it calls.
 */

import { createLogger } from '@/lib/core/logger';
import { runWithRequestContext } from '@/lib/core/requestContext';
import type { IAgentConfig } from '@/lib/database';
import { buildAgentChatModel } from './agentService';
import { titleReasoningForModel } from './agentReasoning';
import { isDynamicModel } from './gatewayChatModel';
import { getModelByKey } from '@/lib/services/models/modelService';
import { assertAgentSpendAllowed, agentSpendSettler, resolveAgentSpendScope } from './agentSpendLimits';
import { runWithTenantDb } from './agentRunService';

const logger = createLogger('agents:title');

export const TITLE_MAX_WORDS = 6;
const TITLE_MAX_CHARS = 80;
const EXCHANGE_MAX_CHARS = 700;
const DEFAULT_TIMEOUT_MS = 15_000;

/** The `experience.titles` setting of a surface: no generated titles, the agent's model, or a model key. */
export type TitleSetting = 'off' | 'agent_model' | (string & {});

/** The model key a title setting names for this agent, or null when titles are off (or the agent has no model). */
export function resolveTitleModelKey(setting: TitleSetting | null | undefined, config: Pick<IAgentConfig, 'modelKey' | 'kind'> | undefined): string | null {
    if (!setting || setting === 'off') return null;
    if (setting === 'agent_model') {
        return config && config.kind !== 'external' && config.modelKey ? config.modelKey : null;
    }
    return setting.trim() || null;
}

const SYSTEM_PROMPT = (maxWords: number) => [
    `Write a short title for the conversation below: at most ${maxWords} words.`,
    'Write it in the language the conversation is in.',
    'Reply with the title only — no quotes, no markdown, no trailing punctuation, no explanation.',
].join(' ');

/** Turns a model's reply into a title: first line, no quotes or markdown, at most `maxWords` words. */
export function cleanGeneratedTitle(raw: string, maxWords: number = TITLE_MAX_WORDS): string | null {
    const firstLine = raw.split(/\r?\n/).map((line) => line.trim()).find((line) => line.length > 0) ?? '';
    let title = firstLine
        .replace(/^(title|başlık)\s*[:：-]\s*/i, '')
        .replace(/^[\s"'`“”‘’«»*_#>-]+/, '')
        .replace(/[\s"'`“”‘’«»*_#.!?:;,，。]+$/, '')
        .replace(/\s+/g, ' ');
    if (!title) return null;
    const words = title.split(' ');
    if (words.length > maxWords) title = words.slice(0, maxWords).join(' ');
    // Languages written without spaces: the character cap is what bounds them.
    if (title.length > TITLE_MAX_CHARS) title = `${title.slice(0, TITLE_MAX_CHARS - 1).trimEnd()}…`;
    return title;
}

export interface GenerateTitleInput {
    tenantDbName: string;
    tenantId: string;
    projectId: string;
    /** The model that writes the title (see {@link resolveTitleModelKey}). */
    modelKey: string;
    /** The person the usage is attributed to. */
    userId?: string;
    agentKey?: string;
    /** The first exchange of the conversation. */
    exchange: { user: string; assistant: string };
    maxWords?: number;
    timeoutMs?: number;
}

/**
 * Asks the model for a title. Null when it could not be produced (a model that
 * is gone, a spend limit, a timeout, an empty reply) — the conversation keeps
 * the title it has.
 */
export async function generateConversationTitle(input: GenerateTitleInput): Promise<string | null> {
    const maxWords = input.maxWords ?? TITLE_MAX_WORDS;
    const userText = input.exchange.user.trim().slice(0, EXCHANGE_MAX_CHARS);
    const assistantText = input.exchange.assistant.trim().slice(0, EXCHANGE_MAX_CHARS);
    if (!userText && !assistantText) return null;

    try {
        return await runWithRequestContext(
            {
                tenantId: input.tenantId,
                projectId: input.projectId,
                ...(input.userId ? { userId: input.userId, actorType: 'user' as const } : { actorType: 'system' as const }),
                source: 'dashboard',
            },
            async () => {
                const spend = await resolveAgentSpendScope({
                    tenantDbName: input.tenantDbName,
                    tenantId: input.tenantId,
                    projectId: input.projectId,
                    userId: input.userId,
                });
                await assertAgentSpendAllowed(spend, input.modelKey);

                // Thinking would eat the 40-token budget and the agent's own pick is for answers, so a model
                // that reasons is told not to (forced above every other rung); one that does not is left alone.
                const record = await getModelByKey(input.tenantDbName, input.modelKey, input.projectId);
                const titleThinking = record ? titleReasoningForModel(record, { dynamic: isDynamicModel(record) }) : undefined;
                const { chatModel } = await buildAgentChatModel(input.tenantDbName, input.tenantId, input.projectId, input.modelKey, {
                    // A title is a few words: no room for a long answer, and nothing creative about it.
                    max_tokens: 40,
                    temperature: 0.2,
                }, titleThinking, undefined, {
                    route: 'agent.title',
                    purpose: 'title',
                    ...(input.agentKey ? { agentKey: input.agentKey } : {}),
                    ...(input.userId ? { userId: input.userId } : {}),
                    onCost: agentSpendSettler(spend, input.modelKey),
                });
                const tapped = chatModel as { invoke: (messages: unknown, options?: { signal?: AbortSignal }) => Promise<unknown> };
                // A title that is late is dropped, and its request with it.
                const abort = new AbortController();

                let timer: ReturnType<typeof setTimeout> | undefined;
                const timeout = new Promise<never>((_, reject) => {
                    timer = setTimeout(() => {
                        abort.abort();
                        reject(new Error('title generation timed out'));
                    }, input.timeoutMs ?? DEFAULT_TIMEOUT_MS);
                    timer.unref?.();
                });
                try {
                    const reply = await Promise.race([
                        tapped.invoke([
                            { role: 'system', content: SYSTEM_PROMPT(maxWords) },
                            { role: 'user', content: `User: ${userText}\n\nAssistant: ${assistantText}` },
                        ], { signal: abort.signal }),
                        timeout,
                    ]);
                    return cleanGeneratedTitle(replyText(reply), maxWords);
                } finally {
                    if (timer) clearTimeout(timer);
                }
            },
        );
    } catch (error) {
        logger.info('No generated title', {
            modelKey: input.modelKey,
            reason: error instanceof Error ? error.message : String(error),
        });
        return null;
    }
}

/** The text of a chat model's reply (a string, or content parts). */
function replyText(reply: unknown): string {
    const content = (reply as { content?: unknown } | null)?.content ?? reply;
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
        return content
            .map((part) => (typeof part === 'string' ? part : typeof (part as { text?: unknown })?.text === 'string' ? (part as { text: string }).text : ''))
            .join('');
    }
    return '';
}

// ── Naming a stored conversation ──────────────────────────────────────

/** `conversation.metadata.titleSource`: who last chose the title. */
export type TitleSource = 'generated' | 'user';

export interface NameConversationInput extends Omit<GenerateTitleInput, 'exchange' | 'agentKey'> {
    conversationId: string;
}

/**
 * Names a conversation after its first exchange, once. Does nothing when the
 * conversation is not at its first exchange, or when a person already chose its
 * title (`metadata.titleSource: 'user'`) or a title was generated before. The
 * title the first message produced by default (its first characters) counts as
 * "not chosen by anyone" and is replaced.
 *
 * Returns the new title, or null when nothing changed.
 */
export async function generateAndStoreConversationTitle(input: NameConversationInput): Promise<string | null> {
    const conversation = await runWithTenantDb(input.tenantDbName, (db) => db.findAgentConversationById(input.conversationId).catch(() => null));
    if (!conversation || conversation.projectId !== input.projectId) return null;
    const source = conversation.metadata?.titleSource;
    if (source === 'user' || source === 'generated') return null;
    const messages = conversation.messages ?? [];
    const firstUser = messages.find((message) => message.role === 'user');
    const firstAnswer = messages.find((message) => message.role === 'assistant' && message.content.trim() !== '');
    if (!firstUser || !firstAnswer) return null;
    // Only the first exchange is named: a conversation that has moved on keeps the title it has.
    if (messages.filter((message) => message.role === 'user').length > 1) return null;
    // A title somebody typed (renamed by hand without the marker) is not the default one.
    const defaultTitle = firstUser.content.substring(0, 80);
    const title = conversation.title?.trim();
    if (title && title !== 'New conversation' && title !== defaultTitle) return null;

    const generated = await generateConversationTitle({
        tenantDbName: input.tenantDbName,
        tenantId: input.tenantId,
        projectId: input.projectId,
        modelKey: input.modelKey,
        agentKey: conversation.agentKey,
        ...(input.userId ? { userId: input.userId } : {}),
        exchange: { user: firstUser.content, assistant: firstAnswer.content },
        ...(input.maxWords ? { maxWords: input.maxWords } : {}),
        ...(input.timeoutMs ? { timeoutMs: input.timeoutMs } : {}),
    });
    if (!generated) return null;

    // Re-read: a person may have renamed it while the model was thinking.
    return runWithTenantDb(input.tenantDbName, async (db) => {
        const latest = await db.findAgentConversationById(input.conversationId).catch(() => null);
        if (!latest || latest.metadata?.titleSource === 'user') return null;
        await db.updateAgentConversation(input.conversationId, {
            title: generated,
            metadata: { ...(latest.metadata ?? {}), titleSource: 'generated' satisfies TitleSource },
        });
        return generated;
    });
}
