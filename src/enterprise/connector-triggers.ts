/**
 * Connector triggers seam — COMMUNITY (open-source) edition.
 *
 * A `connector` agent trigger fires on an event a connector package declares:
 * a vendor webhook or a poll on a schedule. Connector packages, their
 * subscriptions (vendor webhook registration, signing secret, poll cursor),
 * the public intake route and the poller belong to the enterprise Connectors
 * module, which registers a host here. Core keeps the trigger itself (prompt,
 * variables, filters, run settings) and starts the runs: the host hands every
 * event to `dispatchTriggerEvent` (services/agents/agentTriggerEventDispatch.ts).
 *
 * Nothing is registered in the community edition: a connector trigger cannot
 * be created, a stored one is listed as unavailable and never fires.
 *
 * Leaf module on purpose: only types are imported, so the overlay registry can
 * import it at load time without creating a cycle, and it is a separate
 * community file (NOT replaced by the overlay), so the `registry.ts` seam shape
 * and SEAM_CONTRACT_VERSION do not change because of it.
 * Never read a registered value at module scope: resolve it at call time.
 */
import type { AgentTriggerConnector, IAgentTrigger } from '@/lib/database';
import type { ConnectorSubscriptionStatus } from '@/lib/shared/connectorTriggers';

export interface ConnectorTriggerScope {
  tenantId: string;
  tenantDbName: string;
  projectId: string;
  /** Who made the change (`system` for background work). */
  actorId: string;
  locale?: string;
}

export interface ConnectorTriggerFieldError {
  /** `connector.params.<key>`, `connector.events`, `connector.schedule`, `connector.connector_id`, `connector.trigger`. */
  field: string;
  message: string;
}

export type ConnectorTriggerPrepareResult =
  | { ok: true; settings: AgentTriggerConnector }
  | { ok: false; errors: ConnectorTriggerFieldError[] };

/** The subscription behind a connector trigger, for the editor. */
export interface ConnectorTriggerView {
  subscriptionId: string;
  status: ConnectorSubscriptionStatus;
  kind: 'webhook' | 'poll';
  /** Why it is paused, failed or waiting for manual setup (fixed English text, never vendor data). */
  reason?: string | null;
  /**
   * A stable code for `reason` (`no_subscribe`, `subscribe_failed`, `attach_failed` ...), so a screen can say it in
   * the reader's own language. `reason` stays the fixed sentence for API readers. Optional: a host without codes
   * leaves it out and screens show `reason`.
   */
  reasonCode?: string | null;
  /** Webhook: the public URL the vendor posts to. */
  callbackUrl?: string | null;
  /** Webhook: the signing secret's last 4 characters. */
  secretHint?: string | null;
  /** Webhook, manual setup: the whole secret, only in the attach/rotate answer that created it. */
  secret?: string | null;
  /** Webhook, manual setup: until when the secret before the last rotation is still accepted (its grace period); null/absent when none is. */
  previousSecretValidUntil?: Date | null;
  /** Webhook: registered at the vendor by the package. */
  autoRegistered?: boolean;
  schedule?: { cron: string; timezone: string } | null;
  nextPollAt?: Date | null;
  lastEventAt?: Date | null;
  lastPollAt?: Date | null;
  lastError?: string | null;
  /** Manual setup steps (markdown, localized) with the callback URL filled in. */
  setup?: string | null;
  /** Agent triggers bound to the subscription. */
  bindings: number;
}

export interface ConnectorTriggerSample {
  eventType: string;
  data: unknown;
}

export interface ConnectorTriggerHost {
  /**
   * Checks and normalizes the connector settings of a trigger before it is
   * stored: the connector is in the scope's project, its package declares the
   * trigger, params / events / schedule are valid. Fills packageId, kind, label.
   */
  prepare(
    scope: ConnectorTriggerScope,
    input: { settings: unknown; previous?: AgentTriggerConnector | null },
  ): Promise<ConnectorTriggerPrepareResult>;
  /**
   * Called after a connector trigger was stored (created or updated): binds it
   * to its subscription, creating one (and registering the vendor webhook) when
   * none exists. Returns the settings to store (with `subscriptionId`) and the
   * subscription view. Never throws for vendor trouble: the view says `failed`
   * or `manual` instead.
   */
  attach(
    scope: ConnectorTriggerScope,
    trigger: IAgentTrigger,
  ): Promise<{ settings: AgentTriggerConnector; view: ConnectorTriggerView | null }>;
  /**
   * Called before a connector trigger is deleted or changes type: releases its
   * binding, and removes the subscription (and the vendor webhook) when no other
   * trigger uses it. Never throws.
   */
  detach(scope: ConnectorTriggerScope, trigger: IAgentTrigger): Promise<void>;
  /** The subscription's current state, or null when there is none. */
  view(scope: ConnectorTriggerScope, trigger: IAgentTrigger): Promise<ConnectorTriggerView | null>;
  /** A sample event for Run now and the Test tab (the package's declared sample). */
  sample(scope: ConnectorTriggerScope, trigger: IAgentTrigger): Promise<ConnectorTriggerSample | null>;
  /**
   * Webhook: a new signing secret (manual setup keeps the old one for `graceSeconds`; auto setup re-registers). A call the
   * module will not make throws an error with a 4xx `status` and a string `code` (the licence guard's 402 / 403
   * `service_unavailable`): the API answers with that status, message and code. Any other throw is a 502.
   */
  rotate(
    scope: ConnectorTriggerScope,
    trigger: IAgentTrigger,
    options: { graceSeconds: number },
  ): Promise<ConnectorTriggerView | null>;
  /** Tries the vendor registration again, or resumes a paused poll. Refuses like `rotate`. */
  retry(scope: ConnectorTriggerScope, trigger: IAgentTrigger): Promise<ConnectorTriggerView | null>;
}

let host: ConnectorTriggerHost | null = null;

/** The enterprise Connectors module calls this once, when its registry loads. */
export function registerConnectorTriggerHost(next: ConnectorTriggerHost): void {
  host = next;
}

/** The registered host, or null in the community edition. Call at use time. */
export function getConnectorTriggerHost(): ConnectorTriggerHost | null {
  return host;
}

export function __resetConnectorTriggerHostForTests(): void {
  host = null;
}
