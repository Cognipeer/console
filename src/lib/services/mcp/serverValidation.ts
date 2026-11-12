import type { IMcpExposureConfig, McpSourceType } from '@/lib/database';
import type { CreateMcpServerInput } from './types';
import { CONSOLE_IDENTITY_AUTH_TYPE } from '@/lib/iam/consoleIdentity';
import { isStdioRunnerEnabled } from './stdioRunner';
import { mcpSandboxRunner } from '@/enterprise/registry';
import { assertConsoleIdentitySource } from './identityAuth';
import { DEFAULT_MCP_EXPOSURE } from './serverView';

// ── CRUD ──────────────────────────────────────────────────────────────────

export function validateCreateInput(input: CreateMcpServerInput): McpSourceType {
  const sourceType: McpSourceType = input.sourceType ?? 'openapi';
  if (sourceType === 'openapi' && !input.openApiSpec) {
    throw new Error('openApiSpec is required for source type "openapi"');
  }
  if (sourceType === 'remote' && !input.remoteConfig?.url) {
    throw new Error('remoteConfig.url is required for source type "remote"');
  }
  if (sourceType === 'stdio') {
    if (!input.stdioConfig?.packageName?.trim()) {
      throw new Error('stdioConfig.packageName is required for source type "stdio"');
    }
    if (!['npx', 'uvx'].includes(input.stdioConfig.runtime)) {
      throw new Error('stdioConfig.runtime must be "npx" or "uvx"');
    }
    if (input.stdioConfig.executionMode === 'sandbox') {
      if (!mcpSandboxRunner.current) {
        throw new Error('Sandbox execution requires the enterprise sandbox module');
      }
    } else if (!isStdioRunnerEnabled()) {
      throw new Error('Stdio subprocess execution is disabled on this deployment');
    }
  }
  if (sourceType === 'internal') {
    if (!input.internalConfig?.provider?.trim()) {
      throw new Error('internalConfig.provider is required for source type "internal"');
    }
    if (!input.internalConfig?.instanceKey?.trim()) {
      throw new Error('internalConfig.instanceKey is required for source type "internal"');
    }
  }
  if (input.upstreamAuth?.type === CONSOLE_IDENTITY_AUTH_TYPE) assertConsoleIdentitySource(sourceType);
  if (sourceType === 'composite') {
    if (!input.compositeConfig?.members?.length) {
      throw new Error('compositeConfig.members is required for source type "composite"');
    }
    for (const m of input.compositeConfig.members) {
      if (!m.serverId?.trim()) {
        throw new Error('Every composite member needs a serverId');
      }
    }
  }
  return sourceType;
}

export function normalizeExposure(input?: IMcpExposureConfig): IMcpExposureConfig {
  if (!input) return DEFAULT_MCP_EXPOSURE;
  const protocols = (input.protocols ?? []).filter(
    (p): p is IMcpExposureConfig['protocols'][number] => p === 'streamable-http' || p === 'sse',
  );
  return {
    protocols: protocols.length ? protocols : DEFAULT_MCP_EXPOSURE.protocols,
    accessMode: input.accessMode === 'public' ? 'public' : 'token',
  };
}
