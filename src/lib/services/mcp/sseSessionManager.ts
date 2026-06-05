/**
 * In-memory MCP SSE session manager.
 *
 * Maps sessionId → session data with an SSE controller reference so the
 * message endpoint can push JSON-RPC responses back through the open stream.
 */

export interface McpSseSession {
  serverKey: string;
  tenantDbName: string;
  tenantId: string;
  projectId: string | undefined;
  tokenId: string | undefined;
  controller: ReadableStreamDefaultController | null;
}

const sessions = new Map<string, McpSseSession>();

/** Encode one SSE frame */
function sseFrame(event: string, data: string): string {
  return `event: ${event}\ndata: ${data}\n\n`;
}

export function createSseSession(sessionId: string, session: McpSseSession) {
  sessions.set(sessionId, session);
}

export function getSseSession(sessionId: string): McpSseSession | undefined {
  return sessions.get(sessionId);
}

export function removeSseSession(sessionId: string) {
  sessions.delete(sessionId);
}

/**
 * Send a JSON-RPC response through the SSE stream identified by sessionId.
 */
export function sendSseResponse(sessionId: string, payload: Record<string, unknown>) {
  const session = sessions.get(sessionId);
  if (!session?.controller) return;
  try {
    const encoder = new TextEncoder();
    session.controller.enqueue(encoder.encode(sseFrame('message', JSON.stringify(payload))));
  } catch {
    // stream already closed – ignore
  }
}

/**
 * Encode an SSE endpoint event (used during stream initialization).
 */
export function encodeSseEndpointEvent(messageEndpoint: string): Uint8Array {
  const encoder = new TextEncoder();
  return encoder.encode(sseFrame('endpoint', messageEndpoint));
}
