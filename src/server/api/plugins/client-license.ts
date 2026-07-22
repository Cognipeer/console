/**
 * Client License API plugin (token-authenticated admin surface).
 *
 * Tenant-scoped license management via an API token. Gated by the `license`
 * RBAC service (an adminService → GET needs `read`, POST/DELETE need `admin`).
 * Tenant + actor are read ONLY from the authenticated token context (`auth`).
 *
 * Unlike the dashboard `/license` routes this path has NO session cookie, so the
 * session-token re-mint (`TokenManager.generateToken` + `setSessionCookies`) is
 * intentionally omitted — apply/reset just verify + persist + return the view.
 *
 * Secret redaction: the raw signed `licenseKey` and the decoded JWT `payload`
 * (stored on the tenant as `licenseKey`/`licensePayload`) are NEVER echoed. Only
 * the effective license view — id/type/status/source/features/limits/expiresAt —
 * is returned, from `sanitizeLicense`.
 *
 *   GET    /client/v1/license   – effective license view + project count
 *   POST   /client/v1/license   – apply an offline license key
 *   DELETE /client/v1/license   – reset to the default FREE license
 */

import type { FastifyPluginAsync } from 'fastify';
import { createLogger } from '@/lib/core/logger';
import { getDatabase } from '@/lib/database';
import { type EffectiveLicense, LicenseManager } from '@/lib/license/license-manager';
import { readJsonBody, sendApiTokenError, withClientApiRequestContext } from '../fastify-utils';

const logger = createLogger('api:client-license');

/**
 * Strip the decoded JWT `payload` from an effective-license view before it
 * leaves the process. `payload` mirrors the tenant's stored `licensePayload`
 * (license claims) and must never be echoed over the token API; the raw signed
 * `licenseKey` is never part of this view to begin with.
 */
function sanitizeLicense(license: EffectiveLicense): Omit<EffectiveLicense, 'payload'> {
  const view = { ...license };
  delete view.payload;
  return view;
}

export const clientLicenseApiPlugin: FastifyPluginAsync = async (app) => {
  app.get('/client/v1/license', withClientApiRequestContext(async (_request, reply, auth) => {
    try {
      const db = await getDatabase();
      const tenant = await db.findTenantById(auth.tenantId);
      if (!tenant) {
        return reply.code(404).send({ error: 'Tenant not found' });
      }

      await db.switchToTenant(tenant.dbName);
      const projects = await db.listProjects(auth.tenantId);
      const license = LicenseManager.getEffectiveLicenseForTenant(tenant);

      return reply.code(200).send({
        license: sanitizeLicense(license),
        projectCount: projects.length,
      });
    } catch (error) {
      logger.error('Client get license error', { error });
      return sendApiTokenError(reply, error)
        ?? reply.code(500).send({ error: error instanceof Error ? error.message : 'Internal server error' });
    }
  }));

  app.post('/client/v1/license', withClientApiRequestContext(async (request, reply, auth) => {
    try {
      const body = readJsonBody<{ licenseKey?: string }>(request);
      if (!body.licenseKey || body.licenseKey.trim().length < 20) {
        return reply.code(400).send({ error: 'A valid license key is required' });
      }

      const db = await getDatabase();
      const tenant = await db.findTenantById(auth.tenantId);
      if (!tenant) {
        return reply.code(404).send({ error: 'Tenant not found' });
      }

      const verified = await LicenseManager.verifyOfflineLicenseKey(body.licenseKey, tenant);
      const updatedTenant = await db.updateTenant(auth.tenantId, {
        licenseActivatedAt: new Date(),
        licenseError: null,
        licenseExpiresAt: verified.expiresAt,
        licenseId: verified.licenseId,
        licenseKey: body.licenseKey.trim(),
        licenseLastVerifiedAt: new Date(),
        licensePayload: verified.payload,
        licenseStatus: 'active',
        licenseType: verified.licenseType,
      });

      if (!updatedTenant) {
        return reply.code(500).send({ error: 'Failed to store license' });
      }

      await db.switchToTenant(updatedTenant.dbName);
      const projects = await db.listProjects(auth.tenantId);
      const license = LicenseManager.getEffectiveLicenseForTenant(updatedTenant);

      return reply.code(200).send({
        license: sanitizeLicense(license),
        projectCount: projects.length,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'License validation failed';
      logger.warn('Client apply license failed', { error: message });
      return sendApiTokenError(reply, error) ?? reply.code(400).send({ error: message });
    }
  }));

  app.delete('/client/v1/license', withClientApiRequestContext(async (_request, reply, auth) => {
    try {
      const db = await getDatabase();
      const tenant = await db.findTenantById(auth.tenantId);
      if (!tenant) {
        return reply.code(404).send({ error: 'Tenant not found' });
      }

      const freeLicense = LicenseManager.getDefaultFreeLicense();
      const updatedTenant = await db.updateTenant(auth.tenantId, {
        licenseActivatedAt: null,
        licenseError: null,
        licenseExpiresAt: null,
        licenseId: 'FREE',
        licenseKey: null,
        licenseLastVerifiedAt: new Date(),
        licensePayload: null,
        licenseStatus: 'free',
        licenseType: 'FREE',
      });

      if (!updatedTenant) {
        return reply.code(500).send({ error: 'Failed to reset license' });
      }

      await db.switchToTenant(updatedTenant.dbName);
      const projects = await db.listProjects(auth.tenantId);

      return reply.code(200).send({
        license: sanitizeLicense(freeLicense),
        projectCount: projects.length,
      });
    } catch (error) {
      logger.error('Client reset license error', { error });
      return sendApiTokenError(reply, error)
        ?? reply.code(500).send({ error: error instanceof Error ? error.message : 'Internal server error' });
    }
  }));
};
