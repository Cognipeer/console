'use client';

import { useState } from 'react';
import {
  Badge,
  Button,
  Code,
  Group,
  Paper,
  Stack,
  Table,
  Text,
  Textarea,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useLocale, useTranslations } from '@/lib/i18n';
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
  action: 'detect' | 'redact' | 'mask' | 'block' | 'tokenize';
  block: boolean;
  replacement: string;
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
}

export default function PiiTestPanel({ categories, customPatterns, languages }: Props) {
  const t = useTranslations('pii.test');
  const tSev = useTranslations('pii.severity');
  const locale = useLocale();

  const [text, setText] = useState('');
  const [result, setResult] = useState<ScanResult | null>(null);
  const [activeAction, setActiveAction] = useState<'detect' | 'redact' | 'mask' | 'tokenize' | null>(null);
  const [running, setRunning] = useState(false);

  const run = async (action: 'detect' | 'redact' | 'mask' | 'tokenize') => {
    if (!text.trim()) return;
    setRunning(true);
    setActiveAction(action);
    try {
      const res = await fetch(`/api/pii/${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text,
          categories,
          customPatterns,
          languages,
          locale,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? 'Failed');
      }
      const data = (await res.json()) as ScanResult;
      setResult(data);
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

  return (
    <Stack gap="md">
      <div>
        <Text fw={600} size="sm">{t('title')}</Text>
        <Text size="xs" c="dimmed">{t('subtitle')}</Text>
      </div>

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
              <Table striped highlightOnHover withColumnBorders verticalSpacing="xs" fz="xs">
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>Token</Table.Th>
                    <Table.Th>{t('value')}</Table.Th>
                    <Table.Th>{t('category')}</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {Object.entries(result.vault).map(([token, entry]) => (
                    <Table.Tr key={token}>
                      <Table.Td><Code>{token}</Code></Table.Td>
                      <Table.Td>{entry.value}</Table.Td>
                      <Table.Td>{entry.category}</Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </Paper>
          )}

          <Paper p="md" withBorder radius="sm">
            <Text size="sm" fw={600} mb="xs">{t('findings')}</Text>
            {result.findings.length === 0 ? (
              <Text size="sm" c="dimmed">{t('noFindings')}</Text>
            ) : (
              <Table striped highlightOnHover withColumnBorders verticalSpacing="xs" fz="xs">
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>{t('category')}</Table.Th>
                    <Table.Th>{t('severity')}</Table.Th>
                    <Table.Th>{t('value')}</Table.Th>
                    <Table.Th>{t('offset')}</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {result.findings.map((f, i) => (
                    <Table.Tr key={`${f.category}-${f.start}-${i}`}>
                      <Table.Td>
                        <div>
                          <Text size="xs" fw={500}>{f.label}</Text>
                          <Text size="xs" c="dimmed">{f.category}</Text>
                        </div>
                      </Table.Td>
                      <Table.Td>
                        <Badge size="xs" color={f.severity === 'high' ? 'red' : f.severity === 'medium' ? 'orange' : 'gray'}>
                          {tSev(f.severity)}
                        </Badge>
                      </Table.Td>
                      <Table.Td style={{ fontFamily: 'var(--font-mono, monospace)', maxWidth: 320, wordBreak: 'break-all' }}>
                        {f.value}
                      </Table.Td>
                      <Table.Td>
                        <Text size="xs" c="dimmed">{f.start}–{f.end}</Text>
                      </Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            )}
          </Paper>
        </>
      )}
    </Stack>
  );
}
