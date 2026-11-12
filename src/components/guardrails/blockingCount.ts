import {
  readGuardrailMode,
} from '@/lib/services/guardrail/hooks/contract';

interface BlockingCandidate {
  action?: string;
  mode?: unknown;
  enabled?: boolean;
}

/**
 * Counts guardrails that actually reject traffic: action is `block` AND the
 * effective mode is `enforce`. A monitor-mode (log only) or disabled guardrail
 * never blocks, whatever its configured action says.
 */
export function countBlockingGuardrails(guardrails: BlockingCandidate[]): number {
  return guardrails.filter(
    (g) =>
      g.action === 'block' &&
      readGuardrailMode({ mode: g.mode as never, enabled: g.enabled }) === 'enforce',
  ).length;
}
