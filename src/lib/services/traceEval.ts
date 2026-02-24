import { getDatabase } from '@/lib/database';

export type TraceEvalDraftCase = {
  caseId: string;
  sessionId: string;
  threadId?: string;
  agentName?: string;
  createdFrom: {
    status?: string;
    startedAt?: Date;
    durationMs?: number;
    totalEvents?: number;
    totalInputTokens?: number;
    totalOutputTokens?: number;
    toolsUsed?: string[];
    modelsUsed?: string[];
  };
  input: {
    userMessages: string[];
    latestUserMessage?: string;
  };
  candidateAssertions: Array<
    | { type: 'latency_max_ms'; threshold: number; severity: 'medium' | 'high' }
    | { type: 'tool_error_rate_max'; threshold: number; severity: 'high' }
    | { type: 'min_output_tokens'; threshold: number; severity: 'low' }
  >;
  riskTags: string[];
};

export type TraceEvalScore = {
  sessionId: string;
  score: number;
  pass: boolean;
  checks: Array<{ name: string; pass: boolean; detail: string; weight: number }>;
};

function clamp(v: number, min = 0, max = 1) {
  return Math.max(min, Math.min(max, v));
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function extractUserMessages(events: Array<any>): string[] {
  const out: string[] = [];
  for (const e of events || []) {
    const sections = Array.isArray(e?.sections) ? e.sections : [];
    for (const s of sections) {
      if (s?.kind === 'message' && (s?.role === 'user' || s?.metadata?.role === 'user')) {
        const content = asString(s?.content).trim();
        if (content) out.push(content);
      }
    }
  }
  return out;
}

function riskTagsFromSession(session: any): string[] {
  const tags = new Set<string>();
  if ((session?.status || '').toLowerCase() === 'error') tags.add('runtime_error');
  if ((session?.durationMs || 0) > 8000) tags.add('latency_risk');
  if ((session?.totalOutputTokens || 0) > 4000) tags.add('cost_risk');
  if (Array.isArray(session?.errors) && session.errors.length > 0) tags.add('agent_error');
  return Array.from(tags);
}

export class TraceEvalService {
  static async generateDraftCases(
    tenantDbName: string,
    projectId: string,
    options?: {
      agent?: string;
      status?: string;
      from?: string;
      to?: string;
      limit?: number;
      riskFocus?: Array<'latency' | 'errors' | 'cost'>;
    },
  ): Promise<{ cases: TraceEvalDraftCase[]; totalScanned: number }> {
    const db = await getDatabase();
    await db.switchToTenant(tenantDbName);

    const limit = Math.min(Math.max(options?.limit || 50, 1), 200);
    const { sessions } = await db.listAgentTracingSessions(
      {
        agentName: options?.agent,
        status: options?.status,
        from: options?.from,
        to: options?.to,
        limit,
        skip: 0,
      },
      projectId,
    );

    const draftCases: TraceEvalDraftCase[] = [];
    for (const s of sessions) {
      const events = await db.listAgentTracingEvents(s.sessionId, projectId);
      const userMessages = extractUserMessages(events as any[]);

      const caseId = `draft_${s.sessionId}`;
      draftCases.push({
        caseId,
        sessionId: s.sessionId,
        threadId: s.threadId,
        agentName: s.agentName,
        createdFrom: {
          status: s.status,
          startedAt: s.startedAt,
          durationMs: s.durationMs,
          totalEvents: s.totalEvents,
          totalInputTokens: s.totalInputTokens,
          totalOutputTokens: s.totalOutputTokens,
          toolsUsed: s.toolsUsed,
          modelsUsed: s.modelsUsed,
        },
        input: {
          userMessages,
          latestUserMessage: userMessages[userMessages.length - 1],
        },
        candidateAssertions: [
          { type: 'latency_max_ms', threshold: 6000, severity: 'high' },
          { type: 'tool_error_rate_max', threshold: 0.2, severity: 'high' },
          { type: 'min_output_tokens', threshold: 16, severity: 'low' },
        ],
        riskTags: riskTagsFromSession(s),
      });
    }

    return { cases: draftCases, totalScanned: sessions.length };
  }

  static async scoreSessions(
    tenantDbName: string,
    projectId: string,
    options: {
      sessionIds: string[];
      thresholds?: {
        maxLatencyMs?: number;
        maxToolErrorRate?: number;
        minOutputTokens?: number;
      };
      passScore?: number;
    },
  ): Promise<{ results: TraceEvalScore[]; aggregate: { avgScore: number; passRate: number } }> {
    const db = await getDatabase();
    await db.switchToTenant(tenantDbName);

    const maxLatencyMs = options.thresholds?.maxLatencyMs ?? 6000;
    const maxToolErrorRate = options.thresholds?.maxToolErrorRate ?? 0.2;
    const minOutputTokens = options.thresholds?.minOutputTokens ?? 16;
    const passScore = clamp(options.passScore ?? 0.75);

    const results: TraceEvalScore[] = [];

    for (const sessionId of options.sessionIds) {
      const session = await db.findAgentTracingSessionById(sessionId, projectId);
      if (!session) continue;

      const events = await db.listAgentTracingEvents(sessionId, projectId);
      const toolEvents = events.filter((e: any) => e?.type === 'tool_call' || e?.toolName);
      const errorToolEvents = events.filter((e: any) => e?.type === 'tool_call' && e?.status === 'error');

      const latencyPass = (session.durationMs || 0) <= maxLatencyMs;
      const toolErrRate = toolEvents.length > 0 ? errorToolEvents.length / toolEvents.length : 0;
      const toolErrPass = toolErrRate <= maxToolErrorRate;
      const outputTokens = session.totalOutputTokens || 0;
      const outputPass = outputTokens >= minOutputTokens;

      const checks = [
        {
          name: 'latency_max_ms',
          pass: latencyPass,
          detail: `duration=${session.durationMs || 0}ms <= ${maxLatencyMs}`,
          weight: 0.4,
        },
        {
          name: 'tool_error_rate_max',
          pass: toolErrPass,
          detail: `rate=${toolErrRate.toFixed(3)} <= ${maxToolErrorRate}`,
          weight: 0.4,
        },
        {
          name: 'min_output_tokens',
          pass: outputPass,
          detail: `outputTokens=${outputTokens} >= ${minOutputTokens}`,
          weight: 0.2,
        },
      ];

      const score = checks.reduce((acc, c) => acc + (c.pass ? c.weight : 0), 0);
      const pass = score >= passScore;

      results.push({
        sessionId,
        score,
        pass,
        checks,
      });
    }

    const avgScore = results.length
      ? results.reduce((a, r) => a + r.score, 0) / results.length
      : 0;
    const passRate = results.length
      ? results.filter((r) => r.pass).length / results.length
      : 0;

    return {
      results,
      aggregate: { avgScore: Number(avgScore.toFixed(4)), passRate: Number(passRate.toFixed(4)) },
    };
  }
}
