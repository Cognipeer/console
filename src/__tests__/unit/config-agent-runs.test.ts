import { afterEach, describe, expect, it } from 'vitest';
import { getConfig, getConfigSource, setConfigSource, type ConfigSource } from '@/lib/core/config';

const originalSource = getConfigSource();

function sourceWith(values: Record<string, string | undefined>): ConfigSource {
  return { name: 'test', get: (key) => values[key] };
}

const agent = (values: Record<string, string | undefined> = {}) => {
  setConfigSource(sourceWith(values));
  return getConfig().agent;
};

afterEach(() => {
  setConfigSource(originalSource);
});

describe('agent run engine config', () => {
  it('has the documented defaults', () => {
    const a = agent();
    expect(a).toMatchObject({
      syncTimeoutMs: 600_000,
      backgroundMaxDurationMs: 1_800_000,
      runMaxActivePerTenant: 250,
      runMaxActivePerProject: 0,
      runConcurrency: 4,
      deferredMaxRunningPerTenant: 2,
      deferredMaxQueuedPerTenant: 10_000,
      deferredConcurrency: 2,
      deferredMaxWaitMs: 86_400_000,
      runCallbackConcurrency: 4,
      runDrainTimeoutMs: 10_000,
      triggerTickMs: 30_000,
      triggerMisfireGraceMs: 3_600_000,
      chatConcurrency: 4,
    });
  });

  it('reads the knobs from the config source', () => {
    const a = agent({
      AGENT_RUN_MAX_ACTIVE_PER_TENANT: '40',
      AGENT_RUN_MAX_ACTIVE_PER_PROJECT: '7',
      AGENT_DEFERRED_MAX_RUNNING_PER_TENANT: '5',
      AGENT_DEFERRED_MAX_QUEUED_PER_TENANT: '300',
      AGENT_DEFERRED_CONCURRENCY: '3',
      AGENT_DEFERRED_MAX_WAIT_MS: '7200000',
      AGENT_RUN_CALLBACK_CONCURRENCY: '9',
      AGENT_TRIGGER_TICK_MS: '10000',
      AGENT_TRIGGER_MISFIRE_GRACE_MS: '60000',
      AGENT_CHAT_CONCURRENCY: '12',
    });
    expect(a).toMatchObject({
      runMaxActivePerTenant: 40,
      runMaxActivePerProject: 7,
      deferredMaxRunningPerTenant: 5,
      deferredMaxQueuedPerTenant: 300,
      deferredConcurrency: 3,
      deferredMaxWaitMs: 7_200_000,
      runCallbackConcurrency: 9,
      triggerTickMs: 10_000,
      triggerMisfireGraceMs: 60_000,
      chatConcurrency: 12,
    });
  });

  it('0 turns the tenant cap off, and the deferred share follows half of the run concurrency', () => {
    expect(agent({ AGENT_RUN_MAX_ACTIVE_PER_TENANT: '0' }).runMaxActivePerTenant).toBe(0);
    expect(agent({ AGENT_RUN_CONCURRENCY: '10' }).deferredConcurrency).toBe(5);
    expect(agent({ AGENT_RUN_CONCURRENCY: '1' }).deferredConcurrency).toBe(1);
  });

  it('clamps values that would wedge the system', () => {
    const a = agent({
      AGENT_RUN_MAX_ACTIVE_PER_TENANT: '-5',
      AGENT_DEFERRED_MAX_RUNNING_PER_TENANT: '0',
      AGENT_DEFERRED_MAX_QUEUED_PER_TENANT: '0',
      AGENT_DEFERRED_CONCURRENCY: '0',
      AGENT_DEFERRED_MAX_WAIT_MS: '5',
      AGENT_RUN_CALLBACK_CONCURRENCY: '0',
      AGENT_TRIGGER_TICK_MS: '10',
      AGENT_CHAT_CONCURRENCY: '0',
      AGENT_SYNC_TIMEOUT_MS: '1',
    });
    expect(a).toMatchObject({
      runMaxActivePerTenant: 0,
      deferredMaxRunningPerTenant: 1,
      deferredMaxQueuedPerTenant: 1,
      deferredConcurrency: 1,
      deferredMaxWaitMs: 60_000,
      runCallbackConcurrency: 1,
      triggerTickMs: 5_000,
      chatConcurrency: 1,
      syncTimeoutMs: 5_000,
    });
  });

  it('keeps the drain window below the shutdown timeout', () => {
    expect(agent({ SHUTDOWN_TIMEOUT_MS: '8000' }).runDrainTimeoutMs).toBe(5_000);
    expect(agent({ AGENT_RUN_DRAIN_TIMEOUT_MS: '2000', SHUTDOWN_TIMEOUT_MS: '60000' }).runDrainTimeoutMs).toBe(2_000);
    expect(agent({ SHUTDOWN_TIMEOUT_MS: '1000' }).runDrainTimeoutMs).toBe(0);
  });

  it('reads the reminder ceilings and clamps them', () => {
    expect(agent().reminders).toEqual({
      enabled: true,
      minDelaySeconds: 60,
      maxHorizonHours: 168,
      maxActivePerSession: 10,
      maxFiresPerSession: 100,
    });
    expect(agent({
      AGENT_REMINDERS_ENABLED: 'false',
      AGENT_REMINDER_MIN_DELAY_SECONDS: '5',
      AGENT_REMINDER_MAX_HORIZON_HOURS: '5000',
      AGENT_REMINDER_MAX_ACTIVE_PER_SESSION: '0',
      AGENT_REMINDER_MAX_FIRES_PER_SESSION: '3',
    }).reminders).toEqual({
      enabled: false,
      minDelaySeconds: 30,
      maxHorizonHours: 720,
      maxActivePerSession: 1,
      maxFiresPerSession: 3,
    });
  });
});
