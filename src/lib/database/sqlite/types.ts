/**
 * Shared types for SQLite provider mixins.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Constructor<T = object> = new (...args: any[]) => T;

/**
 * Shape of a generic SQLite row before mapping to domain types.
 * All columns arrive as string | number | null from better-sqlite3.
 */
export type SqliteRow = Record<string, unknown>;
