'use client';

import { useEffect, useMemo, useState } from 'react';
import { Combobox, Group, Loader, Text, UnstyledButton, useCombobox } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useQuery } from '@tanstack/react-query';
import { IconCheck, IconChevronDown, IconSearch } from '@tabler/icons-react';
import { includesFolded } from '@/lib/shared/searchFold';

type Project = {
  _id: string;
  name: string;
  key: string;
};

export default function ProjectPill() {
  const [submitting, setSubmitting] = useState(false);
  const [search, setSearch] = useState('');
  // The search box takes the focus as the list opens, so typing filters at once
  // and Enter switches to the highlighted (first) match.
  const combobox = useCombobox({
    onDropdownOpen: () => combobox.focusSearchInput(),
    onDropdownClose: () => {
      combobox.resetSelectedOption();
      setSearch('');
    },
  });

  const projectsQuery = useQuery<{ projects: Project[]; activeProjectId?: string }>(
    {
      queryKey: ['projects'],
      queryFn: async () => {
        const res = await fetch('/api/projects', { cache: 'no-store' });
        if (!res.ok) throw new Error('Failed to load projects');
        return (await res.json()) as { projects: Project[]; activeProjectId?: string };
      },
      refetchOnMount: 'always',
    },
  );

  const projects = useMemo(() => {
    return (projectsQuery.data?.projects ?? [])
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [projectsQuery.data?.projects]);

  const activeId = projectsQuery.data?.activeProjectId;
  const activeProject = projects.find((p) => p._id === activeId);
  const visible = useMemo(
    () => projects.filter((p) => includesFolded(p.name, search) || includesFolded(p.key, search)),
    [projects, search],
  );

  // A typed search highlights its first match; an empty one highlights nothing,
  // so Enter on an untouched list changes nothing.
  useEffect(() => {
    if (search.trim()) combobox.selectFirstOption();
    else combobox.resetSelectedOption();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the store is stable; re-run on the query only
  }, [search, visible.length]);
  const loading = projectsQuery.isLoading;
  const errorMessage = projectsQuery.isError
    ? projectsQuery.error instanceof Error
      ? projectsQuery.error.message
      : 'Failed to load projects'
    : undefined;

  const handleSwitch = async (projectId: string) => {
    if (!projectId || projectId === activeId) return;
    setSubmitting(true);
    try {
      const res = await fetch('/api/projects/active', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ projectId }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error || 'Failed to set active project');
      }
      window.location.reload();
    } catch (error) {
      notifications.show({
        title: 'Project',
        message: error instanceof Error ? error.message : 'Unexpected error',
        color: 'red',
      });
      setSubmitting(false);
    }
  };

  if (errorMessage) {
    return (
      <Text size="xs" c="red" px="sm">
        {errorMessage}
      </Text>
    );
  }

  const disabled = loading || submitting || projects.length === 0;

  return (
    <Combobox
      store={combobox}
      position="bottom-end"
      shadow="md"
      width={260}
      withinPortal
      onOptionSubmit={(projectId) => {
        combobox.closeDropdown();
        void handleSwitch(projectId);
      }}
    >
      <Combobox.Target withAriaAttributes={false}>
        <UnstyledButton
          className="ds-project-pill"
          aria-label="Switch project"
          disabled={disabled}
          onClick={() => combobox.toggleDropdown()}
        >
          <span className="ds-project-dot" aria-hidden="true" />
          <span className="ds-project-label">
            {loading ? 'Loading…' : activeProject?.name ?? 'Default Project'}
          </span>
          {submitting ? (
            <Loader size={12} color="teal" />
          ) : (
            <IconChevronDown size={13} stroke={1.7} />
          )}
        </UnstyledButton>
      </Combobox.Target>
      <Combobox.Dropdown>
        <Combobox.Search
          value={search}
          onChange={(event) => setSearch(event.currentTarget.value)}
          placeholder="Search projects"
          aria-label="Search projects"
          leftSection={<IconSearch size={14} stroke={1.7} />}
        />
        <Combobox.Options mah={320} style={{ overflowY: 'auto' }}>
          {visible.length === 0 ? (
            <Combobox.Empty>No project found</Combobox.Empty>
          ) : (
            visible.map((p) => (
              <Combobox.Option key={p._id} value={p._id} active={p._id === activeId}>
                <Group justify="space-between" wrap="nowrap" gap="xs">
                  <div style={{ minWidth: 0 }}>
                    <Text size="sm" fw={p._id === activeId ? 600 : 400} truncate>
                      {p.name}
                    </Text>
                    <Text size="xs" c="dimmed" className="ds-mono" truncate>
                      {p.key}
                    </Text>
                  </div>
                  {p._id === activeId ? (
                    <IconCheck size={13} stroke={2} color="var(--ds-accent)" />
                  ) : null}
                </Group>
              </Combobox.Option>
            ))
          )}
        </Combobox.Options>
      </Combobox.Dropdown>
    </Combobox>
  );
}
