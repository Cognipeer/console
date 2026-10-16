'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
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
  const [rule, setRule] = useState<AlertRuleDto | null>(null);
  const [attempt, setAttempt] = useState(0);
  const lastId = useRef<string | undefined>(undefined);

  useEffect(() => {
    if (!ruleId) return;
    if (lastId.current !== ruleId) {
      lastId.current = ruleId;
      setRule(null);
    }
    const controller = new AbortController();
    fetch(`/api/alerts/rules/${encodeURIComponent(ruleId)}`, { signal: controller.signal, cache: 'no-store' })
      .then(async (res) => (res.ok ? ((await res.json()) as { rule?: AlertRuleDto }) : null))
      .then((data) => {
        if (data?.rule && !controller.signal.aborted) setRule(data.rule);
      })
      .catch(() => {
        // the rule is context for the page, not required by it
      });
    return () => controller.abort();
  }, [ruleId, attempt]);

  const reload = useCallback(() => setAttempt((value) => value + 1), []);
  return { rule, setRule, reload };
}
