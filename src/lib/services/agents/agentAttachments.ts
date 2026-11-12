/**
 * The attachments of one agent turn: resolved from the request, assembled for the model,
 * those of earlier turns, and the output files a turn produced.
 */

import { type IAgentConversation, type IAgentConfig, type IFileRecord, getDatabase, type IAgentMessageAttachment } from '@/lib/database';
import type { AgentRuntimeContext } from '@/lib/services/runtimeContext';
import {
    attachmentsAvailability,
    attachmentsUnavailableMessage,
    resolveTurnAttachments,
    findUnsentSessionFiles,
    type AssembledAttachments,
    NO_ATTACHMENTS,
    assembleTurnAttachments,
    resolveAttachmentsConfig,
    agentTakesAttachments,
} from './sessionFiles';
import { AgentAttachmentError } from './agentErrors';
import { resolveModelCapabilities } from '@/lib/services/models/modelCapabilities';
import { buildTurnInputState } from './agentTurnState';
import { resolveAgentRuntimeOptions } from './agentRuntimeConfig';
import { toClientOutputFiles, outputFileEventData } from './clientWire';
import { createLogger } from '@/lib/core/logger';

const logger = createLogger('agents');

/**
 * The runtime context a turn runs with: the session's own (`metadata.runtimeContext`,
 * entered once when the session was started) UNDER the caller's, so a
 * per-message value still wins. Headers and metadata merge key by key.
 */
export function mergeSessionRuntimeContext(
    conversation: Pick<IAgentConversation, 'metadata'> | null | undefined,
    requestContext: AgentRuntimeContext | undefined,
): AgentRuntimeContext | undefined {
    const sessionContext = conversation?.metadata?.runtimeContext as AgentRuntimeContext | undefined;
    if (!sessionContext) return requestContext;
    return {
        ...sessionContext,
        ...requestContext,
        headers: { ...sessionContext.headers, ...requestContext?.headers },
        metadata: { ...sessionContext.metadata, ...requestContext?.metadata },
    };
}

/**
 * The files a message attaches, checked against the session BEFORE anything
 * runs (a refusal must not mark the session running or leave tools open).
 * Throws `AgentAttachmentError`; empty when the message attaches nothing.
 *
 * That is the files it names, plus — when the agent's `attachNewUploads` is on
 * (the default) — the files uploaded to the session that no message has carried
 * yet. Every channel that starts a turn gets that here, so "create a session,
 * upload, ask" works the same from the dashboard, the Responses API, a
 * background run or a portal.
 */
export async function resolveMessageAttachments(input: {
    tenantDbName: string;
    tenantId: string;
    projectId: string;
    conversation: IAgentConversation | null;
    config: IAgentConfig;
    fileIds: string[] | undefined;
}): Promise<IFileRecord[]> {
    const named = input.fileIds ?? [];
    const availability = attachmentsAvailability(input.config);
    if (named.length > 0) {
        if (!input.conversation) {
            throw new AgentAttachmentError(400, 'attachment_not_found', 'Attachments belong to a session; start one and upload the files to it first.');
        }
        if (!availability.available) {
            throw new AgentAttachmentError(403, 'attachments_disabled', attachmentsUnavailableMessage(availability.reason));
        }
    }
    const scope = { tenantDbName: input.tenantDbName, tenantId: input.tenantId, projectId: input.projectId };
    const records = input.conversation && named.length > 0
        ? await resolveTurnAttachments(scope, String(input.conversation._id), named)
        : [];

    if (input.conversation && availability.available && availability.cfg.attachNewUploads) {
        const carried = new Set(records.map((record) => String(record._id)));
        for (const record of await findUnsentSessionFiles(scope, input.conversation)) {
            if (!carried.has(String(record._id))) records.push(record);
        }
    }
    return records;
}

/**
 * The attached files made ready for the model — in the turn, or readable with
 * the session file tools, images as parts when the model takes them. Never
 * fails the turn: what could not be read is a warning.
 */
export async function assembleMessageAttachments(input: {
    tenantDbName: string;
    tenantId: string;
    projectId: string;
    records: IFileRecord[];
    config: IAgentConfig;
    model: Parameters<typeof resolveModelCapabilities>[0];
    warnings: Set<string>;
}): Promise<AssembledAttachments> {
    if (input.records.length === 0) return NO_ATTACHMENTS;
    const assembled = await assembleTurnAttachments({
        scope: { tenantDbName: input.tenantDbName, tenantId: input.tenantId, projectId: input.projectId },
        records: input.records,
        cfg: resolveAttachmentsConfig(input.config.attachments),
        supportsVision: resolveModelCapabilities(input.model).inputModalities.includes('image'),
    });
    for (const warning of assembled.warnings) input.warnings.add(warning);
    return assembled;
}

/**
 * How the files of EARLIER messages reach the model again (`buildTurnInputState`):
 * a transcript replay rebuilds each message with its attachments, and the last
 * `attachments.carryRecentImages` messages with images are shown again when the
 * agent's own context no longer holds them. Absent for a stateless call, which
 * has no session and so no files.
 */
export async function earlierAttachments(input: {
    db: Awaited<ReturnType<typeof getDatabase>>;
    conversation: IAgentConversation | null;
    config: IAgentConfig;
    model: Parameters<typeof resolveModelCapabilities>[0];
}): Promise<NonNullable<Parameters<typeof buildTurnInputState>[0]['attachments']> | undefined> {
    if (!input.conversation) return undefined;
    const cfg = resolveAttachmentsConfig(input.config.attachments);
    const supportsVision = resolveModelCapabilities(input.model).inputModalities.includes('image');
    const carryRecentImages = supportsVision && agentTakesAttachments(input.config) ? cfg.carryRecentImages : 0;
    let availableFileIds: Set<string> | undefined;
    if (carryRecentImages > 0 && input.conversation.messages?.some((message) => message.attachments?.length)) {
        try {
            const records = await input.db.listFileRecordsByConversation(String(input.conversation._id));
            availableFileIds = new Set(records.map((record) => String(record._id)));
        } catch (error) {
            logger.debug('Could not list the session files to carry images from', { error: error instanceof Error ? error.message : String(error) });
        }
    }
    // The window the SDK builds each request from: a picture counts as still seen only inside it.
    const { policy, lastTurnsToKeep } = resolveAgentRuntimeOptions(input.config).context ?? {};
    const window = policy && lastTurnsToKeep ? { policy, lastTurnsToKeep } : undefined;
    return { supportsVision, carryRecentImages, ...(availableFileIds ? { availableFileIds } : {}), ...(window ? { window } : {}) };
}

/**
 * The OpenAI Responses–shaped reply to one exchange. `outcome` is absent for a
 * connected agent, which reports no stop reason at all.
 */
/** `agent.output_file` event payloads of a turn's output attachments. */
export function outputFileEvents(conversationId: string, attachments: ReadonlyArray<IAgentMessageAttachment>): Array<Record<string, unknown>> {
    return toClientOutputFiles(conversationId, attachments).map(outputFileEventData);
}
