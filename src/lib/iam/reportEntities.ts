/**
 * A report as the policy engine sees it: `Report::"<key>"`, a resource of the
 * `reports` service, `in` its group (`ReportGroup::"usage"`, so a rule can name a
 * whole group) and, when it is viewed for one project, `in` that project (so a rule
 * limited to projects can say something about it).
 *
 * The actions (actions.ts): `report.view` and `report.export` (Read: every reader of
 * Reports holds them), `report.view_all_projects` and `report.view_people` (Admin:
 * owners and administrators, or whoever a policy grants them). The reports API
 * (enterprise) asks them; the catalog of reports comes through @/enterprise/iam-reports.
 *
 * Pure: no database, no engine.
 */

import { isIamReportGroup, type IamReportFacts } from '@/enterprise/iam-reports';
import type { IamResource } from './entities';

export const REPORT_RESOURCE_TYPE = 'report';
export const REPORT_GROUP_RESOURCE_TYPE = 'report-group';
/** Cedar entity type of a report group (the parent of its reports). */
export const REPORT_GROUP_ENTITY = 'ReportGroup';

export const REPORT_ACTIONS = Object.freeze({
  view: 'report.view',
  export: 'report.export',
  viewAllProjects: 'report.view_all_projects',
  viewPeople: 'report.view_people',
});

export interface ReportResourceInput {
  key: IamReportFacts['key'];
  group: IamReportFacts['group'];
  /** The project the report is viewed for; absent for the view across all projects. */
  projectId?: string | null;
}

/** The resource the engine is asked about for one report. */
export function reportResource(input: ReportResourceInput): IamResource {
  const group = input.group && isIamReportGroup(input.group) ? input.group : null;
  return {
    kind: 'resource',
    type: REPORT_RESOURCE_TYPE,
    id: input.key,
    service: 'reports',
    key: input.key,
    projectId: input.projectId ?? null,
    ...(group
      ? {
          parents: [{ type: REPORT_GROUP_ENTITY, id: group }],
          extra: [{ uid: { type: REPORT_GROUP_ENTITY, id: group }, parents: [], attrs: {} }],
        }
      : {}),
  };
}
