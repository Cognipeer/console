'use client';

/**
 * The places where the agent trigger editor reaches the Connectors module (connector triggers).
 *
 * Connectors ship with the Enterprise overlay. The community build gets this file: no catalog, nothing
 * rendered, so the editor offers no "Connector" choice. The Enterprise overlay replaces it at the same path
 * with the real parts, so keep every export and its props as they are. The trigger editor calls these in the
 * same order on every render, so the community stubs can be plain functions.
 */
import type { ReactNode } from 'react';
import type {
  ConnectorSubscriptionWire,
  ConnectorTriggerCatalogConnector,
  ConnectorTriggerFormValue,
} from '@/lib/shared/connectorTriggers';

export interface ConnectorTriggerCatalogState {
  /** Connector triggers can be used here (enterprise build, Connectors on, licensed). */
  available: boolean;
  loading: boolean;
  error: string | null;
  /** The project's connectors whose packages declare triggers. */
  connectors: ConnectorTriggerCatalogConnector[];
  reload(): void;
}

const UNAVAILABLE: ConnectorTriggerCatalogState = {
  available: false,
  loading: false,
  error: null,
  connectors: [],
  reload: () => {},
};

export function useConnectorTriggerCatalog(): ConnectorTriggerCatalogState {
  return UNAVAILABLE;
}

export interface ConnectorTriggerPickerProps {
  value: ConnectorTriggerFormValue | null;
  onChange(value: ConnectorTriggerFormValue | null): void;
  /** Field errors keyed like the API's (`connector.params.<key>`, `connector.events`, …). */
  errors?: Record<string, string>;
  disabled?: boolean;
}

/** The "When" part of the editor for a connector trigger: connector, trigger, parameters, events, schedule. */
export function ConnectorTriggerPicker(_props: ConnectorTriggerPickerProps): ReactNode {
  return null;
}

export interface ConnectorTriggerStatusProps {
  agentId: string;
  triggerId: string;
  subscription: ConnectorSubscriptionWire | null;
  /** The subscription changed (retried, rotated): reload the trigger. */
  onChanged(): void;
}

/** The subscription of a saved connector trigger: state, callback URL and secret, setup steps, retry. */
export function ConnectorTriggerStatus(_props: ConnectorTriggerStatusProps): ReactNode {
  return null;
}
