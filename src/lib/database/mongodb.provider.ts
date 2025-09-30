import { MongoClient, Db, ObjectId } from 'mongodb';
import { DatabaseProvider, IUser, IApiToken, ITenant, IAgentTracingSession, IAgentTracingEvent } from './provider.interface';

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
}
