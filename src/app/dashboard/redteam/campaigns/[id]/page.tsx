'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { Alert, Button, Group, Loader, Menu, Text, Tooltip } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useDeleteResource, ResourceUsageSection } from '@/components/common/confirm';
import { useTranslations } from '@/lib/i18n';
import { IconAlertTriangle, IconDots, IconPencil, IconPlayerPlay, IconShield, IconTrash } from '@tabler/icons-react';
import DetailShell from '@/components/common/ui/DetailShell';
import DataGrid, { type DataGridColumn } from '@/components/common/ui/DataGrid';
import StatTile from '@/components/common/ui/StatTile';
import AgentWithVersion from '@/components/agents/AgentWithVersion';
import { configVersionTag, runVersionTag } from '@/components/agents/agentVersionTag';
import { AGENT_TEST_ACCESS_HINT, useAgentTestAccess } from '@/components/agents/useAgentTestAccess';
import CreateCampaignModal from '@/components/redteam/CreateCampaignModal';
import RunScanModal from '@/components/redteam/RunScanModal';
import { appendPage, inconclusiveReasons, isActiveStatus, mergePolledPage, pct } from '@/components/redteam/helpers';
import { runStatusBadgeClass } from '@/components/redteam/severity';
import type { DisabledProbeView, ProbeCatalogView, RedTeamCampaignView, RedTeamRunView, SelectOption } from '@/components/redteam/types';

const RUNS_PAGE = 50;
const POLL_MS = 4000;

type LoadError = 'not-found' | 'forbidden' | 'error' | null;

function fmtDate(value?: string): string {
  if (!value) return '—';
  const d = new Date(value);
  return Number.isFinite(d.getTime()) ? d.toLocaleString() : '—';
}

export default function RedTeamCampaignDetailPage() {
  const router = useRouter();
  const deleteResource = useDeleteResource();
  const tq = useTranslations('common.confirm.qos');
  const params = useParams<{ id: string }>();
  const id = params?.id;

  const [campaign, setCampaign] = useState<RedTeamCampaignView | null>(null);
  const [runs, setRuns] = useState<RedTeamRunView[]>([]);
  const [runsTotal, setRunsTotal] = useState<number | null>(null);
  const [agents, setAgents] = useState<SelectOption[]>([]);
  const [models, setModels] = useState<SelectOption[]>([]);
  const [probes, setProbes] = useState<ProbeCatalogView[]>([]);
  const [disabledProbes, setDisabledProbes] = useState<DisabledProbeView[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<LoadError>(null);
  // A refresh that fails keeps the last data on screen and only says so.
  const [pollFailed, setPollFailed] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [scanOpen, setScanOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const { canRunAgentTests } = useAgentTestAccess();

  const campaignKey = useRef<string | null>(null);
  const hasData = useRef(false);

  const fetchRuns = useCallback(async (key: string, skip = 0): Promise<boolean> => {
    const res = await fetch(
      `/api/redteam/runs?campaignKey=${encodeURIComponent(key)}&limit=${RUNS_PAGE}${skip ? `&skip=${skip}` : ''}`,
      { cache: 'no-store' },
    );
    if (!res.ok) return false;
    const data = await res.json();
    const page: RedTeamRunView[] = data.runs ?? [];
    setRuns((prev) => (skip ? appendPage(prev, page) : mergePolledPage(prev, page, RUNS_PAGE)));
    setRunsTotal(typeof data.total === 'number' ? data.total : null);
    return true;
  }, []);

  const load = useCallback(async () => {
    if (!id) return;
    try {
      const res = await fetch(`/api/redteam/campaigns/${id}`, { cache: 'no-store' });
      if (res.status === 404) { hasData.current = false; setCampaign(null); setLoadError('not-found'); return; }
      if (res.status === 403) { hasData.current = false; setCampaign(null); setLoadError('forbidden'); return; }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const c: RedTeamCampaignView | null = data.campaign ?? null;
      setCampaign(c);
      if (!c) { setLoadError('not-found'); return; }
      campaignKey.current = c.key;
      hasData.current = true;
      setLoadError(null);
      const ok = await fetchRuns(c.key);
      setPollFailed(!ok);
    } catch {
      if (hasData.current) setPollFailed(true);
      else setLoadError('error');
    } finally {
      setLoading(false);
    }
  }, [id, fetchRuns]);

  useEffect(() => { void load(); }, [load]);

  // Poll the runs while one is pending or running; stop once they have all finished.
  const hasActive = runs.some((r) => isActiveStatus(r.status));
  useEffect(() => {
    if (!hasActive) return;
    const timer = setInterval(() => {
      const key = campaignKey.current;
      if (!key) return;
      void fetchRuns(key).then((ok) => setPollFailed(!ok)).catch(() => setPollFailed(true));
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [hasActive, fetchRuns]);

  const retry = () => {
    setLoading(true);
    setLoadError(null);
    void load();
  };

  const loadMore = async () => {
    const key = campaignKey.current;
    if (!key) return;
    setLoadingMore(true);
    try { await fetchRuns(key, runs.length); } catch { setPollFailed(true); } finally { setLoadingMore(false); }
  };

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
      if (pRes.ok) {
        const pData = await pRes.json();
        setProbes(pData.probes ?? []);
        setDisabledProbes(pData.disabledProbes ?? []);
      }
    })();
  }, []);

  const onDelete = async () => {
    if (!campaign) return;
    const done = await deleteResource({
      noun: tq('nouns.redteamCampaign'),
      name: campaign.name,
      type: 'redteam-campaign',
      id: campaign.id,
      action: async () => {
        const res = await fetch(`/api/redteam/campaigns/${campaign.id}`, { method: 'DELETE' });
        if (!res.ok) throw new Error(tq('deleteFailed'));
      },
    });
    if (!done) return;
    notifications.show({ title: 'Deleted', message: campaign.name, color: 'red' });
    router.push('/dashboard/redteam');
  };

  const runColumns: DataGridColumn<RedTeamRunView>[] = [
    { key: 'status', label: 'Status', render: (r) => <span className={runStatusBadgeClass(r.status)}>{r.status}</span> },
    { key: 'asr', label: 'Attack success', render: (r) => <span>{r.aggregate ? pct(r.aggregate.attackSuccessRate) : '—'}</span> },
    { key: 'vuln', label: 'Vulnerable', render: (r) => <span className={r.aggregate && r.aggregate.vulnerable > 0 ? 'ds-badge ds-badge-err' : ''}>{r.aggregate ? r.aggregate.vulnerable : '—'}</span> },
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
    { key: 'started', label: 'Started', render: (r) => <span className="ds-faint" style={{ fontSize: 12 }}>{fmtDate(r.startedAt ?? r.createdAt)}</span> },
  ];

  if (loading) {
    return <DetailShell backHref="/dashboard/redteam" title="Loading…"><Group justify="center" mt={60}><Loader /></Group></DetailShell>;
  }
  if (loadError === 'forbidden') {
    return (
      <DetailShell backHref="/dashboard/redteam" title="No access">
        <Text c="dimmed" size="sm">You do not have access to this campaign.</Text>
      </DetailShell>
    );
  }
  if (loadError === 'error') {
    return (
      <DetailShell backHref="/dashboard/redteam" title="Could not load the campaign">
        <Alert color="red" variant="light" icon={<IconAlertTriangle size={16} />} title="Something went wrong">
          <Group justify="space-between">
            <Text size="sm">The campaign could not be loaded.</Text>
            <Button size="xs" variant="default" onClick={retry}>Retry</Button>
          </Group>
        </Alert>
      </DetailShell>
    );
  }
  if (!campaign) {
    return (
      <DetailShell backHref="/dashboard/redteam" title="Campaign not found">
        <Text c="dimmed" size="sm">This campaign could not be found.</Text>
      </DetailShell>
    );
  }

  // The latest finished scan whose rates can be trusted: an inconclusive one would show a meaningless 100%.
  const latest = runs.find((r) => r.status === 'completed' && r.aggregate && inconclusiveReasons(r.aggregate).length === 0)?.aggregate;
  const totalRuns = runsTotal ?? runs.length;
  // Scanning an agent needs Write on Agents; the server refuses it otherwise.
  const scanBlocked = campaign.targetKind === 'agent' && !canRunAgentTests;

  return (
    <DetailShell
      backHref="/dashboard/redteam"
      backLabel="Back to campaigns"
      icon={<div className="detail-icon-badge"><IconShield size={18} stroke={1.7} /></div>}
      title={<h1 className="ds-h2" style={{ margin: 0 }}>{campaign.name}</h1>}
      meta={
        <span>
          <span className="ds-mono">{campaign.key}</span> · {campaign.targetKind}{' '}
          <span className="ds-mono">
            {campaign.targetKind === 'agent'
              ? <AgentWithVersion name={campaign.agentKey ?? '—'} tag={configVersionTag(campaign.agentVersion)} />
              : campaign.modelKey}
          </span>
          {campaign.schedule?.enabled ? <> · <span className="ds-badge ds-badge-info ds-mono">{campaign.schedule.cron}</span></> : null}
        </span>
      }
      actions={
        <>
          <Tooltip label={AGENT_TEST_ACCESS_HINT} disabled={!scanBlocked} withArrow multiline w={240}>
            {/* `data-disabled`, not `disabled`: a native one swallows the hover the tooltip needs. */}
            <Button
              color="teal"
              size="sm"
              leftSection={<IconPlayerPlay size={14} />}
              data-disabled={scanBlocked || undefined}
              aria-disabled={scanBlocked || undefined}
              onClick={scanBlocked ? (event) => event.preventDefault() : () => setScanOpen(true)}
            >
              Run scan
            </Button>
          </Tooltip>
          <Menu position="bottom-end" withinPortal>
            <Menu.Target><Button variant="default" size="sm" px={8} aria-label="Campaign actions"><IconDots size={16} /></Button></Menu.Target>
            <Menu.Dropdown>
              <Menu.Item leftSection={<IconPencil size={14} />} onClick={() => setEditing(true)}>Edit</Menu.Item>
              <Menu.Divider />
              <Menu.Item color="red" leftSection={<IconTrash size={14} />} onClick={() => void onDelete()}>Delete</Menu.Item>
            </Menu.Dropdown>
          </Menu>
        </>
      }
    >
      <div className="ds-stat-grid" style={{ marginBottom: 16 }}>
        <StatTile label="Probes" value={campaign.probeKeys.length === 0 ? 'all' : campaign.probeKeys.length} />
        <StatTile label="Scans" value={totalRuns} />
        <StatTile label="Latest vulnerable" value={latest ? latest.vulnerable : '—'} />
        <StatTile label="Latest resilience" value={latest ? pct(latest.resilienceScore) : '—'} />
      </div>

      {campaign.description ? <Text size="sm" c="dimmed" mb="md">{campaign.description}</Text> : null}

      {pollFailed ? (
        <Text size="xs" c="yellow.8" mb="sm" data-testid="redteam-poll-warning">
          Could not refresh the scans just now. Showing the last data.
        </Text>
      ) : null}

      <DataGrid<RedTeamRunView>
        records={runs}
        loading={false}
        rowKey={(r) => r.id}
        columns={runColumns}
        onRowClick={(r) => router.push(`/dashboard/redteam/runs/${r.id}`)}
        footerLeft={`${runs.length} of ${totalRuns} scans`}
        empty={{
          icon: <IconPlayerPlay size={26} stroke={1.7} />,
          title: 'No scans yet',
          description: 'Run a scan to see vulnerability results here.',
          primaryAction: scanBlocked ? undefined : { label: 'Run scan', icon: <IconPlayerPlay size={14} />, onClick: () => setScanOpen(true) },
        }}
      />

      {runs.length < totalRuns ? (
        <Group justify="center" mt="sm">
          <Button variant="default" size="xs" loading={loadingMore} onClick={() => void loadMore()}>Load more</Button>
        </Group>
      ) : null}

      <CreateCampaignModal
        opened={editing}
        editing={campaign}
        onClose={() => setEditing(false)}
        agents={agents}
        models={models}
        probes={probes}
        disabledProbes={disabledProbes}
        onSaved={() => void load()}
      />

      <RunScanModal
        opened={scanOpen}
        campaign={campaign}
        probes={probes}
        disabledProbes={disabledProbes}
        models={models}
        onClose={() => setScanOpen(false)}
        onStarted={(runId) => router.push(`/dashboard/redteam/runs/${runId}`)}
      />

      <div style={{ marginTop: 16 }}>
        <ResourceUsageSection type="redteam-campaign" id={campaign.id} />
      </div>
    </DetailShell>
  );
}
