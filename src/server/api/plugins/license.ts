import type { FastifyPluginAsync } from 'fastify';
import { createLogger } from '@/lib/core/logger';
import { getDatabase, runWithTenantScope } from '@/lib/database';
import { LicenseManager } from '@/lib/license/license-manager';
import { invalidateTenantLicenseState } from '@/lib/limits/invalidate';
import { TokenManager } from '@/lib/license/token-manager';
import { listSwitchableServices, serviceLabel } from '@/lib/services/availability/catalog';
import {
  getDisabledServices,
  unknownLicenseServiceIds,
} from '@/lib/services/availability/serviceAvailability';
import {
  readJsonBody,
  requireSessionContext,
  setSessionCookies,
  withApiRequestContext,
} from '../fastify-utils';
import { authz } from '@/lib/iam/routeAuthz';

/** Every route here is gated by the "license" service (the same one its path prefix maps to). */
const GATE = { config: authz.service('license') } as const;

const logger = createLogger('api:license');

function canManageLicense(role: string): boolean {
  return role === 'owner' || role === 'admin';
}

export const licenseApiPlugin: FastifyPluginAsync = async (app) => {
  app.get('/license', GATE, withApiRequestContext(async (request, reply) => {
    try {
      const session = requireSessionContext(request);
      const mainDb = await getDatabase();
      const tenant = await mainDb.findTenantById(session.tenantId);
      if (!tenant) {
        return reply.code(404).send({ error: 'Tenant not found' });
      }

      return await runWithTenantScope(tenant.dbName, async (db) => {
        const projects = await db.listProjects(session.tenantId);
        const license = LicenseManager.getEffectiveLicenseForTenant(tenant);
        const disabled = await getDisabledServices(session.tenantId);

        return reply.code(200).send({
          canManage: canManageLicense(session.userRole),
          license,
          projectCount: projects.length,
          // Every switchable service, on or off for this workspace, and what switched it off (environment or license).
          services: listSwitchableServices().map((service) => {
            const off = disabled.get(service);
            return {
              service,
              label: serviceLabel(service),
              enabled: !off,
              ...(off ? { source: off.source } : {}),
              ...(off?.via ? { via: off.via } : {}),
            };
          }),
          tenantSlug: tenant.slug,
        });
      });
    } catch (error) {
      logger.error('Get license error', { error });
      return reply.code(500).send({ error: 'Internal server error' });
    }
  }));

  app.post('/license', GATE, withApiRequestContext(async (request, reply) => {
    try {
      const session = requireSessionContext(request);
      if (!canManageLicense(session.userRole)) {
        return reply.code(403).send({ error: 'Forbidden' });
      }

      const body = readJsonBody<{ licenseKey?: string }>(request);
      if (!body.licenseKey || body.licenseKey.trim().length < 20) {
        return reply.code(400).send({ error: 'A valid license key is required' });
      }

      const mainDb = await getDatabase();
      const tenant = await mainDb.findTenantById(session.tenantId);
      if (!tenant) {
        return reply.code(404).send({ error: 'Tenant not found' });
      }

      const verified = await LicenseManager.verifyOfflineLicenseKey(body.licenseKey, tenant);
      const updatedTenant = await mainDb.updateTenant(session.tenantId, {
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

      // Bust the enterprise-access guard's cached license for this tenant so
      // every already-logged-in session (not just this request's re-issued
      // cookie) sees the new license on its very next request.
      await invalidateTenantLicenseState(session.tenantId);

      return await runWithTenantScope(updatedTenant.dbName, async (db) => {
        const user = await db.findUserById(session.userId);
        if (user) {
          const token = await TokenManager.generateToken({
            email: user.email,
            features: verified.features,
            licenseExpiresAt: verified.expiresAt?.toISOString(),
            licenseId: verified.licenseId,
            licenseType: verified.licenseType,
            role: user.role,
            tenantDbName: updatedTenant.dbName,
            tenantId: session.tenantId,
            tenantSlug: updatedTenant.slug,
            userId: session.userId,
          });

          setSessionCookies(reply, {
            activeProjectId: request.cookies.active_project_id,
            token,
          });
        }

        // Ids this release does not know are ignored (a license made for a newer release keeps working); say so.
        const unknownServices = unknownLicenseServiceIds(verified.services);
        if (unknownServices.length > 0) {
          logger.warn('License names services this release does not know; they are ignored', { unknownServices });
        }
        return reply.code(200).send({
          license: verified,
          ...(unknownServices.length > 0 ? { warnings: { unknownServices } } : {}),
        });
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'License validation failed';
      logger.warn('Apply license failed', { error: message });
      return reply.code(400).send({ error: message });
    }
  }));

  app.delete('/license', GATE, withApiRequestContext(async (request, reply) => {
    try {
      const session = requireSessionContext(request);
      if (!canManageLicense(session.userRole)) {
        return reply.code(403).send({ error: 'Forbidden' });
      }

      const mainDb = await getDatabase();
      const tenant = await mainDb.findTenantById(session.tenantId);
      if (!tenant) {
        return reply.code(404).send({ error: 'Tenant not found' });
      }

      const freeLicense = LicenseManager.getDefaultFreeLicense();
      const updatedTenant = await mainDb.updateTenant(session.tenantId, {
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

      // Bust the enterprise-access guard's cached license for this tenant so
      // every already-logged-in session (not just this request's re-issued
      // cookie) loses enterprise access on its very next request.
      await invalidateTenantLicenseState(session.tenantId);

      return await runWithTenantScope(updatedTenant.dbName, async (db) => {
        const user = await db.findUserById(session.userId);
        if (user) {
          const token = await TokenManager.generateToken({
            email: user.email,
            features: freeLicense.features,
            licenseExpiresAt: freeLicense.expiresAt?.toISOString(),
            licenseId: freeLicense.licenseId,
            licenseType: freeLicense.licenseType,
            role: user.role,
            tenantDbName: updatedTenant.dbName,
            tenantId: session.tenantId,
            tenantSlug: updatedTenant.slug,
            userId: session.userId,
          });

          setSessionCookies(reply, {
            activeProjectId: request.cookies.active_project_id,
            token,
          });
        }

        return reply.code(200).send({ license: freeLicense });
      });
    } catch (error) {
      logger.error('Reset license error', { error });
      return reply.code(500).send({ error: 'Internal server error' });
    }
  }));
};
