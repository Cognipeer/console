import { useAgentTemplate } from '@/lib/api/queries/agents';
import type { AgentTemplateDetail } from '@/lib/services/agents/templates/types';

export interface TemplateDetailState {
  template: AgentTemplateDetail | null;
  loading: boolean;
  failed: boolean;
}

/** The full template for a key (null key: nothing is loaded). */
export function useTemplateDetail(templateKey: string | null): TemplateDetailState {
  const query = useAgentTemplate(templateKey);
  if (!templateKey) return { template: null, loading: false, failed: false };
  return { template: query.data ?? null, loading: query.isPending, failed: query.isError };
}
