'use client';

/**
 * "Who can use it": the access list of a shared resource (an MCP server, a skill), edited on the resource's own form.
 *
 * Everyone who can run the agent (the default), or the people and groups listed. The list is the resource's built-in
 * IAM policy (managed:access:*): the agent runtime asks it for the person each run is made for. The pickers search on
 * the server (a workspace can have tens of thousands of people) and the ids already saved are turned into names by
 * looking up just those ids, the way the portal and channel access forms do.
 */

import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Group, SegmentedControl, Stack, Text } from '@mantine/core';
import { IconAlertTriangle, IconUserPlus } from '@tabler/icons-react';
import PrincipalMultiSelect from '@/components/iam/pickers/PrincipalMultiSelect';
import { resolvePrincipalLabels } from '@/components/iam/pickers/principalLabels';
import type { PrincipalRef } from '@/components/iam/policies/specModel';
import { useViewer } from '@/components/agents/session/useViewer';
import { useTranslations } from '@/lib/i18n';

export interface AccessListValue {
  mode: 'all' | 'selected';
  userIds: string[];
  groupIds: string[];
}

export function openAccessValue(): AccessListValue {
  return { mode: 'all', userIds: [], groupIds: [] };
}

const idList = (value: unknown): string[] =>
  Array.isArray(value) ? [...new Set(value.filter((v): v is string => typeof v === 'string' && v !== ''))] : [];

/** A list as the API sent it (absent on an older server: everyone). */
export function accessValueOf(raw: unknown): AccessListValue {
  if (!raw || typeof raw !== 'object') return openAccessValue();
  const value = raw as Record<string, unknown>;
  return { mode: value.mode === 'selected' ? 'selected' : 'all', userIds: idList(value.userIds), groupIds: idList(value.groupIds) };
}

export function isRestrictedAccess(raw: unknown): boolean {
  return accessValueOf(raw).mode === 'selected';
}

/** Names are a nicety: at most this many saved ids are looked up, in chunks the label lookup accepts. */
const MAX_NAMED = 100;
const LOOKUP_CHUNK = 25;

async function namedRefs(type: 'user' | 'group', ids: readonly string[]): Promise<PrincipalRef[]> {
  const labels = new Map<string, string>();
  for (let from = 0; from < Math.min(ids.length, MAX_NAMED); from += LOOKUP_CHUNK) {
    try {
      const part = await resolvePrincipalLabels(type, ids.slice(from, from + LOOKUP_CHUNK));
      part.forEach((label, id) => labels.set(id, label));
    } catch {
      /* the ids still render, and stay removable */
    }
  }
  return ids.map((id) => ({ id, label: labels.get(id) ?? id }));
}

/** Keep the refs a picker holds in step with the ids of the value, keeping every name already known. */
function refsFor(ids: readonly string[], known: readonly PrincipalRef[]): PrincipalRef[] {
  const labels = new Map(known.map((r) => [r.id, r.label]));
  return ids.map((id) => ({ id, label: labels.get(id) ?? id }));
}

const sameIds = (refs: readonly PrincipalRef[], ids: readonly string[]) =>
  refs.length === ids.length && refs.every((r, i) => r.id === ids[i]);

interface AccessListFieldsProps {
  value: AccessListValue;
  onChange: (next: AccessListValue) => void;
  /** What the list is about, as the texts name it. */
  resource: 'mcp' | 'skill';
  disabled?: boolean;
}

export function AccessListFields({ value, onChange, resource, disabled }: AccessListFieldsProps) {
  const t = useTranslations('resourceAccess');
  const viewer = useViewer();
  const resourceName = t(resource === 'mcp' ? 'resourceMcp' : 'resourceSkill');
  const selected = value.mode === 'selected';

  const [userRefs, setUserRefs] = useState<PrincipalRef[]>(() => refsFor(value.userIds, []));
  const [groupRefs, setGroupRefs] = useState<PrincipalRef[]>(() => refsFor(value.groupIds, []));
  // `type:id` of every id that already has its name (picked here) or has been looked up once.
  const named = useRef(new Set<string>());

  // The pickers follow the value (it can be replaced from outside: another record opened, a reset), and ids that came
  // without a name are looked up once.
  useEffect(() => {
    setUserRefs((current) => (sameIds(current, value.userIds) ? current : refsFor(value.userIds, current)));
    setGroupRefs((current) => (sameIds(current, value.groupIds) ? current : refsFor(value.groupIds, current)));
    const users = value.userIds.filter((id) => !named.current.has(`user:${id}`));
    const groups = value.groupIds.filter((id) => !named.current.has(`group:${id}`));
    if (users.length === 0 && groups.length === 0) return;
    users.forEach((id) => named.current.add(`user:${id}`));
    groups.forEach((id) => named.current.add(`group:${id}`));
    void Promise.all([namedRefs('user', users), namedRefs('group', groups)]).then(([namedUsers, namedGroups]) => {
      const found = (refs: PrincipalRef[]) => refs.filter((r) => r.label !== r.id);
      setUserRefs((current) => refsFor(current.map((r) => r.id), [...found(current), ...found(namedUsers)]));
      setGroupRefs((current) => refsFor(current.map((r) => r.id), [...found(current), ...found(namedGroups)]));
    });
  }, [value.userIds, value.groupIds]);

  const setUsers = (next: PrincipalRef[]) => {
    next.forEach((r) => named.current.add(`user:${r.id}`));
    setUserRefs(next);
    onChange({ ...value, userIds: next.map((r) => r.id) });
  };
  const setGroups = (next: PrincipalRef[]) => {
    next.forEach((r) => named.current.add(`group:${r.id}`));
    setGroupRefs(next);
    onChange({ ...value, groupIds: next.map((r) => r.id) });
  };
  const addMe = () => {
    if (!viewer.userId || value.userIds.includes(viewer.userId)) return;
    setUsers([...userRefs, { id: viewer.userId, label: t('you') }]);
  };

  const empty = value.userIds.length + value.groupIds.length === 0;

  return (
    <Stack gap="sm" data-testid="access-list-fields">
      <Text size="xs" c="dimmed">{t('description', { resource: resourceName })}</Text>
      <SegmentedControl
        aria-label={t('mode')}
        value={value.mode}
        disabled={disabled}
        onChange={(mode) => onChange({ ...value, mode: mode === 'selected' ? 'selected' : 'all' })}
        data={[
          { value: 'all', label: t('everyone') },
          { value: 'selected', label: t('selected') },
        ]}
      />
      <Text size="xs" c="dimmed">
        {selected ? t('selectedHint', { resource: resourceName }) : t('everyoneHint', { resource: resourceName })}
      </Text>
      {selected ? (
        <>
          <PrincipalMultiSelect
            type="user"
            label={t('people')}
            placeholder={t('peoplePlaceholder')}
            value={userRefs}
            onChange={setUsers}
            disabled={disabled}
          />
          <PrincipalMultiSelect
            type="group"
            label={t('groups')}
            placeholder={t('groupsPlaceholder')}
            value={groupRefs}
            onChange={setGroups}
            disabled={disabled}
          />
          <Group gap="xs" wrap="nowrap" align="center">
            {viewer.userId && !value.userIds.includes(viewer.userId) ? (
              <Button size="compact-xs" variant="default" leftSection={<IconUserPlus size={12} />} onClick={addMe} disabled={disabled}>
                {t('addMe')}
              </Button>
            ) : null}
            <Text size="xs" c="dimmed">{t('pickerHint')}</Text>
          </Group>
          {empty ? (
            <Alert color="yellow" variant="light" icon={<IconAlertTriangle size={14} />} p="xs">
              <Text size="xs">{t('emptyWarning', { resource: resourceName })}</Text>
            </Alert>
          ) : null}
        </>
      ) : null}
      <Text size="xs" c="dimmed">{t('iamNote', { resource: resourceName })}</Text>
    </Stack>
  );
}

/** One line for a form's summary panel. */
export function useAccessSummary(value: AccessListValue): string {
  const t = useTranslations('resourceAccess');
  return value.mode === 'all'
    ? t('summaryEveryone')
    : t('summarySelected', { people: String(value.userIds.length), groups: String(value.groupIds.length) });
}
