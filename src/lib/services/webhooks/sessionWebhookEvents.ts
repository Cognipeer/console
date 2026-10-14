/**
 * Which session-log events are also webhook events, and what their (thin) data
 * is. The session event writer calls this once a batch is stored, so every path
 * that writes the log — a turn, a resume, a timeout sweep — publishes the same
 * way without each knowing about webhooks.
 */

import { publishWebhookEvent } from './webhookService';

interface LoggedEvent {
  type: string;
  data: Record<string, unknown>;
}

export interface SessionWebhookScope {
  tenantDbName: string;
  tenantId: string;
  projectId: string;
  agentKey: string;
  conversationId: string;
}

/** The webhook events a stored batch of session events maps to (usually none). */
export function sessionWebhookEvents(
  events: readonly LoggedEvent[],
  scope: Pick<SessionWebhookScope, 'agentKey' | 'conversationId'>,
): Array<{ type: string; data: Record<string, unknown> }> {
  // `sessionId` is the id a client continues the session by (`session_id`); `conversationId` is the same id under its older name.
  const base = { sessionId: scope.conversationId, conversationId: scope.conversationId, agentKey: scope.agentKey };
  const out: Array<{ type: string; data: Record<string, unknown> }> = [];
  for (const event of events) {
    switch (event.type) {
      case 'session.status_idle':
        out.push({ type: 'session.idled', data: { ...base, stopReason: event.data.stopReason ?? null } });
        break;
      case 'session.work_done':
        out.push({ type: 'session.work_done', data: base });
        break;
      case 'action.required':
        out.push({ type: 'action.required', data: { ...base, actionId: event.data.actionId ?? null, kind: event.data.kind ?? null } });
        break;
      case 'budget.reached':
        out.push({
          type: 'budget.reached',
          data: { ...base, spentUsd: event.data.spentUsd ?? null, maxCostUsd: event.data.maxCostUsd ?? null },
        });
        break;
      default:
        break;
    }
  }
  return out;
}

/** Publishes them, in order. Never throws. */
export async function publishSessionWebhooks(events: readonly LoggedEvent[], scope: SessionWebhookScope): Promise<void> {
  for (const event of sessionWebhookEvents(events, scope)) {
    await publishWebhookEvent({
      tenantDbName: scope.tenantDbName,
      tenantId: scope.tenantId,
      projectId: scope.projectId,
      type: event.type,
      data: event.data,
    });
  }
}
