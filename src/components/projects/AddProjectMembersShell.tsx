'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Badge, Checkbox, Loader, Select, SegmentedControl, Text, TextInput } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconInfoCircle, IconSearch, IconUserPlus } from '@tabler/icons-react';
import FormShell, { FormSection, SummaryGroup, SummaryKV } from '@/components/common/ui/FormShell';
import { fetchPrincipals, isAbortError, type PrincipalSummary } from '@/components/iam/principals/client';
import { directoryApi } from '@/components/iam/principals/directoryApi';
import { useTranslations } from '@/lib/i18n';
import {
  buildAddRequests,
  countByType,
  lockReason,
  pickKey,
  setAllRoles,
  setPickRole,
  togglePick,
  type ExistingAccess,
  type PickedEntry,
} from './detail/addPeopleModel';
import { parseBulkResult, type ProjectRoleValue } from './detail/membersModel';

interface AddProjectMembersShellProps {
  open: boolean;
  projectId: string;
  projectName?: string;
  existing: ExistingAccess;
  /** Groups are granted by owners and admins only. */
  canAddGroups: boolean;
  onClose: () => void;
  onDone: () => void;
}

const SEARCH_LIMIT = 25;

function errorText(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

/** Add people and groups to a project in one go, with a role per row. */
export default function AddProjectMembersShell({
  open,
  projectId,
  projectName,
  existing,
  canAddGroups,
  onClose,
  onDone,
}: AddProjectMembersShellProps) {
  const t = useTranslations('projectTabs.addPeople');
  const tCommon = useTranslations('common');
  const [type, setType] = useState<'user' | 'group'>('user');
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<PrincipalSummary[]>([]);
  const [searching, setSearching] = useState(false);
  const [picked, setPicked] = useState<PickedEntry[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);

  useEffect(() => {
    if (!open) return;
    setType('user');
    setQuery('');
    setPicked([]);
    setError(null);
    setSaving(false);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    const mine = ++seq.current;
    setSearching(true);
    const handle = setTimeout(() => {
      fetchPrincipals({ type, q: query.trim(), limit: SEARCH_LIMIT }, controller.signal)
        .then((page) => {
          if (mine === seq.current && !controller.signal.aborted) setResults(page.items);
        })
        .catch((err: unknown) => {
          if (!isAbortError(err) && mine === seq.current) setResults([]);
        })
        .finally(() => {
          if (mine === seq.current) setSearching(false);
        });
    }, 250);
    return () => {
      clearTimeout(handle);
      controller.abort();
    };
  }, [open, type, query]);

  const counts = useMemo(() => countByType(picked), [picked]);
  const roleOptions = [
    { value: 'member', label: t('roles.member') },
    { value: 'project_admin', label: t('roles.project_admin') },
  ];

  const reasonText = (reason: NonNullable<ReturnType<typeof lockReason>>) => t(`locked.${reason}`);

  const save = async () => {
    if (picked.length === 0 || saving) return;
    setSaving(true);
    setError(null);
    const requests = buildAddRequests(picked);
    const failures: string[] = [];
    let warnings: string[] = [];
    let added = 0;
    const done = new Set<string>();
    try {
      if (requests.users.length > 0) {
        const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}/members/bulk`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ add: requests.users }),
        });
        const body: unknown = await res.json().catch(() => null);
        if (!res.ok) {
          const message = body && typeof body === 'object' ? (body as { error?: unknown }).error : null;
          throw new Error(typeof message === 'string' && message ? message : t('errors.save'));
        }
        const result = parseBulkResult(body);
        added += result.added;
        warnings = result.warnings;
        for (const u of requests.users) done.add(pickKey('user', u.userId));
      }
      for (const group of requests.groups) {
        try {
          await directoryApi.assignGroupProject(group.groupId, { projectId, role: group.role });
          added += 1;
          done.add(pickKey('group', group.groupId));
        } catch (err) {
          const label = picked.find((p) => p.key === pickKey('group', group.groupId))?.label ?? group.groupId;
          failures.push(`${label}: ${errorText(err, t('errors.save'))}`);
        }
      }
      if (added > 0) {
        notifications.show({
          title: tCommon('success'),
          message: t('done', { count: added }),
          color: 'green',
        });
        onDone();
      }
      if (failures.length === 0 && warnings.length === 0) {
        onClose();
        return;
      }
      // Something was skipped: stay open so the reasons can be read, keep only what is still to do.
      setError([...warnings, ...failures].join('\n'));
      setPicked((prev) => prev.filter((p) => !done.has(p.key)));
    } catch (err) {
      setError(errorText(err, t('errors.save')));
    } finally {
      setSaving(false);
    }
  };

  const summary = (
    <SummaryGroup title={t('summary.title')}>
      <SummaryKV label={t('summary.project')} value={projectName ?? <span className="ds-faint">—</span>} />
      <SummaryKV label={t('summary.people')} value={counts.users} />
      {canAddGroups ? <SummaryKV label={t('summary.groups')} value={counts.groups} /> : null}
    </SummaryGroup>
  );

  return (
    <FormShell
      open={open}
      onClose={onClose}
      icon={<IconUserPlus size={16} />}
      title={t('title')}
      subtitle={projectName ? t('subtitle', { project: projectName }) : undefined}
      summary={summary}
      disableEscape={saving}
      primaryAction={{
        label: t('submit', { count: picked.length }),
        loading: saving,
        disabled: picked.length === 0,
        onClick: () => void save(),
      }}
      secondaryAction={{ label: t('cancel'), onClick: onClose, disabled: saving }}
    >
      <Alert color="blue" variant="light" icon={<IconInfoCircle size={16} />}>
        {t('note')}
      </Alert>

      <FormSection number={1} title={t('find.title')} description={t('find.hint')} done={picked.length > 0}>
        <div className="ds-row" style={{ gap: 8, marginBottom: 10 }}>
          {canAddGroups ? (
            <SegmentedControl
              size="xs"
              aria-label={t('find.type')}
              value={type}
              onChange={(v) => setType(v as 'user' | 'group')}
              data={[
                { value: 'user', label: t('find.people') },
                { value: 'group', label: t('find.groupsLabel') },
              ]}
            />
          ) : null}
          <TextInput
            size="xs"
            style={{ flex: 1 }}
            aria-label={t('find.search')}
            placeholder={type === 'user' ? t('find.searchPeople') : t('find.searchGroups')}
            leftSection={<IconSearch size={13} />}
            rightSection={searching ? <Loader size={12} /> : undefined}
            value={query}
            onChange={(e) => setQuery(e.currentTarget.value)}
          />
        </div>
        <div className="ds-card" style={{ padding: 4, maxHeight: 320, overflowY: 'auto' }}>
          {results.length === 0 ? (
            <Text size="sm" c="dimmed" p="sm">
              {searching ? tCommon('loading') : t('find.nothing')}
            </Text>
          ) : (
            results.map((principal) => {
              const key = pickKey(type, principal.id);
              const reason = lockReason(type, principal, existing);
              const checked = picked.some((p) => p.key === key);
              return (
                <div
                  key={key}
                  className="ds-row-between"
                  style={{ padding: '6px 8px', gap: 12, opacity: reason ? 0.6 : 1 }}
                >
                  <Checkbox
                    size="xs"
                    checked={checked}
                    disabled={reason !== null}
                    onChange={() =>
                      setPicked((prev) =>
                        togglePick(prev, {
                          type,
                          id: principal.id,
                          label: principal.label,
                          sublabel: principal.email ?? principal.sublabel,
                        }),
                      )
                    }
                    aria-label={principal.label}
                    label={
                      <span className="ds-col" style={{ gap: 1 }}>
                        <span style={{ fontSize: 13, fontWeight: 500 }}>{principal.label}</span>
                        <span className="ds-faint" style={{ fontSize: 11 }}>
                          {type === 'group'
                            ? t('find.members', { count: principal.memberCount ?? 0 })
                            : (principal.email ?? principal.sublabel ?? '')}
                        </span>
                      </span>
                    }
                  />
                  {reason ? (
                    <Badge size="xs" variant="light" color="gray">
                      {reasonText(reason)}
                    </Badge>
                  ) : null}
                </div>
              );
            })
          )}
        </div>
      </FormSection>

      <FormSection number={2} title={t('roles.title')} description={t('roles.hint')} done={picked.length > 0}>
        {picked.length === 0 ? (
          <Text size="sm" c="dimmed">
            {t('roles.empty')}
          </Text>
        ) : (
          <>
            <div className="ds-row" style={{ gap: 8, marginBottom: 8 }}>
              <Text size="xs" c="dimmed">
                {t('roles.setAll')}
              </Text>
              <Select
                size="xs"
                w={170}
                aria-label={t('roles.setAll')}
                data={roleOptions}
                value={null}
                placeholder={t('roles.choose')}
                onChange={(v) => v && setPicked((prev) => setAllRoles(prev, v as ProjectRoleValue))}
              />
            </div>
            {picked.map((entry) => (
              <div key={entry.key} className="ds-row-between" style={{ padding: '6px 0', gap: 12 }}>
                <span className="ds-col" style={{ gap: 1, minWidth: 0 }}>
                  <span style={{ fontSize: 13, fontWeight: 500 }}>
                    {entry.label}{' '}
                    {entry.type === 'group' ? (
                      <Badge size="xs" variant="light" color="grape">
                        {t('roles.groupBadge')}
                      </Badge>
                    ) : null}
                  </span>
                  {entry.sublabel ? (
                    <span className="ds-faint" style={{ fontSize: 11 }}>
                      {entry.sublabel}
                    </span>
                  ) : null}
                </span>
                <Select
                  size="xs"
                  w={170}
                  aria-label={t('roles.roleOf', { name: entry.label })}
                  allowDeselect={false}
                  data={roleOptions}
                  value={entry.role}
                  onChange={(v) => v && setPicked((prev) => setPickRole(prev, entry.key, v as ProjectRoleValue))}
                />
              </div>
            ))}
          </>
        )}
      </FormSection>

      {error ? (
        <Alert color="red" variant="light" title={t('errors.title')}>
          <span style={{ whiteSpace: 'pre-line' }}>{error}</span>
        </Alert>
      ) : null}
    </FormShell>
  );
}
