/**
 * Lightweight axios-based fetcher. Used for fast first-pass crawling or
 * when the user explicitly selects the `axios` engine.
 */

import axios from 'axios';
import https from 'node:https';
import iconv from 'iconv-lite';
import mime from 'mime-types';
import { parseContentTypeBase } from './normalize';
import { assertSafeUrl } from './ssrf';
import type { CrawlHttpConfig, CrawlerEngineMode } from './types';
import { DEFAULT_ACCEPT_LANGUAGE, DEFAULT_USER_AGENT } from './types';

// Reused across requests when allowInsecureTls is set, to avoid creating a
// fresh TLS agent (and losing keep-alive) per fetch.
const insecureAgent = new https.Agent({ rejectUnauthorized: false });

// The initial frontier URL is SSRF-checked by the caller (engine/index.ts),
// but axios happily follows a 3xx `Location` chain on its own — a public
// seed can redirect straight to `http://169.254.169.254/` (or any other
// private target) and axios would fetch it transparently, bypassing the
// guard entirely. To prevent that, redirects are followed manually here:
// each hop is re-validated with `assertSafeUrl()` before being requested.
const MAX_MANUAL_REDIRECTS = 5;

export interface FetchResult {
  type: 'html' | 'file';
  httpStatus: number;
  contentType: string;
  html?: string;
  htmlBytes?: number;
  fileBytes?: number;
  /** Raw bytes of a downloaded attachment. Present when `type === 'file'`. */
  fileBuffer?: Buffer;
}

export async function fetchWithAxios(
  url: string,
  http: CrawlHttpConfig,
  downloadableMimes: string[],
): Promise<FetchResult> {
  const timeout = http.timeoutMs ?? 30_000;
  const headers: Record<string, string> = {
    'User-Agent': http.userAgent ?? DEFAULT_USER_AGENT,
    Accept:
      'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': http.acceptLanguage ?? DEFAULT_ACCEPT_LANGUAGE,
    'Cache-Control': 'no-cache',
    Pragma: 'no-cache',
    ...(http.headers ?? {}),
  };
  if (http.cookies?.length) {
    headers.Cookie = http.cookies
      .map((c) => `${c.name}=${c.value}`)
      .join('; ');
  }
  if (http.bearerToken) {
    headers.Authorization = `Bearer ${http.bearerToken}`;
  }

  let currentUrl = url;

  for (let hop = 0; ; hop += 1) {
    const controller = new AbortController();
    const tid = setTimeout(() => controller.abort(), timeout + 2000);

    try {
      const response = await axios.get(currentUrl, {
        responseType: 'arraybuffer',
        headers,
        timeout,
        maxContentLength: 15 * 1024 * 1024,
        // Redirects are followed manually below so every hop can be
        // SSRF-checked before it's requested (see MAX_MANUAL_REDIRECTS doc).
        maxRedirects: 0,
        signal: controller.signal,
        auth: http.basicAuth,
        validateStatus: (status) => status < 400,
        httpsAgent: http.allowInsecureTls ? insecureAgent : undefined,
      });
      clearTimeout(tid);

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers['location'];
        if (!location) {
          throw new Error(`Redirect (${response.status}) from ${currentUrl} has no Location header`);
        }
        if (hop >= MAX_MANUAL_REDIRECTS) {
          throw new Error(`Too many redirects (>${MAX_MANUAL_REDIRECTS}) starting from ${url}`);
        }
        const nextUrl = new URL(location, currentUrl).toString();
        // Re-validate every redirect hop — a public seed can 302 to a
        // private/metadata host and must not be followed silently.
        assertSafeUrl(nextUrl, http.allowPrivateNetwork);
        currentUrl = nextUrl;
        continue;
      }

      const contentTypeRaw = String(response.headers['content-type'] ?? '');
      const contentType = parseContentTypeBase(contentTypeRaw);
      const disposition = String(response.headers['content-disposition'] ?? '').toLowerCase();
      const buffer = Buffer.from(response.data as ArrayBuffer);

      const isFile =
        disposition.includes('attachment') ||
        disposition.includes('filename') ||
        (contentType && !contentType.includes('text/html')) ||
        (contentType && downloadableMimes.includes(contentType));

      if (isFile) {
        return {
          type: 'file',
          httpStatus: response.status,
          contentType: contentType || mime.lookup(currentUrl) || 'application/octet-stream',
          fileBytes: buffer.length,
          fileBuffer: buffer,
        };
      }

      const html = decodeBuffer(buffer, contentTypeRaw);
      return {
        type: 'html',
        httpStatus: response.status,
        contentType: contentType || 'text/html',
        html,
        htmlBytes: buffer.length,
      };
    } catch (error) {
      clearTimeout(tid);
      if (axios.isAxiosError(error)) {
        if (error.code === 'ECONNABORTED' || error.code === 'ERR_CANCELED') {
          throw new Error(`Timeout fetching ${currentUrl} (${timeout}ms)`);
        }
        if (error.response) {
          throw new Error(`HTTP ${error.response.status} for ${currentUrl}`);
        }
      }
      throw new Error(`Axios error for ${currentUrl}: ${(error as Error).message}`);
    }
  }
}

function decodeBuffer(buffer: Buffer, contentType: string): string {
  const headerCharset = /charset=([^;\s]+)/i.exec(contentType)?.[1]?.toLowerCase();
  if (headerCharset && headerCharset !== 'utf-8' && headerCharset !== 'utf8') {
    try {
      return iconv.decode(buffer, headerCharset);
    } catch { /* fall through */ }
  }
  let utf8Text: string;
  try {
    utf8Text = buffer.toString('utf8');
  } catch {
    return iconv.decode(buffer, 'utf8');
  }
  const meta = /<meta[^>]*charset=["']?([^"'>\s]+)/i.exec(utf8Text)?.[1]?.toLowerCase();
  if (meta && meta !== 'utf-8' && meta !== 'utf8') {
    try {
      return iconv.decode(buffer, meta);
    } catch { /* fall through */ }
  }
  return utf8Text;
}

/** Forces axios route when the URL extension already implies a file. */
export function isFileByExtension(url: string, downloadableMimes: string[]): boolean {
  const ext = String(mime.lookup(url) || '').toLowerCase();
  return Boolean(ext && downloadableMimes.includes(ext));
}

/**
 * Derives a sensible file name for an attachment so the markdown converter
 * can pick the right parser (extension-driven). Falls back to the mime type
 * when the URL path has no usable file name (e.g. `/getFile?id=123`).
 */
export function deriveAttachmentFileName(url: string, contentType?: string): string {
  try {
    const { pathname } = new URL(url);
    const last = pathname.split('/').filter(Boolean).pop();
    if (last && last.includes('.')) return decodeURIComponent(last);
    const ext = contentType ? mime.extension(contentType) : '';
    return last ? `${decodeURIComponent(last)}.${ext || 'bin'}` : `attachment.${ext || 'bin'}`;
  } catch {
    return 'attachment';
  }
}

export const AXIOS_ENGINE_NAME: CrawlerEngineMode = 'axios';
