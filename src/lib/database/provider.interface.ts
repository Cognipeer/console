/**
 * Database Provider Interface
 * This abstraction allows switching between different database providers (MongoDB, PostgreSQL, etc.)
 */

export interface ITenant {
  _id?: string;
  companyName: string;
  slug: string;
  dbName: string;
  licenseType: string;
  ownerId?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface IUser {
  _id?: string;
  email: string;
  password: string;
  name: string;
  tenantId: string;
  role: 'owner' | 'admin' | 'user';
  licenseId: string;
  features?: string[];
  invitedBy?: string;
  invitedAt?: Date;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface IApiToken {
  _id?: string;
  userId: string;
  tenantId: string;
  label: string;
  token: string;
  lastUsed?: Date;
  createdAt?: Date;
  expiresAt?: Date;
}

export interface IAgentTracingSession {
  _id?: string;
  sessionId: string;
  tenantId: string;
  agent?: any;
  agentName?: string;
  agentVersion?: string;
  agentModel?: string;
  config?: any;
  summary?: any;
  status?: string;
  startedAt?: Date;
  endedAt?: Date;
  durationMs?: number;
  errors?: any[];
  modelsUsed?: string[];
  toolsUsed?: string[];
  eventCounts?: any;
  totalEvents?: number;
  totalInputTokens?: number;
  totalOutputTokens?: number;
  totalCachedInputTokens?: number;
  totalBytesIn?: number;
  totalBytesOut?: number;
  totalRequestBytes?: number;
  totalResponseBytes?: number;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface IAgentTracingEvent {
  _id?: string;
  sessionId: string;
  tenantId: string;
  id?: string;
  type?: string;
  label?: string;
  sequence?: number;
  timestamp?: Date;
  status?: string;
  actor?: any;
  metadata?: any;
  sections?: any[];
  modelNames?: string[];
  model?: string;
  error?: any;
  durationMs?: number;
  actorName?: string;
  actorRole?: string;
  toolName?: string;
  toolExecutionId?: string;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cachedInputTokens?: number;
  bytesIn?: number;
  bytesOut?: number;
  requestBytes?: number;
  responseBytes?: number;
  createdAt?: Date;
}

export interface DatabaseProvider {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  
  // Tenant operations (uses main/shared database)
  createTenant(tenant: Omit<ITenant, '_id' | 'createdAt' | 'updatedAt'>): Promise<ITenant>;
  findTenantBySlug(slug: string): Promise<ITenant | null>;
  findTenantById(id: string): Promise<ITenant | null>;
  updateTenant(id: string, data: Partial<ITenant>): Promise<ITenant | null>;
  
  // Switch to tenant-specific database
  switchToTenant(tenantDbName: string): Promise<void>;
  
  // User operations (tenant-specific)
  findUserByEmail(email: string): Promise<IUser | null>;
  findUserById(id: string): Promise<IUser | null>;
  createUser(user: Omit<IUser, '_id' | 'createdAt' | 'updatedAt'>): Promise<IUser>;
  updateUser(id: string, data: Partial<IUser>): Promise<IUser | null>;
  deleteUser(id: string): Promise<boolean>;
  listUsers(): Promise<IUser[]>;
  
  // API Token operations (tenant-specific)
  createApiToken(token: Omit<IApiToken, '_id' | 'createdAt'>): Promise<IApiToken>;
  listApiTokens(userId: string): Promise<IApiToken[]>;
  findApiTokenByToken(token: string): Promise<IApiToken | null>;
  deleteApiToken(id: string, userId: string): Promise<boolean>;
  updateTokenLastUsed(token: string): Promise<void>;
  
  // Agent Tracing Session operations (tenant-specific)
  createAgentTracingSession(session: Omit<IAgentTracingSession, '_id' | 'createdAt' | 'updatedAt'>): Promise<IAgentTracingSession>;
  updateAgentTracingSession(sessionId: string, data: Partial<IAgentTracingSession>): Promise<IAgentTracingSession | null>;
  findAgentTracingSessionById(sessionId: string): Promise<IAgentTracingSession | null>;
  listAgentTracingSessions(filters?: any): Promise<{ sessions: IAgentTracingSession[], total: number }>;
  
  // Agent Tracing Event operations (tenant-specific)
  createAgentTracingEvent(event: Omit<IAgentTracingEvent, '_id' | 'createdAt'>): Promise<IAgentTracingEvent>;
  listAgentTracingEvents(sessionId: string): Promise<IAgentTracingEvent[]>;
  deleteAgentTracingEvents(sessionId: string): Promise<number>;
}
