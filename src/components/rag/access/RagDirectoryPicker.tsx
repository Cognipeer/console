'use client';

/**
 * The "From a connector" tab of the permission editor: pick a connector's identity directory, then one of its users,
 * one of its groups, or all its members (guests are not members). Directories are read by Knowledge Engine admins of
 * the whole workspace only; for anyone else the tab says so instead of an empty list.
 */

import { useState } from 'react';
import { Loader, SegmentedControl, Select, Stack, Text, TextInput } from '@mantine/core';
import { IconSearch } from '@tabler/icons-react';
import { externalAllPrincipal, formatPrincipal } from '@/lib/services/rag/access/principals';
import { PICKER_LIMIT, PickerResults, PickerRow } from './RagPrincipalPicker';
import { entryInput, peopleText } from './principalDisplay';
import { ACCESS_TEXT } from './ragAccessText';
import {
  ragAccessApi,
  type RagAclEntryInput,
  type RagIdentityDomainView,
  type RagIdentityGroupView,
  type RagIdentityUserView,
} from './ragAccessApi';
import { errorStatus, useAccessLoad, useServerSearch } from './useRagAccessData';

type Mode = 'users' | 'groups' | 'all';

export interface RagDirectoryPickerProps {
  taken: ReadonlySet<string>;
  full: boolean;
  disabled?: boolean;
  onAdd: (entry: RagAclEntryInput) => void;
}

/** A failed directory call: the workspace-admin refusal has its own sentence. */
function directoryProblem(error: Error | null): Error | null {
  if (!error) return null;
  return errorStatus(error) === 403 ? new Error(ACCESS_TEXT.directoryNeedsWorkspace) : error;
}

export function RagDirectoryPicker({ taken, full, disabled = false, onAdd }: RagDirectoryPickerProps) {
  const domains = useAccessLoad((signal) => ragAccessApi.identityDomains(signal), 'identity-domains');
  const [chosen, setChosen] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>('users');

  const list = domains.data ?? [];
  // One directory needs no choosing.
  const directory: RagIdentityDomainView | undefined = list.find((item) => item.key === chosen) ?? (list.length === 1 ? list[0] : undefined);

  if (domains.loading && !domains.data) return <Loader size="sm" aria-label="Loading directories" />;
  const problem = directoryProblem(domains.error);
  if (problem) return <Text size="sm" c="dimmed" role="alert">{problem.message}</Text>;
  if (list.length === 0) return <Text size="sm" c="dimmed">{ACCESS_TEXT.noDirectories}</Text>;

  return (
    <Stack gap="sm">
      <Select
        size="xs"
        label="Connector"
        placeholder="Choose a directory"
        data={list.map((item) => ({ value: item.key, label: item.label }))}
        value={directory?.key ?? null}
        onChange={setChosen}
        allowDeselect={false}
        disabled={disabled}
      />
      {directory ? (
        <>
          <SegmentedControl
            size="xs"
            aria-label="What to add from the directory"
            value={mode}
            onChange={(next) => setMode(next as Mode)}
            data={[
              { value: 'users', label: 'Users' },
              { value: 'groups', label: 'Groups' },
              { value: 'all', label: 'All members' },
            ]}
            disabled={disabled}
          />
          {mode === 'users' ? <DirectoryUsers key={directory.key} directory={directory} taken={taken} full={full} disabled={disabled} onAdd={onAdd} /> : null}
          {mode === 'groups' ? <DirectoryGroups key={directory.key} directory={directory} taken={taken} full={full} disabled={disabled} onAdd={onAdd} /> : null}
          {mode === 'all' ? <AllMembers directory={directory} taken={taken} full={full} disabled={disabled} onAdd={onAdd} /> : null}
        </>
      ) : null}
    </Stack>
  );
}

interface PartProps extends RagDirectoryPickerProps {
  directory: RagIdentityDomainView;
}

function SearchBox({ label, placeholder, query, loading, disabled, onChange }: {
  label: string;
  placeholder: string;
  query: string;
  loading: boolean;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <TextInput
      size="xs"
      aria-label={label}
      placeholder={placeholder}
      leftSection={<IconSearch size={14} />}
      rightSection={loading ? <Loader size="xs" /> : undefined}
      value={query}
      onChange={(event) => onChange(event.currentTarget.value)}
      disabled={disabled}
    />
  );
}

function DirectoryUsers({ directory, taken, full, disabled = false, onAdd }: PartProps) {
  const search = useServerSearch<RagIdentityUserView>(
    async (query, signal) => (await ragAccessApi.directoryUsers(directory.key, { search: query, limit: PICKER_LIMIT }, signal)).users,
    { resetKey: directory.key },
  );
  return (
    <Stack gap="xs">
      <SearchBox label="Search users" placeholder="Search users by name or e-mail" query={search.query} loading={search.loading} disabled={disabled} onChange={search.setQuery} />
      <PickerResults loading={search.loading} error={directoryProblem(search.error)} count={search.items.length} emptyText="No user found.">
        {search.items.map((user) => {
          const principal = formatPrincipal({ kind: 'external_user', domain: directory.key, id: user.extId });
          if (!principal) return null;
          const title = user.name?.trim() || user.email || user.upn || user.extId;
          const contact = user.email || user.upn;
          return (
            <PickerRow
              key={user.extId}
              kind="external_user"
              title={title}
              detail={[contact && contact !== title ? contact : null, user.type === 'guest' ? 'guest' : null].filter(Boolean).join(' · ') || undefined}
              added={taken.has(principal)}
              disabled={disabled || full}
              onAdd={() => onAdd(entryInput(principal, title))}
            />
          );
        })}
      </PickerResults>
    </Stack>
  );
}

function DirectoryGroups({ directory, taken, full, disabled = false, onAdd }: PartProps) {
  const search = useServerSearch<RagIdentityGroupView>(
    async (query, signal) => (await ragAccessApi.directoryGroups(directory.key, { search: query, limit: PICKER_LIMIT }, signal)).groups,
    { resetKey: directory.key },
  );
  return (
    <Stack gap="xs">
      <SearchBox label="Search groups" placeholder="Search groups by name" query={search.query} loading={search.loading} disabled={disabled} onChange={search.setQuery} />
      <PickerResults loading={search.loading} error={directoryProblem(search.error)} count={search.items.length} emptyText="No group found.">
        {search.items.map((group) => {
          const principal = formatPrincipal({ kind: 'external_group', domain: directory.key, id: group.id });
          if (!principal) return null;
          const title = group.name?.trim() || group.id;
          return (
            <PickerRow
              key={group.id}
              kind="external_group"
              title={title}
              detail={`${directory.label} group · ${peopleText(group.users)}`}
              added={taken.has(principal)}
              disabled={disabled || full}
              onAdd={() => onAdd(entryInput(principal, title))}
            />
          );
        })}
      </PickerResults>
    </Stack>
  );
}

function AllMembers({ directory, taken, full, disabled = false, onAdd }: PartProps) {
  const principal = externalAllPrincipal(directory.key);
  return (
    <div role="list">
      <PickerRow
        kind="external_all"
        title="All members"
        detail={`${directory.label} · guests not included`}
        added={taken.has(principal)}
        disabled={disabled || full}
        onAdd={() => onAdd(entryInput(principal, `All members of ${directory.label}`))}
      />
    </div>
  );
}
