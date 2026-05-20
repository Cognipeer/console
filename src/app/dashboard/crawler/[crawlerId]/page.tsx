'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import {
  Badge,
  Button,
  Code,
  Divider,
  Group,
  Modal,
  NumberInput,
  PasswordInput,
  Select,
  Stack,
  Switch,
  Textarea,
  TextInput,
  Title,
} from '@mantine/core';
import { useForm } from '@mantine/form';
import { notifications } from '@mantine/notifications';
import {
  IconArrowLeft,
  IconExternalLink,
  IconPlayerPlay,
  IconPlus,
  IconTrash,
  IconWorld,
} from '@tabler/icons-react';
import PageContainer, { PageHeader } from '@/components/common/ui/PageContainer';
import TabsBar from '@/components/common/ui/TabsBar';
import StatTile from '@/components/common/ui/StatTile';
import StatusBadge from '@/components/common/ui/StatusBadge';
import DataGrid, { type DataGridColumn } from '@/components/common/ui/DataGrid';
import type {
  CrawlerView,
  CrawlJobView,
  CrawlResultView,
} from '@/lib/services/crawler';

interface PlanForm {
  name: string;
  description: string;
  engine: 'axios' | 'playwright' | 'auto';
  maxDepth: number;
  maxPages: number;
  autoCrawl: boolean;
  sameDomainOnly: boolean;
  includeSubdomains: boolean;
  allowList: string;
  blockList: string;
}

interface HttpForm {
  userAgent: string;
  acceptLanguage: string;
  timeoutMs: number;
  maxConcurrency: number;
  bearerToken: string;
  basicUsername: string;
  basicPassword: string;
  headers: string;
  cookies: string;
  allowPrivateNetwork: boolean;
}

interface IntegrationForm {
  ragEnabled: boolean;
  ragModuleKey: string;
  webhookEnabled: boolean;
  webhookUrl: string;
  webhookSecret: string;
  webhookEventPage: boolean;
  webhookEventCompleted: boolean;
  webhookEventFailed: boolean;
}

interface ScheduleForm {
  enabled: boolean;
  mode: 'interval' | 'cron';
  intervalSeconds: number;
  cron: string;
}

type TabId = 'overview' | 'urls' | 'plan' | 'http' | 'integration' | 'schedule' | 'runs';

export default function CrawlerDetailPage() {
  const router = useRouter();
  const params = useParams<{ crawlerId: string }>();
  const crawlerId = params.crawlerId;

  const [crawler, setCrawler] = useState<CrawlerView | null>(null);
  const [jobs, setJobs] = useState<CrawlJobView[]>([]);
  const [ragModules, setRagModules] = useState<Array<{ key: string; name: string }>>([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<TabId>('overview');
  const [savingPlan, setSavingPlan] = useState(false);
  const [savingHttp, setSavingHttp] = useState(false);
  const [savingIntegration, setSavingIntegration] = useState(false);
  const [savingSchedule, setSavingSchedule] = useState(false);
  const [running, setRunning] = useState(false);
  const [newUrl, setNewUrl] = useState('');
  const [singleCrawlUrl, setSingleCrawlUrl] = useState('');
  const [openJob, setOpenJob] = useState<CrawlJobView | null>(null);
  const [jobResults, setJobResults] = useState<CrawlResultView[]>([]);
  const [resultsLoading, setResultsLoading] = useState(false);
  const [openResult, setOpenResult] = useState<CrawlResultView | null>(null);

  const planForm = useForm<PlanForm>({
    initialValues: {
      name: '',
      description: '',
      engine: 'auto',
      maxDepth: 0,
      maxPages: 50,
      autoCrawl: false,
      sameDomainOnly: true,
      includeSubdomains: false,
      allowList: '',
      blockList: '',
    },
  });

  const httpForm = useForm<HttpForm>({
    initialValues: {
      userAgent: '',
      acceptLanguage: '',
      timeoutMs: 30000,
      maxConcurrency: 5,
      bearerToken: '',
      basicUsername: '',
      basicPassword: '',
      headers: '',
      cookies: '',
      allowPrivateNetwork: false,
    },
  });

  const intForm = useForm<IntegrationForm>({
    initialValues: {
      ragEnabled: false,
      ragModuleKey: '',
      webhookEnabled: false,
      webhookUrl: '',
      webhookSecret: '',
      webhookEventPage: true,
      webhookEventCompleted: true,
      webhookEventFailed: true,
    },
  });

  const schedForm = useForm<ScheduleForm>({
    initialValues: {
      enabled: false,
      mode: 'interval',
      intervalSeconds: 3600,
      cron: '0 * * * *',
    },
  });

  /**
   * One-shot fetch for the crawler config. Resets every form to the latest
   * persisted values. Called ONLY on initial mount and after the user saves
   * — never from the polling loop, which would clobber in-progress edits.
   */
  const loadCrawler = useCallback(async () => {
    try {
      const res = await fetch(`/api/crawler/crawlers/${crawlerId}`, { cache: 'no-store' });
      if (!res.ok) throw new Error('Crawler not found');
      const data = await res.json();
      const c = data.crawler as CrawlerView;
      setCrawler(c);

      planForm.setValues({
        name: c.name,
        description: c.description ?? '',
        engine: c.engine,
        maxDepth: c.maxDepth,
        maxPages: c.maxPages,
        autoCrawl: c.autoCrawl,
        sameDomainOnly: c.scope.sameDomainOnly,
        includeSubdomains: c.scope.includeSubdomains,
        allowList: (c.scope.allowList ?? []).join('\n'),
        blockList: (c.scope.blockList ?? []).join('\n'),
      });

      httpForm.setValues({
        userAgent: c.http.userAgent ?? '',
        acceptLanguage: c.http.acceptLanguage ?? '',
        timeoutMs: c.http.timeoutMs ?? 30000,
        maxConcurrency: c.http.maxConcurrency ?? 5,
        bearerToken: c.http.bearerToken ?? '',
        basicUsername: c.http.basicAuth?.username ?? '',
        basicPassword: c.http.basicAuth?.password ?? '',
        headers: c.http.headers ? JSON.stringify(c.http.headers, null, 2) : '',
        cookies: c.http.cookies ? JSON.stringify(c.http.cookies, null, 2) : '',
        allowPrivateNetwork: c.http.allowPrivateNetwork ?? false,
      });

      intForm.setValues({
        ragEnabled: c.rag?.enabled ?? false,
        ragModuleKey: c.rag?.ragModuleKey ?? '',
        webhookEnabled: Boolean(c.webhook?.url),
        webhookUrl: c.webhook?.url ?? '',
        webhookSecret: c.webhook?.secret ?? '',
        webhookEventPage: c.webhook?.events?.includes('page') ?? true,
        webhookEventCompleted: c.webhook?.events?.includes('completed') ?? true,
        webhookEventFailed: c.webhook?.events?.includes('failed') ?? true,
      });

      schedForm.setValues({
        enabled: c.schedule?.enabled ?? false,
        mode: c.schedule?.mode ?? 'interval',
        intervalSeconds: c.schedule?.intervalSeconds ?? 3600,
        cron: c.schedule?.cron ?? '0 * * * *',
      });
    } catch (err) {
      notifications.show({
        color: 'red',
        title: 'Error',
        message: err instanceof Error ? err.message : 'Failed',
      });
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [crawlerId]);

  /**
   * Polled separately from `loadCrawler`. Touches ONLY the jobs list — does
   * NOT mutate form state so a user editing the RAG / Webhook / Schedule
   * panels while a job is running won't see their toggles reset.
   */
  const loadJobs = useCallback(async () => {
    try {
      const res = await fetch(`/api/crawler/jobs?limit=50`, { cache: 'no-store' });
      if (!res.ok) return;
      const data = await res.json();
      const list = (data.jobs ?? []) as CrawlJobView[];
      setJobs((prev) => {
        // Filter to this crawler. Use crawler from state if available; else
        // accept all (first load before crawler is set will be replaced on next tick).
        const current = crawler;
        if (!current) return prev;
        return list.filter((j) => j.crawlerKey === current.key);
      });
    } catch {
      // Network errors during polling are non-fatal; the next tick retries.
    }
  }, [crawler]);

  const loadRagModules = useCallback(async () => {
    try {
      const res = await fetch('/api/rag/modules?status=active', { cache: 'no-store' });
      if (!res.ok) return;
      const data = await res.json();
      const modules = (data.modules ?? []) as Array<{ key: string; name: string }>;
      setRagModules(modules.map((m) => ({ key: m.key, name: m.name })));
    } catch {
      // Non-fatal — Select will just be empty.
    }
  }, []);

  // Initial load: crawler config + jobs list + available RAG modules.
  useEffect(() => {
    void loadCrawler();
    void loadRagModules();
  }, [loadCrawler, loadRagModules]);

  // Once we know the crawler, load jobs for it.
  useEffect(() => {
    if (!crawler) return;
    void loadJobs();
  }, [crawler, loadJobs]);

  // Polling for live job status — does NOT touch the form.
  useEffect(() => {
    if (!crawler) return;
    const hasActive = jobs.some(
      (j) => j.status === 'queued' || j.status === 'running',
    );
    if (!hasActive) return;
    const id = setInterval(() => {
      void loadJobs();
    }, 2000);
    return () => clearInterval(id);
  }, [crawler, jobs, loadJobs]);

  const summary = useMemo(() => {
    const last = jobs[0];
    const succeeded = jobs.filter((j) => j.status === 'succeeded').length;
    const totalPages = jobs.reduce((acc, j) => acc + (j.pagesProcessed ?? 0), 0);
    return {
      totalRuns: jobs.length,
      succeeded,
      urlCount: crawler?.seeds?.length ?? 0,
      totalPages,
      last,
    };
  }, [jobs, crawler]);

  function parseRecord(value: string): Record<string, unknown> | undefined {
    if (!value.trim()) return undefined;
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : undefined;
    } catch {
      throw new Error('Invalid JSON');
    }
  }

  function parseArray(value: string): unknown[] | undefined {
    if (!value.trim()) return undefined;
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : undefined;
    } catch {
      throw new Error('Invalid JSON');
    }
  }

  async function savePlan(values: PlanForm) {
    setSavingPlan(true);
    try {
      const res = await fetch(`/api/crawler/crawlers/${crawlerId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: values.name,
          description: values.description || undefined,
          engine: values.engine,
          maxDepth: values.maxDepth,
          maxPages: values.maxPages,
          autoCrawl: values.autoCrawl,
          scope: {
            sameDomainOnly: values.sameDomainOnly,
            includeSubdomains: values.includeSubdomains,
            allowList: values.allowList.split('\n').map((s) => s.trim()).filter(Boolean),
            blockList: values.blockList.split('\n').map((s) => s.trim()).filter(Boolean),
          },
        }),
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(text || 'Failed to save');
      }
      notifications.show({ color: 'teal', title: 'Saved', message: 'Plan updated' });
      await loadCrawler();
    } catch (err) {
      notifications.show({
        color: 'red',
        title: 'Error',
        message: err instanceof Error ? err.message : 'Failed',
      });
    } finally {
      setSavingPlan(false);
    }
  }

  async function saveHttp(values: HttpForm) {
    setSavingHttp(true);
    try {
      let headers: Record<string, unknown> | undefined;
      let cookies: unknown[] | undefined;
      try {
        headers = parseRecord(values.headers);
        cookies = parseArray(values.cookies);
      } catch {
        notifications.show({
          color: 'red',
          title: 'Invalid JSON',
          message: 'Headers / cookies must be valid JSON',
        });
        setSavingHttp(false);
        return;
      }

      const http: Record<string, unknown> = {
        userAgent: values.userAgent || undefined,
        acceptLanguage: values.acceptLanguage || undefined,
        timeoutMs: values.timeoutMs,
        maxConcurrency: values.maxConcurrency,
        bearerToken: values.bearerToken || undefined,
        allowPrivateNetwork: values.allowPrivateNetwork,
        headers,
        cookies,
      };
      if (values.basicUsername || values.basicPassword) {
        http.basicAuth = {
          username: values.basicUsername,
          password: values.basicPassword,
        };
      }

      const res = await fetch(`/api/crawler/crawlers/${crawlerId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ http }),
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(text || 'Failed to save');
      }
      notifications.show({ color: 'teal', title: 'Saved', message: 'HTTP settings updated' });
      await loadCrawler();
    } catch (err) {
      notifications.show({
        color: 'red',
        title: 'Error',
        message: err instanceof Error ? err.message : 'Failed',
      });
    } finally {
      setSavingHttp(false);
    }
  }

  async function saveIntegration(values: IntegrationForm) {
    setSavingIntegration(true);
    try {
      const body: Record<string, unknown> = {
        rag: values.ragEnabled
          ? { ragModuleKey: values.ragModuleKey, enabled: true }
          : null,
        webhook: values.webhookEnabled && values.webhookUrl
          ? {
              url: values.webhookUrl,
              secret: values.webhookSecret || undefined,
              events: [
                ...(values.webhookEventPage ? ['page'] : []),
                ...(values.webhookEventCompleted ? ['completed'] : []),
                ...(values.webhookEventFailed ? ['failed'] : []),
              ],
            }
          : null,
      };
      const res = await fetch(`/api/crawler/crawlers/${crawlerId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(text || 'Failed to save');
      }
      notifications.show({ color: 'teal', title: 'Saved', message: 'Integration updated' });
      await loadCrawler();
    } catch (err) {
      notifications.show({
        color: 'red',
        title: 'Error',
        message: err instanceof Error ? err.message : 'Failed',
      });
    } finally {
      setSavingIntegration(false);
    }
  }

  async function saveSchedule(values: ScheduleForm) {
    setSavingSchedule(true);
    try {
      const body: Record<string, unknown> = {
        schedule: values.enabled
          ? {
              mode: values.mode,
              enabled: true,
              ...(values.mode === 'interval'
                ? { intervalSeconds: values.intervalSeconds }
                : { cron: values.cron }),
            }
          : null,
      };
      const res = await fetch(`/api/crawler/crawlers/${crawlerId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(text || 'Failed to save schedule');
      }
      notifications.show({ color: 'teal', title: 'Saved', message: 'Schedule updated' });
      await loadCrawler();
    } catch (err) {
      notifications.show({
        color: 'red',
        title: 'Error',
        message: err instanceof Error ? err.message : 'Failed',
      });
    } finally {
      setSavingSchedule(false);
    }
  }

  async function addUrls(rawInput: string) {
    const urls = rawInput
      .split(/[\s\n]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (urls.length === 0) return;
    try {
      const res = await fetch(`/api/crawler/crawlers/${crawlerId}/urls`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ urls }),
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(text || 'Failed to add');
      }
      notifications.show({
        color: 'teal',
        title: 'Added',
        message: `${urls.length} URL${urls.length === 1 ? '' : 's'} added`,
      });
      setNewUrl('');
      await loadCrawler();
    } catch (err) {
      notifications.show({
        color: 'red',
        title: 'Error',
        message: err instanceof Error ? err.message : 'Failed',
      });
    }
  }

  async function removeUrl(url: string) {
    try {
      const res = await fetch(`/api/crawler/crawlers/${crawlerId}/urls`, {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ urls: [url] }),
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(text || 'Failed to remove');
      }
      await loadCrawler();
    } catch (err) {
      notifications.show({
        color: 'red',
        title: 'Error',
        message: err instanceof Error ? err.message : 'Failed',
      });
    }
  }

  async function runAll() {
    setRunning(true);
    try {
      const res = await fetch(`/api/crawler/crawlers/${crawlerId}/run`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(text || 'Failed to run');
      }
      notifications.show({
        color: 'teal',
        title: 'Run started',
        message: 'Crawl job queued',
      });
      await loadJobs();
      setActiveTab('runs');
    } catch (err) {
      notifications.show({
        color: 'red',
        title: 'Error',
        message: err instanceof Error ? err.message : 'Failed',
      });
    } finally {
      setRunning(false);
    }
  }

  async function runOne(url: string) {
    try {
      const res = await fetch(`/api/crawler/crawlers/${crawlerId}/crawl`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ urls: [url] }),
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(text || 'Failed to crawl');
      }
      notifications.show({
        color: 'teal',
        title: 'Run started',
        message: `Crawling ${url}`,
      });
      await loadJobs();
      setActiveTab('runs');
    } catch (err) {
      notifications.show({
        color: 'red',
        title: 'Error',
        message: err instanceof Error ? err.message : 'Failed',
      });
    }
  }

  async function openJobModal(job: CrawlJobView) {
    setOpenJob(job);
    setResultsLoading(true);
    setJobResults([]);
    try {
      if (!job.id) {
        throw new Error('Job is missing its id (data not serialized correctly)');
      }
      const res = await fetch(
        `/api/crawler/jobs/${job.id}/results?limit=200`,
        { cache: 'no-store' },
      );
      if (!res.ok) {
        const text = await res.text();
        throw new Error(text || `Server returned ${res.status}`);
      }
      const data = await res.json();
      setJobResults(data.results ?? []);
    } catch (err) {
      notifications.show({
        color: 'red',
        title: 'Failed to load results',
        message: err instanceof Error ? err.message : 'Failed',
      });
    } finally {
      setResultsLoading(false);
    }
  }

  if (loading) {
    return <PageContainer><div>Loading…</div></PageContainer>;
  }
  if (!crawler) {
    return (
      <PageContainer>
        <PageHeader title="Crawler not found" />
        <Button leftSection={<IconArrowLeft size={14} />} onClick={() => router.push('/dashboard/crawler')}>
          Back to crawlers
        </Button>
      </PageContainer>
    );
  }

  const urls = crawler.seeds ?? [];

  const jobColumns: DataGridColumn<CrawlJobView>[] = [
    {
      key: 'status',
      label: 'Status',
      render: (j) => <StatusBadge status={statusToBadge(j.status)} />,
    },
    {
      key: 'startedAt',
      label: 'Started',
      render: (j) => (
        <span className="ds-mono ds-muted" style={{ fontSize: 12 }}>
          {j.startedAt
            ? new Date(j.startedAt).toLocaleString()
            : new Date(j.createdAt ?? Date.now()).toLocaleString()}
        </span>
      ),
    },
    {
      key: 'pages',
      label: 'Pages',
      render: (j) => <span className="ds-mono">{j.pagesProcessed}</span>,
    },
    {
      key: 'files',
      label: 'Files',
      render: (j) => <span className="ds-mono">{j.filesProcessed}</span>,
    },
    {
      key: 'errors',
      label: 'Errors',
      render: (j) => (
        <span className="ds-mono" style={{ color: j.errorsCount > 0 ? 'var(--ds-err)' : undefined }}>
          {j.errorsCount}
        </span>
      ),
    },
    {
      key: 'duration',
      label: 'Duration',
      render: (j) => (
        <span className="ds-mono ds-muted" style={{ fontSize: 12 }}>
          {j.durationMs ? `${(j.durationMs / 1000).toFixed(1)}s` : '—'}
        </span>
      ),
    },
    {
      key: 'trigger',
      label: 'Trigger',
      render: (j) => <Badge variant="light" color="gray">{j.trigger}</Badge>,
    },
  ];

  const resultColumns: DataGridColumn<CrawlResultView>[] = [
    {
      key: 'url',
      label: 'URL',
      render: (r) => (
        <span style={{ maxWidth: 360, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'inline-block' }} title={r.url}>
          {r.url}
        </span>
      ),
    },
    { key: 'depth', label: 'Depth', render: (r) => <span className="ds-mono">{r.depth}</span> },
    { key: 'type', label: 'Type', render: (r) => <span className="ds-mono ds-muted">{r.type}</span> },
    {
      key: 'rag',
      label: 'RAG',
      render: (r) =>
        r.ragStatus
          ? <Badge variant="light" color={r.ragStatus === 'indexed' ? 'teal' : r.ragStatus === 'failed' ? 'red' : 'gray'}>{r.ragStatus}</Badge>
          : <span className="ds-faint">—</span>,
    },
    {
      key: 'bytes',
      label: 'Bytes',
      render: (r) => <span className="ds-mono ds-muted">{r.bytes ?? '—'}</span>,
    },
  ];

  return (
    <PageContainer>
      <PageHeader
        eyebrow={`Data · Crawlers · ${crawler.key}`}
        title={crawler.name}
        subtitle={crawler.description || 'Crawler container — add URLs and run them with this profile’s engine / HTTP / RAG / webhook config.'}
        actions={
          <Group gap="xs">
            <Button
              variant="default"
              size="sm"
              leftSection={<IconArrowLeft size={14} />}
              onClick={() => router.push('/dashboard/crawler')}
            >
              Back
            </Button>
            <Button
              color="teal"
              size="sm"
              leftSection={<IconPlayerPlay size={14} />}
              onClick={runAll}
              loading={running}
              disabled={crawler.status !== 'active' || urls.length === 0}
            >
              Run all ({urls.length})
            </Button>
          </Group>
        }
      />

      <div className="ds-stat-grid" style={{ marginBottom: 16 }}>
        <StatTile
          label="Status"
          icon={<IconWorld size={14} stroke={1.7} />}
          value={crawler.status === 'active' ? 'Active' : 'Disabled'}
        />
        <StatTile label="URLs" value={summary.urlCount} />
        <StatTile label="Total runs" value={summary.totalRuns} />
        <StatTile
          label="Schedule"
          value={crawler.schedule?.enabled
            ? (crawler.schedule.mode === 'cron'
              ? `cron: ${crawler.schedule.cron}`
              : `every ${crawler.schedule.intervalSeconds}s`)
            : 'manual'}
        />
      </div>

      <TabsBar
        items={[
          { id: 'overview', label: 'Overview' },
          { id: 'urls', label: 'URLs', count: summary.urlCount },
          { id: 'plan', label: 'Engine' },
          { id: 'http', label: 'HTTP' },
          { id: 'integration', label: 'RAG + Webhook' },
          { id: 'schedule', label: 'Schedule' },
          { id: 'runs', label: 'Runs', count: jobs.length },
        ]}
        activeId={activeTab}
        onChange={(id) => setActiveTab(id as TabId)}
      />

      <div style={{ marginTop: 16 }}>
        {activeTab === 'overview' && (
          <Stack>
            <Title order={5}>Last run</Title>
            {summary.last ? (
              <Stack gap={4}>
                <Group gap="xs">
                  <StatusBadge status={statusToBadge(summary.last.status)} />
                  <span className="ds-mono ds-muted" style={{ fontSize: 12 }}>
                    {new Date(summary.last.createdAt ?? Date.now()).toLocaleString()}
                  </span>
                </Group>
                <span className="ds-faint" style={{ fontSize: 13 }}>
                  {summary.last.pagesProcessed} pages · {summary.last.filesProcessed} files · {summary.last.errorsCount} errors
                  {summary.last.durationMs ? ` · ${(summary.last.durationMs / 1000).toFixed(1)}s` : ''}
                </span>
              </Stack>
            ) : (
              <span className="ds-faint">No runs yet — add URLs and click <strong>Run all</strong> to kick off the first job.</span>
            )}

            <Divider my="md" />
            <Title order={5}>API quick start</Title>
            <span className="ds-faint" style={{ fontSize: 13 }}>
              Send URLs from an external app and crawl them with this profile&apos;s settings:
            </span>
            <Code block>{`POST /api/client/v1/crawler/crawlers/${crawler.key}/crawl
Authorization: Bearer <api-token>
Content-Type: application/json

{
  "urls": ["https://example.com/page"]
}

# Returns: { "jobId": "...", "status": "queued" }
# Poll /api/client/v1/crawler/jobs/{jobId}/results for markdown.`}</Code>
          </Stack>
        )}

        {activeTab === 'urls' && (
          <Stack>
            <Title order={5}>URLs in this crawler</Title>
            <span className="ds-faint" style={{ fontSize: 13 }}>
              The crawler runs against this list when you click <strong>Run all</strong> or
              when a schedule fires. You can also send URLs directly via API without
              persisting them here.
            </span>

            <Group align="end">
              <TextInput
                label="Add URL"
                placeholder="https://example.com/page"
                value={newUrl}
                onChange={(e) => setNewUrl(e.currentTarget.value)}
                style={{ flexGrow: 1 }}
              />
              <Button
                leftSection={<IconPlus size={14} />}
                onClick={() => void addUrls(newUrl)}
                disabled={!newUrl.trim()}
              >
                Add
              </Button>
            </Group>

            <Textarea
              label="Or paste multiple URLs (one per line)"
              autosize
              minRows={2}
              onBlur={(e) => {
                if (e.currentTarget.value.trim()) {
                  void addUrls(e.currentTarget.value);
                  e.currentTarget.value = '';
                }
              }}
            />

            <Divider my="xs" />

            {urls.length === 0 ? (
              <span className="ds-faint">No URLs yet. Add one above.</span>
            ) : (
              <DataGrid<{ url: string }>
                records={urls.map((url) => ({ url }))}
                rowKey={(r) => r.url}
                columns={[
                  {
                    key: 'url',
                    label: 'URL',
                    render: (r) => (
                      <Group gap="xs" wrap="nowrap">
                        <IconExternalLink size={14} className="ds-muted" />
                        <a
                          href={r.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="ds-mono"
                          style={{ fontSize: 13 }}
                          onClick={(e) => e.stopPropagation()}
                        >
                          {r.url}
                        </a>
                      </Group>
                    ),
                  },
                ]}
                rowActions={(r) => [
                  {
                    id: 'crawl',
                    label: 'Crawl now',
                    icon: <IconPlayerPlay size={14} />,
                    onClick: () => void runOne(r.url),
                  },
                  { divider: true },
                  {
                    id: 'remove',
                    label: 'Remove',
                    icon: <IconTrash size={14} />,
                    color: 'red',
                    onClick: () => void removeUrl(r.url),
                  },
                ]}
                footerLeft={`${urls.length} URL${urls.length === 1 ? '' : 's'}`}
              />
            )}

            <Divider my="md" label="Try an URL without saving it" />
            <Group align="end">
              <TextInput
                label="One-shot crawl"
                description="Crawl this URL with the container's config (engine, HTTP, RAG, webhook) but don't save it to the list."
                placeholder="https://example.com/article"
                value={singleCrawlUrl}
                onChange={(e) => setSingleCrawlUrl(e.currentTarget.value)}
                style={{ flexGrow: 1 }}
              />
              <Button
                leftSection={<IconPlayerPlay size={14} />}
                onClick={async () => {
                  if (!singleCrawlUrl.trim()) return;
                  await runOne(singleCrawlUrl.trim());
                  setSingleCrawlUrl('');
                }}
                disabled={!singleCrawlUrl.trim() || crawler.status !== 'active'}
              >
                Crawl
              </Button>
            </Group>
          </Stack>
        )}

        {activeTab === 'plan' && (
          <form onSubmit={planForm.onSubmit(savePlan)}>
            <Stack>
              <TextInput label="Name" required {...planForm.getInputProps('name')} />
              <Textarea label="Description" autosize minRows={2} {...planForm.getInputProps('description')} />
              <Group grow>
                <Select
                  label="Engine"
                  data={[
                    { value: 'auto', label: 'Auto (axios → playwright fallback)' },
                    { value: 'axios', label: 'Axios only (fast, static)' },
                    { value: 'playwright', label: 'Playwright only (JS-heavy)' },
                  ]}
                  {...planForm.getInputProps('engine')}
                />
                <NumberInput
                  label="Link-follow depth (0–3)"
                  description="0 = only the URLs you provide. >0 = follow in-domain links."
                  min={0}
                  max={3}
                  {...planForm.getInputProps('maxDepth')}
                />
                <NumberInput
                  label="Max pages (0 = unlimited)"
                  min={0}
                  max={5000}
                  {...planForm.getInputProps('maxPages')}
                />
              </Group>
              <Switch
                label="Follow links discovered on each page"
                description="When enabled, the crawler walks links found on each URL up to the depth above."
                {...planForm.getInputProps('autoCrawl', { type: 'checkbox' })}
              />
              <Divider my="xs" label="Scope (when following links)" />
              <Group>
                <Switch label="Same domain only" {...planForm.getInputProps('sameDomainOnly', { type: 'checkbox' })} />
                <Switch label="Include subdomains" {...planForm.getInputProps('includeSubdomains', { type: 'checkbox' })} />
              </Group>
              <Textarea
                label="Allow list (host glob, one per line)"
                description="If non-empty, only hosts matching one of these patterns are crawled."
                autosize
                minRows={2}
                {...planForm.getInputProps('allowList')}
              />
              <Textarea
                label="Block list"
                description="Hosts matching one of these patterns are skipped."
                autosize
                minRows={2}
                {...planForm.getInputProps('blockList')}
              />
              <Group justify="flex-end">
                <Button type="submit" loading={savingPlan}>Save engine settings</Button>
              </Group>
            </Stack>
          </form>
        )}

        {activeTab === 'http' && (
          <form onSubmit={httpForm.onSubmit(saveHttp)}>
            <Stack>
              <TextInput label="User-Agent" placeholder="Leave empty for default" {...httpForm.getInputProps('userAgent')} />
              <TextInput label="Accept-Language" placeholder="en-US,en;q=0.9,tr;q=0.8" {...httpForm.getInputProps('acceptLanguage')} />
              <Group grow>
                <NumberInput label="Timeout (ms)" min={1000} max={120000} {...httpForm.getInputProps('timeoutMs')} />
                <NumberInput label="Max concurrency" min={1} max={16} {...httpForm.getInputProps('maxConcurrency')} />
              </Group>
              <Divider my="xs" label="Auth" />
              <PasswordInput label="Bearer token" {...httpForm.getInputProps('bearerToken')} />
              <Group grow>
                <TextInput label="Basic auth username" {...httpForm.getInputProps('basicUsername')} />
                <PasswordInput label="Basic auth password" {...httpForm.getInputProps('basicPassword')} />
              </Group>
              <Divider my="xs" label="Headers & cookies" />
              <Textarea
                label='Custom headers (JSON: { "X-Foo": "bar" })'
                autosize
                minRows={3}
                {...httpForm.getInputProps('headers')}
              />
              <Textarea
                label='Cookies (JSON array of { name, value, domain?, path? })'
                autosize
                minRows={3}
                {...httpForm.getInputProps('cookies')}
              />
              <Switch
                label="Allow private network (DANGER: disables SSRF guard)"
                {...httpForm.getInputProps('allowPrivateNetwork', { type: 'checkbox' })}
              />
              <Group justify="flex-end">
                <Button type="submit" loading={savingHttp}>Save HTTP settings</Button>
              </Group>
            </Stack>
          </form>
        )}

        {activeTab === 'integration' && (
          <form onSubmit={intForm.onSubmit(saveIntegration)}>
            <Stack>
              <Title order={5}>Knowledge engine (RAG)</Title>
              <Switch label="Ingest fetched pages into a RAG module" {...intForm.getInputProps('ragEnabled', { type: 'checkbox' })} />
              <Select
                label="RAG module"
                description="Each successful page will be ingested into the selected module via ragService."
                placeholder={ragModules.length === 0
                  ? 'No active RAG modules found — create one in the Knowledge Engine page first'
                  : 'Select a RAG module'}
                disabled={!intForm.values.ragEnabled || ragModules.length === 0}
                data={ragModules.map((m) => ({ value: m.key, label: `${m.name} · ${m.key}` }))}
                searchable
                nothingFoundMessage="No matching RAG modules"
                {...intForm.getInputProps('ragModuleKey')}
              />
              <Divider my="md" />
              <Title order={5}>Webhook</Title>
              <Switch label="Send webhook for every page / completion" {...intForm.getInputProps('webhookEnabled', { type: 'checkbox' })} />
              <TextInput
                label="Webhook URL"
                placeholder="https://your.app/hook"
                disabled={!intForm.values.webhookEnabled}
                {...intForm.getInputProps('webhookUrl')}
              />
              <PasswordInput
                label="HMAC secret (optional)"
                description="If set, payloads are signed with X-Cognipeer-Signature."
                disabled={!intForm.values.webhookEnabled}
                {...intForm.getInputProps('webhookSecret')}
              />
              <Group>
                <Switch label="page" disabled={!intForm.values.webhookEnabled} {...intForm.getInputProps('webhookEventPage', { type: 'checkbox' })} />
                <Switch label="completed" disabled={!intForm.values.webhookEnabled} {...intForm.getInputProps('webhookEventCompleted', { type: 'checkbox' })} />
                <Switch label="failed" disabled={!intForm.values.webhookEnabled} {...intForm.getInputProps('webhookEventFailed', { type: 'checkbox' })} />
              </Group>
              <Group justify="flex-end">
                <Button type="submit" loading={savingIntegration}>Save integration</Button>
              </Group>
            </Stack>
          </form>
        )}

        {activeTab === 'schedule' && (
          <form onSubmit={schedForm.onSubmit(saveSchedule)}>
            <Stack>
              <Switch
                label="Schedule recurring runs"
                description="When enabled, the cluster scheduler fires this crawler automatically against its URL list."
                {...schedForm.getInputProps('enabled', { type: 'checkbox' })}
              />
              <Select
                label="Mode"
                disabled={!schedForm.values.enabled}
                data={[
                  { value: 'interval', label: 'Interval (every N seconds)' },
                  { value: 'cron', label: 'Cron expression (UTC)' },
                ]}
                {...schedForm.getInputProps('mode')}
              />
              {schedForm.values.mode === 'interval' ? (
                <NumberInput
                  label="Interval (seconds)"
                  description="Minimum 60 seconds. Use 3600 for hourly, 86400 for daily."
                  min={60}
                  max={86400}
                  disabled={!schedForm.values.enabled}
                  {...schedForm.getInputProps('intervalSeconds')}
                />
              ) : (
                <TextInput
                  label="Cron expression"
                  description="Standard 5-field cron in UTC. Example: '0 */6 * * *' = every 6 hours."
                  placeholder="0 * * * *"
                  disabled={!schedForm.values.enabled}
                  {...schedForm.getInputProps('cron')}
                />
              )}
              {crawler.schedule?.enabled && crawler.schedule.nextRunAt ? (
                <div className="ds-faint" style={{ fontSize: 13 }}>
                  Next run at:{' '}
                  <strong>
                    {new Date(crawler.schedule.nextRunAt).toLocaleString()}
                  </strong>
                  {crawler.schedule.lastRunAt ? (
                    <> · Last run: {new Date(crawler.schedule.lastRunAt).toLocaleString()}</>
                  ) : null}
                </div>
              ) : null}
              <Group justify="flex-end">
                <Button type="submit" loading={savingSchedule}>Save schedule</Button>
              </Group>
            </Stack>
          </form>
        )}

        {activeTab === 'runs' && (
          <DataGrid<CrawlJobView>
            records={jobs}
            rowKey={(j) => j.id}
            onRowClick={(j) => void openJobModal(j)}
            columns={jobColumns}
            onRefresh={loadJobs}
            empty={{
              icon: <IconPlayerPlay size={22} stroke={1.7} />,
              title: 'No runs yet',
              description: 'Click "Run all" or "Crawl now" on a URL to start the first run.',
            }}
            footerLeft={`${jobs.length} run${jobs.length === 1 ? '' : 's'}`}
          />
        )}
      </div>

      <Modal
        opened={openJob !== null}
        onClose={() => { setOpenJob(null); setJobResults([]); setOpenResult(null); }}
        title={openJob ? `Job ${openJob.id.slice(0, 12)}…` : ''}
        size="xl"
      >
        {openJob && (
          <Stack>
            <Group>
              <StatusBadge status={statusToBadge(openJob.status)} />
              <span className="ds-faint">
                {openJob.pagesProcessed} pages · {openJob.filesProcessed} files · {openJob.errorsCount} errors
                {openJob.durationMs ? ` · ${(openJob.durationMs / 1000).toFixed(1)}s` : ''}
              </span>
            </Group>
            {openJob.errorMessage ? (
              <Code block color="red">{openJob.errorMessage}</Code>
            ) : null}
            {resultsLoading ? (
              <span className="ds-faint">Loading results…</span>
            ) : (
              <DataGrid<CrawlResultView>
                records={jobResults}
                rowKey={(r) => r.id}
                onRowClick={(r) => setOpenResult(r)}
                columns={resultColumns}
                empty={{ title: 'No results' }}
              />
            )}
          </Stack>
        )}
      </Modal>

      <Modal
        opened={openResult !== null}
        onClose={() => setOpenResult(null)}
        title={openResult?.url ?? ''}
        size="xl"
      >
        {openResult && (
          <Stack>
            <Group gap="xs">
              <Badge>{openResult.type}</Badge>
              {openResult.httpStatus ? <Badge variant="light">HTTP {openResult.httpStatus}</Badge> : null}
              {openResult.ragStatus ? <Badge color="teal" variant="light">rag: {openResult.ragStatus}</Badge> : null}
            </Group>
            {openResult.errorMessage ? (
              <Code block color="red">{openResult.errorMessage}</Code>
            ) : null}
            {openResult.bodyMarkdown ? (
              <Code block style={{ maxHeight: '60vh', overflow: 'auto' }}>{openResult.bodyMarkdown}</Code>
            ) : (
              <span className="ds-faint">(no markdown body)</span>
            )}
          </Stack>
        )}
      </Modal>
    </PageContainer>
  );
}

function statusToBadge(status: CrawlJobView['status']): string {
  switch (status) {
    case 'succeeded':
      return 'active';
    case 'failed':
      return 'failed';
    case 'partial':
    case 'canceled':
      return 'warn';
    case 'running':
      return 'info';
    default:
      return 'pending';
  }
}
