'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActionIcon,
  AppShell,
  Button,
  Group,
  Stack,
  Text,
  useComputedColorScheme,
} from '@mantine/core';
import { IconExternalLink, IconX } from '@tabler/icons-react';
import { buildDocsUrl, type ResolvedDoc } from '@/lib/docs/docsLinks';

/**
 * The docs panel beside the dashboard: the docs site in a frame, in its embed mode (`embed=1`: no
 * site navigation, sidebar or footer; `theme` = the console's colour scheme when the page opens).
 *
 * In embed mode the site posts `{ source: 'cognipeer-docs', type: 'navigate', path, hash, title }`
 * to this window for every page it shows, so "Open" opens the page the reader is on, not the one
 * the panel started with. The console posts `{ source: 'cognipeer-console', type: 'theme', theme }`
 * when its scheme changes, which restyles the page without reloading it. A docs site this browser
 * cannot reach (an install without internet access, a blocked host) gets a notice and a link
 * instead of an empty frame.
 */

interface DocsAsideProps {
  /** Root of the docs site (DOCS_BASE_URL). */
  baseUrl: string;
  doc: ResolvedDoc;
  /** Changes with every request to open a page, so asking for the page again goes back to it. */
  requestId: number;
  onClose: () => void;
}

/** The page the frame shows, as the docs site reports it. */
type ShownPage = { path: string; hash: string; title?: string };

export default function DocsAside({ baseUrl, doc, requestId, onClose }: DocsAsideProps) {
  const colorScheme = useComputedColorScheme('light');
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const docsOrigin = useMemo(() => new URL(baseUrl).origin, [baseUrl]);
  const reachable = useDocsReachable(baseUrl);
  const [shown, setShown] = useState<ShownPage | null>(null);

  // The frame starts in the scheme of the moment it is asked for; later changes go by message.
  const schemeRef = useRef(colorScheme);
  schemeRef.current = colorScheme;
  const src = useMemo(
    () => buildDocsUrl(baseUrl, doc.path, { embed: '1', theme: schemeRef.current }),
    // requestId: a new request reloads the page even when the path is the same.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [baseUrl, doc.path, requestId],
  );

  // A new page starts over: nothing reported yet, not loaded, in the scheme of its address.
  const [frameLoaded, setFrameLoaded] = useState(false);
  const postedSchemeRef = useRef(colorScheme);
  useEffect(() => {
    setShown(null);
    setFrameLoaded(false);
    postedSchemeRef.current = schemeRef.current;
  }, [src]);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== docsOrigin || event.source !== iframeRef.current?.contentWindow) return;
      const data: unknown = event.data;
      if (!data || typeof data !== 'object') return;
      const message = data as Record<string, unknown>;
      if (message.source !== 'cognipeer-docs' || message.type !== 'navigate') return;
      if (typeof message.path !== 'string' || !message.path.startsWith('/')) return;
      setShown({
        path: message.path,
        hash: typeof message.hash === 'string' && message.hash.startsWith('#') ? message.hash : '',
        title: typeof message.title === 'string' ? message.title : undefined,
      });
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [docsOrigin]);

  // A change of scheme while a page is open goes to the page by message.
  useEffect(() => {
    if (!frameLoaded || postedSchemeRef.current === colorScheme) return;
    postedSchemeRef.current = colorScheme;
    iframeRef.current?.contentWindow?.postMessage(
      { source: 'cognipeer-console', type: 'theme', theme: colorScheme },
      docsOrigin,
    );
  }, [colorScheme, docsOrigin, frameLoaded]);

  const openHref = shown ? `${docsOrigin}${shown.path}${shown.hash}` : buildDocsUrl(baseUrl, doc.path);
  // VitePress titles a page "<page> | <site>".
  const title = shown?.title?.split(' | ')[0] || doc.title || 'Documentation';

  return (
    <AppShell.Aside p="md" withBorder>
      <Stack gap="md" h="100%" style={{ minHeight: 0 }}>
        <Group justify="space-between" align="center" wrap="nowrap">
          <div style={{ minWidth: 0 }}>
            <Text fw={600}>Documentation</Text>
            <Text size="sm" c="dimmed" mt={4} lineClamp={1}>
              {title}
            </Text>
          </div>
          <Group gap="xs" wrap="nowrap">
            <Button
              component="a"
              href={openHref}
              target="_blank"
              rel="noopener noreferrer"
              variant="light"
              leftSection={<IconExternalLink size={16} />}
            >
              Open
            </Button>
            <ActionIcon variant="light" aria-label="Close documentation" onClick={onClose}>
              <IconX size={16} />
            </ActionIcon>
          </Group>
        </Group>

        <div style={{ flex: 1, minHeight: 0 }}>
          {reachable === false ? (
            <Stack gap="xs" p="md" className="ds-card">
              <Text fw={600} size="sm">
                The documentation site can&apos;t be reached from this browser
              </Text>
              <Text size="sm" c="dimmed">
                {docsOrigin} did not answer. If this installation has no internet access, an
                administrator can point DOCS_BASE_URL at a copy of the documentation that it can
                reach.
              </Text>
              <Button
                component="a"
                href={openHref}
                target="_blank"
                rel="noopener noreferrer"
                variant="default"
                size="xs"
                leftSection={<IconExternalLink size={14} />}
                style={{ alignSelf: 'flex-start' }}
              >
                Open in a new tab
              </Button>
            </Stack>
          ) : (
            <iframe
              ref={iframeRef}
              title={title}
              src={src}
              onLoad={() => setFrameLoaded(true)}
              style={{ width: '100%', height: '100%', border: 0, borderRadius: 12 }}
              sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox"
            />
          )}
        </div>
      </Stack>
    </AppShell.Aside>
  );
}

/**
 * Whether the docs site answers from this browser: null while asking, false when the request
 * fails or takes longer than 8 seconds. An opaque (`no-cors`) request is enough to tell a host
 * that answers from one that does not, and reads nothing from it.
 */
function useDocsReachable(baseUrl: string): boolean | null {
  const [reachable, setReachable] = useState<boolean | null>(null);
  useEffect(() => {
    let settled = false;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    setReachable(null);
    fetch(`${baseUrl}/`, { mode: 'no-cors', cache: 'no-store', credentials: 'omit', signal: controller.signal })
      .then(() => {
        if (!settled) setReachable(true);
      })
      .catch(() => {
        if (!settled) setReachable(false);
      })
      .finally(() => clearTimeout(timer));
    return () => {
      settled = true;
      clearTimeout(timer);
      controller.abort();
    };
  }, [baseUrl]);
  return reachable;
}
