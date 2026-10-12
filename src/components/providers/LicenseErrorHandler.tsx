'use client';

import { useEffect, useRef } from 'react';
import { notifications } from '@mantine/notifications';
import { useTranslations } from '@/lib/i18n';

type LicenseErrorPayload = {
  error?: string;
  message?: string;
  requiredLicense?: string;
};

/**
 * A 403 body that means "your licence does not include this" (as opposed to "your
 * access does not include this"): the licence gate answers `error: 'Forbidden'`
 * with a message about the licence. A service denial of the authorization engine
 * words its `error` as "Forbidden: <service> requires <level> permission", so it
 * never matches - not even for the service that is called `license`.
 */
export function isLicenseErrorPayload(payload: unknown): payload is LicenseErrorPayload {
  if (!payload || typeof payload !== 'object') {
    return false;
  }

  const record = payload as Record<string, unknown>;
  return (
    record.error === 'Forbidden' &&
    typeof record.message === 'string' &&
    record.message.toLowerCase().includes('license')
  );
}

/**
 * The answer of a request the authorization engine could not decide (HTTP 503):
 * `{ error, code: 'authorization_unavailable', decisionId }`. Not a denial - nobody
 * was refused by a rule - so it is told apart from the 403s above.
 */
export function isAuthorizationUnavailablePayload(payload: unknown): boolean {
  return !!payload && typeof payload === 'object' && (payload as Record<string, unknown>).code === 'authorization_unavailable';
}

export default function LicenseErrorHandler() {
  const lastNotificationRef = useRef<{ key: string; timestamp: number }>({
    key: '',
    timestamp: 0,
  });
  const lastUnavailableRef = useRef(0);
  // The wrapper below is installed once; it reads the current words from here.
  const t = useTranslations('authorizationNotice');
  const tRef = useRef(t);
  tRef.current = t;

  useEffect(() => {
    const originalFetch = window.fetch.bind(window);

    window.fetch = (async (...args: Parameters<typeof fetch>) => {
      const response = await originalFetch(...args);

      if (response.status === 403) {
        try {
          const payload = (await response.clone().json()) as unknown;
          if (isLicenseErrorPayload(payload)) {
            const title = 'License required';
            const message = [payload.message, payload.requiredLicense]
              .filter(Boolean)
              .join(' — ');
            const key = `${payload.error}|${payload.message}|${payload.requiredLicense ?? ''}`;
            const now = Date.now();
            const shouldShow =
              lastNotificationRef.current.key !== key ||
              now - lastNotificationRef.current.timestamp > 4000;

            if (shouldShow) {
              notifications.show({
                title,
                message,
                color: 'orange',
                autoClose: 5000,
              });
              lastNotificationRef.current = { key, timestamp: now };
            }
          }
        } catch {
          // Ignore non-JSON or unparsable responses.
        }
      }

      if (response.status === 503) {
        try {
          const payload = (await response.clone().json()) as unknown;
          if (isAuthorizationUnavailablePayload(payload)) {
            const now = Date.now();
            // A page fires several requests at once: one notice is enough.
            if (now - lastUnavailableRef.current > 8000) {
              lastUnavailableRef.current = now;
              notifications.show({
                title: tRef.current('title'),
                message: tRef.current('message'),
                color: 'yellow',
                autoClose: 7000,
              });
            }
          }
        } catch {
          // Ignore non-JSON or unparsable responses.
        }
      }

      return response;
    }) as typeof fetch;

    return () => {
      window.fetch = originalFetch;
    };
  }, []);

  return null;
}
