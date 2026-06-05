/**
 * Enterprise extension registry — COMMUNITY (open-source) edition.
 *
 * This is the single seam through which the closed-source enterprise overlay
 * plugs into the community core. In the community edition every collection
 * below is EMPTY, so all `apply*` / loops are no-ops and the FREE product runs
 * unchanged.
 *
 * The enterprise overlay repository (cognipeer-console-ee) ships a file that
 * REPLACES this one (same path) and populates the collections by importing the
 * real implementations from `@/enterprise/impl/*`. See the cognipeer-console-ee repo (docs/licensing/SEAM-DESIGN.md).
 *
 * IMPORTANT: keep this file dependency-free of any enterprise module. It must
 * compile and run with zero enterprise code present.
 */

import type { FastifyInstance } from 'fastify';

// ── DB provider mixins ────────────────────────────────────────────────────
// A mixin takes a base constructor and returns an extended one. For the
// community type contract we treat them as identity over the base type:
// enterprise DB methods are accessed dynamically (they are not part of the
// `DatabaseProvider` interface), exactly as they are today.
export type GenericConstructor = new (...args: any[]) => object;
export type DbMixin = <T extends GenericConstructor>(Base: T) => T;

/**
 * Marker interface for the DB methods the enterprise mixins add. EMPTY in the
 * community edition. The overlay augments it (declaration merging) with the
 * gpu-fleet / sandbox method signatures. `DatabaseProvider` extends this, so the
 * community contract gains nothing and the enterprise contract gains the methods
 * — both from this single seam.
 */
export interface EnterpriseDbMethods {}
type EnterpriseDbCtor = new (...args: any[]) => EnterpriseDbMethods;

// SQLite and MongoDB have SEPARATE mixin implementations, so the overlay must
// contribute them to the matching provider. Order = application order.
export const enterpriseSqliteDbMixins: DbMixin[] = [];
export const enterpriseMongoDbMixins: DbMixin[] = [];

export function applyEnterpriseSqliteDbMixins<T extends GenericConstructor>(Base: T): T & EnterpriseDbCtor {
  return enterpriseSqliteDbMixins.reduce<GenericConstructor>((Acc, mixin) => mixin(Acc), Base) as T & EnterpriseDbCtor;
}

export function applyEnterpriseMongoDbMixins<T extends GenericConstructor>(Base: T): T & EnterpriseDbCtor {
  return enterpriseMongoDbMixins.reduce<GenericConstructor>((Acc, mixin) => mixin(Acc), Base) as T & EnterpriseDbCtor;
}

// ── Fastify API plugins ───────────────────────────────────────────────────
// Each registrar receives the Fastify app and registers its own plugin(s).
// This keeps the core plugin bootstrap decoupled from enterprise plugin types.
export type EnterprisePluginRegistrar = (app: FastifyInstance) => Promise<void> | void;

export const enterpriseApiPlugins: EnterprisePluginRegistrar[] = [];

export async function registerEnterpriseApiPlugins(app: FastifyInstance): Promise<void> {
  for (const register of enterpriseApiPlugins) {
    await register(app);
  }
}

// ── Bootstrap reconcilers ─────────────────────────────────────────────────
// Run once during server bootstrap (e.g. sandbox/gpu-fleet runtime reconcile).
// Each hook is isolated: a throw is logged by the caller and does not abort
// startup.
export type BootstrapHook = () => Promise<void> | void;

export const enterpriseReconcilers: BootstrapHook[] = [];

// ── Public-path contributions ─────────────────────────────────────────────
// Extra unauthenticated path prefixes the enterprise edition needs (e.g. the
// gpu-fleet installer.sh / agent bundle download). Merged into PUBLIC_API_*.
export const enterprisePublicApiPaths: string[] = [];
export const enterprisePublicApiPrefixes: string[] = [];

// ── Edition flag ──────────────────────────────────────────────────────────
// True only when the overlay has replaced this file. Lets the UI/runtime tell
// "feature absent (community build)" apart from "feature present but FREE tier".
export const IS_ENTERPRISE_BUILD = false;
