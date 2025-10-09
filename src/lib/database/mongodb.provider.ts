import { MongoClient, Db, ObjectId } from 'mongodb';
import {
  DatabaseProvider,
  IUser,
  IApiToken,
  ITenant,
  IAgentTracingSession,
  IAgentTracingEvent,
  IModel,
  IModelUsageAggregate,
  IModelUsageCostSnapshot,
  IModelUsageLog,
  ModelCategory,
  ModelProviderType,
  ITenantUserDirectoryEntry,
  IProviderRecord,
  IVectorIndexRecord,
  ProviderDomain,
} from './provider.interface';

export class MongoDBProvider implements DatabaseProvider {
  private client: MongoClient | null = null;
  private mainDb: Db | null = null; // Shared database for tenants
  private tenantDb: Db | null = null; // Current tenant-specific database
  private readonly uri: string;
  private readonly mainDbName: string;
  private static readonly tenantUserDirectoryCollection =
    'tenant_user_directory';
  private static readonly providersCollection = 'providers';
  private static readonly vectorIndexesCollection = 'vector_indexes';

  constructor(uri: string, mainDbName: string = 'cgate_main') {
    this.uri = uri;
    this.mainDbName = mainDbName;
  }

  async connect(): Promise<void> {
    if (this.client) {
      return;
    }

    try {
      this.client = new MongoClient(this.uri);
      await this.client.connect();
      this.mainDb = this.client.db(this.mainDbName);
      console.log('✅ MongoDB connected successfully');
    } catch (error) {
      console.error('❌ MongoDB connection error:', error);
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      await this.client.close();
      this.client = null;
      this.mainDb = null;
      this.tenantDb = null;
      console.log('MongoDB disconnected');
    }
  }

  private getMainDb(): Db {
    if (!this.mainDb) {
      throw new Error('Main database not connected. Call connect() first.');
    }
    return this.mainDb;
  }

  private getTenantDb(): Db {
    if (!this.tenantDb) {
      throw new Error('Tenant database not set. Call switchToTenant() first.');
    }
    return this.tenantDb;
  }

  private normalizeEmail(email: string): string {
    return email.trim().toLowerCase();
  }

  async switchToTenant(tenantDbName: string): Promise<void> {
    if (!this.client) {
      throw new Error('Database client not connected. Call connect() first.');
    }
    this.tenantDb = this.client.db(tenantDbName);
  }

  // Cross-tenant user directory (use main DB)
  async registerUserInDirectory(
    entry: ITenantUserDirectoryEntry,
  ): Promise<void> {
    const db = this.getMainDb();
    const now = new Date();
    const normalizedEmail = this.normalizeEmail(entry.email);

    await db
      .collection(MongoDBProvider.tenantUserDirectoryCollection)
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
      .collection(MongoDBProvider.tenantUserDirectoryCollection)
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
      .collection<ITenantUserDirectoryEntry>(
        MongoDBProvider.tenantUserDirectoryCollection,
      )
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

  // Tenant operations (use main DB)
  async createTenant(
    tenantData: Omit<ITenant, '_id' | 'createdAt' | 'updatedAt'>,
  ): Promise<ITenant> {
    const db = this.getMainDb();
    const now = new Date();

    const result = await db.collection('tenants').insertOne({
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
    const tenant = await db.collection<ITenant>('tenants').findOne({ slug });
    if (!tenant) return null;

    return {
      ...tenant,
      _id: tenant._id?.toString(),
    };
  }

  async findTenantById(id: string): Promise<ITenant | null> {
    const db = this.getMainDb();
    const tenant = await db
      .collection<ITenant>('tenants')
      .findOne({ _id: new ObjectId(id) });
    if (!tenant) return null;

    return {
      ...tenant,
      _id: tenant._id?.toString(),
    };
  }

  async listTenants(): Promise<ITenant[]> {
    const db = this.getMainDb();
    const tenants = await db.collection<ITenant>('tenants').find({}).toArray();

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
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { _id, ...updateData } = data;

    const result = await db.collection<ITenant>('tenants').findOneAndUpdate(
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

  // User operations (use tenant DB)
  async findUserByEmail(email: string): Promise<IUser | null> {
    const db = this.getTenantDb();
    const trimmedEmail = email.trim();
    const normalizedEmail = this.normalizeEmail(email);
    const user = await db.collection<IUser>('users').findOne({
      $or: [
        { emailLower: normalizedEmail },
        { email: normalizedEmail },
        { email: trimmedEmail },
      ],
    });
    if (!user) return null;

    return {
      ...user,
      _id: user._id?.toString(),
    };
  }

  async findUserById(id: string): Promise<IUser | null> {
    const db = this.getTenantDb();
    const user = await db
      .collection<IUser>('users')
      .findOne({ _id: new ObjectId(id) });
    if (!user) return null;

    return {
      ...user,
      _id: user._id?.toString(),
    };
  }

  async createUser(
    userData: Omit<IUser, '_id' | 'createdAt' | 'updatedAt'>,
  ): Promise<IUser> {
    const db = this.getTenantDb();
    const now = new Date();
    const trimmedEmail = userData.email.trim();
    const normalizedEmail = this.normalizeEmail(trimmedEmail);

    const userDocument = {
      ...userData,
      email: trimmedEmail,
      emailLower: normalizedEmail,
      createdAt: now,
      updatedAt: now,
    };

    const result = await db.collection('users').insertOne(userDocument);

    const createdUser: IUser = {
      ...userDocument,
      _id: result.insertedId.toString(),
      createdAt: now,
      updatedAt: now,
    };

    try {
      const tenant = await this.findTenantById(userData.tenantId);
      if (tenant) {
        const tenantId =
          typeof tenant._id === 'string'
            ? tenant._id
            : (tenant._id?.toString() ?? userData.tenantId);
        await this.registerUserInDirectory({
          email: trimmedEmail,
          tenantId,
          tenantSlug: tenant.slug,
          tenantDbName: tenant.dbName,
          tenantCompanyName: tenant.companyName,
        });
      }
    } catch (error) {
      console.error('Failed to register user in directory:', error);
    }

    return createdUser;
  }

  async updateUser(id: string, data: Partial<IUser>): Promise<IUser | null> {
    const db = this.getTenantDb();
    const objectId = new ObjectId(id);
    const existingUser = await db
      .collection<IUser>('users')
      .findOne({ _id: objectId });

    if (!existingUser) {
      return null;
    }

    const { _id, ...updateData } = data;
    const payload: Partial<IUser> = { ...updateData };

    if (payload.email) {
      const trimmedEmail = payload.email.trim();
      payload.email = trimmedEmail;
      payload.emailLower = this.normalizeEmail(trimmedEmail);
    }

    payload.updatedAt = new Date();

    const result = await db
      .collection<IUser>('users')
      .findOneAndUpdate(
        { _id: objectId },
        { $set: payload },
        { returnDocument: 'after' },
      );

    if (!result) {
      return null;
    }

    const updatedUser: IUser = {
      ...result,
      _id: result._id?.toString(),
    };

    try {
      const tenant = await this.findTenantById(updatedUser.tenantId);
      if (tenant) {
        const tenantId =
          typeof tenant._id === 'string'
            ? tenant._id
            : (tenant._id?.toString() ?? updatedUser.tenantId);
        if (existingUser.email && existingUser.email !== updatedUser.email) {
          await this.unregisterUserFromDirectory(existingUser.email, tenantId);
        }
        await this.registerUserInDirectory({
          email: updatedUser.email,
          tenantId,
          tenantSlug: tenant.slug,
          tenantDbName: tenant.dbName,
          tenantCompanyName: tenant.companyName,
        });
      }
    } catch (error) {
      console.error('Failed to sync user directory during update:', error);
    }

    return updatedUser;
  }

  async deleteUser(id: string): Promise<boolean> {
    const db = this.getTenantDb();
    const objectId = new ObjectId(id);
    const existingUser = await db
      .collection<IUser>('users')
      .findOne({ _id: objectId });

    if (!existingUser) {
      return false;
    }

    const result = await db.collection('users').deleteOne({ _id: objectId });
    const deleted = result.deletedCount > 0;

    if (deleted) {
      try {
        await this.unregisterUserFromDirectory(
          existingUser.email,
          existingUser.tenantId,
        );
      } catch (error) {
        console.error('Failed to unregister user from directory:', error);
      }
    }

    return deleted;
  }

  async listUsers(): Promise<IUser[]> {
    const db = this.getTenantDb();
    const users = await db
      .collection<IUser>('users')
      .find({})
      .sort({ createdAt: -1 })
      .toArray();

    return users.map((user: IUser) => ({
      ...user,
      _id: user._id?.toString(),
    }));
  }

  // API Token operations (use main DB because tokens need to be accessible before tenant resolution)
  async createApiToken(
    tokenData: Omit<IApiToken, '_id' | 'createdAt'>,
  ): Promise<IApiToken> {
    const db = this.getMainDb();
    const now = new Date();

    const result = await db.collection('api_tokens').insertOne({
      ...tokenData,
      createdAt: now,
    });

    return {
      ...tokenData,
      _id: result.insertedId.toString(),
      createdAt: now,
    };
  }

  async listApiTokens(userId: string): Promise<IApiToken[]> {
    const db = this.getMainDb();
    const tokens = await db
      .collection<IApiToken>('api_tokens')
      .find({ userId })
      .sort({ createdAt: -1 })
      .toArray();

    return tokens.map((token: IApiToken) => ({
      ...token,
      _id: token._id?.toString(),
    }));
  }

  async findApiTokenByToken(token: string): Promise<IApiToken | null> {
    // API tokens are stored in main database because we don't know the tenant yet
    const db = this.getMainDb();
    const apiToken = await db
      .collection<IApiToken>('api_tokens')
      .findOne({ token });
    if (!apiToken) return null;

    return {
      ...apiToken,
      _id: apiToken._id?.toString(),
    };
  }

  async deleteApiToken(id: string, userId: string): Promise<boolean> {
    const db = this.getMainDb();
    const result = await db.collection('api_tokens').deleteOne({
      _id: new ObjectId(id),
      userId,
    });
    return result.deletedCount > 0;
  }

  async updateTokenLastUsed(token: string): Promise<void> {
    const db = this.getMainDb();
    await db
      .collection('api_tokens')
      .updateOne({ token }, { $set: { lastUsed: new Date() } });
  }

  // Agent Tracing Session operations
  async createAgentTracingSession(
    session: Omit<IAgentTracingSession, '_id' | 'createdAt' | 'updatedAt'>,
  ): Promise<IAgentTracingSession> {
    const db = this.getTenantDb();
    const now = new Date();
    const sessionData = {
      ...session,
      createdAt: now,
      updatedAt: now,
    };

    const result = await db
      .collection('agent_tracing_sessions')
      .insertOne(sessionData);
    return {
      ...sessionData,
      _id: result.insertedId.toString(),
    };
  }

  async updateAgentTracingSession(
    sessionId: string,
    data: Partial<IAgentTracingSession>,
  ): Promise<IAgentTracingSession | null> {
    const db = this.getTenantDb();
    const updateData = {
      ...data,
      updatedAt: new Date(),
    };

    const result = await db
      .collection('agent_tracing_sessions')
      .findOneAndUpdate(
        { sessionId },
        { $set: updateData },
        { returnDocument: 'after' },
      );

    if (!result) return null;

    return {
      ...result,
      _id: result._id.toString(),
    } as IAgentTracingSession;
  }

  async findAgentTracingSessionById(
    sessionId: string,
  ): Promise<IAgentTracingSession | null> {
    const db = this.getTenantDb();
    const session = await db
      .collection<IAgentTracingSession>('agent_tracing_sessions')
      .findOne({ sessionId });

    if (!session) return null;

    return {
      ...session,
      _id: session._id?.toString(),
    };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async listAgentTracingSessions(
    filters?: any,
  ): Promise<{ sessions: IAgentTracingSession[]; total: number }> {
    const db = this.getTenantDb();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const query: any = {};

    if (filters?.agentName) {
      query.agentName = { $regex: filters.agentName, $options: 'i' };
    }

    if (filters?.status) {
      query.status = filters.status;
    }

    if (filters?.from || filters?.to) {
      query.startedAt = {};
      if (filters.from) query.startedAt.$gte = new Date(filters.from);
      if (filters.to) query.startedAt.$lte = new Date(filters.to);
    }

    const limit = parseInt(filters?.limit || '50');
    const skip = parseInt(filters?.skip || '0');

    const sessions = await db
      .collection<IAgentTracingSession>('agent_tracing_sessions')
      .find(query)
      .sort({ startedAt: -1 })
      .limit(limit)
      .skip(skip)
      .toArray();

    const total = await db
      .collection('agent_tracing_sessions')
      .countDocuments(query);

    return {
      sessions: sessions.map((session: IAgentTracingSession) => ({
        ...session,
        _id: session._id?.toString(),
      })),
      total,
    };
  }

  // Agent Tracing Event operations
  async createAgentTracingEvent(
    event: Omit<IAgentTracingEvent, '_id' | 'createdAt'>,
  ): Promise<IAgentTracingEvent> {
    const db = this.getTenantDb();
    const eventData = {
      ...event,
      createdAt: new Date(),
    };
    const result = await db
      .collection('agent_tracing_events')
      .insertOne(eventData);
    return {
      ...eventData,
      _id: result.insertedId.toString(),
    };
  }

  async listAgentTracingEvents(
    sessionId: string,
  ): Promise<IAgentTracingEvent[]> {
    const db = this.getTenantDb();
    const events = await db
      .collection<IAgentTracingEvent>('agent_tracing_events')
      .find({ sessionId })
      .sort({ sequence: 1, timestamp: 1 })
      .toArray();

    return events.map((event: IAgentTracingEvent) => ({
      ...event,
      _id: event._id?.toString(),
    }));
  }

  async deleteAgentTracingEvents(sessionId: string): Promise<number> {
    const db = this.getTenantDb();
    const result = await db
      .collection('agent_tracing_events')
      .deleteMany({ sessionId });
    return result.deletedCount ?? 0;
  }

  // Model management operations
  async createModel(
    model: Omit<IModel, '_id' | 'createdAt' | 'updatedAt'>,
  ): Promise<IModel> {
    const db = this.getTenantDb();
    const now = new Date();
    const pricing = {
      currency: model.pricing.currency || 'USD',
      inputTokenPer1M: model.pricing.inputTokenPer1M,
      outputTokenPer1M: model.pricing.outputTokenPer1M,
      cachedTokenPer1M: model.pricing.cachedTokenPer1M ?? 0,
    };

    const modelDoc = {
      ...model,
      provider: model.provider ?? (model.providerDriver as ModelProviderType | undefined),
      pricing,
      createdAt: now,
      updatedAt: now,
    };

    const result = await db.collection('models').insertOne(modelDoc);

    return {
      ...modelDoc,
      _id: result.insertedId.toString(),
    };
  }

  async updateModel(id: string, data: Partial<IModel>): Promise<IModel | null> {
    const db = this.getTenantDb();
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { _id, pricing, ...rest } = data;

    const updateData: Record<string, unknown> = {
      ...rest,
      updatedAt: new Date(),
    };

    if (pricing) {
      updateData.pricing = {
        currency: pricing.currency || 'USD',
        inputTokenPer1M: pricing.inputTokenPer1M,
        outputTokenPer1M: pricing.outputTokenPer1M,
        cachedTokenPer1M: pricing.cachedTokenPer1M ?? 0,
      };
    }

    if (rest.providerDriver !== undefined && rest.provider === undefined) {
      updateData.provider = rest.providerDriver as ModelProviderType;
    }

    const result = await db
      .collection<IModel>('models')
      .findOneAndUpdate(
        { _id: new ObjectId(id) },
        { $set: updateData },
        { returnDocument: 'after' },
      );

    if (!result) {
      return null;
    }

    return {
      ...result,
      _id: result._id?.toString(),
    } as IModel;
  }

  async deleteModel(id: string): Promise<boolean> {
    const db = this.getTenantDb();
    const result = await db
      .collection('models')
      .deleteOne({ _id: new ObjectId(id) });
    return result.deletedCount === 1;
  }

  async listModels(filters?: {
    category?: ModelCategory;
    provider?: ModelProviderType;
    providerKey?: string;
    providerDriver?: string;
  }): Promise<IModel[]> {
    const db = this.getTenantDb();
    const query: Record<string, unknown> = {};

    if (filters?.category) {
      query.category = filters.category;
    }

    if (filters?.provider) {
      query.provider = filters.provider;
    }

    if (filters?.providerKey) {
      query.providerKey = filters.providerKey;
    }

    if (filters?.providerDriver) {
      query.providerDriver = filters.providerDriver;
    }

    const models = await db
      .collection<IModel>('models')
      .find(query)
      .sort({ createdAt: -1 })
      .toArray();

    return models.map((model) => ({
      ...model,
      _id: model._id?.toString(),
    }));
  }

  async findModelById(id: string): Promise<IModel | null> {
    const db = this.getTenantDb();
    const model = await db
      .collection<IModel>('models')
      .findOne({ _id: new ObjectId(id) });
    if (!model) {
      return null;
    }

    return {
      ...model,
      _id: model._id?.toString(),
    } as IModel;
  }

  async findModelByKey(key: string): Promise<IModel | null> {
    const db = this.getTenantDb();
    const model = await db.collection<IModel>('models').findOne({ key });
    if (!model) {
      return null;
    }

    return {
      ...model,
      _id: model._id?.toString(),
    } as IModel;
  }

  async createModelUsageLog(
    log: Omit<IModelUsageLog, '_id' | 'createdAt'>,
  ): Promise<IModelUsageLog> {
    const db = this.getTenantDb();
    const now = new Date();
    const logDoc = {
      ...log,
      createdAt: now,
    };

    const result = await db.collection('model_usage_logs').insertOne(logDoc);

    return {
      ...logDoc,
      _id: result.insertedId.toString(),
    };
  }

  async listModelUsageLogs(
    modelKey: string,
    options?: { limit?: number; skip?: number; from?: Date; to?: Date },
  ): Promise<IModelUsageLog[]> {
    const db = this.getTenantDb();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const query: Record<string, any> = { modelKey };

    if (options?.from || options?.to) {
      query.createdAt = {};
      if (options.from) {
        query.createdAt.$gte = options.from;
      }
      if (options.to) {
        query.createdAt.$lte = options.to;
      }
    }

    const limit = Math.min(options?.limit ?? 50, 200);
    const skip = options?.skip ?? 0;

    const logs = await db
      .collection<IModelUsageLog>('model_usage_logs')
      .find(query)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .toArray();

    return logs.map((logDoc) => ({
      ...logDoc,
      _id: logDoc._id?.toString(),
    }));
  }

  async aggregateModelUsage(
    modelKey: string,
    options?: { from?: Date; to?: Date; groupBy?: 'hour' | 'day' | 'month' },
  ): Promise<IModelUsageAggregate> {
    const db = this.getTenantDb();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const match: Record<string, any> = { modelKey };

    if (options?.from || options?.to) {
      match.createdAt = {};
      if (options.from) {
        match.createdAt.$gte = options.from;
      }
      if (options.to) {
        match.createdAt.$lte = options.to;
      }
    }

    const totals = await db
      .collection('model_usage_logs')
      .aggregate([
        { $match: match },
        {
          $group: {
            _id: null,
            totalCalls: { $sum: 1 },
            successCalls: {
              $sum: {
                $cond: [{ $eq: ['$status', 'success'] }, 1, 0],
              },
            },
            errorCalls: {
              $sum: {
                $cond: [{ $eq: ['$status', 'error'] }, 1, 0],
              },
            },
            totalInputTokens: { $sum: { $ifNull: ['$inputTokens', 0] } },
            totalOutputTokens: { $sum: { $ifNull: ['$outputTokens', 0] } },
            totalCachedInputTokens: {
              $sum: { $ifNull: ['$cachedInputTokens', 0] },
            },
            totalTokens: { $sum: { $ifNull: ['$totalTokens', 0] } },
            totalToolCalls: { $sum: { $ifNull: ['$toolCalls', 0] } },
            avgLatencyMs: { $avg: '$latencyMs' },
            totalCost: { $sum: { $ifNull: ['$pricingSnapshot.totalCost', 0] } },
            currency: { $first: '$pricingSnapshot.currency' },
            inputCost: { $sum: { $ifNull: ['$pricingSnapshot.inputCost', 0] } },
            outputCost: {
              $sum: { $ifNull: ['$pricingSnapshot.outputCost', 0] },
            },
            cachedCost: {
              $sum: { $ifNull: ['$pricingSnapshot.cachedCost', 0] },
            },
          },
        },
      ])
      .toArray();

    const totalsDoc = totals[0] ?? {
      totalCalls: 0,
      successCalls: 0,
      errorCalls: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCachedInputTokens: 0,
      totalTokens: 0,
      totalToolCalls: 0,
      avgLatencyMs: null,
      totalCost: 0,
      currency: 'USD',
      inputCost: 0,
      outputCost: 0,
      cachedCost: 0,
    };

    const unit = options?.groupBy ?? 'day';
    const timeseriesDocs = await db
      .collection('model_usage_logs')
      .aggregate([
        { $match: match },
        {
          $group: {
            _id: {
              $dateTrunc: {
                date: '$createdAt',
                unit,
              },
            },
            callCount: { $sum: 1 },
            inputTokens: { $sum: { $ifNull: ['$inputTokens', 0] } },
            outputTokens: { $sum: { $ifNull: ['$outputTokens', 0] } },
            cachedInputTokens: { $sum: { $ifNull: ['$cachedInputTokens', 0] } },
            totalTokens: { $sum: { $ifNull: ['$totalTokens', 0] } },
            totalCost: { $sum: { $ifNull: ['$pricingSnapshot.totalCost', 0] } },
          },
        },
        { $sort: { _id: 1 } },
      ])
      .toArray();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const timeseries = timeseriesDocs.map((doc: any) => ({
      period: doc._id instanceof Date ? doc._id.toISOString() : String(doc._id),
      callCount: doc.callCount ?? 0,
      inputTokens: doc.inputTokens ?? 0,
      outputTokens: doc.outputTokens ?? 0,
      cachedInputTokens: doc.cachedInputTokens ?? 0,
      totalTokens: doc.totalTokens ?? 0,
      totalCost: doc.totalCost ?? 0,
    }));

    const costSummary: IModelUsageCostSnapshot | undefined = totalsDoc.totalCost
      ? {
          currency: totalsDoc.currency || 'USD',
          totalCost: totalsDoc.totalCost ?? 0,
          inputCost: totalsDoc.inputCost ?? 0,
          outputCost: totalsDoc.outputCost ?? 0,
          cachedCost: totalsDoc.cachedCost ?? 0,
        }
      : undefined;

    return {
      modelKey,
      totalCalls: totalsDoc.totalCalls ?? 0,
      successCalls: totalsDoc.successCalls ?? 0,
      errorCalls: totalsDoc.errorCalls ?? 0,
      totalInputTokens: totalsDoc.totalInputTokens ?? 0,
      totalOutputTokens: totalsDoc.totalOutputTokens ?? 0,
      totalCachedInputTokens: totalsDoc.totalCachedInputTokens ?? 0,
      totalTokens: totalsDoc.totalTokens ?? 0,
      totalToolCalls: totalsDoc.totalToolCalls ?? 0,
      avgLatencyMs: totalsDoc.avgLatencyMs ?? null,
      costSummary,
      timeseries,
    };
  }

  async createVectorIndex(
    indexData: Omit<IVectorIndexRecord, '_id' | 'createdAt' | 'updatedAt'>,
  ): Promise<IVectorIndexRecord> {
    const db = this.getTenantDb();
    const now = new Date();

    const document: Omit<IVectorIndexRecord, '_id'> & {
      createdAt: Date;
      updatedAt: Date;
    } = {
      ...indexData,
      createdAt: now,
      updatedAt: now,
    };

    const result = await db
      .collection<IVectorIndexRecord>(
        MongoDBProvider.vectorIndexesCollection,
      )
      .insertOne(document as unknown as IVectorIndexRecord);

    return {
      ...document,
      _id: result.insertedId.toString(),
    };
  }

  async updateVectorIndex(
    id: string,
    data: Partial<
      Omit<IVectorIndexRecord, 'tenantId' | 'providerKey' | 'key'>
    >,
  ): Promise<IVectorIndexRecord | null> {
    const db = this.getTenantDb();
    const objectId = new ObjectId(id);

    const existing = await db
      .collection<IVectorIndexRecord>(
        MongoDBProvider.vectorIndexesCollection,
      )
      .findOne({ _id: objectId });

    if (!existing) {
      return null;
    }

    const { _id, tenantId, providerKey, key, ...updateData } =
      data as Partial<IVectorIndexRecord>;
    const payload: Partial<IVectorIndexRecord> = {
      ...updateData,
      updatedAt: new Date(),
    };

    const result = await db
      .collection<IVectorIndexRecord>(
        MongoDBProvider.vectorIndexesCollection,
      )
      .findOneAndUpdate(
        { _id: objectId },
        { $set: payload },
        { returnDocument: 'after' },
      );

    if (!result) {
      return null;
    }

    return {
      ...result,
      _id: result._id?.toString(),
    };
  }

  async deleteVectorIndex(id: string): Promise<boolean> {
    const db = this.getTenantDb();
    const result = await db
      .collection<IVectorIndexRecord>(
        MongoDBProvider.vectorIndexesCollection,
      )
      .deleteOne({ _id: new ObjectId(id) });

    return result.deletedCount > 0;
  }

  async listVectorIndexes(filters?: {
    providerKey?: string;
    search?: string;
  }): Promise<IVectorIndexRecord[]> {
    const db = this.getTenantDb();
    const query: Record<string, unknown> = {};

    if (filters?.providerKey) {
      query.providerKey = filters.providerKey;
    }

    if (filters?.search) {
      const regex = new RegExp(filters.search, 'i');
      query.$or = [{ key: regex }, { name: regex }];
    }

    const indexes = await db
      .collection<IVectorIndexRecord>(
        MongoDBProvider.vectorIndexesCollection,
      )
      .find(query)
      .sort({ createdAt: -1 })
      .toArray();

    return indexes.map((index) => ({
      ...index,
      _id: index._id?.toString(),
    }));
  }

  async findVectorIndexById(id: string): Promise<IVectorIndexRecord | null> {
    const db = this.getTenantDb();
    const index = await db
      .collection<IVectorIndexRecord>(
        MongoDBProvider.vectorIndexesCollection,
      )
      .findOne({ _id: new ObjectId(id) });

    if (!index) {
      return null;
    }

    return {
      ...index,
      _id: index._id?.toString(),
    };
  }

  async findVectorIndexByKey(
    providerKey: string,
    key: string,
  ): Promise<IVectorIndexRecord | null> {
    const db = this.getTenantDb();
    const index = await db
      .collection<IVectorIndexRecord>(
        MongoDBProvider.vectorIndexesCollection,
      )
      .findOne({ providerKey, key });

    if (!index) {
      return null;
    }

    return {
      ...index,
      _id: index._id?.toString(),
    };
  }

  async findVectorIndexByExternalId(
    providerKey: string,
    externalId: string,
  ): Promise<IVectorIndexRecord | null> {
    const db = this.getTenantDb();
    const index = await db
      .collection<IVectorIndexRecord>(
        MongoDBProvider.vectorIndexesCollection,
      )
      .findOne({ providerKey, externalId });

    if (!index) {
      return null;
    }

    return {
      ...index,
      _id: index._id?.toString(),
    };
  }

  async createProvider(
    provider: Omit<IProviderRecord, '_id' | 'createdAt' | 'updatedAt'>,
  ): Promise<IProviderRecord> {
    const db = this.getTenantDb();
    const now = new Date();
    const document: Omit<IProviderRecord, '_id'> & {
      createdAt: Date;
      updatedAt: Date;
    } = {
      ...provider,
      createdAt: now,
      updatedAt: now,
    };

    const result = await db
      .collection<IProviderRecord>(MongoDBProvider.providersCollection)
      .insertOne(document as unknown as IProviderRecord);

    return {
      ...document,
      _id: result.insertedId.toString(),
    };
  }

  async updateProvider(
    id: string,
    data: Partial<Omit<IProviderRecord, 'tenantId' | 'key'>>,
  ): Promise<IProviderRecord | null> {
    const db = this.getTenantDb();
    const objectId = new ObjectId(id);

    const existing = await db
      .collection<IProviderRecord>(MongoDBProvider.providersCollection)
      .findOne({ _id: objectId });

    if (!existing) {
      return null;
    }

    const { _id, tenantId, key, ...updateData } = data as Partial<IProviderRecord>;
    const payload: Partial<IProviderRecord> = {
      ...updateData,
      updatedAt: new Date(),
    };

    const result = await db
      .collection<IProviderRecord>(MongoDBProvider.providersCollection)
      .findOneAndUpdate(
        { _id: objectId },
        { $set: payload },
        { returnDocument: 'after' },
      );

    if (!result) {
      return null;
    }

    return {
      ...result,
      _id: result._id?.toString(),
    };
  }

  async findProviderById(id: string): Promise<IProviderRecord | null> {
    const db = this.getTenantDb();
    const provider = await db
      .collection<IProviderRecord>(MongoDBProvider.providersCollection)
      .findOne({ _id: new ObjectId(id) });

    if (!provider) {
      return null;
    }

    return {
      ...provider,
      _id: provider._id?.toString(),
    };
  }

  async findProviderByKey(
    tenantId: string,
    key: string,
  ): Promise<IProviderRecord | null> {
    const db = this.getTenantDb();
    const provider = await db
      .collection<IProviderRecord>(MongoDBProvider.providersCollection)
      .findOne({ tenantId, key });

    if (!provider) {
      return null;
    }

    return {
      ...provider,
      _id: provider._id?.toString(),
    };
  }

  async listProviders(
    tenantId: string,
    filters?: {
      type?: ProviderDomain;
      driver?: string;
      status?: IProviderRecord['status'];
    },
  ): Promise<IProviderRecord[]> {
    const db = this.getTenantDb();
    const query: Record<string, unknown> = { tenantId };

    if (filters?.type) {
      query.type = filters.type;
    }

    if (filters?.driver) {
      query.driver = filters.driver;
    }

    if (filters?.status) {
      query.status = filters.status;
    }

    const providers = await db
      .collection<IProviderRecord>(MongoDBProvider.providersCollection)
      .find(query)
      .sort({ createdAt: -1 })
      .toArray();

    return providers.map((provider) => ({
      ...provider,
      _id: provider._id?.toString(),
    }));
  }

  async deleteProvider(id: string): Promise<boolean> {
    const db = this.getTenantDb();
    const result = await db
      .collection<IProviderRecord>(MongoDBProvider.providersCollection)
      .deleteOne({ _id: new ObjectId(id) });

    return result.deletedCount > 0;
  }
}
