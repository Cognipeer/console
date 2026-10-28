/**
 * Internal MCP provider registry — types.
 *
 * An "internal" MCP server (sourceType 'internal') doesn't proxy an external
 * upstream; it wraps a console-native capability (e.g. a Knowledge Base / RAG
 * module) and serves it as MCP tools. Each capability that wants to be
 * exposable this way registers one provider here — see `registry.ts`.
 */

import type { IMcpTool } from '@/lib/database';
import type { ConsoleIdentityCaller } from '@/lib/iam/consoleIdentity';

export interface InternalMcpProviderContext {
  tenantDbName: string;
  tenantId: string;
  projectId?: string;
  /** Key of the MCP server the call came through. Set for `execute` only. */
  serverKey?: string;
  /** Who the call is for. Set for `execute` only; absent when the surface knows nobody (a public endpoint). */
  identity?: ConsoleIdentityCaller;
}

/** One selectable instance of a provider, e.g. a single RAG module. */
export interface InternalMcpInstanceOption {
  key: string;
  label: string;
  description?: string;
}

/** Extra settings the create/edit form must collect for a provider. */
export interface InternalMcpConfigField {
  key: string;
  label: string;
  type: 'model' | 'text' | 'number';
  required?: boolean;
  /** For type 'model': narrows the model picker (e.g. 'chat'). */
  modelCategory?: string;
  hint?: string;
}

export interface InternalMcpBuiltTools {
  tools: IMcpTool[];
  /** Suggested server name when the user leaves the name blank. */
  suggestedName: string;
  suggestedDescription?: string;
  /** MCP `instructions`: how the tools fit together, served unless the operator writes their own. */
  instructions?: string;
}

export interface InternalMcpProvider {
  id: string;
  label: string;
  description: string;
  configFields: InternalMcpConfigField[];
  /** List the tenant's selectable instances (e.g. RAG modules) for this provider. */
  listInstances(ctx: InternalMcpProviderContext): Promise<InternalMcpInstanceOption[]>;
  /** Validate an instance key + config exist/are well-formed before saving. */
  validateInstance(
    ctx: InternalMcpProviderContext,
    instanceKey: string,
    config: Record<string, unknown>,
  ): Promise<void>;
  /** Build the MCP tool descriptor(s) for one instance. */
  buildTools(
    ctx: InternalMcpProviderContext,
    instanceKey: string,
    config: Record<string, unknown>,
  ): Promise<InternalMcpBuiltTools>;
  /** Execute a tool call against one instance. */
  execute(
    ctx: InternalMcpProviderContext,
    instanceKey: string,
    config: Record<string, unknown>,
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<unknown>;
}
