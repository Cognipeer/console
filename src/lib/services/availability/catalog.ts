/**
 * The services an operator can switch off — for the whole deployment through the
 * environment, or for one tenant through its license — and what each one needs
 * in order to work.
 *
 * A service id is a permission service (`RBAC_SERVICE_DEFINITIONS`, the same id
 * every route declares in `config.authz`) or an enterprise module
 * (`ENTERPRISE_API_RULES`, for modules such as `mcp-hub` that share a permission
 * service with something an operator may want to keep on).
 */

import { RBAC_SERVICE_DEFINITIONS } from '@/lib/security/rbac';
import { ENTERPRISE_API_RULES } from '@/lib/license/enterprise-access';

/**
 * The administration surface. Switching any of these off would leave nobody able
 * to sign in, manage access or read the license, so neither the environment nor
 * a license can turn them off.
 */
export const ALWAYS_ON_SERVICES: readonly string[] = [
  'tokens',
  'members',
  'projects',
  'providers',
  'config',
  'license',
  'audit',
  'iam',
  'resources',
];

/**
 * A service that cannot do its work while another one is off is off with it.
 * Only hard needs are listed: an agent that merely USES a knowledge engine as a
 * tool keeps running without it (that binding is dropped), so `agents` does not
 * require `rag`.
 */
export const SERVICE_REQUIRES: Readonly<Record<string, readonly string[]>> = {
  agents: ['models'],
  rag: ['models', 'vector'],
  memory: ['vector'],
  portals: ['agents'],
  channels: ['agents'],
  connectors: ['tools'],
  realtime: ['models'],
  evaluations: ['models'],
  redteam: ['models'],
  analysis: ['models'],
  'prompt-optimizer': ['models'],
  'ai-app-gateway': ['models'],
};

let knownServices: ReadonlySet<string> | null = null;

function allKnownServices(): ReadonlySet<string> {
  if (!knownServices) {
    knownServices = new Set([
      ...RBAC_SERVICE_DEFINITIONS.map((definition) => definition.id as string),
      ...ENTERPRISE_API_RULES.map((rule) => rule.module),
    ]);
  }
  return knownServices;
}

export function isKnownService(service: string): boolean {
  return allKnownServices().has(service);
}

export function isAlwaysOnService(service: string): boolean {
  return ALWAYS_ON_SERVICES.includes(service);
}

/** Names for the enterprise modules that are not permission services (those carry their own label). */
const MODULE_LABELS: Readonly<Record<string, string>> = {
  health: 'Entity Health',
  'mcp-hub': 'MCP Hub catalogs',
  'prompt-optimizer': 'Prompt Optimizer',
  reports: 'Service Reports',
};

export function serviceLabel(service: string): string {
  const definition = RBAC_SERVICE_DEFINITIONS.find((candidate) => candidate.id === service);
  return definition?.label ?? MODULE_LABELS[service] ?? service;
}

/** Every service a switch can turn off, sorted. */
export function listSwitchableServices(): string[] {
  return [...allKnownServices()].filter((service) => !isAlwaysOnService(service)).sort();
}
