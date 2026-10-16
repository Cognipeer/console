/**
 * The two access mails: "you were added to these projects" (to the person) and "someone is asking for access" (to the
 * workspace's owners and admins). Both ride the invitation mailer (`sendEmail` + `mail-templates/*.html`): when no mail
 * server is configured it sends nothing and says so (false), and a mail that fails never fails the change it is about.
 */

import { getConfig } from '@/lib/core/config';
import { createLogger } from '@/lib/core/logger';
import type { DatabaseProvider, IUser } from '@/lib/database';
import { sendEmail } from '@/lib/email/mailer';
import type { ProjectRole } from '@/lib/database/provider/types.base';

const logger = createLogger('users:access-mail');

/** How many owners and admins an access request is mailed to (a workspace has a handful). */
const MAX_REQUEST_RECIPIENTS = 25;

const appUrl = (path: string): string => `${getConfig().app.url.replace(/\/$/, '')}${path}`;

const ROLE_LABEL: Record<ProjectRole, string> = { project_admin: 'Project admin', member: 'Member' };

export interface ProjectsAddedMail {
  to: Pick<IUser, 'email' | 'name'>;
  companyName: string;
  adderName: string;
  projects: Array<{ name: string; role: ProjectRole }>;
}

/** Tell a person which projects they were added to. False when nothing was sent (no address, no mail server, a failure). */
export async function sendProjectsAddedEmail(input: ProjectsAddedMail): Promise<boolean> {
  const email = (input.to.email ?? '').trim();
  if (!email || input.projects.length === 0) return false;
  const names = input.projects.map((project) => project.name);
  try {
    return await sendEmail(email, 'projects-added', {
      adderName: input.adderName,
      companyName: input.companyName,
      dashboardUrl: appUrl('/dashboard'),
      name: input.to.name,
      projects: input.projects.map((project) => ({ name: project.name, roleLabel: ROLE_LABEL[project.role] })),
      projectSummary: names.length <= 2 ? names.join(' and ') : `${names.length} projects`,
    });
  } catch (error) {
    logger.warn('Could not send the "added to projects" mail', { error: error instanceof Error ? error.message : String(error) });
    return false;
  }
}

export interface AccessRequestMail {
  tenantId: string;
  companyName: string;
  requester: Pick<IUser, 'name' | 'email'>;
  message?: string;
  at: Date;
}

/** Mail the workspace's active owners and admins that a person asks for access. Returns how many mails were sent. */
export async function sendAccessRequestEmails(
  db: Pick<DatabaseProvider, 'iamListUsers'>,
  input: AccessRequestMail,
): Promise<number> {
  try {
    const page = await db.iamListUsers({
      tenantId: input.tenantId,
      roles: ['owner', 'admin'],
      status: 'active',
      canLogin: true,
      external: false,
      limit: MAX_REQUEST_RECIPIENTS,
      offset: 0,
    });
    let sent = 0;
    for (const recipient of page.items) {
      const to = (recipient.email ?? '').trim();
      if (!to) continue;
      const delivered = await sendEmail(to, 'access-request', {
        companyName: input.companyName,
        message: input.message,
        peopleUrl: appUrl('/dashboard/iam?tab=principals'),
        requestedAt: input.at.toISOString(),
        requesterEmail: input.requester.email,
        requesterName: input.requester.name || input.requester.email,
      }).catch(() => false);
      if (delivered) sent += 1;
    }
    return sent;
  } catch (error) {
    logger.warn('Could not send the access request mails', { error: error instanceof Error ? error.message : String(error) });
    return 0;
  }
}
