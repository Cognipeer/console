/**
 * Core Module — barrel export.
 *
 * All cross-cutting infrastructure is accessible from this single import:
 *   import { getConfig, logger, getCache, withResilience, ... } from '@/lib/core';
 */

// Config
export { getConfig, reloadConfig, setConfigSource, getConfigSource, validateConfig } from './config';
export type { AppConfig, ConfigSource, ConfigValidationError } from './config';

// Logger
export { logger, createLogger, resetLogger } from './logger';

// Request Context
export { runWithRequestContext, getRequestContext, getRequestId } from './requestContext';

// Cache
export { getCache, destroyCache } from './cache';
export type { CacheProvider } from './cache';

// Resilience
export { withResilience, getCircuitState, getAllCircuitStates, resetCircuit, resetAllCircuits, CircuitOpenError } from './resilience';
export type { ResilienceOptions, RetryConfig, CircuitBreakerConfig } from './resilience';

// Lifecycle
export { initLifecycle, registerShutdownHandler, isShuttingDown } from './lifecycle';

// CORS
export { applyCors, handleCorsPreflightIfNeeded } from './cors';

// Health
export { registerHealthCheck, checkHealth, checkLiveness } from './health';
export type { HealthStatus, HealthCheckResult, HealthReport, HealthCheckFn } from './health';

// Runtime Pool
export { runtimePool, hashCredentials } from './runtimePool';

// Async Tasks
export { fireAndForget, drainPendingTasks, pendingTaskCount } from './asyncTask';
