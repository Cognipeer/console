/**
 * HTTP/WS client for the console sandbox agent API.
 */

import WebSocket from 'ws';
import type { SandboxCommand, SandboxEvent } from '@cognipeer/sandbox-protocol';
import type { AgentConfig } from '../config';

export interface HandshakeResult {
  runnerId: string;
  agentToken: string;
  heartbeatIntervalSeconds: number;
  commandPollWaitSeconds: number;
}

export class ConsoleClient {
  private agentToken: string | null = null;

  constructor(private readonly cfg: AgentConfig) {}

  setAgentToken(token: string): void {
    this.agentToken = token;
  }

  private base(): string {
    return `${this.cfg.consoleUrl}/api/sandbox/agent/${encodeURIComponent(this.cfg.tenantSlug)}`;
  }

  private authHeaders(): Record<string, string> {
    return this.agentToken
      ? { authorization: `Bearer ${this.agentToken}`, 'content-type': 'application/json' }
      : { 'content-type': 'application/json' };
  }

  async handshake(registrationToken: string, inventory: Record<string, unknown>): Promise<HandshakeResult> {
    const res = await fetch(`${this.base()}/handshake`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ registrationToken, inventory }),
    });
    if (!res.ok) throw new Error(`handshake failed: ${res.status}`);
    return (await res.json()) as HandshakeResult;
  }

  async heartbeat(inventory?: Record<string, unknown>): Promise<void> {
    await fetch(`${this.base()}/heartbeat`, {
      method: 'POST',
      headers: this.authHeaders(),
      body: JSON.stringify({ inventory }),
    });
  }

  async pollCommands(waitSeconds: number): Promise<SandboxCommand[]> {
    const res = await fetch(`${this.base()}/commands?wait=${waitSeconds}`, {
      method: 'GET',
      headers: this.authHeaders(),
    });
    if (!res.ok) throw new Error(`poll failed: ${res.status}`);
    const body = (await res.json()) as { commands: SandboxCommand[] };
    return body.commands ?? [];
  }

  async postEvents(events: SandboxEvent[]): Promise<void> {
    if (events.length === 0) return;
    await fetch(`${this.base()}/events`, {
      method: 'POST',
      headers: this.authHeaders(),
      body: JSON.stringify({ events }),
    });
  }

  openTerminalSocket(sessionId: string): WebSocket {
    const url = `${this.base().replace(/^http/, 'ws')}/terminal/${encodeURIComponent(sessionId)}/agent`;
    return new WebSocket(url, { headers: { authorization: `Bearer ${this.agentToken}` } });
  }
}
