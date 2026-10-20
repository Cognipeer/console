/**
 * Agent reminders: the defaults and the effective settings of
 * `config.reminders`. Pure — the editor and the server read the same
 * resolution; the server passes the platform limits from the environment
 * (`AGENT_REMINDER_*`), the editor the ones the server reported.
 */

import type { IAgentRemindersConfig } from '@/lib/database/provider/types.domain';

/** The platform ceilings (env). Every agent setting is clamped by them. */
export interface ReminderPlatformLimits {
  enabled: boolean;
  minDelaySeconds: number;
  maxHorizonHours: number;
  maxActivePerSession: number;
  maxFiresPerSession: number;
}

export const REMINDER_PLATFORM_DEFAULTS: ReminderPlatformLimits = {
  enabled: true,
  minDelaySeconds: 60,
  maxHorizonHours: 168,
  maxActivePerSession: 10,
  maxFiresPerSession: 100,
};

export const REMINDER_DEFAULTS = {
  minDelaySeconds: 60,
  maxHorizonHours: 72,
  maxActivePerSession: 3,
  maxFiresPerSession: 20,
  runClass: 'deferred',
  whenBusy: 'postpone',
  afterUntrustedContent: 'approve',
} as const satisfies Required<Omit<IAgentRemindersConfig, 'enabled' | 'instructions'>>;

export const REMINDER_MESSAGE_MAX_CHARS = 1000;
export const REMINDER_REASON_MAX_CHARS = 200;
export const REMINDER_INSTRUCTIONS_MAX_CHARS = 2000;

export interface ResolvedRemindersConfig {
  /** Switched on for the agent AND allowed by the platform. */
  available: boolean;
  /** Switched on for the agent (whatever the platform says). */
  enabled: boolean;
  minDelaySeconds: number;
  maxHorizonHours: number;
  maxActivePerSession: number;
  maxFiresPerSession: number;
  runClass: 'default' | 'deferred';
  whenBusy: 'postpone' | 'skip';
  afterUntrustedContent: 'approve' | 'deny' | 'allow';
  instructions: string;
}

function positive(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

export function resolveRemindersConfig(
  config: IAgentRemindersConfig | undefined | null,
  platform: ReminderPlatformLimits = REMINDER_PLATFORM_DEFAULTS,
): ResolvedRemindersConfig {
  const enabled = config?.enabled === true;
  const minDelaySeconds = Math.max(positive(config?.minDelaySeconds) ?? REMINDER_DEFAULTS.minDelaySeconds, platform.minDelaySeconds);
  const maxHorizonHours = Math.min(positive(config?.maxHorizonHours) ?? REMINDER_DEFAULTS.maxHorizonHours, platform.maxHorizonHours);
  return {
    available: enabled && platform.enabled,
    enabled,
    minDelaySeconds,
    // A horizon shorter than the minimum delay would leave no valid time at all.
    maxHorizonHours: Math.max(maxHorizonHours, Math.ceil(minDelaySeconds / 3600)),
    maxActivePerSession: Math.min(Math.floor(positive(config?.maxActivePerSession) ?? REMINDER_DEFAULTS.maxActivePerSession), platform.maxActivePerSession),
    maxFiresPerSession: Math.min(Math.floor(positive(config?.maxFiresPerSession) ?? REMINDER_DEFAULTS.maxFiresPerSession), platform.maxFiresPerSession),
    runClass: config?.runClass === 'default' ? 'default' : REMINDER_DEFAULTS.runClass,
    whenBusy: config?.whenBusy === 'skip' ? 'skip' : REMINDER_DEFAULTS.whenBusy,
    afterUntrustedContent: config?.afterUntrustedContent === 'deny' || config?.afterUntrustedContent === 'allow'
      ? config.afterUntrustedContent
      : REMINDER_DEFAULTS.afterUntrustedContent,
    instructions: typeof config?.instructions === 'string' ? config.instructions.trim().slice(0, REMINDER_INSTRUCTIONS_MAX_CHARS) : '',
  };
}
