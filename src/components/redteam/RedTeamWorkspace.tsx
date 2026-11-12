'use client';

/**
 * Red-team workspace — renders one sub-section (campaigns / runs / api). Scans
 * run asynchronously on the queue, so triggering one returns a pending run and
 * the workspace polls while any run is pending/running.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Badge, Button, Group, List, Modal, Select, Stack, Switch, Tabs, Text } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useDeleteResource } from '@/components/common/confirm';
import { useTranslations } from '@/lib/i18n';
import {
  IconBug,
  IconCopy,
  IconDownload,
  IconEye,
  IconFileImport,
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
import AgentWithVersion from '@/components/agents/AgentWithVersion';
import { configVersionTag, runVersionTag } from '@/components/agents/agentVersionTag';
import { AGENT_TEST_ACCESS_HINT, useAgentTestAccess } from '@/components/agents/useAgentTestAccess';
import CreateCampaignModal from '@/components/redteam/CreateCampaignModal';
import CreateCustomProbeModal from '@/components/redteam/CreateCustomProbeModal';
import ImportProbesWizard from '@/components/redteam/ImportProbesWizard';
import RunScanModal from '@/components/redteam/RunScanModal';
import RedTeamApiUsage from '@/components/redteam/RedTeamApiUsage';
import {
  POLL_PAGE_LIMIT,
  appendPage,
  detectionKind,
  exportFileName,
  filterBuiltinProbes,
  inconclusiveReasons,
  isNewProbe,
  mergePolledPage,
  pct,
  probeOriginOf,
  probeSourceLabel,
  toNativeProbe,
  worksWithLabels,
  type DetectionFilter,
  type SourceFilter,
} from '@/components/redteam/helpers';
import { downloadText } from '@/components/redteam/download';
import { runStatusBadgeClass, severityBadgeClass } from '@/components/redteam/severity';
import { exportNativeProbes } from '@/lib/services/redteam/import';
import { OWASP_LLM_CATEGORIES, owaspCategoryLabel } from '@/lib/services/redteam/owasp';
import type {
  BuiltinProbeDefinitionView,
  CustomProbeView,
  DisabledProbeView,
  ProbeCatalogView,
  RedTeamCampaignView,
  RedTeamOverviewView,
  RedTeamRunView,
  SelectOption,
} from '@/components/redteam/types';

export type RedTeamSection = 'campaigns' | 'runs' | 'probes' | 'api';

const RUNS_PAGE = 50;
const RUNS_POLL_LIMIT = Math.min(POLL_PAGE_LIMIT, RUNS_PAGE);
/** What the overview endpoint covers when it does not say: the latest completed scans. */
const DEFAULT_OVERVIEW_WINDOW = 100;

/** A custom probe that campaigns still select: the campaigns that block deleting it. */
interface ProbeInUse {
  probe: { id: string; name: string };
  campaigns: string[];
}

/** The campaign names in a 409 `usedBy` list, whatever shape each entry has. */
function usedByNames(usedBy: unknown): string[] {
  if (!Array.isArray(usedBy)) return [];
  return usedBy.map((u) => {
    if (typeof u === 'string') return u;
    const o = (u ?? {}) as { name?: string; key?: string; id?: string };
    return o.name || o.key || o.id || 'campaign';
  });
}

function fmtDate(value?: string): string {
  if (!value) return '—';
  const d = new Date(value);
  return Number.isFinite(d.getTime()) ? d.toLocaleString() : '—';
}

export default function RedTeamWorkspace({ section }: { section: RedTeamSection }) {
  const router = useRouter();
  const deleteResource = useDeleteResource();
  const tq = useTranslations('common.confirm.qos');
  const [campaigns, setCampaigns] = useState<RedTeamCampaignView[]>([]);
  const [runs, setRuns] = useState<RedTeamRunView[]>([]);
  const [runsTotal, setRunsTotal] = useState<number | null>(null);
  const [loadingMoreRuns, setLoadingMoreRuns] = useState(false);
  const [overview, setOverview] = useState<RedTeamOverviewView | null>(null);
  const [probeInUse, setProbeInUse] = useState<ProbeInUse | null>(null);
  const [forceDeleting, setForceDeleting] = useState(false);
  const runsLoaded = useRef(0);
  const [probes, setProbes] = useState<ProbeCatalogView[]>([]);
  const [disabledProbes, setDisabledProbes] = useState<DisabledProbeView[]>([]);
  const [customProbes, setCustomProbes] = useState<CustomProbeView[]>([]);
  const [agents, setAgents] = useState<SelectOption[]>([]);
  const [models, setModels] = useState<SelectOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [scanCampaign, setScanCampaign] = useState<RedTeamCampaignView | null>(null);
  const { canRunAgentTests } = useAgentTestAccess();

  const [campaignModal, setCampaignModal] = useState(false);
  const [probeModal, setProbeModal] = useState(false);
  const [editingProbe, setEditingProbe] = useState<CustomProbeView | null>(null);
  const [cloneOf, setCloneOf] = useState<BuiltinProbeDefinitionView | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [probeTab, setProbeTab] = useState<'builtin' | 'custom'>('builtin');
  const [sourceFilter, setSourceFilter] = useState<SourceFilter | null>(null);
  const [categoryFilter, setCategoryFilter] = useState<string | null>(null);
  const [severityFilter, setSeverityFilter] = useState<string | null>(null);
  const [targetFilter, setTargetFilter] = useState<'model' | 'agent' | null>(null);
  const [detectionFilter, setDetectionFilter] = useState<DetectionFilter | null>(null);
  const [cloningKey, setCloningKey] = useState<string | null>(null);
  // "Use in campaign" from a built-in probe page arrives as ?newWithProbe=<key>.
  const [campaignProbeKeys, setCampaignProbeKeys] = useState<string[] | undefined>(undefined);

  useEffect(() => {
    try {
      const params = new URLSearchParams(window.location.search);
      if (section === 'probes' && params.get('tab') === 'custom') setProbeTab('custom');
      const withProbe = params.get('newWithProbe');
      if (section === 'campaigns' && withProbe) {
        setCampaignProbeKeys([withProbe]);
        setCampaignModal(true);
        router.replace('/dashboard/redteam');
      }
    } catch {
      // No query string to read.
    }
  }, [section, router]);

  const openClone = async (key: string) => {
    setCloningKey(key);
    try {
      const res = await fetch(`/api/redteam/probes/builtin/${encodeURIComponent(key)}`, { cache: 'no-store' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.probe) throw new Error(data.error || 'Could not load the probe');
      setEditingProbe(null);
      setCloneOf(data.probe as BuiltinProbeDefinitionView);
      setProbeModal(true);
    } catch (err) {
      notifications.show({ title: 'Error', message: err instanceof Error ? err.message : 'Could not load the probe', color: 'red' });
    } finally {
      setCloningKey(null);
    }
  };

  const exportCustomProbe = (p: CustomProbeView) => {
    try {
      downloadText(exportFileName(p.key), exportNativeProbes([toNativeProbe(p)]));
    } catch (err) {
      notifications.show({ title: 'Error', message: err instanceof Error ? err.message : 'Could not export the probe', color: 'red' });
    }
  };

  const applyRuns = (data: { runs?: RedTeamRunView[]; total?: number }, mode: 'replace' | 'append' | 'merge') => {
    const page = data.runs ?? [];
    setRuns((prev) => {
      const next = mode === 'replace' ? page : mode === 'append' ? appendPage(prev, page) : mergePolledPage(prev, page, RUNS_POLL_LIMIT);
      runsLoaded.current = next.length;
      return next;
    });
    setRunsTotal(typeof data.total === 'number' ? data.total : null);
  };

  const loadAll = async () => {
    setRefreshing(true);
    try {
      const [cRes, rRes, pRes, cpRes, aRes, mRes, oRes] = await Promise.all([
        fetch('/api/redteam/campaigns', { cache: 'no-store' }),
        fetch(`/api/redteam/runs?limit=${RUNS_PAGE}`, { cache: 'no-store' }),
        fetch('/api/redteam/probes', { cache: 'no-store' }),
        fetch('/api/redteam/custom-probes', { cache: 'no-store' }),
        fetch('/api/agents', { cache: 'no-store' }),
        fetch('/api/models?category=llm', { cache: 'no-store' }),
        fetch('/api/redteam/overview', { cache: 'no-store' }),
      ]);
      if (cRes.ok) setCampaigns((await cRes.json()).campaigns ?? []);
      if (rRes.ok) applyRuns(await rRes.json(), 'replace');
      if (oRes.ok) setOverview((await oRes.json()).overview ?? null);
      if (pRes.ok) {
        const pData = await pRes.json();
        setProbes(pData.probes ?? []);
        setDisabledProbes(pData.disabledProbes ?? []);
      }
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

  // Re-reads the first page and merges it into the loaded rows, so polling does not drop the pages the person loaded.
  const loadRuns = async () => {
    const res = await fetch(`/api/redteam/runs?limit=${RUNS_POLL_LIMIT}`, { cache: 'no-store' });
    if (res.ok) applyRuns(await res.json(), 'merge');
  };

  const loadMoreRuns = async () => {
    setLoadingMoreRuns(true);
    try {
      const res = await fetch(`/api/redteam/runs?limit=${RUNS_PAGE}&skip=${runsLoaded.current}`, { cache: 'no-store' });
      if (res.ok) applyRuns(await res.json(), 'append');
    } finally {
      setLoadingMoreRuns(false);
    }
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


  const confirmDelete = async (item: { id: string; name: string }) => {
    const done = await deleteResource({
      noun: tq('nouns.redteamCampaign'),
      name: item.name,
      type: 'redteam-campaign',
      id: item.id,
      action: async () => {
        const res = await fetch(`/api/redteam/campaigns/${item.id}`, { method: 'DELETE' });
        if (!res.ok) throw new Error(tq('deleteFailed'));
      },
    });
    if (!done) return;
    notifications.show({ title: 'Deleted', message: `"${item.name}" was deleted`, color: 'red' });
    await loadAll();
  };

  const confirmDeleteProbe = async (item: { id: string; name: string }) => {
    // A thrown error would keep the confirm dialog open, so a "still in use" answer
    // is recorded here and the dialog closes normally; the list of campaigns and
    // the "Delete anyway" choice then come in a dialog of their own.
    let inUse: string[] = [];
    const done = await deleteResource({
      noun: tq('nouns.customProbe'),
      name: item.name,
      type: 'redteam-custom-probe',
      id: item.id,
      extraWarning: 'Campaigns that still select it are listed if there are any.',
      action: async () => {
        const res = await fetch(`/api/redteam/custom-probes/${item.id}`, { method: 'DELETE' });
        if (res.status === 409) {
          const body = await res.json().catch(() => ({}));
          inUse = usedByNames(body.usedBy);
          if (inUse.length > 0) return;
        }
        if (!res.ok) throw new Error(tq('deleteFailed'));
      },
    });
    if (!done) return;
    if (inUse.length > 0) {
      setProbeInUse({ probe: item, campaigns: inUse });
      return;
    }
    notifications.show({ title: 'Deleted', message: `"${item.name}" was deleted`, color: 'red' });
    await loadAll();
  };

  const forceDeleteProbe = async () => {
    if (!probeInUse) return;
    setForceDeleting(true);
    try {
      const res = await fetch(`/api/redteam/custom-probes/${probeInUse.probe.id}?force=true`, { method: 'DELETE' });
      if (!res.ok) throw new Error(tq('deleteFailed'));
      notifications.show({ title: 'Deleted', message: `"${probeInUse.probe.name}" was deleted`, color: 'red' });
      setProbeInUse(null);
      await loadAll();
    } catch (err) {
      notifications.show({ title: 'Error', message: err instanceof Error ? err.message : tq('deleteFailed'), color: 'red' });
    } finally {
      setForceDeleting(false);
    }
  };

  const toggleProbeEnabled = async (probe: CustomProbeView, enabled: boolean) => {
    // Show the new state at once; a failure puts it back.
    setCustomProbes((prev) => prev.map((p) => (p.id === probe.id ? { ...p, enabled } : p)));
    try {
      const res = await fetch(`/api/redteam/custom-probes/${probe.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled }),
      });
      if (!res.ok) throw new Error('Could not change the probe');
    } catch (err) {
      setCustomProbes((prev) => prev.map((p) => (p.id === probe.id ? { ...p, enabled: probe.enabled } : p)));
      notifications.show({ title: 'Error', message: err instanceof Error ? err.message : 'Could not change the probe', color: 'red' });
    }
  };

  // The tiles come from the overview (the latest completed scans), not from the page of scans loaded here,
  // and say which window they cover.
  const windowLabel = `last ${overview?.windowRuns ?? DEFAULT_OVERVIEW_WINDOW} scans`;
  const totalScans = runsTotal ?? runs.length;

  const campaignsCtl = useTableControls(campaigns, {
    searchText: (c) => `${c.name} ${c.key} ${c.targetKind} ${c.agentKey ?? ''} ${c.modelKey ?? ''}`,
    searchPlaceholder: 'Filter by name, key, or target…',
  });
  const runsCtl = useTableControls(runs, {
    searchText: (r) => `${r.campaignKey} ${r.status}`,
    searchPlaceholder: 'Filter by campaign or status…',
  });
  const visibleCustomProbes = useMemo(
    () => (sourceFilter ? customProbes.filter((p) => probeOriginOf(p) === sourceFilter) : customProbes),
    [customProbes, sourceFilter],
  );
  const probesCtl = useTableControls(visibleCustomProbes, {
    searchText: (p) => `${p.name} ${p.key} ${p.category} ${p.severity} ${probeSourceLabel(p)}`,
    searchPlaceholder: 'Filter by name, category, or severity…',
  });
  const builtinProbes = useMemo(
    () =>
      filterBuiltinProbes(probes.filter((p) => !p.custom), {
        category: categoryFilter,
        severity: severityFilter,
        target: targetFilter,
        detection: detectionFilter,
      }),
    [probes, categoryFilter, severityFilter, targetFilter, detectionFilter],
  );
  const builtinCtl = useTableControls(builtinProbes, {
    searchText: (p) => `${p.name} ${p.key} ${p.category} ${p.severity} ${p.technique ?? ''}`,
    searchPlaceholder: 'Filter by name, key, or category…',
  });

  const builtinColumns: DataGridColumn<ProbeCatalogView>[] = [
    { key: 'name', label: 'Name', render: (p) => (
      <div className="ds-col" style={{ gap: 2 }}>
        <Group gap={6} wrap="nowrap">
          <span style={{ fontWeight: 500, color: 'var(--ds-text)' }}>{p.name}</span>
          {isNewProbe(p.addedAt) ? <Badge size="xs" variant="filled" color="teal">NEW</Badge> : null}
          {p.polarity === 'over-refusal' ? <Badge size="xs" variant="light" color="blue">over-refusal</Badge> : null}
        </Group>
        <span className="ds-faint ds-mono" style={{ fontSize: 11 }}>{p.key}</span>
      </div>
    ) },
    { key: 'category', label: 'OWASP category (2025)', render: (p) => <span className="ds-muted" style={{ fontSize: 12 }}>{owaspCategoryLabel(p.category)}</span> },
    { key: 'severity', label: 'Severity', render: (p) => <span className={severityBadgeClass(p.severity)}>{p.severity}</span> },
    { key: 'works', label: 'Works with', render: (p) => (
      <Group gap={4}>
        {worksWithLabels(p).map((l) => <span key={l} className="ds-badge">{l}</span>)}
      </Group>
    ) },
    { key: 'attempts', label: 'Attempts', render: (p) => <span>{p.attemptCount ?? '—'}</span> },
    { key: 'detection', label: 'Detection', render: (p) => {
      const kind = detectionKind(p.detectors);
      return <span className="ds-faint" style={{ fontSize: 12 }}>{kind === 'unknown' ? '—' : kind === 'both' ? 'deterministic + judge' : kind}</span>;
    } },
  ];

  const campaignColumns: DataGridColumn<RedTeamCampaignView>[] = [
    { key: 'name', label: 'Name', render: (c) => (
      <div className="ds-col" style={{ gap: 2 }}>
        <span style={{ fontWeight: 500, color: 'var(--ds-text)' }}>{c.name}</span>
        <span className="ds-faint ds-mono" style={{ fontSize: 11 }}>{c.key}</span>
      </div>
    ) },
    { key: 'kind', label: 'Target', render: (c) => <span className="ds-badge ds-badge-info">{c.targetKind}</span> },
    { key: 'ref', label: 'Agent / Model', render: (c) => (
      <span className="ds-mono ds-muted" style={{ fontSize: 12 }}>
        {c.targetKind === 'agent' && c.agentKey
          ? <AgentWithVersion name={c.agentKey} tag={configVersionTag(c.agentVersion)} />
          : c.modelKey ?? '—'}
      </span>
    ) },
    { key: 'probes', label: 'Probes', render: (c) => <span>{c.probeKeys.length === 0 ? 'default set' : c.probeKeys.length}</span> },
    { key: 'schedule', label: 'Schedule', render: (c) => (
      c.schedule?.enabled
        ? <span className="ds-badge ds-badge-info ds-mono" title="cron (UTC)">{c.schedule.cron}</span>
        : <span className="ds-faint">manual</span>
    ) },
    { key: 'created', label: 'Created', render: (c) => <span className="ds-faint" style={{ fontSize: 12 }}>{fmtDate(c.createdAt)}</span> },
  ];

  const runColumns: DataGridColumn<RedTeamRunView>[] = [
    { key: 'campaign', label: 'Campaign', render: (r) => <span className="ds-mono" style={{ fontSize: 12 }}>{r.campaignKey}</span> },
    { key: 'status', label: 'Status', render: (r) => <span className={runStatusBadgeClass(r.status)}>{r.status}</span> },
    { key: 'asr', label: 'Attack success', render: (r) => (
      <Group gap={4} wrap="nowrap">
        <span>{r.aggregate ? pct(r.aggregate.attackSuccessRate) : '—'}</span>
        {inconclusiveReasons(r.aggregate).length > 0 ? <span className="ds-badge ds-badge-warn" title="Do not rely on this scan's rates">inconclusive</span> : null}
      </Group>
    ) },
    { key: 'vuln', label: 'Vulnerable', render: (r) => (
      <span className={r.aggregate && r.aggregate.vulnerable > 0 ? 'ds-badge ds-badge-err' : ''}>
        {r.aggregate ? r.aggregate.vulnerable : '—'}
      </span>
    ) },
    { key: 'review', label: 'Needs review', render: (r) => <span>{r.aggregate ? r.aggregate.needsReview : '—'}</span> },
    { key: 'agent', label: 'Agent', render: (r) => (
      r.targetKind === 'agent'
        ? (
          <span className="ds-mono ds-muted" style={{ fontSize: 12 }}>
            <AgentWithVersion name={r.targetRef} tag={runVersionTag(r.agentRevision)} />
          </span>
        )
        : <span className="ds-faint">—</span>
    ) },
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
    { key: 'category', label: 'OWASP category (2025)', render: (p) => <span className="ds-muted" style={{ fontSize: 12 }}>{owaspCategoryLabel(p.category)}</span> },
    { key: 'severity', label: 'Severity', render: (p) => <span className={severityBadgeClass(p.severity)}>{p.severity}</span> },
    { key: 'source', label: 'Source', render: (p) => <span className="ds-faint" style={{ fontSize: 12 }}>{probeSourceLabel(p)}</span> },
    { key: 'attempts', label: 'Attempts', render: (p) => <span>{p.attempts.length}</span> },
    { key: 'detectors', label: 'Detectors', render: (p) => {
      const parts: string[] = [];
      if (p.detectors.refusal) parts.push('refusal');
      if (p.detectors.pattern) parts.push('pattern');
      if (p.detectors.named?.length) parts.push(`${p.detectors.named.length} named`);
      if (p.detectors.judges?.length) parts.push(`${p.detectors.judges.length} judge`);
      return <span className="ds-faint" style={{ fontSize: 12 }}>{parts.join(' · ') || '—'}</span>;
    } },
    { key: 'enabled', label: 'Enabled', render: (p) => (
      // The row opens the editor on click; the switch must not.
      <span role="presentation" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
        <Switch
          size="xs"
          checked={p.enabled !== false}
          onChange={(e) => void toggleProbeEnabled(p, e.currentTarget.checked)}
          aria-label={`${p.enabled === false ? 'Enable' : 'Disable'} ${p.name}`}
        />
      </span>
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
        <Group gap="xs">
          <Button variant="default" size="sm" leftSection={<IconFileImport size={14} stroke={1.7} />} onClick={() => setImportOpen(true)}>
            Import from file
          </Button>
          <Button color="teal" size="sm" leftSection={<IconPlus size={14} stroke={1.7} />} onClick={() => { setEditingProbe(null); setCloneOf(null); setProbeModal(true); }}>
            New custom probe
          </Button>
        </Group>
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
        <StatTile label="Scans" icon={<IconPlayerPlay size={14} stroke={1.7} />} value={totalScans} />
        <StatTile label={`Vulnerabilities · ${windowLabel}`} icon={<IconShieldCheck size={14} stroke={1.7} />} value={overview ? overview.vulnerable : '—'} />
        <StatTile label={`Resilience · ${windowLabel}`} value={overview ? pct(overview.resilienceScore) : '—'} />
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
              // Scanning an agent needs Write on Agents; the server refuses it otherwise.
              disabled: c.targetKind === 'agent' && !canRunAgentTests,
              disabledReason: AGENT_TEST_ACCESS_HINT,
              onClick: () => setScanCampaign(c),
            },
            { id: 'open', label: 'Open', icon: <IconPencil size={14} />, onClick: () => router.push(`/dashboard/redteam/campaigns/${c.id}`) },
            { divider: true },
            { id: 'delete', label: 'Delete', icon: <IconTrash size={14} />, color: 'red', onClick: () => void confirmDelete({ id: c.id, name: c.name }) },
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

      {section === 'runs' && runs.length < totalScans ? (
        <Group justify="center" mt="sm">
          <Text size="xs" c="dimmed">{runs.length} of {totalScans} scans</Text>
          <Button variant="default" size="xs" loading={loadingMoreRuns} onClick={() => void loadMoreRuns()}>Load more</Button>
        </Group>
      ) : null}

      {section === 'probes' && (
        <Tabs value={probeTab} onChange={(v) => setProbeTab(v === 'custom' ? 'custom' : 'builtin')} mb="md" keepMounted={false}>
          <Tabs.List>
            <Tabs.Tab value="builtin">Built-in ({probes.filter((p) => !p.custom).length})</Tabs.Tab>
            <Tabs.Tab value="custom">Custom ({customProbes.length})</Tabs.Tab>
          </Tabs.List>
        </Tabs>
      )}

      {section === 'probes' && probeTab === 'builtin' && (
        <>
          <Group gap="xs" mb="sm" align="flex-end">
            <Select
              size="xs"
              label="OWASP category"
              placeholder="All"
              clearable
              w={240}
              data={OWASP_LLM_CATEGORIES.map((c) => ({ value: c, label: owaspCategoryLabel(c) }))}
              value={categoryFilter}
              onChange={setCategoryFilter}
            />
            <Select
              size="xs"
              label="Severity"
              placeholder="All"
              clearable
              w={120}
              data={['critical', 'high', 'medium', 'low'].map((s) => ({ value: s, label: s }))}
              value={severityFilter}
              onChange={setSeverityFilter}
            />
            <Select
              size="xs"
              label="Target"
              placeholder="All"
              clearable
              w={120}
              data={[{ value: 'model', label: 'Model' }, { value: 'agent', label: 'Agent' }]}
              value={targetFilter}
              onChange={(v) => setTargetFilter(v === 'model' || v === 'agent' ? v : null)}
            />
            <Select
              size="xs"
              label="Detection"
              placeholder="All"
              clearable
              w={160}
              data={[{ value: 'deterministic', label: 'Deterministic' }, { value: 'judge', label: 'Uses a judge' }]}
              value={detectionFilter}
              onChange={(v) => setDetectionFilter(v === 'deterministic' || v === 'judge' ? v : null)}
            />
          </Group>
          <DataGrid<ProbeCatalogView>
            records={builtinCtl.records}
            loading={loading}
            rowKey={(p) => p.key}
            columns={builtinColumns}
            search={builtinCtl.search}
            pagination={builtinCtl.pagination}
            footerLeft={builtinCtl.footerLeft('built-in probes')}
            onRefresh={loadAll}
            refreshing={refreshing}
            onRowClick={(p) => router.push(`/dashboard/redteam/probes/builtin/${encodeURIComponent(p.key)}`)}
            empty={{
              icon: <IconBug size={26} stroke={1.7} />,
              title: 'No built-in probes match',
              description: 'Change the filters to see more of the built-in library.',
            }}
            rowActions={(p) => [
              { id: 'view', label: 'View', icon: <IconEye size={14} />, onClick: () => router.push(`/dashboard/redteam/probes/builtin/${encodeURIComponent(p.key)}`) },
              {
                id: 'clone',
                label: 'Clone',
                icon: <IconCopy size={14} />,
                disabled: cloningKey === p.key,
                onClick: () => void openClone(p.key),
              },
            ]}
          />
        </>
      )}

      {section === 'probes' && probeTab === 'custom' && (
        <Group gap="xs" mb="sm" align="flex-end">
          <Select
            size="xs"
            label="Source"
            placeholder="All"
            clearable
            w={160}
            data={[
              { value: 'manual', label: 'Manual' },
              { value: 'clone', label: 'Clone' },
              { value: 'import', label: 'Imported' },
            ]}
            value={sourceFilter}
            onChange={(v) => setSourceFilter(v === 'manual' || v === 'clone' || v === 'import' ? v : null)}
          />
        </Group>
      )}

      {section === 'probes' && probeTab === 'custom' && (
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
          onRowClick={(p) => { setEditingProbe(p); setCloneOf(null); setProbeModal(true); }}
          empty={{
            icon: <IconBug size={26} stroke={1.7} />,
            title: sourceFilter ? 'No custom probes from this source' : 'No custom probes yet',
            description: 'Author your own adversarial probes (attacks + detectors), clone a built-in one, or import a file, to extend the built-in catalog. They become selectable in any campaign.',
            primaryAction: { label: 'New custom probe', icon: <IconPlus size={14} />, onClick: () => { setEditingProbe(null); setCloneOf(null); setProbeModal(true); } },
          }}
          rowActions={(p) => [
            { id: 'edit', label: 'Edit', icon: <IconPencil size={14} />, onClick: () => { setEditingProbe(p); setCloneOf(null); setProbeModal(true); } },
            { id: 'export', label: 'Export YAML', icon: <IconDownload size={14} />, onClick: () => exportCustomProbe(p) },
            { divider: true },
            { id: 'delete', label: 'Delete', icon: <IconTrash size={14} />, color: 'red', onClick: () => void confirmDeleteProbe({ id: p.id, name: p.name }) },
          ]}
        />
      )}

      {section === 'api' && <RedTeamApiUsage campaignKey={campaigns[0]?.key} />}

      <CreateCampaignModal
        opened={campaignModal}
        onClose={() => { setCampaignModal(false); setCampaignProbeKeys(undefined); }}
        agents={agents}
        models={models}
        probes={probes}
        disabledProbes={disabledProbes}
        initialProbeKeys={campaignProbeKeys}
        onSaved={(c) => { void loadAll(); if (c?.id) router.push(`/dashboard/redteam/campaigns/${c.id}`); }}
      />

      <RunScanModal
        opened={scanCampaign !== null}
        campaign={scanCampaign}
        probes={probes}
        disabledProbes={disabledProbes}
        models={models}
        onClose={() => setScanCampaign(null)}
        onStarted={(runId) => router.push(`/dashboard/redteam/runs/${runId}`)}
      />

      <Modal
        opened={probeInUse !== null}
        onClose={() => setProbeInUse(null)}
        title="This probe is in use"
        centered
      >
        {probeInUse ? (
          <Stack gap="md">
            <Text size="sm">
              &ldquo;{probeInUse.probe.name}&rdquo; is selected by these campaigns. If you delete it anyway, they
              keep the reference and their scans note that the probe no longer exists.
            </Text>
            <List size="sm" spacing={2}>
              {probeInUse.campaigns.map((c) => <List.Item key={c}>{c}</List.Item>)}
            </List>
            <Group justify="flex-end">
              <Button variant="default" onClick={() => setProbeInUse(null)}>Keep it</Button>
              <Button color="red" loading={forceDeleting} onClick={() => void forceDeleteProbe()}>Delete anyway</Button>
            </Group>
          </Stack>
        ) : null}
      </Modal>

      <CreateCustomProbeModal
        opened={probeModal}
        editing={editingProbe}
        cloneOf={cloneOf}
        onClose={() => { setProbeModal(false); setEditingProbe(null); setCloneOf(null); }}
        onSaved={() => {
          void loadAll();
          if (cloneOf) setProbeTab('custom');
        }}
      />

      <ImportProbesWizard
        opened={importOpen}
        onClose={() => setImportOpen(false)}
        onImported={() => {
          setProbeTab('custom');
          setSourceFilter('import');
          void loadAll();
        }}
      />
    </PageContainer>
  );
}
