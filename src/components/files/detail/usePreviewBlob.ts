'use client';

/**
 * A PDF for the drawer's inline preview.
 *
 * The preview address itself cannot be put in a frame: every `/api` answer forbids being framed and the preview
 * route sandboxes what it serves. So the bytes are fetched here (same origin, with the session) and shown from a
 * `blob:` address of this page. The blob is typed `application/pdf` by us, never by the server's header, so the
 * browser can only ever open it as a PDF.
 */

import { useEffect, useState } from 'react';
import { FilesApiError, objectPreviewUrl } from '../filesApi';

export type PreviewBlobState =
  | { status: 'loading' }
  | { status: 'ready'; url: string }
  | { status: 'error'; error: FilesApiError };

interface Settled {
  /** Which file this answer is for: an answer for another file is not shown. */
  id: string;
  url?: string;
  error?: FilesApiError;
}

export function usePreviewBlob(bucketKey: string, key: string, enabled: boolean): PreviewBlobState {
  const [settled, setSettled] = useState<Settled | null>(null);
  const id = `${bucketKey}\u0000${key}`;

  useEffect(() => {
    if (!enabled) return undefined;
    const controller = new AbortController();
    let objectUrl: string | null = null;

    void (async () => {
      try {
        const response = await fetch(objectPreviewUrl(bucketKey, key), { cache: 'no-store', signal: controller.signal });
        if (!response.ok) throw await FilesApiError.fromResponse(response);
        const bytes = await response.arrayBuffer();
        if (controller.signal.aborted) return;
        objectUrl = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
        setSettled({ id, url: objectUrl });
      } catch (error) {
        if (controller.signal.aborted) return;
        setSettled({ id, error: error instanceof FilesApiError ? error : FilesApiError.network(error) });
      }
    })();

    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      setSettled((current) => (current?.id === id ? null : current));
    };
  }, [bucketKey, key, enabled, id]);

  const current = enabled && settled?.id === id ? settled : null;
  if (current?.url) return { status: 'ready', url: current.url };
  if (current?.error) return { status: 'error', error: current.error };
  return { status: 'loading' };
}
