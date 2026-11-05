'use client';

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ActionIcon, Alert, Badge, Button, Loader, Select, Stack, Switch, Text, TextInput, Tooltip } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import {
  IconAlertCircle,
  IconArrowRight,
  IconBooks,
  IconBrain,
  IconEye,
  IconInfoCircle,
  IconListSearch,
  IconPencil,
  IconPlug,
  IconPlus,
  IconRefresh,
  IconSearch,
  IconTool,
  IconX,
} from '@tabler/icons-react';
import FormShell, {
  ChipPicker,
  FormField,
  FormRow,
  FormSection,
  SummaryGroup,
  SummaryKV,
  type FormShellAction,
} from '@/components/common/ui/FormShell';
import { SkeletonRegion, SkeletonText } from '@/components/common/ui/Skeletons';
import StatusBadge from '@/components/common/ui/StatusBadge';
import { useConfirm } from '@/components/common/confirm/ConfirmProvider';
import { formatRelative } from '@/components/iam/timeFormat';
import { useLocale, useTranslations } from '@/lib/i18n';
import type { IModel, ModelCategory } from '@/lib/database';
import type { ModelProviderView } from '@/lib/services/models/types';
import type { CatalogModel, CatalogNotice, ProviderModelCatalog } from '@/lib/services/models/catalog/types';
import {
  catalogCategoryCounts,
  catalogModelToCreatePayload,
  catalogModelToPrefill,
  filterCatalogModels,
  isCatalogModelRegistered,
  type CatalogCategoryFilter,
  type CreateModelPrefill,
} from './catalogPrefill';
import { noteCatalogModelsCreated, useProviderModelCatalog } from './useProviderModelCatalog';

/** Rows drawn at once. A provider can list a couple of thousand models; the search narrows them. */
const MAX_ROWS = 300;

/** Mantine palette names per category, so a long mixed list reads at a glance. */
const CATEGORY_COLORS: Record<ModelCategory, string> = {
  llm: 'teal',
  embedding: 'violet',
  rerank: 'grape',
  stt: 'blue',
  tts: 'cyan',
  image: 'pink',
  moderation: 'orange',
  ocr: 'indigo',
  decision: 'lime',
};

type Translate = ReturnType<typeof useTranslations>;

export interface ModelCatalogModalProps {
  opened: boolean;
  onClose: () => void;
  providers: ModelProviderView[];
  /** Preselects this provider when the project can use it; otherwise the first active one is shown. */
  defaultProviderKey?: string;
  /** Opens on this category when the provider lists models of it; otherwise on "All". */
  defaultCategory?: ModelCategory;
  /** One model picked ("Configure", or "Continue" with one selected): the create form opens filled in with it. */
  onSelectModel: (prefill: CreateModelPrefill) => void;
  /** "Enter custom model": the create form opens blank, with this provider selected. */
  onCustom: (providerKey?: string) => void;
  /** Models created by "Add N models". */
  onModelsCreated: (models: IModel[], provider: ModelProviderView) => void;
  /** Opens the "Add provider" flow (the project has no model provider yet). */
  onAddProvider?: () => void;
}

/** A message that reads differently for one has a sibling `<key>One` (messages carry no plural rules). */
function countKey(key: string, count: number): string {
  return count === 1 ? `${key}One` : key;
}

/** The provider preselected on opening: the asked-for one when it is usable, else the first active one. */
function pickProvider(providers: ModelProviderView[], preferred?: string): string | undefined {
  const usable = providers.filter((provider) => provider.status !== 'disabled');
  if (preferred && usable.some((provider) => provider.key === preferred)) return preferred;
  return usable[0]?.key;
}

function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${Number((tokens / 1_000_000).toFixed(1))}M`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}K`;
  return String(tokens);
}

function formatPrice(value: number, locale: string): string {
  if (value === 0) return '0';
  const small = value < 0.01;
  return new Intl.NumberFormat(locale, {
    minimumFractionDigits: small ? 0 : 2,
    maximumFractionDigits: small ? 4 : 2,
  }).format(value);
}

function takesImages(model: CatalogModel): boolean {
  return Array.isArray(model.inputModalities) && model.inputModalities.includes('image');
}

export default function ModelCatalogModal({
  opened,
  onClose,
  providers,
  defaultProviderKey,
  defaultCategory,
  onSelectModel,
  onCustom,
  onModelsCreated,
  onAddProvider,
}: ModelCatalogModalProps) {
  const t = useTranslations('modelCatalog');
  const locale = useLocale();
  const { confirm } = useConfirm();
  const [providerKey, setProviderKey] = useState<string | undefined>(undefined);
  const [query, setQuery] = useState('');
  // null = not picked by hand: the default category applies while the provider lists models of it.
  const [chosenCategory, setChosenCategory] = useState<CatalogCategoryFilter | null>(null);
  const [hideRegistered, setHideRegistered] = useState(false);
  // Selected model ids, in the order they were picked.
  const [selected, setSelected] = useState<string[]>([]);
  const [bulk, setBulk] = useState<{ done: number; total: number } | null>(null);
  const cancelBulkRef = useRef(false);
  const wasOpenedRef = useRef(false);

  // Every opening starts on the preselected provider with nothing filtered or picked. The provider is unset while
  // closed, so the opening render does not list a provider that is about to be replaced.
  useEffect(() => {
    if (!opened) {
      wasOpenedRef.current = false;
      setProviderKey(undefined);
      return;
    }
    if (!wasOpenedRef.current) {
      wasOpenedRef.current = true;
      setQuery('');
      setChosenCategory(null);
      setHideRegistered(false);
      setSelected([]);
      setProviderKey(pickProvider(providers, defaultProviderKey));
      return;
    }
    // The provider list changed while open (it loaded late, or a provider was added): keep the pick while usable.
    setProviderKey((current) =>
      current && providers.some((provider) => provider.key === current && provider.status !== 'disabled')
        ? current
        : pickProvider(providers, defaultProviderKey),
    );
  }, [opened, providers, defaultProviderKey]);

  const provider = providers.find((candidate) => candidate.key === providerKey);
  const catalog = useProviderModelCatalog(providerKey, { enabled: opened });
  const data = catalog.data;
  const models = useMemo(() => data?.models ?? [], [data]);

  const searchMatches = useMemo(
    () => filterCatalogModels(models, { query, hideRegistered }),
    [models, query, hideRegistered],
  );
  const presentCategories = useMemo(() => catalogCategoryCounts(models), [models]);
  const matchCounts = useMemo(
    () => new Map(catalogCategoryCounts(searchMatches).map((entry) => [entry.category, entry.count])),
    [searchMatches],
  );
  const fallbackCategory: CatalogCategoryFilter =
    defaultCategory && presentCategories.some((entry) => entry.category === defaultCategory) ? defaultCategory : 'all';
  const category: CatalogCategoryFilter =
    chosenCategory && (chosenCategory === 'all' || presentCategories.some((entry) => entry.category === chosenCategory))
      ? chosenCategory
      : fallbackCategory;
  const visible = useMemo(
    () => (category === 'all' ? searchMatches : searchMatches.filter((model) => model.category === category)),
    [searchMatches, category],
  );
  const rows = visible.slice(0, MAX_ROWS);

  const selectedModels = useMemo(() => {
    const byId = new Map(models.map((model) => [model.id, model]));
    return selected
      .map((id) => byId.get(id))
      .filter((model): model is CatalogModel => Boolean(model) && !isCatalogModelRegistered(model as CatalogModel));
  }, [models, selected]);
  const registeredCount = useMemo(() => models.filter(isCatalogModelRegistered).length, [models]);

  const changeProvider = (key: string) => {
    if (key === providerKey) return;
    setProviderKey(key);
    setSelected([]);
    setChosenCategory(null);
  };

  const toggle = (id: string) =>
    setSelected((current) => (current.includes(id) ? current.filter((entry) => entry !== id) : [...current, id]));

  const configure = (model: CatalogModel) => {
    if (!provider) return;
    onSelectModel(catalogModelToPrefill(model, provider.key));
  };

  const close = () => {
    // Closing while models are being added stops after the one in flight; what was added is still reported.
    if (bulk) cancelBulkRef.current = true;
    onClose();
  };

  const addSelected = async () => {
    if (!provider || selectedModels.length < 2 || bulk) return;
    const target = provider;
    const payloads = selectedModels.map((model) => ({ model, ...catalogModelToCreatePayload(model, target) }));
    const unpriced = payloads.filter((payload) => !payload.priced).length;
    const ok = await confirm({
      title: t('bulk.confirmTitle', { count: payloads.length }),
      message: (
        <span className="ds-col" style={{ gap: 8 }}>
          <span>{t('bulk.confirmMessage', { provider: target.label || target.key })}</span>
          {unpriced > 0 ? <span>{t(countKey('bulk.unpriced', unpriced), { count: unpriced })}</span> : null}
        </span>
      ),
      confirmLabel: t('bulk.confirmLabel'),
      tone: unpriced > 0 ? 'warning' : 'neutral',
    });
    if (!ok) return;

    cancelBulkRef.current = false;
    const created: IModel[] = [];
    let firstError: string | undefined;
    let stopped = false;
    // One at a time: each create checks the project's model quota against what exists, and the keys generated
    // from the names are made unique against the models created just before.
    for (const [index, payload] of payloads.entries()) {
      if (cancelBulkRef.current) {
        stopped = true;
        break;
      }
      setBulk({ done: index + 1, total: payloads.length });
      try {
        const response = await fetch('/api/models', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload.body),
        });
        const body = await response.json().catch(() => null) as { model?: IModel; error?: unknown } | null;
        if (!response.ok || !body?.model) {
          throw new Error(typeof body?.error === 'string' && body.error ? body.error : t('bulk.unknownError'));
        }
        created.push(body.model);
      } catch (error) {
        firstError ??= `${payload.model.id}: ${error instanceof Error ? error.message : t('bulk.unknownError')}`;
      }
    }
    setBulk(null);

    const total = payloads.length;
    const errorLine = firstError ?? t('bulk.stoppedMessage', { created: created.length, total });
    if (created.length === total) {
      notifications.show({
        color: 'green',
        title: t('bulk.doneTitle'),
        message: t(countKey('bulk.doneMessage', created.length), { count: created.length }),
      });
    } else if (created.length > 0) {
      notifications.show({
        color: 'orange',
        title: t('bulk.partialTitle'),
        message: firstError
          ? t('bulk.partialMessage', { created: created.length, total, error: firstError })
          : errorLine,
      });
    } else {
      notifications.show({
        color: 'red',
        title: t('bulk.failedTitle'),
        message: firstError ? t('bulk.failedMessage', { error: firstError }) : errorLine,
      });
    }

    if (created.length > 0) {
      noteCatalogModelsCreated(
        target.key,
        created.map((model) => ({ modelId: model.modelId, key: model.key })),
      );
      onModelsCreated(created, target);
      setSelected([]);
      if (!stopped) onClose();
    }
  };

  const count = selectedModels.length;
  const primaryAction: FormShellAction = bulk
    ? {
        label: t('actions.adding', { done: bulk.done, total: bulk.total }),
        icon: <Loader size={12} color="gray" />,
        disabled: true,
        onClick: () => undefined,
      }
    : count === 0
      ? {
          label: t('actions.selectModel'),
          disabled: true,
          disabledReason: t('actions.selectModelHint'),
          onClick: () => undefined,
        }
      : count === 1
        ? {
            label: t('actions.continue'),
            icon: <IconArrowRight size={13} />,
            onClick: () => configure(selectedModels[0]),
          }
        : {
            label: t('actions.addMany', { count }),
            icon: <IconPlus size={13} />,
            onClick: () => void addSelected(),
          };

  const sourceLabel = data ? t(`summary.${sourceSummaryKey(data.source)}`) : '—';

  const summary = (
    <>
      <SummaryGroup title={t('summary.provider')}>
        {provider ? (
          <>
            <SummaryKV label={t('summary.name')} value={provider.label || provider.key} />
            <SummaryKV label={t('summary.driver')} value={provider.driver} mono />
            <SummaryKV label={t('summary.status')} value={<ProviderStatusBadge status={provider.status} t={t} />} />
          </>
        ) : (
          <SummaryKV label="—" value={<span className="ds-faint">{t('provider.pickHint')}</span>} />
        )}
      </SummaryGroup>
      <SummaryGroup title={t('summary.listing')}>
        <SummaryKV label={t('summary.source')} value={sourceLabel} />
        <SummaryKV label={t('summary.listed')} value={data ? formatRelative(data.fetchedAt, locale) : '—'} />
        <SummaryKV label={t('summary.models')} value={data ? models.length.toLocaleString(locale) : '—'} mono />
        <SummaryKV label={t('summary.added')} value={data ? registeredCount.toLocaleString(locale) : '—'} mono />
        <SummaryKV
          label={t('summary.took')}
          value={data ? t('summary.tookValue', { ms: Math.round(data.latencyMs) }) : '—'}
          mono
        />
      </SummaryGroup>
      <SummaryGroup title={t('summary.selected', { count })}>
        {count === 0 ? (
          <span className="ds-faint" style={{ fontSize: 12.5 }}>{t('summary.nothingSelected')}</span>
        ) : (
          <ul className="ds-col" style={{ gap: 8, listStyle: 'none', margin: 0, padding: 0 }}>
            {selectedModels.map((model) => (
              <li key={model.id} className="ds-row" style={{ gap: 8, flexWrap: 'nowrap', alignItems: 'flex-start' }}>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ fontSize: 12.5, fontWeight: 500, overflowWrap: 'anywhere' }}>{model.name}</div>
                  <div className="ds-faint ds-mono" style={{ fontSize: 11, overflowWrap: 'anywhere' }}>{model.id}</div>
                  <div className="ds-muted ds-mono" style={{ fontSize: 11 }}>
                    {model.pricing ? priceText(model, t, locale) : t('summary.unpriced')}
                  </div>
                </div>
                <ActionIcon
                  variant="subtle"
                  color="gray"
                  size="sm"
                  aria-label={t('summary.remove', { name: model.name })}
                  disabled={Boolean(bulk)}
                  onClick={() => toggle(model.id)}
                >
                  <IconX size={13} />
                </ActionIcon>
              </li>
            ))}
          </ul>
        )}
      </SummaryGroup>
    </>
  );

  const enterManually = (
    <Button size="sm" color="teal" leftSection={<IconPencil size={14} />} onClick={() => onCustom(providerKey)}>
      {t('states.enterManually')}
    </Button>
  );

  // The models section's content for the listing's state. A plain function called during render (not a component
  // declared here, which would be a new type on every render and remount the search box on each keystroke).
  function renderModelsBody(): ReactNode {
    if (catalog.loading) return <RowsSkeleton label={t('models.loading')} />;
    if (catalog.error && !data) {
      return (
        <CatalogState
          tone="error"
          icon={<IconAlertCircle size={24} />}
          title={t('states.requestFailedTitle')}
          text={catalog.error}
        >
          <div className="ds-row" style={{ justifyContent: 'center' }}>
            <Button size="sm" variant="default" leftSection={<IconRefresh size={14} />} onClick={catalog.refresh}>
              {t('states.retry')}
            </Button>
            {enterManually}
          </div>
        </CatalogState>
      );
    }
    if (!data) return <RowsSkeleton label={t('models.loading')} />;
    if (!data.supported) {
      return (
        <CatalogState
          icon={<IconListSearch size={24} />}
          title={t('states.unsupportedTitle')}
          text={t('states.unsupportedText', { provider: data.provider.label || provider?.label || '' })}
        >
          {enterManually}
        </CatalogState>
      );
    }
    if (data.error && models.length === 0) {
      return (
        <CatalogState
          tone="error"
          icon={<IconAlertCircle size={24} />}
          title={errorTitle(data, t)}
          text={errorHint(data, t)}
          detail={errorDetail(data, t)}
        >
          {/* The refused listing stays on screen while the next one is on its way (`refreshing`, not `loading`): the
              button shows it and takes no second click, which would start another listing at the provider. */}
          <div className="ds-row" style={{ justifyContent: 'center' }} aria-busy={catalog.refreshing || undefined}>
            <Button
              size="sm"
              variant="default"
              leftSection={<IconRefresh size={14} />}
              loading={catalog.refreshing}
              onClick={catalog.refresh}
            >
              {t('states.retry')}
            </Button>
            {enterManually}
          </div>
        </CatalogState>
      );
    }
    if (models.length === 0) {
      return (
        <>
          <Notices notices={data.notices} t={t} locale={locale} />
          <CatalogState icon={<IconListSearch size={24} />} title={t('states.emptyTitle')} text={t('states.emptyText')}>
            {enterManually}
          </CatalogState>
        </>
      );
    }

    return (
      <>
        {data.error ? (
          <Alert color="orange" variant="light" icon={<IconAlertCircle size={16} />} title={errorTitle(data, t)}>
            {errorDetail(data, t) ?? errorHint(data, t)}
          </Alert>
        ) : null}
        {catalog.error ? (
          <Alert color="red" variant="light" icon={<IconAlertCircle size={16} />} title={t('states.requestFailedTitle')}>
            {catalog.error}
          </Alert>
        ) : null}
        <Notices notices={data.notices} t={t} locale={locale} />

        <div className="ds-row" style={{ gap: 12 }}>
          <TextInput
            style={{ flex: '1 1 240px' }}
            aria-label={t('models.searchLabel')}
            placeholder={t('models.searchPlaceholder')}
            leftSection={<IconSearch size={14} />}
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
          />
          <Switch
            size="sm"
            label={t('models.hideAdded')}
            checked={hideRegistered}
            onChange={(event) => setHideRegistered(event.currentTarget.checked)}
            disabled={registeredCount === 0 && !hideRegistered}
          />
        </div>

        {presentCategories.length > 1 ? (
          <div role="group" aria-label={t('models.categoryLabel')}>
            <ChipPicker<CatalogCategoryFilter>
              options={[
                { value: 'all', label: t('models.chip', { label: t('models.all'), count: searchMatches.length }) },
                ...presentCategories.map((entry) => ({
                  value: entry.category,
                  label: t('models.chip', {
                    label: t(`categories.${entry.category}`),
                    count: matchCounts.get(entry.category) ?? 0,
                  }),
                })),
              ]}
              value={category}
              onChange={(next) => setChosenCategory(next as CatalogCategoryFilter)}
            />
          </div>
        ) : null}

        {visible.length === 0 ? (
          <CatalogState icon={<IconSearch size={24} />} title={t('states.noMatchTitle')} text={t('states.noMatchText')}>
            <Button
              size="sm"
              variant="default"
              onClick={() => {
                setQuery('');
                setHideRegistered(false);
                setChosenCategory('all');
              }}
            >
              {t('states.clearFilters')}
            </Button>
          </CatalogState>
        ) : (
          <div className="ds-card" style={{ position: 'relative', overflow: 'hidden' }}>
            {catalog.refreshing ? <div className="ds-refresh-bar" /> : null}
            <ul style={{ listStyle: 'none', margin: 0, padding: 0 }} aria-busy={catalog.refreshing || undefined}>
              {rows.map((model, index) => (
                <CatalogRow
                  key={model.id}
                  model={model}
                  first={index === 0}
                  selected={selected.includes(model.id)}
                  locked={Boolean(bulk)}
                  onToggle={() => toggle(model.id)}
                  onConfigure={() => configure(model)}
                  t={t}
                  locale={locale}
                />
              ))}
            </ul>
          </div>
        )}
        {visible.length > rows.length ? (
          <span className="ds-muted" style={{ fontSize: 12 }}>
            {t('models.showing', {
              shown: rows.length.toLocaleString(locale),
              total: visible.length.toLocaleString(locale),
            })}
          </span>
        ) : null}
      </>
    );
  }

  return (
    <FormShell
      open={opened}
      onClose={close}
      icon={<IconBooks size={16} />}
      title={t('title')}
      subtitle={t('subtitle')}
      summary={summary}
      footerStatus={count > 0 ? t('actions.selectedStatus', { count }) : undefined}
      secondaryAction={{
        label: t('actions.custom'),
        icon: <IconPencil size={13} />,
        disabled: Boolean(bulk),
        onClick: () => onCustom(providerKey),
      }}
      primaryAction={primaryAction}
    >
      <FormSection
        number={1}
        done={Boolean(provider)}
        title={t('provider.sectionTitle')}
        description={t('provider.sectionDescription')}
      >
        {providers.length === 0 ? (
          <CatalogState icon={<IconPlug size={24} />} title={t('provider.empty.title')} text={t('provider.empty.description')}>
            {onAddProvider ? (
              <Button size="sm" color="teal" leftSection={<IconPlus size={14} />} onClick={onAddProvider}>
                {t('provider.empty.action')}
              </Button>
            ) : null}
          </CatalogState>
        ) : (
          <>
            <FormRow cols={1}>
              <FormField label={t('provider.label')} required>
                <Select
                  aria-label={t('provider.label')}
                  placeholder={t('provider.placeholder')}
                  data={providers.map((candidate) => ({
                    value: candidate.key,
                    label: candidate.label || candidate.key,
                    disabled: candidate.status === 'disabled',
                  }))}
                  value={providerKey ?? null}
                  onChange={(value) => {
                    if (value) changeProvider(value);
                  }}
                  allowDeselect={false}
                  searchable
                  disabled={Boolean(bulk)}
                  renderOption={({ option }) => {
                    const candidate = providers.find((entry) => entry.key === option.value);
                    return (
                      <div className="ds-row-between" style={{ width: '100%', flexWrap: 'nowrap' }}>
                        <span>{option.label}</span>
                        <span className="ds-faint ds-mono" style={{ fontSize: 11.5 }}>
                          {candidate?.driver}
                          {candidate?.status === 'disabled' ? ` · ${t('provider.disabled')}` : ''}
                        </span>
                      </div>
                    );
                  }}
                />
              </FormField>
            </FormRow>
            {provider ? (
              <SourceLine
                data={data}
                loading={catalog.loading}
                refreshing={catalog.refreshing}
                onRefresh={catalog.refresh}
                disabled={Boolean(bulk)}
                t={t}
                locale={locale}
              />
            ) : (
              <span className="ds-muted" style={{ fontSize: 13 }}>{t('provider.pickHint')}</span>
            )}
          </>
        )}
      </FormSection>

      {provider ? (
        <FormSection
          number={2}
          done={count > 0}
          title={t('models.sectionTitle')}
          description={t('models.sectionDescription')}
        >
          <Stack gap="sm">{renderModelsBody()}</Stack>
        </FormSection>
      ) : null}
    </FormShell>
  );
}

function sourceSummaryKey(source: ProviderModelCatalog['source']): string {
  switch (source) {
    case 'live':
      return 'sourceLive';
    case 'reference':
      return 'sourceReference';
    case 'static':
      return 'sourceStatic';
    default:
      return 'sourceNone';
  }
}

const KNOWN_ERROR_CODES = new Set([
  'auth_failed',
  'unreachable',
  'timeout',
  'upstream_error',
  'endpoint_not_allowed',
  'credentials_unavailable',
  'invalid_settings',
]);

function errorKey(data: ProviderModelCatalog): string {
  const code = data.error?.code;
  return code && KNOWN_ERROR_CODES.has(code) ? code : 'generic';
}

function errorTitle(data: ProviderModelCatalog, t: Translate): string {
  return t(`errors.${errorKey(data)}.title`);
}

function errorHint(data: ProviderModelCatalog, t: Translate): string {
  return t(`errors.${errorKey(data)}.hint`);
}

/** The scrubbed detail line of the listing's error (and its HTTP status), when there is one. */
function errorDetail(data: ProviderModelCatalog, t: Translate): string | undefined {
  const parts = [
    data.error?.status ? t('errors.status', { status: data.error.status }) : null,
    data.error?.message?.trim() || null,
  ].filter(Boolean);
  return parts.length ? t('states.detail', { message: parts.join(' · ') }) : undefined;
}

function priceText(model: CatalogModel, t: Translate, locale: string): string {
  const pricing = model.pricing;
  if (!pricing) return t('row.noPrice');
  const values = {
    input: formatPrice(pricing.inputTokenPer1M, locale),
    output: formatPrice(pricing.outputTokenPer1M, locale),
  };
  return t(pricing.confidence === 'fuzzy' ? 'row.priceApprox' : 'row.price', values);
}

function priceHint(model: CatalogModel, t: Translate): string {
  const pricing = model.pricing;
  if (!pricing) return t('row.noPriceHint');
  if (pricing.source === 'provider') return t('row.priceProvider');
  const key = pricing.catalogKey ?? model.id;
  return pricing.confidence === 'fuzzy' ? t('row.priceFuzzy', { key }) : t('row.priceReference', { key });
}

/** StatusBadge's style for each provider status, with the label from this screen's messages (its own are English). */
const PROVIDER_STATUS_BADGES: Record<string, { status: string; key: string }> = {
  active: { status: 'active', key: 'provider.active' },
  disabled: { status: 'paused', key: 'provider.disabled' },
  errored: { status: 'err', key: 'provider.errored' },
};

function ProviderStatusBadge({ status, t }: { status: string; t: Translate }) {
  const badge = PROVIDER_STATUS_BADGES[status];
  // A status this screen has no message for is shown as stored, as StatusBadge does.
  return badge ? <StatusBadge status={badge.status} label={t(badge.key)} /> : <StatusBadge status={status} />;
}

/** Where the listing came from and when, with "List again". */
function SourceLine({
  data,
  loading,
  refreshing,
  onRefresh,
  disabled,
  t,
  locale,
}: {
  data?: ProviderModelCatalog;
  loading: boolean;
  refreshing: boolean;
  onRefresh: () => void;
  disabled: boolean;
  t: Translate;
  locale: string;
}) {
  let text: ReactNode;
  if (!data) text = loading ? t('source.refreshing') : '—';
  else if (data.source === 'live') {
    text = t('source.live', { provider: data.provider.label, time: formatRelative(data.fetchedAt, locale) });
  } else if (data.source === 'reference') {
    text = t('source.reference', { time: formatRelative(data.fetchedAt, locale) });
  } else if (data.source === 'static') text = t('source.static');
  else text = t('source.none');
  const busy = loading || refreshing;
  return (
    <div className="ds-row-between" style={{ gap: 8 }}>
      <span className="ds-row ds-muted" style={{ fontSize: 12.5, gap: 6 }} aria-live="polite">
        {data?.source === 'live' ? <span className="ds-badge-dot" style={{ color: 'var(--ds-ok)' }} /> : null}
        {refreshing ? t('source.refreshing') : text}
      </span>
      <Tooltip label={t('source.refresh')} withArrow>
        <ActionIcon
          variant="subtle"
          color="gray"
          size="sm"
          aria-label={t('source.refresh')}
          loading={busy}
          disabled={disabled}
          onClick={onRefresh}
        >
          <IconRefresh size={14} />
        </ActionIcon>
      </Tooltip>
    </div>
  );
}

function Notices({ notices, t, locale }: { notices?: CatalogNotice[]; t: Translate; locale: string }) {
  if (!notices?.length) return null;
  return (
    <ul className="ds-col" style={{ gap: 4, listStyle: 'none', margin: 0, padding: 0 }}>
      {notices.map((notice) => {
        const withCount = notice.code === 'excluded_unsupported' || notice.code === 'truncated';
        const text = !withCount
          ? t(`notices.${notice.code}`)
          : typeof notice.count === 'number'
            ? t(`notices.${countKey(notice.code, notice.count)}`, { count: notice.count.toLocaleString(locale) })
            : t(`notices.${notice.code}NoCount`);
        return (
          <li key={notice.code} className="ds-row ds-muted" style={{ gap: 6, fontSize: 12, flexWrap: 'nowrap', alignItems: 'flex-start' }}>
            <IconInfoCircle size={14} style={{ flexShrink: 0, marginTop: 1 }} aria-hidden="true" />
            <span>{text}</span>
          </li>
        );
      })}
    </ul>
  );
}

function CatalogRow({
  model,
  first,
  selected,
  locked,
  onToggle,
  onConfigure,
  t,
  locale,
}: {
  model: CatalogModel;
  first: boolean;
  selected: boolean;
  locked: boolean;
  onToggle: () => void;
  onConfigure: () => void;
  t: Translate;
  locale: string;
}) {
  const registered = isCatalogModelRegistered(model);
  const contextHint = [
    model.contextWindow ? t('row.contextWindowHint', { tokens: model.contextWindow.toLocaleString(locale) }) : null,
    model.maxOutputTokens ? t('row.maxOutputHint', { tokens: model.maxOutputTokens.toLocaleString(locale) }) : null,
  ].filter(Boolean).join(' · ');
  return (
    <li style={{ borderTop: first ? undefined : '1px solid var(--ds-border-soft)' }}>
      {/* The whole row is the checkbox's label: a click anywhere but on the Configure button picks the model. */}
      <label
        className="ds-row"
        style={{
          gap: 10,
          padding: '9px 14px',
          flexWrap: 'nowrap',
          alignItems: 'flex-start',
          cursor: registered || locked ? 'default' : 'pointer',
          background: selected ? 'var(--ds-hover)' : undefined,
        }}
      >
        <span style={{ display: 'inline-flex', paddingTop: 2 }} title={registered ? t('row.addedLocked') : undefined}>
          <input
            type="checkbox"
            className="ds-checkbox"
            checked={selected}
            disabled={registered || locked}
            onChange={onToggle}
            aria-label={t('row.select', { name: model.name })}
          />
        </span>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div className="ds-row" style={{ gap: 6 }}>
            <span style={{ fontSize: 13, fontWeight: 500, overflowWrap: 'anywhere' }}>{model.name}</span>
            <Badge size="sm" variant="light" color={CATEGORY_COLORS[model.category] ?? 'gray'}>
              {t(`categories.${model.category}`)}
            </Badge>
            {model.deprecated ? (
              <span className="ds-badge ds-badge-warn" title={t('row.deprecatedHint')}>{t('row.deprecated')}</span>
            ) : null}
            {registered ? (
              <span
                className="ds-badge ds-badge-ok"
                title={t('row.addedHint', { keys: (model.registeredModelKeys ?? []).join(', ') })}
              >
                {t('row.added')}
              </span>
            ) : null}
          </div>
          <div className="ds-faint ds-mono" style={{ fontSize: 11.5, overflowWrap: 'anywhere' }}>
            {model.id}
            {model.upstreamModel && model.upstreamModel !== model.id ? ` · ${t('row.via', { model: model.upstreamModel })}` : null}
          </div>
          {model.description ? (
            <Text size="xs" c="dimmed" lineClamp={1} title={model.description}>
              {model.description}
            </Text>
          ) : null}
        </div>
        <div className="ds-row" style={{ gap: 6, flexShrink: 0, justifyContent: 'flex-end', paddingTop: 1 }}>
          {takesImages(model) ? (
            <span className="ds-faint" style={{ display: 'inline-flex' }} title={t('row.vision')} role="img" aria-label={t('row.vision')}>
              <IconEye size={14} />
            </span>
          ) : null}
          {model.supportsToolCalls ? (
            <span className="ds-faint" style={{ display: 'inline-flex' }} title={t('row.tools')} role="img" aria-label={t('row.tools')}>
              <IconTool size={14} />
            </span>
          ) : null}
          {model.supportsReasoning ? (
            <span className="ds-faint" style={{ display: 'inline-flex' }} title={t('row.reasoning')} role="img" aria-label={t('row.reasoning')}>
              <IconBrain size={14} />
            </span>
          ) : null}
          {model.contextWindow ? (
            <span className="ds-badge ds-mono" title={contextHint}>
              {t('row.contextWindow', { tokens: formatTokens(model.contextWindow) })}
            </span>
          ) : null}
          <span
            className={`ds-mono ${model.pricing ? 'ds-muted' : 'ds-faint'}`}
            style={{ fontSize: 11.5, whiteSpace: 'nowrap', minWidth: 120, textAlign: 'right' }}
            title={priceHint(model, t)}
          >
            {priceText(model, t, locale)}
          </span>
          <Button
            variant="subtle"
            size="compact-xs"
            title={t('row.configureHint')}
            disabled={locked}
            onClick={(event) => {
              // Inside the row's label: the click configures, it does not also pick the row.
              event.preventDefault();
              onConfigure();
            }}
          >
            {t('row.configure')}
          </Button>
        </div>
      </label>
    </li>
  );
}

/** A state that takes the place of the model list (no providers, no list, a failed listing, nothing matches). */
function CatalogState({
  tone = 'neutral',
  icon,
  title,
  text,
  detail,
  children,
}: {
  tone?: 'neutral' | 'error';
  icon: ReactNode;
  title: string;
  text?: ReactNode;
  detail?: ReactNode;
  children?: ReactNode;
}) {
  const isError = tone === 'error';
  return (
    <div className="ds-card" role={isError ? 'alert' : undefined} style={{ background: 'var(--ds-surface-1)' }}>
      <div className="ds-empty" style={{ padding: '32px 24px' }}>
        <div
          className="ds-empty-icon"
          aria-hidden="true"
          style={isError ? { background: 'rgba(201, 59, 59, 0.12)', color: 'var(--ds-err)' } : undefined}
        >
          {icon}
        </div>
        <h3 className="ds-h4" style={{ margin: '0 0 4px' }}>{title}</h3>
        {text ? (
          <Text size="sm" c="dimmed" maw={480} ta="center">
            {text}
          </Text>
        ) : null}
        {detail ? (
          <Text size="xs" c="dimmed" maw={480} ta="center" mt={6} className="ds-mono" style={{ overflowWrap: 'anywhere' }}>
            {detail}
          </Text>
        ) : null}
        {children ? <div style={{ marginTop: 14 }}>{children}</div> : null}
      </div>
    </div>
  );
}

function RowsSkeleton({ label }: { label: string }) {
  return (
    <SkeletonRegion label={label} className="ds-card">
      {[0, 1, 2, 3, 4, 5].map((row) => (
        <div
          key={row}
          className="ds-row"
          style={{ gap: 10, padding: '11px 14px', borderTop: row ? '1px solid var(--ds-border-soft)' : undefined }}
        >
          <SkeletonText width={16} height={16} />
          <div className="ds-col" style={{ gap: 6, flex: 1 }}>
            <SkeletonText width={[180, 140, 210, 160, 120, 190][row]} />
            <SkeletonText width={[120, 100, 150, 90, 110, 130][row]} height="0.6em" />
          </div>
          <SkeletonText width={110} />
        </div>
      ))}
    </SkeletonRegion>
  );
}
