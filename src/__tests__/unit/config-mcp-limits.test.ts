import { afterEach, describe, expect, it } from 'vitest';
import { getConfig, getConfigSource, setConfigSource, type ConfigSource } from '@/lib/core/config';

const originalSource = getConfigSource();

function sourceWith(values: Record<string, string | undefined>): ConfigSource {
  return { name: 'test', get: (key) => values[key] };
}

afterEach(() => {
  setConfigSource(originalSource);
});

const DEFAULT_SSE = {
  maxSessions: 2000,
  maxSessionsPerIp: 50,
  idleTimeoutMs: 1_800_000,
  maxBufferedBytes: 8_388_608,
  keepaliveMs: 25_000,
};

const DEFAULT_STDIO = { maxConcurrent: 8, maxConcurrentPerTenant: 4 };

const DEFAULT_PUBLIC = {
  rateLimitPerMinute: 300,
  endpointRateLimitPerMinute: 6000,
  bodyLimitBytes: 1_048_576,
  maxInflightPerTenant: 100,
  logPayloadLimitBytes: 16_384,
};

describe('MCP gateway limits', () => {
  it('defaults to bounds generous enough not to change ordinary behaviour', () => {
    setConfigSource(sourceWith({}));
    expect(getConfig().mcp).toEqual({
      errorMessageMaxChars: 8192,
      lastErrorMaxChars: 2048,
      lastErrorThrottleMs: 60_000,
      logToolNameMaxChars: 200,
      logUserAgentMaxChars: 300,
      logClientMeta: true,
      logClientMetaMaxBytes: 2048,
      sse: DEFAULT_SSE,
      stdio: DEFAULT_STDIO,
      public: DEFAULT_PUBLIC,
    });
  });

  it('reads each limit from its environment variable', () => {
    setConfigSource(sourceWith({
      MCP_ERROR_MESSAGE_MAX_CHARS: '4000',
      MCP_LAST_ERROR_MAX_CHARS: '1000',
      MCP_LAST_ERROR_THROTTLE_MS: '5000',
      MCP_LOG_TOOL_NAME_MAX_CHARS: '120',
      MCP_LOG_USER_AGENT_MAX_CHARS: '150',
      MCP_LOG_CLIENT_META: 'false',
      MCP_LOG_CLIENT_META_MAX_BYTES: '4096',
    }));
    expect(getConfig().mcp).toEqual({
      errorMessageMaxChars: 4000,
      lastErrorMaxChars: 1000,
      lastErrorThrottleMs: 5000,
      logToolNameMaxChars: 120,
      logUserAgentMaxChars: 150,
      logClientMeta: false,
      logClientMetaMaxBytes: 4096,
      sse: DEFAULT_SSE,
      stdio: DEFAULT_STDIO,
      public: DEFAULT_PUBLIC,
    });
  });

  it('clamps a value that would leave nothing useful, and ignores one that is not a number', () => {
    setConfigSource(sourceWith({
      MCP_ERROR_MESSAGE_MAX_CHARS: '1',
      MCP_LAST_ERROR_MAX_CHARS: '-5',
      MCP_LAST_ERROR_THROTTLE_MS: '-1',
      MCP_LOG_TOOL_NAME_MAX_CHARS: '0',
      MCP_LOG_USER_AGENT_MAX_CHARS: 'abc',
      MCP_LOG_CLIENT_META_MAX_BYTES: '10',
    }));
    expect(getConfig().mcp).toEqual({
      errorMessageMaxChars: 256,
      lastErrorMaxChars: 64,
      lastErrorThrottleMs: 0,
      logToolNameMaxChars: 16,
      logUserAgentMaxChars: 300,
      logClientMeta: true,
      logClientMetaMaxBytes: 256,
      sse: DEFAULT_SSE,
      stdio: DEFAULT_STDIO,
      public: DEFAULT_PUBLIC,
    });
  });

  it('reads the SSE limits from their environment variables', () => {
    setConfigSource(sourceWith({
      MCP_SSE_MAX_SESSIONS: '500',
      MCP_SSE_MAX_SESSIONS_PER_IP: '10',
      MCP_SSE_IDLE_TIMEOUT_MS: '60000',
      MCP_SSE_MAX_BUFFERED_BYTES: '1048576',
      MCP_SSE_KEEPALIVE_MS: '10000',
    }));
    expect(getConfig().mcp.sse).toEqual({
      maxSessions: 500,
      maxSessionsPerIp: 10,
      idleTimeoutMs: 60_000,
      maxBufferedBytes: 1_048_576,
      keepaliveMs: 10_000,
    });
  });

  it('reads the public-endpoint limits from their environment variables', () => {
    setConfigSource(sourceWith({
      MCP_PUBLIC_RATE_LIMIT_PER_MINUTE: '60',
      MCP_PUBLIC_BODY_LIMIT_BYTES: '262144',
      MCP_PUBLIC_MAX_INFLIGHT_PER_TENANT: '20',
      MCP_PUBLIC_LOG_PAYLOAD_LIMIT_BYTES: '4096',
    }));
    expect(getConfig().mcp.public).toEqual({
      rateLimitPerMinute: 60,
      // Not set: twenty times the per-address rate.
      endpointRateLimitPerMinute: 1200,
      bodyLimitBytes: 262_144,
      maxInflightPerTenant: 20,
      logPayloadLimitBytes: 4096,
    });
  });

  describe('the request rate of a public endpoint as a whole', () => {
    const endpointRate = (values: Record<string, string | undefined>) => {
      setConfigSource(sourceWith(values));
      return getConfig().mcp.public.endpointRateLimitPerMinute;
    };

    it('defaults to twenty times the per-address rate', () => {
      expect(endpointRate({})).toBe(6000);
      expect(endpointRate({ MCP_PUBLIC_RATE_LIMIT_PER_MINUTE: '10' })).toBe(200);
      expect(endpointRate({ MCP_PUBLIC_RATE_LIMIT_PER_MINUTE: '1000' })).toBe(20_000);
    });

    it('reads MCP_PUBLIC_ENDPOINT_RATE_LIMIT_PER_MINUTE, whatever the per-address rate is', () => {
      expect(endpointRate({ MCP_PUBLIC_ENDPOINT_RATE_LIMIT_PER_MINUTE: '500' })).toBe(500);
      expect(endpointRate({ MCP_PUBLIC_ENDPOINT_RATE_LIMIT_PER_MINUTE: '500', MCP_PUBLIC_RATE_LIMIT_PER_MINUTE: '0' })).toBe(500);
      expect(endpointRate({ MCP_PUBLIC_ENDPOINT_RATE_LIMIT_PER_MINUTE: '50000', MCP_PUBLIC_RATE_LIMIT_PER_MINUTE: '5' })).toBe(50_000);
    });

    it('is switched off by 0 on its own', () => {
      expect(endpointRate({ MCP_PUBLIC_ENDPOINT_RATE_LIMIT_PER_MINUTE: '0' })).toBe(0);
      expect(getConfig().mcp.public.rateLimitPerMinute).toBe(300);
    });

    it('is off with the per-address rate when it is not set', () => {
      expect(endpointRate({ MCP_PUBLIC_RATE_LIMIT_PER_MINUTE: '0' })).toBe(0);
    });

    it('takes the default for a value that is empty, negative or not a number', () => {
      for (const value of ['', '-1', '-500', 'many']) {
        expect(endpointRate({ MCP_PUBLIC_ENDPOINT_RATE_LIMIT_PER_MINUTE: value }), JSON.stringify(value)).toBe(6000);
      }
    });
  });

  describe('the in-process rate limiter', () => {
    const trackedKeys = (values: Record<string, string | undefined>) => {
      setConfigSource(sourceWith(values));
      return getConfig().rateLimit.maxTrackedKeys;
    };

    it('keeps 100,000 counters by default', () => {
      expect(trackedKeys({})).toBe(100_000);
    });

    it('reads RATE_LIMIT_MAX_TRACKED_KEYS as a whole number from 1', () => {
      expect(trackedKeys({ RATE_LIMIT_MAX_TRACKED_KEYS: '2500' })).toBe(2500);
      expect(trackedKeys({ RATE_LIMIT_MAX_TRACKED_KEYS: '1' })).toBe(1);
      expect(trackedKeys({ RATE_LIMIT_MAX_TRACKED_KEYS: ' 250 ' })).toBe(250);
    });

    // Never unbounded and never tiny because of a slip: each of these is unset.
    it.each([
      ['an empty value', ''],
      ['blanks', '   '],
      ['zero', '0'],
      ['a negative number', '-4'],
      ['text', 'lots'],
      ['an exponent', '1e5'],
      ['a thousands separator', '100,000'],
      ['an underscore', '100_000'],
      ['trailing text', '12abc'],
      ['a fraction', '12.5'],
      ['a sign', '+5'],
      ['a number too large to be exact', '9007199254740993'],
    ])('takes the default for %s', (_label, value) => {
      expect(trackedKeys({ RATE_LIMIT_MAX_TRACKED_KEYS: value })).toBe(100_000);
    });

    it('does not read a value the way parseInt would', () => {
      // parseInt reads these two as 1 and 100, which would bound the limiter to a handful of counters.
      expect(parseInt('1e5', 10)).toBe(1);
      expect(parseInt('100,000', 10)).toBe(100);
      expect(trackedKeys({ RATE_LIMIT_MAX_TRACKED_KEYS: '1e5' })).toBe(100_000);
      expect(trackedKeys({ RATE_LIMIT_MAX_TRACKED_KEYS: '100,000' })).toBe(100_000);
    });
  });

  describe('the stdio pool', () => {
    it('shares the pool with each tenant by halves, but never less than one slot', () => {
      for (const [pool, share] of [['8', 4], ['10', 5], ['3', 1], ['1', 1], ['2', 1]] as const) {
        setConfigSource(sourceWith({ MCP_STDIO_MAX_CONCURRENT: pool }));
        expect(getConfig().mcp.stdio, pool).toEqual({ maxConcurrent: Number(pool), maxConcurrentPerTenant: share });
      }
    });

    it('takes a tenant share from MCP_STDIO_MAX_CONCURRENT_PER_TENANT, and 0 turns the share off', () => {
      setConfigSource(sourceWith({ MCP_STDIO_MAX_CONCURRENT: '8', MCP_STDIO_MAX_CONCURRENT_PER_TENANT: '6' }));
      expect(getConfig().mcp.stdio).toEqual({ maxConcurrent: 8, maxConcurrentPerTenant: 6 });
      setConfigSource(sourceWith({ MCP_STDIO_MAX_CONCURRENT_PER_TENANT: '0' }));
      expect(getConfig().mcp.stdio).toEqual({ maxConcurrent: 8, maxConcurrentPerTenant: 0 });
    });

    it('falls back to the defaults for a value that is empty, negative or not a number', () => {
      for (const value of ['', '-3', 'abc']) {
        setConfigSource(sourceWith({ MCP_STDIO_MAX_CONCURRENT_PER_TENANT: value }));
        expect(getConfig().mcp.stdio, JSON.stringify(value)).toEqual({ maxConcurrent: 8, maxConcurrentPerTenant: 4 });
      }
      setConfigSource(sourceWith({ MCP_STDIO_MAX_CONCURRENT: 'abc' }));
      expect(getConfig().mcp.stdio).toEqual({ maxConcurrent: 8, maxConcurrentPerTenant: 4 });
    });
  });

  it('lets 0 switch off the limits that can be switched off', () => {
    setConfigSource(sourceWith({
      MCP_SSE_MAX_SESSIONS: '0',
      MCP_SSE_MAX_SESSIONS_PER_IP: '0',
      MCP_SSE_IDLE_TIMEOUT_MS: '0',
      MCP_SSE_MAX_BUFFERED_BYTES: '0',
      MCP_SSE_KEEPALIVE_MS: '0',
      MCP_PUBLIC_RATE_LIMIT_PER_MINUTE: '0',
      MCP_PUBLIC_MAX_INFLIGHT_PER_TENANT: '0',
    }));
    expect(getConfig().mcp.sse).toEqual({
      maxSessions: 0,
      maxSessionsPerIp: 0,
      idleTimeoutMs: 0,
      maxBufferedBytes: 0,
      keepaliveMs: 0,
    });
    expect(getConfig().mcp.public.rateLimitPerMinute).toBe(0);
    expect(getConfig().mcp.public.endpointRateLimitPerMinute).toBe(0);
    expect(getConfig().mcp.public.maxInflightPerTenant).toBe(0);
  });

  it('clamps negative or unusable values, and ignores ones that are not numbers', () => {
    setConfigSource(sourceWith({
      MCP_SSE_MAX_SESSIONS: '-1',
      MCP_SSE_IDLE_TIMEOUT_MS: 'soon',
      MCP_PUBLIC_RATE_LIMIT_PER_MINUTE: '-30',
      MCP_PUBLIC_BODY_LIMIT_BYTES: '10',
      MCP_PUBLIC_LOG_PAYLOAD_LIMIT_BYTES: '0',
    }));
    expect(getConfig().mcp.sse).toEqual({ ...DEFAULT_SSE, maxSessions: 0 });
    expect(getConfig().mcp.public).toEqual({
      ...DEFAULT_PUBLIC,
      rateLimitPerMinute: 0,
      endpointRateLimitPerMinute: 0,
      bodyLimitBytes: 1024,
      logPayloadLimitBytes: 256,
    });
  });
});
