'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  ActionIcon,
  Alert,
  Badge,
  Button,
  Group,
  Loader,
  Menu,
  Paper,
  SegmentedControl,
  Stack,
  Switch,
  Table,
  Text,
  TextInput,
  Tooltip,
} from '@mantine/core';
import { useElementSize, useMediaQuery } from '@mantine/hooks';
import { notifications } from '@mantine/notifications';
import {
  IconAlertTriangle,
  IconCopy,
  IconDots,
  IconEdit,
  IconEye,
  IconPlus,
  IconRefresh,
  IconSearch,
  IconShieldPlus,
  IconTrash,
} from '@tabler/icons-react';
import EmptyState from '@/components/common/EmptyState';
import { useDeleteResource, useConfirm } from '@/components/common/confirm';
import { useLocale, useTranslations } from '@/lib/i18n';
import {
  IamApiError,
  iamApi,
  type PoliciesResponse,
  type PolicyRow,
  type PolicyWriteBody,
} from '../api';
import { iamHref, parsePolicyParams, policyPageHref, type PolicyLinkParams } from '../links';
import { useProjects } from '../pickers/lookups';
import { useGroupLabels } from '../pickers/principalLabels';
import { formatDateTime, formatRelative } from '../timeFormat';
import { useErrorText } from '../useErrorText';
import { useIamCatalog } from '../useIamCatalog';
import { useIamLabels } from '../useIamLabels';
import ManagedPolicies from './ManagedPolicies';
import { EffectBadge } from './PolicyBadges';
import PolicyEditor, { type PolicyEditorTarget } from './PolicyEditor';
import { summarizeSpec } from './specModel';
import { describeSpec } from './specSummary';

interface PoliciesTabProps {
  canManage: boolean;
}

type EnabledFilter = 'all' | 'enabled' | 'disabled';
type EffectFilter = 'all' | 'permit' | 'forbid';
type SortKey = 'name' | 'updated';

/** Narrowest box the policies table is laid out in; below it the policies are shown as cards. */
const TABLE_MIN_WIDTH = 860;

/**
 * What a switch in the table sends: only the switch. The server keeps the stored
 * Cedar and spec, so turning a policy off never re-validates (and can never be
 * refused because of) the people and groups it names.
 */
function bodyOf(change: { enabled?: boolean }): Partial<PolicyWriteBody> {
  return change.enabled !== undefined ? { enabled: change.enabled } : {};
}

export default function PoliciesTab({ canManage }: PoliciesTabProps) {
  const t = useTranslations('iamCenter');
  const locale = useLocale();
  const { confirm } = useConfirm();
  const deleteResource = useDeleteResource();
  const errorText = useErrorText();
  const searchParams = useSearchParams()!;
  const router = useRouter();
  // One card per policy instead of a wide table when the table does not fit. Decided by the
  // width of the box the table lives in, not the window: the sidebar takes ~300px, so a
  // 1280px laptop leaves the table less than its minimum width and its right-hand columns
  // (and the row menu) would sit off-screen. The window query is only the first-paint guess.
  const { ref: tableBox, width: tableBoxWidth } = useElementSize();
  const windowCompact = useMediaQuery('(max-width: 82em)') ?? false;
  const compact = tableBoxWidth > 0 ? tableBoxWidth < TABLE_MIN_WIDTH + 48 : windowCompact;

  const { catalog, index, error: catalogError, reload: reloadCatalog } = useIamCatalog();
  const labels = useIamLabels(catalog);
  const { projects } = useProjects();

  const [data, setData] = useState<PoliciesResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [search, setSearch] = useState('');
  const [enabledFilter, setEnabledFilter] = useState<EnabledFilter>('all');
  const [effectFilter, setEffectFilter] = useState<EffectFilter>('all');
  const [sortKey, setSortKey] = useState<SortKey>('name');
  const [busy, setBusy] = useState<Set<string>>(() => new Set());

  const [editor, setEditor] = useState<{ key: number; target: PolicyEditorTarget } | null>(null);
  const editorKey = useRef(0);

  const load = useCallback(
    async (quiet = false) => {
      if (!quiet) setLoading(true);
      setLoadError(null);
      try {
        setData(await iamApi.listPolicies());
      } catch (err) {
        setLoadError(
          err instanceof IamApiError && err.status === 403 ? t('errors.forbidden') : errorText(err, t('errors.load')),
        );
      } finally {
        setLoading(false);
      }
    },
    [errorText, t],
  );

  useEffect(() => {
    void load();
  }, [load]);

  const custom = data?.custom;

  const openEditor = useCallback((target: PolicyEditorTarget) => {
    editorKey.current += 1;
    setEditor({ key: editorKey.current, target });
  }, []);

  // ── deep links: ?new=1[&principalType&principalId] and ?policyId= ────────

  const handled = useRef('');
  useEffect(() => {
    if (!data || !catalog) return;
    const key = searchParams.toString();
    if (handled.current === key) return;
    const link: PolicyLinkParams = parsePolicyParams(searchParams);
    if (!link.isNew && !link.policyId) return;
    handled.current = key;

    const clearLink = () => {
      // Drop the one-shot parameters so a refresh does not reopen the editor.
      window.history.replaceState(null, '', iamHref('policies'));
    };

    void (async () => {
      if (link.isNew) {
        clearLink();
        if (!canManage) {
          notifications.show({ color: 'yellow', message: t('errors.readOnly') });
          return;
        }
        const resourcePrefill = link.resourceType && link.resourceId
          ? { type: link.resourceType, id: link.resourceId, label: link.resourceLabel || link.resourceId }
          : undefined;
        if (link.principalType && link.principalId) {
          let label = link.principalId;
          try {
            label = (await iamApi.getPrincipal(link.principalType, link.principalId)).principal.label || label;
          } catch {
            /* open with the id; the server validates it on save */
          }
          openEditor({ kind: 'create', prefill: { type: link.principalType, ref: { id: link.principalId, label } }, resourcePrefill });
        } else {
          openEditor({ kind: 'create', resourcePrefill });
        }
        return;
      }
      if (link.policyId) {
        clearLink();
        let row = data.custom.find((p) => p.policyId === link.policyId) ?? null;
        if (!row) {
          try {
            row = await iamApi.getPolicy(link.policyId);
          } catch {
            row = null;
          }
        }
        if (!row) {
          notifications.show({ color: 'yellow', message: t('errors.policyNotFound') });
          return;
        }
        if (canManage) openEditor({ kind: 'edit', policy: row });
        else router.replace(policyPageHref(row.policyId));
      }
    })();
  }, [data, catalog, searchParams, canManage, openEditor, router, t]);

  // ── list ─────────────────────────────────────────────────────────────────

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (custom ?? [])
      .filter((p) => enabledFilter === 'all' || (enabledFilter === 'enabled' ? p.enabled : !p.enabled))
      .filter((p) => effectFilter === 'all' || p.effect === effectFilter)
      .filter((p) => !q || p.name.toLowerCase().includes(q) || p.description.toLowerCase().includes(q))
      .sort((a, b) =>
        sortKey === 'updated'
          ? (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0) || a.name.localeCompare(b.name)
          : a.name.localeCompare(b.name),
      );
  }, [custom, search, enabledFilter, effectFilter, sortKey]);

  const needsGroupNames = useMemo(
    () => (custom ?? []).some((p) => p.spec && summarizeSpec(p.spec).groupIds.length > 0),
    [custom],
  );
  const groupNames = useGroupLabels(needsGroupNames);
  const projectNames = useMemo(() => new Map(projects.map((p) => [p.id, p.name])), [projects]);

  // ── mutations ────────────────────────────────────────────────────────────

  const setBusyFor = (id: string, on: boolean) =>
    setBusy((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  const applyChange = useCallback(
    async (row: PolicyRow, change: { enabled?: boolean }) => {
      setBusyFor(row.policyId, true);
      // Optimistic: the switch follows the click, and snaps back if the server refuses.
      setData((d) =>
        d ? { ...d, custom: d.custom.map((p) => (p.policyId === row.policyId ? { ...p, ...change } : p)) } : d,
      );
      try {
        const saved = await iamApi.updatePolicy(row.policyId, bodyOf(change));
        setData((d) => (d ? { ...d, custom: d.custom.map((p) => (p.policyId === saved.policyId ? saved : p)) } : d));
        notifications.show({ color: 'green', message: t('table.updated', { name: row.name }) });
      } catch (err) {
        setData((d) => (d ? { ...d, custom: d.custom.map((p) => (p.policyId === row.policyId ? row : p)) } : d));
        notifications.show({
          color: 'red',
          title: t('table.updateFailed', { name: row.name }),
          message: errorText(err),
        });
      } finally {
        setBusyFor(row.policyId, false);
      }
    },
    [errorText, t],
  );

  const toggleEnabled = useCallback(
    async (row: PolicyRow, enabled: boolean) => {
      // Every policy decides real requests, so switching one on or off is always confirmed.
      const ok = await confirm({
        title: enabled ? t('table.enableTitle', { name: row.name }) : t('table.disableTitle', { name: row.name }),
        message: enabled ? t('table.enableMessage') : t('table.disableMessage'),
        confirmLabel: enabled ? t('table.enable') : t('table.disable'),
        tone: row.effect === 'forbid' && !enabled ? 'warning' : 'neutral',
      });
      if (!ok) return;
      await applyChange(row, { enabled });
    },
    [applyChange, confirm, t],
  );

  const removePolicy = useCallback(
    async (row: PolicyRow) => {
      const done = await deleteResource({
        noun: t('policyNoun'),
        name: row.name,
        extraWarning: row.enabled ? t('table.deleteEnabledWarning') : undefined,
        action: async () => {
          await iamApi.deletePolicy(row.policyId);
        },
      });
      if (done) {
        setData((d) => (d ? { ...d, custom: d.custom.filter((p) => p.policyId !== row.policyId) } : d));
        notifications.show({ color: 'green', message: t('table.deleted', { name: row.name }) });
        void load(true);
      }
    },
    [deleteResource, load, t],
  );

  const handleSaved = useCallback(
    (row: PolicyRow) => {
      setEditor(null);
      setData((d) => {
        if (!d) return d;
        const exists = d.custom.some((p) => p.policyId === row.policyId);
        return {
          ...d,
          custom: exists ? d.custom.map((p) => (p.policyId === row.policyId ? row : p)) : [...d.custom, row],
        };
      });
      void load(true);
    },
    [load],
  );

  // ── render ───────────────────────────────────────────────────────────────

  const renderScope = (row: PolicyRow) => {
    if (!row.spec) {
      return (
        <Text size="xs" c="dimmed">
          {t('table.rawCedar', { count: row.statementCount })}
        </Text>
      );
    }
    const l = describeSpec(row.spec, {
      t,
      labels,
      groupNames,
      projectNames,
      formatDate: (iso) => formatDateTime(iso, locale),
    });
    return (
      <Stack gap={1}>
        <Text size="xs" lineClamp={1} title={l.who}>
          <Text span fw={600} size="xs">
            {t('summary.who')}:{' '}
          </Text>
          {l.who}
        </Text>
        <Text size="xs" lineClamp={2} title={`${l.what} · ${l.where}`}>
          <Text span fw={600} size="xs">
            {t('summary.what')}:{' '}
          </Text>
          {l.what}
          <Text span c="dimmed" size="xs">
            {' · '}
            {l.where}
          </Text>
        </Text>
        {l.when ? (
          <Text size="xs" c="dimmed" lineClamp={1} title={l.when}>
            {l.when}
          </Text>
        ) : null}
      </Stack>
    );
  };

  const openRow = (row: PolicyRow) => (canManage ? openEditor({ kind: 'edit', policy: row }) : router.push(policyPageHref(row.policyId)));

  const renderName = (row: PolicyRow, wrap: boolean) => (
    <>
      <Text
        size="sm"
        fw={600}
        {...(wrap ? { lineClamp: 2 } : { truncate: true })}
        style={{ cursor: 'pointer' }}
        onClick={() => openRow(row)}
      >
        {row.name}
      </Text>
      {row.description ? (
        <Text size="xs" c="dimmed" lineClamp={wrap ? 2 : 1} title={row.description}>
          {row.description}
        </Text>
      ) : null}
      {!row.spec ? (
        <Badge size="xs" variant="default" mt={2}>
          Cedar
        </Badge>
      ) : null}
    </>
  );

  const renderSwitch = (row: PolicyRow) => (
    <Switch
      checked={row.enabled}
      disabled={!canManage || busy.has(row.policyId)}
      onChange={(e) => void toggleEnabled(row, e.currentTarget.checked)}
      aria-label={t('table.colEnabled')}
    />
  );

  const renderUpdated = (row: PolicyRow) => (
    <Tooltip
      label={t('table.updatedBy', {
        date: formatDateTime(row.updatedAt, locale),
        by: row.updatedByLabel || row.updatedBy || '—',
      })}
    >
      <Text size="xs" style={{ whiteSpace: 'nowrap' }}>
        {formatRelative(row.updatedAt, locale)}
      </Text>
    </Tooltip>
  );

  const renderMenu = (row: PolicyRow) => (
    <Menu position="bottom-end" withinPortal>
      <Menu.Target>
        <ActionIcon variant="subtle" color="gray" aria-label={t('table.actions')}>
          <IconDots size={16} />
        </ActionIcon>
      </Menu.Target>
      <Menu.Dropdown>
        {canManage ? (
          <>
            <Menu.Item leftSection={<IconEdit size={14} />} onClick={() => openEditor({ kind: 'edit', policy: row })}>
              {t('table.edit')}
            </Menu.Item>
            <Menu.Item leftSection={<IconCopy size={14} />} onClick={() => openEditor({ kind: 'duplicate', policy: row })}>
              {t('table.duplicate')}
            </Menu.Item>
            <Menu.Divider />
            <Menu.Item color="red" leftSection={<IconTrash size={14} />} onClick={() => void removePolicy(row)}>
              {t('table.delete')}
            </Menu.Item>
          </>
        ) : (
          <Menu.Item leftSection={<IconEye size={14} />} onClick={() => router.push(policyPageHref(row.policyId))}>
            {t('table.view')}
          </Menu.Item>
        )}
      </Menu.Dropdown>
    </Menu>
  );

  return (
    <Stack gap="lg">
      {!canManage ? (
        <Alert color="gray" variant="light">
          {t('errors.readOnly')}
        </Alert>
      ) : null}

      <Group justify="space-between" align="flex-end" wrap="wrap" gap="sm">
        <div style={{ flex: 1, minWidth: 240 }}>
          <Text fw={600}>{t('policies.title')}</Text>
          <Text size="sm" c="dimmed" maw={720}>
            {t('policies.description')}
          </Text>
        </div>
        <Group gap="xs">
          <Button
            size="xs"
            variant="default"
            leftSection={<IconRefresh size={14} />}
            loading={loading && !!data}
            onClick={() => void load()}
          >
            {t('common.refresh')}
          </Button>
          {canManage ? (
            <Button
              size="xs"
              leftSection={<IconPlus size={14} />}
              disabled={!catalog || !index}
              onClick={() => openEditor({ kind: 'create' })}
            >
              {t('policies.create')}
            </Button>
          ) : null}
        </Group>
      </Group>

      {catalogError ? (
        <Alert color="red" icon={<IconAlertTriangle size={16} />} title={t('errors.catalog')}>
          <Group justify="space-between">
            <Text size="sm">{catalogError}</Text>
            <Button size="xs" variant="light" onClick={reloadCatalog}>
              {t('common.retry')}
            </Button>
          </Group>
        </Alert>
      ) : null}

      {/* Custom policies */}
      <Paper withBorder radius="md" p="md" ref={tableBox}>
        <Stack gap="sm">
          <Group justify="space-between" wrap="wrap" gap="sm">
            <Text fw={600}>
              {t('policies.customTitle')}
              {custom ? (
                <Text span c="dimmed" fw={400} size="sm">
                  {' '}
                  ({custom.length})
                </Text>
              ) : null}
            </Text>
            <Group gap="xs" wrap="wrap">
              <TextInput
                size="xs"
                leftSection={<IconSearch size={14} />}
                placeholder={t('policies.searchPlaceholder')}
                value={search}
                onChange={(e) => setSearch(e.currentTarget.value)}
                aria-label={t('policies.searchPlaceholder')}
                w={{ base: '100%', sm: 220 }}
              />
              <SegmentedControl
                size="xs"
                value={effectFilter}
                onChange={(v) => setEffectFilter(v as EffectFilter)}
                data={[
                  { value: 'all', label: t('policies.filterAll') },
                  { value: 'permit', label: t('effects.permit') },
                  { value: 'forbid', label: t('effects.forbid') },
                ]}
              />
              <SegmentedControl
                size="xs"
                value={enabledFilter}
                onChange={(v) => setEnabledFilter(v as EnabledFilter)}
                aria-label={t('table.colEnabled')}
                data={[
                  { value: 'all', label: t('policies.filterAll') },
                  { value: 'enabled', label: t('policies.filterEnabled') },
                  { value: 'disabled', label: t('policies.filterDisabled') },
                ]}
              />
              <SegmentedControl
                size="xs"
                value={sortKey}
                onChange={(v) => setSortKey(v as SortKey)}
                aria-label={t('policies.sortLabel')}
                data={[
                  { value: 'name', label: t('policies.sortName') },
                  { value: 'updated', label: t('policies.sortUpdated') },
                ]}
              />
            </Group>
          </Group>

          {loading && !data ? (
            <Group justify="center" py="xl">
              <Loader size="sm" />
            </Group>
          ) : loadError ? (
            <Alert color="red" icon={<IconAlertTriangle size={16} />} title={t('errors.load')}>
              <Group justify="space-between">
                <Text size="sm">{loadError}</Text>
                <Button size="xs" variant="light" leftSection={<IconRefresh size={14} />} onClick={() => void load()}>
                  {t('common.retry')}
                </Button>
              </Group>
            </Alert>
          ) : (custom?.length ?? 0) === 0 ? (
            <EmptyState
              title={t('policies.emptyTitle')}
              description={t('policies.emptyDescription')}
              icon={<IconShieldPlus size={24} stroke={1.6} />}
              action={
                canManage ? (
                  <Button
                    size="xs"
                    leftSection={<IconPlus size={14} />}
                    disabled={!catalog || !index}
                    onClick={() => openEditor({ kind: 'create' })}
                  >
                    {t('policies.create')}
                  </Button>
                ) : undefined
              }
            />
          ) : rows.length === 0 ? (
            <Text size="sm" c="dimmed" py="md" ta="center">
              {t('policies.noMatches')}
            </Text>
          ) : (
            compact ? (
              <Stack gap="sm">
                {rows.map((row) => (
                  <Paper key={row.policyId} withBorder radius="md" p="sm" style={{ opacity: row.enabled ? 1 : 0.7 }}>
                    <Group justify="space-between" wrap="nowrap" align="flex-start" gap="xs">
                      <div style={{ minWidth: 0, flex: 1 }}>{renderName(row, true)}</div>
                      <Group gap={4} wrap="nowrap">
                        {renderSwitch(row)}
                        {renderMenu(row)}
                      </Group>
                    </Group>
                    <Group gap={6} mt={8}>
                      <EffectBadge effect={row.effect} labels={labels} />
                    </Group>
                    <div style={{ marginTop: 8 }}>{renderScope(row)}</div>
                    <Group justify="flex-end" mt={8} gap="xs">
                      {renderUpdated(row)}
                    </Group>
                  </Paper>
                ))}
              </Stack>
            ) : (
            <Table.ScrollContainer minWidth={TABLE_MIN_WIDTH}>
              <Table verticalSpacing="sm" highlightOnHover>
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th miw={180}>{t('table.colName')}</Table.Th>
                    <Table.Th miw={96}>{t('table.colEffect')}</Table.Th>
                    <Table.Th miw={72}>{t('table.colEnabled')}</Table.Th>
                    <Table.Th miw={240}>{t('table.colScope')}</Table.Th>
                    <Table.Th miw={120}>{t('table.colUpdated')}</Table.Th>
                    <Table.Th w={44} />
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {rows.map((row) => (
                    <Table.Tr key={row.policyId} style={{ opacity: row.enabled ? 1 : 0.7 }}>
                      <Table.Td maw={260}>{renderName(row, false)}</Table.Td>
                      <Table.Td>
                        <EffectBadge effect={row.effect} labels={labels} />
                      </Table.Td>
                      <Table.Td>{renderSwitch(row)}</Table.Td>
                      <Table.Td maw={340}>{renderScope(row)}</Table.Td>
                      <Table.Td>{renderUpdated(row)}</Table.Td>
                      <Table.Td>{renderMenu(row)}</Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </Table.ScrollContainer>
            )
          )}
        </Stack>
      </Paper>

      {/* Built-in policies */}
      <Paper withBorder radius="md" p="md">
        <Stack gap="sm">
          <div>
            <Text fw={600}>{t('managed.title')}</Text>
            <Text size="sm" c="dimmed" maw={720}>
              {t('managed.description')}
            </Text>
          </div>
          {data ? (
            <ManagedPolicies policies={data.managed} labels={labels} />
          ) : loading ? (
            <Group justify="center" py="md">
              <Loader size="sm" />
            </Group>
          ) : null}
        </Stack>
      </Paper>

      {editor && catalog && index ? (
        <PolicyEditor
          key={editor.key}
          target={editor.target}
          catalog={catalog}
          index={index}
          labels={labels}
          onClose={() => setEditor(null)}
          onSaved={handleSaved}
        />
      ) : null}

    </Stack>
  );
}
