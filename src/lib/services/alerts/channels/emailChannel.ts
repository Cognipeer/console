/**
 * Email alert channel dispatcher.
 *
 * Sends alert notifications through the mailer: `alert-fired.html` for fired,
 * re-notified and test notifications, `alert-resolved.html` for recoveries,
 * `alert-message.html` for generic messages (digests). When the recipient
 * list is empty it falls back to the tenant owner/admin emails.
 */

import { sendEmail } from '@/lib/email/mailer';
import { createLogger } from '@/lib/core/logger';
import { getTenantDatabase } from '@/lib/database';
import type { IAlertChannel } from '@/lib/database';
import { isUserDisabled } from '@/lib/services/users/userAuthState';
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

type TenantUser = Awaited<ReturnType<Awaited<ReturnType<typeof getTenantDatabase>>['listUsers']>>[number];

/** A fan-out storm sends hundreds of mails in one sweep; the user list they all consult is read once per this long. */
const USER_CACHE_TTL_MS = 30_000;
const userCache = new Map<string, { at: number; users: Promise<TenantUser[]> }>();

/** Forget the cached user lists (tests; a disabled account is otherwise honoured within the TTL). */
export function resetAlertEmailUserCache(): void {
  userCache.clear();
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
 * Who an email channel really mails: its explicit recipients (or, when none,
 * the tenant owners and admins) minus disabled accounts, de-duplicated.
 * Shared with the digests, which send their own templates.
 */
export async function resolveAlertEmailRecipients(
  tenantDbName: string,
  explicit?: string[] | null,
): Promise<string[]> {
  const listed = (explicit ?? []).map((r) => (typeof r === 'string' ? r.trim() : '')).filter(Boolean);
  const users = await readUsers(tenantDbName);
  const base = listed.length > 0
    ? listed
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
    return this.sendToRecipients(channel, ctx, templateName, buildAlertEmailData(n, ctx));
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
  ): Promise<DispatchResult[]> {
    // A disabled account must not keep receiving operational mail, whether it
    // was listed explicitly or picked up by the owner/admin fallback.
    const recipients = await resolveAlertEmailRecipients(ctx.tenantDbName, channel.recipients);
    if (recipients.length === 0) {
      return [{ type: 'email', target: '(none)', success: false, error: 'No recipients available' }];
    }

    return Promise.all(
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
  }
}
