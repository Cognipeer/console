'use client';

/**
 * React Query hooks of the Browser screens (browsers, sessions, flows, flow runs).
 *
 * - Every key starts `['browser', <project>, ...]` (`browserKeys`); `<project>` is the marker of `useResourceKey`
 *   (see `projectScope.ts`), so a project switch never shows the old project's browsers.
 * - A key is a prefix of the keys below it: `browsers(project)` reaches the list and every browser,
 *   `sessions(project)` every session list and event list, `flows(project)` every flow and its runs.
 * - Mutations invalidate what they change, and resolve after the lists were read again.
 * - The live screenshot (an image the page polls) and the workbench's own driving loop (`useWorkbench.ts`) stay
 *   with their screens; the imperative calls the workbench needs are exported here as plain functions
 *   (`fetchSessionSnapshot`, `postSessionAction`, ...).
 *
 * The routes are the dashboard's `/api/browser` plugin (`src/server/api/plugins/browser.ts`).
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiDelete, apiGet, apiPatch, apiPost, apiPut, isApiError } from '@/lib/api/client';
import type {
  BrowserFlowRunView,
  BrowserFlowView,
  BrowserSessionEventView,
  BrowserSessionView,
  BrowserView,
} from '@/lib/services/browser';
import type { ArtifactBucketRow } from '@/components/browser/artifactBucket';
import { retryUnlessClientError } from './errors';
import { pollingOptions } from './polling';
import { useProjectScope, useResourceKey } from './projectScope';

/* ── Keys ────────────────────────────────────────────────────────────────── */

export const browserKeys = {
  all: ['browser'] as const,
  project: (project: string) => ['browser', project] as const,
  /** The browser list (any status filter) and every browser. */
  browsers: (project: string) => ['browser', project, 'browsers'] as const,
  browserList: (project: string, status: string) => ['browser', project, 'browsers', 'list', status] as const,
  browser: (project: string, id: string) => ['browser', project, 'browsers', 'detail', id] as const,
  /** Every session list and every session's events. */
  sessions: (project: string) => ['browser', project, 'sessions'] as const,
  sessionList: (project: string, query: string) => ['browser', project, 'sessions', 'list', query] as const,
  sessionEvents: (project: string, sessionId: string) => ['browser', project, 'sessions', 'events', sessionId] as const,
  /** Every flow list, flow and flow run. */
  flows: (project: string) => ['browser', project, 'flows'] as const,
  flowLists: (project: string) => ['browser', project, 'flows', 'list'] as const,
  flowList: (project: string, browserId: string) => ['browser', project, 'flows', 'list', browserId] as const,
  flow: (project: string, id: string) => ['browser', project, 'flows', 'detail', id] as const,
  flowRuns: (project: string, flowId: string) => ['browser', project, 'flows', 'runs', flowId] as const,
  flowRun: (project: string, runId: string) => ['browser', project, 'flows', 'run', runId] as const,
  artifactBuckets: (project: string) => ['browser', project, 'artifact-buckets'] as const,
};

/* ── Types ───────────────────────────────────────────────────────────────── */

/** The session actions answer with their own result object; the screens read what they need. */
export type SessionActionResult = Record<string, unknown>;

export interface ProfileSummary {
  cookieCount: number;
  origins: unknown[];
}

export interface FlowStepsRunResponse {
  results?: unknown[];
  captures?: Record<string, unknown>;
  failedStepIndex?: number;
  errorMessage?: string;
}

/* ── Routes ──────────────────────────────────────────────────────────────── */

const browserPath = (id: string) => `/api/browser/browsers/${encodeURIComponent(id)}`;
const flowPath = (id: string) => `/api/browser/flows/${encodeURIComponent(id)}`;
const sessionKeyPath = (key: string) => `/api/browser/sessions/${encodeURIComponent(key)}`;

const withQuery = (path: string, query: string) => (query ? `${path}?${query}` : path);

/* ── Browsers ────────────────────────────────────────────────────────────── */

/** The browsers; `status` narrows the list server-side (`active` for pickers). */
export function useBrowsers(options: { status?: string; notifyOnError?: string } = {}) {
  const [, project] = useResourceKey('browser');
  const status = options.status ?? '';
  return useQuery({
    queryKey: browserKeys.browserList(project, status),
    queryFn: async ({ signal }) =>
      (await apiGet<{ browsers?: BrowserView[] }>(withQuery('/api/browser/browsers', status ? `status=${encodeURIComponent(status)}` : ''), { signal }))
        .browsers ?? [],
    retry: retryUnlessClientError,
    meta: options.notifyOnError ? { notifyOnError: options.notifyOnError } : undefined,
    // Browsers are also changed by agents and the API, so a visit reads the list again.
    staleTime: 0,
  });
}

export function useBrowser(id: string | undefined, options: { notifyOnError?: string } = {}) {
  const [, project] = useResourceKey('browser');
  return useQuery({
    queryKey: browserKeys.browser(project, id ?? ''),
    queryFn: async ({ signal }) => (await apiGet<{ browser?: BrowserView | null }>(browserPath(id as string), { signal })).browser ?? null,
    enabled: Boolean(id),
    retry: retryUnlessClientError,
    meta: options.notifyOnError ? { notifyOnError: options.notifyOnError } : undefined,
    staleTime: 0,
  });
}

/** For a component that changed a browser itself and hands the answer over: puts it into the browser's detail. */
export function useSetBrowserData() {
  const queryClient = useQueryClient();
  const project = useProjectScope();
  return (browser: BrowserView) => queryClient.setQueryData(browserKeys.browser(project, browser.id), browser);
}

export interface BrowserInput {
  name?: string;
  description?: string;
  artifactBucketKey?: string;
  defaultModelKey?: string;
  status?: string;
  defaultSessionConfig?: unknown;
}

function useInvalidateBrowsers() {
  const queryClient = useQueryClient();
  const project = useProjectScope();
  return () => queryClient.invalidateQueries({ queryKey: browserKeys.browsers(project) });
}

function useInvalidateSessions() {
  const queryClient = useQueryClient();
  const project = useProjectScope();
  return () => queryClient.invalidateQueries({ queryKey: browserKeys.sessions(project) });
}

function useInvalidateFlows() {
  const queryClient = useQueryClient();
  const project = useProjectScope();
  return () => queryClient.invalidateQueries({ queryKey: browserKeys.flows(project) });
}

/** Creating a browser changes the browser list. */
export function useCreateBrowser() {
  const invalidate = useInvalidateBrowsers();
  return useMutation({
    mutationFn: (input: BrowserInput) => apiPost<{ browser: BrowserView }>('/api/browser/browsers', input),
    onSuccess: () => invalidate(),
  });
}

/** Saving a browser puts the answer into its detail and reads the lists again. */
export function useUpdateBrowser() {
  const queryClient = useQueryClient();
  const project = useProjectScope();
  return useMutation({
    mutationFn: ({ id, ...input }: BrowserInput & { id: string }) =>
      apiPatch<{ browser: BrowserView }>(browserPath(id), input),
    onSuccess: async (data, { id }) => {
      if (data?.browser) queryClient.setQueryData(browserKeys.browser(project, id), data.browser);
      await queryClient.invalidateQueries({ queryKey: browserKeys.browsers(project) });
    },
  });
}

export function useDeleteBrowser() {
  const queryClient = useQueryClient();
  const project = useProjectScope();
  return useMutation({
    mutationFn: (id: string) => apiDelete<unknown>(browserPath(id)),
    onSuccess: async (_result, id) => {
      queryClient.removeQueries({ queryKey: browserKeys.browser(project, id) });
      await queryClient.invalidateQueries({ queryKey: browserKeys.browsers(project) });
    },
  });
}

/** Attaches a signed-in profile (a Playwright `storageState`) to a browser. */
export function useAttachBrowserProfile() {
  const queryClient = useQueryClient();
  const project = useProjectScope();
  return useMutation({
    mutationFn: ({ browserId, storageState, fileName }: { browserId: string; storageState: unknown; fileName: string }) =>
      apiPut<{ profile: ProfileSummary }>(`${browserPath(browserId)}/profile`, { storageState, fileName }),
    onSuccess: (_result, { browserId }) =>
      queryClient.invalidateQueries({ queryKey: browserKeys.browser(project, browserId) }),
  });
}

export function useClearBrowserProfile() {
  const queryClient = useQueryClient();
  const project = useProjectScope();
  return useMutation({
    mutationFn: (browserId: string) => apiDelete<unknown>(`${browserPath(browserId)}/profile`),
    onSuccess: (_result, browserId) =>
      queryClient.invalidateQueries({ queryKey: browserKeys.browser(project, browserId) }),
  });
}

/** Exports a live session's cookies and attaches them to the browser's profile. */
export function useSaveSessionProfile() {
  const queryClient = useQueryClient();
  const project = useProjectScope();
  return useMutation({
    mutationFn: async ({ browserId, sessionKey }: { browserId: string; sessionKey: string }) => {
      const exported = await apiGet<{ storageState: unknown }>(`${sessionKeyPath(sessionKey)}/profile`);
      return apiPut<{ profile: ProfileSummary }>(`${browserPath(browserId)}/profile`, {
        storageState: exported.storageState,
        fileName: `session-${sessionKey}.json`,
      });
    },
    onSuccess: (_result, { browserId }) =>
      queryClient.invalidateQueries({ queryKey: browserKeys.browser(project, browserId) }),
  });
}

/** The file buckets a browser can keep its screenshots and PDFs in. */
export function useArtifactBuckets() {
  const [, project] = useResourceKey('browser');
  return useQuery({
    queryKey: browserKeys.artifactBuckets(project),
    queryFn: async ({ signal }) =>
      (await apiGet<{ buckets?: ArtifactBucketRow[] }>('/api/files/buckets', { signal })).buckets ?? [],
    retry: retryUnlessClientError,
    staleTime: 0,
  });
}

/* ── Sessions ────────────────────────────────────────────────────────────── */

/** The sessions; `query` is the search string (`browserId=`, `status=`, a range, `limit=`), empty for all. */
export function useBrowserSessions(query = '', options: { enabled?: boolean; notifyOnError?: string } = {}) {
  const [, project] = useResourceKey('browser');
  return useQuery({
    queryKey: browserKeys.sessionList(project, query),
    queryFn: async ({ signal }) =>
      (await apiGet<{ sessions?: BrowserSessionView[] }>(withQuery('/api/browser/sessions', query), { signal })).sessions ?? [],
    enabled: options.enabled ?? true,
    retry: retryUnlessClientError,
    meta: options.notifyOnError ? { notifyOnError: options.notifyOnError } : undefined,
    // Sessions come and go with agents and flows, so a visit reads them again.
    staleTime: 0,
  });
}

/** The latest events of a session (the viewer drawer). */
export function useSessionEvents(sessionId: string | undefined, enabled: boolean) {
  const [, project] = useResourceKey('browser');
  return useQuery({
    queryKey: browserKeys.sessionEvents(project, sessionId ?? ''),
    queryFn: async ({ signal }) =>
      (await apiGet<{ events?: BrowserSessionEventView[] }>(`/api/browser/sessions/${encodeURIComponent(sessionId as string)}/events?limit=25`, { signal }))
        .events ?? [],
    enabled: enabled && Boolean(sessionId),
    retry: false,
    staleTime: 0,
  });
}

export interface CreateSessionInput {
  browserId: string;
  name?: string;
  artifactBucketKey?: string;
  config?: unknown;
}

/** Opens a session. The new session is in every session list, so they are read again. */
export function useCreateBrowserSession() {
  const invalidate = useInvalidateSessions();
  return useMutation({
    mutationFn: async (input: CreateSessionInput) => (await apiPost<{ session: BrowserSessionView }>('/api/browser/sessions', input)).session,
    onSuccess: () => invalidate(),
  });
}

/** Runs one action (`goto`, ...) against a session. */
export function useSessionAction() {
  return useMutation({
    mutationFn: ({ sessionKey, action }: { sessionKey: string; action: Record<string, unknown> }) =>
      apiPost<SessionActionResult>(`${sessionKeyPath(sessionKey)}/actions`, action),
  });
}

/** Closes a live session (the record stays). */
export function useCloseBrowserSession() {
  const invalidate = useInvalidateSessions();
  return useMutation({
    mutationFn: (sessionKey: string) => apiDelete<unknown>(sessionKeyPath(sessionKey)),
    onSuccess: () => invalidate(),
  });
}

/** Deletes the record of a session. */
export function useDeleteBrowserSession() {
  const invalidate = useInvalidateSessions();
  return useMutation({
    mutationFn: (sessionId: string) => apiDelete<unknown>(`/api/browser/sessions/by-id/${encodeURIComponent(sessionId)}`),
    onSuccess: () => invalidate(),
  });
}

/** Stores a full-page screenshot of the session in its bucket. */
export function usePersistSessionScreenshot() {
  return useMutation({
    mutationFn: (sessionKey: string) =>
      apiPost<{ artifact?: { objectKey?: string } }>(`${sessionKeyPath(sessionKey)}/screenshot`, { fullPage: true }),
  });
}

/** Stores a PDF of the session's page in its bucket. */
export function useExportSessionPdf() {
  return useMutation({
    mutationFn: (sessionKey: string) =>
      apiPost<{ artifact?: { objectKey?: string } }>(`${sessionKeyPath(sessionKey)}/pdf`, {}),
  });
}

/* ── The workbench's imperative calls ────────────────────────────────────── */

export interface SessionSnapshot {
  ariaSnapshot?: string;
  url?: string;
  title?: string;
}

/** The page's aria snapshot, read now. `null` when the session answers an error. */
export async function fetchSessionSnapshot(sessionKey: string): Promise<SessionSnapshot | null> {
  try {
    return await apiGet<SessionSnapshot>(`${sessionKeyPath(sessionKey)}/snapshot`);
  } catch (error) {
    if (isApiError(error)) return null;
    throw error;
  }
}

/** The console lines and failed requests of a session. `null` when the session answers an error. */
export async function fetchSessionDiagnostics<T>(sessionKey: string): Promise<T | null> {
  try {
    return await apiGet<T>(`${sessionKeyPath(sessionKey)}/diagnostics`);
  } catch (error) {
    if (isApiError(error)) return null;
    throw error;
  }
}

/** Asks the page for a durable handle (a test id or a structural selector) of the element behind `ref`. */
export function describeSessionElement(sessionKey: string, ref: string) {
  return apiPost<{ target?: Record<string, string | number> }>(`${sessionKeyPath(sessionKey)}/describe`, { ref });
}

/**
 * Posts to a session's `actions` / `extract` endpoint and reports what the server said, an error answer
 * included: the workbench shows the server's own result of a failed action. Only a lost connection throws.
 */
export async function postSessionAction(
  sessionKey: string,
  endpoint: 'actions' | 'extract',
  body: Record<string, unknown>,
): Promise<{ ok: boolean; data: Record<string, unknown> }> {
  try {
    const data = await apiPost<Record<string, unknown> | undefined>(`${sessionKeyPath(sessionKey)}/${endpoint}`, body);
    return { ok: true, data: data && typeof data === 'object' ? data : {} };
  } catch (error) {
    if (isApiError(error)) {
      const payload = error.payload && typeof error.payload === 'object' ? (error.payload as Record<string, unknown>) : {};
      return { ok: false, data: payload };
    }
    throw error;
  }
}

/** Opens a session for a workbench; the caller reads a plan-limit answer off the thrown `ApiError`. */
export async function openWorkbenchSession(browserId: string, name: string): Promise<BrowserSessionView> {
  return (await apiPost<{ session: BrowserSessionView }>('/api/browser/sessions', { browserId, name })).session;
}

/** Closes a workbench's session. */
export function closeWorkbenchSession(sessionKey: string) {
  return apiDelete<unknown>(sessionKeyPath(sessionKey));
}

/* ── Flows ───────────────────────────────────────────────────────────────── */

/** The flows, all of them or one browser's. */
export function useBrowserFlows(options: { browserId?: string; notifyOnError?: string } = {}) {
  const [, project] = useResourceKey('browser');
  const browserId = options.browserId ?? '';
  return useQuery({
    queryKey: browserKeys.flowList(project, browserId),
    queryFn: async ({ signal }) =>
      (await apiGet<{ flows?: BrowserFlowView[] }>(withQuery('/api/browser/flows', browserId ? `browserId=${encodeURIComponent(browserId)}` : ''), { signal }))
        .flows ?? [],
    retry: retryUnlessClientError,
    meta: options.notifyOnError ? { notifyOnError: options.notifyOnError } : undefined,
    staleTime: 0,
  });
}

export function useBrowserFlow(id: string | undefined, options: { notifyOnError?: string } = {}) {
  const [, project] = useResourceKey('browser');
  return useQuery({
    queryKey: browserKeys.flow(project, id ?? ''),
    queryFn: async ({ signal }) => (await apiGet<{ flow: BrowserFlowView }>(flowPath(id as string), { signal })).flow,
    enabled: Boolean(id),
    retry: retryUnlessClientError,
    meta: options.notifyOnError ? { notifyOnError: options.notifyOnError } : undefined,
    staleTime: 0,
  });
}

/** A flow's latest runs. */
export function useBrowserFlowRuns(flowId: string | undefined) {
  const [, project] = useResourceKey('browser');
  return useQuery({
    queryKey: browserKeys.flowRuns(project, flowId ?? ''),
    queryFn: async ({ signal }) =>
      (await apiGet<{ runs?: BrowserFlowRunView[] }>(`/api/browser/flow-runs?flowId=${encodeURIComponent(flowId as string)}&limit=25`, { signal }))
        .runs ?? [],
    enabled: Boolean(flowId),
    retry: false,
    staleTime: 0,
  });
}

/** One run, read every 800 ms while `watch` is set and the run is still `running`. */
export function useBrowserFlowRun(runId: string | null) {
  const [, project] = useResourceKey('browser');
  return useQuery({
    queryKey: browserKeys.flowRun(project, runId ?? ''),
    queryFn: async ({ signal }) => (await apiGet<{ run: BrowserFlowRunView }>(`/api/browser/flow-runs/${encodeURIComponent(runId as string)}`, { signal })).run,
    enabled: Boolean(runId),
    retry: false,
    staleTime: 0,
    ...pollingOptions<BrowserFlowRunView>((run) => run === undefined || run.status === 'running', 800),
  });
}

export interface CreateFlowInput {
  name: string;
  description?: string;
  browserId: string;
  steps: unknown[];
}

export function useCreateBrowserFlow() {
  const invalidate = useInvalidateFlows();
  return useMutation({
    mutationFn: (input: CreateFlowInput) => apiPost<{ flow: BrowserFlowView }>('/api/browser/flows', input),
    onSuccess: () => invalidate(),
  });
}

/** Turns a session's action log into a flow. */
export function useRecordBrowserFlow() {
  const invalidate = useInvalidateFlows();
  return useMutation({
    mutationFn: (input: { sessionId: string; name: string; description?: string }) =>
      apiPost<{ flow: BrowserFlowView }>('/api/browser/flows/record', input),
    onSuccess: () => invalidate(),
  });
}

/** Saving a flow puts the answer into its detail and reads the lists again. */
export function useUpdateBrowserFlow(flowId: string) {
  const queryClient = useQueryClient();
  const project = useProjectScope();
  return useMutation({
    mutationFn: (body: Record<string, unknown>) => apiPatch<{ flow: BrowserFlowView }>(flowPath(flowId), body),
    onSuccess: async (data) => {
      if (data?.flow) queryClient.setQueryData(browserKeys.flow(project, flowId), data.flow);
      await queryClient.invalidateQueries({ queryKey: browserKeys.flowLists(project) });
    },
  });
}

export function useDeleteBrowserFlow() {
  const queryClient = useQueryClient();
  const project = useProjectScope();
  return useMutation({
    mutationFn: (id: string) => apiDelete<unknown>(flowPath(id)),
    onSuccess: async (_result, id) => {
      queryClient.removeQueries({ queryKey: browserKeys.flow(project, id) });
      await queryClient.invalidateQueries({ queryKey: browserKeys.flows(project) });
    },
  });
}

/** Replays a flow's steps against the authoring session. */
export function useRunFlowSteps(flowId: string) {
  return useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      apiPost<FlowStepsRunResponse>(`${flowPath(flowId)}/steps/run`, body),
  });
}

/** Starts a test run of a flow. */
export function useStartFlowRun(flowId: string) {
  const queryClient = useQueryClient();
  const project = useProjectScope();
  return useMutation({
    mutationFn: (body: { inputs: Record<string, string>; keepSessionOpen: boolean }) =>
      apiPost<{ run: BrowserFlowRunView }>(`${flowPath(flowId)}/run/start`, body),
    onSuccess: (data) => {
      if (data?.run) queryClient.setQueryData(browserKeys.flowRun(project, data.run.id), data.run);
    },
  });
}

/** After a run ended: its flow's run list changed. */
export function useInvalidateFlowRuns() {
  const queryClient = useQueryClient();
  const project = useProjectScope();
  return (flowId: string) => queryClient.invalidateQueries({ queryKey: browserKeys.flowRuns(project, flowId) });
}
