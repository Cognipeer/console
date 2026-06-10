'use client';

/**
 * Red-team workspace — renders one sub-section (campaigns / runs / api). Scans
 * run asynchronously on the queue, so triggering one returns a pending run and
 * the workspace polls while any run is pending/running.
 */

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Group, Modal, Text } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import {
  IconBug,
  IconPencil,
  IconPlayerPlay,
  IconPlus,
  IconShield,
  IconShieldCheck,
  IconTrash,
} from '@tabler/icons-react';
import PageContainer, { PageHeader } from '@/components/common/ui/PageContainer';
import StatTile from '@/components/common/ui/StatTile';
import DataGrid, { type DataGridColumn } from '@/components/common/ui/DataGrid';
import { useTableControls } from '@/components/common/ui/useTableControls';
import CreateCampaignModal from '@/components/redteam/CreateCampaignModal';
import CreateCustomProbeModal from '@/components/redteam/CreateCustomProbeModal';
import RunScanModal from '@/components/redteam/RunScanModal';
import RedTeamApiUsage from '@/components/redteam/RedTeamApiUsage';
import type {
  CustomProbeView,
  ProbeCatalogView,
  RedTeamCampaignView,
  RedTeamRunView,
  SelectOption,
} from '@/components/redteam/types';

export type RedTeamSection = 'campaigns' | 'runs' | 'probes' | 'api';

const SEVERITY_BADGE: Record<string, string> = {
  critical: 'ds-badge-err',
  high: 'ds-badge-warn',
  medium: 'ds-badge-info',
  low: 'ds-badge',
};

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
  return value === undefined ? '—' : `${Math.round(value * 100)}%`;
}

export default function RedTeamWorkspace({ section }: { section: RedTeamSection }) {
  const router = useRouter();
  const [campaigns, setCampaigns] = useState<RedTeamCampaignView[]>([]);
  const [runs, setRuns] = useState<RedTeamRunView[]>([]);
  const [probes, setProbes] = useState<ProbeCatalogView[]>([]);
  const [customProbes, setCustomProbes] = useState<CustomProbeView[]>([]);
  const [agents, setAgents] = useState<SelectOption[]>([]);
  const [models, setModels] = useState<SelectOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [scanCampaign, setScanCampaign] = useState<RedTeamCampaignView | null>(null);

  const [campaignModal, setCampaignModal] = useState(false);
  const [deleteItem, setDeleteItem] = useState<{ id: string; name: string } | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [probeModal, setProbeModal] = useState(false);
  const [editingProbe, setEditingProbe] = useState<CustomProbeView | null>(null);
  const [deleteProbe, setDeleteProbe] = useState<{ id: string; name: string } | null>(null);
  const [deletingProbe, setDeletingProbe] = useState(false);

  const loadAll = async () => {
    setRefreshing(true);
    try {
      const [cRes, rRes, pRes, cpRes, aRes, mRes] = await Promise.all([
        fetch('/api/redteam/campaigns', { cache: 'no-store' }),
        fetch('/api/redteam/runs', { cache: 'no-store' }),
        fetch('/api/redteam/probes', { cache: 'no-store' }),
        fetch('/api/redteam/custom-probes', { cache: 'no-store' }),
        fetch('/api/agents', { cache: 'no-store' }),
        fetch('/api/models?category=llm', { cache: 'no-store' }),
      ]);
      if (cRes.ok) setCampaigns((await cRes.json()).campaigns ?? []);
      if (rRes.ok) setRuns((await rRes.json()).runs ?? []);
      if (pRes.ok) setProbes((await pRes.json()).probes ?? []);
      if (cpRes.ok) setCustomProbes((await cpRes.json()).probes ?? []);
      if (aRes.ok) {
        setAgents(((await aRes.json()).agents ?? []).map((a: { key: string; name: string }) => ({ value: a.key, label: a.name })));
      }
      if (mRes.ok) {
        setModels(((await mRes.json()).models ?? []).map((m: { key: string; name: string }) => ({ value: m.key, label: m.name })));
      }
    } catch (err) {
      console.error('Failed to load red-team data', err);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  const loadRuns = async () => {
    const res = await fetch('/api/redteam/runs', { cache: 'no-store' });
    if (res.ok) setRuns((await res.json()).runs ?? []);
  };

  useEffect(() => {
    void loadAll();
  }, []);

  // Poll while any scan is still pending/running in the background.
  const hasActive = runs.some((r) => r.status === 'pending' || r.status === 'running');
  useEffect(() => {
    if (!hasActive) return;
    const timer = setInterval(() => { void loadRuns(); }, 4000);
    return () => clearInterval(timer);
  }, [hasActive]);


  const confirmDelete = async () => {
    if (!deleteItem) return;
    setDeleting(true);
    try {
      const res = await fetch(`/api/redteam/campaigns/${deleteItem.id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Failed to delete');
      notifications.show({ title: 'Deleted', message: `"${deleteItem.name}" was deleted`, color: 'red' });
      setDeleteItem(null);
      await loadAll();
    } catch (err) {
      notifications.show({ title: 'Error', message: err instanceof Error ? err.message : 'Failed to delete', color: 'red' });
    } finally {
      setDeleting(false);
    }
  };

  const confirmDeleteProbe = async () => {
    if (!deleteProbe) return;
    setDeletingProbe(true);
    try {
      const res = await fetch(`/api/redteam/custom-probes/${deleteProbe.id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Failed to delete');
      notifications.show({ title: 'Deleted', message: `"${deleteProbe.name}" was deleted`, color: 'red' });
      setDeleteProbe(null);
      await loadAll();
    } catch (err) {
      notifications.show({ title: 'Error', message: err instanceof Error ? err.message : 'Failed to delete', color: 'red' });
    } finally {
      setDeletingProbe(false);
    }
  };

  const totalVulnerable = runs.reduce((n, r) => n + (r.aggregate?.vulnerable ?? 0), 0);
  const lastResilience = runs.find((r) => r.aggregate)?.aggregate?.resilienceScore;

  const campaignsCtl = useTableControls(campaigns, {
    searchText: (c) => `${c.name} ${c.key} ${c.targetKind} ${c.agentKey ?? ''} ${c.modelKey ?? ''}`,
    searchPlaceholder: 'Filter by name, key, or target…',
  });
  const runsCtl = useTableControls(runs, {
    searchText: (r) => `${r.campaignKey} ${r.status}`,
    searchPlaceholder: 'Filter by campaign or status…',
  });
  const probesCtl = useTableControls(customProbes, {
    searchText: (p) => `${p.name} ${p.key} ${p.category} ${p.severity}`,
    searchPlaceholder: 'Filter by name, category, or severity…',
  });

  const campaignColumns: DataGridColumn<RedTeamCampaignView>[] = [
    { key: 'name', label: 'Name', render: (c) => (
      <div className="ds-col" style={{ gap: 2 }}>
        <span style={{ fontWeight: 500, color: 'var(--ds-text)' }}>{c.name}</span>
        <span className="ds-faint ds-mono" style={{ fontSize: 11 }}>{c.key}</span>
      </div>
    ) },
    { key: 'kind', label: 'Target', render: (c) => <span className="ds-badge ds-badge-info">{c.targetKind}</span> },
    { key: 'ref', label: 'Agent / Model', render: (c) => (
      <span className="ds-mono ds-muted" style={{ fontSize: 12 }}>{c.agentKey ?? c.modelKey ?? '—'}</span>
    ) },
    { key: 'probes', label: 'Probes', render: (c) => <span>{c.probeKeys.length === 0 ? 'all' : c.probeKeys.length}</span> },
    { key: 'schedule', label: 'Schedule', render: (c) => (
      c.schedule?.enabled
        ? <span className="ds-badge ds-badge-info ds-mono" title="cron (UTC)">{c.schedule.cron}</span>
        : <span className="ds-faint">manual</span>
    ) },
    { key: 'created', label: 'Created', render: (c) => <span className="ds-faint" style={{ fontSize: 12 }}>{fmtDate(c.createdAt)}</span> },
  ];

  const runColumns: DataGridColumn<RedTeamRunView>[] = [
    { key: 'campaign', label: 'Campaign', render: (r) => <span className="ds-mono" style={{ fontSize: 12 }}>{r.campaignKey}</span> },
    { key: 'status', label: 'Status', render: (r) => <span className={`ds-badge ${RUN_STATUS_BADGE[r.status] ?? ''}`}>{r.status}</span> },
    { key: 'asr', label: 'Attack success', render: (r) => <span>{r.aggregate ? pct(r.aggregate.attackSuccessRate) : '—'}</span> },
    { key: 'vuln', label: 'Vulnerable', render: (r) => (
      <span className={r.aggregate && r.aggregate.vulnerable > 0 ? 'ds-badge ds-badge-err' : ''}>
        {r.aggregate ? r.aggregate.vulnerable : '—'}
      </span>
    ) },
    { key: 'review', label: 'Needs review', render: (r) => <span>{r.aggregate ? r.aggregate.needsReview : '—'}</span> },
    { key: 'resilience', label: 'Resilience', render: (r) => <span>{r.aggregate ? pct(r.aggregate.resilienceScore) : '—'}</span> },
    { key: 'created', label: 'Started', render: (r) => <span className="ds-faint" style={{ fontSize: 12 }}>{fmtDate(r.startedAt ?? r.createdAt)}</span> },
  ];

  const customProbeColumns: DataGridColumn<CustomProbeView>[] = [
    { key: 'name', label: 'Name', render: (p) => (
      <div className="ds-col" style={{ gap: 2 }}>
        <span style={{ fontWeight: 500, color: 'var(--ds-text)' }}>{p.name}</span>
        <span className="ds-faint ds-mono" style={{ fontSize: 11 }}>{p.key}</span>
      </div>
    ) },
    { key: 'category', label: 'OWASP category', render: (p) => <span className="ds-mono ds-muted" style={{ fontSize: 12 }}>{p.category}</span> },
    { key: 'severity', label: 'Severity', render: (p) => <span className={`ds-badge ${SEVERITY_BADGE[p.severity] ?? ''}`}>{p.severity}</span> },
    { key: 'attempts', label: 'Attempts', render: (p) => <span>{p.attempts.length}</span> },
    { key: 'detectors', label: 'Detectors', render: (p) => {
      const parts: string[] = [];
      if (p.detectors.refusal) parts.push('refusal');
      if (p.detectors.pattern) parts.push('pattern');
      if (p.detectors.judges?.length) parts.push(`${p.detectors.judges.length} judge`);
      return <span className="ds-faint" style={{ fontSize: 12 }}>{parts.join(' · ') || '—'}</span>;
    } },
    { key: 'enabled', label: 'Status', render: (p) => (
      <span className={`ds-badge ${p.enabled === false ? 'ds-badge' : 'ds-badge-teal'}`}>{p.enabled === false ? 'disabled' : 'enabled'}</span>
    ) },
  ];

  const actionButton = useMemo(() => {
    if (section === 'campaigns') {
      return (
        <Button color="teal" size="sm" leftSection={<IconPlus size={14} stroke={1.7} />} onClick={() => setCampaignModal(true)}>
          New campaign
        </Button>
      );
    }
    if (section === 'probes') {
      return (
        <Button color="teal" size="sm" leftSection={<IconPlus size={14} stroke={1.7} />} onClick={() => { setEditingProbe(null); setProbeModal(true); }}>
          New custom probe
        </Button>
      );
    }
    return null;
  }, [section]);

  return (
    <PageContainer>
      <PageHeader
        eyebrow="Operate · Red Team"
        title="Red Team"
        subtitle="Adversarial testing for agents and models. Probes generate attacks, a layered decision engine judges each verdict (safe / vulnerable / needs review), and scans run unattended in the background."
        actions={actionButton}
      />

      <div className="ds-stat-grid" style={{ marginBottom: 16 }}>
        <StatTile label="Campaigns" icon={<IconShield size={14} stroke={1.7} />} value={campaigns.length} />
        <StatTile label="Scans" icon={<IconPlayerPlay size={14} stroke={1.7} />} value={runs.length} />
        <StatTile label="Vulnerabilities" icon={<IconShieldCheck size={14} stroke={1.7} />} value={totalVulnerable} />
        <StatTile label="Latest resilience" value={lastResilience === undefined ? '—' : pct(lastResilience)} />
      </div>

      {section === 'campaigns' && (
        <DataGrid<RedTeamCampaignView>
          records={campaignsCtl.records}
          loading={loading}
          rowKey={(c) => c.id}
          columns={campaignColumns}
          search={campaignsCtl.search}
          pagination={campaignsCtl.pagination}
          footerLeft={campaignsCtl.footerLeft('campaigns')}
          onRefresh={loadAll}
          refreshing={refreshing}
          onRowClick={(c) => router.push(`/dashboard/redteam/campaigns/${c.id}`)}
          empty={{
            icon: <IconShield size={26} stroke={1.7} />,
            title: 'No campaigns yet',
            description: 'A campaign points a set of adversarial probes at one agent or model.',
            primaryAction: { label: 'New campaign', icon: <IconPlus size={14} />, onClick: () => setCampaignModal(true) },
          }}
          rowActions={(c) => [
            {
              id: 'scan',
              label: 'Run scan',
              icon: <IconPlayerPlay size={14} />,
              onClick: () => setScanCampaign(c),
            },
            { id: 'open', label: 'Open', icon: <IconPencil size={14} />, onClick: () => router.push(`/dashboard/redteam/campaigns/${c.id}`) },
            { divider: true },
            { id: 'delete', label: 'Delete', icon: <IconTrash size={14} />, color: 'red', onClick: () => setDeleteItem({ id: c.id, name: c.name }) },
          ]}
        />
      )}

      {section === 'runs' && (
        <DataGrid<RedTeamRunView>
          records={runsCtl.records}
          loading={loading}
          rowKey={(r) => r.id}
          columns={runColumns}
          search={runsCtl.search}
          pagination={runsCtl.pagination}
          footerLeft={runsCtl.footerLeft('scans')}
          onRowClick={(r) => router.push(`/dashboard/redteam/runs/${r.id}`)}
          onRefresh={loadAll}
          refreshing={refreshing}
          empty={{
            icon: <IconPlayerPlay size={26} stroke={1.7} />,
            title: 'No scans yet',
            description: 'Run a campaign from the Campaigns section to see scan results here.',
          }}
        />
      )}

      {section === 'probes' && (
        <DataGrid<CustomProbeView>
          records={probesCtl.records}
          loading={loading}
          rowKey={(p) => p.id}
          columns={customProbeColumns}
          search={probesCtl.search}
          pagination={probesCtl.pagination}
          footerLeft={probesCtl.footerLeft('custom probes')}
          onRefresh={loadAll}
          refreshing={refreshing}
          onRowClick={(p) => { setEditingProbe(p); setProbeModal(true); }}
          empty={{
            icon: <IconBug size={26} stroke={1.7} />,
            title: 'No custom probes yet',
            description: 'Author your own adversarial probes (attacks + detectors) to extend the built-in catalog. They become selectable in any campaign.',
            primaryAction: { label: 'New custom probe', icon: <IconPlus size={14} />, onClick: () => { setEditingProbe(null); setProbeModal(true); } },
          }}
          rowActions={(p) => [
            { id: 'edit', label: 'Edit', icon: <IconPencil size={14} />, onClick: () => { setEditingProbe(p); setProbeModal(true); } },
            { divider: true },
            { id: 'delete', label: 'Delete', icon: <IconTrash size={14} />, color: 'red', onClick: () => setDeleteProbe({ id: p.id, name: p.name }) },
          ]}
        />
      )}

      {section === 'api' && <RedTeamApiUsage campaignKey={campaigns[0]?.key} />}

      <Modal opened={deleteItem !== null} onClose={() => setDeleteItem(null)} title="Delete" centered size="sm">
        <Text size="sm" mb="lg">
          Delete <strong>{deleteItem?.name}</strong>? This action cannot be undone.
        </Text>
        <Group justify="flex-end">
          <Button variant="default" onClick={() => setDeleteItem(null)}>Cancel</Button>
          <Button color="red" loading={deleting} onClick={confirmDelete}>Delete</Button>
        </Group>
      </Modal>

      <CreateCampaignModal
        opened={campaignModal}
        onClose={() => setCampaignModal(false)}
        agents={agents}
        models={models}
        probes={probes}
        onSaved={(c) => { void loadAll(); if (c?.id) router.push(`/dashboard/redteam/campaigns/${c.id}`); }}
      />

      <RunScanModal
        opened={scanCampaign !== null}
        campaign={scanCampaign}
        probes={probes}
        models={models}
        onClose={() => setScanCampaign(null)}
        onStarted={(runId) => router.push(`/dashboard/redteam/runs/${runId}`)}
      />

      <CreateCustomProbeModal
        opened={probeModal}
        editing={editingProbe}
        onClose={() => { setProbeModal(false); setEditingProbe(null); }}
        onSaved={() => { void loadAll(); }}
      />

      <Modal opened={deleteProbe !== null} onClose={() => setDeleteProbe(null)} title="Delete custom probe" centered size="sm">
        <Text size="sm" mb="lg">
          Delete <strong>{deleteProbe?.name}</strong>? Campaigns referencing it will fail until the reference is removed.
        </Text>
        <Group justify="flex-end">
          <Button variant="default" onClick={() => setDeleteProbe(null)}>Cancel</Button>
          <Button color="red" loading={deletingProbe} onClick={confirmDeleteProbe}>Delete</Button>
        </Group>
      </Modal>
    </PageContainer>
  );
}
