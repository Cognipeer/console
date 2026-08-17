/**
 * Cognipeer Support handoff.
 *
 * Console exchanges its integration secret for a single-use CRM code
 * server-to-server; the browser only ever receives the resulting Support URL.
 * Mirrors the Studio and Pulse integrations so one CRM contract serves all
 * products.
 */
import { getConfig } from '@/lib/core/config';
import { createLogger } from '@/lib/core/logger';
import { getDatabase } from '@/lib/database';

const logger = createLogger('support-handoff');

const CRM_TIMEOUT_MS = 10_000;

export type SupportLocale = 'tr' | 'en';

export type SupportHandoffResult =
  | { ok: true; url: string; diagnosticsUnavailable?: true }
  | { ok: false; status: number; message: string };

export type SupportHandoffInput = {
  tenantId: string;
  userId: string;
  userEmail: string;
  locale: SupportLocale;
  summary?: string;
  diagnostics?: Record<string, unknown>;
};

/** True when a handoff code can actually be issued, which needs all three values. */
export function isSupportConfigured() {
  const { support } = getConfig();
  return Boolean(support.baseUrl && support.crmApiUrl && support.handoffSecret);
}

/** True when Support is reachable at all, even if handoffs cannot be issued. */
export function isSupportReachable() {
  return Boolean(getConfig().support.baseUrl);
}

/**
 * Whether a Support entry point can be shown. Reachability alone is not enough:
 * on SaaS without CRM credentials every click would end in a 503, while on-prem
 * the same setup still lands the user on the Support login.
 */
export function isSupportEntryPointEnabled() {
  return isSupportConfigured()
    || (getConfig().deployment.isOnPrem && isSupportReachable());
}

/**
 * On-prem deployments often point at Support without holding CRM credentials.
 * Sending the user to the Support login beats failing the action outright.
 */
function loginFallback(locale: SupportLocale): SupportHandoffResult | null {
  const { support, deployment } = getConfig();
  if (!deployment.isOnPrem || !support.baseUrl) return null;

  const url = new URL(`/${locale}/login`, support.baseUrl);
  url.searchParams.set('diagnostics', 'unavailable');
  return { ok: true, url: url.toString(), diagnosticsUnavailable: true };
}

async function postToCrm(path: string, payload: unknown) {
  const { support } = getConfig();
  const response = await fetch(`${support.crmApiUrl}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${support.handoffSecret}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(CRM_TIMEOUT_MS),
  });
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  return { ok: response.ok, status: response.status, body };
}

async function createDiagnosticDraft(
  input: SupportHandoffInput,
  tenantId: string,
): Promise<string | null> {
  const draft = await postToCrm('/api/internal-support/v1/diagnostic-drafts', {
    issuer: 'console',
    requesterEmail: input.userEmail,
    externalInstallationId: tenantId,
    summary: input.summary?.trim().slice(0, 500) || 'Console application error',
    diagnostics: input.diagnostics,
  });

  if (!draft.ok || typeof draft.body.id !== 'string') {
    logger.warn('CRM rejected the Support diagnostic draft', { statusCode: draft.status });
    return null;
  }
  return draft.body.id;
}

/**
 * The CRM stores this as the customer's display name, so support staff and
 * notification emails address a person rather than an address. A lookup failure
 * must not block the handoff.
 */
async function resolveUserName(
  input: SupportHandoffInput,
  tenantDbName: string,
  email: string,
): Promise<string> {
  try {
    const db = await getDatabase();
    await db.switchToTenant(tenantDbName);
    db.assertTenantContext?.(tenantDbName);
    const user = await db.findUserById(input.userId);
    return user?.name?.trim() || email;
  } catch (error) {
    logger.warn('Support handoff could not resolve the user name', {
      error: error instanceof Error ? error.message : String(error),
    });
    return email;
  }
}

export async function createSupportHandoff(
  input: SupportHandoffInput,
): Promise<SupportHandoffResult> {
  const { support } = getConfig();

  if (!support.baseUrl) {
    return { ok: false, status: 503, message: 'Support integration is not configured.' };
  }
  if (!support.crmApiUrl || !support.handoffSecret) {
    return (
      loginFallback(input.locale)
      ?? { ok: false, status: 503, message: 'Support integration is not configured.' }
    );
  }

  // The CRM identifies the customer by tenant, and requires its display name.
  const db = await getDatabase();
  const tenant = await db.findTenantById(input.tenantId);
  if (!tenant) {
    return { ok: false, status: 403, message: 'Support access denied.' };
  }

  const email = input.userEmail.trim().toLowerCase();
  if (!email) {
    return { ok: false, status: 403, message: 'Support access denied.' };
  }

  const userName = await resolveUserName(input, tenant.dbName, email);

  try {
    let diagnosticDraftId: string | undefined;
    if (input.diagnostics) {
      const draftId = await createDiagnosticDraft(input, input.tenantId);
      if (!draftId) {
        return (
          loginFallback(input.locale)
          ?? { ok: false, status: 502, message: 'Error details could not be prepared for Support.' }
        );
      }
      diagnosticDraftId = draftId;
    }

    const handoff = await postToCrm('/api/internal-support/v1/handoffs', {
      issuer: 'console',
      email,
      externalInstallationId: input.tenantId,
      diagnosticDraftId,
      context: {
        workspaceName: tenant.companyName,
        // A Console tenant is both the customer and the workspace, so the CRM
        // derives an issuer-scoped organization key from the tenant id. Sending
        // the slug here would anchor support history to a renameable value.
        organizationId: null,
        userId: input.userId,
        userName,
      },
    });

    if (!handoff.ok || typeof handoff.body.code !== 'string') {
      logger.warn('CRM rejected the Support handoff', { statusCode: handoff.status });
      return handoff.status === 404 || handoff.status === 403
        ? { ok: false, status: 403, message: 'Support access denied.' }
        : { ok: false, status: 502, message: 'Support access could not be created.' };
    }

    const callbackUrl = new URL('/api/auth/handoff', support.baseUrl);
    callbackUrl.searchParams.set('code', handoff.body.code);
    callbackUrl.searchParams.set('locale', input.locale);
    return { ok: true, url: callbackUrl.toString() };
  } catch (error) {
    logger.warn('Support handoff request failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return (
      loginFallback(input.locale)
      ?? { ok: false, status: 502, message: 'Support service is unavailable.' }
    );
  }
}
