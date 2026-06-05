/**
 * Prometheus Metrics Exporter
 *
 * Collects item-based metrics from all modules for a tenant and renders
 * them in the Prometheus text exposition format (version 0.0.4).
 *
 * Reference: https://prometheus.io/docs/instrumenting/exposition_formats/
 */

import { getTenantDatabase } from '@/lib/database';

// ── Prometheus text format helpers ─────────────────────────────────────────

type Labels = Record<string, string>;

interface MetricSample {
  labels?: Labels;
  value: number;
}

interface MetricFamily {
  name: string;
  help: string;
  type: 'counter' | 'gauge';
  samples: MetricSample[];
}

function labelStr(labels?: Labels): string {
  if (!labels || Object.keys(labels).length === 0) return '';
  const pairs = Object.entries(labels)
    .map(([k, v]) => `${k}="${escapeLabelValue(v)}"`)
    .join(',');
  return `{${pairs}}`;
}

function escapeLabelValue(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

function renderFamily(family: MetricFamily): string {
  const lines: string[] = [
    `# HELP ${family.name} ${family.help}`,
    `# TYPE ${family.name} ${family.type}`,
  ];
  for (const s of family.samples) {
    lines.push(`${family.name}${labelStr(s.labels)} ${s.value}`);
  }
  return lines.join('\n');
}

function renderFamilies(families: MetricFamily[]): string {
  return families.map(renderFamily).join('\n\n') + '\n';
}

// ── Metrics collection ──────────────────────────────────────────────────────

export async function collectPrometheusMetrics(
  tenantDbName: string,
  tenantId: string,
): Promise<string> {
  const db = await getTenantDatabase(tenantDbName);
  const families: MetricFamily[] = [];

  // ── Projects ──────────────────────────────────────────────────────────
  try {
    const projects = await db.listProjects(tenantId);
    families.push({
      name: 'console_projects_total',
      help: 'Total number of projects for this tenant.',
      type: 'gauge',
      samples: [{ value: projects.length }],
    });
  } catch {
    // non-fatal
  }

  // ── Users ─────────────────────────────────────────────────────────────
  try {
    const users = await db.listUsers();
    const byRole: Record<string, number> = {};
    for (const u of users) {
      byRole[u.role] = (byRole[u.role] ?? 0) + 1;
    }
    families.push({
      name: 'console_users_total',
      help: 'Total number of users per role.',
      type: 'gauge',
      samples: Object.entries(byRole).map(([role, count]) => ({
        labels: { role },
        value: count,
      })),
    });
  } catch {
    // non-fatal
  }

  // ── API Tokens ────────────────────────────────────────────────────────
  try {
    const tokens = await db.listTenantApiTokens(tenantId);
    families.push({
      name: 'console_api_tokens_total',
      help: 'Total number of API tokens for this tenant.',
      type: 'gauge',
      samples: [{ value: tokens.length }],
    });
  } catch {
    // non-fatal
  }

  // ── Models ────────────────────────────────────────────────────────────
  try {
    const models = await db.listModels();
    const byCat: Record<string, number> = {};
    for (const m of models) {
      byCat[m.category] = (byCat[m.category] ?? 0) + 1;
    }
    families.push({
      name: 'console_models_total',
      help: 'Total number of configured models per category.',
      type: 'gauge',
      samples: Object.entries(byCat).map(([category, count]) => ({
        labels: { category },
        value: count,
      })),
    });

    // Per-model usage aggregates (last 30 days)
    const from = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const requestSamples: MetricSample[] = [];
    const inputTokenSamples: MetricSample[] = [];
    const outputTokenSamples: MetricSample[] = [];
    const cachedTokenSamples: MetricSample[] = [];
    const latencySamples: MetricSample[] = [];
    const costSamples: MetricSample[] = [];
    const errorSamples: MetricSample[] = [];

    for (const model of models) {
      try {
        const agg = await db.aggregateModelUsage(model.key, { from });
        requestSamples.push({
          labels: { model: model.key },
          value: agg.totalCalls,
        });
        inputTokenSamples.push({
          labels: { model: model.key },
          value: agg.totalInputTokens,
        });
        outputTokenSamples.push({
          labels: { model: model.key },
          value: agg.totalOutputTokens,
        });
        cachedTokenSamples.push({
          labels: { model: model.key },
          value: agg.totalCachedInputTokens,
        });
        if (agg.avgLatencyMs !== null) {
          latencySamples.push({
            labels: { model: model.key },
            value: agg.avgLatencyMs / 1000,
          });
        }
        if (agg.costSummary?.totalCost !== undefined) {
          costSamples.push({
            labels: { model: model.key, currency: agg.costSummary.currency ?? 'USD' },
            value: agg.costSummary.totalCost,
          });
        }
        errorSamples.push({
          labels: { model: model.key },
          value: agg.errorCalls,
        });
      } catch {
        // skip model on error
      }
    }

    if (requestSamples.length > 0) {
      families.push({
        name: 'console_model_requests_total',
        help: 'Total number of model API requests in the last 30 days per model.',
        type: 'counter',
        samples: requestSamples,
      });
    }
    if (inputTokenSamples.length > 0) {
      families.push({
        name: 'console_model_input_tokens_total',
        help: 'Total input tokens consumed in the last 30 days per model.',
        type: 'counter',
        samples: inputTokenSamples,
      });
    }
    if (outputTokenSamples.length > 0) {
      families.push({
        name: 'console_model_output_tokens_total',
        help: 'Total output tokens generated in the last 30 days per model.',
        type: 'counter',
        samples: outputTokenSamples,
      });
    }
    if (cachedTokenSamples.length > 0) {
      families.push({
        name: 'console_model_cached_tokens_total',
        help: 'Total cached input tokens in the last 30 days per model.',
        type: 'counter',
        samples: cachedTokenSamples,
      });
    }
    if (latencySamples.length > 0) {
      families.push({
        name: 'console_model_avg_latency_seconds',
        help: 'Average model request latency in seconds over the last 30 days.',
        type: 'gauge',
        samples: latencySamples,
      });
    }
    if (costSamples.length > 0) {
      families.push({
        name: 'console_model_cost_total',
        help: 'Total estimated cost in the last 30 days per model.',
        type: 'counter',
        samples: costSamples,
      });
    }
    if (errorSamples.length > 0) {
      families.push({
        name: 'console_model_errors_total',
        help: 'Total number of failed model requests in the last 30 days per model.',
        type: 'counter',
        samples: errorSamples,
      });
    }
  } catch {
    // non-fatal
  }

  // ── Providers ─────────────────────────────────────────────────────────
  try {
    const providers = await db.listProviders(tenantId);
    const key = (type: string, status: string) => `${type}__${status}`;
    const byTypeStatus: Record<string, number> = {};
    for (const p of providers) {
      const k = key(p.type, p.status);
      byTypeStatus[k] = (byTypeStatus[k] ?? 0) + 1;
    }
    families.push({
      name: 'console_providers_total',
      help: 'Total number of configured providers per type and status.',
      type: 'gauge',
      samples: Object.entries(byTypeStatus).map(([k, count]) => {
        const [type, status] = k.split('__');
        return { labels: { type, status }, value: count };
      }),
    });
  } catch {
    // non-fatal
  }

  // ── Vector Indexes ────────────────────────────────────────────────────
  try {
    const indexes = await db.listVectorIndexes();
    families.push({
      name: 'console_vector_indexes_total',
      help: 'Total number of vector indexes per provider.',
      type: 'gauge',
      samples: (() => {
        const byProvider: Record<string, number> = {};
        for (const idx of indexes) {
          byProvider[idx.providerKey] = (byProvider[idx.providerKey] ?? 0) + 1;
        }
        return Object.entries(byProvider).map(([provider_key, count]) => ({
          labels: { provider_key },
          value: count,
        }));
      })(),
    });
  } catch {
    // non-fatal
  }

  // ── Files ─────────────────────────────────────────────────────────────
  try {
    const [fileCount, fileBytes] = await Promise.all([
      db.countFileRecords(),
      db.sumFileRecordBytes(),
    ]);
    families.push(
      {
        name: 'console_files_total',
        help: 'Total number of file records stored.',
        type: 'gauge',
        samples: [{ value: fileCount }],
      },
      {
        name: 'console_files_bytes_total',
        help: 'Total bytes of files stored.',
        type: 'gauge',
        samples: [{ value: fileBytes }],
      },
    );
  } catch {
    // non-fatal
  }

  // ── Agent Tracing ─────────────────────────────────────────────────────
  try {
    const [sessionsResult, distinctAgents] = await Promise.all([
      db.listAgentTracingSessions(),
      db.countAgentTracingDistinctAgents(),
    ]);
    const sessions = sessionsResult.sessions;
    const byStatus: Record<string, number> = {};
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    for (const s of sessions) {
      const status = s.status ?? 'unknown';
      byStatus[status] = (byStatus[status] ?? 0) + 1;
      totalInputTokens += s.totalInputTokens ?? 0;
      totalOutputTokens += s.totalOutputTokens ?? 0;
    }
    families.push(
      {
        name: 'console_tracing_sessions_total',
        help: 'Total number of agent tracing sessions per status.',
        type: 'gauge',
        samples: Object.entries(byStatus).map(([status, count]) => ({
          labels: { status },
          value: count,
        })),
      },
      {
        name: 'console_tracing_agents_total',
        help: 'Total number of distinct traced agents.',
        type: 'gauge',
        samples: [{ value: distinctAgents }],
      },
      {
        name: 'console_tracing_input_tokens_total',
        help: 'Total input tokens across all traced sessions.',
        type: 'counter',
        samples: [{ value: totalInputTokens }],
      },
      {
        name: 'console_tracing_output_tokens_total',
        help: 'Total output tokens across all traced sessions.',
        type: 'counter',
        samples: [{ value: totalOutputTokens }],
      },
    );
  } catch {
    // non-fatal
  }

  // ── Guardrails ────────────────────────────────────────────────────────
  try {
    const guardrails = await db.listGuardrails();
    const byEnabledType: Record<string, number> = {};
    for (const g of guardrails) {
      const k = `${g.type}__${g.enabled ? 'true' : 'false'}`;
      byEnabledType[k] = (byEnabledType[k] ?? 0) + 1;
    }
    families.push({
      name: 'console_guardrails_total',
      help: 'Total number of guardrails per type and enabled state.',
      type: 'gauge',
      samples: Object.entries(byEnabledType).map(([k, count]) => {
        const [type, enabled] = k.split('__');
        return { labels: { type, enabled }, value: count };
      }),
    });

    // Per-guardrail evaluation stats (last 30 days)
    const from = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const evalTotalSamples: MetricSample[] = [];
    const evalPassedSamples: MetricSample[] = [];
    const evalFailedSamples: MetricSample[] = [];

    for (const g of guardrails) {
      try {
        const agg = await db.aggregateGuardrailEvaluations(String(g._id), { from });
        evalTotalSamples.push({ labels: { guardrail: g.key }, value: agg.totalEvaluations });
        evalPassedSamples.push({ labels: { guardrail: g.key }, value: agg.passedCount });
        evalFailedSamples.push({ labels: { guardrail: g.key }, value: agg.failedCount });
      } catch {
        // skip
      }
    }

    if (evalTotalSamples.length > 0) {
      families.push(
        {
          name: 'console_guardrail_evaluations_total',
          help: 'Total guardrail evaluations in the last 30 days per guardrail.',
          type: 'counter',
          samples: evalTotalSamples,
        },
        {
          name: 'console_guardrail_evaluations_passed_total',
          help: 'Guardrail evaluations that passed in the last 30 days per guardrail.',
          type: 'counter',
          samples: evalPassedSamples,
        },
        {
          name: 'console_guardrail_evaluations_failed_total',
          help: 'Guardrail evaluations that failed in the last 30 days per guardrail.',
          type: 'counter',
          samples: evalFailedSamples,
        },
      );
    }
  } catch {
    // non-fatal
  }

  // ── Inference Servers ─────────────────────────────────────────────────
  try {
    const servers = await db.listInferenceServers(tenantId);
    const byStatus: Record<string, number> = {};
    for (const s of servers) {
      byStatus[s.status] = (byStatus[s.status] ?? 0) + 1;
    }
    families.push({
      name: 'console_inference_servers_total',
      help: 'Total number of inference servers per status.',
      type: 'gauge',
      samples: Object.entries(byStatus).map(([status, count]) => ({
        labels: { status },
        value: count,
      })),
    });

    // Latest metrics per server
    const gpuSamples: MetricSample[] = [];
    const cpuSamples: MetricSample[] = [];
    const runningReqSamples: MetricSample[] = [];
    const waitingReqSamples: MetricSample[] = [];
    const promptThroughputSamples: MetricSample[] = [];
    const genThroughputSamples: MetricSample[] = [];

    for (const server of servers) {
      try {
        const metrics = await db.listInferenceServerMetrics(server.key, { limit: 1 });
        if (metrics.length === 0) continue;
        const m = metrics[0];
        const lbl = { server: server.key };
        if (m.gpuCacheUsagePercent !== undefined) {
          gpuSamples.push({ labels: lbl, value: m.gpuCacheUsagePercent / 100 });
        }
        if (m.cpuCacheUsagePercent !== undefined) {
          cpuSamples.push({ labels: lbl, value: m.cpuCacheUsagePercent / 100 });
        }
        if (m.numRequestsRunning !== undefined) {
          runningReqSamples.push({ labels: lbl, value: m.numRequestsRunning });
        }
        if (m.numRequestsWaiting !== undefined) {
          waitingReqSamples.push({ labels: lbl, value: m.numRequestsWaiting });
        }
        if (m.promptTokensThroughput !== undefined) {
          promptThroughputSamples.push({ labels: lbl, value: m.promptTokensThroughput });
        }
        if (m.generationTokensThroughput !== undefined) {
          genThroughputSamples.push({ labels: lbl, value: m.generationTokensThroughput });
        }
      } catch {
        // skip server
      }
    }

    if (gpuSamples.length > 0) {
      families.push({
        name: 'console_inference_server_gpu_cache_usage_ratio',
        help: 'GPU KV-cache usage ratio (0–1) per inference server (latest poll).',
        type: 'gauge',
        samples: gpuSamples,
      });
    }
    if (cpuSamples.length > 0) {
      families.push({
        name: 'console_inference_server_cpu_cache_usage_ratio',
        help: 'CPU KV-cache usage ratio (0–1) per inference server (latest poll).',
        type: 'gauge',
        samples: cpuSamples,
      });
    }
    if (runningReqSamples.length > 0) {
      families.push({
        name: 'console_inference_server_running_requests',
        help: 'Number of requests currently running per inference server (latest poll).',
        type: 'gauge',
        samples: runningReqSamples,
      });
    }
    if (waitingReqSamples.length > 0) {
      families.push({
        name: 'console_inference_server_waiting_requests',
        help: 'Number of requests currently waiting per inference server (latest poll).',
        type: 'gauge',
        samples: waitingReqSamples,
      });
    }
    if (promptThroughputSamples.length > 0) {
      families.push({
        name: 'console_inference_server_prompt_tokens_throughput',
        help: 'Prompt token throughput (tokens/s) per inference server (latest poll).',
        type: 'gauge',
        samples: promptThroughputSamples,
      });
    }
    if (genThroughputSamples.length > 0) {
      families.push({
        name: 'console_inference_server_generation_tokens_throughput',
        help: 'Generation token throughput (tokens/s) per inference server (latest poll).',
        type: 'gauge',
        samples: genThroughputSamples,
      });
    }
  } catch {
    // non-fatal
  }

  // ── RAG Modules ───────────────────────────────────────────────────────
  try {
    const ragModules = await db.listRagModules();
    const byStatus: Record<string, number> = {};
    for (const m of ragModules) {
      byStatus[m.status] = (byStatus[m.status] ?? 0) + 1;
    }
    families.push({
      name: 'console_rag_modules_total',
      help: 'Total number of RAG modules per status.',
      type: 'gauge',
      samples: Object.entries(byStatus).map(([status, count]) => ({
        labels: { status },
        value: count,
      })),
    });

    // Per-module document counts and chunk counts
    const docSamples: MetricSample[] = [];
    const chunkSamples: MetricSample[] = [];
    for (const mod of ragModules) {
      try {
        const docCount = await db.countRagDocuments(mod.key);
        docSamples.push({ labels: { rag_module: mod.key }, value: docCount });
        if (mod.totalChunks !== undefined) {
          chunkSamples.push({ labels: { rag_module: mod.key }, value: mod.totalChunks });
        }
      } catch {
        // skip
      }
    }
    if (docSamples.length > 0) {
      families.push({
        name: 'console_rag_documents_total',
        help: 'Total number of documents per RAG module.',
        type: 'gauge',
        samples: docSamples,
      });
    }
    if (chunkSamples.length > 0) {
      families.push({
        name: 'console_rag_chunks_total',
        help: 'Total number of indexed chunks per RAG module.',
        type: 'gauge',
        samples: chunkSamples,
      });
    }
  } catch {
    // non-fatal
  }

  // ── Memory Stores ─────────────────────────────────────────────────────
  try {
    const stores = await db.listMemoryStores();
    const byStatus: Record<string, number> = {};
    let totalItems = 0;
    for (const s of stores) {
      byStatus[s.status] = (byStatus[s.status] ?? 0) + 1;
    }
    families.push({
      name: 'console_memory_stores_total',
      help: 'Total number of memory stores per status.',
      type: 'gauge',
      samples: Object.entries(byStatus).map(([status, count]) => ({
        labels: { status },
        value: count,
      })),
    });

    const itemSamples: MetricSample[] = [];
    for (const store of stores) {
      try {
        const count = await db.countMemoryItems(store.key);
        totalItems += count;
        itemSamples.push({ labels: { memory_store: store.key }, value: count });
      } catch {
        // skip
      }
    }
    if (itemSamples.length > 0) {
      families.push({
        name: 'console_memory_items_total',
        help: 'Total number of memory items per store.',
        type: 'gauge',
        samples: itemSamples,
      });
    }
    families.push({
      name: 'console_memory_items_all_total',
      help: 'Total number of memory items across all stores.',
      type: 'gauge',
      samples: [{ value: totalItems }],
    });
  } catch {
    // non-fatal
  }

  // ── Alerts ────────────────────────────────────────────────────────────
  try {
    const [alertRules, activeAlerts] = await Promise.all([
      db.listAlertRules(tenantId),
      db.countActiveAlerts(tenantId),
    ]);
    const byEnabled: Record<string, number> = {};
    for (const r of alertRules) {
      const k = r.enabled ? 'true' : 'false';
      byEnabled[k] = (byEnabled[k] ?? 0) + 1;
    }
    families.push(
      {
        name: 'console_alert_rules_total',
        help: 'Total number of alert rules per enabled state.',
        type: 'gauge',
        samples: Object.entries(byEnabled).map(([enabled, count]) => ({
          labels: { enabled },
          value: count,
        })),
      },
      {
        name: 'console_active_alerts_total',
        help: 'Total number of currently active (fired, unresolved) alert events.',
        type: 'gauge',
        samples: [{ value: activeAlerts }],
      },
    );
  } catch {
    // non-fatal
  }

  // ── Prompts ───────────────────────────────────────────────────────────
  try {
    const prompts = await db.listPrompts();
    families.push({
      name: 'console_prompts_total',
      help: 'Total number of prompt templates.',
      type: 'gauge',
      samples: [{ value: prompts.length }],
    });
  } catch {
    // non-fatal
  }

  return renderFamilies(families);
}
