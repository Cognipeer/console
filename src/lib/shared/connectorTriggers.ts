/**
 * Connector triggers — the wire shapes the trigger editor and the enterprise
 * Connectors module share (catalog, subscription state, form value). Used by
 * the agent trigger routes, the community trigger editor and the enterprise
 * picker that replaces `src/components/enterprise/EnterpriseConnectorTriggerUi.tsx`.
 * Dependency-free: types only, so client and server code can import it.
 */

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

/** `connector_subscription` on a trigger response (snake_case wire). */
export interface ConnectorSubscriptionWire {
  subscription_id: string;
  status: ConnectorSubscriptionStatus;
  kind: 'webhook' | 'poll';
  reason?: string | null;
  callback_url?: string | null;
  secret_hint?: string | null;
  /** Present once: in the response that created or rotated the secret of a manual-mode webhook. */
  secret?: string | null;
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
