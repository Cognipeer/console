/**
 * Model of the service-permission matrix used wherever a person or a group gets
 * per-service access on top of a role: inviting someone, editing a person's
 * access, creating or editing a group.
 *
 * Each service has exactly two states in storage: nothing (the role's own
 * default stands: "inherit") or an explicit level, which REPLACES the role
 * default - including an explicit "no access". The matrix never renders an
 * unset service as "None" (the old screens did, which turned every
 * touched-and-put-back service into a real restriction) and saves only what was
 * chosen. Stored entries for services the matrix does not offer (a retired
 * service) are carried through a save untouched.
 *
 * Pure (no React): covered by unit tests, shared by the forms and their preview.
 */

import {
  getRoleDefaultPermission,
  normalizeServicePermissions,
  RBAC_SERVICE_DEFINITIONS,
  SERVICE_PERMISSION_LEVELS,
  type PermissionService,
  type RbacServiceDefinition,
  type ServicePermissionLevel,
  type UserServicePermissions,
} from '@/lib/security/rbac';

/** What an admin can choose for one service. `inherit` stores nothing. */
export type PermissionChoice = 'inherit' | ServicePermissionLevel;

export const PERMISSION_CHOICES: readonly PermissionChoice[] = ['inherit', ...SERVICE_PERMISSION_LEVELS];

/**
 * The services the matrix OFFERS. A retired service keeps its definition so a
 * stored entry naming it still resolves, but it is not something new to hand
 * out - filtered on the flag, not the id, so the next retirement needs no change.
 */
export const MATRIX_SERVICES: readonly RbacServiceDefinition[] = RBAC_SERVICE_DEFINITIONS.filter(
  (service) => !service.deprecated,
);

const OFFERED_IDS: ReadonlySet<string> = new Set(MATRIX_SERVICES.map((s) => s.id));

export interface MatrixDraft {
  /** One entry per offered service (`inherit` when nothing is stored). */
  choices: Record<string, PermissionChoice>;
  /** Stored entries for services the matrix does not offer: carried through a save untouched. */
  kept: UserServicePermissions;
}

/** Reads stored overrides into matrix choices. */
export function readDraft(stored: unknown): MatrixDraft {
  const levels = normalizeServicePermissions(stored);
  const choices: Record<string, PermissionChoice> = {};
  for (const service of MATRIX_SERVICES) {
    choices[service.id] = levels[service.id] ?? 'inherit';
  }
  const kept: UserServicePermissions = {};
  for (const [service, level] of Object.entries(levels) as Array<[PermissionService, ServicePermissionLevel]>) {
    if (!OFFERED_IDS.has(service)) kept[service] = level;
  }
  return { choices, kept };
}

/** What is saved: only explicit choices (`inherit` removes the key), plus the entries carried through. */
export function toPermissions(draft: MatrixDraft): UserServicePermissions {
  const out: UserServicePermissions = { ...draft.kept };
  for (const service of MATRIX_SERVICES) {
    const choice = draft.choices[service.id];
    if (choice && choice !== 'inherit') out[service.id] = choice;
  }
  return out;
}

/** How many services carry an explicit level. */
export function overrideCount(choices: Record<string, PermissionChoice>): number {
  return MATRIX_SERVICES.reduce((n, s) => (choices[s.id] && choices[s.id] !== 'inherit' ? n + 1 : n), 0);
}

/** Services whose choice differs between two states, in the matrix's order. */
export function changedServices(
  before: Record<string, PermissionChoice>,
  after: Record<string, PermissionChoice>,
): string[] {
  return MATRIX_SERVICES.filter((s) => (before[s.id] ?? 'inherit') !== (after[s.id] ?? 'inherit')).map((s) => s.id);
}

export function sameDraft(a: MatrixDraft, b: MatrixDraft): boolean {
  return changedServices(a.choices, b.choices).length === 0;
}

/** Every service back to "inherit" (the stored entries of retired services stay). */
export function resetDraft(draft: MatrixDraft): MatrixDraft {
  return { kept: draft.kept, choices: Object.fromEntries(MATRIX_SERVICES.map((s) => [s.id, 'inherit' as const])) };
}

/** The level a role gives without any override. `role` null = no role (a group without a tenant role). */
export function roleDefaultLevel(role: string | null | undefined, service: PermissionService): ServicePermissionLevel {
  return getRoleDefaultPermission(role ?? undefined, service);
}

/** The level the matrix alone yields for one service: the explicit choice, else the role's default. */
export function matrixLevel(
  role: string | null | undefined,
  choice: PermissionChoice,
  service: PermissionService,
): ServicePermissionLevel {
  return choice === 'inherit' ? roleDefaultLevel(role, service) : choice;
}

export const LEVEL_ORDER: Record<ServicePermissionLevel, number> = { none: 0, read: 1, write: 2, admin: 3 };

/** The services whose level goes up or down against the role default, for the summary. */
export function overrideEffects(
  role: string | null | undefined,
  choices: Record<string, PermissionChoice>,
): Array<{ service: PermissionService; from: ServicePermissionLevel; to: ServicePermissionLevel }> {
  const out: Array<{ service: PermissionService; from: ServicePermissionLevel; to: ServicePermissionLevel }> = [];
  for (const service of MATRIX_SERVICES) {
    const choice = choices[service.id];
    if (!choice || choice === 'inherit') continue;
    const from = roleDefaultLevel(role, service.id);
    if (from !== choice) out.push({ service: service.id, from, to: choice });
  }
  return out;
}
