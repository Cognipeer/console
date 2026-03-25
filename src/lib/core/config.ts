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
  };

  app: {
    url: string;
    demoEmail: string;
    shutdownTimeoutMs: number;
  };

  providerRuntime: {
    cacheTtlSeconds: number;
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
      jwtSecret: str(source, 'JWT_SECRET', ''),
      jwtExpiresIn: str(source, 'JWT_EXPIRES_IN', '7d'),
      providerEncryptionSecret:
        str(source, 'PROVIDER_ENCRYPTION_SECRET', '') ||
        str(source, 'JWT_SECRET', ''),
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
    },

    app: {
      url: str(source, 'NEXT_PUBLIC_APP_URL', 'http://localhost:3000'),
      demoEmail: str(source, 'DEMO_EMAIL', ''),
      shutdownTimeoutMs: int(source, 'SHUTDOWN_TIMEOUT_MS', 15000),
    },

    providerRuntime: {
      cacheTtlSeconds: int(source, 'PROVIDER_RUNTIME_CACHE_TTL_SECONDS', 300),
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
  }
  if (cfg.cache.provider === 'redis' && !cfg.cache.redis.url) {
    errors.push({ key: 'REDIS_URL', message: 'Redis URL is required when CACHE_PROVIDER=redis' });
  }
  if (cfg.rateLimit.provider === 'redis' && !cfg.cache.redis.url) {
    errors.push({ key: 'REDIS_URL', message: 'Redis URL is required when RATE_LIMIT_PROVIDER=redis' });
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
