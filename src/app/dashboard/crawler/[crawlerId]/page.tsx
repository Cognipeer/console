'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams } from 'next/navigation';
import {
  Badge,
  Button,
  Code,
  Divider,
  Group,
  NumberInput,
  PasswordInput,
  Select,
  Stack,
  Switch,
  Textarea,
  TextInput,
  Tooltip,
} from '@mantine/core';
import { useForm } from '@mantine/form';
import { notifications } from '@mantine/notifications';
import {
  IconAlertTriangle,
  IconClock,
  IconExternalLink,
  IconPlayerPlay,
  IconPlus,
  IconTrash,
  IconWorld,
} from '@tabler/icons-react';
import DetailShell, {
  DetailCard,
  DetailTwoCol,
} from '@/components/common/ui/DetailShell';
import StatTile from '@/components/common/ui/StatTile';
import StatusBadge from '@/components/common/ui/StatusBadge';
import DataGrid, { type DataGridColumn } from '@/components/common/ui/DataGrid';
import RunDetailModal from '@/components/crawler/RunDetailModal';
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
  allowInsecureTls: boolean;
  outputFormat: 'markdown' | 'text';
  cleanup: boolean;
  stripDataImages: boolean;
  mainContentOnly: boolean;
  contentSelector: string;
  removeSelectors: string;
  maxBodyChars: number;
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
  const [cancelingJob, setCancelingJob] = useState(false);
  const [jobResults, setJobResults] = useState<CrawlResultView[]>([]);
  const [resultsLoading, setResultsLoading] = useState(false);
  const [jobQuery, setJobQuery] = useState('');
  const [jobStatusFilter, setJobStatusFilter] = useState('all');
  const [jobTriggerFilter, setJobTriggerFilter] = useState('all');

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
      allowInsecureTls: false,
      outputFormat: 'markdown',
      cleanup: true,
      stripDataImages: true,
      mainContentOnly: false,
      contentSelector: '',
      removeSelectors: '',
      maxBodyChars: 0,
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
        allowInsecureTls: c.http.allowInsecureTls ?? false,
        outputFormat: c.markdownOptions?.outputFormat ?? 'markdown',
        cleanup: c.markdownOptions?.cleanup ?? true,
        stripDataImages: c.markdownOptions?.stripDataImages ?? true,
        mainContentOnly: c.markdownOptions?.mainContentOnly ?? false,
        contentSelector: c.markdownOptions?.contentSelector ?? '',
        removeSelectors: (c.markdownOptions?.removeSelectors ?? []).join('\n'),
        maxBodyChars: c.markdownOptions?.maxBodyChars ?? 0,
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

  const filteredJobs = useMemo(() => {
    const q = jobQuery.trim().toLowerCase();
    return jobs.filter((j) => {
      if (jobStatusFilter !== 'all' && j.status !== jobStatusFilter) return false;
      if (jobTriggerFilter !== 'all' && j.trigger !== jobTriggerFilter) return false;
      if (q) {
        const started = j.startedAt ? new Date(j.startedAt).toLocaleString() : '';
        const created = j.createdAt ? new Date(j.createdAt).toLocaleString() : '';
        const hay = `${j.id} ${j.status} ${j.trigger} ${j.errorMessage ?? ''} ${started} ${created}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [jobs, jobQuery, jobStatusFilter, jobTriggerFilter]);

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
        allowInsecureTls: values.allowInsecureTls,
        headers,
        cookies,
      };
      if (values.basicUsername || values.basicPassword) {
        http.basicAuth = {
          username: values.basicUsername,
          password: values.basicPassword,
        };
      }

      const markdownOptions: Record<string, unknown> = {
        outputFormat: values.outputFormat,
        cleanup: values.cleanup,
        stripDataImages: values.stripDataImages,
        mainContentOnly: values.mainContentOnly,
        contentSelector: values.contentSelector || undefined,
        removeSelectors: values.removeSelectors
          .split('\n').map((s) => s.trim()).filter(Boolean),
        maxBodyChars: values.maxBodyChars > 0 ? values.maxBodyChars : undefined,
      };

      const res = await fetch(`/api/crawler/crawlers/${crawlerId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ http, markdownOptions }),
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

  async function cancelJob(jobId: string) {
    setCancelingJob(true);
    try {
      const res = await fetch(`/api/crawler/jobs/${jobId}/cancel`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(text || 'Failed to cancel');
      }
      notifications.show({
        color: 'teal',
        title: 'Job canceled',
        message: 'The crawl job was canceled',
      });
      setOpenJob(null);
      await loadJobs();
    } catch (err) {
      notifications.show({
        color: 'red',
        title: 'Error',
        message: err instanceof Error ? err.message : 'Failed',
      });
    } finally {
      setCancelingJob(false);
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
      // A single `limit=200` request silently truncated the table for any
      // job with more than 200 results (e.g. 232 pages + 5 files + 2 errors
      // = 239) — the Runs tab looked complete but was missing the tail end.
      // Page through with skip/limit until a short page confirms we've
      // reached the end, so jobs of any size are fully shown.
      const pageSize = 200;
      const all: CrawlResultView[] = [];
      let skip = 0;
      for (;;) {
        const res = await fetch(
          `/api/crawler/jobs/${job.id}/results?limit=${pageSize}&skip=${skip}`,
          { cache: 'no-store' },
        );
        if (!res.ok) {
          const text = await res.text();
          throw new Error(text || `Server returned ${res.status}`);
        }
        const data = await res.json();
        const batch: CrawlResultView[] = data.results ?? [];
        all.push(...batch);
        if (batch.length < pageSize) break;
        skip += pageSize;
      }
      setJobResults(all);
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

  if (loading || !crawler) {
    return (
      <DetailShell
        backHref="/dashboard/crawler"
        backLabel="Back to crawlers"
        icon={<IconWorld size={16} />}
        title={loading ? 'Loading…' : 'Crawler not found'}
      >
        <div className="ds-card ds-card-pad">
          {loading ? (
            <span className="ds-faint">Loading crawler…</span>
          ) : (
            <span className="ds-faint">
              This crawler doesn’t exist or was removed.
            </span>
          )}
        </div>
      </DetailShell>
    );
  }

  const urls = crawler.seeds ?? [];

  const jobColumns: DataGridColumn<CrawlJobView>[] = [
    {
      key: 'status',
      label: 'Status',
      render: (j) => (
        <Group gap={6} wrap="nowrap">
          <StatusBadge status={j.status} />
          {j.errorMessage ? (
            <Tooltip label={j.errorMessage} multiline maw={420} withArrow>
              <IconAlertTriangle size={15} color="var(--ds-err)" style={{ flexShrink: 0 }} />
            </Tooltip>
          ) : null}
        </Group>
      ),
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

  const scheduleLabel = crawler.schedule?.enabled
    ? crawler.schedule.mode === 'cron'
      ? `cron ${crawler.schedule.cron}`
      : `every ${crawler.schedule.intervalSeconds}s`
    : 'Manual';

  return (
    <DetailShell
      backHref="/dashboard/crawler"
      backLabel="Back to crawlers"
      icon={<IconWorld size={16} />}
      title={crawler.name}
      meta={
        <>
          <span className="ds-faint ds-mono" style={{ fontSize: 12 }}>
            {crawler.key}
          </span>
          <StatusBadge status={crawler.status === 'active' ? 'active' : 'paused'} />
          <Badge size="xs" variant="light" color="gray">
            {crawler.engine}
          </Badge>
          {crawler.schedule?.enabled ? (
            <Badge
              size="xs"
              variant="light"
              color="blue"
              leftSection={<IconClock size={10} />}
            >
              {scheduleLabel}
            </Badge>
          ) : null}
        </>
      }
      actions={
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
      }
      tabs={[
        { id: 'overview', label: 'Overview' },
        { id: 'urls', label: 'URLs', count: summary.urlCount },
        { id: 'plan', label: 'Engine' },
        { id: 'http', label: 'HTTP' },
        { id: 'integration', label: 'Knowledge Engine + Webhook' },
        { id: 'schedule', label: 'Schedule' },
        { id: 'runs', label: 'Runs', count: jobs.length },
      ]}
      activeTab={activeTab}
      onTabChange={(id) => setActiveTab(id as TabId)}
    >
      {activeTab === 'overview' && (
        <>
          <div className="ds-stat-grid" style={{ marginBottom: 12 }}>
            <StatTile
              label="Status"
              icon={<IconWorld size={14} stroke={1.7} />}
              value={crawler.status === 'active' ? 'Active' : 'Disabled'}
            />
            <StatTile label="URLs" value={summary.urlCount} />
            <StatTile label="Total runs" value={summary.totalRuns} />
            <StatTile label="Schedule" value={scheduleLabel} />
          </div>

          <DetailTwoCol>
            <DetailCard
              title="Last run"
              description="The most recent crawl job for this crawler."
            >
              {summary.last ? (
                <Stack gap={6}>
                  <Group gap="xs">
                    <StatusBadge status={summary.last.status} />
                    <span className="ds-mono ds-muted" style={{ fontSize: 12 }}>
                      {new Date(summary.last.createdAt ?? Date.now()).toLocaleString()}
                    </span>
                  </Group>
                  <span className="ds-faint" style={{ fontSize: 13 }}>
                    {summary.last.pagesProcessed} pages · {summary.last.filesProcessed} files · {summary.last.errorsCount} errors
                    {summary.last.durationMs ? ` · ${(summary.last.durationMs / 1000).toFixed(1)}s` : ''}
                  </span>
                  <div>
                    <Button
                      variant="subtle"
                      size="xs"
                      onClick={() => setActiveTab('runs')}
                    >
                      View all runs
                    </Button>
                  </div>
                </Stack>
              ) : (
                <span className="ds-faint" style={{ fontSize: 13 }}>
                  No runs yet — add URLs and click <strong>Run all</strong> to kick off the first job.
                </span>
              )}
            </DetailCard>

            <DetailCard
              title="API quick start"
              description="Send URLs from an external app and crawl them with this crawler’s settings."
            >
              <Code block>{`POST /api/client/v1/crawler/crawlers/${crawler.key}/crawl
Authorization: Bearer <api-token>
Content-Type: application/json

{
  "urls": ["https://example.com/page"]
}

# Returns: { "jobId": "...", "status": "queued" }
# Poll /api/client/v1/crawler/jobs/{jobId}/results for markdown.`}</Code>
            </DetailCard>
          </DetailTwoCol>
        </>
      )}

      {activeTab === 'urls' && (
        <DetailTwoCol narrowAside>
          <DetailCard
            title="URLs in this crawler"
            description="The crawler runs against this list on “Run all” or when a schedule fires. You can also send URLs directly via API without persisting them here."
          >
            <Stack>
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

              <Divider my={2} />

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
            </Stack>
          </DetailCard>

          <DetailCard
            title="One-shot crawl"
            description="Crawl a URL with this crawler’s config (engine, HTTP, Knowledge Engine, webhook) without saving it to the list."
          >
            <Stack>
              <TextInput
                label="URL"
                placeholder="https://example.com/article"
                value={singleCrawlUrl}
                onChange={(e) => setSingleCrawlUrl(e.currentTarget.value)}
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
                Crawl now
              </Button>
              {crawler.status !== 'active' ? (
                <span className="ds-faint" style={{ fontSize: 12 }}>
                  Enable the crawler to run one-shot crawls.
                </span>
              ) : null}
            </Stack>
          </DetailCard>
        </DetailTwoCol>
      )}

      {activeTab === 'plan' && (
        <DetailCard
          title="Engine & scope"
          description="How pages are fetched and, when link-following is on, which links the crawler is allowed to walk."
        >
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
        </DetailCard>
      )}

      {activeTab === 'http' && (
        <form onSubmit={httpForm.onSubmit(saveHttp)}>
          <DetailTwoCol>
            <DetailCard
              title="Request"
              description="Headers and connection tuning applied to every fetch."
            >
              <Stack>
                <TextInput label="User-Agent" placeholder="Leave empty for default" {...httpForm.getInputProps('userAgent')} />
                <TextInput label="Accept-Language" placeholder="en-US,en;q=0.9,tr;q=0.8" {...httpForm.getInputProps('acceptLanguage')} />
                <Group grow>
                  <NumberInput label="Timeout (ms)" min={1000} max={120000} {...httpForm.getInputProps('timeoutMs')} />
                  <NumberInput label="Max concurrency" min={1} max={16} {...httpForm.getInputProps('maxConcurrency')} />
                </Group>
                <Divider my={2} label="Auth" />
                <PasswordInput label="Bearer token" {...httpForm.getInputProps('bearerToken')} />
                <Group grow>
                  <TextInput label="Basic auth username" {...httpForm.getInputProps('basicUsername')} />
                  <PasswordInput label="Basic auth password" {...httpForm.getInputProps('basicPassword')} />
                </Group>
                <Divider my={2} label="Headers & cookies" />
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
              <Switch
                label="Allow insecure TLS (DANGER: skips certificate verification)"
                description="Rarely needed — the crawler now falls back to the browser engine for sites with a missing-intermediate TLS chain, keeping verification on. Enable this only as a last resort for a destination you trust."
                {...httpForm.getInputProps('allowInsecureTls', { type: 'checkbox' })}
              />
              </Stack>
            </DetailCard>

            <DetailCard
              title="Content extraction"
              description="How fetched HTML is turned into markdown or plain text before storage and Knowledge Engine ingestion."
            >
              <Stack>
                <Select
                  label="Output format"
                  description="markdown keeps headings/links/tables; text flattens to clean plain prose (good for the Knowledge Engine, and sidesteps markdown-structure quirks)."
                  data={[
                    { value: 'markdown', label: 'Markdown' },
                    { value: 'text', label: 'Plain text' },
                  ]}
                  allowDeselect={false}
                  {...httpForm.getInputProps('outputFormat')}
                />
                <Switch
                  label="Clean up markdown"
                  description="Decodes leftover HTML entities (&nbsp; etc.), drops dead #/javascript: links and collapses blank-line runs. Ignored for plain-text output."
                  disabled={httpForm.values.outputFormat === 'text'}
                  {...httpForm.getInputProps('cleanup', { type: 'checkbox' })}
                />
                <Switch
                  label="Strip inline (base64) images"
                  description="Drops data: images from the extracted markdown. Recommended — a single page can otherwise carry megabytes of inline image data."
                  {...httpForm.getInputProps('stripDataImages', { type: 'checkbox' })}
                />
                <Switch
                  label="Main content only"
                  description="Extract just the primary content region, dropping nav menus, headers and footers. Reduces boilerplate noise in the Knowledge Engine."
                  {...httpForm.getInputProps('mainContentOnly', { type: 'checkbox' })}
                />
                <TextInput
                  label="Content selector (optional)"
                  placeholder="e.g. main, article, #content"
                  description="CSS selector for the main content region. Overrides the auto heuristic when set."
                  {...httpForm.getInputProps('contentSelector')}
                />
                <Textarea
                  label="Remove selectors (one per line)"
                  placeholder={'.cookie-banner\nnav\nfooter'}
                  autosize
                  minRows={2}
                  {...httpForm.getInputProps('removeSelectors')}
                />
                <NumberInput
                  label="Max body length (chars, 0 = no limit)"
                  min={0}
                  max={5000000}
                  {...httpForm.getInputProps('maxBodyChars')}
                />
                <Group justify="flex-end">
                  <Button type="submit" loading={savingHttp}>Save HTTP settings</Button>
                </Group>
              </Stack>
            </DetailCard>
          </DetailTwoCol>
        </form>
      )}

      {activeTab === 'integration' && (
        <form onSubmit={intForm.onSubmit(saveIntegration)}>
          <DetailTwoCol>
            <DetailCard
              title="Knowledge Engine"
              description="Ingest every successfully fetched page into a Knowledge Engine module for retrieval."
            >
              <Stack>
                <Switch label="Ingest fetched pages into a Knowledge Engine module" {...intForm.getInputProps('ragEnabled', { type: 'checkbox' })} />
                <Select
                  label="Knowledge Engine module"
                  description="Each successful page will be ingested into the selected module via ragService."
                  placeholder={ragModules.length === 0
                    ? 'No active Knowledge Engine modules found — create one in the Knowledge Engine page first'
                    : 'Select a Knowledge Engine module'}
                  disabled={!intForm.values.ragEnabled || ragModules.length === 0}
                  data={ragModules.map((m) => ({ value: m.key, label: `${m.name} · ${m.key}` }))}
                  searchable
                  nothingFoundMessage="No matching Knowledge Engine modules"
                  {...intForm.getInputProps('ragModuleKey')}
                />
              </Stack>
            </DetailCard>

            <DetailCard
              title="Webhook"
              description="Notify an external endpoint on each page and on run completion / failure."
            >
              <Stack>
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
                <Divider my={2} label="Events" />
                <Group>
                  <Switch label="page" disabled={!intForm.values.webhookEnabled} {...intForm.getInputProps('webhookEventPage', { type: 'checkbox' })} />
                  <Switch label="completed" disabled={!intForm.values.webhookEnabled} {...intForm.getInputProps('webhookEventCompleted', { type: 'checkbox' })} />
                  <Switch label="failed" disabled={!intForm.values.webhookEnabled} {...intForm.getInputProps('webhookEventFailed', { type: 'checkbox' })} />
                </Group>
                <Group justify="flex-end">
                  <Button type="submit" loading={savingIntegration}>Save integration</Button>
                </Group>
              </Stack>
            </DetailCard>
          </DetailTwoCol>
        </form>
      )}

      {activeTab === 'schedule' && (
        <DetailCard
          title="Schedule"
          description="Run this crawler automatically against its saved URL list on a recurring interval or cron expression."
        >
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
        </DetailCard>
      )}

      {activeTab === 'runs' && (
        <DetailCard
          title="Runs"
          description="Every crawl job for this crawler. Click a row to inspect its pages and errors."
          pad="sm"
        >
          <DataGrid<CrawlJobView>
            records={filteredJobs}
            rowKey={(j) => j.id}
            onRowClick={(j) => void openJobModal(j)}
            columns={jobColumns}
            onRefresh={loadJobs}
            search={{
              value: jobQuery,
              onChange: setJobQuery,
              placeholder: 'Search by id, status, trigger, date…',
            }}
            filters={[
              {
                value: jobStatusFilter,
                onChange: setJobStatusFilter,
                ariaLabel: 'Filter by status',
                width: 150,
                options: [
                  { value: 'all', label: 'All statuses' },
                  { value: 'queued', label: 'Queued' },
                  { value: 'running', label: 'Running' },
                  { value: 'succeeded', label: 'Succeeded' },
                  { value: 'partial', label: 'Partial' },
                  { value: 'failed', label: 'Failed' },
                  { value: 'canceled', label: 'Canceled' },
                ],
              },
              {
                value: jobTriggerFilter,
                onChange: setJobTriggerFilter,
                ariaLabel: 'Filter by trigger',
                width: 140,
                options: [
                  { value: 'all', label: 'All triggers' },
                  { value: 'manual', label: 'Manual' },
                  { value: 'schedule', label: 'Schedule' },
                  { value: 'api', label: 'API' },
                  { value: 'adhoc', label: 'Ad-hoc' },
                ],
              },
            ]}
            empty={{
              icon: <IconPlayerPlay size={22} stroke={1.7} />,
              title: jobs.length === 0 ? 'No runs yet' : 'No runs match your filters',
              description:
                jobs.length === 0
                  ? 'Click "Run all" or "Crawl now" on a URL to start the first run.'
                  : 'Try clearing the search or filters above.',
            }}
            footerLeft={`Showing ${filteredJobs.length} of ${jobs.length} run${jobs.length === 1 ? '' : 's'}`}
          />
        </DetailCard>
      )}

      <RunDetailModal
        job={openJob}
        results={jobResults}
        loading={resultsLoading}
        canceling={cancelingJob}
        onCancel={(jobId) => void cancelJob(jobId)}
        onClose={() => {
          setOpenJob(null);
          setJobResults([]);
        }}
      />
    </DetailShell>
  );
}
