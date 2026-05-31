/**
 * Thin HTTP client wrapping the console's `/api/gpu/agent/:tenantSlug/*`
 * surface. All endpoints share the same:
 *   - tenant-slug URL prefix
 *   - bearer-token auth (set after handshake)
 *   - JSON body convention
 *
 * Built on `undici` because Node's global fetch can't customise per-request
 * timeouts as cleanly as we want for the 25-second long-poll endpoint.
 */

import { request, type Dispatcher } from 'undici';
import { gpuAgentPath } from '@cognipeer/gpu-fleet-protocol';
import type {
  CommandPollResponse,
  EventBatchRequest,
  EventBatchResponse,
  FleetHandshakeRequest,
  FleetHandshakeResponse,
  HandshakeRequest,
  HandshakeResponse,
  HeartbeatRequest,
  HeartbeatResponse,
  InventoryRefreshRequest,
  InventoryRefreshResponse,
} from '@cognipeer/gpu-fleet-protocol';

export interface ApiClientOptions {
  consoleUrl: string;
  tenantSlug: string;
  /** Bearer token set after handshake. Mutable: rotation updates it in place. */
  agentTokenRef: { current: string | null };
}

export class ConsoleApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly body: unknown,
  ) {
    super(message);
    this.name = 'ConsoleApiError';
  }
}

export class ConsoleApiClient {
  constructor(private readonly options: ApiClientOptions) {}

  private url(path: string): string {
    return `${this.options.consoleUrl}${gpuAgentPath(this.options.tenantSlug, path)}`;
  }

  private async send<TResponse>(
    method: Dispatcher.HttpMethod,
    path: string,
    body: unknown,
    options?: { timeoutMs?: number; requireAuth?: boolean },
  ): Promise<TResponse> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json',
      'user-agent': 'cognipeer-gpu-agent/0.1',
    };
    if (options?.requireAuth !== false) {
      const token = this.options.agentTokenRef.current;
      if (!token) throw new Error('Agent token is not set; handshake first');
      headers.authorization = `Bearer ${token}`;
    }

    const response = await request(this.url(path), {
      method,
      headers,
      body: body == null ? undefined : JSON.stringify(body),
      bodyTimeout: options?.timeoutMs ?? 30_000,
      headersTimeout: options?.timeoutMs ?? 30_000,
    });

    const text = await response.body.text();
    let parsed: unknown = null;
    if (text.length > 0) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }

    if (response.statusCode < 200 || response.statusCode >= 300) {
      const message =
        (parsed && typeof parsed === 'object' && 'error' in parsed && typeof (parsed as { error: unknown }).error === 'string')
          ? String((parsed as { error: string }).error)
          : `Request failed: HTTP ${response.statusCode}`;
      throw new ConsoleApiError(response.statusCode, message, parsed);
    }

    return parsed as TResponse;
  }

  handshake(body: HandshakeRequest): Promise<HandshakeResponse> {
    return this.send('POST', '/handshake', body, { requireAuth: false });
  }

  fleetHandshake(body: FleetHandshakeRequest): Promise<FleetHandshakeResponse> {
    return this.send('POST', '/fleet-handshake', body, { requireAuth: false });
  }

  heartbeat(body: HeartbeatRequest): Promise<HeartbeatResponse> {
    return this.send('POST', '/heartbeat', body);
  }

  pushInventory(body: InventoryRefreshRequest): Promise<InventoryRefreshResponse> {
    return this.send('POST', '/inventory', body);
  }

  pollCommands(waitSeconds: number): Promise<CommandPollResponse> {
    // Long-poll: timeout > wait so the server has time to return naturally.
    return this.send(
      'GET',
      `/commands?wait=${encodeURIComponent(String(waitSeconds))}`,
      null,
      { timeoutMs: (waitSeconds + 10) * 1000 },
    );
  }

  pushEvents(body: EventBatchRequest): Promise<EventBatchResponse> {
    return this.send('POST', '/events', body);
  }
}
