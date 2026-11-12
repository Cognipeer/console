'use client';

import { useAlertRule, useSetAlertRule } from '@/lib/api/queries/alerts';
import type { AlertRuleDto } from '../alertTypes';

/**
 * The rule behind an incident (`GET /alerts/rules/:id`): the mute state and the runbook link live there,
 * not on the incident. A missing or forbidden rule is not an error for the page: `rule` stays null.
 */
export function useIncidentRule(ruleId: string | undefined): {
  rule: AlertRuleDto | null;
  setRule: (rule: AlertRuleDto | null) => void;
  reload: () => void;
} {
  const query = useAlertRule(ruleId);
  const setRule = useSetAlertRule();
  return { rule: query.data ?? null, setRule, reload: () => void query.refetch() };
}
