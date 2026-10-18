import { useEffect, useState } from 'react';
import type { AgentTemplateDetail } from '@/lib/services/agents/templates/types';

export interface TemplateDetailState {
  template: AgentTemplateDetail | null;
  loading: boolean;
  failed: boolean;
}

/** The full template for a key (null key: nothing is loaded). */
export function useTemplateDetail(templateKey: string | null): TemplateDetailState {
  const [state, setState] = useState<TemplateDetailState>({ template: null, loading: false, failed: false });

  useEffect(() => {
    if (!templateKey) {
      setState({ template: null, loading: false, failed: false });
      return;
    }
    let cancelled = false;
    setState({ template: null, loading: true, failed: false });
    fetch(`/api/agents/templates/${encodeURIComponent(templateKey)}`, { cache: 'no-store' })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return (await res.json()).template as AgentTemplateDetail;
      })
      .then((template) => { if (!cancelled) setState({ template, loading: false, failed: false }); })
      .catch(() => { if (!cancelled) setState({ template: null, loading: false, failed: true }); });
    return () => { cancelled = true; };
  }, [templateKey]);

  return state;
}
