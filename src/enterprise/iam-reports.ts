/**
 * Report catalog seam for the policy engine — COMMUNITY (open-source) edition.
 *
 * The reports (the summary and the reports over the services' usage, cost, quality
 * and safety data) are an enterprise feature. Who may see a report, export it, see it
 * across all projects or see its breakdowns that name people is decided by the policy
 * engine (`report.*` actions on `Report::"<key>"`, lib/iam/reportEntities.ts), so the
 * engine, the Access check and the policy editor have to know the reports WITHOUT the
 * community core depending on any enterprise code.
 *
 * Contract:
 *   - Nothing is registered in the community edition: there are no reports, the
 *     `report.*` actions are reported as not enforced, a policy that names a report
 *     is refused (it does not exist) and the Access check has no report to ask about.
 *   - The overlay calls `registerIamReportCatalog(...)` once at load, from its
 *     `registry.ts`. This is a separate community file (NOT replaced by the overlay),
 *     so the `registry.ts` seam shape and SEAM_CONTRACT_VERSION do not change because
 *     of it.
 *   - The catalog is code, not data: the same for every workspace.
 *
 * Leaf module on purpose: no imports besides the logger, so the overlay registry
 * can import it at load time without creating a cycle.
 */
import { createLogger } from '@/lib/core/logger';

const logger = createLogger('iam:reports-seam');

/** The headings the reports sit under; a policy can name a whole group (`ReportGroup::"usage"`). */
export const IAM_REPORT_GROUPS = ['usage', 'quality', 'safety', 'infrastructure'] as const;
export type IamReportGroup = (typeof IAM_REPORT_GROUPS)[number];

/** What the engine, the Access check and the policy editor need to know about one report. */
export interface IamReportFacts {
  /** The report's key (`/dashboard/analytics/<key>`): its resource id. */
  key: string;
  /** English title (a UI translates it by key). */
  title: string;
  /** Its heading; null for a report outside the catalog (the old overview). */
  group: IamReportGroup | null;
  /** The permission service its data comes from: seeing the report also needs read on it. */
  service: string;
}

export type IamReportCatalog = () => readonly IamReportFacts[];

let catalog: IamReportCatalog | null = null;

/** The overlay registers the catalog once at load; `null` clears it (tests). A later registration replaces the earlier one. */
export function registerIamReportCatalog(fn: IamReportCatalog | null): void {
  catalog = fn;
}

/** True when this build has reports (the enterprise overlay registered the catalog). */
export function hasIamReportCatalog(): boolean {
  return catalog !== null;
}

/** Every report of this build (none in community, or when the catalog failed: the failure is logged). */
export function listIamReports(): readonly IamReportFacts[] {
  if (!catalog) return [];
  try {
    return catalog();
  } catch (error) {
    logger.warn('The report catalog failed', { error: error instanceof Error ? error.message : String(error) });
    return [];
  }
}

/** One report by key, or null. */
export function findIamReport(key: string): IamReportFacts | null {
  return listIamReports().find((report) => report.key === key) ?? null;
}

export function isIamReportGroup(id: string): id is IamReportGroup {
  return (IAM_REPORT_GROUPS as readonly string[]).includes(id);
}
