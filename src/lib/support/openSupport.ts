'use client';

import { apiRequest } from '@/lib/api/client';

type HandoffResponse = { url: string; diagnosticsUnavailable?: boolean };

/**
 * Opens Support in a new tab. The tab is opened before the request so the
 * browser attributes it to the click and does not block it as a popup.
 */
export async function openSupport(locale: 'tr' | 'en' = 'tr'): Promise<boolean> {
  const supportWindow = window.open('about:blank', '_blank');
  if (!supportWindow) return false;
  supportWindow.opener = null;

  try {
    const response = await apiRequest<HandoffResponse>('/api/support/handoff', {
      method: 'POST',
      body: JSON.stringify({ locale }),
    });
    supportWindow.location.replace(response.url);
    return true;
  } catch (error) {
    supportWindow.close();
    console.error('Support handoff failed', error);
    return false;
  }
}
