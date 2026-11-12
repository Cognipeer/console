'use client';

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  Alert,
  Badge,
  Box,
  Button,
  Code,
  Group,
  MultiSelect,
  Paper,
  ScrollArea,
  Select,
  SimpleGrid,
  Stack,
  Switch,
  TagsInput,
  Text,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconAlertTriangle, IconCheck, IconX } from '@tabler/icons-react';
import PiiProtectionField from '@/components/pii/PiiProtectionField';
import { useTranslations } from '@/lib/i18n';
import type { IMcpTool } from '@/lib/database';
import type { McpServerView } from '@/lib/services/mcp';
import type { McpDefinitionFinding } from '@/lib/services/mcp/definitionScan';
import type { McpToolReviewEntry } from '@/lib/services/mcp/toolSecurity';
import { lineDiff } from './lineDiff';

/** Sources whose upstream is outside Console: their tool definitions are pinned and their calls can be PII-protected. */
const OUTSIDE_SOURCES = new Set(['remote', 'stdio', 'openapi']);

const MAX_DIFF_HEIGHT = 280;
const SEVERITY_COLORS: Record<McpDefinitionFinding['severity'], string> = { high: 'red', medium: 'orange', low: 'gray' };
const REASON_LABELS: Record<McpToolReviewEntry['reason'], { label: string; color: string }> = {
  new: { label: 'New tool', color: 'blue' },
  changed: { label: 'Definition changed', color: 'orange' },
  scan: { label: 'Flagged by the scan', color: 'red' },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

// Keyed by tool names the upstream chose: no prototype, so `__proto__` is an ordinary key.
function readReview(value: unknown): Record<string, McpToolReviewEntry> {
  const out = Object.create(null) as Record<string, McpToolReviewEntry>;
  if (!isRecord(value)) return out;
  for (const [name, entry] of Object.entries(value)) {
    if (isRecord(entry) && typeof entry.hash === 'string') out[name] = entry as unknown as McpToolReviewEntry;
  }
  return out;
}

function readScan(value: unknown): Record<string, McpDefinitionFinding[]> {
  const out = Object.create(null) as Record<string, McpDefinitionFinding[]>;
  if (!isRecord(value)) return out;
  for (const [name, findings] of Object.entries(value)) {
    if (Array.isArray(findings) && findings.length) out[name] = findings as McpDefinitionFinding[];
  }
  return out;
}

export interface McpSecurityPanelProps {
  server: McpServerView;
  onServerUpdated: (server: McpServerView) => void;
  /** The guardrail binding card, kept by the detail view (it owns the guardrail list and the binding save). */
  guardrailSection: ReactNode;
}

/**
 * An MCP server's Security tab: the guardrail on its tool calls, the caller
 * headers it passes on, PII protection of its upstream calls, and the review
 * of tool definitions that changed. The same panel serves the MCP hub page and
 * an agent's own server (the drawer on the agent screen).
 */
export default function McpSecurityPanel({ server, onServerUpdated, guardrailSection }: McpSecurityPanelProps) {
  const tPii = useTranslations('piiProtection');
  const metadata = (server.metadata ?? {}) as Record<string, unknown>;
  const outside = OUTSIDE_SOURCES.has(server.sourceType);
  const tools = server.tools ?? [];
  const [saving, setSaving] = useState<string | null>(null);

  const reloadServer = async () => {
    const res = await fetch(`/api/mcp/${server.id}`, { cache: 'no-store' }).catch(() => null);
    const data = res?.ok ? await res.json().catch(() => null) : null;
    if (data?.server) onServerUpdated(data.server);
  };

  const save = async (section: string, body: Record<string, unknown>, done?: string): Promise<boolean> => {
    setSaving(section);
    try {
      const res = await fetch(`/api/mcp/${server.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        // A review decision fails when a definition changed meanwhile: show what waits now.
        if (section === 'review') void reloadServer();
        throw new Error(data.error || 'The change could not be saved');
      }
      onServerUpdated(data.server);
      if (done) notifications.show({ title: 'Saved', message: done, color: 'teal' });
      return true;
    } catch (err) {
      notifications.show({
        title: 'Error',
        message: err instanceof Error ? err.message : 'The change could not be saved',
        color: 'red',
      });
      return false;
    } finally {
      setSaving(null);
    }
  };

  // ── Caller headers ──
  const headerPolicy = isRecord(metadata.runtimeHeaders) ? metadata.runtimeHeaders : {};
  const savedAllow = headerPolicy.allow === true;
  const savedNames = stringList(headerPolicy.allowedNames);
  const savedHeadersKey = JSON.stringify([savedAllow, savedNames]);
  const [headersOn, setHeadersOn] = useState(savedAllow);
  const [headerNames, setHeaderNames] = useState<string[]>(savedNames);
  useEffect(() => {
    setHeadersOn(savedAllow);
    setHeaderNames(savedNames);
    // Reset the draft when the saved policy changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [savedHeadersKey]);
  const headersDirty = JSON.stringify([headersOn, headersOn ? headerNames : []]) !== JSON.stringify([savedAllow, savedAllow ? savedNames : []]);

  // ── PII ──
  const piiPolicyKey = isRecord(metadata.piiProtection) && typeof metadata.piiProtection.policyKey === 'string'
    ? metadata.piiProtection.policyKey
    : null;
  const passthrough = stringList(metadata.piiPassthroughTools);

  // ── Tool definitions ──
  const changePolicy = metadata.toolChangePolicy === 'notify' ? 'notify' : 'approve';
  const review = useMemo(() => readReview(metadata.toolReview), [metadata.toolReview]);
  const scan = useMemo(() => readScan(metadata.toolScan), [metadata.toolScan]);
  const pending = Object.keys(review).sort();
  const hasHigh = (name: string) => (scan[name] ?? []).some((finding) => finding.severity === 'high');
  const bulkApprovable = pending.filter((name) => !hasHigh(name));
  const flaggedApproved = Object.keys(scan).filter((name) => !review[name]).sort();

  return (
    <Stack gap="md">
      <SimpleGrid cols={{ base: 1, md: 2 }} spacing="md">
        {guardrailSection}
        <Paper withBorder p="md" radius="md">
          <Text size="xs" c="dimmed" tt="uppercase" fw={600}>Caller headers</Text>
          <Text size="xs" c="dimmed" mt={4}>
            API, A2A and realtime callers may pass these request headers to the upstream (remote and OpenAPI
            servers). Only the listed names pass.
          </Text>
          <Switch
            mt="sm"
            size="sm"
            label="Pass listed caller headers"
            checked={headersOn}
            onChange={(event) => setHeadersOn(event.currentTarget.checked)}
          />
          <TagsInput
            mt="xs"
            size="xs"
            label="Header names"
            placeholder="e.g. X-Request-Region"
            value={headerNames}
            onChange={setHeaderNames}
            disabled={!headersOn}
            maxTags={24}
            splitChars={[',', ' ']}
          />
          {headersOn && headerNames.length === 0 ? (
            <Text size="xs" c="orange" mt={4}>Add at least one header name: without a list no header passes.</Text>
          ) : null}
          <Group justify="flex-end" mt="sm">
            <Button
              size="xs"
              disabled={!headersDirty || (headersOn && headerNames.length === 0)}
              loading={saving === 'headers'}
              onClick={() => void save(
                'headers',
                { runtimeHeaders: headersOn ? { allow: true, allowedNames: headerNames } : null },
                'Caller header policy saved',
              )}
            >
              Save
            </Button>
          </Group>
        </Paper>
      </SimpleGrid>

      <Paper withBorder p="md" radius="md">
        <Text size="xs" c="dimmed" tt="uppercase" fw={600}>{tPii('title')}</Text>
        {outside ? (
          <Stack gap="sm" mt="xs">
            <Text size="xs" c="dimmed">{tPii('mcp.description')}</Text>
            <PiiProtectionField
              surface="mcp"
              value={piiPolicyKey}
              disabled={saving === 'pii'}
              onChange={(next) => void save('pii', { piiProtection: next ? { policyKey: next } : null })}
            />
            {piiPolicyKey ? (
              <MultiSelect
                size="xs"
                label="Tools that receive the real values"
                description="For a tool whose upstream needs the value itself, such as a mail recipient. Its calls are not tokenized."
                data={tools.map((tool) => tool.name)}
                value={passthrough.filter((name) => tools.some((tool) => tool.name === name))}
                onChange={(next) => void save('pii', { piiPassthroughTools: next })}
                disabled={saving === 'pii'}
                searchable
                clearable
              />
            ) : null}
          </Stack>
        ) : (
          <Text size="sm" c="dimmed" mt="xs">
            {server.sourceType === 'composite'
              ? 'Set on each member server: a member’s protection applies to the calls this composite routes to it.'
              : 'This server runs inside Console; there is no outside upstream to protect personal data from.'}
          </Text>
        )}
      </Paper>

      {outside ? (
        <Paper withBorder p="md" radius="md">
          <Group justify="space-between" align="flex-start">
            <Box>
              <Text size="xs" c="dimmed" tt="uppercase" fw={600}>Tool definition changes</Text>
              <Text size="xs" c="dimmed" mt={4} maw={640}>
                Each tool’s definition (name, description, input schema) is pinned when it is approved. A new tool or
                a changed definition found by Update tools or a background refresh waits here and cannot be called
                until it is approved. A definition the scan rates high risk always waits.
              </Text>
            </Box>
            <Select
              size="xs"
              w={280}
              aria-label="When a tool definition changes"
              allowDeselect={false}
              disabled={saving === 'policy'}
              data={[
                { value: 'approve', label: 'Hold new and changed tools for approval' },
                { value: 'notify', label: 'Accept changes and record them' },
              ]}
              value={changePolicy}
              onChange={(next) => {
                if (next && next !== changePolicy) void save('policy', { toolChangePolicy: next });
              }}
            />
          </Group>

          {pending.length === 0 ? (
            <Text size="sm" c="dimmed" mt="sm">No tool is waiting for approval.</Text>
          ) : (
            <Stack gap="sm" mt="sm">
              <Group justify="space-between">
                <Text size="sm" fw={600}>{pending.length === 1 ? '1 tool waiting' : `${pending.length} tools waiting`}</Text>
                {bulkApprovable.length > 1 ? (
                  <Button
                    size="compact-xs"
                    variant="default"
                    loading={saving === 'review'}
                    onClick={() => void save(
                      'review',
                      { toolReview: { approve: bulkApprovable.map((name) => ({ name, hash: review[name].hash })) } },
                      'Tools approved',
                    )}
                  >
                    Approve {bulkApprovable.length} without high-risk findings
                  </Button>
                ) : null}
              </Group>
              {pending.map((name) => (
                <PendingTool
                  key={name}
                  name={name}
                  entry={review[name]}
                  tool={tools.find((tool) => tool.name === name)}
                  findings={scan[name] ?? []}
                  busy={saving === 'review'}
                  onDecide={(decision) => void save(
                    'review',
                    { toolReview: { [decision]: [{ name, hash: review[name].hash }] } },
                    decision === 'approve' ? `“${name}” approved` : `“${name}” rejected and disabled`,
                  )}
                />
              ))}
            </Stack>
          )}

          {flaggedApproved.length ? (
            <Box mt="md">
              <Text size="sm" fw={600}>Scan findings on approved tools</Text>
              <Stack gap={6} mt={6}>
                {flaggedApproved.map((name) => (
                  <Box key={name}>
                    <Code>{name}</Code>
                    <Findings findings={scan[name]} />
                  </Box>
                ))}
              </Stack>
            </Box>
          ) : null}
        </Paper>
      ) : null}
    </Stack>
  );
}

function Findings({ findings }: { findings: McpDefinitionFinding[] }) {
  return (
    <Stack gap={4} mt={6}>
      {findings.map((finding, index) => (
        <Group key={`${finding.rule}-${finding.field}-${index}`} gap={6} wrap="nowrap" align="flex-start">
          <Badge size="xs" variant="light" color={SEVERITY_COLORS[finding.severity]}>{finding.severity}</Badge>
          <Text size="xs" style={{ flex: 1, minWidth: 0 }}>
            {finding.rule} · <Text span size="xs" c="dimmed">{finding.field}</Text>
            {finding.excerpt ? (
              <Code block mt={2} style={{ fontSize: 11, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                {finding.excerpt}
              </Code>
            ) : null}
          </Text>
        </Group>
      ))}
    </Stack>
  );
}

function PendingTool({
  name,
  entry,
  tool,
  findings,
  busy,
  onDecide,
}: {
  name: string;
  entry: McpToolReviewEntry;
  tool: IMcpTool | undefined;
  findings: McpDefinitionFinding[];
  busy: boolean;
  onDecide: (decision: 'approve' | 'reject') => void;
}) {
  const reason = REASON_LABELS[entry.reason] ?? REASON_LABELS.changed;
  const high = findings.some((finding) => finding.severity === 'high');
  return (
    <Paper withBorder p="sm" radius="sm">
      <Group justify="space-between" wrap="nowrap" align="flex-start">
        <Group gap="xs">
          <Code>{name}</Code>
          <Badge size="xs" variant="light" color={reason.color}>{reason.label}</Badge>
          {entry.detectedAt ? (
            <Text size="xs" c="dimmed">since {new Date(entry.detectedAt).toLocaleString()}</Text>
          ) : null}
        </Group>
        <Group gap={6} wrap="nowrap">
          <Button
            size="compact-xs"
            color={high ? 'red' : 'teal'}
            variant={high ? 'outline' : 'filled'}
            leftSection={<IconCheck size={12} />}
            loading={busy}
            onClick={() => onDecide('approve')}
          >
            {high ? 'Approve anyway' : 'Approve'}
          </Button>
          <Button
            size="compact-xs"
            variant="default"
            leftSection={<IconX size={12} />}
            disabled={busy}
            onClick={() => onDecide('reject')}
          >
            Reject
          </Button>
        </Group>
      </Group>
      {high ? (
        <Alert color="red" variant="light" mt="xs" p="xs" icon={<IconAlertTriangle size={14} />}>
          <Text size="xs">
            The scan found text in this definition that tries to steer the model. Approve only if you trust it.
          </Text>
        </Alert>
      ) : null}
      {findings.length ? <Findings findings={findings} /> : null}
      <DefinitionDiff previous={entry.previous} tool={tool} isNew={entry.reason === 'new'} />
      <Text size="xs" c="dimmed" mt={6}>Reject disables the tool and pins this definition; it is raised again only if it changes.</Text>
    </Paper>
  );
}

function DefinitionDiff({
  previous,
  tool,
  isNew,
}: {
  previous: McpToolReviewEntry['previous'];
  tool: IMcpTool | undefined;
  isNew: boolean;
}) {
  if (!tool) return null;
  const current = { title: tool.title, description: tool.description, inputSchema: tool.inputSchema };
  const after = JSON.stringify(current, null, 2);
  if (isNew || !previous) {
    return (
      <ScrollArea.Autosize mah={MAX_DIFF_HEIGHT} mt="xs">
        <Code block style={{ fontSize: 11 }}>{after}</Code>
      </ScrollArea.Autosize>
    );
  }
  const partial = previous.inputSchema === undefined && previous.description === undefined;
  const before = JSON.stringify({ title: previous.title, description: previous.description, inputSchema: previous.inputSchema }, null, 2);
  const diff = lineDiff(before, after);
  return (
    <Box mt="xs">
      {partial ? (
        <Text size="xs" c="dimmed" mb={4}>The approved definition was too large to keep; only its title is compared.</Text>
      ) : null}
      <ScrollArea.Autosize mah={MAX_DIFF_HEIGHT}>
        {diff ? (
          <Box component="pre" m={0} style={{ fontSize: 11, fontFamily: 'var(--mantine-font-family-monospace)' }}>
            {diff.map((line, index) => (
              <Box
                key={index}
                component="div"
                style={{
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                  background: line.kind === 'added'
                    ? 'var(--mantine-color-teal-light)'
                    : line.kind === 'removed'
                      ? 'var(--mantine-color-red-light)'
                      : undefined,
                }}
              >
                {line.kind === 'added' ? '+ ' : line.kind === 'removed' ? '- ' : '  '}
                {line.text}
              </Box>
            ))}
          </Box>
        ) : (
          <SimpleGrid cols={2} spacing="xs">
            <Code block style={{ fontSize: 11 }}>{before}</Code>
            <Code block style={{ fontSize: 11 }}>{after}</Code>
          </SimpleGrid>
        )}
      </ScrollArea.Autosize>
    </Box>
  );
}
