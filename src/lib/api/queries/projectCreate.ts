'use client';

/**
 * React Query hooks of the "create a project" form: the people and groups it can add, and the workspace default for
 * the alert rules a new project starts with. (Creating the project itself is `useCreateProject`, in `projects.ts`;
 * the providers it can attach are `useTenantProviders`, in `tenantProviders.ts`.)
 *
 * - Every key starts `['project-create', <project>, ...]` (`projectCreateKeys`); `<project>` is the marker of `useResourceKey`.
 * - Both reads run only while the form is open, and again on every open (`staleTime: 0`): people join and rules change.
 */

import { useQuery } from '@tanstack/react-query';
import { apiGet } from '@/lib/api/client';
import { retryUnlessClientError } from './errors';
import { useResourceKey } from './projectScope';

export const projectCreateKeys = {
  all: ['project-create'] as const,
  project: (project: string) => ['project-create', project] as const,
  people: (project: string) => ['project-create', project, 'people'] as const,
  alertDefault: (project: string) => ['project-create', project, 'alert-default'] as const,
};

export interface PeopleBody {
  users?: unknown[];
  groups?: unknown[];
}

/** The accounts and the groups of the workspace, read together: both answer or the read failed. */
export function useProjectPeople(enabled: boolean) {
  const [, project] = useResourceKey('project-create');
  return useQuery<PeopleBody, Error>({
    queryKey: projectCreateKeys.people(project),
    queryFn: async ({ signal }) => {
      const [users, groups] = await Promise.all([
        apiGet<{ users?: unknown[] }>('/api/users', { signal }),
        apiGet<{ groups?: unknown[] }>('/api/groups', { signal }),
      ]);
      return { users: users?.users ?? [], groups: groups?.groups ?? [] };
    },
    enabled,
    retry: retryUnlessClientError,
    staleTime: 0,
  });
}

/**
 * Whether a new project starts with the default alert rules (the workspace's choice), or undefined when the
 * workspace did not say or the read failed. `enabled` false reads nothing.
 */
export function useDefaultAlertRulesChoice(enabled: boolean) {
  const [, project] = useResourceKey('project-create');
  return useQuery<unknown, Error, boolean | undefined>({
    queryKey: projectCreateKeys.alertDefault(project),
    queryFn: ({ signal }) => apiGet<unknown>('/api/alerts/templates', { signal }),
    select: (body) => {
      const choice = (body as { defaultRulesOnNewProjects?: unknown } | null | undefined)?.defaultRulesOnNewProjects;
      return typeof choice === 'boolean' ? choice : undefined;
    },
    enabled,
    retry: false,
    staleTime: 0,
  });
}
