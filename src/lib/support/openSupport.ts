'use client';

import { apiRequest } from '@/lib/api/client';

type HandoffResponse = { url: string; diagnosticsUnavailable?: boolean };

export type SupportDiagnostic = {
  summary: string;
  category?: string;
  error?: { name?: string; message?: string; stack?: string; digest?: string };
  requestId?: string;
};

/** Everything the CRM needs to reproduce the problem; it redacts on its side. */
function buildDiagnostics(diagnostic: SupportDiagnostic) {
  return {
    category: diagnostic.category ?? 'application_error',
    error: diagnostic.error,
    requestId: diagnostic.requestId,
    page: window.location.pathname,
    environment: process.env.NEXT_PUBLIC_ENV || process.env.NODE_ENV,
    occurredAt: new Date().toISOString(),
  };
}

/**
 * Opens Support in a new tab. The tab is opened before the request so the
 * browser attributes it to the click and does not block it as a popup.
 */
export async function openSupport(
  locale: 'tr' | 'en' = 'tr',
  diagnostic?: SupportDiagnostic,
): Promise<boolean> {
  const supportWindow = window.open('about:blank', '_blank');
  if (!supportWindow) return false;
  supportWindow.opener = null;

  try {
    const response = await apiRequest<HandoffResponse>('/api/support/handoff', {
      method: 'POST',
      body: JSON.stringify({
        locale,
        ...(diagnostic
          ? {
            summary: diagnostic.summary.slice(0, 500),
            diagnostics: buildDiagnostics(diagnostic),
          }
          : {}),
      }),
    });
    supportWindow.location.replace(response.url);
    return true;
  } catch (error) {
    supportWindow.close();
    console.error('Support handoff failed', error);
    return false;
  }
}

/** Lets a client surface hide its Support action when no handoff can be issued. */
export async function isSupportAvailable(): Promise<boolean> {
  try {
    const response = await apiRequest<{ enabled: boolean }>('/api/support/status');
    return response.enabled === true;
  } catch {
    return false;
  }
}
