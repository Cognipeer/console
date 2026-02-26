import { SignJWT, jwtVerify } from 'jose';
import { LicenseType } from './license-manager';
import { getConfig } from '@/lib/core/config';

// NOTE: This module is imported by middleware.ts which runs in Edge Runtime.
// Winston/createLogger cannot be used here — Edge Runtime lacks Node.js APIs.

export interface JWTPayload {
  userId: string;
  email: string;
  tenantId: string;
  tenantSlug: string;
  tenantDbName: string;
  role: 'owner' | 'admin' | 'project_admin' | 'user';
  licenseId: string;
  licenseType: LicenseType;
  features: string[];
  iat?: number;
  exp?: number;
}

export class TokenManager {
  private static getSecretKey(): Uint8Array {
    const cfg = getConfig();
    if (!cfg.auth.jwtSecret) {
      throw new Error('JWT_SECRET is not defined in environment variables');
    }
    return new TextEncoder().encode(cfg.auth.jwtSecret);
  }

  /**
   * Generate JWT token with license features
   */
  static async generateToken(
    payload: Omit<JWTPayload, 'iat' | 'exp'>,
  ): Promise<string> {
    const expiresIn = getConfig().auth.jwtExpiresIn;

    // Convert expiry string to seconds (7d -> 604800)
    const expiryMap: Record<string, number> = {
      '1d': 86400,
      '7d': 604800,
      '30d': 2592000,
    };
    const expirySeconds = expiryMap[expiresIn] || 604800;

    const token = await new SignJWT(payload as Record<string, unknown>)
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setExpirationTime(Math.floor(Date.now() / 1000) + expirySeconds)
      .sign(this.getSecretKey());

    return token;
  }

  /**
   * Verify and decode JWT token
   */
  static async verifyToken(token: string): Promise<JWTPayload | null> {
    try {
      const { payload } = await jwtVerify(token, this.getSecretKey());
      return payload as unknown as JWTPayload;
    } catch {
      // Edge Runtime — cannot use Winston logger here
      return null;
    }
  }

  /**
   * Decode token without verification (for debugging)
   */
  static decodeToken(token: string): JWTPayload | null {
    try {
      const parts = token.split('.');
      if (parts.length !== 3) return null;

      const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString());
      return payload as JWTPayload;
    } catch {
      return null;
    }
  }

  /**
   * Check if token has a specific feature
   */
  static async hasFeature(token: string, feature: string): Promise<boolean> {
    const payload = await this.verifyToken(token);
    if (!payload) return false;
    return payload.features.includes(feature);
  }

  /**
   * Refresh token (generate new token from old one)
   */
  static async refreshToken(oldToken: string): Promise<string | null> {
    const payload = await this.verifyToken(oldToken);
    if (!payload) return null;

    const tokenData: Omit<JWTPayload, 'iat' | 'exp'> & Record<string, unknown> = {
      ...payload,
    };
    delete tokenData.iat;
    delete tokenData.exp;
    return this.generateToken(tokenData as Omit<JWTPayload, 'iat' | 'exp'>);
  }
}
