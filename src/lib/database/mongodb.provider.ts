import { MongoClient, Db, ObjectId, type Filter } from 'mongodb';
import {
  DatabaseProvider,
  IUser,
  IApiToken,
  ITenant,
  IProject,
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
  IFileRecord,
  IFileBucketRecord,
  IPrompt,
  IPromptVersion,
  IPromptComment,
  ProviderDomain,
  IQuotaPolicy,
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
  private static readonly fileBucketsCollection = 'file_buckets';
  private static readonly filesCollection = 'files';
  private static readonly promptsCollection = 'prompts';
  private static readonly promptVersionsCollection = 'prompt_versions';
  private static readonly quotaPoliciesCollection = 'quota_policies';
  private static readonly rateLimitsCollection = 'rate_limits';
  private static readonly projectsCollection = 'projects';
  private static readonly vectorCountersCollection = 'vector_counters';

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

  private escapeRegex(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
    const updateData = { ...data };
    delete updateData._id;

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

    const payload: Partial<IUser> = { ...data };
    delete payload._id;

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

  // Project operations (tenant database)
  async createProject(
    project: Omit<IProject, '_id' | 'createdAt' | 'updatedAt'>,
  ): Promise<IProject> {
    const db = this.getTenantDb();
    const now = new Date();

    const payload = {
      ...project,
      createdAt: now,
      updatedAt: now,
    };

    const result = await db
      .collection<IProject>(MongoDBProvider.projectsCollection)
      .insertOne(payload);

    return {
      ...payload,
      _id: result.insertedId.toString(),
    };
  }

  async updateProject(
    id: string,
    data: Partial<Omit<IProject, 'tenantId' | 'key'>>,
  ): Promise<IProject | null> {
    const db = this.getTenantDb();
    const hasObjectId = ObjectId.isValid(id);
    const filter: Filter<IProject> = hasObjectId
      ? { _id: new ObjectId(id) }
      : { _id: id };

    const result = await db
      .collection<IProject>(MongoDBProvider.projectsCollection)
      .findOneAndUpdate(
        filter,
        { $set: { ...data, updatedAt: new Date() } },
        { returnDocument: 'after' },
      );

    if (!result) return null;

    const updated = result as IProject;
    return {
      ...updated,
      _id: updated._id?.toString(),
    } as IProject;
  }

  async deleteProject(id: string): Promise<boolean> {
    const db = this.getTenantDb();
    const hasObjectId = ObjectId.isValid(id);
    const filter: Filter<IProject> = hasObjectId
      ? { _id: new ObjectId(id) }
      : { _id: id };

    const result = await db
      .collection<IProject>(MongoDBProvider.projectsCollection)
      .deleteOne(filter);

    return result.deletedCount > 0;
  }

  async findProjectById(id: string): Promise<IProject | null> {
    const db = this.getTenantDb();
    const hasObjectId = ObjectId.isValid(id);
    const filter: Filter<IProject> = hasObjectId
      ? { _id: new ObjectId(id) }
      : { _id: id };

    const project = await db
      .collection<IProject>(MongoDBProvider.projectsCollection)
      .findOne(filter);

    if (!project) return null;
    return { ...project, _id: project._id?.toString() };
  }

  async findProjectByKey(tenantId: string, key: string): Promise<IProject | null> {
    const db = this.getTenantDb();
    const project = await db
      .collection<IProject>(MongoDBProvider.projectsCollection)
      .findOne({ tenantId, key } as Filter<IProject>);
    if (!project) return null;
    return { ...project, _id: project._id?.toString() };
  }

  async listProjects(tenantId: string): Promise<IProject[]> {
    const db = this.getTenantDb();
    const projects = await db
      .collection<IProject>(MongoDBProvider.projectsCollection)
      .find({ tenantId } as Filter<IProject>)
      .sort({ createdAt: -1 })
      .toArray();

    return projects.map((project) => ({
      ...project,
      _id: project._id?.toString(),
    }));
  }

  async assignProjectIdToLegacyRecords(tenantId: string, projectId: string): Promise<void> {
    const db = this.getTenantDb();
    const collections = [
      MongoDBProvider.providersCollection,
      'models',
      MongoDBProvider.vectorIndexesCollection,
      MongoDBProvider.fileBucketsCollection,
      MongoDBProvider.filesCollection,
      MongoDBProvider.promptsCollection,
      MongoDBProvider.promptVersionsCollection,
      MongoDBProvider.quotaPoliciesCollection,
      'agent_tracing_sessions',
      'agent_tracing_events',
      'model_usage_logs',
    ];

    await Promise.all(
      collections.map(async (collectionName) => {
        try {
          await db.collection(collectionName).updateMany(
            { tenantId, projectId: { $exists: false } },
            { $set: { projectId } },
          );
        } catch (error) {
          console.warn('[projects] Legacy migration skipped for', collectionName, error);
        }
      }),
    );
  }

  // Prompt operations (tenant database)
  async createPrompt(
    prompt: Omit<IPrompt, '_id' | 'createdAt' | 'updatedAt'>,
  ): Promise<IPrompt> {
    const db = this.getTenantDb();
    const now = new Date();
    const payload = {
      ...prompt,
      createdAt: now,
      updatedAt: now,
    };

    const result = await db
      .collection<IPrompt>(MongoDBProvider.promptsCollection)
      .insertOne(payload);

    return {
      ...payload,
      _id: result.insertedId.toString(),
    };
  }

  async updatePrompt(id: string, data: Partial<IPrompt>): Promise<IPrompt | null> {
    const db = this.getTenantDb();
    const hasObjectId = ObjectId.isValid(id);
    const filter: Filter<IPrompt> = hasObjectId
      ? { _id: new ObjectId(id) }
      : { _id: id };

    const updateData: Record<string, unknown> = {
      ...data,
      updatedAt: new Date(),
    };
    delete updateData._id;

    const result = await db
      .collection<IPrompt>(MongoDBProvider.promptsCollection)
      .findOneAndUpdate(filter, { $set: updateData }, { returnDocument: 'after' });

    if (!result) {
      return null;
    }

    const updated = result as IPrompt;
    return {
      ...updated,
      _id: updated._id?.toString(),
    } as IPrompt;
  }

  async deletePrompt(id: string): Promise<boolean> {
    const db = this.getTenantDb();
    const hasObjectId = ObjectId.isValid(id);
    const filter: Filter<IPrompt> = hasObjectId
      ? { _id: new ObjectId(id) }
      : { _id: id };

    const result = await db
      .collection<IPrompt>(MongoDBProvider.promptsCollection)
      .deleteOne(filter);

    return result.deletedCount > 0;
  }

  async findPromptById(id: string, projectId?: string): Promise<IPrompt | null> {
    const db = this.getTenantDb();
    const hasObjectId = ObjectId.isValid(id);
    const filter: Filter<IPrompt> = hasObjectId
      ? { _id: new ObjectId(id) }
      : { _id: id };
    if (projectId) {
      filter.projectId = projectId;
    }

    const prompt = await db
      .collection<IPrompt>(MongoDBProvider.promptsCollection)
      .findOne(filter);

    if (!prompt) return null;
    return { ...prompt, _id: prompt._id?.toString() } as IPrompt;
  }

  async findPromptByKey(key: string, projectId?: string): Promise<IPrompt | null> {
    const db = this.getTenantDb();
    const filter: Filter<IPrompt> = { key };
    if (projectId) {
      filter.projectId = projectId;
    }
    const prompt = await db
      .collection<IPrompt>(MongoDBProvider.promptsCollection)
      .findOne(filter);

    if (!prompt) return null;
    return { ...prompt, _id: prompt._id?.toString() } as IPrompt;
  }

  async listPrompts(filters?: {
    projectId?: string;
    search?: string;
  }): Promise<IPrompt[]> {
    const db = this.getTenantDb();
    const query: Filter<IPrompt> = {};

    if (filters?.projectId) {
      query.projectId = filters.projectId;
    }

    if (filters?.search) {
      const searchValue = filters.search.trim();
      if (searchValue) {
        const regex = new RegExp(this.escapeRegex(searchValue), 'i');
        query.$or = [{ name: regex }, { key: regex }, { description: regex }];
      }
    }

    const prompts = await db
      .collection<IPrompt>(MongoDBProvider.promptsCollection)
      .find(query)
      .sort({ updatedAt: -1, createdAt: -1 })
      .toArray();

    return prompts.map((prompt) => ({
      ...prompt,
      _id: prompt._id?.toString(),
    }));
  }

  async createPromptVersion(
    version: Omit<IPromptVersion, '_id' | 'createdAt'>,
  ): Promise<IPromptVersion> {
    const db = this.getTenantDb();
    const payload = {
      ...version,
      createdAt: new Date(),
    };

    const result = await db
      .collection<IPromptVersion>(MongoDBProvider.promptVersionsCollection)
      .insertOne(payload);

    return {
      ...payload,
      _id: result.insertedId.toString(),
    };
  }

  async updatePromptVersion(
    id: string,
    data: Partial<IPromptVersion>,
  ): Promise<IPromptVersion | null> {
    const db = this.getTenantDb();
    const hasObjectId = ObjectId.isValid(id);
    const filter: Filter<IPromptVersion> = hasObjectId
      ? { _id: new ObjectId(id) }
      : { _id: id };

    const updateData: Record<string, unknown> = { ...data };
    delete updateData._id;

    const result = await db
      .collection<IPromptVersion>(MongoDBProvider.promptVersionsCollection)
      .findOneAndUpdate(filter, { $set: updateData }, { returnDocument: 'after' });

    if (!result) {
      return null;
    }

    const updated = result as IPromptVersion;
    return {
      ...updated,
      _id: updated._id?.toString(),
    } as IPromptVersion;
  }

  async updatePromptVersions(
    promptId: string,
    data: Partial<IPromptVersion>,
    projectId?: string,
  ): Promise<number> {
    const db = this.getTenantDb();
    const filter: Filter<IPromptVersion> = { promptId };
    if (projectId) {
      filter.projectId = projectId;
    }
    const updateData: Record<string, unknown> = { ...data };
    delete updateData._id;
    const result = await db
      .collection<IPromptVersion>(MongoDBProvider.promptVersionsCollection)
      .updateMany(filter, { $set: updateData });

    return result.modifiedCount ?? 0;
  }

  async findPromptVersionById(
    id: string,
    promptId?: string,
    projectId?: string,
  ): Promise<IPromptVersion | null> {
    const db = this.getTenantDb();
    const hasObjectId = ObjectId.isValid(id);
    const filter: Filter<IPromptVersion> = hasObjectId
      ? { _id: new ObjectId(id) }
      : { _id: id };
    if (promptId) {
      filter.promptId = promptId;
    }
    if (projectId) {
      filter.projectId = projectId;
    }

    const version = await db
      .collection<IPromptVersion>(MongoDBProvider.promptVersionsCollection)
      .findOne(filter);

    if (!version) return null;
    return { ...version, _id: version._id?.toString() } as IPromptVersion;
  }

  async listPromptVersions(
    promptId: string,
    projectId?: string,
  ): Promise<IPromptVersion[]> {
    const db = this.getTenantDb();
    const filter: Filter<IPromptVersion> = { promptId };
    if (projectId) {
      filter.projectId = projectId;
    }

    const versions = await db
      .collection<IPromptVersion>(MongoDBProvider.promptVersionsCollection)
      .find(filter)
      .sort({ version: -1, createdAt: -1 })
      .toArray();

    return versions.map((version) => ({
      ...version,
      _id: version._id?.toString(),
    }));
  }

  async deletePromptVersions(promptId: string, projectId?: string): Promise<number> {
    const db = this.getTenantDb();
    const filter: Filter<IPromptVersion> = { promptId };
    if (projectId) {
      filter.projectId = projectId;
    }
    const result = await db
      .collection<IPromptVersion>(MongoDBProvider.promptVersionsCollection)
      .deleteMany(filter);
    return result.deletedCount ?? 0;
  }

  async deletePromptVersionsByPromptId(
    promptId: string,
    projectId?: string,
  ): Promise<number> {
    return this.deletePromptVersions(promptId, projectId);
  }

  // Prompt comments
  private static promptCommentsCollection = 'prompt_comments';

  async createPromptComment(
    comment: Omit<IPromptComment, '_id' | 'createdAt' | 'updatedAt'>,
  ): Promise<IPromptComment> {
    const db = this.getTenantDb();
    const now = new Date();
    const payload = {
      ...comment,
      createdAt: now,
      updatedAt: now,
    };

    const result = await db
      .collection<IPromptComment>(MongoDBProvider.promptCommentsCollection)
      .insertOne(payload);

    return {
      ...payload,
      _id: result.insertedId.toString(),
    };
  }

  async listPromptComments(
    promptId: string,
    options?: { versionId?: string; projectId?: string },
  ): Promise<IPromptComment[]> {
    const db = this.getTenantDb();
    const filter: Filter<IPromptComment> = { promptId };
    if (options?.versionId) {
      filter.versionId = options.versionId;
    }
    if (options?.projectId) {
      filter.projectId = options.projectId;
    }

    const comments = await db
      .collection<IPromptComment>(MongoDBProvider.promptCommentsCollection)
      .find(filter)
      .sort({ createdAt: -1 })
      .toArray();

    return comments.map((c) => ({
      ...c,
      _id: c._id?.toString(),
    }));
  }

  async updatePromptComment(
    id: string,
    data: Partial<Pick<IPromptComment, 'content'>>,
  ): Promise<IPromptComment | null> {
    const db = this.getTenantDb();
    const result = await db
      .collection<IPromptComment>(MongoDBProvider.promptCommentsCollection)
      .findOneAndUpdate(
        { _id: new ObjectId(id) },
        { $set: { ...data, updatedAt: new Date() } },
        { returnDocument: 'after' },
      );

    if (!result) return null;
    return { ...result, _id: result._id?.toString() };
  }

  async deletePromptComment(id: string): Promise<boolean> {
    const db = this.getTenantDb();
    const result = await db
      .collection<IPromptComment>(MongoDBProvider.promptCommentsCollection)
      .deleteOne({ _id: new ObjectId(id) });
    return result.deletedCount === 1;
  }

  async deletePromptCommentsByPromptId(promptId: string): Promise<number> {
    const db = this.getTenantDb();
    const result = await db
      .collection<IPromptComment>(MongoDBProvider.promptCommentsCollection)
      .deleteMany({ promptId });
    return result.deletedCount ?? 0;
  }

  // Quota policies (tenant database)
  async createQuotaPolicy(
    policy: Omit<IQuotaPolicy, '_id'>,
  ): Promise<IQuotaPolicy> {
    const db = this.getTenantDb();
    const now = new Date();
    const payload = {
      ...policy,
      createdAt: policy.createdAt ?? now,
      updatedAt: policy.updatedAt ?? now,
    };

    const result = await db
      .collection<IQuotaPolicy>(MongoDBProvider.quotaPoliciesCollection)
      .insertOne(payload);

    return {
      ...payload,
      _id: result.insertedId.toString(),
    };
  }

  async listQuotaPolicies(tenantId: string, projectId?: string): Promise<IQuotaPolicy[]> {
    const db = this.getTenantDb();
    const tenantFilter = ObjectId.isValid(tenantId)
      ? { $or: [{ tenantId }, { tenantId: new ObjectId(tenantId) }] }
      : { tenantId };
    const projectFilter = projectId ? { projectId } : {};
    const query: Filter<IQuotaPolicy> = {
      ...(tenantFilter as Record<string, unknown>),
      ...(projectFilter as Record<string, unknown>),
    };
    const policies = await db
      .collection<IQuotaPolicy>(MongoDBProvider.quotaPoliciesCollection)
      .find(query)
      .sort({ priority: -1, createdAt: -1 })
      .toArray();

    return policies.map((policy) => ({
      ...policy,
      _id: policy._id?.toString(),
    }));
  }

  async updateQuotaPolicy(
    id: string,
    tenantId: string,
    data: Partial<IQuotaPolicy>,
    projectId?: string,
  ): Promise<IQuotaPolicy | null> {
    const db = this.getTenantDb();
    const hasObjectId = ObjectId.isValid(id);
    const tenantFilter = ObjectId.isValid(tenantId)
      ? { $or: [{ tenantId }, { tenantId: new ObjectId(tenantId) }] }
      : { tenantId };
    const idFilter = hasObjectId
      ? { $or: [{ _id: new ObjectId(id) }, { _id: id }] }
      : { _id: id };
    const projectFilter = projectId ? { projectId } : {};
    const filter = { $and: [tenantFilter, idFilter, projectFilter] } as Filter<IQuotaPolicy>;
    const updateData = {
      ...data,
      updatedAt: new Date(),
    };

    const result = await db
      .collection<IQuotaPolicy>(MongoDBProvider.quotaPoliciesCollection)
      .findOneAndUpdate(
        filter,
        { $set: updateData },
        { returnDocument: 'after' },
      );

    if (!result) return null;

    return {
      ...result,
      _id: result._id?.toString(),
    } as IQuotaPolicy;
  }

  async deleteQuotaPolicy(id: string, tenantId: string, projectId?: string): Promise<boolean> {
    const db = this.getTenantDb();
    const hasObjectId = ObjectId.isValid(id);
    const tenantFilter = ObjectId.isValid(tenantId)
      ? { $or: [{ tenantId }, { tenantId: new ObjectId(tenantId) }] }
      : { tenantId };
    const idFilter = hasObjectId
      ? { $or: [{ _id: new ObjectId(id) }, { _id: id }] }
      : { _id: id };
    const projectFilter = projectId ? { projectId } : {};
    const filter = { $and: [tenantFilter, idFilter, projectFilter] } as Filter<IQuotaPolicy>;

    const result = await db
      .collection<IQuotaPolicy>(MongoDBProvider.quotaPoliciesCollection)
      .deleteOne(filter);

    return result.deletedCount > 0;
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

  async listTenantApiTokens(tenantId: string): Promise<IApiToken[]> {
    const db = this.getMainDb();
    const tokens = await db
      .collection<IApiToken>('api_tokens')
      .find({ tenantId })
      .sort({ createdAt: -1 })
      .toArray();

    return tokens.map((token: IApiToken) => ({
      ...token,
      _id: token._id?.toString(),
    }));
  }

  async listProjectApiTokens(tenantId: string, projectId: string): Promise<IApiToken[]> {
    const db = this.getMainDb();
    const tokens = await db
      .collection<IApiToken>('api_tokens')
      .find({ tenantId, projectId })
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

  async deleteTenantApiToken(id: string, tenantId: string): Promise<boolean> {
    const db = this.getMainDb();
    const result = await db.collection('api_tokens').deleteOne({
      _id: new ObjectId(id),
      tenantId,
    });
    return result.deletedCount > 0;
  }

  async deleteProjectApiToken(id: string, tenantId: string, projectId: string): Promise<boolean> {
    const db = this.getMainDb();
    const result = await db.collection('api_tokens').deleteOne({
      _id: new ObjectId(id),
      tenantId,
      projectId,
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

  async countAgentTracingDistinctAgents(projectId?: string): Promise<number> {
    const db = this.getTenantDb();
    const match: Record<string, unknown> = {
      agentName: { $type: 'string', $ne: '' },
    };

    if (projectId) {
      match.projectId = projectId;
    }

    const result = await db
      .collection('agent_tracing_sessions')
      .aggregate([{ $match: match }, { $group: { _id: '$agentName' } }, { $count: 'count' }])
      .toArray();

    const count = (result[0] as { count?: number } | undefined)?.count;
    return typeof count === 'number' ? count : 0;
  }

  async agentTracingAgentExists(agentName: string, projectId?: string): Promise<boolean> {
    const db = this.getTenantDb();
    const trimmed = agentName.trim();
    if (!trimmed) {
      return false;
    }

    const existing = await db
      .collection('agent_tracing_sessions')
      .findOne(projectId ? { projectId, agentName: trimmed } : { agentName: trimmed }, {
        projection: { _id: 1 },
      });

    return Boolean(existing);
  }

  async cleanupAgentTracingRetention(options: {
    projectId?: string;
    olderThan: Date;
    batchSize?: number;
  }): Promise<{ sessionsDeleted: number; eventsDeleted: number }> {
    const db = this.getTenantDb();

    const batchSize = Math.max(1, Math.min(options.batchSize ?? 500, 2000));
    const cutoff = options.olderThan;

    const sessionQuery: Record<string, unknown> = {
      $or: [
        { startedAt: { $lt: cutoff } },
        { startedAt: { $exists: false }, createdAt: { $lt: cutoff } },
      ],
    };
    if (options.projectId) {
      sessionQuery.projectId = options.projectId;
    }

    let sessionsDeleted = 0;
    let eventsDeleted = 0;

    // Iterate in batches to avoid pulling too many session ids into memory.
    while (true) {
      const sessions = await db
        .collection<IAgentTracingSession>('agent_tracing_sessions')
        .find(sessionQuery, { projection: { sessionId: 1 } })
        .limit(batchSize)
        .toArray();

      const sessionIds = sessions
        .map((s) => s.sessionId)
        .filter((value): value is string => typeof value === 'string' && value.length > 0);

      if (sessionIds.length === 0) {
        break;
      }

      const eventQuery: Record<string, unknown> = { sessionId: { $in: sessionIds } };
      if (options.projectId) {
        eventQuery.projectId = options.projectId;
      }

      const eventResult = await db
        .collection('agent_tracing_events')
        .deleteMany(eventQuery);
      eventsDeleted += eventResult.deletedCount ?? 0;

      const sessionDeleteQuery: Record<string, unknown> = { sessionId: { $in: sessionIds } };
      if (options.projectId) {
        sessionDeleteQuery.projectId = options.projectId;
      }

      const sessionResult = await db
        .collection('agent_tracing_sessions')
        .deleteMany(sessionDeleteQuery);
      sessionsDeleted += sessionResult.deletedCount ?? 0;
    }

    return { sessionsDeleted, eventsDeleted };
  }

  async updateAgentTracingSession(
    sessionId: string,
    data: Partial<IAgentTracingSession>,
    projectId?: string,
  ): Promise<IAgentTracingSession | null> {
    const db = this.getTenantDb();
    const updateData = {
      ...data,
      updatedAt: new Date(),
    };

    const filter = projectId ? { sessionId, projectId } : { sessionId };

    const result = await db
      .collection('agent_tracing_sessions')
      .findOneAndUpdate(
        filter,
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
    projectId?: string,
  ): Promise<IAgentTracingSession | null> {
    const db = this.getTenantDb();
    const session = await db
      .collection<IAgentTracingSession>('agent_tracing_sessions')
      .findOne(projectId ? { sessionId, projectId } : { sessionId });

    if (!session) return null;

    return {
      ...session,
      _id: session._id?.toString(),
    };
  }

  async listAgentTracingSessions(
    filters?: Record<string, unknown>,
    projectId?: string,
  ): Promise<{ sessions: IAgentTracingSession[]; total: number }> {
    const db = this.getTenantDb();
    const query: Record<string, unknown> = {};

    if (projectId) {
      query.projectId = projectId;
    }

    if (filters?.agentName) {
      query.agentName = { $regex: filters.agentName, $options: 'i' };
    }

    if (filters?.status) {
      query.status = filters.status;
    }

    if (filters?.threadId) {
      query.threadId = filters.threadId;
    }

    if (filters?.from || filters?.to) {
      const startedAt: { $gte?: Date; $lte?: Date } = {};
      if (typeof filters.from === 'string') startedAt.$gte = new Date(filters.from);
      if (typeof filters.to === 'string') startedAt.$lte = new Date(filters.to);
      query.startedAt = startedAt;
    }

    const limit = parseInt(String(filters?.limit ?? '50'));
    const skip = parseInt(String(filters?.skip ?? '0'));

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

  /**
   * List threads (distinct threadId values) with aggregated session info.
   */
  async listAgentTracingThreads(
    filters?: Record<string, unknown>,
    projectId?: string,
  ): Promise<{ threads: Array<Record<string, unknown>>; total: number }> {
    const db = this.getTenantDb();
    const match: Record<string, unknown> = {
      threadId: { $type: 'string', $ne: '' },
    };

    if (projectId) {
      match.projectId = projectId;
    }

    if (filters?.agentName) {
      match.agentName = { $regex: filters.agentName, $options: 'i' };
    }

    if (filters?.status) {
      match.status = filters.status;
    }

    if (filters?.from || filters?.to) {
      const startedAt: { $gte?: Date; $lte?: Date } = {};
      if (typeof filters?.from === 'string') startedAt.$gte = new Date(filters.from);
      if (typeof filters?.to === 'string') startedAt.$lte = new Date(filters.to);
      match.startedAt = startedAt;
    }

    const limit = parseInt(String(filters?.limit ?? '50'));
    const skip = parseInt(String(filters?.skip ?? '0'));

    const pipeline = [
      { $match: match },
      {
        $group: {
          _id: '$threadId',
          sessionsCount: { $sum: 1 },
          agents: { $addToSet: '$agentName' },
          statuses: { $addToSet: '$status' },
          startedAt: { $min: '$startedAt' },
          endedAt: { $max: '$endedAt' },
          totalEvents: { $sum: { $ifNull: ['$totalEvents', 0] } },
          totalInputTokens: { $sum: { $ifNull: ['$totalInputTokens', 0] } },
          totalOutputTokens: { $sum: { $ifNull: ['$totalOutputTokens', 0] } },
          totalDurationMs: { $sum: { $ifNull: ['$durationMs', 0] } },
          latestStatus: { $last: '$status' },
          modelsUsed: { $addToSet: '$modelsUsed' },
        },
      },
      { $sort: { startedAt: -1 as const } },
      {
        $facet: {
          threads: [{ $skip: skip }, { $limit: limit }],
          totalCount: [{ $count: 'count' }],
        },
      },
    ];

    const result = await db
      .collection('agent_tracing_sessions')
      .aggregate(pipeline)
      .toArray();

    const facet = result[0] as {
      threads?: Array<Record<string, unknown>>;
      totalCount?: Array<{ count: number }>;
    } | undefined;

    const threads = (facet?.threads || []).map((t) => ({
      threadId: t._id as string,
      sessionsCount: t.sessionsCount as number,
      agents: (t.agents as string[]).filter(Boolean),
      statuses: t.statuses as string[],
      latestStatus: t.latestStatus as string,
      startedAt: t.startedAt as Date,
      endedAt: t.endedAt as Date,
      totalEvents: t.totalEvents as number,
      totalInputTokens: t.totalInputTokens as number,
      totalOutputTokens: t.totalOutputTokens as number,
      totalDurationMs: t.totalDurationMs as number,
      modelsUsed: [...new Set((t.modelsUsed as string[][]).flat().filter(Boolean))],
    }));

    const total = (facet?.totalCount as Array<{ count: number }> | undefined)?.[0]?.count ?? 0;

    return { threads, total };
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
    projectId?: string,
  ): Promise<IAgentTracingEvent[]> {
    const db = this.getTenantDb();
    const events = await db
      .collection<IAgentTracingEvent>('agent_tracing_events')
      .find(projectId ? { sessionId, projectId } : { sessionId })
      .sort({ sequence: 1, timestamp: 1 })
      .toArray();

    return events.map((event: IAgentTracingEvent) => ({
      ...event,
      _id: event._id?.toString(),
    }));
  }

  async deleteAgentTracingEvents(sessionId: string, projectId?: string): Promise<number> {
    const db = this.getTenantDb();
    const result = await db
      .collection('agent_tracing_events')
      .deleteMany(projectId ? { sessionId, projectId } : { sessionId });
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
    const updateData: Record<string, unknown> = {
      ...data,
      updatedAt: new Date(),
    };
    delete updateData._id;

    const pricing = data.pricing;
    if (pricing) {
      updateData.pricing = {
        currency: pricing.currency || 'USD',
        inputTokenPer1M: pricing.inputTokenPer1M,
        outputTokenPer1M: pricing.outputTokenPer1M,
        cachedTokenPer1M: pricing.cachedTokenPer1M ?? 0,
      };
    }

    if (data.providerDriver !== undefined && data.provider === undefined) {
      updateData.provider = data.providerDriver as ModelProviderType;
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
    projectId?: string;
    category?: ModelCategory;
    provider?: ModelProviderType;
    providerKey?: string;
    providerDriver?: string;
  }): Promise<IModel[]> {
    const db = this.getTenantDb();
    const query: Record<string, unknown> = {};

    if (filters?.projectId) {
      query.projectId = filters.projectId;
    }

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

  async findModelById(id: string, projectId?: string): Promise<IModel | null> {
    const db = this.getTenantDb();
    const query: Record<string, unknown> = { _id: new ObjectId(id) };
    if (projectId) {
      query.projectId = projectId;
    }
    const model = await db
      .collection<IModel>('models')
      .findOne(query);
    if (!model) {
      return null;
    }

    return {
      ...model,
      _id: model._id?.toString(),
    } as IModel;
  }

  async findModelByKey(key: string, projectId?: string): Promise<IModel | null> {
    const db = this.getTenantDb();
    const query: Record<string, unknown> = { key };
    if (projectId) {
      query.projectId = projectId;
    }
    const model = await db.collection<IModel>('models').findOne(query);
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
    projectId?: string,
  ): Promise<IModelUsageLog[]> {
    const db = this.getTenantDb();
    const query: {
      modelKey: string;
      projectId?: string;
      createdAt?: { $gte?: Date; $lte?: Date };
    } = { modelKey };

    if (projectId) {
      query.projectId = projectId;
    }

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
    projectId?: string,
  ): Promise<IModelUsageAggregate> {
    const db = this.getTenantDb();
    const match: {
      modelKey: string;
      projectId?: string;
      createdAt?: { $gte?: Date; $lte?: Date };
    } = { modelKey };

    if (projectId) {
      match.projectId = projectId;
    }

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

    const timeseries = timeseriesDocs.map((doc) => {
      const record = doc as Record<string, unknown>;
      const periodValue = record._id;
      return {
        period: periodValue instanceof Date ? periodValue.toISOString() : String(periodValue),
        callCount: Number(record.callCount ?? 0),
        inputTokens: Number(record.inputTokens ?? 0),
        outputTokens: Number(record.outputTokens ?? 0),
        cachedInputTokens: Number(record.cachedInputTokens ?? 0),
        totalTokens: Number(record.totalTokens ?? 0),
        totalCost: Number(record.totalCost ?? 0),
      };
    });

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

    const payload: Partial<IVectorIndexRecord> = {
      ...(data as Partial<IVectorIndexRecord>),
      updatedAt: new Date(),
    };
    delete payload._id;
    delete payload.tenantId;
    delete payload.providerKey;
    delete payload.key;

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
    projectId?: string;
    search?: string;
  }): Promise<IVectorIndexRecord[]> {
    const db = this.getTenantDb();
    const query: Record<string, unknown> = {};

    if (filters?.projectId) {
      query.projectId = filters.projectId;
    }

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
    projectId?: string,
  ): Promise<IVectorIndexRecord | null> {
    const db = this.getTenantDb();
    const index = await db
      .collection<IVectorIndexRecord>(
        MongoDBProvider.vectorIndexesCollection,
      )
        .findOne({ providerKey, key, ...(projectId ? { projectId } : {}) } as Filter<IVectorIndexRecord>);

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
    projectId?: string,
  ): Promise<IVectorIndexRecord | null> {
    const db = this.getTenantDb();
    const index = await db
      .collection<IVectorIndexRecord>(
        MongoDBProvider.vectorIndexesCollection,
      )
        .findOne({ providerKey, externalId, ...(projectId ? { projectId } : {}) } as Filter<IVectorIndexRecord>);

    if (!index) {
      return null;
    }

    return {
      ...index,
      _id: index._id?.toString(),
    };
  }

  async createFileRecord(
    record: Omit<IFileRecord, '_id' | 'createdAt' | 'updatedAt'>,
  ): Promise<IFileRecord> {
    const db = this.getTenantDb();
    const now = new Date();
    const document: Omit<IFileRecord, '_id'> & {
      createdAt: Date;
      updatedAt: Date;
    } = {
      ...record,
      createdAt: now,
      updatedAt: now,
    };

    const result = await db
      .collection<IFileRecord>(MongoDBProvider.filesCollection)
      .insertOne(document as unknown as IFileRecord);

    return {
      ...document,
      _id: result.insertedId.toString(),
    };
  }

  async updateFileRecord(
    id: string,
    data: Partial<
      Omit<IFileRecord, 'tenantId' | 'providerKey' | 'bucketKey' | 'key' | 'createdBy'>
    >,
  ): Promise<IFileRecord | null> {
    const db = this.getTenantDb();
    const objectId = new ObjectId(id);

    const existing = await db
      .collection<IFileRecord>(MongoDBProvider.filesCollection)
      .findOne({ _id: objectId });

    if (!existing) {
      return null;
    }

    const payload: Partial<IFileRecord> = {
      ...(data as Partial<IFileRecord>),
      updatedAt: new Date(),
    };
    delete payload._id;
    delete payload.tenantId;
    delete payload.providerKey;
    delete payload.bucketKey;
    delete payload.key;
    delete payload.createdBy;

    const result = await db
      .collection<IFileRecord>(MongoDBProvider.filesCollection)
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
    } as IFileRecord;
  }

  async deleteFileRecord(id: string): Promise<boolean> {
    const db = this.getTenantDb();
    const result = await db
      .collection<IFileRecord>(MongoDBProvider.filesCollection)
      .deleteOne({ _id: new ObjectId(id) });

    return result.deletedCount > 0;
  }

  async findFileRecordById(id: string): Promise<IFileRecord | null> {
    const db = this.getTenantDb();
    const record = await db
      .collection<IFileRecord>(MongoDBProvider.filesCollection)
      .findOne({ _id: new ObjectId(id) });

    if (!record) {
      return null;
    }

    return {
      ...record,
      _id: record._id?.toString(),
    };
  }

  async findFileRecordByKey(
    providerKey: string,
    bucketKey: string,
    key: string,
    projectId?: string,
  ): Promise<IFileRecord | null> {
    const db = this.getTenantDb();
    const record = await db
      .collection<IFileRecord>(MongoDBProvider.filesCollection)
      .findOne(projectId ? { providerKey, bucketKey, key, projectId } : { providerKey, bucketKey, key });

    if (!record) {
      return null;
    }

    return {
      ...record,
      _id: record._id?.toString(),
    };
  }

  async listFileRecords(filters: {
    providerKey: string;
    bucketKey: string;
    projectId?: string;
    search?: string;
    limit?: number;
    cursor?: string;
  }): Promise<{ items: IFileRecord[]; nextCursor?: string }> {
    const db = this.getTenantDb();
    const query: Record<string, unknown> = {
      providerKey: filters.providerKey,
      bucketKey: filters.bucketKey,
    };

    if (filters.projectId) {
      query.projectId = filters.projectId;
    }

    if (filters.search) {
      const regex = new RegExp(filters.search, 'i');
      query.$or = [{ key: regex }, { name: regex }];
    }

    if (filters.cursor) {
      try {
        query._id = { $gt: new ObjectId(filters.cursor) };
      } catch (error) {
        console.warn('Invalid cursor provided for listFileRecords:', filters.cursor, error);
      }
    }

    const limit = Math.min(filters.limit ?? 50, 200);

    const documents = await db
      .collection<IFileRecord>(MongoDBProvider.filesCollection)
      .find(query)
      .sort({ _id: 1 })
      .limit(limit + 1)
      .toArray();

    const items = documents.slice(0, limit).map((record) => ({
      ...record,
      _id: record._id?.toString(),
    }));

    const next = documents.length > limit ? documents[limit] : undefined;
    const nextCursor = next?._id ? next._id.toString() : undefined;

    return {
      items,
      nextCursor,
    };
  }

  async countFileRecords(filters?: { projectId?: string }): Promise<number> {
    const db = this.getTenantDb();
    const query: Record<string, unknown> = {};
    if (filters?.projectId) {
      query.projectId = filters.projectId;
    }

    return db
      .collection<IFileRecord>(MongoDBProvider.filesCollection)
      .countDocuments(query);
  }

  async sumFileRecordBytes(filters?: { projectId?: string }): Promise<number> {
    const db = this.getTenantDb();
    const match: Record<string, unknown> = {};
    if (filters?.projectId) {
      match.projectId = filters.projectId;
    }

    const result = await db
      .collection<IFileRecord>(MongoDBProvider.filesCollection)
      .aggregate([
        { $match: match },
        {
          $group: {
            _id: null,
            total: {
              $sum: {
                $add: [
                  { $ifNull: ['$size', 0] },
                  { $ifNull: ['$markdownSize', 0] },
                ],
              },
            },
          },
        },
      ])
      .toArray();

    const total = (result[0] as { total?: number } | undefined)?.total;
    return typeof total === 'number' ? total : 0;
  }

  async getProjectVectorCountApprox(projectId: string): Promise<number> {
    const db = this.getTenantDb();
    const doc = await db
      .collection(MongoDBProvider.vectorCountersCollection)
      .findOne({ projectId }, { projection: { count: 1 } });

    const count = (doc as { count?: number } | null)?.count;
    return typeof count === 'number' ? count : 0;
  }

  async incrementProjectVectorCountApprox(projectId: string, delta: number): Promise<number> {
    const db = this.getTenantDb();
    const now = new Date();
    const safeDelta = Number.isFinite(delta) ? Math.trunc(delta) : 0;

    const result = await db
      .collection(MongoDBProvider.vectorCountersCollection)
      .findOneAndUpdate(
        { projectId },
        [
          {
            $set: {
              projectId,
              updatedAt: now,
              createdAt: { $ifNull: ['$createdAt', now] },
              count: {
                $max: [
                  0,
                  {
                    $add: [
                      { $ifNull: ['$count', 0] },
                      safeDelta,
                    ],
                  },
                ],
              },
            },
          },
        ],
        { upsert: true, returnDocument: 'after' },
      );

    const count = (result as { count?: number } | null)?.count;
    return typeof count === 'number' ? count : 0;
  }

  async createFileBucket(
    bucket: Omit<IFileBucketRecord, '_id' | 'createdAt' | 'updatedAt'>,
  ): Promise<IFileBucketRecord> {
    const db = this.getTenantDb();
    const now = new Date();
    const document: Omit<IFileBucketRecord, '_id'> & {
      createdAt: Date;
      updatedAt: Date;
    } = {
      ...bucket,
      createdAt: now,
      updatedAt: now,
    };

    const result = await db
      .collection<IFileBucketRecord>(MongoDBProvider.fileBucketsCollection)
      .insertOne(document as unknown as IFileBucketRecord);

    return {
      ...document,
      _id: result.insertedId.toString(),
    };
  }

  async updateFileBucket(
    id: string,
    data: Partial<Omit<IFileBucketRecord, 'tenantId' | 'key' | 'providerKey'>>,
  ): Promise<IFileBucketRecord | null> {
    const db = this.getTenantDb();
    const objectId = new ObjectId(id);

    const existing = await db
      .collection<IFileBucketRecord>(MongoDBProvider.fileBucketsCollection)
      .findOne({ _id: objectId });

    if (!existing) {
      return null;
    }

    const payload: Partial<IFileBucketRecord> = {
      ...(data as Partial<IFileBucketRecord>),
      updatedAt: new Date(),
    };
    delete payload._id;
    delete payload.tenantId;
    delete payload.key;
    delete payload.providerKey;

    const result = await db
      .collection<IFileBucketRecord>(MongoDBProvider.fileBucketsCollection)
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

  async deleteFileBucket(id: string): Promise<boolean> {
    const db = this.getTenantDb();
    const result = await db
      .collection<IFileBucketRecord>(MongoDBProvider.fileBucketsCollection)
      .deleteOne({ _id: new ObjectId(id) });

    return result.deletedCount > 0;
  }

  async findFileBucketById(id: string): Promise<IFileBucketRecord | null> {
    const db = this.getTenantDb();
    const record = await db
      .collection<IFileBucketRecord>(MongoDBProvider.fileBucketsCollection)
      .findOne({ _id: new ObjectId(id) });

    if (!record) {
      return null;
    }

    return {
      ...record,
      _id: record._id?.toString(),
    };
  }

  async findFileBucketByKey(
    tenantId: string,
    key: string,
    projectId?: string,
  ): Promise<IFileBucketRecord | null> {
    const db = this.getTenantDb();
    const query: Record<string, unknown> = { tenantId, key };
    if (projectId) {
      query.projectId = projectId;
    }
    const record = await db
      .collection<IFileBucketRecord>(MongoDBProvider.fileBucketsCollection)
      .findOne(query);

    if (!record) {
      return null;
    }

    return {
      ...record,
      _id: record._id?.toString(),
    };
  }

  async listFileBuckets(tenantId: string, projectId?: string): Promise<IFileBucketRecord[]> {
    const db = this.getTenantDb();
    const query: Record<string, unknown> = { tenantId };
    if (projectId) {
      query.projectId = projectId;
    }
    const records = await db
      .collection<IFileBucketRecord>(MongoDBProvider.fileBucketsCollection)
      .find(query)
      .sort({ createdAt: -1 })
      .toArray();

    return records.map((record) => ({
      ...record,
      _id: record._id?.toString(),
    }));
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

    const payload: Partial<IProviderRecord> = {
      ...(data as Partial<IProviderRecord>),
      updatedAt: new Date(),
    };
    delete payload._id;
    delete payload.tenantId;
    delete payload.key;

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
    projectId?: string,
  ): Promise<IProviderRecord | null> {
    const db = this.getTenantDb();
    const query: Record<string, unknown> = { tenantId, key };
    if (projectId) {
      // Treat projectId as an assignment filter.
      // Supports legacy single-project providers (projectId) and multi-assigned providers (projectIds).
      query.$or = [{ projectId }, { projectIds: projectId }];
    }
    const provider = await db
      .collection<IProviderRecord>(MongoDBProvider.providersCollection)
      .findOne(query as Filter<IProviderRecord>);

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
      projectId?: string;
    },
  ): Promise<IProviderRecord[]> {
    const db = this.getTenantDb();
    const query: Record<string, unknown> = { tenantId };

    if (filters?.projectId) {
      query.$or = [{ projectId: filters.projectId }, { projectIds: filters.projectId }];
    }

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

  async incrementRateLimit(
    key: string,
    windowSeconds: number,
    amount: number = 1,
  ): Promise<{ count: number; resetAt: Date }> {
    type RateLimitRecord = {
      _id: string;
      count: number;
      resetAt: Date;
      isExpired?: boolean;
    };

    const db = this.getTenantDb();
    const now = new Date();
    const resetAt = new Date(now.getTime() + windowSeconds * 1000);

    // Use pipeline update for atomic check-and-set
    const result = await db
      .collection<RateLimitRecord>(MongoDBProvider.rateLimitsCollection)
      .findOneAndUpdate(
        { _id: key } as Filter<RateLimitRecord>,
        [
          {
            $set: {
              isExpired: { $lt: ['$resetAt', now] },
            },
          },
          {
            $set: {
              count: {
                $cond: {
                  if: { $or: [{ $eq: ['$isExpired', true] }, { $not: ['$resetAt'] }] },
                  then: amount,
                  else: { $add: ['$count', amount] },
                },
              },
              resetAt: {
                $cond: {
                  if: { $or: [{ $eq: ['$isExpired', true] }, { $not: ['$resetAt'] }] },
                  then: resetAt,
                  else: '$resetAt',
                },
              },
            },
          },
          {
            $unset: 'isExpired',
          },
        ],
        { upsert: true, returnDocument: 'after' },
      );

    if (!result) {
      throw new Error('Failed to increment rate limit');
    }

    return {
      count: result.count,
      resetAt: result.resetAt,
    };
  }
}
