/**
 * Internal MCP provider registry.
 *
 * Add a new console-native capability here to make it selectable as an
 * "Internal Service" MCP source. Keep providers self-contained — each one
 * owns its own instance listing, config fields, tool schema and execution.
 */

import { knowledgeBaseProvider } from './knowledgeBaseProvider';
import type { InternalMcpProvider } from './types';

export const INTERNAL_MCP_PROVIDERS: InternalMcpProvider[] = [knowledgeBaseProvider];

export function getInternalMcpProvider(id: string): InternalMcpProvider | undefined {
  return INTERNAL_MCP_PROVIDERS.find((p) => p.id === id);
}

export function requireInternalMcpProvider(id: string): InternalMcpProvider {
  const provider = getInternalMcpProvider(id);
  if (!provider) {
    throw new Error(`Unknown internal MCP provider "${id}"`);
  }
  return provider;
}

export type {
  InternalMcpProvider,
  InternalMcpProviderContext,
  InternalMcpInstanceOption,
  InternalMcpConfigField,
  InternalMcpBuiltTools,
} from './types';
