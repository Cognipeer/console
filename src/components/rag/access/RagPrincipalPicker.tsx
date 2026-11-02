'use client';

/**
 * The pickers of the permission editor's "Add" panel that need no directory: people, groups and API tokens (found by
 * a server-side search that works for a Knowledge Engine admin who has no access to the IAM directory), and an
 * e-mail address typed by hand.
 */

import { useState, type ReactNode } from 'react';
import { Button, Group, Loader, Stack, Text, TextInput } from '@mantine/core';
import { IconCheck, IconPlus, IconSearch } from '@tabler/icons-react';
import type { RagPrincipalKind } from '@/lib/services/rag/access/principals';
import { PrincipalIcon } from './PrincipalIcon';
import { emailEntry, entryInput } from './principalDisplay';
import { ACCESS_TEXT } from './ragAccessText';
import { ragAccessApi, type RagAccessPrincipalOption, type RagAclEntryInput } from './ragAccessApi';
import { useServerSearch } from './useRagAccessData';

/** Rows asked for per search; a longer list is narrowed by typing. */
export const PICKER_LIMIT = 20;

/* ── A result row ────────────────────────────────────────────────────────── */

export interface PickerRowProps {
  kind: RagPrincipalKind;
  title: string;
  detail?: string;
  /** Already in the list. */
  added: boolean;
  /** Nothing can be added now (the list is full, or the editor is read-only). */
  disabled: boolean;
  onAdd: () => void;
}

export function PickerRow({ kind, title, detail, added, disabled, onAdd }: PickerRowProps) {
  return (
    <Group role="listitem" justify="space-between" wrap="nowrap" gap="sm" py={6}>
      <Group gap="sm" wrap="nowrap" style={{ minWidth: 0 }}>
        <PrincipalIcon kind={kind} size={26} />
        <div style={{ minWidth: 0 }}>
          <Text size="sm" fw={500} truncate>{title}</Text>
          {detail ? <Text size="xs" c="dimmed" truncate>{detail}</Text> : null}
        </div>
      </Group>
      {added ? (
        <Button size="xs" variant="subtle" color="teal" leftSection={<IconCheck size={12} />} disabled aria-label={`${title} is added`}>
          Added
        </Button>
      ) : (
        <Button size="xs" variant="light" leftSection={<IconPlus size={12} />} disabled={disabled} onClick={onAdd} aria-label={`Add ${title}`}>
          Add
        </Button>
      )}
    </Group>
  );
}

/** The rows of a search, with its empty, failed and cut-short states. */
export function PickerResults({
  loading,
  error,
  count,
  emptyText,
  children,
}: {
  loading: boolean;
  error: Error | null;
  count: number;
  emptyText: string;
  children: ReactNode;
}) {
  if (error) return <Text size="sm" c="red" role="alert">{error.message}</Text>;
  if (!loading && count === 0) return <Text size="sm" c="dimmed">{emptyText}</Text>;
  return (
    <Stack gap={0}>
      <div role="list" aria-label="Results" style={{ maxHeight: 280, overflowY: 'auto' }}>{children}</div>
      {count >= PICKER_LIMIT ? (
        <Text size="xs" c="dimmed" mt={6}>Showing the first {PICKER_LIMIT}. Type to narrow the list.</Text>
      ) : null}
    </Stack>
  );
}

/* ── People, groups, API tokens ──────────────────────────────────────────── */

const COPY = {
  user: {
    note: 'People who can open this knowledge engine’s project.',
    label: 'Search people',
    placeholder: 'Search people by name or e-mail',
    empty: 'No person found.',
  },
  group: {
    note: 'Console groups. Everyone in the group reads, now and later.',
    label: 'Search groups',
    placeholder: 'Search groups by name',
    empty: 'No group found.',
  },
  token: {
    note: 'An API token reads for calls without a person, such as a trigger or a key that belongs to no user.',
    label: 'Search API tokens',
    placeholder: 'Search API tokens by name',
    empty: 'No API token found.',
  },
} as const;

export interface RagPrincipalPickerProps {
  moduleKey: string;
  type: 'user' | 'group' | 'token';
  /** Keys already in the list. */
  taken: ReadonlySet<string>;
  /** The list holds its most. */
  full: boolean;
  disabled?: boolean;
  onAdd: (entry: RagAclEntryInput) => void;
}

export function RagPrincipalPicker({ moduleKey, type, taken, full, disabled = false, onAdd }: RagPrincipalPickerProps) {
  const copy = COPY[type];
  const search = useServerSearch<RagAccessPrincipalOption>(
    (query, signal) => ragAccessApi.principals(moduleKey, type, query, PICKER_LIMIT, signal),
    { resetKey: `${moduleKey}:${type}` },
  );

  return (
    <Stack gap="xs">
      <Text size="xs" c="dimmed">{copy.note}</Text>
      <TextInput
        size="xs"
        aria-label={copy.label}
        placeholder={copy.placeholder}
        leftSection={<IconSearch size={14} />}
        rightSection={search.loading ? <Loader size="xs" /> : undefined}
        value={search.query}
        onChange={(event) => search.setQuery(event.currentTarget.value)}
        disabled={disabled}
      />
      <PickerResults loading={search.loading} error={search.error} count={search.items.length} emptyText={copy.empty}>
        {search.items.map((option) => (
          <PickerRow
            key={option.principal}
            kind={option.kind}
            title={option.label}
            detail={option.detail}
            added={taken.has(option.principal)}
            disabled={disabled || full}
            onAdd={() => onAdd(entryInput(option.principal, option.label))}
          />
        ))}
      </PickerResults>
    </Stack>
  );
}

/* ── An e-mail address ───────────────────────────────────────────────────── */

export interface RagEmailAdderProps {
  taken: ReadonlySet<string>;
  full: boolean;
  disabled?: boolean;
  onAdd: (entry: RagAclEntryInput) => void;
}

export function RagEmailAdder({ taken, full, disabled = false, onAdd }: RagEmailAdderProps) {
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);

  const submit = () => {
    // Enter reaches here even while Add is disabled.
    if (disabled) return;
    if (full) {
      setError(ACCESS_TEXT.listFull);
      return;
    }
    const result = emailEntry(value);
    if ('error' in result) {
      setError(result.error);
      return;
    }
    if (taken.has(result.entry.principal)) {
      setError(ACCESS_TEXT.emailTaken);
      return;
    }
    onAdd(result.entry);
    setValue('');
    setError(null);
  };

  return (
    <Stack gap="xs">
      <Text size="xs" c="dimmed">
        Whoever signs in with this address reads, also when their account is created later.
      </Text>
      <Group gap="xs" align="flex-start" wrap="nowrap">
        <TextInput
          size="xs"
          style={{ flex: 1 }}
          aria-label="E-mail address"
          placeholder="name@example.com"
          value={value}
          onChange={(event) => {
            setValue(event.currentTarget.value);
            setError(null);
          }}
          onKeyDown={(event) => {
            if (event.key !== 'Enter') return;
            event.preventDefault();
            submit();
          }}
          error={error ?? undefined}
          disabled={disabled}
        />
        <Button size="xs" variant="light" leftSection={<IconPlus size={12} />} disabled={disabled || full || value.trim() === ''} onClick={submit}>
          Add
        </Button>
      </Group>
    </Stack>
  );
}
