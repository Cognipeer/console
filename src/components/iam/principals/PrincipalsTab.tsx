'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import {
  ActionIcon,
  Alert,
  Badge,
  Button,
  Group,
  SegmentedControl,
  Stack,
  Text,
  Tooltip,
  UnstyledButton,
} from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { IconAlertTriangle, IconRefresh } from '@tabler/icons-react';
import DataGrid, { type DataGridColumn } from '@/components/common/ui/DataGrid';
import { useTranslations } from '@/lib/i18n';
import {
  fetchPrincipals,
  IamApiError,
  isAbortError,
  isPrincipalType,
  PRINCIPAL_TYPES,
  type PrincipalPage,
  type PrincipalSummary,
  type PrincipalType,
} from './client';
import { translateOr, type Translate } from './format';
import { PagerControls, useCursorPager } from './pager';
import PrincipalDetailDrawer, { type PrincipalTarget } from './PrincipalDetailDrawer';
import { replaceUrlParams } from './urlState';
import { badgeVariant, PrincipalAvatar, roleColor, statusColor } from './visuals';

const NS = 'iamPrincipals';
const PAGE_SIZE = 25;

/**
 * A Mantine badge clips itself to an ellipsis (its grid track has no minimum),
 * so inside an auto-width table cell it collapses to its padding on a narrow
 * screen. `max-content` keeps it whole and lets the table scroll sideways.
 */
const NO_SHRINK = { minWidth: 'max-content' } as const;

interface ListState {
  /** The segment the loaded page belongs to (columns differ per segment). */
  forType: PrincipalType | null;
  page: PrincipalPage | null;
  loading: boolean;
  error: string | null;
}

function describeError(err: unknown, t: Translate): string {
  if (err instanceof IamApiError) {
    if (err.status === 403) return t('errors.forbidden');
    return err.message;
  }
  return err instanceof Error ? err.message : String(err);
}

/** Mirrors the open principal into the address bar so the drawer is linkable. */
function mirrorTarget(target: PrincipalTarget | null): string {
  replaceUrlParams({
    principalType: target ? target.type : null,
    principalId: target ? target.id : null,
  });
  return target ? `${target.type}\u0000${target.id}` : '';
}

export default function PrincipalsTab({ canManage }: { canManage: boolean }) {
  const t = useTranslations(NS);
  // Null outside the app router (a test, a pages-router host): then there is simply no deep link.
  const searchParams = useSearchParams();
  const urlType = searchParams?.get('principalType') ?? null;
  const urlId = searchParams?.get('principalId') ?? null;

  const [type, setType] = useState<PrincipalType>(isPrincipalType(urlType) ? urlType : 'user');
  const [searchInput, setSearchInput] = useState('');
  const [debounced] = useDebouncedValue(searchInput.trim(), 300);
  const pager = useCursorPager(`${type}\u0000${debounced}`);
  const [reload, setReload] = useState(0);
  const [state, setState] = useState<ListState>({ forType: null, page: null, loading: true, error: null });

  // The drawer is a stack so that a group or token opened from a user can go back.
  const [stack, setStack] = useState<PrincipalTarget[]>([]);
  const target = stack[stack.length - 1] ?? null;
  const urlKey = useRef('');

  useEffect(() => {
    const controller = new AbortController();
    setState((s) => ({ ...s, loading: true, error: null }));
    fetchPrincipals({ type, q: debounced, limit: PAGE_SIZE, cursor: pager.cursor }, controller.signal)
      .then((page) => {
        if (!controller.signal.aborted) setState({ forType: type, page, loading: false, error: null });
      })
      .catch((err: unknown) => {
        if (isAbortError(err)) return;
        setState((s) => ({ ...s, loading: false, error: describeError(err, t) }));
      });
    return () => controller.abort();
  }, [type, debounced, pager.cursor, reload, t]);

  // Deep link: ?tab=principals&principalType=user&principalId=<id> opens that drawer.
  useEffect(() => {
    if (!isPrincipalType(urlType) || !urlId) {
      urlKey.current = '';
      return;
    }
    const key = `${urlType}\u0000${urlId}`;
    if (urlKey.current === key) return; // our own write of the same target
    urlKey.current = key;
    setType(urlType);
    setStack([{ type: urlType, id: urlId }]);
  }, [urlType, urlId]);

  const showStack = useCallback((next: PrincipalTarget[]) => {
    setStack(next);
    urlKey.current = mirrorTarget(next[next.length - 1] ?? null);
  }, []);

  const openFromList = useCallback(
    (row: PrincipalSummary) => showStack([{ type: row.type, id: row.id, summary: row }]),
    [showStack],
  );
  const openNested = useCallback(
    (next: PrincipalTarget) => {
      const top = stack[stack.length - 1];
      if (top && top.type === next.type && top.id === next.id) return;
      showStack([...stack, next]);
    },
    [showStack, stack],
  );
  const goBack = useCallback(() => showStack(stack.slice(0, -1)), [showStack, stack]);
  const closeDrawer = useCallback(() => showStack([]), [showStack]);

  const items = state.forType === type ? (state.page?.items ?? []) : [];
  const nextCursor = state.forType === type ? (state.page?.nextCursor ?? null) : null;

  const columns = useMemo<DataGridColumn<PrincipalSummary>[]>(() => {
    const name: DataGridColumn<PrincipalSummary> = {
      key: 'name',
      label: t('columns.name'),
      render: (row) => (
        <UnstyledButton
          onClick={(e) => {
            e.stopPropagation();
            openFromList(row);
          }}
          aria-label={t('openDetail', { name: row.label })}
          style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 220, textAlign: 'left', maxWidth: 420 }}
        >
          <PrincipalAvatar type={row.type} label={row.label} size={30} />
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 13, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {row.label}
            </div>
            {row.sublabel ? (
              <div className="ds-faint" style={{ fontSize: 11.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {row.sublabel}
              </div>
            ) : null}
          </div>
        </UnstyledButton>
      ),
    };
    const status: DataGridColumn<PrincipalSummary> = {
      key: 'status',
      label: t('columns.status'),
      width: 130,
      render: (row) =>
        row.status ? (
          <Badge variant={badgeVariant(statusColor(row.status))} color={statusColor(row.status)} radius="sm" style={NO_SHRINK}>
            {translateOr(t, NS, `statuses.${row.status}`, row.status)}
          </Badge>
        ) : (
          <Text size="sm" c="dimmed">
            —
          </Text>
        ),
    };
    const policies: DataGridColumn<PrincipalSummary> = {
      key: 'policies',
      label: t('columns.policies'),
      width: 110,
      align: 'right',
      render: (row) => (
        <Tooltip label={t('columns.policiesHint')} withArrow multiline w={240} openDelay={300}>
          <Badge variant={row.policyCount > 0 ? 'light' : 'default'} color="grape" radius="sm" style={NO_SHRINK}>
            {row.policyCount.toLocaleString()}
          </Badge>
        </Tooltip>
      ),
    };

    if (type === 'user') {
      return [
        name,
        {
          key: 'role',
          label: t('columns.role'),
          width: 150,
          render: (row) =>
            row.role ? (
              <Badge variant={badgeVariant(roleColor(row.role))} color={roleColor(row.role)} radius="sm" style={NO_SHRINK}>
                {translateOr(t, NS, `roles.${row.role}`, row.role)}
              </Badge>
            ) : (
              <Text size="sm" c="dimmed">
                —
              </Text>
            ),
        },
        status,
        policies,
      ];
    }
    if (type === 'group') {
      return [
        name,
        {
          key: 'members',
          label: t('columns.members'),
          width: 120,
          align: 'right',
          render: (row) => (
            <Text size="sm">{row.memberCount === null ? '—' : row.memberCount.toLocaleString()}</Text>
          ),
        },
        policies,
      ];
    }
    return [name, status, policies];
  }, [type, t, openFromList]);

  // A failed load must not read as an empty directory: the grid's empty state carries the error.
  const emptyView = state.error
    ? {
        icon: <IconAlertTriangle size={28} stroke={1.5} color="var(--mantine-color-red-6)" />,
        title: t('errors.loadFailed'),
        description: state.error,
        primaryAction: {
          label: t('errors.retry'),
          icon: <IconRefresh size={14} />,
          onClick: () => setReload((n) => n + 1),
        },
      }
    : debounced
      ? { title: t('empty.noMatches'), description: t('empty.noMatchesHint', { query: debounced }) }
      : { title: t(`empty.none.${type}`), description: t('empty.noneHint') };

  return (
    <Stack gap="md">
      <Group align="center" gap="md" wrap="wrap">
        <SegmentedControl
          value={type}
          onChange={(v) => setType(v as PrincipalType)}
          aria-label={t('segments.label')}
          data={PRINCIPAL_TYPES.map((p) => ({ value: p, label: t(`segments.${p}`) }))}
        />
        <Text size="sm" c="dimmed" maw={640} style={{ flex: '1 1 260px' }}>
          {t(`hint.${type}`)}
        </Text>
      </Group>

      {state.error && items.length > 0 ? (
        <Alert color="red" icon={<IconAlertTriangle size={16} />} title={t('errors.loadFailed')}>
          <Stack gap="xs" align="flex-start">
            <Text size="sm">{state.error}</Text>
            <Button size="xs" variant="light" leftSection={<IconRefresh size={14} />} onClick={() => setReload((n) => n + 1)}>
              {t('errors.retry')}
            </Button>
          </Stack>
        </Alert>
      ) : null}

      <DataGrid<PrincipalSummary>
        records={items}
        rowKey={(row) => `${row.type}:${row.id}`}
        columns={columns}
        loading={state.loading}
        onRowClick={openFromList}
        search={{
          value: searchInput,
          onChange: setSearchInput,
          placeholder: t(`search.${type}`),
        }}
        toolbarRight={
          <Tooltip label={t('refresh')} withArrow>
            <ActionIcon
              variant="subtle"
              color="gray"
              radius="md"
              loading={state.loading}
              onClick={() => setReload((n) => n + 1)}
              aria-label={t('refresh')}
            >
              <IconRefresh size={14} stroke={1.7} />
            </ActionIcon>
          </Tooltip>
        }
        empty={emptyView}
        footerLeft={items.length > 0 ? t('showing', { count: items.length }) : undefined}
        footerRight={
          <PagerControls
            page={pager.page}
            hasNext={nextCursor !== null}
            loading={state.loading}
            onPrev={pager.prev}
            onNext={() => nextCursor && pager.next(nextCursor)}
            previousLabel={t('pager.previous')}
            nextLabel={t('pager.next')}
            pageLabel={t('pager.page', { page: pager.page })}
          />
        }
      />

      <PrincipalDetailDrawer
        opened={stack.length > 0}
        target={target}
        canManage={canManage}
        canGoBack={stack.length > 1}
        onBack={goBack}
        onClose={closeDrawer}
        onOpen={openNested}
      />
    </Stack>
  );
}
