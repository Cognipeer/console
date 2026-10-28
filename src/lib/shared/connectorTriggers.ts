/**
 * Connector triggers — the wire shapes the trigger editor and the enterprise
 * Connectors module share (catalog, subscription state, form value). Used by
 * the agent trigger routes, the community trigger editor and the enterprise
 * picker that replaces `src/components/enterprise/EnterpriseConnectorTriggerUi.tsx`.
 * Dependency-free: types, one reason code and the pure conversion of the module's subscription view to the wire,
 * so client and server code (and tests of a screen) can import it.
 */
import type { ConnectorTriggerView } from '@/enterprise/connector-triggers';

/** One parameter field of a package trigger, as the Connectors module renders settings (`FieldView`). */
export interface ConnectorTriggerParamField {
  kind: string;
  label: string;
  help?: string;
  placeholder?: string;
  required?: boolean;
  default?: unknown;
  options?: Array<{ value: string; label: string }>;
  optionsFrom?: string;
  dependsOn?: string[];
  /** Any other renderer hints the Connectors module adds; passed through untouched. */
  [hint: string]: unknown;
}

export interface ConnectorTriggerCatalogEvent {
  type: string;
  title: string;
}

export interface ConnectorTriggerCatalogTrigger {
  name: string;
  title: string;
  description: string;
  kind: 'webhook' | 'poll';
  events: ConnectorTriggerCatalogEvent[];
  params: Record<string, ConnectorTriggerParamField>;
  /** The package can register the webhook at the vendor itself. */
  autoSubscribe: boolean;
  requires?: { scopes?: string[]; help?: string };
  /** Poll triggers: the package's default cron and the smallest interval it allows. */
  schedule?: { default: string; minIntervalMin: number };
  sample?: { type: string; data: unknown };
}

export interface ConnectorTriggerCatalogConnector {
  id: string;
  key: string;
  name: string;
  packageId: string;
  packageName: string;
  iconUrl?: string;
  status: 'active' | 'disabled';
  accountStatus: 'active' | 'needs_reauth' | 'revoked' | 'none';
  triggers: ConnectorTriggerCatalogTrigger[];
}

export interface ConnectorTriggerCatalog {
  connectors: ConnectorTriggerCatalogConnector[];
}

/** The connector part of the trigger editor's form. */
export interface ConnectorTriggerFormValue {
  connectorId: string;
  trigger: string;
  params: Record<string, unknown>;
  events: string[];
  /** Poll triggers only. */
  scheduleCron: string;
  scheduleTimezone: string;
}

export type ConnectorSubscriptionStatus = 'active' | 'pending' | 'manual' | 'paused' | 'failed';

/**
 * The reason code core itself gives a subscription: the trigger was stored, but the Connectors module could not be
 * reached to bind it. (The module has its own codes, `no_subscribe`, `subscribe_failed` ...; a screen names them all.)
 */
export const ATTACH_FAILED_REASON_CODE = 'attach_failed';

/**
 * What the trigger editor keeps of the answer that showed a secret, while it stays open. The module shows the signing
 * secret of a manually set up webhook once, in the answer that created or rotated it; the editor's tabs unmount the
 * status card, so the card hands this to the editor and gets it back. Tied to the subscription it was shown for.
 */
export interface ConnectorSecretReveal {
  subscriptionId: string;
  /** The whole secret, or null when the answer carried none (a rotation of an automatically registered hook). */
  secret: string | null;
  /** Epoch seconds until which the secret before it is still accepted; null when it stopped at once. */
  previousValidUntil: number | null;
}

/** `connector_subscription` on a trigger response (snake_case wire). */
export interface ConnectorSubscriptionWire {
  subscription_id: string;
  status: ConnectorSubscriptionStatus;
  kind: 'webhook' | 'poll';
  /** Why it is paused, failed or waiting for manual setup: a fixed English sentence. */
  reason?: string | null;
  /** A stable code for `reason` (`no_subscribe`, `subscribe_failed`, `attach_failed` ...); screens say it in the reader's language. */
  reason_code?: string | null;
  callback_url?: string | null;
  secret_hint?: string | null;
  /** Present once: in the response that created or rotated the secret of a manual-mode webhook. */
  secret?: string | null;
  /** Epoch seconds until which the secret before the last rotation is still accepted (its grace period); null when none is. */
  previous_secret_valid_until?: number | null;
  auto_registered?: boolean;
  schedule?: { cron: string; timezone: string } | null;
  next_poll_at?: number | null;
  last_event_at?: number | null;
  last_poll_at?: number | null;
  last_error?: string | null;
  /** Manual setup steps (markdown) with the callback URL filled in. */
  setup?: string | null;
  bindings: number;
}

const toEpochSeconds = (value: Date | string | null | undefined) => (value ? Math.floor(new Date(value).getTime() / 1000) : null);

/** The subscription view as `connector_subscription` on a trigger answer (snake_case, dates in epoch seconds). */
export function toSubscriptionWire(view: ConnectorTriggerView | null | undefined): ConnectorSubscriptionWire | null {
  if (!view) return null;
  return {
    subscription_id: view.subscriptionId,
    status: view.status,
    kind: view.kind,
    reason: view.reason ?? null,
    reason_code: view.reasonCode ?? null,
    callback_url: view.callbackUrl ?? null,
    secret_hint: view.secretHint ?? null,
    ...(view.secret ? { secret: view.secret } : {}),
    previous_secret_valid_until: toEpochSeconds(view.previousSecretValidUntil),
    auto_registered: view.autoRegistered ?? false,
    schedule: view.schedule ? { cron: view.schedule.cron, timezone: view.schedule.timezone } : null,
    next_poll_at: toEpochSeconds(view.nextPollAt),
    last_event_at: toEpochSeconds(view.lastEventAt),
    last_poll_at: toEpochSeconds(view.lastPollAt),
    last_error: view.lastError ?? null,
    setup: view.setup ?? null,
    bindings: view.bindings,
  };
}
