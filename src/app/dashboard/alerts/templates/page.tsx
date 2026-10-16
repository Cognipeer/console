'use client';

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Badge, Button, Checkbox, Loader, Text, TextInput } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconArrowLeft, IconSearch } from '@tabler/icons-react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import PageContainer, { PageHeader } from '@/components/common/ui/PageContainer';
import LoadError from '@/components/alerts/LoadError';
import { readApiError } from '@/components/alerts/apiError';
import {
  createAlertCatalog,
  formatMinutes,
  moduleColor,
  moduleLabel,
  summarizeCondition,
  summarizeTarget,
} from '@/components/alerts/alertCatalog';
import type {
  AlertRuleDto,
  AlertTemplateApplyResultDto,
  AlertTemplateCategoryDto,
  AlertTemplateItemDto,
  AlertTemplateListDto,
  BacktestResultDto,
} from '@/components/alerts/alertTypes';
import { pluralKey } from '@/components/alerts/plural';
import { useAlertMeta } from '@/components/alerts/useAlertMeta';
import { useLocale, useTranslations } from '@/lib/i18n';

type ShowFilter = 'all' | 'default' | 'missing';
type TFn = ReturnType<typeof useTranslations>;

const CATEGORIES: AlertTemplateCategoryDto[] = ['errors', 'latency', 'traffic', 'cost', 'quality', 'safety'];

/** Added templates and the ones this build or licence cannot run are not selectable. */
function selectable(item: AlertTemplateItemDto): boolean {
  return item.availability.available && item.state !== 'added';
}

type BacktestState = { status: 'loading' } | { status: 'done'; result: BacktestResultDto } | { status: 'failed' };

function BacktestLine({ state, t }: { state: BacktestState | undefined; t: TFn }) {
  if (!state || state.status === 'failed') return null;
  if (state.status === 'loading') {
    return (
      <Text size="xs" c="dimmed">
        {t('templates.backtestChecking')}
      </Text>
    );
  }
  const { result } = state;
  if (!result.supported) return null;
  if (result.evaluations === 0) {
    return (
      <Text size="xs" c="dimmed">
        {t('templates.backtestNoTraffic')}
      </Text>
    );
  }
  return (
    <Text size="xs" c={result.fires > 0 ? 'orange' : 'dimmed'}>
      {result.fires > 0 ? t('templates.backtestFired', { count: result.fires }) : t('templates.backtestQuiet')}
    </Text>
  );
}

function TemplateCard({
  item,
  checked,
  onToggle,
  backtest,
  onVisible,
  catalog,
  locale,
  t,
}: {
  item: AlertTemplateItemDto;
  checked: boolean;
  onToggle: () => void;
  backtest: BacktestState | undefined;
  onVisible: (item: AlertTemplateItemDto) => void;
  catalog: ReturnType<typeof createAlertCatalog>;
  locale: string;
  t: TFn;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const canSelect = selectable(item);
  useEffect(() => {
    const node = ref.current;
    if (!node || !item.availability.available || typeof IntersectionObserver === 'undefined') {
      if (item.availability.available) onVisible(item);
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        onVisible(item);
        observer.disconnect();
      }
    });
    observer.observe(node);
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item.key]);

  const rule = item.input as unknown as AlertRuleDto;
  const target = summarizeTarget(rule, t);
  const hold = item.input.condition.forMinutes ?? 0;
  const minSamples = item.input.condition.minSamples;
  const unavailableReason =
    !item.availability.available
      ? item.availability.reason === 'not_enterprise_build'
        ? t('templates.unavailableNotEnterprise')
        : t('templates.unavailableLicense')
      : null;

  return (
    <div
      ref={ref}
      className="ds-card"
      style={{ padding: 14, display: 'flex', gap: 12, opacity: item.availability.available ? 1 : 0.65 }}
    >
      <Checkbox checked={checked} disabled={!canSelect} onChange={onToggle} aria-label={item.name} mt={2} />
      <div style={{ minWidth: 0, flex: 1, display: 'flex', flexDirection: 'column', gap: 6 }}>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
          <Text size="sm" fw={600}>
            {item.name}
          </Text>
          {item.default ? (
            <Badge size="xs" variant="light" color="teal">
              {t('templates.defaultBadge')}
            </Badge>
          ) : null}
          {item.state === 'available' && item.availability.available ? (
            <Badge size="xs" variant="outline" color="gray">
              {t('templates.stateAvailable')}
            </Badge>
          ) : null}
          {item.state === 'covered' ? (
            <Badge size="xs" variant="light" color="blue">
              {t('templates.stateCovered')}
            </Badge>
          ) : null}
          {item.state === 'added' ? (
            <Badge size="xs" variant="light" color="green">
              {t('templates.stateAdded')}
            </Badge>
          ) : null}
          {!item.availability.available ? (
            <>
              <Badge size="xs" variant="outline" color="gray">
                {t('templates.stateUnavailable')}
              </Badge>
              <Badge size="xs" variant="light" color="violet">
                {t('templates.enterpriseBadge')}
              </Badge>
            </>
          ) : null}
        </div>
        <Text size="xs" c="dimmed">
          {item.description}
        </Text>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          <Badge size="xs" variant="light" color={moduleColor(item.module)}>
            {moduleLabel(item.module, t)}
          </Badge>
          <Badge size="xs" variant="outline" color="gray">
            {target.label}
          </Badge>
          <Badge size="xs" variant="outline" color="gray">
            {summarizeCondition(rule, catalog, t, locale)}
          </Badge>
          {hold > 0 ? (
            <Badge size="xs" variant="outline" color="gray">
              {t('templates.chipHold', { value: formatMinutes(hold, t) })}
            </Badge>
          ) : null}
          {typeof minSamples === 'number' ? (
            <Badge size="xs" variant="outline" color="gray">
              {t(pluralKey('templates.chipSamples', minSamples), { count: minSamples })}
            </Badge>
          ) : null}
        </div>
        {item.state === 'covered' && item.rule ? (
          <Text size="xs" c="blue">
            {t('templates.coveredHint', { rule: item.rule.name })}
          </Text>
        ) : null}
        {unavailableReason ? (
          <Text size="xs" c="dimmed">
            {unavailableReason}
          </Text>
        ) : null}
        {item.state !== 'added' && item.availability.available ? <BacktestLine state={backtest} t={t} /> : null}
        <div style={{ display: 'flex', gap: 12 }}>
          {item.state === 'added' && item.rule ? (
            <Text size="xs" component={Link} href={`/dashboard/alerts?edit=${item.rule.id}`} fw={600}>
              {t('templates.openRule')}
            </Text>
          ) : null}
          {item.availability.available ? (
            <Text size="xs" component={Link} href={`/dashboard/alerts?template=${encodeURIComponent(item.key)}`} c="dimmed">
              {t('templates.customize')}
            </Text>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function FacetButton({ label, count, active, onClick }: { label: string; count: number; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        display: 'flex',
        justifyContent: 'space-between',
        width: '100%',
        padding: '5px 8px',
        borderRadius: 6,
        border: 'none',
        cursor: 'pointer',
        background: active ? 'var(--ds-surface-2, rgba(128,128,128,0.15))' : 'transparent',
        color: 'inherit',
        fontWeight: active ? 600 : 400,
        fontSize: 13,
        textAlign: 'left',
      }}
    >
      <span>{label}</span>
      <span className="ds-faint">{count}</span>
    </button>
  );
}

function TemplatesGallery() {
  const t = useTranslations('alerts');
  const locale = useLocale();
  const router = useRouter();
  const searchParams = useSearchParams();
  const { meta } = useAlertMeta();
  const catalog = useMemo(() => createAlertCatalog(meta?.catalog), [meta?.catalog]);

  const [data, setData] = useState<AlertTemplateListDto | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const initialShow = searchParams?.get('show');
  const [show, setShow] = useState<ShowFilter>(initialShow === 'default' || initialShow === 'missing' ? initialShow : 'all');
  const [category, setCategory] = useState<AlertTemplateCategoryDto | 'all'>('all');
  const [moduleFilter, setModuleFilter] = useState('all');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [adding, setAdding] = useState(false);
  const [backtests, setBacktests] = useState<Record<string, BacktestState>>({});
  const requested = useRef<Set<string>>(new Set());
  const preselect = searchParams?.get('select') === 'default';

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const res = await fetch('/api/alerts/templates');
      if (!res.ok) throw new Error(await readApiError(res, t('templates.loadFailed')));
      const body = (await res.json()) as AlertTemplateListDto;
      setData(body);
      if (preselect) {
        setSelected(new Set(body.items.filter((item) => item.default && selectable(item) && item.state === 'available').map((item) => item.key)));
      }
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : t('templates.loadFailed'));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const runBacktest = useCallback((item: AlertTemplateItemDto) => {
    if (requested.current.has(item.key)) return;
    requested.current.add(item.key);
    setBacktests((current) => ({ ...current, [item.key]: { status: 'loading' } }));
    fetch('/api/alerts/rules/backtest', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rule: item.input, days: 7 }),
    })
      .then((res) => (res.ok ? (res.json() as Promise<BacktestResultDto>) : Promise.reject(new Error('backtest'))))
      .then((result) => setBacktests((current) => ({ ...current, [item.key]: { status: 'done', result } })))
      .catch(() => setBacktests((current) => ({ ...current, [item.key]: { status: 'failed' } })));
  }, []);

  const items = useMemo(() => data?.items ?? [], [data]);
  const modules = useMemo(() => Array.from(new Set(items.map((item) => item.module))), [items]);
  const matches = (item: AlertTemplateItemDto) => {
    const needle = search.trim().toLowerCase();
    if (needle && !`${item.name} ${item.description}`.toLowerCase().includes(needle)) return false;
    if (show === 'default' && !item.default) return false;
    if (show === 'missing' && item.state !== 'available') return false;
    if (category !== 'all' && item.category !== category) return false;
    if (moduleFilter !== 'all' && item.module !== moduleFilter) return false;
    return true;
  };
  const visible = items.filter(matches);

  const toggle = (key: string) =>
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const selectGroup = (group: AlertTemplateItemDto[]) =>
    setSelected((current) => {
      const next = new Set(current);
      for (const item of group) if (selectable(item) && item.state === 'available') next.add(item.key);
      return next;
    });

  const add = async () => {
    if (selected.size === 0) return;
    setAdding(true);
    try {
      const res = await fetch('/api/alerts/templates', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ keys: Array.from(selected) }),
      });
      if (!res.ok) throw new Error(await readApiError(res, t('templates.addFailed')));
      const result = (await res.json()) as AlertTemplateApplyResultDto;
      notifications.show({
        title: t('templates.added'),
        message: t(pluralKey('templates.addedMessage', result.created.length), { count: result.created.length }),
        color: 'teal',
      });
      router.push('/dashboard/alerts');
    } catch (error) {
      notifications.show({
        title: t('error'),
        message: error instanceof Error ? error.message : t('templates.addFailed'),
        color: 'red',
      });
      setAdding(false);
    }
  };

  const groups = CATEGORIES.map((id) => ({ id, items: visible.filter((item) => item.category === id) })).filter((group) => group.items.length > 0);
  const count = selected.size;

  return (
    <PageContainer>
      <PageHeader
        eyebrow={t('eyebrow')}
        title={t('templates.title')}
        subtitle={t('templates.subtitle')}
        actions={
          <Button component={Link} href="/dashboard/alerts" variant="default" size="sm" leftSection={<IconArrowLeft size={14} stroke={1.7} />}>
            {t('backToRules')}
          </Button>
        }
      />

      {loadError ? (
        <LoadError message={loadError} onRetry={() => void load()} />
      ) : !data ? (
        <div style={{ display: 'flex', justifyContent: 'center', padding: 48 }}>
          <Loader size="sm" />
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(200px, 240px) minmax(0, 1fr)', gap: 20, alignItems: 'start' }}>
          <aside style={{ display: 'flex', flexDirection: 'column', gap: 16, position: 'sticky', top: 12 }}>
            <TextInput
              size="xs"
              placeholder={t('templates.searchPlaceholder')}
              leftSection={<IconSearch size={13} />}
              value={search}
              onChange={(event) => setSearch(event.currentTarget.value)}
            />
            <div>
              <div className="ds-eyebrow" style={{ marginBottom: 4 }}>
                {t('templates.show')}
              </div>
              <FacetButton label={t('templates.showAll')} count={items.length} active={show === 'all'} onClick={() => setShow('all')} />
              <FacetButton
                label={t('templates.showDefault')}
                count={items.filter((item) => item.default).length}
                active={show === 'default'}
                onClick={() => setShow('default')}
              />
              <FacetButton
                label={t('templates.showMissing')}
                count={items.filter((item) => item.state === 'available').length}
                active={show === 'missing'}
                onClick={() => setShow('missing')}
              />
            </div>
            <div>
              <div className="ds-eyebrow" style={{ marginBottom: 4 }}>
                {t('templates.category')}
              </div>
              <FacetButton label={t('templates.showAll')} count={items.length} active={category === 'all'} onClick={() => setCategory('all')} />
              {CATEGORIES.map((id) => (
                <FacetButton
                  key={id}
                  label={t(`templates.categories.${id}`)}
                  count={items.filter((item) => item.category === id).length}
                  active={category === id}
                  onClick={() => setCategory(id)}
                />
              ))}
            </div>
            <div>
              <div className="ds-eyebrow" style={{ marginBottom: 4 }}>
                {t('templates.module')}
              </div>
              <FacetButton label={t('templates.showAll')} count={items.length} active={moduleFilter === 'all'} onClick={() => setModuleFilter('all')} />
              {modules.map((id) => (
                <FacetButton
                  key={id}
                  label={moduleLabel(id, t)}
                  count={items.filter((item) => item.module === id).length}
                  active={moduleFilter === id}
                  onClick={() => setModuleFilter(id)}
                />
              ))}
            </div>
          </aside>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 16, paddingBottom: 72 }}>
            {data.projectAdminRecipients > 0 ? (
              <Alert color="blue" variant="light" title={t('templates.notifyTitle')}>
                {t(pluralKey('templates.notifyAdmins', data.projectAdminRecipients), { count: data.projectAdminRecipients })}
              </Alert>
            ) : (
              <Alert color="yellow" variant="light" title={t('templates.notifyTitle')}>
                {t('templates.notifyNoAdmins')}
              </Alert>
            )}

            {groups.length === 0 ? (
              <Text size="sm" c="dimmed" ta="center" py="xl">
                {t('templates.noMatch')}
              </Text>
            ) : null}

            {groups.map((group) => {
              const open = group.items.filter((item) => selectable(item) && item.state === 'available');
              return (
                <section key={group.id} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                    <div className="ds-h4">
                      {t(`templates.categories.${group.id}`)} <span className="ds-faint">{group.items.length}</span>
                    </div>
                    {open.length > 0 ? (
                      <Button variant="subtle" size="compact-xs" onClick={() => selectGroup(group.items)}>
                        {t(pluralKey('templates.selectAvailable', open.length), { count: open.length })}
                      </Button>
                    ) : null}
                  </div>
                  {group.items.map((item) => (
                    <TemplateCard
                      key={item.key}
                      item={item}
                      checked={selected.has(item.key)}
                      onToggle={() => toggle(item.key)}
                      backtest={backtests[item.key]}
                      onVisible={runBacktest}
                      catalog={catalog}
                      locale={locale}
                      t={t}
                    />
                  ))}
                </section>
              );
            })}
          </div>
        </div>
      )}

      {data ? (
        <div
          style={{
            position: 'sticky',
            bottom: 0,
            display: 'flex',
            justifyContent: 'flex-end',
            padding: '12px 0',
            background: 'var(--ds-bg, var(--mantine-color-body))',
            borderTop: '1px solid var(--ds-border, rgba(128,128,128,0.25))',
          }}
        >
          <Button color="teal" disabled={count === 0} loading={adding} onClick={() => void add()}>
            {count === 0 ? t('templates.addNone') : t(pluralKey('templates.add', count), { count })}
          </Button>
        </div>
      ) : null}
    </PageContainer>
  );
}

export default function AlertTemplatesPage() {
  return (
    <Suspense fallback={null}>
      <TemplatesGallery />
    </Suspense>
  );
}
