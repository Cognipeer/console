/**
 * MongoDB Provider – Tenant operations mixin
 *
 * Includes tenant CRUD (main DB) and cross-tenant user directory.
 */

import { ObjectId } from 'mongodb';
import type { ITenant, ITenantUserDirectoryEntry } from '../provider.interface';
import type { Constructor } from './types';
import { MongoDBProviderBase, COLLECTIONS } from './base';

export function TenantMixin<TBase extends Constructor<MongoDBProviderBase>>(Base: TBase) {
  return class TenantOps extends Base {
    // ── Cross-tenant user directory (main DB) ────────────────────────

    async registerUserInDirectory(
      entry: ITenantUserDirectoryEntry,
    ): Promise<void> {
      const db = this.getMainDb();
      const now = new Date();
      const normalizedEmail = this.normalizeEmail(entry.email);

      await db
        .collection(COLLECTIONS.tenantUserDirectory)
        .updateOne(
          {
            email: normalizedEmail,
            tenantId: entry.tenantId,
          },
          {
            $set: {
              email: normalizedEmail,
              tenantId: entry.tenantId,
              tenantSlug: entry.tenantSlug,
              tenantDbName: entry.tenantDbName,
              tenantCompanyName: entry.tenantCompanyName,
              updatedAt: now,
            },
            $setOnInsert: {
              createdAt: now,
            },
          },
          { upsert: true },
        );
    }

    async unregisterUserFromDirectory(
      email: string,
      tenantId: string,
    ): Promise<void> {
      const db = this.getMainDb();
      const normalizedEmail = this.normalizeEmail(email);

      await db
        .collection(COLLECTIONS.tenantUserDirectory)
        .deleteOne({
          email: normalizedEmail,
          tenantId,
        });
    }

    async listTenantsForUser(
      email: string,
    ): Promise<ITenantUserDirectoryEntry[]> {
      const db = this.getMainDb();
      const normalizedEmail = this.normalizeEmail(email);

      const entries = await db
        .collection<ITenantUserDirectoryEntry>(COLLECTIONS.tenantUserDirectory)
        .find({ email: normalizedEmail })
        .toArray();

      return entries.map((entry) => ({
        email: entry.email,
        tenantId: entry.tenantId,
        tenantSlug: entry.tenantSlug,
        tenantDbName: entry.tenantDbName,
        tenantCompanyName: entry.tenantCompanyName,
        createdAt: entry.createdAt,
        updatedAt: entry.updatedAt,
      }));
    }

    // ── Tenant CRUD (main DB) ────────────────────────────────────────

    async createTenant(
      tenantData: Omit<ITenant, '_id' | 'createdAt' | 'updatedAt'>,
    ): Promise<ITenant> {
      const db = this.getMainDb();
      const now = new Date();

      const result = await db.collection(COLLECTIONS.tenants).insertOne({
        ...tenantData,
        createdAt: now,
        updatedAt: now,
      });

      return {
        ...tenantData,
        _id: result.insertedId.toString(),
        createdAt: now,
        updatedAt: now,
      };
    }

    async findTenantBySlug(slug: string): Promise<ITenant | null> {
      const db = this.getMainDb();
      const tenant = await db.collection<ITenant>(COLLECTIONS.tenants).findOne({ slug });
      if (!tenant) return null;

      return {
        ...tenant,
        _id: tenant._id?.toString(),
      };
    }

    async findTenantById(id: string): Promise<ITenant | null> {
      const db = this.getMainDb();
      const tenant = await db
        .collection<ITenant>(COLLECTIONS.tenants)
        .findOne({ _id: new ObjectId(id) });
      if (!tenant) return null;

      return {
        ...tenant,
        _id: tenant._id?.toString(),
      };
    }

    async listTenants(): Promise<ITenant[]> {
      const db = this.getMainDb();
      const tenants = await db.collection<ITenant>(COLLECTIONS.tenants).find({}).toArray();

      return tenants.map((tenant) => ({
        ...tenant,
        _id: tenant._id?.toString(),
      }));
    }

    async updateTenant(
      id: string,
      data: Partial<ITenant>,
    ): Promise<ITenant | null> {
      const db = this.getMainDb();
      const updateData = { ...data };
      delete updateData._id;

      const result = await db.collection<ITenant>(COLLECTIONS.tenants).findOneAndUpdate(
        { _id: new ObjectId(id) },
        {
          $set: {
            ...updateData,
            updatedAt: new Date(),
          },
        },
        { returnDocument: 'after' },
      );

      if (!result) return null;

      return {
        ...result,
        _id: result._id?.toString(),
      };
    }
  };
}
