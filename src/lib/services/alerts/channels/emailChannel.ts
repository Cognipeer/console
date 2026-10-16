/**
 * Email alert channel dispatcher.
 *
 * Sends alert notifications through the mailer: `alert-fired.html` for fired,
 * re-notified and test notifications, `alert-resolved.html` for recoveries,
 * `alert-message.html` for generic messages (digests). A channel with the
 * `project_admins` audience also mails the rule's project admins. When that
 * leaves nobody, it falls back to the tenant owner/admin emails.
 */

import { sendEmail } from '@/lib/email/mailer';
import { createLogger } from '@/lib/core/logger';
import { getTenantDatabase } from '@/lib/database';
import { effectiveProjectLevels, getProjectLevelsSince } from '@/lib/iam/projectLevels';
import type { AlertEmailAudience, IAlertChannel } from '@/lib/database';
import { isUserDisabled, isUserLoginBlocked } from '@/lib/services/users/userAuthState';
import {
  describeBreach,
  entityLabel,
  formatDuration,
  formatTimestamp,
  formatValue,
  formatVersionChange,
  formatWindow,
  operatorSymbol,
  severityLabel,
} from './format';
import { errorMessage } from './channelHttp';
import type {
  AlertContext,
  AlertNotification,
  ChannelMessage,
  DispatchResult,
  IAlertDispatcher,
} from './types';

const log = createLogger('alert-channels');
const MAX_ERROR_SIGNATURES = 3;

/** Most addresses a test notification is mailed to, however many its channel resolves to. */
export const MAX_TEST_EMAIL_RECIPIENTS = 5;

type TenantUser = Awaited<ReturnType<Awaited<ReturnType<typeof getTenantDatabase>>['listUsers']>>[number];

/** A fan-out storm sends hundreds of mails in one sweep; the user list they all consult is read once per this long. */
const USER_CACHE_TTL_MS = 30_000;
const userCache = new Map<string, { at: number; users: Promise<TenantUser[]> }>();
/** A project's admin memberships, read once per this long for the same reason. */
const PROJECT_ADMIN_CACHE_TTL_MS = 30_000;
const projectAdminCache = new Map<string, { at: number; ids: Promise<Set<string>> }>();

/** Forget the cached user lists and project admins (tests; a disabled account is otherwise honoured within the TTL). */
export function resetAlertEmailUserCache(): void {
  userCache.clear();
  projectAdminCache.clear();
}

/**
 * The tenant's users, shared across the resolutions of one burst. Best effort:
 * `null` when the list can't be read (logged, error name only, never cached), so
 * callers keep their recipients: failing to notify is worse than one stray mail
 * to an account disabled moments ago.
 */
async function readUsers(tenantDbName: string): Promise<TenantUser[] | null> {
  const now = Date.now();
  let entry = userCache.get(tenantDbName);
  if (!entry || now - entry.at > USER_CACHE_TTL_MS) {
    const users = (async () => (await getTenantDatabase(tenantDbName)).listUsers())();
    entry = { at: now, users };
    userCache.set(tenantDbName, entry);
  }
  try {
    return await entry.users;
  } catch (err) {
    userCache.delete(tenantDbName);
    log.warn('Alert email recipient lookup failed', { error: err instanceof Error ? err.name : typeof err });
    return null;
  }
}

/**
 * Ids of the users who administer the project through a membership: a direct
 * `project_admin` membership or a group granted `project_admin`, unless that
 * grant takes their alerts access away (read the way the access engine reads it,
 * so a `none` saved before the project levels were enforced does not count).
 * Best effort: `null` when the
 * memberships can't be read (logged, error name only, never cached).
 */
async function readProjectAdminIds(tenantDbName: string, projectId: string): Promise<Set<string> | null> {
  const key = `${tenantDbName}\u0000${projectId}`;
  const now = Date.now();
  let entry = projectAdminCache.get(key);
  if (!entry || now - entry.at > PROJECT_ADMIN_CACHE_TTL_MS) {
    const ids = (async () => {
      const db = await getTenantDatabase(tenantDbName);
      const [rows, grants, since] = await Promise.all([
        db.listUserProjectsByProject(projectId),
        db.listGroupProjectsByProject(projectId),
        getProjectLevelsSince(tenantDbName).catch((err): null => {
          // Mailing someone whose old `none` is out of date beats mailing nobody: use the stored levels.
          log.warn('Alert project levels lookup failed', { error: err instanceof Error ? err.name : typeof err });
          return null;
        }),
      ]);
      const alertsLevel = (row: { servicePermissions?: unknown; updatedAt?: Date | string | number | null }) =>
        since === null
          ? (row.servicePermissions as { alerts?: string } | undefined)?.alerts
          : effectiveProjectLevels(row, since).alerts;
      const out = new Set<string>();
      for (const row of rows) {
        if (row.role === 'project_admin' && alertsLevel(row) !== 'none') out.add(String(row.userId));
      }
      const adminGroups = grants.filter((grant) => grant.role === 'project_admin' && alertsLevel(grant) !== 'none');
      const members = await Promise.all(adminGroups.map((grant) => db.listGroupMembers(String(grant.groupId))));
      for (const member of members.flat()) out.add(String(member.userId));
      return out;
    })();
    entry = { at: now, ids };
    projectAdminCache.set(key, entry);
  }
  try {
    return await entry.ids;
  } catch (err) {
    projectAdminCache.delete(key);
    log.warn('Alert project admin lookup failed', { error: err instanceof Error ? err.name : typeof err });
    return null;
  }
}

/**
 * The project's admins who can follow an alert: membership admins plus legacy
 * project admins (tenant role `project_admin` with the project listed), minus
 * accounts that cannot sign in and portal users.
 */
async function projectAdminEmails(tenantDbName: string, projectId: string, users: TenantUser[]): Promise<string[]> {
  const ids = await readProjectAdminIds(tenantDbName, projectId);
  return users
    .filter((user) => {
      const id = String(user._id);
      const legacy = user.role === 'project_admin' && (user.projectIds ?? []).map(String).includes(projectId);
      // A tenant-level `alerts: none` hides alerts everywhere, so it takes them out of the audience too.
      const noAlerts = user.servicePermissions?.alerts === 'none';
      return (legacy || ids?.has(id) === true) && user.role !== 'portal_user' && !noAlerts && !isUserLoginBlocked(user);
    })
    .map((user) => user.email);
}

/** The project's admins the `project_admins` audience reaches, de-duplicated (no owner/admin fallback). */
export async function resolveProjectAdminRecipients(tenantDbName: string, projectId: string): Promise<string[]> {
  const users = await readUsers(tenantDbName);
  if (!users) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const email of await projectAdminEmails(tenantDbName, projectId, users)) {
    const key = (email ?? '').trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(email.trim());
  }
  return out;
}

export interface AlertEmailAudienceOptions {
  /** `project_admins` adds the admins of `projectId` to the listed recipients. */
  audience?: AlertEmailAudience;
  projectId?: string;
}

/**
 * Who an email channel really mails: its explicit recipients plus, with the
 * `project_admins` audience, the project's admins. When that leaves nobody,
 * the tenant owners and admins. Disabled accounts are removed and the list is
 * de-duplicated. Shared with the digests, which send their own templates.
 */
export async function resolveAlertEmailRecipients(
  tenantDbName: string,
  explicit?: string[] | null,
  options: AlertEmailAudienceOptions = {},
): Promise<string[]> {
  const listed = (explicit ?? []).map((r) => (typeof r === 'string' ? r.trim() : '')).filter(Boolean);
  const users = await readUsers(tenantDbName);
  const audience = options.audience === 'project_admins' && options.projectId && users
    ? await projectAdminEmails(tenantDbName, options.projectId, users)
    : [];
  const named = [...listed, ...audience.map((email) => (email ?? '').trim()).filter(Boolean)];
  const base = named.length > 0
    ? named
    : (users ?? [])
        .filter((u) => (u.role === 'owner' || u.role === 'admin') && !isUserDisabled(u))
        .map((u) => u.email);
  const disabled = new Set(
    (users ?? []).filter(isUserDisabled).map((u) => (u.email ?? '').trim().toLowerCase()).filter(Boolean),
  );
  const seen = new Set<string>();
  return base.filter((recipient) => {
    const key = recipient.trim().toLowerCase();
    if (!key || disabled.has(key) || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

const BADGES: Record<AlertNotification['kind'], string> = {
  fired: 'Alert fired',
  renotify: 'Alert still firing',
  resolved: 'Alert resolved',
  test: 'Test notification',
};

/** The Handlebars data of `alert-fired.html` / `alert-resolved.html`. Exported for the tests. */
export function buildAlertEmailData(n: AlertNotification, ctx: AlertContext): Record<string, unknown> {
  const { rule } = n;
  const resolvedAt = n.resolvedAt ? new Date(n.resolvedAt) : null;
  const hasThreshold = typeof rule.threshold === 'number' && Number.isFinite(rule.threshold);
  const incidentUrl = n.incidentUrl || ctx.incidentUrl || n.dashboardUrl || ctx.dashboardUrl;
  const hasBaseline = n.baseline !== null && n.baseline !== undefined;

  return {
    kind: n.kind,
    isTest: n.kind === 'test',
    isRenotify: n.kind === 'renotify',
    badge: BADGES[n.kind],
    severity: n.severity,
    severityLabel: severityLabel(n.severity),
    alertName: rule.name,
    projectName: n.projectName || ctx.projectName,
    companyName: n.companyName || ctx.companyName,
    metricLabel: rule.metricLabel,
    mode: rule.mode,
    isThreshold: rule.mode === 'threshold',
    operator: operatorSymbol(rule.operator),
    threshold: hasThreshold ? rule.threshold : '',
    thresholdText: hasThreshold ? formatValue(rule.threshold, rule.unit) : '',
    actualValue: n.value === null || n.value === undefined ? '' : Number(n.value.toFixed(2)),
    valueText: formatValue(n.value, rule.unit),
    hasBaseline,
    baselineText: hasBaseline ? formatValue(n.baseline, rule.unit) : '',
    unit: rule.unit,
    windowMinutes: rule.windowMinutes,
    windowText: formatWindow(rule.windowMinutes),
    entityLabel: entityLabel(n) ?? '',
    entityKey: n.entity?.key ?? '',
    entityType: n.entity?.type ?? '',
    summary: describeBreach(n),
    firedAt: formatTimestamp(n.firedAt),
    resolvedAt: resolvedAt ? formatTimestamp(resolvedAt) : '',
    duration: resolvedAt ? formatDuration(new Date(n.firedAt).getTime(), resolvedAt.getTime()) : '',
    versionChange: formatVersionChange(n.context?.versionChange, n.firedAt),
    errorSignatures: (n.context?.errorSignatures ?? []).slice(0, MAX_ERROR_SIGNATURES).map((s) => ({
      message: s.message,
      count: s.count,
    })),
    dashboardUrl: n.dashboardUrl || ctx.dashboardUrl,
    incidentUrl,
    incidentId: ctx.incidentId || '',
  };
}

export class EmailAlertChannel implements IAlertDispatcher {
  readonly type = 'email';

  async dispatch(n: AlertNotification, channel: IAlertChannel, ctx: AlertContext): Promise<DispatchResult[]> {
    if (channel.type !== 'email') return [];
    const templateName = n.kind === 'resolved' ? 'alert-resolved' : 'alert-fired';
    return this.sendToRecipients(channel, ctx, templateName, buildAlertEmailData(n, ctx), n.kind === 'test');
  }

  async sendMessage(message: ChannelMessage, channel: IAlertChannel, ctx: AlertContext): Promise<DispatchResult[]> {
    if (channel.type !== 'email') return [];
    return this.sendToRecipients(channel, ctx, 'alert-message', {
      title: message.title,
      summary: message.summary,
      severity: message.severity ?? 'info',
      severityLabel: severityLabel(message.severity),
      fields: message.fields,
      url: message.url ?? '',
      urlLabel: message.urlLabel ?? 'Open',
      footer: message.footer ?? '',
      projectName: ctx.projectName,
      companyName: ctx.companyName,
    });
  }

  private async sendToRecipients(
    channel: Extract<IAlertChannel, { type: 'email' }>,
    ctx: AlertContext,
    templateName: string,
    data: Record<string, unknown>,
    isTest = false,
  ): Promise<DispatchResult[]> {
    // A disabled account must not keep receiving operational mail, whether it
    // was listed explicitly or picked up by the owner/admin fallback.
    const resolved = await resolveAlertEmailRecipients(ctx.tenantDbName, channel.recipients, {
      audience: channel.audience,
      projectId: ctx.projectId,
    });
    if (resolved.length === 0) {
      return [{ type: 'email', target: '(none)', success: false, error: 'No recipients available' }];
    }
    // An audience can resolve to many people: a test must not become a mass mailer.
    const recipients = isTest ? resolved.slice(0, MAX_TEST_EMAIL_RECIPIENTS) : resolved;

    const results = await Promise.all(
      recipients.map(async (recipient): Promise<DispatchResult> => {
        try {
          // sendEmail reports failure through its return value (it never throws)
          const sent = await sendEmail(recipient, templateName, data);
          if (!sent) {
            log.warn('Alert email was not sent', { template: templateName });
            return {
              type: 'email',
              target: recipient,
              success: false,
              error: 'The mail server did not accept the message (SMTP is not configured or the send failed)',
            };
          }
          return { type: 'email', target: recipient, success: true };
        } catch (err) {
          return { type: 'email', target: recipient, success: false, error: errorMessage(err) };
        }
      }),
    );
    if (!isTest) return results;

    // The person who tests sees how many were mailed, not who they are.
    const failure = results.find((result) => !result.success);
    const target = `${results.length} ${results.length === 1 ? 'recipient' : 'recipients'}`;
    return [failure ? { ...failure, target } : { type: 'email', target, success: true }];
  }
}
