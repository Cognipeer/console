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
  Select,
  Stack,
  Text,
  Tooltip,
  UnstyledButton,
} from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import {
  IconAlertTriangle,
  IconCopy,
  IconExternalLink,
  IconKey,
  IconLock,
  IconRefresh,
  IconShieldCheck,
  IconShieldHalf,
  IconTrash,
  IconUserCheck,
  IconUserEdit,
  IconUserOff,
  IconUserPlus,
  IconUsersGroup,
} from '@tabler/icons-react';
import DataGrid, { type DataGridColumn, type DataGridRowAction } from '@/components/common/ui/DataGrid';
import TokenStatusBadges from '@/components/iam/tokens/TokenStatusBadges';
import { useLocale, useTranslations } from '@/lib/i18n';
import AddMenu from './AddMenu';
import {
  isAbortError,
  isPrincipalType,
  PRINCIPAL_TYPES,
  type PrincipalPage,
  type PrincipalSummary,
  type PrincipalTarget,
  type PrincipalType,
} from './client';
import { directoryApi, type InviteResult, type ProjectChoice } from './directoryApi';
import { describeError } from './errors';
import FilterBar from './FilterBar';
import { formatDateTime, formatRelativeTime, translateOr } from './format';
import GroupShell from './GroupShell';
import ImportPeopleShell from './ImportPeopleShell';
import InvitePersonShell from './InvitePersonShell';
import {
  isNarrowed,
  listKey,
  listStateToParams,
  listStateToQuery,
  NO_OVERLAY,
  normalizePageSize,
  overlayToParams,
  PAGE_SIZES,
  parseListState,
  parseOverlay,
  resetListState,
  type EditKind,
  type ListState,
  type NewKind,
  type OverlayState,
} from './listState';
import MembershipShell from './MembershipShell';
import NewTokenShell from './NewTokenShell';
import { PagerControls, useCursorPager } from './pager';
import PrincipalDetailDrawer, { type DrawerContext } from './PrincipalDetailDrawer';
import { replaceUrlParams } from './urlState';
import { useBulkFlow } from './useBulkFlow';
import { usePeopleActions } from './usePeopleActions';
import { usePeopleCapabilities } from './usePeopleCapabilities';
import { badgeVariant, PrincipalAvatar, roleColor, statusColor } from './visuals';

const NS = 'iamPrincipals';

/**
 * A Mantine badge clips itself to an ellipsis (its grid track has no minimum),
 * so inside an auto-width table cell it collapses to its padding on a narrow
 * screen. `max-content` keeps it whole and lets the table scroll sideways.
 */
const NO_SHRINK = { minWidth: 'max-content' } as const;

const EMPTY_PARAMS = new URLSearchParams();

interface LoadState {
  /** The segment the loaded page belongs to (columns differ per segment). */
  forType: PrincipalType | null;
  page: PrincipalPage | null;
  loading: boolean;
  error: unknown;
}

const dash = (
  <Text size="sm" c="dimmed">
    —
  </Text>
);

export default function PrincipalsTab({ canManage }: { canManage: boolean }) {
  const t = useTranslations(NS);
  const td = useTranslations('iamDirectory');
  const locale = useLocale();
  // Null outside the app router (a test, a pages-router host): then there is simply no deep link.
  const searchParams = useSearchParams();
  const params = searchParams ?? EMPTY_PARAMS;
  const paramsKey = params.toString();
  const caps = usePeopleCapabilities();

  // ── view state, mirrored into the address bar ─────────────────────────
  const urlType = params.get('principalType');
  const urlId = params.get('principalId');
  const initialType: PrincipalType = isPrincipalType(urlType) ? urlType : 'user';
  const [type, setType] = useState<PrincipalType>(initialType);
  const [filters, setFilters] = useState<ListState>(() => parseListState(initialType, params));
  const [searchInput, setSearchInput] = useState(filters.q);
  const [debouncedSearch] = useDebouncedValue(searchInput.trim(), 300);
  const [pageSize, setPageSize] = useState<number>(25);
  const [overlay, setOverlay] = useState<OverlayState>(() => parseOverlay(params));
  // The drawer is a stack so that a group or token opened from a user can go back.
  const [stack, setStack] = useState<PrincipalTarget[]>(() =>
    isPrincipalType(urlType) && urlId ? [{ type: urlType, id: urlId }] : [],
  );
  const target = stack[stack.length - 1] ?? null;

  // Query strings this tab wrote itself: the router reports them back, and they must not be re-read as navigation.
  const written = useRef(new Set<string>([paramsKey]));
  const mirror = useCallback((updates: Record<string, string | null>) => {
    const key = replaceUrlParams(updates);
    if (key === null) return;
    if (written.current.size > 30) written.current.clear();
    written.current.add(key);
  }, []);

  useEffect(() => {
    if (written.current.has(paramsKey)) return;
    // A navigation from outside (a link to another view of this list): adopt it.
    const nextType: PrincipalType = isPrincipalType(urlType) ? urlType : 'user';
    const nextFilters = parseListState(nextType, params);
    written.current = new Set([paramsKey]);
    setType(nextType);
    setFilters(nextFilters);
    setSearchInput(nextFilters.q);
    setOverlay(parseOverlay(params));
    setStack(isPrincipalType(urlType) && urlId ? [{ type: urlType, id: urlId }] : []);
    // `params` is derived from `paramsKey`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paramsKey]);

  // The search box feeds the applied search text after a pause.
  useEffect(() => {
    if (debouncedSearch === filters.q) return;
    setFilters((f) => ({ ...f, q: debouncedSearch }));
    mirror(listStateToParams(type, { ...filters, q: debouncedSearch }));
    // Only the debounced text drives this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedSearch]);

  const key = listKey(type, filters, pageSize);
  const pager = useCursorPager(key);
  const [reload, setReload] = useState(0);
  const refresh = useCallback(() => setReload((n) => n + 1), []);
  const [load, setLoad] = useState<LoadState>({ forType: null, page: null, loading: true, error: null });
  const totals = useRef(new Map<string, number>());
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [projects, setProjects] = useState<ProjectChoice[]>([]);
  const [ownerLabel, setOwnerLabel] = useState<string | null>(null);
  const [groupLabel, setGroupLabel] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setLoad((s) => ({ ...s, loading: true, error: null }));
    const first = pager.cursor === null;
    directoryApi
      .list(
        {
          type,
          q: filters.q,
          limit: pageSize,
          cursor: pager.cursor,
          filters: listStateToQuery(type, filters),
          // The exact total costs a scan: ask for it once per view, with its first page.
          count: first,
        },
        controller.signal,
      )
      .then((page) => {
        if (controller.signal.aborted) return;
        if (page.total !== undefined) totals.current.set(key, page.total);
        setLoad({ forType: type, page, loading: false, error: null });
      })
      .catch((error: unknown) => {
        if (isAbortError(error)) return;
        setLoad((s) => ({ ...s, loading: false, error }));
      });
    return () => controller.abort();
    // `filters` is part of `key`; the pager cursor and reload drive the rest.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, pager.cursor, reload]);

  // A page, a filter or a refresh starts with nothing selected.
  useEffect(() => setSelected(new Set()), [key, pager.cursor, reload]);

  const items = useMemo(() => (load.forType === type ? (load.page?.items ?? []) : []), [load.forType, load.page, type]);
  const nextCursor = load.forType === type ? (load.page?.nextCursor ?? null) : null;
  const total = load.forType === type ? (totals.current.get(key) ?? null) : null;

  // The workspace's projects, once: the project filter of every segment is a list of them.
  useEffect(() => {
    const controller = new AbortController();
    directoryApi
      .listProjects(controller.signal)
      .then((res) => {
        if (!controller.signal.aborted) setProjects(res.projects);
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, []);

  // The names behind the owner and group filters, from the ids of the address bar.
  const ownerId = type === 'token' ? filters.ownerId : '';
  useEffect(() => {
    if (!ownerId) {
      setOwnerLabel(null);
      return;
    }
    const controller = new AbortController();
    directoryApi
      .list({ type: 'user', ids: [ownerId], limit: 1 }, controller.signal)
      .then((page) => {
        if (!controller.signal.aborted) setOwnerLabel(page.items[0]?.label ?? null);
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, [ownerId]);

  const filterGroupId = type === 'user' ? filters.groupId : '';
  useEffect(() => {
    if (!filterGroupId) {
      setGroupLabel(null);
      return;
    }
    const controller = new AbortController();
    directoryApi
      .list({ type: 'group', ids: [filterGroupId], limit: 1 }, controller.signal)
      .then((page) => {
        if (!controller.signal.aborted) setGroupLabel(page.items[0]?.label ?? null);
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, [filterGroupId]);

  // ── view changes ──────────────────────────────────────────────────────
  const changeFilters = useCallback(
    (patch: Partial<ListState>) => {
      const next = { ...filters, ...patch };
      setFilters(next);
      mirror(listStateToParams(type, next));
    },
    [filters, mirror, type],
  );

  const resetFilters = useCallback(() => {
    const next = resetListState();
    setFilters(next);
    setSearchInput('');
    mirror(listStateToParams(type, next));
  }, [mirror, type]);

  const switchSegment = useCallback(
    (next: PrincipalType) => {
      if (next === type) return;
      const fresh = resetListState();
      setType(next);
      setFilters(fresh);
      setSearchInput('');
      setStack([]);
      setOverlay(NO_OVERLAY);
      mirror({ ...listStateToParams(next, fresh), principalType: next, principalId: null, new: null, edit: null });
    },
    [mirror, type],
  );

  const showStack = useCallback(
    (next: PrincipalTarget[], edit: EditKind | null = null) => {
      setStack(next);
      const top = next[next.length - 1] ?? null;
      setOverlay((o) => ({ ...o, edit: top ? edit : null }));
      // The segment stays in the address bar when the drawer closes.
      mirror({
        principalType: top ? top.type : type,
        principalId: top ? top.id : null,
        edit: top ? edit : null,
      });
    },
    [mirror, type],
  );

  const openFromList = useCallback(
    (row: PrincipalSummary, edit: EditKind | null = null) => showStack([{ type: row.type, id: row.id, summary: row }], edit),
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

  const setNew = useCallback(
    (kind: NewKind | null) => {
      const next: OverlayState = { new: kind, edit: kind ? null : overlay.edit };
      setOverlay(next);
      mirror(overlayToParams(next));
    },
    [mirror, overlay.edit],
  );
  const setEdit = useCallback(
    (kind: EditKind | null) => {
      setOverlay((o) => ({ ...o, edit: kind }));
      mirror({ edit: kind });
    },
    [mirror],
  );

  // ── actions ───────────────────────────────────────────────────────────
  // A dialog or a form that is open owns the Escape key; the drawer must not close under it.
  const [busy, setBusy] = useState(0);
  const [drawerForm, setDrawerForm] = useState(false);
  const guard = useCallback(async <T,>(run: () => Promise<T>): Promise<T> => {
    setBusy((n) => n + 1);
    try {
      return await run();
    } finally {
      setBusy((n) => n - 1);
    }
  }, []);
  const actions = usePeopleActions({ onChanged: refresh, guard });
  const labels = useMemo(() => new Map(items.map((i) => [i.id, i.label])), [items]);
  const bulk = useBulkFlow({ onDone: refresh, labelOf: (id) => labels.get(id) ?? id, guard });

  const [tokenOwner, setTokenOwner] = useState<{ id: string; label: string } | null>(null);
  const [bulkGroup, setBulkGroup] = useState<'bulk-add' | 'bulk-remove' | null>(null);
  const [bulkIds, setBulkIds] = useState<string[]>([]);
  const me = caps.me;
  const canWrite = caps.ready && caps.peopleManage;

  const drawerContext = useMemo<DrawerContext>(
    () => ({
      me,
      assignableRoles: caps.assignableRoles,
      canMintForOthers: caps.tokensManageOthers,
      actions,
      edit: overlay.edit,
      onEdit: setEdit,
      onChanged: refresh,
      onOverlayChange: setDrawerForm,
      onNewToken: (owner) => {
        setTokenOwner(owner);
        setNew('token');
      },
      onGone: closeDrawer,
    }),
    [me, caps.assignableRoles, caps.tokensManageOthers, actions, overlay.edit, setEdit, refresh, setNew, closeDrawer],
  );

  // ── columns ───────────────────────────────────────────────────────────
  const columns = useMemo<DataGridColumn<PrincipalSummary>[]>(() => {
    const name: DataGridColumn<PrincipalSummary> = {
      key: 'name',
      label: type === 'user' ? td('list.columns.person') : type === 'group' ? td('list.columns.group') : td('list.columns.token'),
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
          dash
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
    const created: DataGridColumn<PrincipalSummary> = {
      key: 'created',
      label: td('list.columns.created'),
      width: 130,
      render: (row) =>
        row.createdAt ? (
          <Text size="xs" c="dimmed">
            {formatDateTime(row.createdAt, locale).split(',')[0]}
          </Text>
        ) : (
          dash
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
              dash
            ),
        },
        status,
        {
          key: 'kind',
          label: td('list.columns.type'),
          width: 150,
          render: (row) =>
            row.kind ? (
              <Badge variant="default" radius="sm" tt="none" style={NO_SHRINK}>
                {td(`badges.kinds.${row.kind}`)}
              </Badge>
            ) : (
              dash
            ),
        },
        {
          key: 'source',
          label: td('list.columns.source'),
          width: 140,
          render: (row) =>
            row.authProvider ? (
              <Badge
                variant="default"
                radius="sm"
                tt="none"
                style={NO_SHRINK}
                leftSection={row.managed ? <IconLock size={11} aria-label={td('badges.managedBadge')} /> : undefined}
              >
                {translateOr(td, 'iamDirectory', `badges.sources.${row.authProvider}`, row.authProvider)}
              </Badge>
            ) : (
              dash
            ),
        },
        created,
        policies,
      ];
    }
    if (type === 'group') {
      return [
        name,
        {
          key: 'source',
          label: td('list.columns.source'),
          width: 130,
          render: (row) => (
            <Badge variant="default" radius="sm" tt="none" style={NO_SHRINK}>
              {translateOr(td, 'iamDirectory', `badges.sources.${row.source ?? 'local'}`, row.source ?? 'local')}
            </Badge>
          ),
        },
        {
          key: 'tenantRole',
          label: td('list.columns.tenantRole'),
          width: 140,
          render: (row) =>
            row.tenantRole ? (
              <Badge variant={badgeVariant(roleColor(row.tenantRole))} color={roleColor(row.tenantRole)} radius="sm" style={NO_SHRINK}>
                {translateOr(t, NS, `roles.${row.tenantRole}`, row.tenantRole)}
              </Badge>
            ) : (
              dash
            ),
        },
        {
          key: 'members',
          label: t('columns.members'),
          width: 120,
          align: 'right',
          render: (row) => <Text size="sm">{row.memberCount === null ? '—' : row.memberCount.toLocaleString()}</Text>,
        },
        policies,
      ];
    }
    return [
      name,
      {
        key: 'owner',
        label: td('list.columns.owner'),
        width: 220,
        render: (row) =>
          row.ownerId ? (
            <Group gap={6} wrap="wrap">
              <UnstyledButton
                onClick={(e) => {
                  e.stopPropagation();
                  openNested({ type: 'user', id: row.ownerId ?? '' });
                }}
              >
                <Text size="sm">{row.ownerLabel ?? row.ownerId}</Text>
              </UnstyledButton>
              {row.ownerKind === 'service' ? (
                <Badge size="xs" variant="default" radius="sm" tt="none" style={NO_SHRINK}>
                  {td('badges.kinds.service')}
                </Badge>
              ) : null}
              {row.ownerDisabled ? (
                <Badge size="xs" variant="light" color="red" radius="sm" tt="none" style={NO_SHRINK}>
                  {td('badges.ownerDisabled')}
                </Badge>
              ) : null}
            </Group>
          ) : (
            <Text size="xs" c="dimmed">
              {td('badges.ownerGone')}
            </Text>
          ),
      },
      {
        key: 'project',
        label: td('list.columns.project'),
        width: 160,
        render: (row) => (row.projectName || row.projectId ? <Text size="sm">{row.projectName ?? row.projectId}</Text> : dash),
      },
      {
        key: 'scope',
        label: td('list.columns.scope'),
        width: 120,
        render: (row) =>
          row.scoped === undefined ? (
            dash
          ) : (
            <Badge variant={row.scoped ? 'light' : 'default'} color="orange" radius="sm" tt="none" style={NO_SHRINK}>
              {row.scoped ? t('drawer.meta.scoped') : t('drawer.meta.unscoped')}
            </Badge>
          ),
      },
      {
        ...status,
        render: (row) => (
          <Group gap={4} wrap="nowrap">
            {row.status ? (
              <Badge variant={badgeVariant(statusColor(row.status))} color={statusColor(row.status)} radius="sm" style={NO_SHRINK}>
                {translateOr(t, NS, `statuses.${row.status}`, row.status)}
              </Badge>
            ) : null}
            {row.expiresAt || row.lastUsedAt || row.createdAt ? (
              <TokenStatusBadges
                token={{
                  _id: row.id,
                  label: row.label,
                  createdAt: row.createdAt ?? '',
                  expiresAt: row.expiresAt ?? null,
                  lastUsedAt: row.lastUsedAt ?? null,
                }}
              />
            ) : null}
          </Group>
        ),
      },
      {
        key: 'lastUsed',
        label: td('list.columns.lastUsed'),
        width: 130,
        render: (row) =>
          row.lastUsedAt ? (
            <Text size="xs" c="dimmed">
              {formatRelativeTime(row.lastUsedAt, { locale })}
            </Text>
          ) : (
            <Text size="xs" c="dimmed">
              {t('drawer.meta.neverUsed')}
            </Text>
          ),
      },
      {
        key: 'expires',
        label: td('list.columns.expires'),
        width: 130,
        render: (row) =>
          row.expiresAt ? (
            <Text size="xs" c="dimmed">
              {formatDateTime(row.expiresAt, locale).split(',')[0]}
            </Text>
          ) : (
            <Text size="xs" c="dimmed">
              {t('drawer.meta.noExpiry')}
            </Text>
          ),
      },
      created,
    ];
  }, [type, t, td, locale, openFromList, openNested]);

  // ── row actions: what the server says THIS viewer may do to the row ───
  // The list carries `allowedActions` per row (the same verdicts the writes enforce); an older server that
  // does not send them leaves the cheap facts of the row (owner, yourself, a directory account) to decide.
  const rowActions = useCallback(
    (row: PrincipalSummary): DataGridRowAction<PrincipalSummary>[] => {
      const open: DataGridRowAction<PrincipalSummary> = {
        id: 'open',
        label: td('actions.open'),
        icon: <IconExternalLink size={14} />,
        onClick: () => openFromList(row),
      };
      if (!caps.ready) return [open];
      const server = row.allowedActions;
      const may = (name: string, fallback: boolean): boolean => (server ? server[name]?.allowed === true : fallback);

      if (type === 'user') {
        const isSelf = me?.userId === row.id;
        const isOwner = row.role === 'owner';
        const managed = row.managed === true;
        const person = { id: row.id, name: row.label, email: row.email ?? row.sublabel };
        if (!server && !canWrite) return [open];
        const list: DataGridRowAction<PrincipalSummary>[] = [open];
        if (may('editProfile', !managed)) {
          list.push({ id: 'profile', label: td('actions.editProfile'), icon: <IconUserEdit size={14} />, onClick: () => openFromList(row, 'profile') });
        }
        if (may('changeRole', !isSelf && !isOwner)) {
          list.push({ id: 'role', label: td('actions.changeRole'), icon: <IconShieldHalf size={14} />, onClick: () => openFromList(row, 'role') });
        }
        if (may('editPermissions', !isOwner)) {
          list.push({ id: 'access', label: td('actions.editAccess'), icon: <IconShieldCheck size={14} />, onClick: () => openFromList(row, 'access') });
        }
        if (row.status === 'invited' && may('copyInvitationLink', true)) {
          list.push({ id: 'link', label: td('actions.copyInvitationLink'), icon: <IconCopy size={14} />, onClick: () => void actions.copyInvitationLink(person) });
        }
        if (row.status === 'disabled') {
          if (may('enable', !isSelf && !isOwner)) {
            list.push({ id: 'enable', label: td('actions.enable'), icon: <IconUserCheck size={14} />, onClick: () => void actions.enable(person) });
          }
        } else if (may('disable', !isSelf && !isOwner)) {
          list.push({ id: 'disable', label: td('actions.disable'), icon: <IconUserOff size={14} />, onClick: () => void actions.disable(person) });
        }
        if (may('manageGroups', true)) {
          list.push({ id: 'groups', label: td('actions.addToGroups'), icon: <IconUsersGroup size={14} />, onClick: () => openFromList(row, 'memberships') });
        }
        if (may('mintToken', caps.tokensManageOthers || isSelf)) {
          list.push({
            id: 'token',
            label: td('actions.newToken'),
            icon: <IconKey size={14} />,
            onClick: () => {
              setTokenOwner({ id: row.id, label: row.label });
              setNew('token');
            },
          });
        }
        if (may('delete', !isSelf && !isOwner && !managed)) {
          list.push({ id: 'delete', label: td('actions.delete'), icon: <IconTrash size={14} />, color: 'red', onClick: () => void actions.remove(person) });
        }
        return list;
      }

      if (type === 'group') {
        if (!server && !canWrite) return [open];
        const local = (row.source ?? 'local') === 'local';
        const list: DataGridRowAction<PrincipalSummary>[] = [open];
        if (may('edit', true)) {
          list.push({ id: 'edit', label: td('actions.editGroup'), icon: <IconUserEdit size={14} />, onClick: () => openFromList(row, 'group') });
        }
        if (may('delete', local)) {
          list.push({
            id: 'delete',
            label: td('actions.deleteGroup'),
            icon: <IconTrash size={14} />,
            color: 'red',
            onClick: () => void actions.deleteGroup({ id: row.id, name: row.label, policyCount: row.policyCount }),
          });
        }
        return list;
      }

      // tokens
      const manageable = caps.tokensManageOthers || (Boolean(me) && row.ownerId === me?.userId);
      const list: DataGridRowAction<PrincipalSummary>[] = [open];
      if (may('edit', manageable)) {
        list.push({ id: 'edit', label: td('actions.editToken'), icon: <IconUserEdit size={14} />, onClick: () => openFromList(row, 'token') });
      }
      if (may('revoke', manageable)) {
        list.push({ id: 'revoke', label: td('actions.revokeToken'), icon: <IconTrash size={14} />, color: 'red', onClick: () => void actions.revokeToken({ id: row.id, label: row.label }) });
      }
      return list;
    },
    [actions, canWrite, caps.ready, caps.tokensManageOthers, me, openFromList, setNew, td, type],
  );

  // ── bulk bar (a page at a time) ───────────────────────────────────────
  const bulkActions = useMemo(() => {
    if (!caps.ready) return undefined;
    if (type === 'user' && canWrite) {
      return [
        {
          label: td('bulk.buttons.disable'),
          icon: <IconUserOff size={13} />,
          onClick: (rows: PrincipalSummary[]) => void bulk.runPeople({ action: 'disable', ids: rows.map((r) => r.id) }),
        },
        {
          label: td('bulk.buttons.enable'),
          icon: <IconUserCheck size={13} />,
          onClick: (rows: PrincipalSummary[]) => void bulk.runPeople({ action: 'enable', ids: rows.map((r) => r.id) }),
        },
        {
          label: td('bulk.buttons.addToGroup'),
          icon: <IconUsersGroup size={13} />,
          onClick: (rows: PrincipalSummary[]) => {
            setBulkIds(rows.map((r) => r.id));
            setBulkGroup('bulk-add');
          },
        },
        {
          label: td('bulk.buttons.removeFromGroup'),
          icon: <IconUsersGroup size={13} />,
          onClick: (rows: PrincipalSummary[]) => {
            setBulkIds(rows.map((r) => r.id));
            setBulkGroup('bulk-remove');
          },
        },
        {
          label: td('bulk.buttons.revokeTokens'),
          icon: <IconTrash size={13} />,
          color: 'red' as const,
          onClick: (rows: PrincipalSummary[]) => void bulk.runPeople({ action: 'revoke-tokens', ids: rows.map((r) => r.id) }),
        },
      ];
    }
    if (type === 'token' && (caps.tokensManageOthers || items.some((i) => i.ownerId === me?.userId))) {
      return [
        {
          label: td('bulk.buttons.revoke'),
          icon: <IconTrash size={13} />,
          color: 'red' as const,
          onClick: (rows: PrincipalSummary[]) => void bulk.revokeTokens(rows.map((r) => r.id)),
        },
      ];
    }
    return undefined;
    // `bulk` is stable enough for the buttons: it only closes over refs and setters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [caps.ready, caps.tokensManageOthers, canWrite, items, me, td, type]);

  // ── empty and error states ────────────────────────────────────────────
  const narrowed = isNarrowed(type, filters);
  const errorText = load.error ? describeError(load.error, td) : null;
  const emptyView = errorText
    ? {
        icon: <IconAlertTriangle size={28} stroke={1.5} color="var(--mantine-color-red-6)" />,
        title: t('errors.loadFailed'),
        description: load.error instanceof Error && (load.error as { status?: number }).status === 403 ? t('errors.forbidden') : errorText,
        primaryAction: {
          label: t('errors.retry'),
          icon: <IconRefresh size={14} />,
          onClick: refresh,
        },
      }
    : narrowed
      ? {
          title: t('empty.noMatches'),
          description: filters.q ? t('empty.noMatchesHint', { query: filters.q }) : td('list.noMatchesFilters'),
          primaryAction: { label: td('filters.reset'), onClick: resetFilters },
        }
      : {
          title: t(`empty.none.${type}`),
          description: t('empty.noneHint'),
          ...(type === 'user' && canWrite
            ? { primaryAction: { label: td('list.inviteFirst'), icon: <IconUserPlus size={14} />, onClick: () => setNew('person') } }
            : {}),
        };

  const range = items.length > 0 ? { from: (pager.page - 1) * pageSize + 1, to: (pager.page - 1) * pageSize + items.length } : null;
  const footerText =
    range && total !== null
      ? td('list.range', { from: range.from.toLocaleString(), to: range.to.toLocaleString(), total: total.toLocaleString() })
      : items.length > 0
        ? t('showing', { count: items.length })
        : undefined;

  const overlayOpen = busy > 0 || drawerForm || overlay.new !== null || bulkGroup !== null;

  return (
    <Stack gap="md">
      <Group align="center" gap="md" wrap="wrap">
        <SegmentedControl
          value={type}
          onChange={(v) => switchSegment(v as PrincipalType)}
          aria-label={t('segments.label')}
          data={PRINCIPAL_TYPES.map((p) => ({ value: p, label: t(`segments.${p}`) }))}
        />
        <Text size="sm" c="dimmed" maw={640} style={{ flex: '1 1 260px' }}>
          {t(`hint.${type}`)}
        </Text>
      </Group>

      <FilterBar
        type={type}
        state={filters}
        onChange={changeFilters}
        onReset={resetFilters}
        projects={projects}
        ownerLabel={ownerLabel}
        groupLabel={groupLabel}
      />

      {type === 'token' ? (
        <Text size="xs" c="dimmed" data-testid="token-note">
          {td('list.tokenNote')}
        </Text>
      ) : null}

      {load.error && items.length > 0 ? (
        <Alert color="red" icon={<IconAlertTriangle size={16} />} title={t('errors.loadFailed')}>
          <Stack gap="xs" align="flex-start">
            <Text size="sm">{errorText}</Text>
            <Button size="xs" variant="light" leftSection={<IconRefresh size={14} />} onClick={refresh}>
              {t('errors.retry')}
            </Button>
          </Stack>
        </Alert>
      ) : null}

      <DataGrid<PrincipalSummary>
        records={items}
        rowKey={(row) => `${row.type}:${row.id}`}
        columns={columns}
        loading={load.loading}
        onRowClick={(row) => openFromList(row)}
        rowActions={rowActions}
        selectable={Boolean(bulkActions)}
        selected={selected}
        onSelectionChange={setSelected}
        bulkActions={bulkActions}
        search={{
          value: searchInput,
          onChange: setSearchInput,
          placeholder: t(`search.${type}`),
        }}
        toolbarRight={
          <Group gap={8} wrap="nowrap">
            <AddMenu capabilities={caps} onPick={(kind) => {
              if (kind === 'token') setTokenOwner(null);
              setNew(kind);
            }} />
            <Tooltip label={t('refresh')} withArrow>
              <ActionIcon variant="subtle" color="gray" radius="md" loading={load.loading} onClick={refresh} aria-label={t('refresh')}>
                <IconRefresh size={14} stroke={1.7} />
              </ActionIcon>
            </Tooltip>
          </Group>
        }
        empty={emptyView}
        footerLeft={footerText}
        footerRight={
          <Group gap="sm" wrap="nowrap">
            <Select
              size="xs"
              w={110}
              allowDeselect={false}
              data={PAGE_SIZES.map((n) => ({ value: String(n), label: td('list.perPage', { count: n }) }))}
              value={String(pageSize)}
              onChange={(v) => setPageSize(normalizePageSize(v))}
              aria-label={td('list.pageSize')}
              comboboxProps={{ withinPortal: true }}
            />
            <PagerControls
              page={pager.page}
              hasNext={nextCursor !== null}
              loading={load.loading}
              onPrev={pager.prev}
              onNext={() => nextCursor && pager.next(nextCursor)}
              previousLabel={t('pager.previous')}
              nextLabel={t('pager.next')}
              pageLabel={t('pager.page', { page: pager.page })}
            />
          </Group>
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
        context={drawerContext}
        closeOnEscape={!overlayOpen}
      />

      {/* creation forms */}
      <InvitePersonShell
        open={overlay.new === 'person' || overlay.new === 'service'}
        mode={overlay.new === 'service' ? 'service' : 'person'}
        assignableRoles={caps.assignableRoles}
        onCreated={() => refresh()}
        onClose={(created?: InviteResult) => {
          setNew(null);
          if (created?.userId) openFromList({ type: 'user', id: created.userId, label: created.name || created.email, sublabel: created.email || null, role: created.role, status: null, memberCount: null, policyCount: 0 });
        }}
        onCreateToken={(created) => {
          setTokenOwner({ id: created.userId, label: created.name || created.email });
          setNew('token');
        }}
      />
      <ImportPeopleShell
        open={overlay.new === 'import'}
        assignableRoles={caps.assignableRoles}
        onClose={() => setNew(null)}
        onImported={() => refresh()}
      />
      <GroupShell
        open={overlay.new === 'group'}
        group={null}
        onClose={() => setNew(null)}
        onSaved={(id) => {
          refresh();
          if (id) openFromList({ type: 'group', id, label: id, sublabel: null, role: null, status: null, memberCount: null, policyCount: 0 });
        }}
      />
      <NewTokenShell
        open={overlay.new === 'token'}
        onClose={() => {
          setNew(null);
          setTokenOwner(null);
        }}
        onCreated={refresh}
        owner={tokenOwner}
        me={me ? { userId: me.userId } : null}
        canMintForOthers={caps.tokensManageOthers}
      />
      {bulkGroup ? (
        <MembershipShell
          mode={bulkGroup}
          open
          count={bulkIds.length}
          onClose={() => setBulkGroup(null)}
          onPick={(group) => {
            const mode = bulkGroup;
            setBulkGroup(null);
            void bulk.runPeople({ action: mode === 'bulk-add' ? 'add-to-group' : 'remove-from-group', ids: bulkIds, group });
          }}
        />
      ) : null}
      {bulk.dialog}
    </Stack>
  );
}
