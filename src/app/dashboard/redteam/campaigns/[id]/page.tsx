'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { Button, Group, Loader, Menu, Modal, Text } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconDots, IconPencil, IconPlayerPlay, IconShield, IconTrash } from '@tabler/icons-react';
import DetailShell from '@/components/common/ui/DetailShell';
import DataGrid, { type DataGridColumn } from '@/components/common/ui/DataGrid';
import StatTile from '@/components/common/ui/StatTile';
import CreateCampaignModal from '@/components/redteam/CreateCampaignModal';
import RunScanModal from '@/components/redteam/RunScanModal';
import type { ProbeCatalogView, RedTeamCampaignView, RedTeamRunView, SelectOption } from '@/components/redteam/types';

const RUN_STATUS_BADGE: Record<string, string> = {
  completed: 'ds-badge-teal',
  running: 'ds-badge-info',
  failed: 'ds-badge-err',
  pending: 'ds-badge',
  cancelled: 'ds-badge-warn',
};

function fmtDate(value?: string): string {
  if (!value) return '—';
  const d = new Date(value);
  return Number.isFinite(d.getTime()) ? d.toLocaleString() : '—';
}

function pct(value?: number): string {
  return value === undefined || value === null ? '—' : `${Math.round(value * 100)}%`;
}

export default function RedTeamCampaignDetailPage() {
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const id = params?.id;

  const [campaign, setCampaign] = useState<RedTeamCampaignView | null>(null);
  const [runs, setRuns] = useState<RedTeamRunView[]>([]);
  const [agents, setAgents] = useState<SelectOption[]>([]);
  const [models, setModels] = useState<SelectOption[]>([]);
  const [probes, setProbes] = useState<ProbeCatalogView[]>([]);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [scanOpen, setScanOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(async () => {
    if (!id) return;
    try {
      const res = await fetch(`/api/redteam/campaigns/${id}`, { cache: 'no-store' });
      if (res.status === 404) { setNotFound(true); return; }
      const data = await res.json();
      const c: RedTeamCampaignView | null = data.campaign ?? null;
      setCampaign(c);
      if (c) {
        const rRes = await fetch(`/api/redteam/runs?campaignKey=${encodeURIComponent(c.key)}`, { cache: 'no-store' });
        if (rRes.ok) setRuns((await rRes.json()).runs ?? []);
      }
    } catch {
      setNotFound(true);
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => { void load(); }, [load]);

  // Dropdown data for the edit form.
  useEffect(() => {
    void (async () => {
      const [aRes, mRes, pRes] = await Promise.all([
        fetch('/api/agents', { cache: 'no-store' }),
        fetch('/api/models?category=llm', { cache: 'no-store' }),
        fetch('/api/redteam/probes', { cache: 'no-store' }),
      ]);
      if (aRes.ok) setAgents(((await aRes.json()).agents ?? []).map((a: { key: string; name: string }) => ({ value: a.key, label: a.name })));
      if (mRes.ok) setModels(((await mRes.json()).models ?? []).map((m: { key: string; name: string }) => ({ value: m.key, label: m.name })));
      if (pRes.ok) setProbes((await pRes.json()).probes ?? []);
    })();
  }, []);

  const confirmDelete = async () => {
    if (!campaign) return;
    setDeleting(true);
    try {
      const res = await fetch(`/api/redteam/campaigns/${campaign.id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Failed to delete');
      notifications.show({ title: 'Deleted', message: campaign.name, color: 'red' });
      router.push('/dashboard/redteam');
    } catch (err) {
      notifications.show({ title: 'Error', message: err instanceof Error ? err.message : 'Failed to delete', color: 'red' });
    } finally {
      setDeleting(false);
    }
  };

  const runColumns: DataGridColumn<RedTeamRunView>[] = [
    { key: 'status', label: 'Status', render: (r) => <span className={`ds-badge ${RUN_STATUS_BADGE[r.status] ?? ''}`}>{r.status}</span> },
    { key: 'asr', label: 'Attack success', render: (r) => <span>{r.aggregate ? pct(r.aggregate.attackSuccessRate) : '—'}</span> },
    { key: 'vuln', label: 'Vulnerable', render: (r) => <span className={r.aggregate && r.aggregate.vulnerable > 0 ? 'ds-badge ds-badge-err' : ''}>{r.aggregate ? r.aggregate.vulnerable : '—'}</span> },
    { key: 'review', label: 'Needs review', render: (r) => <span>{r.aggregate ? r.aggregate.needsReview : '—'}</span> },
    { key: 'started', label: 'Started', render: (r) => <span className="ds-faint" style={{ fontSize: 12 }}>{fmtDate(r.startedAt ?? r.createdAt)}</span> },
  ];

  if (loading) {
    return <DetailShell backHref="/dashboard/redteam" title="Loading…"><Group justify="center" mt={60}><Loader /></Group></DetailShell>;
  }
  if (notFound || !campaign) {
    return (
      <DetailShell backHref="/dashboard/redteam" title="Campaign not found">
        <Text c="dimmed" size="sm">This campaign could not be found.</Text>
      </DetailShell>
    );
  }

  const latest = runs.find((r) => r.aggregate)?.aggregate;

  return (
    <DetailShell
      backHref="/dashboard/redteam"
      backLabel="Back to campaigns"
      icon={<div className="detail-icon-badge"><IconShield size={18} stroke={1.7} /></div>}
      title={<h1 style={{ margin: 0, fontSize: 20 }}>{campaign.name}</h1>}
      meta={
        <span>
          <span className="ds-mono">{campaign.key}</span> · {campaign.targetKind}{' '}
          <span className="ds-mono">{campaign.agentKey ?? campaign.modelKey}</span>
          {campaign.schedule?.enabled ? <> · <span className="ds-badge ds-badge-info ds-mono">{campaign.schedule.cron}</span></> : null}
        </span>
      }
      actions={
        <>
          <Button color="teal" size="sm" leftSection={<IconPlayerPlay size={14} />} onClick={() => setScanOpen(true)}>
            Run scan
          </Button>
          <Menu position="bottom-end" withinPortal>
            <Menu.Target><Button variant="default" size="sm" px={8}><IconDots size={16} /></Button></Menu.Target>
            <Menu.Dropdown>
              <Menu.Item leftSection={<IconPencil size={14} />} onClick={() => setEditing(true)}>Edit</Menu.Item>
              <Menu.Divider />
              <Menu.Item color="red" leftSection={<IconTrash size={14} />} onClick={() => setDeleteOpen(true)}>Delete</Menu.Item>
            </Menu.Dropdown>
          </Menu>
        </>
      }
    >
      <div className="ds-stat-grid" style={{ marginBottom: 16 }}>
        <StatTile label="Probes" value={campaign.probeKeys.length === 0 ? 'all' : campaign.probeKeys.length} />
        <StatTile label="Scans" value={runs.length} />
        <StatTile label="Latest vulnerable" value={latest ? latest.vulnerable : '—'} />
        <StatTile label="Latest resilience" value={latest ? pct(latest.resilienceScore) : '—'} />
      </div>

      {campaign.description ? <Text size="sm" c="dimmed" mb="md">{campaign.description}</Text> : null}

      <DataGrid<RedTeamRunView>
        records={runs}
        loading={false}
        rowKey={(r) => r.id}
        columns={runColumns}
        onRowClick={(r) => router.push(`/dashboard/redteam/runs/${r.id}`)}
        footerLeft={`${runs.length} scans`}
        empty={{
          icon: <IconPlayerPlay size={26} stroke={1.7} />,
          title: 'No scans yet',
          description: 'Run a scan to see vulnerability results here.',
          primaryAction: { label: 'Run scan', icon: <IconPlayerPlay size={14} />, onClick: () => setScanOpen(true) },
        }}
      />

      <Modal opened={deleteOpen} onClose={() => setDeleteOpen(false)} title="Delete campaign" centered size="sm">
        <Text size="sm" mb="lg">Delete <strong>{campaign.name}</strong>? This cannot be undone.</Text>
        <Group justify="flex-end">
          <Button variant="default" onClick={() => setDeleteOpen(false)}>Cancel</Button>
          <Button color="red" loading={deleting} onClick={confirmDelete}>Delete</Button>
        </Group>
      </Modal>

      <CreateCampaignModal
        opened={editing}
        editing={campaign}
        onClose={() => setEditing(false)}
        agents={agents}
        models={models}
        probes={probes}
        onSaved={() => void load()}
      />

      <RunScanModal
        opened={scanOpen}
        campaign={campaign}
        probes={probes}
        models={models}
        onClose={() => setScanOpen(false)}
        onStarted={(runId) => router.push(`/dashboard/redteam/runs/${runId}`)}
      />
    </DetailShell>
  );
}
