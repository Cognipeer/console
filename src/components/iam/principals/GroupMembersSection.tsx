'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, Badge, Button, Checkbox, Group, Loader, Stack, Text } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconInfoCircle, IconLock, IconPlus, IconTrash } from '@tabler/icons-react';
import PrincipalMultiSelect from '@/components/iam/pickers/PrincipalMultiSelect';
import type { PrincipalRef } from '@/components/iam/policies/specModel';
import { useTranslations } from '@/lib/i18n';
import { isAbortError } from './client';
import { directoryApi, type GroupMemberRow, type GroupMembersPage } from './directoryApi';
import { ErrorText, notifyError } from './errors';
import { providerLabel } from './managed';
import { translateOr, type Translate } from './format';
import { PagerControls, useCursorPager } from './pager';
import styles from './PrincipalDetail.module.css';
import type { PeopleActions } from './usePeopleActions';
import { badgeVariant, PrincipalAvatar, statusColor } from './visuals';

const PAGE = 50;
const NS = 'iamPrincipals';

interface GroupMembersSectionProps {
  group: { id: string; name: string; source: string };
  /** The viewer may add and remove members of this (local) group. */
  canManage: boolean;
  actions: PeopleActions;
  t: Translate;
  /** Open a member's drawer. */
  onOpenMember: (userId: string, label: string) => void;
  /** A change happened (counts elsewhere are stale). */
  onChanged: () => void;
  /** Bumped by the parent to reload (after the group changed elsewhere). */
  reloadKey?: number;
}

/**
 * The members of a group, 50 per page: who they are, how they got in, and (for
 * a local group, to someone who may) add and remove them. A membership whose
 * user no longer exists is listed too, so it can be removed.
 */
export default function GroupMembersSection({
  group,
  canManage,
  actions,
  t,
  onOpenMember,
  onChanged,
  reloadKey = 0,
}: GroupMembersSectionProps) {
  const td = useTranslations('iamDirectory');
  const tCommon = useTranslations('common');
  const tNotifications = useTranslations('notifications');
  const pager = useCursorPager(`${group.id}\u0000${reloadKey}`);
  const [reload, setReload] = useState(0);
  const [state, setState] = useState<{ page: GroupMembersPage | null; loading: boolean; error: unknown }>({
    page: null,
    loading: true,
    error: null,
  });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [picked, setPicked] = useState<PrincipalRef[]>([]);
  const [busy, setBusy] = useState(false);

  const directory = group.source !== 'local';
  const editable = canManage && !directory;

  useEffect(() => {
    const controller = new AbortController();
    setState((s) => ({ ...s, loading: true, error: null }));
    directoryApi
      .groupMembers(group.id, { limit: PAGE, cursor: pager.cursor, signal: controller.signal })
      .then((page) => {
        if (!controller.signal.aborted) setState({ page, loading: false, error: null });
      })
      .catch((error: unknown) => {
        if (isAbortError(error)) return;
        setState((s) => ({ ...s, loading: false, error }));
      });
    return () => controller.abort();
  }, [group.id, pager.cursor, reload, reloadKey]);

  // A new page (or a reload) starts with nothing selected.
  useEffect(() => setSelected(new Set()), [pager.cursor, reload, reloadKey, group.id]);

  const items = state.page?.items ?? [];
  const total = state.page?.total ?? null;
  const done = useCallback(() => {
    setReload((n) => n + 1);
    onChanged();
  }, [onChanged]);

  const addMembers = async () => {
    if (picked.length === 0 || busy) return;
    setBusy(true);
    try {
      const result = await directoryApi.bulk({ action: 'add-to-group', ids: picked.map((p) => p.id), groupId: group.id });
      notifications.show({
        title: tCommon('success'),
        message: td('drawer.members.added', { ok: result.ok, skipped: result.skipped + result.failed }),
        color: result.failed > 0 ? 'orange' : 'green',
      });
      setPicked([]);
      done();
    } catch (error) {
      notifyError(error, td, tNotifications('errorTitle'));
    } finally {
      setBusy(false);
    }
  };

  const removeSelected = async () => {
    if (selected.size === 0 || busy) return;
    const rows = items.filter((m) => selected.has(m.userId));
    const real = rows.filter((m) => !m.missing).map((m) => m.userId);
    const orphans = rows.filter((m) => m.missing).map((m) => m.userId);
    setBusy(true);
    let removed = 0;
    let failed = 0;
    try {
      if (real.length > 0) {
        const result = await directoryApi.bulk({ action: 'remove-from-group', ids: real, groupId: group.id });
        removed += result.ok;
        failed += result.failed + result.skipped;
      }
      for (const userId of orphans) {
        try {
          await directoryApi.removeGroupMember(group.id, userId);
          removed += 1;
        } catch {
          failed += 1;
        }
      }
      notifications.show({
        title: tCommon('success'),
        message: td('drawer.members.removed', { ok: removed, failed }),
        color: failed > 0 ? 'orange' : 'green',
      });
      done();
    } catch (error) {
      notifyError(error, td, tNotifications('errorTitle'));
    } finally {
      setBusy(false);
    }
  };

  const toggle = (id: string) =>
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const allSelected = items.length > 0 && items.every((m) => selected.has(m.userId));
  const range = useMemo(() => {
    if (items.length === 0 || total === null) return null;
    const from = (pager.page - 1) * PAGE + 1;
    return { from, to: from + items.length - 1, total };
  }, [items.length, pager.page, total]);

  return (
    <Stack gap="sm">
      {directory ? (
        <Alert color="blue" variant="light" icon={<IconLock size={16} />} data-testid="directory-group-note">
          {td('drawer.members.directory', { source: providerLabel(td, group.source) })}
        </Alert>
      ) : null}

      {editable ? (
        <Group align="flex-end" gap="xs" wrap="nowrap">
          <div style={{ flex: 1, minWidth: 0 }}>
            <PrincipalMultiSelect
              type="user"
              label={td('drawer.members.addLabel')}
              value={picked}
              onChange={setPicked}
              disabled={busy}
            />
          </div>
          <Button
            leftSection={<IconPlus size={14} />}
            disabled={picked.length === 0}
            loading={busy}
            onClick={() => void addMembers()}
          >
            {td('drawer.members.add')}
          </Button>
        </Group>
      ) : null}

      {state.error ? (
        <Alert color="red" variant="light" icon={<IconInfoCircle size={16} />}>
          <Stack gap={6} align="flex-start">
            <ErrorText error={state.error} t={td} />
            <Button size="compact-xs" variant="light" onClick={() => setReload((n) => n + 1)}>
              {td('common.retry')}
            </Button>
          </Stack>
        </Alert>
      ) : null}

      {editable && selected.size > 0 ? (
        <Group gap="xs">
          <Text size="sm">{td('drawer.members.selected', { count: selected.size })}</Text>
          <Button size="compact-xs" color="red" variant="light" leftSection={<IconTrash size={12} />} loading={busy} onClick={() => void removeSelected()}>
            {td('drawer.members.removeSelected')}
          </Button>
        </Group>
      ) : null}

      {state.loading && !state.page ? (
        <Group justify="center" py="md">
          <Loader size="sm" />
        </Group>
      ) : items.length === 0 && !state.error ? (
        <Text size="sm" c="dimmed">
          {td('drawer.members.empty')}
        </Text>
      ) : (
        <div className={styles.bordered} style={{ opacity: state.loading ? 0.6 : 1 }} aria-busy={state.loading}>
          {editable ? (
            <div className={styles.listRow} style={{ background: 'var(--ds-surface-1)' }}>
              <Checkbox
                size="xs"
                checked={allSelected}
                indeterminate={!allSelected && selected.size > 0}
                onChange={() => setSelected(allSelected ? new Set() : new Set(items.map((m) => m.userId)))}
                label={td('drawer.members.selectPage')}
              />
            </div>
          ) : null}
          {items.map((m) => (
            <MemberRow
              key={m.userId}
              member={m}
              t={t}
              td={td}
              selectable={editable}
              selected={selected.has(m.userId)}
              onToggle={() => toggle(m.userId)}
              onOpen={() => onOpenMember(m.userId, m.label)}
              onRemove={
                editable
                  ? async () => {
                      const ok = await actions.removeMembershipOf(m.userId, m.label, group);
                      if (ok) setReload((n) => n + 1);
                    }
                  : undefined
              }
            />
          ))}
        </div>
      )}

      {items.length > 0 || pager.page > 1 ? (
        <Group justify="space-between" wrap="wrap">
          <Text size="xs" c="dimmed">
            {range
              ? td('drawer.members.range', { from: range.from.toLocaleString(), to: range.to.toLocaleString(), total: range.total.toLocaleString() })
              : td('drawer.members.onPage', { count: items.length })}
          </Text>
          <PagerControls
            page={pager.page}
            hasNext={state.page?.nextCursor != null}
            loading={state.loading}
            onPrev={pager.prev}
            onNext={() => state.page?.nextCursor && pager.next(state.page.nextCursor)}
            previousLabel={t('pager.previous')}
            nextLabel={t('pager.next')}
            pageLabel={t('pager.page', { page: pager.page })}
          />
        </Group>
      ) : null}
    </Stack>
  );
}

function MemberRow({
  member,
  t,
  td,
  selectable,
  selected,
  onToggle,
  onOpen,
  onRemove,
}: {
  member: GroupMemberRow;
  t: Translate;
  td: Translate;
  selectable: boolean;
  selected: boolean;
  onToggle: () => void;
  onOpen: () => void;
  onRemove?: () => void;
}) {
  return (
    <div className={styles.listRow} data-testid="group-member" data-missing={member.missing || undefined}>
      <Group gap="sm" wrap="nowrap" style={{ minWidth: 0, flex: 1 }}>
        {selectable ? <Checkbox size="xs" checked={selected} onChange={onToggle} aria-label={td('drawer.members.select', { name: member.label })} /> : null}
        <PrincipalAvatar type="user" label={member.label} size={28} />
        <div style={{ minWidth: 0 }}>
          {member.missing ? (
            <>
              <Text size="sm" fw={500} c="dimmed">
                {td('drawer.members.deletedUser')}
              </Text>
              <Text size="xs" c="dimmed" ff="monospace" style={{ wordBreak: 'break-all' }}>
                {member.userId}
              </Text>
            </>
          ) : (
            <>
              <Button variant="subtle" size="compact-sm" px={0} onClick={onOpen} style={{ height: 'auto', fontWeight: 500 }}>
                {member.label}
              </Button>
              {member.email ? (
                <Text size="xs" c="dimmed" truncate>
                  {member.email}
                </Text>
              ) : null}
            </>
          )}
        </div>
      </Group>
      <Group gap={6} wrap="nowrap">
        {member.role ? (
          <Badge size="sm" variant="default" tt="none">
            {translateOr(t, NS, `roles.${member.role}`, member.role)}
          </Badge>
        ) : null}
        {member.status ? (
          <Badge size="sm" variant={badgeVariant(statusColor(member.status))} color={statusColor(member.status)}>
            {translateOr(t, NS, `statuses.${member.status}`, member.status)}
          </Badge>
        ) : null}
        {member.membershipSource !== 'local' ? (
          <Badge size="sm" variant="default" tt="none" leftSection={<IconLock size={10} aria-hidden />}>
            {providerLabel(td, member.membershipSource)}
          </Badge>
        ) : null}
        {onRemove ? (
          <Button
            size="compact-xs"
            color="red"
            variant="subtle"
            onClick={onRemove}
            aria-label={td('drawer.members.removeNamed', { name: member.label })}
          >
            {td('drawer.members.remove')}
          </Button>
        ) : null}
      </Group>
    </div>
  );
}
