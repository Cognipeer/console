'use client';

/**
 * DatasetImportWizard — full-screen FormShell wizard that imports external
 * LLM exports (OpenAI fine-tune/stored-completions JSONL, OpenAI
 * request/response pairs, Bedrock invocation logs, Langfuse generations,
 * embedded gateway/APIM chat JSON) into an evaluation dataset behind the
 * mandatory PII anonymization gate.
 *
 * Sections:
 *   1. Source        — three-way input: paste (monospace textarea), file
 *                      upload (read client-side, 10MB cap), or URL fetched
 *                      through the SSRF-guarded POST /api/dataset-import/fetch.
 *                      Whichever fills LAST wins; the effective content's
 *                      origin and byte count are always shown.
 *   2. Format        — debounced POST /api/dataset-import/detect; detected
 *                      format badge + manual override Select, RAW (not yet
 *                      anonymized, never persisted) preview of the first
 *                      items, and parsed/skipped counts per reason.
 *   3. Anonymization — REQUIRED: built-in PII categories (served localized by
 *                      GET /api/pii/categories), mask|pseudonym strategy, and
 *                      an optional stable salt for pseudonym mode.
 *   4. Create        — dataset name + optional source label, then
 *                      POST /api/dataset-import; success screen with
 *                      created/skipped/PII-finding counts and a link to the
 *                      dataset detail page.
 *
 * Product rule surfaced in the UI: imported rows are evaluation data ONLY —
 * they never write usage/cost rows; measured costs come later from eval
 * replay.
 *
 * Full-screen FormShell overlay per the project rule for create/edit
 * surfaces (small Mantine Modals are reserved for confirms).
 */

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Alert,
  Badge,
  Button,
  FileInput,
  Group,
  Loader,
  Radio,
  Select,
  Table,
  Text,
  TextInput,
  Textarea,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import {
  IconCheck,
  IconDatabase,
  IconDownload,
  IconFileImport,
  IconInfoCircle,
  IconShieldLock,
} from '@tabler/icons-react';
import FormShell, {
  Checklist,
  FormField,
  FormRow,
  FormSection,
  SummaryGroup,
  SummaryKV,
  ToggleList,
  ToggleRow,
} from '@/components/common/ui/FormShell';
import StatTile from '@/components/common/ui/StatTile';
import { useLocale, useTranslations } from '@/lib/i18n';
import {
  DATASET_IMPORT_FORMATS,
  MAX_IMPORT_BYTES,
  defaultDatasetName,
  formatBytes,
  isDatasetImportFormat,
  messageText,
  truncateText,
  utf8ByteLength,
  type DatasetImportFormat,
} from '@/components/datasetImport/importHelpers';

type Strategy = 'mask' | 'pseudonym';
type ContentOrigin = 'paste' | 'file' | 'url';

/** Row shape of GET /api/pii/categories → categories[]. */
interface PiiCategoryOption {
  id: string;
  label: string;
  description: string;
  severity: 'low' | 'medium' | 'high';
  defaultEnabled: boolean;
}

/** Pinned POST /api/dataset-import/detect response shape. */
interface DetectPreviewItem {
  input: Array<{ role: string; content: unknown }>;
  tools?: unknown[];
  expected?: {
    reference?: string;
    toolCalls?: Array<{ name: string; args?: Record<string, unknown> }>;
  };
}
interface DetectResponse {
  format?: DatasetImportFormat;
  preview: {
    items: DetectPreviewItem[];
    counts: { parsed: number; skipped: Record<string, number> };
  };
}

/** Pinned POST /api/dataset-import response shape. */
interface ImportResult {
  datasetId: string;
  created: number;
  skipped: Record<string, number>;
  piiFindings: number;
}

const SEVERITY_COLOR: Record<PiiCategoryOption['severity'], string> = {
  low: 'gray',
  medium: 'orange',
  high: 'red',
};

const ROLE_COLOR: Record<string, string> = {
  system: 'gray',
  user: 'blue',
  assistant: 'teal',
  tool: 'orange',
};

const DETECT_DEBOUNCE_MS = 600;
const PREVIEW_MESSAGES_SHOWN = 3;

export default function DatasetImportWizard() {
  const router = useRouter();
  const t = useTranslations('datasetImport');
  const tSeverity = useTranslations('pii.severity');
  const locale = useLocale();

  // ── 1. Source (whichever fills last wins) ──
  const [content, setContent] = useState('');
  const [origin, setOrigin] = useState<ContentOrigin | null>(null);
  const [pasteText, setPasteText] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [url, setUrl] = useState('');
  const [fetching, setFetching] = useState(false);

  // ── 2. Format & preview ──
  const [detect, setDetect] = useState<DetectResponse | null>(null);
  const [detecting, setDetecting] = useState(false);
  const [formatOverride, setFormatOverride] = useState<DatasetImportFormat | null>(null);

  // ── 3. Anonymization (required) ──
  const [catalog, setCatalog] = useState<PiiCategoryOption[]>([]);
  const [catalogLoading, setCatalogLoading] = useState(true);
  const [selectedCategories, setSelectedCategories] = useState<Set<string>>(new Set());
  const [strategy, setStrategy] = useState<Strategy>('mask');
  const [salt, setSalt] = useState('');

  // ── 4. Create ──
  const [name, setName] = useState('');
  const [nameEdited, setNameEdited] = useState(false);
  const [sourceLabel, setSourceLabel] = useState('');
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<ImportResult | null>(null);

  // Built-in PII category catalog (localized labels; defaults preselected).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setCatalogLoading(true);
      try {
        const res = await fetch(`/api/pii/categories?locale=${encodeURIComponent(locale)}`);
        const payload = await res.json();
        if (!res.ok) throw new Error(payload.error ?? 'Failed to load PII categories');
        if (cancelled) return;
        const categories: PiiCategoryOption[] = payload.categories ?? [];
        setCatalog(categories);
        setSelectedCategories(
          new Set(categories.filter((c) => c.defaultEnabled).map((c) => c.id)),
        );
      } catch (error) {
        if (!cancelled) {
          notifications.show({
            color: 'red',
            title: t('piiCategories'),
            message: error instanceof Error ? error.message : 'Unknown error',
          });
        }
      } finally {
        if (!cancelled) setCatalogLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [locale, t]);

  // Debounced format detection: any content change invalidates the previous
  // detection AND a manual override (the override belongs to the old content).
  useEffect(() => {
    setDetect(null);
    setFormatOverride(null);
    if (!content.trim()) {
      setDetecting(false);
      return;
    }
    let cancelled = false;
    setDetecting(true);
    const timer = setTimeout(async () => {
      try {
        const res = await fetch('/api/dataset-import/detect', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content }),
        });
        const payload = await res.json();
        if (!res.ok) throw new Error(payload.error ?? 'Detection failed');
        if (!cancelled) setDetect(payload as DetectResponse);
      } catch (error) {
        if (!cancelled) {
          notifications.show({
            color: 'red',
            title: t('detect'),
            message: error instanceof Error ? error.message : 'Unknown error',
          });
        }
      } finally {
        if (!cancelled) setDetecting(false);
      }
    }, DETECT_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [content, t]);

  const applyContent = (next: string, from: ContentOrigin) => {
    setContent(next);
    setOrigin(next ? from : null);
  };

  const onFileChange = async (picked: File | null) => {
    setFile(picked);
    if (!picked) return;
    if (picked.size > MAX_IMPORT_BYTES) {
      setFile(null);
      notifications.show({ color: 'red', title: t('source'), message: t('fileTooLarge') });
      return;
    }
    try {
      const text = await picked.text();
      applyContent(text, 'file');
    } catch {
      notifications.show({ color: 'red', title: t('source'), message: t('fileReadError') });
    }
  };

  const fetchFromUrl = async () => {
    const target = url.trim();
    if (!target) return;
    setFetching(true);
    try {
      const res = await fetch('/api/dataset-import/fetch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: target }),
      });
      const payload = await res.json();
      if (!res.ok) throw new Error(payload.error ?? 'Fetch failed');
      applyContent(String(payload.content ?? ''), 'url');
    } catch (error) {
      notifications.show({
        color: 'red',
        title: t('fetch'),
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    } finally {
      setFetching(false);
    }
  };

  const contentBytes = useMemo(() => utf8ByteLength(content), [content]);
  const contentTooLarge = contentBytes > MAX_IMPORT_BYTES;
  const hasContent = content.trim().length > 0 && !contentTooLarge;

  const effectiveFormat: DatasetImportFormat | null =
    formatOverride ?? (isDatasetImportFormat(detect?.format) ? detect.format : null);

  const formatOptions = useMemo(
    () => DATASET_IMPORT_FORMATS.map((id) => ({ value: id, label: t(`formats.${id}`) })),
    [t],
  );

  const suggestedName = useMemo(
    () => defaultDatasetName(effectiveFormat),
    [effectiveFormat],
  );
  const effectiveName = nameEdited ? name : suggestedName;

  const anonymizationReady = selectedCategories.size > 0;
  const canCreate =
    hasContent &&
    effectiveFormat !== null &&
    anonymizationReady &&
    effectiveName.trim().length > 0 &&
    !catalogLoading;

  const create = async () => {
    if (!canCreate || !effectiveFormat) return;
    setCreating(true);
    try {
      const res = await fetch('/api/dataset-import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content,
          format: effectiveFormat,
          name: effectiveName.trim(),
          ...(sourceLabel.trim() ? { sourceLabel: sourceLabel.trim() } : {}),
          anonymize: {
            categories: Array.from(selectedCategories),
            strategy,
            // Empty ⇒ omitted ⇒ the server generates a per-request salt.
            ...(salt.trim() ? { salt: salt.trim() } : {}),
          },
        }),
      });
      const payload = await res.json();
      if (!res.ok) throw new Error(payload.error ?? 'Import failed');
      setCreated(payload as ImportResult);
    } catch (error) {
      notifications.show({
        color: 'red',
        title: t('create'),
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    } finally {
      setCreating(false);
    }
  };

  const close = () => router.push('/dashboard/evaluations/datasets');
  const openDataset = () => {
    if (created) router.push(`/dashboard/evaluations/datasets/${created.datasetId}`);
  };

  const toggleCategory = (id: string, checked: boolean) => {
    setSelectedCategories((current) => {
      const next = new Set(current);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  };

  const originLabel =
    origin === 'paste'
      ? t('originPaste')
      : origin === 'file'
        ? t('originFile')
        : origin === 'url'
          ? t('originUrl')
          : '—';

  const skippedEntries = detect ? Object.entries(detect.preview.counts.skipped) : [];
  const skippedTotal = skippedEntries.reduce((sum, [, n]) => sum + n, 0);

  const summary = (
    <>
      <SummaryGroup title={t('source')}>
        <SummaryKV label={t('contentOrigin')} value={originLabel} />
        <SummaryKV label={t('contentBytes')} value={content ? formatBytes(contentBytes) : '—'} mono />
        <SummaryKV
          label={t('detectedFormat')}
          value={effectiveFormat ?? '—'}
          mono
        />
        {sourceLabel.trim() ? (
          <SummaryKV label={t('sourceLabelField')} value={sourceLabel.trim()} mono />
        ) : null}
      </SummaryGroup>
      {detect ? (
        <SummaryGroup title={t('preview')}>
          <SummaryKV label={t('parsed')} value={detect.preview.counts.parsed} />
          <SummaryKV label={t('skipped')} value={skippedTotal} />
        </SummaryGroup>
      ) : null}
      <SummaryGroup title={t('anonymization')}>
        <SummaryKV label={t('piiCategories')} value={selectedCategories.size} />
        <SummaryKV
          label={t('strategy')}
          value={strategy === 'mask' ? 'mask' : 'pseudonym'}
          mono
        />
        {strategy === 'pseudonym' ? (
          <SummaryKV
            label={t('salt')}
            value={salt.trim() ? t('saltCustom') : t('saltServer')}
          />
        ) : null}
      </SummaryGroup>
      <SummaryGroup>
        <Checklist
          items={[
            { id: 'content', label: t('source'), done: hasContent },
            { id: 'format', label: t('detect'), done: effectiveFormat !== null },
            { id: 'anon', label: t('anonymization'), done: anonymizationReady },
            { id: 'name', label: t('datasetName'), done: effectiveName.trim().length > 0 },
          ]}
        />
      </SummaryGroup>
    </>
  );

  const successContent = created ? (
    <div className="ds-col" style={{ alignItems: 'center', gap: 16, padding: '48px 24px' }}>
      <span
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 44,
          height: 44,
          borderRadius: '50%',
          background: 'var(--ds-accent-soft, rgba(20,184,166,0.12))',
          color: 'var(--ds-accent, teal)',
        }}
      >
        <IconCheck size={22} stroke={2.2} />
      </span>
      <div style={{ textAlign: 'center' }}>
        <Text fw={600}>{t('created')}</Text>
        <Text size="sm" c="dimmed">{effectiveName.trim()}</Text>
      </div>
      <Table withTableBorder verticalSpacing="xs" style={{ maxWidth: 440 }}>
        <Table.Tbody>
          <Table.Tr>
            <Table.Td><Text size="sm" fw={600}>{t('createdCount')}</Text></Table.Td>
            <Table.Td align="right"><Text size="sm" fw={600}>{created.created}</Text></Table.Td>
          </Table.Tr>
          {Object.entries(created.skipped).map(([reason, count]) => (
            <Table.Tr key={reason}>
              <Table.Td>
                {t('skipped')} · <span className="ds-mono" style={{ fontSize: 12 }}>{reason}</span>
              </Table.Td>
              <Table.Td align="right">{count}</Table.Td>
            </Table.Tr>
          ))}
          <Table.Tr>
            <Table.Td>{t('piiFindings')}</Table.Td>
            <Table.Td align="right">{created.piiFindings}</Table.Td>
          </Table.Tr>
        </Table.Tbody>
      </Table>
      <Button
        color="teal"
        leftSection={<IconDatabase size={14} stroke={1.7} />}
        onClick={openDataset}
      >
        {t('openDataset')}
      </Button>
    </div>
  ) : null;

  return (
    <FormShell
      open
      onClose={close}
      icon={<IconFileImport size={16} />}
      title={t('title')}
      subtitle={t('subtitle')}
      summary={summary}
      footerStatus={
        created
          ? `${t('createdCount')}: ${created.created}`
          : detect
            ? `${t('parsed')}: ${detect.preview.counts.parsed}`
            : undefined
      }
      primaryAction={
        created
          ? {
            label: t('openDataset'),
            icon: <IconDatabase size={13} />,
            onClick: openDataset,
          }
          : {
            label: t('create'),
            icon: <IconFileImport size={13} />,
            loading: creating,
            disabled: !canCreate,
            onClick: () => void create(),
          }
      }
    >
      {created ? successContent : (
        <>
          <FormSection number={1} title={t('source')} done={hasContent}>
            <FormField label={t('pasteLabel')}>
              <Textarea
                size="sm"
                minRows={6}
                maxRows={12}
                autosize
                value={pasteText}
                placeholder={t('pastePlaceholder')}
                styles={{ input: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 12 } }}
                onChange={(e) => {
                  setPasteText(e.currentTarget.value);
                  applyContent(e.currentTarget.value, 'paste');
                }}
              />
            </FormField>
            <FormRow cols={2}>
              <FormField label={t('fileLabel')} hint={t('fileHint')}>
                <FileInput
                  size="sm"
                  accept=".jsonl,.json,.txt"
                  clearable
                  value={file}
                  placeholder={t('filePlaceholder')}
                  onChange={(picked) => void onFileChange(picked)}
                />
              </FormField>
              <FormField label={t('urlLabel')} hint={t('urlHint')}>
                <Group gap={8} wrap="nowrap" align="flex-start">
                  <TextInput
                    size="sm"
                    style={{ flex: 1 }}
                    value={url}
                    placeholder="https://…"
                    onChange={(e) => setUrl(e.currentTarget.value)}
                  />
                  <Button
                    variant="default"
                    size="sm"
                    leftSection={<IconDownload size={14} stroke={1.7} />}
                    loading={fetching}
                    disabled={!url.trim()}
                    onClick={() => void fetchFromUrl()}
                  >
                    {t('fetch')}
                  </Button>
                </Group>
              </FormField>
            </FormRow>
            <Group gap={8}>
              {content ? (
                <>
                  <Badge variant="light" color={contentTooLarge ? 'red' : 'teal'}>
                    {formatBytes(contentBytes)}
                  </Badge>
                  <Text size="xs" c="dimmed">
                    {t('contentOrigin')}: {originLabel}
                  </Text>
                </>
              ) : (
                <Text size="xs" c="dimmed">{t('noContent')}</Text>
              )}
            </Group>
            {contentTooLarge ? (
              <Alert color="red" variant="light" p="xs">{t('contentTooLarge')}</Alert>
            ) : null}
          </FormSection>

          <FormSection number={2} title={t('detect')} done={effectiveFormat !== null}>
            <FormRow cols={2}>
              <FormField label={t('detectedFormat')}>
                <Group gap={8} py={4}>
                  {detecting ? (
                    <>
                      <Loader size="xs" />
                      <Text size="sm" c="dimmed">{t('detecting')}</Text>
                    </>
                  ) : detect?.format ? (
                    <Badge variant="light" color="teal" className="ds-mono">
                      {detect.format}
                    </Badge>
                  ) : detect ? (
                    <Badge variant="light" color="orange">{t('formatUnknown')}</Badge>
                  ) : (
                    <Text size="sm" c="dimmed">—</Text>
                  )}
                </Group>
              </FormField>
              <FormField label={t('formatOverride')} optional hint={t('formatOverrideHint')}>
                <Select
                  size="sm"
                  clearable
                  value={formatOverride}
                  onChange={(v) => setFormatOverride(isDatasetImportFormat(v) ? v : null)}
                  data={formatOptions}
                  placeholder={detect?.format ? t(`formats.${detect.format}`) : '—'}
                />
              </FormField>
            </FormRow>
            {detect ? (
              <>
                <div className="ds-stat-grid" style={{ marginBottom: 12 }}>
                  <StatTile label={t('parsed')} value={detect.preview.counts.parsed} />
                  <StatTile label={t('skipped')} value={skippedTotal} />
                </div>
                {skippedEntries.length > 0 ? (
                  <Group gap={6} mb={12}>
                    {skippedEntries.map(([reason, count]) => (
                      <Badge key={reason} variant="light" color="orange" className="ds-mono">
                        {reason}: {count}
                      </Badge>
                    ))}
                  </Group>
                ) : null}
                {detect.preview.items.length > 0 ? (
                  <>
                    <Alert color="orange" variant="light" p="xs" mb={12}>
                      {t('previewRawWarning')}
                    </Alert>
                    <Table withTableBorder verticalSpacing="xs">
                      <Table.Thead>
                        <Table.Tr>
                          <Table.Th style={{ width: 36 }}>#</Table.Th>
                          <Table.Th>{t('previewMessages')}</Table.Th>
                          <Table.Th style={{ width: 80, textAlign: 'right' }}>{t('previewTools')}</Table.Th>
                          <Table.Th style={{ width: 100, textAlign: 'center' }}>{t('previewReference')}</Table.Th>
                          <Table.Th style={{ width: 130, textAlign: 'right' }}>{t('previewToolCalls')}</Table.Th>
                        </Table.Tr>
                      </Table.Thead>
                      <Table.Tbody>
                        {detect.preview.items.map((item, index) => (
                          <Table.Tr key={index}>
                            <Table.Td><Text size="xs" c="dimmed">{index + 1}</Text></Table.Td>
                            <Table.Td>
                              <div className="ds-col" style={{ gap: 3 }}>
                                {item.input.slice(0, PREVIEW_MESSAGES_SHOWN).map((message, mi) => (
                                  <Group key={mi} gap={6} wrap="nowrap">
                                    <Badge
                                      size="xs"
                                      variant="light"
                                      color={ROLE_COLOR[message.role] ?? 'gray'}
                                    >
                                      {message.role}
                                    </Badge>
                                    <span className="ds-mono" style={{ fontSize: 11 }}>
                                      {truncateText(messageText(message.content), 100)}
                                    </span>
                                  </Group>
                                ))}
                                {item.input.length > PREVIEW_MESSAGES_SHOWN ? (
                                  <Text size="xs" c="dimmed">
                                    {t('previewMore', { count: item.input.length - PREVIEW_MESSAGES_SHOWN })}
                                  </Text>
                                ) : null}
                              </div>
                            </Table.Td>
                            <Table.Td align="right">{item.tools?.length ?? 0}</Table.Td>
                            <Table.Td align="center">
                              {item.expected?.reference ? (
                                <IconCheck size={14} stroke={2} color="var(--ds-accent, teal)" />
                              ) : (
                                <Text size="xs" c="dimmed" component="span">—</Text>
                              )}
                            </Table.Td>
                            <Table.Td align="right">{item.expected?.toolCalls?.length ?? 0}</Table.Td>
                          </Table.Tr>
                        ))}
                      </Table.Tbody>
                    </Table>
                  </>
                ) : null}
              </>
            ) : !detecting ? (
              <Text size="xs" c="dimmed">{t('detectEmpty')}</Text>
            ) : null}
          </FormSection>

          <FormSection
            number={3}
            title={t('anonymization')}
            done={anonymizationReady}
            description={
              <Alert
                color="teal"
                variant="light"
                icon={<IconShieldLock size={15} />}
                p="xs"
              >
                {t('anonymizationRequired')}
              </Alert>
            }
          >
            <FormField label={t('piiCategories')} required>
              {catalogLoading ? (
                <Group gap={8} py="sm">
                  <Loader size="xs" />
                  <Text size="sm" c="dimmed">{t('piiCategories')}…</Text>
                </Group>
              ) : (
                <ToggleList>
                  {catalog.map((category) => (
                    <ToggleRow
                      key={category.id}
                      checked={selectedCategories.has(category.id)}
                      onChange={(checked) => toggleCategory(category.id, checked)}
                      label={
                        <Group gap={6} wrap="nowrap">
                          <span>{category.label}</span>
                          <Badge size="xs" variant="light" color={SEVERITY_COLOR[category.severity]}>
                            {tSeverity(category.severity)}
                          </Badge>
                        </Group>
                      }
                      description={category.description}
                    />
                  ))}
                </ToggleList>
              )}
              {!catalogLoading && !anonymizationReady ? (
                <Text size="xs" c="red" mt={6}>{t('categoriesRequired')}</Text>
              ) : null}
            </FormField>
            <FormField label={t('strategy')} required>
              <Radio.Group value={strategy} onChange={(v) => setStrategy(v as Strategy)}>
                <div className="ds-col" style={{ gap: 8, paddingTop: 4 }}>
                  <Radio value="mask" label={t('strategyMask')} />
                  <Radio value="pseudonym" label={t('strategyPseudonym')} />
                </div>
              </Radio.Group>
            </FormField>
            {strategy === 'pseudonym' ? (
              <FormField label={t('salt')} optional hint={t('saltHint')}>
                <TextInput
                  size="sm"
                  value={salt}
                  onChange={(e) => setSalt(e.currentTarget.value)}
                  placeholder={t('saltServer')}
                />
              </FormField>
            ) : null}
          </FormSection>

          <FormSection
            number={4}
            title={t('create')}
            done={effectiveName.trim().length > 0}
            description={
              <Alert
                color="blue"
                variant="light"
                icon={<IconInfoCircle size={15} />}
                p="xs"
              >
                {t('evalOnlyNote')}
              </Alert>
            }
          >
            <FormRow cols={2}>
              <FormField label={t('datasetName')} required>
                <TextInput
                  size="sm"
                  value={effectiveName}
                  onChange={(e) => {
                    setName(e.currentTarget.value);
                    setNameEdited(true);
                  }}
                />
              </FormField>
              <FormField label={t('sourceLabelField')} optional hint={t('sourceLabelHint')}>
                <TextInput
                  size="sm"
                  value={sourceLabel}
                  onChange={(e) => setSourceLabel(e.currentTarget.value)}
                  placeholder="azure-apim prod"
                />
              </FormField>
            </FormRow>
          </FormSection>
        </>
      )}
    </FormShell>
  );
}
