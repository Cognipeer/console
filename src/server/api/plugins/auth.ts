import { SignJWT, jwtVerify } from 'jose';
import bcrypt from 'bcryptjs';
import type { FastifyPluginAsync } from 'fastify';
import { getConfig } from '@/lib/core/config';
import { createLogger } from '@/lib/core/logger';
import { getDatabase, type ITenant } from '@/lib/database';
import { LicenseManager, type LicenseType } from '@/lib/license/license-manager';
import { TokenManager } from '@/lib/license/token-manager';
import { sendEmail } from '@/lib/email/mailer';
import {
  checkRateLimit,
  LOGIN_RATE_LIMIT,
  PASSWORD_RESET_RATE_LIMIT,
  REGISTER_RATE_LIMIT,
} from '@/lib/services/auth/rateLimiter';
import {
  BCRYPT_ROUNDS,
  validatePassword,
} from '@/lib/services/auth/passwordPolicy';
import {
  DEFAULT_PROJECT_KEY,
  ensureDefaultProject,
} from '@/lib/services/projects/projectService';
import {
  clearSessionCookies,
  getClientIp,
  getSessionContext,
  readJsonBody,
  setSessionCookies,
} from '../fastify-utils';

const logger = createLogger('api:auth');
const RESET_TOKEN_EXPIRY_SECONDS = 3600;

type LoginBody = {
  email?: string;
  password?: string;
  slug?: string;
};

type RegisterBody = {
  companyName?: string;
  email?: string;
  licenseType?: string;
  name?: string;
  password?: string;
};

function sendRateLimitHeaders(
  headers: Record<string, string | undefined>,
  target: { header: (name: string, value: string) => void },
): void {
  for (const [key, value] of Object.entries(headers)) {
    if (value !== undefined) {
      target.header(key, value);
    }
  }
}

export const authApiPlugin: FastifyPluginAsync = async (app) => {
  app.post('/auth/login', async (request, reply) => {
    try {
      const clientIp = getClientIp(request);
      const rl = checkRateLimit(`login:${clientIp}`, LOGIN_RATE_LIMIT);
      if (!rl.allowed) {
        sendRateLimitHeaders(
          {
            'Retry-After': String(rl.retryAfterSeconds),
            'X-RateLimit-Remaining': '0',
            'X-RateLimit-Reset': rl.resetAt.toISOString(),
          },
          reply,
        );
        return reply
          .code(429)
          .send({ error: 'Too many login attempts. Please try again later.' });
      }

      const { email, password, slug } = readJsonBody<LoginBody>(request);
      if (!email || !password) {
        return reply
          .code(400)
          .send({ error: 'Email and password are required' });
      }

      const normalizedEmail = email.trim().toLowerCase();
      const db = await getDatabase();

      let tenant: ITenant | null = null;
      let user = null;

      if (slug) {
        tenant = await db.findTenantBySlug(slug);
        if (!tenant) {
          return reply
            .code(401)
            .send({ error: 'Invalid company identifier' });
        }

        await db.switchToTenant(tenant.dbName);
        user =
          (await db.findUserByEmail(normalizedEmail))
          || (await db.findUserByEmail(email));

        if (!user) {
          return reply
            .code(401)
            .send({ error: 'Invalid email or password' });
        }

        const isPasswordValid = await bcrypt.compare(password, user.password);
        if (!isPasswordValid) {
          return reply
            .code(401)
            .send({ error: 'Invalid email or password' });
        }
      } else {
        const tenantEntries = await db.listTenantsForUser(normalizedEmail);
        const checkedTenantIds = new Set<string>();

        for (const entry of tenantEntries) {
          checkedTenantIds.add(entry.tenantId);

          try {
            const candidateTenant = await db.findTenantById(entry.tenantId);
            if (!candidateTenant) {
              continue;
            }

            await db.switchToTenant(candidateTenant.dbName);
            const candidateUser =
              (await db.findUserByEmail(normalizedEmail))
              || (await db.findUserByEmail(email));

            if (!candidateUser) {
              continue;
            }

            const isPasswordValid = await bcrypt.compare(
              password,
              candidateUser.password,
            );

            if (!isPasswordValid) {
              continue;
            }

            tenant = candidateTenant;
            user = candidateUser;
            break;
          } catch (error) {
            logger.error('Tenant lookup failed', { error });
          }
        }

        if (!tenant || !user) {
          const allTenants = await db.listTenants();

          for (const candidateTenant of allTenants) {
            const candidateTenantId =
              typeof candidateTenant._id === 'string'
                ? candidateTenant._id
                : candidateTenant._id?.toString();

            if (
              !candidateTenantId
              || checkedTenantIds.has(candidateTenantId)
            ) {
              continue;
            }

            try {
              await db.switchToTenant(candidateTenant.dbName);
              const candidateUser =
                (await db.findUserByEmail(normalizedEmail))
                || (await db.findUserByEmail(email));

              if (!candidateUser) {
                continue;
              }

              const isPasswordValid = await bcrypt.compare(
                password,
                candidateUser.password,
              );

              if (!isPasswordValid) {
                continue;
              }

              tenant = candidateTenant;
              user = candidateUser;

              await db.registerUserInDirectory({
                email: candidateUser.email,
                tenantCompanyName: candidateTenant.companyName,
                tenantDbName: candidateTenant.dbName,
                tenantId: candidateTenantId,
                tenantSlug: candidateTenant.slug,
              });
              break;
            } catch (error) {
              logger.error('Tenant fallback lookup failed', { error });
            }
          }
        }

        if (!tenant || !user) {
          return reply
            .code(401)
            .send({ error: 'Invalid email or password' });
        }
      }

      const tenantIdStr =
        typeof tenant._id === 'string' ? tenant._id : tenant._id!.toString();
      const userIdStr =
        typeof user._id === 'string' ? user._id : user._id!.toString();

      const defaultProject = await ensureDefaultProject(
        tenant.dbName,
        tenantIdStr,
        userIdStr,
      );
      const defaultProjectId =
        typeof defaultProject._id === 'string'
          ? defaultProject._id
          : defaultProject._id?.toString();

      let activeProjectId = request.cookies.active_project_id;

      if (user.role === 'user' || user.role === 'project_admin') {
        const allowed = (user.projectIds ?? []).map(String);
        if (!activeProjectId || !allowed.includes(activeProjectId)) {
          activeProjectId = allowed[0];
        }
      } else if (!activeProjectId) {
        const allProjects = await db.listProjects(tenantIdStr);
        const preferred = allProjects.find(
          (project) =>
            project.key !== DEFAULT_PROJECT_KEY
            && String(project._id) !== defaultProjectId,
        );
        activeProjectId = preferred
          ? (
            typeof preferred._id === 'string'
              ? preferred._id
              : preferred._id?.toString()
          )
          : defaultProjectId;
      }

      const token = await TokenManager.generateToken({
        email: user.email,
        features: user.features || [],
        licenseId: user.licenseId,
        licenseType: user.licenseId as LicenseType,
        role: user.role!,
        tenantDbName: tenant.dbName,
        tenantId: tenantIdStr,
        tenantSlug: tenant.slug,
        userId: userIdStr,
      });

      if (user.invitedBy && !user.inviteAcceptedAt) {
        try {
          await db.updateUser(userIdStr, { inviteAcceptedAt: new Date() });
          user.inviteAcceptedAt = new Date();
        } catch (error) {
          logger.error('Failed to mark invite accepted', { error });
        }
      }

      setSessionCookies(reply, {
        activeProjectId,
        token,
      });

      return reply.code(200).send({
        message: 'Login successful',
        mustChangePassword: Boolean(user.mustChangePassword),
        tenant: {
          companyName: tenant.companyName,
          id: tenant._id,
          slug: tenant.slug,
        },
        user: {
          email: user.email,
          features: user.features,
          id: user._id,
          licenseType: user.licenseId,
          name: user.name,
          role: user.role,
        },
      });
    } catch (error) {
      logger.error('Login error', { error });
      return reply.code(500).send({ error: 'Internal server error' });
    }
  });

  app.post('/auth/register', async (request, reply) => {
    try {
      const clientIp = getClientIp(request);
      const rl = checkRateLimit(`register:${clientIp}`, REGISTER_RATE_LIMIT);
      if (!rl.allowed) {
        sendRateLimitHeaders(
          {
            'Retry-After': String(rl.retryAfterSeconds),
            'X-RateLimit-Remaining': '0',
            'X-RateLimit-Reset': rl.resetAt.toISOString(),
          },
          reply,
        );
        return reply.code(429).send({
          error: 'Too many registration attempts. Please try again later.',
        });
      }

      const { email, password, name, companyName, licenseType } =
        readJsonBody<RegisterBody>(request);

      if (!email || !password || !name || !companyName) {
        return reply.code(400).send({
          error: 'Email, password, name, and company name are required',
        });
      }

      const slug = companyName
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');

      const pwResult = validatePassword(password);
      if (!pwResult.valid) {
        return reply.code(400).send({
          error: pwResult.errors.join('. '),
        });
      }

      const db = await getDatabase();
      const existingTenant = await db.findTenantBySlug(slug);
      if (existingTenant) {
        return reply.code(409).send({
          error:
            'A company with this name already exists. Please choose a different name.',
        });
      }

      const finalLicenseType = (licenseType as LicenseType) || 'FREE';
      const features = LicenseManager.getFeaturesForLicense(finalLicenseType);
      const dbName = `tenant_${slug}`;

      const tenant = await db.createTenant({
        companyName,
        dbName,
        licenseType: finalLicenseType,
        ownerId: '',
        slug,
      });

      await db.switchToTenant(dbName);
      const hashedPassword = await bcrypt.hash(password, BCRYPT_ROUNDS);

      const tenantIdStr =
        typeof tenant._id === 'string' ? tenant._id : tenant._id!.toString();

      const user = await db.createUser({
        email,
        features,
        licenseId: finalLicenseType,
        name,
        password: hashedPassword,
        role: 'owner',
        tenantId: tenantIdStr,
      });

      const userIdStr =
        typeof user._id === 'string' ? user._id : user._id!.toString();

      const defaultProject = await ensureDefaultProject(
        dbName,
        tenantIdStr,
        userIdStr,
      );
      const defaultProjectId =
        typeof defaultProject._id === 'string'
          ? defaultProject._id
          : defaultProject._id?.toString();

      await db.updateTenant(tenantIdStr, { ownerId: userIdStr });

      const token = await TokenManager.generateToken({
        email: user.email,
        features: user.features || [],
        licenseId: user.licenseId,
        licenseType: finalLicenseType,
        role: user.role!,
        tenantDbName: tenant.dbName,
        tenantId: tenantIdStr,
        tenantSlug: tenant.slug,
        userId: userIdStr,
      });

      sendEmail(email, 'welcome', {
        companyName,
        email,
        licenseType: finalLicenseType,
        name,
        slug,
      }).catch((error: Error) => {
        logger.error('Failed to send welcome email', { error });
      });

      setSessionCookies(reply, {
        activeProjectId: defaultProjectId,
        token,
      });

      return reply.code(201).send({
        message: 'Company and user registered successfully',
        tenant: {
          companyName: tenant.companyName,
          id: tenant._id,
          slug: tenant.slug,
        },
        user: {
          email: user.email,
          features: user.features,
          id: user._id,
          licenseType: finalLicenseType,
          name: user.name,
          role: user.role,
        },
      });
    } catch (error) {
      logger.error('Registration error', { error });
      return reply.code(500).send({ error: 'Internal server error' });
    }
  });

  app.post('/auth/logout', async (_request, reply) => {
    clearSessionCookies(reply);
    return reply.code(200).send({ message: 'Logged out successfully' });
  });

  app.get('/auth/session', async (request, reply) => {
    try {
      const session = getSessionContext(request);
      if (!session) {
        return reply.code(401).send({ error: 'Unauthorized' });
      }

      const db = await getDatabase();
      await db.switchToTenant(session.tenantDbName);

      const user = await db.findUserById(session.userId);
      if (!user || String(user.tenantId) !== String(session.tenantId)) {
        return reply.code(401).send({ error: 'Unauthorized' });
      }

      return reply.code(200).send({
        authenticated: true,
        mustChangePassword: Boolean(user.mustChangePassword),
        projectCount: (user.projectIds ?? []).length,
        role: user.role,
      });
    } catch (error) {
      logger.error('Session endpoint error', { error });
      return reply.code(500).send({ error: 'Internal server error' });
    }
  });

  app.post('/auth/change-password', async (request, reply) => {
    try {
      const session = getSessionContext(request);
      if (!session) {
        return reply.code(401).send({ error: 'Unauthorized' });
      }

      const body = readJsonBody<{
        currentPassword?: string;
        newPassword?: string;
      }>(request);

      if (!body.currentPassword || !body.newPassword) {
        return reply.code(400).send({
          error: 'currentPassword and newPassword are required',
        });
      }

      const pwResult = validatePassword(body.newPassword);
      if (!pwResult.valid) {
        return reply.code(400).send({
          error: pwResult.errors.join('. '),
        });
      }

      const db = await getDatabase();
      await db.switchToTenant(session.tenantDbName);

      const user = await db.findUserById(session.userId);
      if (!user || String(user.tenantId) !== String(session.tenantId)) {
        return reply.code(401).send({ error: 'Unauthorized' });
      }

      const isValid = await bcrypt.compare(
        body.currentPassword,
        user.password,
      );
      if (!isValid) {
        return reply.code(401).send({ error: 'Invalid current password' });
      }

      const hashed = await bcrypt.hash(body.newPassword, BCRYPT_ROUNDS);
      const updated = await db.updateUser(session.userId, {
        mustChangePassword: false,
        password: hashed,
        updatedAt: new Date(),
      });

      if (!updated) {
        return reply.code(500).send({ error: 'Failed to update password' });
      }

      return reply.code(200).send({ success: true });
    } catch (error) {
      logger.error('Change password error', { error });
      return reply.code(500).send({ error: 'Internal server error' });
    }
  });

  app.post('/auth/forgot-password', async (request, reply) => {
    try {
      const { email, slug } = readJsonBody<{
        email?: string;
        slug?: string;
      }>(request);

      if (!email || !slug) {
        return reply.code(400).send({
          error: 'Email and organization slug are required',
        });
      }

      const clientIp = getClientIp(request);
      const rl = checkRateLimit(
        `forgot-password:${clientIp}`,
        PASSWORD_RESET_RATE_LIMIT,
      );
      if (!rl.allowed) {
        reply.header('Retry-After', String(rl.retryAfterSeconds));
        return reply.code(429).send({
          error:
            'Too many password reset requests. Please try again later.',
        });
      }

      const successPayload = {
        message: 'If that email exists, a password reset link has been sent.',
      };

      const db = await getDatabase();
      const tenant = await db.findTenantBySlug(slug);
      if (!tenant) {
        logger.warn('Password reset attempted for non-existent tenant', {
          slug,
        });
        return reply.code(200).send(successPayload);
      }

      await db.switchToTenant(tenant.dbName);
      const user = await db.findUserByEmail(email);
      if (!user) {
        logger.warn('Password reset attempted for non-existent user', {
          email: `${email.substring(0, 3)}***`,
        });
        return reply.code(200).send(successPayload);
      }

      const secret = new TextEncoder().encode(getConfig().auth.jwtSecret);
      const resetToken = await new SignJWT({
        email: user.email,
        purpose: 'password-reset',
        slug,
        sub: String(user._id),
      })
        .setProtectedHeader({ alg: 'HS256' })
        .setIssuedAt()
        .setExpirationTime(
          Math.floor(Date.now() / 1000) + RESET_TOKEN_EXPIRY_SECONDS,
        )
        .sign(secret);

      const originHeader = request.headers.origin;
      const origin = Array.isArray(originHeader)
        ? originHeader[0]
        : originHeader;
      const baseUrl =
        origin
        || `${request.protocol}://${request.headers.host ?? 'localhost'}`;
      const resetUrl = `${baseUrl}/reset-password?token=${resetToken}`;

      const emailSent = await sendEmail(email, 'password-reset', {
        expiryTime: '1 hour',
        name: user.name,
        resetUrl,
      });

      if (!emailSent) {
        logger.warn('Password reset email failed to send', {
          userId: String(user._id),
        });
      }

      return reply.code(200).send(successPayload);
    } catch (error) {
      logger.error('Forgot password error', { error });
      return reply.code(500).send({ error: 'Internal server error' });
    }
  });

  app.post('/auth/reset-password', async (request, reply) => {
    try {
      const { token, newPassword } = readJsonBody<{
        token?: string;
        newPassword?: string;
      }>(request);

      if (!token || !newPassword) {
        return reply.code(400).send({
          error: 'Token and new password are required',
        });
      }

      const pwResult = validatePassword(newPassword);
      if (!pwResult.valid) {
        return reply.code(400).send({
          error: pwResult.errors.join('. '),
        });
      }

      const secret = new TextEncoder().encode(getConfig().auth.jwtSecret);
      let payload: {
        email?: string;
        purpose?: string;
        slug?: string;
        sub?: string;
      };

      try {
        const verified = await jwtVerify(token, secret);
        payload = verified.payload as typeof payload;
      } catch {
        return reply.code(400).send({
          error: 'Invalid or expired reset token',
        });
      }

      if (
        payload.purpose !== 'password-reset'
        || !payload.sub
        || !payload.slug
      ) {
        return reply.code(400).send({ error: 'Invalid reset token' });
      }

      const db = await getDatabase();
      const tenant = await db.findTenantBySlug(payload.slug);
      if (!tenant) {
        return reply.code(400).send({ error: 'Invalid reset token' });
      }

      await db.switchToTenant(tenant.dbName);
      const user = await db.findUserById(payload.sub);
      if (!user) {
        return reply.code(400).send({ error: 'Invalid reset token' });
      }

      const hashedPassword = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
      const updated = await db.updateUser(payload.sub, {
        mustChangePassword: false,
        password: hashedPassword,
        updatedAt: new Date(),
      });

      if (!updated) {
        return reply.code(500).send({
          error: 'Failed to reset password',
        });
      }

      logger.info('Password reset successful', { userId: payload.sub });
      return reply.code(200).send({
        message: 'Password has been reset successfully',
      });
    } catch (error) {
      logger.error('Reset password error', { error });
      return reply.code(500).send({ error: 'Internal server error' });
    }
  });
};
