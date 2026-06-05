/**
 * Central Configuration Module
 *
 * All application configuration flows through this module.
 * The ConfigSource abstraction allows swapping ENV for a settings page,
 * database, or any other source in the future.
 *
 * Usage:
 *   import { getConfig } from '@/lib/core/config';
 *   const cfg = getConfig();
 *   cfg.database.uri  // typed, validated, with defaults
 */

/* ------------------------------------------------------------------ */
/*  Config Source Abstraction                                          */
/* ------------------------------------------------------------------ */

export interface ConfigSource {
  /** Human-readable name for diagnostics */
  readonly name: string;
  /** Read a raw string value by key. Returns undefined when missing. */
  get(key: string): string | undefined;
}

/** Default source: reads from process.env */
class EnvConfigSource implements ConfigSource {
  readonly name = 'env';
  get(key: string): string | undefined {
    return process.env[key];
  }
}

/* ------------------------------------------------------------------ */
/*  Typed Config Shape                                                */
/* ------------------------------------------------------------------ */

export interface AppConfig {
  nodeEnv: string;

  license: {
    enforceLicense: boolean;
    offlinePublicKey: string;
    offlinePublicKeyPath: string;
    issuer: string;
    audience: string;
    /** Deployment-wide signed ENTERPRISE license (JWT). On-prem enterprise edition. */
    deploymentKey: string;
    /** If set, the deployment license must be bound to this tenant slug. */
    tenantSlug: string;
    /** Days after `exp` that an expired license still activates (with a warning). */
    graceDays: number;
  };

  database: {
    provider: 'mongodb' | 'sqlite';
    uri: string;
    mainDbName: string;
    dataDir: string;
    minPoolSize: number;
    maxPoolSize: number;
    connectTimeoutMs: number;
    socketTimeoutMs: number;
    serverSelectionTimeoutMs: number;
  };

  auth: {
    jwtSecret: string;
    jwtExpiresIn: string;
    providerEncryptionSecret: string;
  };

  smtp: {
    host: string;
    port: number;
    secure: boolean;
    user: string;
    pass: string;
    from: string;
  };

  gateway: {
    requestTimeoutMs: number;
    retryEnabled: boolean;
    retryMaxAttempts: number;
    retryInitialDelayMs: number;
    circuitBreakerEnabled: boolean;
    circuitBreakerThreshold: number;
    circuitBreakerResetMs: number;
  };

  cache: {
    provider: 'none' | 'memory' | 'redis';
    ttlSeconds: number;
    redis: {
      url: string;
      keyPrefix: string;
    };
  };

  rateLimit: {
    provider: 'mongodb' | 'memory' | 'redis';
    syncIntervalMs: number;
  };

  logging: {
    level: 'error' | 'warn' | 'info' | 'debug';
    format: 'json' | 'pretty';
    logRequestBody: boolean;
    logResponseBody: boolean;
  };

  cors: {
    enabled: boolean;
    allowedOrigins: string[];
    maxAge: number;
  };

  health: {
    endpointEnabled: boolean;
  };

  limits: {
    bodySize: string;
    tracingMaxBodySizeMb: number;
    fileUploadMaxMb: number;
    fileUploadAllowedMimeTypes: string[];
  };

  app: {
    url: string;
    shutdownTimeoutMs: number;
  };

  providerRuntime: {
    cacheTtlSeconds: number;
  };

  browser: {
    /** Concurrency limiter provider (in-memory or future redis). */
    concurrencyProvider: 'memory';
    /** Default per-tenant maximum concurrent live browser sessions. */
    defaultMaxConcurrent: number;
    /** Auto-close session after N ms with no activity. */
    defaultIdleTimeoutMs: number;
    /** Hard upper bound on session lifetime (ms). */
    defaultMaxLifetimeMs: number;
    /** Default Playwright headless mode. */
    headless: boolean;
    /** Default viewport width. */
    viewportWidth: number;
    /** Default viewport height. */
    viewportHeight: number;
    /** Reaper sweep interval (ms). */
    reaperIntervalMs: number;
    /** Bucket key used for browser artifacts when none is provided. */
    defaultArtifactBucketKey: string;
    /** Block localhost/private network egress from managed browser sessions. */
    blockPrivateNetwork: boolean;
  };

  jsSandbox: {
    concurrencyProvider: 'memory';
    defaultMaxConcurrent: number;
    defaultTimeoutMs: number;
    maxTimeoutMs: number;
    memoryLimitMb: number;
    maxCodeSizeBytes: number;
    maxResultSizeBytes: number;
    maxLogEntries: number;
    childProcessTimeoutBufferMs: number;
  };

  systemModels: {
    openai: {
      apiKey: string;
      organizationId: string;
    };
    bedrock: {
      accessKeyId: string;
      secretAccessKey: string;
      region: string;
    };
    together: {
      apiKey: string;
    };
    vertex: {
      projectId: string;
      location: string;
      /** Full service account key JSON string */
      serviceAccountKey: string;
    };
  };

  node: {
    /** Deployment role of this process. */
    role: 'main' | 'worker' | 'all';
    /** Unique name across the cluster. Defaults to hostname-pid when empty. */
    name: string;
    /** Public URL of this node (informational). */
    url: string;
    /** Free-form tags for grouping. */
    tags: string[];
    /** Heartbeat write interval in ms. */
    heartbeatMs: number;
    /** Nodes with last heartbeat older than this are marked offline. */
    offlineAfterMs: number;
    /** Default node name for instance assignments. Empty = first main node. */
    defaultNodeName: string;
  };

  queue: {
    /** auto = bullmq when Redis is configured, otherwise memory. */
    provider: 'auto' | 'memory' | 'bullmq';
    redis: {
      /** Falls back to cache.redis.url when empty. */
      url: string;
      prefix: string;
    };
    defaultAttempts: number;
    defaultBackoffMs: number;
  };
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                           */
/* ------------------------------------------------------------------ */

function str(source: ConfigSource, key: string, fallback: string): string {
  return source.get(key) ?? fallback;
}

function int(source: ConfigSource, key: string, fallback: number): number {
  const raw = source.get(key);
  if (raw === undefined || raw === '') return fallback;
  const parsed = parseInt(raw, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

function bool(source: ConfigSource, key: string, fallback: boolean): boolean {
  const raw = source.get(key);
  if (raw === undefined || raw === '') return fallback;
  return raw === 'true' || raw === '1';
}

function list(source: ConfigSource, key: string, fallback: string[]): string[] {
  const raw = source.get(key);
  if (!raw || raw.trim() === '') return fallback;
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

function oneOf<T extends string>(
  source: ConfigSource,
  key: string,
  allowed: T[],
  fallback: T,
): T {
  const raw = source.get(key);
  if (raw && allowed.includes(raw as T)) return raw as T;
  return fallback;
}

/* ------------------------------------------------------------------ */
/*  Config Builder                                                    */
/* ------------------------------------------------------------------ */

function buildConfig(source: ConfigSource): AppConfig {
  const nodeEnv = str(source, 'NODE_ENV', 'development');

  return {
    nodeEnv,

    license: {
      enforceLicense: bool(source, 'ENFORCE_LICENSE', false),
      offlinePublicKey: str(source, 'OFFLINE_LICENSE_PUBLIC_KEY', ''),
      offlinePublicKeyPath: str(source, 'OFFLINE_LICENSE_PUBLIC_KEY_PATH', ''),
      issuer: str(source, 'OFFLINE_LICENSE_ISSUER', 'cognipeer'),
      audience: str(source, 'OFFLINE_LICENSE_AUDIENCE', 'cognipeer-console'),
      deploymentKey: str(source, 'LICENSE_KEY', ''),
      tenantSlug: str(source, 'LICENSE_TENANT_SLUG', ''),
      graceDays: int(source, 'LICENSE_GRACE_DAYS', 14),
    },

    database: {
      provider: oneOf(source, 'DB_PROVIDER', ['mongodb', 'sqlite'], 'sqlite'),
      uri: str(source, 'MONGODB_URI', ''),
      mainDbName: str(source, 'MAIN_DB_NAME', 'console_main'),
      dataDir: str(source, 'SQLITE_DATA_DIR', './data'),
      minPoolSize: int(source, 'MONGODB_MIN_POOL_SIZE', 2),
      maxPoolSize: int(source, 'MONGODB_MAX_POOL_SIZE', 10),
      connectTimeoutMs: int(source, 'MONGODB_CONNECT_TIMEOUT_MS', 10000),
      socketTimeoutMs: int(source, 'MONGODB_SOCKET_TIMEOUT_MS', 45000),
      serverSelectionTimeoutMs: int(source, 'MONGODB_SERVER_SELECTION_TIMEOUT_MS', 30000),
    },

    auth: {
      jwtSecret: str(source, 'JWT_SECRET', 'jwt-key-change-me'),
      jwtExpiresIn: str(source, 'JWT_EXPIRES_IN', '7d'),
      providerEncryptionSecret: str(source, 'PROVIDER_ENCRYPTION_SECRET', ''),
    },

    smtp: {
      host: str(source, 'SMTP_HOST', 'smtp.gmail.com'),
      port: int(source, 'SMTP_PORT', 587),
      secure: bool(source, 'SMTP_SECURE', false),
      user: str(source, 'SMTP_USER', ''),
      pass: str(source, 'SMTP_PASS', ''),
      from: str(source, 'SMTP_FROM', '') || str(source, 'SMTP_USER', ''),
    },

    gateway: {
      requestTimeoutMs: int(source, 'GATEWAY_REQUEST_TIMEOUT_MS', 120000),
      retryEnabled: bool(source, 'GATEWAY_RETRY_ENABLED', true),
      retryMaxAttempts: int(source, 'GATEWAY_RETRY_MAX_ATTEMPTS', 3),
      retryInitialDelayMs: int(source, 'GATEWAY_RETRY_INITIAL_DELAY_MS', 200),
      circuitBreakerEnabled: bool(source, 'GATEWAY_CIRCUIT_BREAKER_ENABLED', true),
      circuitBreakerThreshold: int(source, 'GATEWAY_CIRCUIT_BREAKER_THRESHOLD', 5),
      circuitBreakerResetMs: int(source, 'GATEWAY_CIRCUIT_BREAKER_RESET_MS', 30000),
    },

    cache: {
      provider: oneOf(source, 'CACHE_PROVIDER', ['none', 'memory', 'redis'], 'memory'),
      ttlSeconds: int(source, 'CACHE_TTL_SECONDS', 300),
      redis: {
        url: str(source, 'REDIS_URL', ''),
        keyPrefix: str(source, 'REDIS_KEY_PREFIX', 'console:'),
      },
    },

    rateLimit: {
      provider: oneOf(source, 'RATE_LIMIT_PROVIDER', ['mongodb', 'memory', 'redis'], 'mongodb'),
      syncIntervalMs: int(source, 'RATE_LIMIT_SYNC_INTERVAL_MS', 5000),
    },

    logging: {
      level: oneOf(source, 'LOG_LEVEL', ['error', 'warn', 'info', 'debug'], nodeEnv === 'production' ? 'info' : 'debug'),
      format: oneOf(source, 'LOG_FORMAT', ['json', 'pretty'], nodeEnv === 'production' ? 'json' : 'pretty'),
      logRequestBody: bool(source, 'LOG_REQUEST_BODY', false),
      logResponseBody: bool(source, 'LOG_RESPONSE_BODY', false),
    },

    cors: {
      enabled: bool(source, 'CORS_ENABLED', false),
      allowedOrigins: list(source, 'CORS_ALLOWED_ORIGINS', []),
      maxAge: int(source, 'CORS_MAX_AGE', 86400),
    },

    health: {
      endpointEnabled: bool(source, 'HEALTH_ENDPOINT_ENABLED', true),
    },

    limits: {
      bodySize: str(source, 'NEXT_BODY_SIZE_LIMIT', '10mb'),
      tracingMaxBodySizeMb: int(source, 'TRACING_MAX_BODY_SIZE_MB', 10),
      fileUploadMaxMb: int(source, 'FILE_UPLOAD_MAX_MB', 50),
      // Empty list disables the allowlist (any MIME accepted). When non-empty,
      // only listed types are accepted. Wildcards like "image/*" are honored.
      fileUploadAllowedMimeTypes: list(source, 'FILE_UPLOAD_ALLOWED_MIME_TYPES', []),
    },

    app: {
      url: str(source, 'NEXT_PUBLIC_APP_URL', 'http://localhost:3000'),
      shutdownTimeoutMs: int(source, 'SHUTDOWN_TIMEOUT_MS', 15000),
    },

    providerRuntime: {
      cacheTtlSeconds: int(source, 'PROVIDER_RUNTIME_CACHE_TTL_SECONDS', 300),
    },

    browser: {
      concurrencyProvider: oneOf(source, 'BROWSER_CONCURRENCY_PROVIDER', ['memory'] as const, 'memory'),
      defaultMaxConcurrent: int(source, 'BROWSER_DEFAULT_MAX_CONCURRENT', 10),
      defaultIdleTimeoutMs: int(source, 'BROWSER_DEFAULT_IDLE_TIMEOUT_MS', 5 * 60 * 1000),
      defaultMaxLifetimeMs: int(source, 'BROWSER_DEFAULT_MAX_LIFETIME_MS', 30 * 60 * 1000),
      headless: bool(source, 'BROWSER_HEADLESS', true),
      viewportWidth: int(source, 'BROWSER_VIEWPORT_WIDTH', 1280),
      viewportHeight: int(source, 'BROWSER_VIEWPORT_HEIGHT', 800),
      reaperIntervalMs: int(source, 'BROWSER_REAPER_INTERVAL_MS', 30 * 1000),
      defaultArtifactBucketKey: str(source, 'BROWSER_DEFAULT_ARTIFACT_BUCKET', 'browser-artifacts'),
      blockPrivateNetwork: bool(source, 'BROWSER_BLOCK_PRIVATE_NETWORK', true),
    },

    jsSandbox: {
      concurrencyProvider: oneOf(source, 'JS_SANDBOX_CONCURRENCY_PROVIDER', ['memory'] as const, 'memory'),
      defaultMaxConcurrent: int(source, 'JS_SANDBOX_DEFAULT_MAX_CONCURRENT', 5),
      defaultTimeoutMs: int(source, 'JS_SANDBOX_DEFAULT_TIMEOUT_MS', 5_000),
      maxTimeoutMs: int(source, 'JS_SANDBOX_MAX_TIMEOUT_MS', 30_000),
      memoryLimitMb: int(source, 'JS_SANDBOX_MEMORY_LIMIT_MB', 64),
      maxCodeSizeBytes: int(source, 'JS_SANDBOX_MAX_CODE_SIZE_BYTES', 64 * 1024),
      maxResultSizeBytes: int(source, 'JS_SANDBOX_MAX_RESULT_SIZE_BYTES', 512 * 1024),
      maxLogEntries: int(source, 'JS_SANDBOX_MAX_LOG_ENTRIES', 100),
      childProcessTimeoutBufferMs: int(source, 'JS_SANDBOX_CHILD_PROCESS_TIMEOUT_BUFFER_MS', 1_000),
    },

    systemModels: {
      openai: {
        apiKey: str(source, 'SYSTEM_OPENAI_API_KEY', ''),
        organizationId: str(source, 'SYSTEM_OPENAI_ORG_ID', ''),
      },
      bedrock: {
        accessKeyId: str(source, 'SYSTEM_BEDROCK_ACCESS_KEY_ID', ''),
        secretAccessKey: str(source, 'SYSTEM_BEDROCK_SECRET_ACCESS_KEY', ''),
        region: str(source, 'SYSTEM_BEDROCK_REGION', 'us-east-1'),
      },
      together: {
        apiKey: str(source, 'SYSTEM_TOGETHER_API_KEY', ''),
      },
      vertex: {
        projectId: str(source, 'SYSTEM_VERTEX_PROJECT_ID', ''),
        location: str(source, 'SYSTEM_VERTEX_LOCATION', 'us-central1'),
        serviceAccountKey: str(source, 'SYSTEM_VERTEX_SERVICE_ACCOUNT_KEY', ''),
      },
    },

    node: {
      role: oneOf(source, 'NODE_ROLE', ['main', 'worker', 'all'] as const, 'all'),
      name: str(source, 'NODE_NAME', ''),
      url: str(source, 'NODE_URL', ''),
      tags: list(source, 'NODE_TAGS', []),
      heartbeatMs: int(source, 'NODE_HEARTBEAT_MS', 10_000),
      offlineAfterMs: int(source, 'NODE_OFFLINE_AFTER_MS', 30_000),
      defaultNodeName: str(source, 'CLUSTER_DEFAULT_NODE_NAME', ''),
    },

    queue: {
      provider: oneOf(source, 'QUEUE_PROVIDER', ['auto', 'memory', 'bullmq'] as const, 'auto'),
      redis: {
        url: str(source, 'QUEUE_REDIS_URL', ''),
        prefix: str(source, 'QUEUE_PREFIX', 'console:q:'),
      },
      defaultAttempts: int(source, 'QUEUE_DEFAULT_ATTEMPTS', 3),
      defaultBackoffMs: int(source, 'QUEUE_DEFAULT_BACKOFF_MS', 1_000),
    },
  };
}

/* ------------------------------------------------------------------ */
/*  Validation                                                        */
/* ------------------------------------------------------------------ */

export interface ConfigValidationError {
  key: string;
  message: string;
}

/**
 * Validate critical config values.  Returns an array of problems.
 * An empty array means the config is valid.
 */
export function validateConfig(cfg: AppConfig): ConfigValidationError[] {
  const errors: ConfigValidationError[] = [];

  if (cfg.database.provider === 'mongodb' && !cfg.database.uri) {
    errors.push({ key: 'MONGODB_URI', message: 'MongoDB connection string is required when DB_PROVIDER=mongodb' });
  }
  if (!cfg.auth.jwtSecret) {
    errors.push({ key: 'JWT_SECRET', message: 'JWT secret is required for authentication' });
  } else if (cfg.auth.jwtSecret.length < 32) {
    errors.push({
      key: 'JWT_SECRET',
      message: 'JWT_SECRET must be at least 32 characters (use a high-entropy random value)',
    });
  }
  if (!cfg.auth.providerEncryptionSecret) {
    errors.push({
      key: 'PROVIDER_ENCRYPTION_SECRET',
      message: 'PROVIDER_ENCRYPTION_SECRET is required to encrypt provider credentials at rest',
    });
  } else if (cfg.auth.providerEncryptionSecret.length < 32) {
    errors.push({
      key: 'PROVIDER_ENCRYPTION_SECRET',
      message: 'PROVIDER_ENCRYPTION_SECRET must be at least 32 characters',
    });
  } else if (cfg.auth.providerEncryptionSecret === cfg.auth.jwtSecret) {
    errors.push({
      key: 'PROVIDER_ENCRYPTION_SECRET',
      message: 'PROVIDER_ENCRYPTION_SECRET must not equal JWT_SECRET (use independent secrets)',
    });
  }
  if (cfg.cache.provider === 'redis' && !cfg.cache.redis.url) {
    errors.push({ key: 'REDIS_URL', message: 'Redis URL is required when CACHE_PROVIDER=redis' });
  }
  if (cfg.rateLimit.provider === 'redis' && !cfg.cache.redis.url) {
    errors.push({ key: 'REDIS_URL', message: 'Redis URL is required when RATE_LIMIT_PROVIDER=redis' });
  }
  if (
    (cfg.rateLimit.provider === 'redis' || cfg.rateLimit.provider === 'memory')
    && cfg.cache.provider !== cfg.rateLimit.provider
  ) {
    errors.push({
      key: 'CACHE_PROVIDER',
      message: `CACHE_PROVIDER must be ${cfg.rateLimit.provider} when RATE_LIMIT_PROVIDER=${cfg.rateLimit.provider}`,
    });
  }

  // Hard-fail if request/response body logging is enabled in production.
  // These flags expose secrets (auth headers, API keys, prompts) to logs.
  if (cfg.nodeEnv === 'production') {
    if (cfg.logging.logRequestBody) {
      errors.push({
        key: 'LOG_REQUEST_BODY',
        message: 'LOG_REQUEST_BODY must be false in production (leaks secrets / PII into logs)',
      });
    }
    if (cfg.logging.logResponseBody) {
      errors.push({
        key: 'LOG_RESPONSE_BODY',
        message: 'LOG_RESPONSE_BODY must be false in production (leaks secrets / PII into logs)',
      });
    }
  }

  return errors;
}

/* ------------------------------------------------------------------ */
/*  Singleton                                                         */
/* ------------------------------------------------------------------ */

let currentSource: ConfigSource = new EnvConfigSource();
let cachedConfig: AppConfig | null = null;

/**
 * Replace the config source (e.g. switch from ENV to database-backed config).
 * Invalidates the cached config so the next getConfig() call rebuilds.
 */
export function setConfigSource(source: ConfigSource): void {
  currentSource = source;
  cachedConfig = null;
}

/**
 * Get the current config source (for diagnostics / testing).
 */
export function getConfigSource(): ConfigSource {
  return currentSource;
}

/**
 * Get the application configuration (built & cached on first call).
 */
export function getConfig(): AppConfig {
  if (!cachedConfig) {
    cachedConfig = buildConfig(currentSource);
  }
  return cachedConfig;
}

/**
 * Force config reload (e.g. after ENV changes in tests).
 */
export function reloadConfig(): AppConfig {
  cachedConfig = null;
  return getConfig();
}
