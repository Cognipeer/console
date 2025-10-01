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
} from './provider.interface';

export class MongoDBProvider implements DatabaseProvider {
    private client: MongoClient | null = null;
    private mainDb: Db | null = null; // Shared database for tenants
    private tenantDb: Db | null = null; // Current tenant-specific database
    private readonly uri: string;
    private readonly mainDbName: string;

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

    async switchToTenant(tenantDbName: string): Promise<void> {
        if (!this.client) {
            throw new Error('Database client not connected. Call connect() first.');
        }
        this.tenantDb = this.client.db(tenantDbName);
    }

    // Tenant operations (use main DB)
    async createTenant(tenantData: Omit<ITenant, '_id' | 'createdAt' | 'updatedAt'>): Promise<ITenant> {
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
        const tenant = await db.collection<ITenant>('tenants').findOne({ _id: new ObjectId(id) as any });
        if (!tenant) return null;

        return {
            ...tenant,
            _id: tenant._id?.toString(),
        };
    }

    async updateTenant(id: string, data: Partial<ITenant>): Promise<ITenant | null> {
        const db = this.getMainDb();
        const { _id, ...updateData } = data;

        const result = await db.collection<ITenant>('tenants').findOneAndUpdate(
            { _id: new ObjectId(id) as any },
            {
                $set: {
                    ...updateData,
                    updatedAt: new Date()
                }
            },
            { returnDocument: 'after' }
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
        const user = await db.collection<IUser>('users').findOne({ email });
        if (!user) return null;

        return {
            ...user,
            _id: user._id?.toString(),
        };
    }

    async findUserById(id: string): Promise<IUser | null> {
        const db = this.getTenantDb();
        const user = await db.collection<IUser>('users').findOne({ _id: new ObjectId(id) as any });
        if (!user) return null;

        return {
            ...user,
            _id: user._id?.toString(),
        };
    }

    async createUser(userData: Omit<IUser, '_id' | 'createdAt' | 'updatedAt'>): Promise<IUser> {
        const db = this.getTenantDb();
        const now = new Date();

        const result = await db.collection('users').insertOne({
            ...userData,
            createdAt: now,
            updatedAt: now,
        });

        return {
            ...userData,
            _id: result.insertedId.toString(),
            createdAt: now,
            updatedAt: now,
        };
    }

    async updateUser(id: string, data: Partial<IUser>): Promise<IUser | null> {
        const db = this.getTenantDb();
        const { _id, ...updateData } = data;

        const result = await db.collection<IUser>('users').findOneAndUpdate(
            { _id: new ObjectId(id) as any },
            {
                $set: {
                    ...updateData,
                    updatedAt: new Date()
                }
            },
            { returnDocument: 'after' }
        );

        if (!result) return null;

        return {
            ...result,
            _id: result._id?.toString(),
        };
    }

    async deleteUser(id: string): Promise<boolean> {
        const db = this.getTenantDb();
        const result = await db.collection('users').deleteOne({ _id: new ObjectId(id) as any });
        return result.deletedCount > 0;
    }

    async listUsers(): Promise<IUser[]> {
        const db = this.getTenantDb();
        const users = await db.collection<IUser>('users')
            .find({})
            .sort({ createdAt: -1 })
            .toArray();

        return users.map((user: IUser) => ({
            ...user,
            _id: user._id?.toString(),
        }));
    }

    // API Token operations (use main DB because tokens need to be accessible before tenant resolution)
    async createApiToken(tokenData: Omit<IApiToken, '_id' | 'createdAt'>): Promise<IApiToken> {
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
        const tokens = await db.collection<IApiToken>('api_tokens')
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
        const apiToken = await db.collection<IApiToken>('api_tokens').findOne({ token });
        if (!apiToken) return null;

        return {
            ...apiToken,
            _id: apiToken._id?.toString(),
        };
    }

    async deleteApiToken(id: string, userId: string): Promise<boolean> {
        const db = this.getMainDb();
        const result = await db.collection('api_tokens').deleteOne({
            _id: new ObjectId(id) as any,
            userId
        });
        return result.deletedCount > 0;
    }

    async updateTokenLastUsed(token: string): Promise<void> {
        const db = this.getMainDb();
        await db.collection('api_tokens').updateOne(
            { token },
            { $set: { lastUsed: new Date() } }
        );
    }

    // Agent Tracing Session operations
    async createAgentTracingSession(session: Omit<IAgentTracingSession, '_id' | 'createdAt' | 'updatedAt'>): Promise<IAgentTracingSession> {
        const db = this.getTenantDb();
        const now = new Date();
        const sessionData = {
            ...session,
            createdAt: now,
            updatedAt: now
        };

        const result = await db.collection('agent_tracing_sessions').insertOne(sessionData as any);
        return {
            ...sessionData,
            _id: result.insertedId.toString()
        };
    }

    async updateAgentTracingSession(sessionId: string, data: Partial<IAgentTracingSession>): Promise<IAgentTracingSession | null> {
        const db = this.getTenantDb();
        const updateData = {
            ...data,
            updatedAt: new Date()
        };

        const result = await db.collection('agent_tracing_sessions').findOneAndUpdate(
            { sessionId },
            { $set: updateData },
            { returnDocument: 'after' }
        );

        if (!result) return null;

        return {
            ...result,
            _id: result._id.toString()
        } as IAgentTracingSession;
    }

    async findAgentTracingSessionById(sessionId: string): Promise<IAgentTracingSession | null> {
        const db = this.getTenantDb();
        const session = await db.collection<IAgentTracingSession>('agent_tracing_sessions').findOne({ sessionId });

        if (!session) return null;

        return {
            ...session,
            _id: session._id?.toString()
        };
    }

    async listAgentTracingSessions(filters?: any): Promise<{ sessions: IAgentTracingSession[], total: number }> {
        const db = this.getTenantDb();
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

        const sessions = await db.collection<IAgentTracingSession>('agent_tracing_sessions')
            .find(query)
            .sort({ startedAt: -1 })
            .limit(limit)
            .skip(skip)
            .toArray();

        const total = await db.collection('agent_tracing_sessions').countDocuments(query);

        return {
            sessions: sessions.map((session: IAgentTracingSession) => ({
                ...session,
                _id: session._id?.toString()
            })),
            total
        };
    }

    // Agent Tracing Event operations
    async createAgentTracingEvent(event: Omit<IAgentTracingEvent, '_id' | 'createdAt'>): Promise<IAgentTracingEvent> {
        const db = this.getTenantDb();
        const eventData = {
            ...event,
            createdAt: new Date()
        };
        const result = await db.collection('agent_tracing_events').insertOne(eventData as any);
        return {
            ...eventData,
            _id: result.insertedId.toString()
        };
    }

    async listAgentTracingEvents(sessionId: string): Promise<IAgentTracingEvent[]> {
        const db = this.getTenantDb();
        const events = await db.collection<IAgentTracingEvent>('agent_tracing_events')
            .find({ sessionId })
            .sort({ sequence: 1, timestamp: 1 })
            .toArray();

        return events.map((event: IAgentTracingEvent) => ({
            ...event,
            _id: event._id?.toString()
        }));
    }

    async deleteAgentTracingEvents(sessionId: string): Promise<number> {
        const db = this.getTenantDb();
        const result = await db.collection('agent_tracing_events').deleteMany({ sessionId });
        return result.deletedCount ?? 0;
    }

    // Model management operations
    async createModel(model: Omit<IModel, '_id' | 'createdAt' | 'updatedAt'>): Promise<IModel> {
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
            pricing,
            createdAt: now,
            updatedAt: now,
        };

        const result = await db.collection('models').insertOne(modelDoc as any);

        return {
            ...modelDoc,
            _id: result.insertedId.toString(),
        };
    }

    async updateModel(id: string, data: Partial<IModel>): Promise<IModel | null> {
        const db = this.getTenantDb();
        const { _id, pricing, ...rest } = data;

        const updateData: Record<string, any> = {
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

        const result = await db.collection<IModel>('models').findOneAndUpdate(
            { _id: new ObjectId(id) as any },
            { $set: updateData },
            { returnDocument: 'after' }
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
        const result = await db.collection('models').deleteOne({ _id: new ObjectId(id) as any });
        return result.deletedCount === 1;
    }

    async listModels(filters?: { category?: ModelCategory; provider?: ModelProviderType }): Promise<IModel[]> {
        const db = this.getTenantDb();
        const query: Record<string, any> = {};

        if (filters?.category) {
            query.category = filters.category;
        }

        if (filters?.provider) {
            query.provider = filters.provider;
        }

        const models = await db.collection<IModel>('models')
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
        const model = await db.collection<IModel>('models').findOne({ _id: new ObjectId(id) as any });
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

    async createModelUsageLog(log: Omit<IModelUsageLog, '_id' | 'createdAt'>): Promise<IModelUsageLog> {
        const db = this.getTenantDb();
        const now = new Date();
        const logDoc = {
            ...log,
            createdAt: now,
        };

        const result = await db.collection('model_usage_logs').insertOne(logDoc as any);

        return {
            ...logDoc,
            _id: result.insertedId.toString(),
        };
    }

    async listModelUsageLogs(modelKey: string, options?: { limit?: number; skip?: number; from?: Date; to?: Date; }): Promise<IModelUsageLog[]> {
        const db = this.getTenantDb();
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

        const logs = await db.collection<IModelUsageLog>('model_usage_logs')
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

    async aggregateModelUsage(modelKey: string, options?: { from?: Date; to?: Date; groupBy?: 'hour' | 'day' | 'month'; }): Promise<IModelUsageAggregate> {
        const db = this.getTenantDb();
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

        const totals = await db.collection('model_usage_logs')
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
                        totalCachedInputTokens: { $sum: { $ifNull: ['$cachedInputTokens', 0] } },
                        totalTokens: { $sum: { $ifNull: ['$totalTokens', 0] } },
                        totalToolCalls: { $sum: { $ifNull: ['$toolCalls', 0] } },
                        avgLatencyMs: { $avg: '$latencyMs' },
                        totalCost: { $sum: { $ifNull: ['$pricingSnapshot.totalCost', 0] } },
                        currency: { $first: '$pricingSnapshot.currency' },
                        inputCost: { $sum: { $ifNull: ['$pricingSnapshot.inputCost', 0] } },
                        outputCost: { $sum: { $ifNull: ['$pricingSnapshot.outputCost', 0] } },
                        cachedCost: { $sum: { $ifNull: ['$pricingSnapshot.cachedCost', 0] } },
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
        const timeseriesDocs = await db.collection('model_usage_logs')
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
}
