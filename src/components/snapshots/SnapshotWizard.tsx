'use client';

/**
 * SnapshotWizard — full-screen FormShell wizard that samples production
 * traffic (gateway model-usage logs or agent tracing sessions) into an
 * evaluation dataset behind the mandatory PII anonymization gate.
 *
 * Sections:
 *   1. Source        — gateway | tracing, date range, model/agent, status
 *   2. Sampling      — deterministic samplePct + max items (server cap 1000)
 *   3. Anonymization — REQUIRED: built-in PII categories (served localized by
 *                      GET /api/pii/categories), mask|pseudonym strategy, and
 *                      an optional stable salt (same salt ⇒ same pseudonym
 *                      tokens across snapshots; empty ⇒ server generates one
 *                      per run and never persists/echoes it)
 *   4. Preview       — POST /api/snapshots/preview (counts only, no payloads)
 *   5. Create        — POST /api/snapshots, then a success screen with
 *                      created/skipped/PII-finding counts and a link to the
 *                      dataset detail page
 *
 * Prefill via query params: ?source=tracing&agent=<name>&model=<key>
 * (used by the tracing sessions entry point).
 *
 * Full-screen FormShell overlay per the project rule for create/edit
 * surfaces (small Mantine Modals are reserved for confirms).
 */

import { useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  Alert,
  Badge,
  Button,
  Group,
  Loader,
  NumberInput,
  Radio,
  Select,
  Table,
  Text,
  TextInput,
} from '@mantine/core';
import { DatePickerInput } from '@mantine/dates';
import { notifications } from '@mantine/notifications';
import {
  IconCalendar,
  IconCamera,
  IconCheck,
  IconDatabase,
  IconRobot,
  IconSearch,
  IconServer,
  IconShieldLock,
} from '@tabler/icons-react';
import FormShell, {
  Checklist,
  FormField,
  FormRow,
  FormSection,
  SliderField,
  SourceCard,
  SourceToggle,
  SummaryGroup,
  SummaryKV,
  ToggleList,
  ToggleRow,
} from '@/components/common/ui/FormShell';
import StatTile from '@/components/common/ui/StatTile';
import { useLocale, useTranslations } from '@/lib/i18n';
import { parseLocalDate } from '@/lib/utils/dashboardDateFilter';
import type {
  CreateSnapshotResult,
  SnapshotPreview,
  SnapshotSource,
} from '@/lib/services/snapshots/types';

type StatusFilter = 'all' | 'success' | 'error';
type Strategy = 'mask' | 'pseudonym';

/** Row shape of GET /api/pii/categories → categories[]. */
interface PiiCategoryOption {
  id: string;
  label: string;
  description: string;
  severity: 'low' | 'medium' | 'high';
  defaultEnabled: boolean;
}

const SEVERITY_COLOR: Record<PiiCategoryOption['severity'], string> = {
  low: 'gray',
  medium: 'orange',
  high: 'red',
};

const SNAPSHOT_MAX_ITEMS = 1000;

function toShortDate(date: Date): string {
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${mm}-${dd}`;
}

/** Last millisecond of the picked day, so `to` includes the whole day. */
function endOfDay(date: Date): Date {
  return new Date(
    new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1).getTime() - 1,
  );
}

export default function SnapshotWizard() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const t = useTranslations('snapshots');
  const tSeverity = useTranslations('pii.severity');
  const locale = useLocale();

  // ── 1. Source ──
  const [source, setSource] = useState<SnapshotSource>(() =>
    searchParams.get('source') === 'tracing' ? 'tracing' : 'gateway');
  const [dateRange, setDateRange] = useState<[Date | null, Date | null]>(() => [
    parseLocalDate(searchParams.get('from')),
    parseLocalDate(searchParams.get('to')),
  ]);
  const [modelKey, setModelKey] = useState<string | null>(
    () => searchParams.get('model') || null,
  );
  const [agentName, setAgentName] = useState(
    () => searchParams.get('agent')?.trim() ?? '',
  );
  const [status, setStatus] = useState<StatusFilter>(() => {
    const raw = searchParams.get('status');
    return raw === 'success' || raw === 'error' ? raw : 'all';
  });
  const [models, setModels] = useState<Array<{ value: string; label: string }>>([]);
  const [agents, setAgents] = useState<string[]>([]);

  // ── 2. Sampling ──
  const [samplePct, setSamplePct] = useState(100);
  const [maxItems, setMaxItems] = useState<number | string>(SNAPSHOT_MAX_ITEMS);

  // ── 3. Anonymization (required) ──
  const [catalog, setCatalog] = useState<PiiCategoryOption[]>([]);
  const [catalogLoading, setCatalogLoading] = useState(true);
  const [selectedCategories, setSelectedCategories] = useState<Set<string>>(new Set());
  const [strategy, setStrategy] = useState<Strategy>('mask');
  const [salt, setSalt] = useState('');

  // ── 4. Preview ──
  const [preview, setPreview] = useState<SnapshotPreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  // ── 5. Create ──
  const [name, setName] = useState('');
  const [nameEdited, setNameEdited] = useState(false);
  const [description, setDescription] = useState('');
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<CreateSnapshotResult | null>(null);
  // Background job tracking: creation runs on the queue; we poll the dataset's
  // metadata.snapshot.status until it goes ready/failed.
  const [jobDatasetId, setJobDatasetId] = useState<string | null>(null);
  const [jobStatus, setJobStatus] = useState<'pending' | 'running' | 'failed'>('pending');
  const [jobError, setJobError] = useState<string | null>(null);

  useEffect(() => {
    if (!jobDatasetId || created || jobStatus === 'failed') return;
    let cancelled = false;
    const tick = async () => {
      try {
        const res = await fetch(`/api/evaluation/datasets/${jobDatasetId}`, { cache: 'no-store' });
        if (!res.ok) return;
        const payload = await res.json();
        const dataset = payload?.dataset;
        const snap = dataset?.metadata?.snapshot;
        if (cancelled || !snap) return;
        if (snap.status === 'ready') {
          setCreated({
            dataset: {
              id: dataset.id ?? jobDatasetId,
              key: dataset.key ?? '',
              name: dataset.name ?? '',
            },
            source: snap.source,
            matching: snap.counts?.matching ?? 0,
            sampled: snap.counts?.sampled ?? 0,
            created: snap.counts?.created ?? 0,
            skipped: snap.counts?.skipped ?? { truncatedPayload: 0, missingMessages: 0, unmappable: 0, sizeCapped: 0 },
            piiFindings: snap.piiFindings ?? 0,
          });
        } else if (snap.status === 'failed') {
          setJobStatus('failed');
          setJobError(typeof snap.error === 'string' ? snap.error : null);
        } else if (snap.status === 'running' || snap.status === 'pending') {
          setJobStatus(snap.status);
        }
      } catch {
        // Transient poll failure — next tick retries.
      }
    };
    void tick();
    const id = window.setInterval(() => { void tick(); }, 2500);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [jobDatasetId, created, jobStatus]);

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

  // Filter dropdown options, fed from observability (usage rollup): agents =
  // tracing agent names actually seen, models = gateway-served model keys.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/snapshots/filters', { cache: 'no-store' });
        if (!res.ok) return;
        const payload = await res.json();
        if (cancelled) return;
        setModels(
          (payload.gatewayModels ?? []).map((key: string) => ({ value: key, label: key })),
        );
        setAgents(payload.agents ?? []);
      } catch {
        // Non-fatal: the filters simply stay empty.
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Any filter change invalidates a previously fetched preview.
  const filterKey = useMemo(
    () =>
      JSON.stringify({
        source,
        from: dateRange[0]?.getTime() ?? null,
        to: dateRange[1]?.getTime() ?? null,
        modelKey,
        agentName,
        status,
        samplePct,
        maxItems,
      }),
    [source, dateRange, modelKey, agentName, status, samplePct, maxItems],
  );
  useEffect(() => { setPreview(null); }, [filterKey]);

  const buildFilterBody = (): Record<string, unknown> => {
    const body: Record<string, unknown> = { source, samplePct };
    const limit = Number(maxItems);
    if (Number.isFinite(limit) && limit > 0) body.limit = limit;
    if (dateRange[0]) body.from = dateRange[0].toISOString();
    if (dateRange[1]) body.to = endOfDay(dateRange[1]).toISOString();
    if (source === 'gateway' && modelKey) body.modelKey = modelKey;
    if (source === 'tracing' && agentName.trim()) body.agentName = agentName.trim();
    if (status !== 'all') body.status = status;
    return body;
  };

  const suggestedName = useMemo(() => {
    const from = dateRange[0] ? toShortDate(dateRange[0]) : null;
    const to = dateRange[1] ? toShortDate(dateRange[1]) : null;
    const dates = from && to ? `${from}–${to}` : (from ?? to ?? toShortDate(new Date()));
    return `snapshot ${source} ${dates}`;
  }, [source, dateRange]);
  const effectiveName = nameEdited ? name : suggestedName;

  const runPreview = async () => {
    setPreviewLoading(true);
    try {
      const res = await fetch('/api/snapshots/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildFilterBody()),
      });
      const payload = await res.json();
      if (!res.ok) throw new Error(payload.error ?? 'Preview failed');
      setPreview(payload as SnapshotPreview);
    } catch (error) {
      notifications.show({
        color: 'red',
        title: t('preview'),
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    } finally {
      setPreviewLoading(false);
    }
  };

  const anonymizationReady = selectedCategories.size > 0;
  const canCreate = anonymizationReady && effectiveName.trim().length > 0 && !catalogLoading;

  const create = async () => {
    if (!canCreate) return;
    setCreating(true);
    try {
      const res = await fetch('/api/snapshots', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...buildFilterBody(),
          name: effectiveName.trim(),
          ...(description.trim() ? { description: description.trim() } : {}),
          anonymize: {
            categories: Array.from(selectedCategories),
            strategy,
            // Empty ⇒ omitted ⇒ the server generates a per-request salt.
            ...(salt.trim() ? { salt: salt.trim() } : {}),
          },
        }),
      });
      const payload = await res.json();
      if (!res.ok) throw new Error(payload.error ?? 'Snapshot creation failed');
      // 202: the job runs in the background — start polling the dataset.
      setJobStatus('pending');
      setJobError(null);
      setJobDatasetId(payload.datasetId as string);
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
    const id = created?.dataset.id ?? jobDatasetId;
    if (id) router.push(`/dashboard/evaluations/datasets/${id}`);
  };

  const toggleCategory = (id: string, checked: boolean) => {
    setSelectedCategories((current) => {
      const next = new Set(current);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  };

  const sourceLabel = source === 'gateway' ? t('sourceGateway') : t('sourceTracing');
  const breakdownKeyLabel = source === 'gateway' ? t('model') : t('agent');

  const summary = (
    <>
      <SummaryGroup title={t('source')}>
        <SummaryKV label={t('source')} value={sourceLabel} />
        <SummaryKV
          label={t('dateRange')}
          value={
            dateRange[0] || dateRange[1]
              ? `${dateRange[0] ? toShortDate(dateRange[0]) : '…'} – ${dateRange[1] ? toShortDate(dateRange[1]) : '…'}`
              : '—'
          }
        />
        {source === 'gateway' ? (
          <SummaryKV label={t('model')} value={modelKey ?? '—'} mono />
        ) : (
          <SummaryKV label={t('agent')} value={agentName.trim() || '—'} mono />
        )}
        <SummaryKV
          label={t('status')}
          value={status === 'all' ? t('statusAll') : status === 'success' ? t('statusSuccess') : t('statusError')}
        />
        <SummaryKV label={t('samplePct')} value={`${samplePct}%`} />
        <SummaryKV label={t('maxItems')} value={String(Number(maxItems) || SNAPSHOT_MAX_ITEMS)} />
      </SummaryGroup>
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
      {preview ? (
        <SummaryGroup title={t('preview')}>
          <SummaryKV label={t('previewMatching')} value={preview.matching} />
          <SummaryKV label={t('previewSampled')} value={preview.sampled} />
          <SummaryKV label={t('previewWouldCreate')} value={preview.wouldCreate} />
        </SummaryGroup>
      ) : null}
      <SummaryGroup>
        <Checklist
          items={[
            { id: 'source', label: t('source'), done: true },
            { id: 'anon', label: t('anonymization'), done: anonymizationReady },
            { id: 'preview', label: t('preview'), done: preview !== null },
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
        <Text size="sm" c="dimmed">{created.dataset.name}</Text>
      </div>
      <Table withTableBorder verticalSpacing="xs" style={{ maxWidth: 440 }}>
        <Table.Tbody>
          <Table.Tr>
            <Table.Td>{t('previewMatching')}</Table.Td>
            <Table.Td align="right">{created.matching}</Table.Td>
          </Table.Tr>
          <Table.Tr>
            <Table.Td>{t('previewSampled')}</Table.Td>
            <Table.Td align="right">{created.sampled}</Table.Td>
          </Table.Tr>
          <Table.Tr>
            <Table.Td><Text size="sm" fw={600}>{t('createdCount')}</Text></Table.Td>
            <Table.Td align="right"><Text size="sm" fw={600}>{created.created}</Text></Table.Td>
          </Table.Tr>
          <Table.Tr>
            <Table.Td>{t('skippedRows')} · {t('skippedTruncated')}</Table.Td>
            <Table.Td align="right">{created.skipped.truncatedPayload}</Table.Td>
          </Table.Tr>
          <Table.Tr>
            <Table.Td>{t('skippedRows')} · {t('skippedNoMessages')}</Table.Td>
            <Table.Td align="right">{created.skipped.missingMessages}</Table.Td>
          </Table.Tr>
          <Table.Tr>
            <Table.Td>{t('skippedRows')} · {t('skippedUnmappable')}</Table.Td>
            <Table.Td align="right">{created.skipped.unmappable}</Table.Td>
          </Table.Tr>
          {created.skipped.sizeCapped > 0 ? (
            <Table.Tr>
              <Table.Td>{t('skippedRows')} · {t('skippedSizeCapped')}</Table.Td>
              <Table.Td align="right">{created.skipped.sizeCapped}</Table.Td>
            </Table.Tr>
          ) : null}
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

  const jobActive = jobDatasetId !== null && !created;

  const jobContent = jobActive ? (
    <div className="ds-col" style={{ gap: 16, alignItems: 'flex-start' }}>
      {jobStatus === 'failed' ? (
        <>
          <Alert color="red" variant="light" title={t('jobFailedTitle')}>
            {jobError ?? '—'}
          </Alert>
          <Button
            variant="default"
            onClick={() => { setJobDatasetId(null); setJobError(null); setJobStatus('pending'); }}
          >
            {t('jobRetry')}
          </Button>
        </>
      ) : (
        <>
          <Group gap="sm">
            <Loader size="sm" />
            <Text fw={600}>{t('jobRunningTitle')}</Text>
            <Badge variant="light" color={jobStatus === 'running' ? 'teal' : 'gray'}>
              {jobStatus === 'running' ? t('jobStatusRunning') : t('jobStatusPending')}
            </Badge>
          </Group>
          <Text size="sm" c="dimmed">{t('jobRunningHint')}</Text>
        </>
      )}
    </div>
  ) : null;

  return (
    <FormShell
      open
      onClose={close}
      icon={<IconCamera size={16} />}
      title={t('title')}
      subtitle={t('subtitle')}
      summary={summary}
      footerStatus={
        created
          ? `${t('createdCount')}: ${created.created}`
          : jobActive && jobStatus !== 'failed'
            ? (jobStatus === 'running' ? t('jobStatusRunning') : t('jobStatusPending'))
            : preview
              ? `${t('previewWouldCreate')}: ${preview.wouldCreate}`
              : undefined
      }
      primaryAction={
        created
          ? {
            label: t('openDataset'),
            icon: <IconDatabase size={13} />,
            onClick: openDataset,
          }
          : jobActive
            ? {
              label: t('jobViewDatasets'),
              icon: <IconDatabase size={13} />,
              onClick: close,
            }
            : {
              label: t('create'),
              icon: <IconCamera size={13} />,
              loading: creating,
              disabled: !canCreate,
              onClick: () => void create(),
            }
      }
    >
      {created ? successContent : jobActive ? jobContent : (
        <>
          <FormSection number={1} title={t('source')} done>
            <SourceToggle>
              <SourceCard
                selected={source === 'gateway'}
                onClick={() => setSource('gateway')}
                icon={<IconServer size={15} stroke={1.7} />}
                title={t('sourceGateway')}
                description={t('sourceGatewayDesc')}
              />
              <SourceCard
                selected={source === 'tracing'}
                onClick={() => setSource('tracing')}
                icon={<IconRobot size={15} stroke={1.7} />}
                title={t('sourceTracing')}
                description={t('sourceTracingDesc')}
              />
            </SourceToggle>
            <FormRow cols={2}>
              <FormField label={t('dateRange')} optional>
                <DatePickerInput
                  type="range"
                  value={dateRange}
                  clearable
                  size="sm"
                  placeholder={`${t('from')} – ${t('to')}`}
                  valueFormat="MMM D, YYYY"
                  leftSection={<IconCalendar size={14} stroke={1.5} />}
                  onChange={(range) => {
                    // Mantine 8 emits 'YYYY-MM-DD' strings — normalize to local Dates.
                    setDateRange([parseLocalDate(range[0]), parseLocalDate(range[1])]);
                  }}
                />
              </FormField>
              <FormField label={t('status')}>
                <Select
                  size="sm"
                  value={status}
                  onChange={(v) => setStatus((v as StatusFilter | null) ?? 'all')}
                  data={[
                    { value: 'all', label: t('statusAll') },
                    { value: 'success', label: t('statusSuccess') },
                    { value: 'error', label: t('statusError') },
                  ]}
                />
              </FormField>
            </FormRow>
            <FormRow cols={2}>
              {source === 'gateway' ? (
                <FormField label={t('model')} optional>
                  <Select
                    size="sm"
                    searchable
                    clearable
                    value={modelKey}
                    onChange={setModelKey}
                    data={models}
                    placeholder="—"
                  />
                </FormField>
              ) : (
                <FormField label={t('agent')} optional>
                  <Select
                    size="sm"
                    searchable
                    clearable
                    value={agentName || null}
                    onChange={(v) => setAgentName(v ?? '')}
                    data={
                      // Keep a query-param prefill selectable even when it is
                      // not in the observed list (e.g. traffic older than the
                      // options window).
                      agentName && !agents.includes(agentName)
                        ? [agentName, ...agents]
                        : agents
                    }
                    placeholder="—"
                  />
                </FormField>
              )}
            </FormRow>
          </FormSection>

          <FormSection number={2} title={t('sampling')} done>
            <FormRow cols={2}>
              <FormField label={t('samplePct')} hint={t('samplePctHint')}>
                <SliderField
                  value={samplePct}
                  onChange={setSamplePct}
                  min={1}
                  max={100}
                  formatValue={(v) => `${v}%`}
                />
              </FormField>
              <FormField label={t('maxItems')}>
                <NumberInput
                  size="sm"
                  min={1}
                  max={SNAPSHOT_MAX_ITEMS}
                  value={maxItems}
                  onChange={setMaxItems}
                />
              </FormField>
            </FormRow>
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

          <FormSection number={4} title={t('preview')} done={preview !== null}>
            <Group gap="sm" mb={preview ? 12 : 0}>
              <Button
                variant="default"
                size="sm"
                leftSection={<IconSearch size={14} stroke={1.7} />}
                loading={previewLoading}
                onClick={() => void runPreview()}
              >
                {t('preview')}
              </Button>
              {!preview && !previewLoading ? (
                <Text size="xs" c="dimmed">{t('previewEmpty')}</Text>
              ) : null}
            </Group>
            {preview ? (
              <>
                <div className="ds-stat-grid" style={{ marginBottom: 12 }}>
                  <StatTile label={t('previewMatching')} value={preview.matching} />
                  <StatTile label={t('previewSampled')} value={preview.sampled} />
                  <StatTile label={t('previewWouldCreate')} value={preview.wouldCreate} />
                  <StatTile label={t('previewScanned')} value={preview.scanned} />
                </div>
                {preview.scanCapped ? (
                  <Alert color="orange" variant="light" p="xs" mb={12}>
                    {t('previewScanCapped')}
                  </Alert>
                ) : null}
                {preview.breakdown.length > 0 ? (
                  <Table withTableBorder verticalSpacing="xs">
                    <Table.Thead>
                      <Table.Tr>
                        <Table.Th>{breakdownKeyLabel}</Table.Th>
                        <Table.Th style={{ width: 120, textAlign: 'right' }}>{t('previewMatching')}</Table.Th>
                        <Table.Th style={{ width: 120, textAlign: 'right' }}>{t('previewSampled')}</Table.Th>
                      </Table.Tr>
                    </Table.Thead>
                    <Table.Tbody>
                      {preview.breakdown.map((entry) => (
                        <Table.Tr key={entry.key}>
                          <Table.Td><span className="ds-mono" style={{ fontSize: 12 }}>{entry.key}</span></Table.Td>
                          <Table.Td align="right">{entry.matching}</Table.Td>
                          <Table.Td align="right">{entry.sampled}</Table.Td>
                        </Table.Tr>
                      ))}
                    </Table.Tbody>
                  </Table>
                ) : null}
              </>
            ) : null}
          </FormSection>

          <FormSection
            number={5}
            title={t('create')}
            done={effectiveName.trim().length > 0}
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
              <FormField label={t('description')} optional>
                <TextInput
                  size="sm"
                  value={description}
                  onChange={(e) => setDescription(e.currentTarget.value)}
                />
              </FormField>
            </FormRow>
          </FormSection>
        </>
      )}
    </FormShell>
  );
}
