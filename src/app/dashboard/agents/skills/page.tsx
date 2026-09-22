'use client';

import { useEffect, useMemo, useState } from 'react';
import { Button, Group, Modal, Text } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import {
  IconBulb,
  IconEdit,
  IconPlayerPause,
  IconPlayerPlay,
  IconPlus,
  IconTrash,
} from '@tabler/icons-react';
import PageContainer, { PageHeader } from '@/components/common/ui/PageContainer';
import StatTile from '@/components/common/ui/StatTile';
import DataGrid, { type DataGridColumn } from '@/components/common/ui/DataGrid';
import StatusBadge from '@/components/common/ui/StatusBadge';
import SkillEditorModal from '@/components/skills/SkillEditorModal';
import type { SkillView } from '@/components/skills/types';

export default function SkillsPage() {
  const [skills, setSkills] = useState<SkillView[]>([]);
  const [loading, setLoading] = useState(true);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<SkillView | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<SkillView | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');

  const loadSkills = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/skills', { cache: 'no-store' });
      if (res.ok) {
        const data = await res.json();
        setSkills(data.skills ?? []);
      }
    } catch (err) {
      console.error('Failed to load skills', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadSkills();
  }, []);

  const toggleStatus = async (skill: SkillView) => {
    try {
      const nextStatus = skill.status === 'active' ? 'inactive' : 'active';
      const res = await fetch(`/api/skills/${skill._id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: nextStatus }),
      });
      if (!res.ok) throw new Error('Failed to update skill');
      notifications.show({
        title: nextStatus === 'active' ? 'Skill enabled' : 'Skill disabled',
        message: `"${skill.title}" is now ${nextStatus}`,
        color: nextStatus === 'active' ? 'teal' : 'orange',
      });
      await loadSkills();
    } catch (err) {
      notifications.show({ title: 'Error', message: err instanceof Error ? err.message : 'Failed to update', color: 'red' });
    }
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      const res = await fetch(`/api/skills/${deleteTarget._id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Failed to delete');
      notifications.show({ title: 'Skill deleted', message: `"${deleteTarget.title}" was deleted`, color: 'red' });
      setDeleteTarget(null);
      await loadSkills();
    } catch (err) {
      notifications.show({ title: 'Error', message: err instanceof Error ? err.message : 'Failed to delete', color: 'red' });
    } finally {
      setDeleting(false);
    }
  };

  const filtered = useMemo(() => {
    return skills.filter((s) => {
      if (statusFilter !== 'all' && s.status !== statusFilter) return false;
      if (query) {
        const q = query.toLowerCase();
        if (!s.title.toLowerCase().includes(q) && !s.header.toLowerCase().includes(q) && !s.key.toLowerCase().includes(q)) {
          return false;
        }
      }
      return true;
    });
  }, [skills, query, statusFilter]);

  const totalSkills = skills.length;
  const activeSkills = skills.filter((s) => s.status === 'active').length;

  const columns: DataGridColumn<SkillView>[] = [
    {
      key: 'title',
      label: 'Skill',
      render: (s) => (
        <div className="ds-col" style={{ gap: 2 }}>
          <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--ds-text)' }}>{s.title}</span>
          <span className="ds-faint" style={{ fontSize: 11.5, maxWidth: 400 }}>
            {s.header.length > 90 ? `${s.header.slice(0, 90)}…` : s.header}
          </span>
        </div>
      ),
    },
    {
      key: 'tier',
      label: 'Model tier',
      render: (s) => <span className="ds-faint" style={{ fontSize: 12 }}>{s.minModelTier ?? 'any'}</span>,
    },
    {
      key: 'status',
      label: 'Status',
      render: (s) => <StatusBadge status={s.status === 'active' ? 'active' : 'paused'} />,
    },
    {
      key: 'key',
      label: 'Key',
      render: (s) => <span className="ds-mono ds-faint" style={{ fontSize: 12 }}>{s.key}</span>,
    },
  ];

  return (
    <PageContainer>
      <PageHeader
        eyebrow="Build · Agents · Skills"
        title="Skills"
        subtitle="Reusable capabilities an agent can discover and open on demand — Anthropic-style progressive disclosure."
        actions={
          <Button color="teal" size="sm" leftSection={<IconPlus size={14} stroke={1.7} />} onClick={() => { setEditing(null); setEditorOpen(true); }}>
            New skill
          </Button>
        }
      />

      <div className="ds-stat-grid" style={{ marginBottom: 16 }}>
        <StatTile label="Total skills" value={totalSkills} icon={<IconBulb size={14} />} />
        <StatTile label="Active" value={activeSkills} />
        <StatTile label="Inactive" value={totalSkills - activeSkills} />
      </div>

      <DataGrid<SkillView>
        records={filtered}
        loading={loading}
        rowKey={(s) => s._id}
        onRowClick={(s) => { setEditing(s); setEditorOpen(true); }}
        columns={columns}
        search={{ value: query, onChange: setQuery, placeholder: 'Filter by title, key, or header…' }}
        filters={[
          {
            value: statusFilter,
            onChange: setStatusFilter,
            ariaLabel: 'Filter by status',
            width: 140,
            options: [
              { value: 'all', label: 'All statuses' },
              { value: 'active', label: 'Active' },
              { value: 'inactive', label: 'Inactive' },
            ],
          },
        ]}
        onRefresh={loadSkills}
        empty={{
          icon: <IconBulb size={26} stroke={1.7} />,
          title: 'No skills yet',
          description: 'A skill is a capability an agent can discover and open on demand — write the instructions once, attach it to any agent from its Skills tab.',
          primaryAction: {
            label: 'Create your first skill',
            icon: <IconPlus size={14} stroke={1.7} />,
            onClick: () => { setEditing(null); setEditorOpen(true); },
          },
        }}
        footerLeft={`Showing ${filtered.length} of ${totalSkills} skills`}
        rowActions={(s) => [
          {
            id: 'edit',
            label: 'Edit',
            icon: <IconEdit size={14} />,
            onClick: () => { setEditing(s); setEditorOpen(true); },
          },
          {
            id: 'toggle',
            label: s.status === 'active' ? 'Disable' : 'Enable',
            icon: s.status === 'active' ? <IconPlayerPause size={14} /> : <IconPlayerPlay size={14} />,
            onClick: () => void toggleStatus(s),
          },
          { divider: true },
          {
            id: 'delete',
            label: 'Delete',
            icon: <IconTrash size={14} />,
            color: 'red',
            onClick: () => setDeleteTarget(s),
          },
        ]}
      />

      <Modal opened={deleteTarget !== null} onClose={() => setDeleteTarget(null)} title="Delete skill" centered size="sm">
        <Text size="sm" mb="lg">
          Are you sure you want to delete <strong>{deleteTarget?.title}</strong>? Any agent whose Skills tab
          references this key will simply stop seeing it — nothing breaks, but confirm no agent still relies on it.
        </Text>
        <Group justify="flex-end">
          <Button variant="default" onClick={() => setDeleteTarget(null)}>Cancel</Button>
          <Button color="red" loading={deleting} onClick={confirmDelete}>Delete</Button>
        </Group>
      </Modal>

      <SkillEditorModal
        opened={editorOpen}
        onClose={() => setEditorOpen(false)}
        skill={editing}
        onSaved={() => {
          setEditorOpen(false);
          void loadSkills();
        }}
      />
    </PageContainer>
  );
}
