/**
 * On-prem bootstrap: create a single organization + owner user from env.
 *
 * Driven by BOOTSTRAP_ORG_NAME / BOOTSTRAP_ADMIN_EMAIL / BOOTSTRAP_ADMIN_PASSWORD
 * (+ optional BOOTSTRAP_ADMIN_NAME). Intended for on-prem deployments where
 * public signup is off (REGISTRATION_MODE=disabled): the deployment gets
 * exactly one organization, owned by the env-provided user.
 *
 * Idempotent: a no-op when the bootstrap envs are unset or when any tenant
 * already exists (single-organization semantics).
 */

import bcrypt from 'bcryptjs';
import { getConfig } from '@/lib/core/config';
import { createLogger } from '@/lib/core/logger';
import { getDatabase } from '@/lib/database';
import { LicenseManager, type LicenseType } from '@/lib/license/license-manager';
import { ensureDefaultProject } from '@/lib/services/projects/projectService';
import { BCRYPT_ROUNDS, validatePassword } from './passwordPolicy';

const logger = createLogger('bootstrap-org');

export async function ensureBootstrapOrganization(): Promise<void> {
  const { bootstrapOrgName, bootstrapAdminEmail, bootstrapAdminPassword, bootstrapAdminName } =
    getConfig().registration;

  if (!bootstrapOrgName || !bootstrapAdminEmail || !bootstrapAdminPassword) {
    return;
  }

  const db = await getDatabase();
  const tenants = await db.listTenants();
  if (tenants.length > 0) {
    return;
  }

  const pwResult = validatePassword(bootstrapAdminPassword);
  if (!pwResult.valid) {
    logger.error('BOOTSTRAP_ADMIN_PASSWORD rejected by password policy; organization not created', {
      errors: pwResult.errors,
    });
    return;
  }

  const slug = bootstrapOrgName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const email = bootstrapAdminEmail.trim().toLowerCase();
  const licenseType: LicenseType = 'FREE';
  const features = LicenseManager.getFeaturesForLicense(licenseType);
  const dbName = `tenant_${slug}`;

  const tenant = await db.createTenant({
    companyName: bootstrapOrgName,
    dbName,
    licenseId: 'FREE',
    licenseType,
    licenseStatus: 'free',
    ownerId: '',
    slug,
  });

  const tenantIdStr =
    typeof tenant._id === 'string' ? tenant._id : tenant._id!.toString();

  await db.switchToTenant(dbName);
  const hashedPassword = await bcrypt.hash(bootstrapAdminPassword, BCRYPT_ROUNDS);

  const user = await db.createUser({
    email,
    features,
    licenseId: licenseType,
    name: bootstrapAdminName || 'Administrator',
    password: hashedPassword,
    role: 'owner',
    tenantId: tenantIdStr,
  });

  const userIdStr =
    typeof user._id === 'string' ? user._id : user._id!.toString();

  await ensureDefaultProject(dbName, tenantIdStr, userIdStr);
  await db.updateTenant(tenantIdStr, { ownerId: userIdStr });
  await db.registerUserInDirectory({
    email,
    tenantCompanyName: tenant.companyName,
    tenantDbName: tenant.dbName,
    tenantId: tenantIdStr,
    tenantSlug: tenant.slug,
  });

  logger.info('Bootstrap organization created from env', {
    email,
    slug,
  });
}
