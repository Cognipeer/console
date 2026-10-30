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
  ConnectorSecretReveal,
  ConnectorSubscriptionWire,
  ConnectorTriggerCatalogConnector,
  ConnectorTriggerFormValue,
} from '@/lib/shared/connectorTriggers';

export interface ConnectorTriggerCatalogState {
  /** Connector triggers can be used here (enterprise build, Connectors on, licensed). */
  available: boolean;
  /**
   * Why they cannot, when the answer is in and the reason is the caller's: the module is there, but this person may not read the
   * project's connectors (a 403). Absent when the module is off, not licensed or not part of this build.
   */
  forbidden?: boolean;
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

export interface ConnectorTriggerParamsFormProps {
  /** The connector the trigger listens to (an id of the catalog). */
  connectorId: string;
  /** The package trigger's name, for example `pull_request`. */
  trigger: string;
  /** The parameters filled in so far, by the package's parameter keys. */
  value: Record<string, unknown>;
  onChange(params: Record<string, unknown>): void;
  /** Field errors keyed like the API's (`connector.params.<key>`). */
  errors?: Record<string, string>;
  /** A heading for the fields; shown only when the trigger has parameters. */
  label?: string;
  disabled?: boolean;
}

/**
 * Only the parameter fields of a package trigger (a repository, a project), without the connector, events or
 * schedule choices of the picker: the use-template form asks for them when a template's connector trigger needs
 * what no template can know. Renders nothing when the trigger has no parameters.
 */
export function ConnectorTriggerParamsForm(_props: ConnectorTriggerParamsFormProps): ReactNode {
  return null;
}

export interface ConnectorTriggerStatusProps {
  agentId: string;
  triggerId: string;
  subscription: ConnectorSubscriptionWire | null;
  /**
   * The subscription changed (retried, rotated): reload the trigger. A retry or a rotation hands over the subscription its answer
   * carried, for a host that wants to show that one until the reload is back.
   */
  onChanged(subscription?: ConnectorSubscriptionWire | null): void;
  /**
   * The secret a create or a rotation showed once, kept by the editor for as long as it is open (the card is
   * unmounted when the editor shows another tab). Absent: the card keeps what it shows for as long as it lives.
   */
  reveal?: ConnectorSecretReveal | null;
  /** The card has a secret (or the end of the old one) to keep, or none any more. Given together with `reveal`. */
  onReveal?(reveal: ConnectorSecretReveal | null): void;
}

/** The subscription of a saved connector trigger: state, callback URL and secret, setup steps, retry. */
export function ConnectorTriggerStatus(_props: ConnectorTriggerStatusProps): ReactNode {
  return null;
}
