'use client';

import { useEffect, useRef } from 'react';
import { notifications } from '@mantine/notifications';

type LicenseErrorPayload = {
  error?: string;
  message?: string;
  requiredLicense?: string;
};

function isLicenseErrorPayload(payload: unknown): payload is LicenseErrorPayload {
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

export default function LicenseErrorHandler() {
  const lastNotificationRef = useRef<{ key: string; timestamp: number }>({
    key: '',
    timestamp: 0,
  });

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

      return response;
    }) as typeof fetch;

    return () => {
      window.fetch = originalFetch;
    };
  }, []);

  return null;
}
