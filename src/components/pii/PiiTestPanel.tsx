'use client';

import { useState, type ReactNode } from 'react';
import {
  Badge,
  Button,
  Code,
  Group,
  Paper,
  Stack,
  Text,
  Textarea,
  Tooltip,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import DataGrid, { type DataGridColumn } from '@/components/common/ui/DataGrid';
import { useLocale, useTranslations } from '@/lib/i18n';
import type { PiiAction, PiiEngine } from '@/lib/services/pii/types';
import type { PiiCustomPatternForm } from './PiiPolicyEditor';

interface Finding {
  category: string;
  source: 'builtin' | 'custom';
  severity: 'low' | 'medium' | 'high';
  value: string;
  start: number;
  end: number;
  label: string;
  message: string;
  action: PiiAction;
  block: boolean;
  replacement: string;
  confidence?: number;
  evidence?: string[];
}

interface ScanResult {
  findings: Finding[];
  outputText: string;
  inputLength: number;
  vault?: Record<string, { value: string; category: string }>;
}

interface Props {
  categories: Record<string, boolean>;
  customPatterns: PiiCustomPatternForm[];
  languages: string[];
  /** Which detector to test against — reflects the (possibly unsaved) draft's
   *  current selection, not necessarily what the saved policy still has. */
  engine: PiiEngine;
  /** The draft's `detection` settings — same caveat as `engine`. */
  minConfidence: number;
  contextBoost: boolean;
}

type VaultRow = { token: string; value: string; category: string };
type FindingRow = { f: Finding; below: boolean; key: string };

/** Row identity for matching a threshold-free scan against the filtered one. */
const findingKey = (f: Finding) => `${f.category}:${f.start}:${f.end}`;

export default function PiiTestPanel({ categories, customPatterns, languages, engine, minConfidence, contextBoost }: Props) {
  const t = useTranslations('pii.test');
  const tSev = useTranslations('pii.severity');
  const locale = useLocale();

  const [text, setText] = useState('');
  const [result, setResult] = useState<ScanResult | null>(null);
  /** Findings the threshold dropped, shown greyed so the threshold's effect is visible. */
  const [ignored, setIgnored] = useState<Finding[]>([]);
  /** Threshold the shown result was produced with (the draft may change after the run). */
  const [ranThreshold, setRanThreshold] = useState(0);
  const [activeAction, setActiveAction] = useState<'detect' | 'redact' | 'mask' | 'tokenize' | null>(null);
  const [running, setRunning] = useState(false);

  const run = async (action: 'detect' | 'redact' | 'mask' | 'tokenize') => {
    if (!text.trim()) return;
    setRunning(true);
    setActiveAction(action);
    try {
      const post = async (op: string, threshold: number) => {
        const res = await fetch(`/api/pii/${op}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            text,
            categories,
            customPatterns,
            languages,
            locale,
            engine,
            detection: { minConfidence: threshold, contextBoost },
          }),
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error ?? 'Failed');
        }
        return (await res.json()) as ScanResult;
      };
      const [data, unfiltered] = await Promise.all([
        post(action, minConfidence),
        minConfidence > 0 ? post('detect', 0) : Promise.resolve(null),
      ]);
      const kept = new Set(data.findings.map(findingKey));
      setResult(data);
      setIgnored(unfiltered ? unfiltered.findings.filter((f) => !kept.has(findingKey(f))) : []);
      setRanThreshold(minConfidence);
    } catch (err) {
      notifications.show({
        title: 'PII',
        message: err instanceof Error ? err.message : '',
        color: 'red',
      });
    } finally {
      setRunning(false);
    }
  };

  const dim = (below: boolean, node: ReactNode) => (below ? <div style={{ opacity: 0.5 }}>{node}</div> : node);

  const vaultCols: DataGridColumn<VaultRow>[] = [
    { key: 'token', label: 'Token', render: (r) => <Code>{r.token}</Code> },
    { key: 'value', label: t('value'), render: (r) => r.value },
    { key: 'category', label: t('category'), render: (r) => r.category },
  ];

  const findingColumns: DataGridColumn<FindingRow>[] = [
    {
      key: 'category',
      label: t('category'),
      render: ({ f, below }) =>
        dim(
          below,
          <div>
            <Text size="xs" fw={500}>{f.label}</Text>
            <Text size="xs" c="dimmed">{f.category}</Text>
            {below && (
              <Badge size="xs" variant="outline" color="gray" mt={2}>{t('belowThreshold')}</Badge>
            )}
          </div>,
        ),
    },
    {
      key: 'severity',
      label: t('severity'),
      render: ({ f, below }) =>
        dim(
          below,
          <Badge size="xs" color={below ? 'gray' : f.severity === 'high' ? 'red' : f.severity === 'medium' ? 'orange' : 'gray'}>
            {tSev(f.severity)}
          </Badge>,
        ),
    },
    {
      key: 'value',
      label: t('value'),
      render: ({ f, below }) =>
        dim(
          below,
          <div style={{ fontFamily: 'var(--font-mono, monospace)', maxWidth: 320, wordBreak: 'break-all' }}>{f.value}</div>,
        ),
    },
    {
      key: 'confidence',
      label: t('confidence'),
      render: ({ f, below }) =>
        dim(
          below,
          <Text size="xs" fw={below ? 400 : 600} c={below || (f.confidence ?? 1) < ranThreshold ? 'dimmed' : undefined}>
            {typeof f.confidence === 'number' ? f.confidence.toFixed(2) : '—'}
          </Text>,
        ),
    },
    {
      key: 'evidence',
      label: t('evidence'),
      render: ({ f, below }) =>
        dim(below, <Text size="xs" c="dimmed">{f.evidence?.length ? f.evidence.join(' · ') : '—'}</Text>),
    },
    {
      key: 'offset',
      label: t('offset'),
      render: ({ f, below }) => dim(below, <Text size="xs" c="dimmed">{f.start}–{f.end}</Text>),
    },
  ];

  return (
    <Stack gap="md">
      <Group justify="space-between" align="flex-start" wrap="nowrap">
        <div>
          <Text fw={600} size="sm">{t('title')}</Text>
          <Text size="xs" c="dimmed">{t('subtitle')}</Text>
        </div>
        <Tooltip label={t('thresholdHint')}>
          <Badge variant="outline" color="gray">{t('threshold', { value: minConfidence.toFixed(2) })}</Badge>
        </Tooltip>
      </Group>

      <Textarea
        label={t('input')}
        placeholder={t('inputPlaceholder')}
        value={text}
        onChange={(e) => setText(e.currentTarget.value)}
        minRows={6}
        autosize
        styles={{ input: { fontFamily: 'var(--font-mono, monospace)', fontSize: 13 } }}
      />

      <Group>
        <Button
          variant={activeAction === 'detect' ? 'filled' : 'light'}
          color="blue"
          loading={running && activeAction === 'detect'}
          onClick={() => void run('detect')}
          disabled={!text.trim()}
        >
          {t('runDetect')}
        </Button>
        <Button
          variant={activeAction === 'redact' ? 'filled' : 'light'}
          color="orange"
          loading={running && activeAction === 'redact'}
          onClick={() => void run('redact')}
          disabled={!text.trim()}
        >
          {t('runRedact')}
        </Button>
        <Button
          variant={activeAction === 'mask' ? 'filled' : 'light'}
          color="teal"
          loading={running && activeAction === 'mask'}
          onClick={() => void run('mask')}
          disabled={!text.trim()}
        >
          {t('runMask')}
        </Button>
        <Button
          variant={activeAction === 'tokenize' ? 'filled' : 'light'}
          color="grape"
          loading={running && activeAction === 'tokenize'}
          onClick={() => void run('tokenize')}
          disabled={!text.trim()}
        >
          {t('runTokenize')}
        </Button>
      </Group>

      {result && (
        <>
          <Paper p="md" withBorder radius="sm">
            <Group justify="space-between" mb="xs">
              <Text size="sm" fw={600}>{t('output')}</Text>
              <Badge variant="light">{t('findingsCount', { count: result.findings.length })}</Badge>
            </Group>
            <Code block style={{ fontSize: 13, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
              {result.outputText || ' '}
            </Code>
          </Paper>

          {result.vault && Object.keys(result.vault).length > 0 && (
            <Paper p="md" withBorder radius="sm">
              <Text size="sm" fw={600} mb="xs">{t('vault')}</Text>
              <DataGrid<VaultRow>
                records={Object.entries(result.vault).map(([token, entry]) => ({ token, ...entry }))}
                rowKey={(r) => r.token}
                columns={vaultCols}
              />
            </Paper>
          )}

          <Paper p="md" withBorder radius="sm">
            <Text size="sm" fw={600} mb="xs">{t('findings')}</Text>
            {result.findings.length === 0 && ignored.length === 0 ? (
              <Text size="sm" c="dimmed">{t('noFindings')}</Text>
            ) : (
              <DataGrid<FindingRow>
                records={[
                  ...result.findings.map((f) => ({ f, below: false })),
                  ...ignored.map((f) => ({ f, below: true })),
                ].map((row, i) => ({ ...row, key: `${row.f.category}-${row.f.start}-${i}` }))}
                rowKey={(row) => row.key}
                columns={findingColumns}
              />
            )}
          </Paper>
        </>
      )}
    </Stack>
  );
}
