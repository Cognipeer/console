/**
 * Smoke-test HTTP client.
 *
 * A thin wrapper around `fetch` that:
 *  - keeps a cookie jar so the session (`token`) and active-project cookies set
 *    by `/api/auth/register` flow into every subsequent dashboard request, the
 *    same way a browser would;
 *  - records every step (name, method, path, expected/actual status, ms,
 *    pass/fail/skip) into a shared report so the orchestrator can summarize.
 */

export type StepStatus = 'pass' | 'fail' | 'skip';

export interface StepResult {
  module: string;
  name: string;
  method: string;
  path: string;
  expected: string;
  actualStatus: number | null;
  status: StepStatus;
  durationMs: number;
  detail?: string;
}

export interface ApiResponse<T = unknown> {
  status: number;
  ok: boolean;
  body: T;
  raw: string;
}

/** Parse a Set-Cookie header value into a `name=value` pair. */
function parseCookie(setCookie: string): { name: string; value: string } | null {
  const first = setCookie.split(';')[0];
  const eq = first.indexOf('=');
  if (eq === -1) {
    return null;
  }
  return { name: first.slice(0, eq).trim(), value: first.slice(eq + 1).trim() };
}

export class SmokeClient {
  private readonly cookies = new Map<string, string>();
  readonly results: StepResult[] = [];
  currentModule = 'general';

  constructor(private readonly baseUrl: string) {}

  cookieHeader(): string {
    return Array.from(this.cookies.entries())
      .map(([name, value]) => `${name}=${value}`)
      .join('; ');
  }

  hasSession(): boolean {
    return this.cookies.has('token');
  }

  private storeCookies(response: Response): void {
    // Node's fetch exposes getSetCookie() for multiple Set-Cookie headers.
    const setCookies =
      typeof response.headers.getSetCookie === 'function'
        ? response.headers.getSetCookie()
        : [];
    for (const raw of setCookies) {
      const parsed = parseCookie(raw);
      if (!parsed) {
        continue;
      }
      // A cookie cleared with an empty value (logout) should be removed.
      if (parsed.value === '' || /expires=thu, 01 jan 1970/i.test(raw)) {
        this.cookies.delete(parsed.name);
      } else {
        this.cookies.set(parsed.name, parsed.value);
      }
    }
  }

  async request<T = unknown>(
    method: string,
    path: string,
    options: { body?: unknown; headers?: Record<string, string> } = {},
  ): Promise<ApiResponse<T>> {
    const headers: Record<string, string> = { ...(options.headers ?? {}) };
    const cookie = this.cookieHeader();
    if (cookie) {
      headers.cookie = cookie;
    }
    let payload: string | undefined;
    if (options.body !== undefined) {
      headers['content-type'] = headers['content-type'] ?? 'application/json';
      payload =
        typeof options.body === 'string'
          ? options.body
          : JSON.stringify(options.body);
    }

    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: payload,
    });
    this.storeCookies(response);

    const raw = await response.text();
    let body: T;
    try {
      body = raw ? (JSON.parse(raw) as T) : (undefined as T);
    } catch {
      body = raw as unknown as T;
    }

    return { status: response.status, ok: response.ok, body, raw };
  }

  /**
   * Run a single labelled step. `expect` is the set of acceptable status codes.
   * Returns the response so a suite can chain (e.g. grab a created id), or null
   * if the step failed (so callers can short-circuit dependent steps).
   */
  async step<T = unknown>(
    name: string,
    method: string,
    path: string,
    expect: number[],
    options: { body?: unknown; headers?: Record<string, string> } = {},
  ): Promise<ApiResponse<T> | null> {
    const startedAt = Date.now();
    let res: ApiResponse<T> | null = null;
    let detail: string | undefined;
    let actualStatus: number | null = null;
    try {
      res = await this.request<T>(method, path, options);
      actualStatus = res.status;
      if (!expect.includes(res.status)) {
        const snippet = res.raw ? res.raw.slice(0, 300) : '';
        detail = `expected ${expect.join('|')}, got ${res.status}. body: ${snippet}`;
      }
    } catch (error) {
      detail = error instanceof Error ? error.message : String(error);
    }

    const passed = res !== null && expect.includes(res.status);
    this.results.push({
      module: this.currentModule,
      name,
      method,
      path,
      expected: expect.join('|'),
      actualStatus,
      status: passed ? 'pass' : 'fail',
      durationMs: Date.now() - startedAt,
      detail,
    });

    const icon = passed ? '✓' : '✗';
    const statusLabel = actualStatus ?? 'ERR';
     
    console.log(
      `  ${icon} [${this.currentModule}] ${name} — ${method} ${path} → ${statusLabel}${
        passed ? '' : `  (${detail ?? 'failed'})`
      }`,
    );

    return passed ? res : null;
  }

  /** Record a step that was intentionally not run (missing prerequisite). */
  skip(name: string, reason: string): void {
    this.results.push({
      module: this.currentModule,
      name,
      method: '-',
      path: '-',
      expected: '-',
      actualStatus: null,
      status: 'skip',
      durationMs: 0,
      detail: reason,
    });
     
    console.log(`  ○ [${this.currentModule}] ${name} — skipped (${reason})`);
  }
}
