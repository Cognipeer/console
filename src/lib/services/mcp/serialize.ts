import type { IMcpServer } from '@/lib/database';
import type { McpServerView } from './types';
import { readAccessList } from '@/lib/iam/accessList';
import { maskAuthConfig, maskStdioConfig } from './secretVault';
import { getCompositeMemberSummaries } from './composite';
import { resolveExposure, resolveSourceType } from './serverView';
import { getDisabledToolNames, getDiscoveredMcpInstructions, getMcpInstructionsOverride, getToolAnnotationOverrides, getToolDescriptionOverrides, getToolNameOverrides } from './toolOverrides';

// ── Serialization ─────────────────────────────────────────────────────────

export function serializeMcpServer(record: IMcpServer): McpServerView {
  const serialized = { ...record } as Record<string, unknown>;
  delete serialized._id;
  delete serialized.openApiSpec;
  return {
    ...serialized,
    id: typeof record._id === 'string' ? record._id : (record._id?.toString() ?? ''),
    sourceType: resolveSourceType(record),
    exposure: resolveExposure(record),
    access: readAccessList(record.access),
    upstreamAuth: maskAuthConfig(record.upstreamAuth),
    stdioConfig: maskStdioConfig(record.stdioConfig),
    disabledTools: getDisabledToolNames(record),
    toolAnnotations: getToolAnnotationOverrides(record),
    toolDescriptions: getToolDescriptionOverrides(record),
    toolNames: getToolNameOverrides(record),
    instructions: getMcpInstructionsOverride(record),
    discoveredInstructions: getDiscoveredMcpInstructions(record),
    members: getCompositeMemberSummaries(record),
  } as McpServerView;
}
export function serializeMcpServerFull(record: IMcpServer): McpServerView & { openApiSpec?: string } {
  const { _id, ...rest } = record;
  return {
    ...rest,
    id: typeof _id === 'string' ? _id : (_id?.toString() ?? ''),
    sourceType: resolveSourceType(record),
    exposure: resolveExposure(record),
    access: readAccessList(record.access),
    upstreamAuth: maskAuthConfig(record.upstreamAuth),
    stdioConfig: maskStdioConfig(record.stdioConfig),
    disabledTools: getDisabledToolNames(record),
    toolAnnotations: getToolAnnotationOverrides(record),
    toolDescriptions: getToolDescriptionOverrides(record),
    toolNames: getToolNameOverrides(record),
    instructions: getMcpInstructionsOverride(record),
    discoveredInstructions: getDiscoveredMcpInstructions(record),
    members: getCompositeMemberSummaries(record),
  } as McpServerView & { openApiSpec?: string };
}
