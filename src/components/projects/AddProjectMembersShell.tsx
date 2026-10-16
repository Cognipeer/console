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
/** The project's own candidate search answers from two letters on. */
const MIN_CANDIDATE_QUERY = 2;

function errorText(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

/**
 * The people a project admin may add. Admins of a single project cannot read the workspace's IAM directory, so
 * they search the project's own candidate list instead (owners, admins and people already in the project left
 * out). Owners and admins search the directory, which also shows who is locked and why.
 */
async function fetchCandidates(projectId: string, query: string, signal: AbortSignal): Promise<PrincipalSummary[]> {
  if (query.length < MIN_CANDIDATE_QUERY) return [];
  const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}/member-candidates?q=${encodeURIComponent(query)}`, {
    cache: 'no-store',
    signal,
  });
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const message = body && typeof body === 'object' ? (body as { error?: unknown }).error : null;
    throw new Error(typeof message === 'string' ? message : '');
  }
  const users = body && typeof body === 'object' ? (body as { users?: unknown }).users : null;
  if (!Array.isArray(users)) return [];
  return users.flatMap((raw): PrincipalSummary[] => {
    const user = raw as { _id?: unknown; email?: unknown; name?: unknown };
    if (typeof user._id !== 'string') return [];
    const email = typeof user.email === 'string' ? user.email : '';
    const name = typeof user.name === 'string' ? user.name : '';
    return [{
      type: 'user',
      id: user._id,
      label: name || email || user._id,
      sublabel: email || null,
      email,
      role: null,
      status: null,
      memberCount: null,
      policyCount: 0,
    }];
  });
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
  const [searchError, setSearchError] = useState<string | null>(null);
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
    setSearchError(null);
    setSaving(false);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    if (type === 'user' && !canAddGroups && query.trim().length < MIN_CANDIDATE_QUERY) {
      // Too short for the project's candidate search: nothing to ask, so no wait and no "Loading".
      seq.current += 1;
      setResults([]);
      setSearchError(null);
      setSearching(false);
      return;
    }
    const controller = new AbortController();
    const mine = ++seq.current;
    setSearching(true);
    const handle = setTimeout(() => {
      // `canAddGroups` is true for owners and admins, the people who can read the IAM directory.
      const load =
        type === 'user' && !canAddGroups
          ? fetchCandidates(projectId, query.trim(), controller.signal)
          : fetchPrincipals({ type, q: query.trim(), limit: SEARCH_LIMIT }, controller.signal).then((page) => page.items);
      load
        .then((items) => {
          if (mine === seq.current && !controller.signal.aborted) {
            setResults(items);
            setSearchError(null);
          }
        })
        .catch((err: unknown) => {
          if (isAbortError(err) || mine !== seq.current) return;
          setResults([]);
          setSearchError(errorText(err, t('errors.search')));
        })
        .finally(() => {
          if (mine === seq.current) setSearching(false);
        });
    }, 250);
    return () => {
      clearTimeout(handle);
      controller.abort();
    };
  }, [open, type, query, canAddGroups, projectId, t]);

  const counts = useMemo(() => countByType(picked), [picked]);
  const needsMoreLetters = type === 'user' && !canAddGroups && query.trim().length < MIN_CANDIDATE_QUERY;
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
            <Text size="sm" c={searchError && !searching ? 'red' : 'dimmed'} p="sm" data-testid="find-empty">
              {searching ? tCommon('loading') : (searchError ?? (needsMoreLetters ? t('find.minChars') : t('find.nothing')))}
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
                  style={{ padding: '6px 8px', gap: 12 }}
                  data-testid={reason ? 'locked-person' : undefined}
                >
                  <Checkbox
                    size="xs"
                    checked={checked}
                    disabled={reason !== null}
                    // A disabled label is almost the colour of the page in this theme: keep the name readable.
                    styles={reason ? { label: { color: 'var(--ds-text-muted)', opacity: 1 } } : undefined}
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
                    <Badge size="xs" variant="default" tt="none">
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
