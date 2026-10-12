/**
 * Newly gated surfaces: places where a signed-in person or an API token did not
 * need a service permission in the previous release and now does.
 *
 * Nothing about the stored data changes here - a route starts to check a
 * permission - so the difference does not come out of the before / after
 * comparison of service levels. The report derives it from the engine's answers
 * instead: a person whose answer for the service and level below is "no" loses
 * the surface. (The dashboard keeps a page in the navigation only when the
 * person can use it: it asks the session for the effective levels.)
 *
 * Keep this list in step with the route declarations when a route starts to
 * check a permission: it is the only place that remembers what the previous
 * release did not check. The unit test checks every entry against the live
 * route-to-service map where the route is mapped by prefix.
 */

import type { PermissionService } from '@/lib/security/rbac';

export interface GatedSurface {
  id: string;
  title: string;
  edition: 'community' | 'enterprise';
  service: PermissionService;
  /** The check that decides: a read-like call asks `read`, a mutation asks `write`. */
  level: 'read' | 'write';
  routes: readonly string[];
  /** Who calls it. */
  caller: 'session';
}

export const NEWLY_GATED_SURFACES: readonly GatedSurface[] = [
  {
    id: 'model-playgrounds',
    title: 'Model playgrounds (chat, embeddings, images, speech, transcription)',
    edition: 'community',
    service: 'models',
    level: 'read',
    routes: [
      'POST /api/dashboard/playground/chat',
      'POST /api/dashboard/playground/embeddings',
      'POST /api/dashboard/playground/images',
      'POST /api/dashboard/playground/speech',
      'POST /api/dashboard/playground/transcription',
    ],
    caller: 'session',
  },
  {
    id: 'ocr-playground',
    title: 'OCR playground',
    edition: 'community',
    service: 'ocr',
    level: 'read',
    routes: ['POST /api/dashboard/playground/ocr'],
    caller: 'session',
  },
  {
    id: 'skills-read',
    title: 'Agent skills library (view)',
    edition: 'community',
    service: 'agents',
    level: 'read',
    routes: ['GET /api/skills', 'GET /api/skills/:id'],
    caller: 'session',
  },
  {
    id: 'skills-write',
    title: 'Agent skills library (create, edit, delete)',
    edition: 'community',
    service: 'agents',
    level: 'write',
    routes: ['POST /api/skills', 'PATCH /api/skills/:id', 'DELETE /api/skills/:id'],
    caller: 'session',
  },
  {
    id: 'prompt-optimizer-read',
    title: 'Prompt optimizer (view)',
    edition: 'enterprise',
    service: 'prompts',
    level: 'read',
    routes: ['GET /api/prompt-optimizer/*'],
    caller: 'session',
  },
  {
    id: 'prompt-optimizer-write',
    title: 'Prompt optimizer (run, change)',
    edition: 'enterprise',
    service: 'prompts',
    level: 'write',
    routes: ['POST|PUT|PATCH|DELETE /api/prompt-optimizer/*'],
    caller: 'session',
  },
];

/**
 * Tokens with a service scope are refused on the tenant-wide metrics export: a
 * per-service cap cannot be honoured on an export that spans every module, so
 * the export asks for an unscoped token.
 */
export const METRICS_EXPORT = {
  id: 'metrics-export',
  title: 'Tenant-wide metrics export refuses tokens that carry a service scope',
  route: 'GET /api/metrics',
} as const;

/** Does the caller, whose answers per service are `answers`, keep the surface? */
export function surfaceAllowed(surface: GatedSurface, answers: ReadonlyMap<string, { read: boolean; write: boolean; admin: boolean }>): boolean {
  const checks = answers.get(surface.service);
  // A service that was not compared (retired / introduced with the engine) cannot gate an existing surface.
  if (!checks) return true;
  return checks[surface.level];
}
