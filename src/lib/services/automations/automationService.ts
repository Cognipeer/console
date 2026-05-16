import { pendingTaskCount } from '@/lib/core/asyncTask';
import { browserManager } from '@/lib/services/browser/browserManager';
import { reconcileOrphanedBrowserSessions } from '@/lib/services/browser/browserOperationsService';
import {
  getAlertSchedulerStatus,
  pauseAlertScheduler,
  resumeAlertScheduler,
  triggerAlertSchedulerRun,
} from '@/lib/services/alerts/alertScheduler';
import {
  getPollSchedulerStatus,
  pausePollScheduler,
  resumePollScheduler,
  triggerPollSchedulerRun,
} from '@/lib/services/inferenceMonitoring/pollScheduler';

export const AUTOMATION_KEYS = [
  'alert-evaluation',
  'browser-session-reaper',
  'browser-session-reconciliation',
  'inference-monitoring-poll',
] as const;

export type AutomationKey = typeof AUTOMATION_KEYS[number];

export interface AutomationView {
  key: AutomationKey;
  name: string;
  description: string;
  domain: 'alerts' | 'browser' | 'monitoring';
  cadenceLabel: string;
  distributed: boolean;
  metrics: Record<string, boolean | number | string | null>;
  state: 'active' | 'degraded' | 'idle' | 'paused' | 'running';
  supportsPause: boolean;
  supportsTrigger: boolean;
  lastStartedAt: Date | null;
  lastCompletedAt: Date | null;
  lastDurationMs: number | null;
  lastError: string | null;
}

export function isAutomationKey(value: string): value is AutomationKey {
  return (AUTOMATION_KEYS as readonly string[]).includes(value);
}

let reconciliationRunning = false;
let reconciliationLastStartedAt: Date | null = null;
let reconciliationLastCompletedAt: Date | null = null;
let reconciliationLastDurationMs: number | null = null;
let reconciliationLastError: string | null = null;
let reconciliationLastSessions = 0;
let reconciliationLastTenants = 0;

function formatIntervalLabel(intervalMs: number): string {
  const seconds = Math.floor(intervalMs / 1_000);
  if (seconds < 60) return `Every ${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `Every ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `Every ${hours}h`;
}

function deriveState(input: {
  paused?: boolean;
  running?: boolean;
  lastError?: string | null;
  idle?: boolean;
}): AutomationView['state'] {
  if (input.running) return 'running';
  if (input.paused) return 'paused';
  if (input.lastError) return 'degraded';
  if (input.idle) return 'idle';
  return 'active';
}

function getAlertAutomationView(): AutomationView {
  const status = getAlertSchedulerStatus();
  return {
    cadenceLabel: formatIntervalLabel(status.checkIntervalMs),
    description: 'Evaluates active alert rules across tenants and emits incidents or notifications.',
    distributed: status.distributedLock,
    domain: 'alerts',
    key: 'alert-evaluation',
    lastCompletedAt: status.lastCompletedAt,
    lastDurationMs: status.lastDurationMs,
    lastError: status.lastError,
    lastStartedAt: status.lastStartedAt,
    metrics: {
      firedCount: status.lastFiredCount,
      lockProvider: status.lastLockProvider,
      pendingAsyncTasks: pendingTaskCount(),
      processedTenants: status.lastProcessedTenants,
    },
    name: 'Alert Evaluation',
    state: deriveState(status),
    supportsPause: true,
    supportsTrigger: true,
  };
}

function getPollAutomationView(): AutomationView {
  const status = getPollSchedulerStatus();
  return {
    cadenceLabel: formatIntervalLabel(status.checkIntervalMs),
    description: 'Polls inference servers on their due intervals and refreshes operational metrics.',
    distributed: status.distributedLock,
    domain: 'monitoring',
    key: 'inference-monitoring-poll',
    lastCompletedAt: status.lastCompletedAt,
    lastDurationMs: status.lastDurationMs,
    lastError: status.lastError,
    lastStartedAt: status.lastStartedAt,
    metrics: {
      dueServers: status.lastDueServers,
      lockProvider: status.lastLockProvider,
      processedTenants: status.lastProcessedTenants,
    },
    name: 'Inference Poll Scheduler',
    state: deriveState(status),
    supportsPause: true,
    supportsTrigger: true,
  };
}

function getBrowserReaperView(): AutomationView {
  const stats = browserManager.getRuntimeStats();
  return {
    cadenceLabel: formatIntervalLabel(stats.reaper.intervalMs),
    description: 'Closes idle or over-lifetime browser sessions inside the local Playwright runtime.',
    distributed: false,
    domain: 'browser',
    key: 'browser-session-reaper',
    lastCompletedAt: stats.reaper.lastCompletedAt,
    lastDurationMs: stats.reaper.lastDurationMs,
    lastError: stats.reaper.lastError,
    lastStartedAt: stats.reaper.lastStartedAt,
    metrics: {
      browserConnected: stats.browserConnected,
      liveSessions: stats.liveSessions,
      shuttingDown: stats.shuttingDown,
    },
    name: 'Browser Session Reaper',
    state: deriveState({ lastError: stats.reaper.lastError, paused: stats.reaper.paused }),
    supportsPause: true,
    supportsTrigger: true,
  };
}

function getBrowserReconciliationView(): AutomationView {
  return {
    cadenceLabel: 'Manual maintenance',
    description: 'Reconciles browser sessions left active in the database after a runtime restart.',
    distributed: false,
    domain: 'browser',
    key: 'browser-session-reconciliation',
    lastCompletedAt: reconciliationLastCompletedAt,
    lastDurationMs: reconciliationLastDurationMs,
    lastError: reconciliationLastError,
    lastStartedAt: reconciliationLastStartedAt,
    metrics: {
      pendingAsyncTasks: pendingTaskCount(),
      sessionsReconciled: reconciliationLastSessions,
      tenantsScanned: reconciliationLastTenants,
    },
    name: 'Browser Session Reconciliation',
    state: deriveState({
      idle: !reconciliationLastStartedAt && !reconciliationRunning,
      lastError: reconciliationLastError,
      running: reconciliationRunning,
    }),
    supportsPause: false,
    supportsTrigger: true,
  };
}

export function listAutomations(): AutomationView[] {
  return [
    getBrowserReaperView(),
    getBrowserReconciliationView(),
    getPollAutomationView(),
    getAlertAutomationView(),
  ];
}

export function getAutomation(key: AutomationKey): AutomationView | null {
  return listAutomations().find((automation) => automation.key === key) ?? null;
}

export async function runAutomation(key: AutomationKey): Promise<AutomationView> {
  switch (key) {
    case 'alert-evaluation':
      await triggerAlertSchedulerRun();
      return getAlertAutomationView();
    case 'browser-session-reaper':
      await browserManager.triggerReaper();
      return getBrowserReaperView();
    case 'browser-session-reconciliation': {
      if (reconciliationRunning) {
        return getBrowserReconciliationView();
      }

      reconciliationRunning = true;
      reconciliationLastStartedAt = new Date();

      try {
        const result = await reconcileOrphanedBrowserSessions();
        reconciliationLastSessions = result.sessionsReconciled;
        reconciliationLastTenants = result.tenantsScanned;
        reconciliationLastError = null;
      } catch (error) {
        reconciliationLastError = error instanceof Error ? error.message : String(error);
        throw error;
      } finally {
        reconciliationLastCompletedAt = new Date();
        reconciliationLastDurationMs = reconciliationLastCompletedAt.getTime() - reconciliationLastStartedAt.getTime();
        reconciliationRunning = false;
      }

      return getBrowserReconciliationView();
    }
    case 'inference-monitoring-poll':
      await triggerPollSchedulerRun();
      return getPollAutomationView();
    default:
      throw new Error(`Unsupported automation: ${key satisfies never}`);
  }
}

export function pauseAutomation(key: AutomationKey): AutomationView {
  switch (key) {
    case 'alert-evaluation':
      pauseAlertScheduler();
      return getAlertAutomationView();
    case 'browser-session-reaper':
      browserManager.pauseReaper();
      return getBrowserReaperView();
    case 'browser-session-reconciliation':
      throw new Error('This automation cannot be paused');
    case 'inference-monitoring-poll':
      pausePollScheduler();
      return getPollAutomationView();
    default:
      throw new Error(`Unsupported automation: ${key satisfies never}`);
  }
}

export function resumeAutomation(key: AutomationKey): AutomationView {
  switch (key) {
    case 'alert-evaluation':
      resumeAlertScheduler();
      return getAlertAutomationView();
    case 'browser-session-reaper':
      browserManager.resumeReaper();
      return getBrowserReaperView();
    case 'browser-session-reconciliation':
      throw new Error('This automation cannot be resumed');
    case 'inference-monitoring-poll':
      resumePollScheduler();
      return getPollAutomationView();
    default:
      throw new Error(`Unsupported automation: ${key satisfies never}`);
  }
}
