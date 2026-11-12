/**
 * EU AI Act compliance report builder.
 *
 * Assembles the scattered red-team evidence (completed runs + their attempts +
 * the campaign's declared risk classification) into a single regulator-facing
 * document modelled on the GPAI Code-of-Practice Safety & Security Model Report.
 *
 * Design choices that matter for it being *evidence*:
 *  - Reads only persisted, HITL-review-honouring outcomes — it never re-judges.
 *  - Evidence sampling is DETERMINISTIC (even-spaced over a stable ordering), so
 *    re-running the report over the same data yields the same samples. That is
 *    stronger for audit than `Math.random`, while still discharging the CoP's
 *    "randomly selected samples of inputs and outputs" expectation.
 */

import { getDatabase } from '@/lib/database';
import { restrictedKnowledgeTagsOf } from '@/lib/services/rag/access/exposure';
import type { IRedTeamAttemptResult, IRedTeamRun } from '@/lib/database';
import { EU_RISK_CATEGORIES, mapOwaspToEu, type EuRiskCategory } from '../euTaxonomy';
import { effectiveOutcome, isFailedAttempt } from '../aggregate';
import {
  OWASP_LLM_CATEGORIES,
  OWASP_LLM_VERSION,
  normalizeOwaspCategory,
  owaspCategoryLabel,
} from '../owasp';
import { completedInBucket, inconclusiveReasonsOf, loadRunAttempts, normalizeRunLimit, RUN_LIST_PAGE_SIZE } from '../service';
import type {
  CampaignComplianceMeta,
  ComplianceEvidenceSample,
  ComplianceEuCategoryPosture,
  ComplianceFinding,
  ComplianceInconclusiveRun,
  EuComplianceReport,
} from './types';

const OWASP_LIST_NAME = 'OWASP Top 10 for LLM Applications';

/** Evidence samples surfaced per EU risk family (CoP asks for ~5). */
const SAMPLES_PER_CATEGORY = 5;
/** Pages of `limit` runs read past draft scans at most, so a project of mostly drafts cannot turn one report into a full scan. */
const MAX_RUN_PAGES = 10;

/** Pick up to `n` items evenly spaced across a list (stable, reproducible). */
function pickEvenly<T>(items: T[], n: number): T[] {
  if (items.length <= n) return [...items];
  const step = items.length / n;
  const out: T[] = [];
  for (let i = 0; i < n; i += 1) out.push(items[Math.floor(i * step)]);
  return out;
}

function runIdOf(run: IRedTeamRun): string {
  return typeof run._id === 'string' ? run._id : String(run._id ?? '');
}

function toSample(run: IRedTeamRun, a: IRedTeamAttemptResult): ComplianceEvidenceSample {
  const lastTurn = a.transcript[a.transcript.length - 1];
  return {
    runId: runIdOf(run),
    campaignKey: run.campaignKey,
    probeKey: a.probeKey,
    attemptId: a.attemptId,
    ...(a.attemptKey ? { attemptKey: a.attemptKey } : {}),
    owaspCategory: normalizeOwaspCategory(a.category),
    outcome: effectiveOutcome(a),
    input: lastTurn?.user ?? a.transcript[0]?.user ?? '',
    output: lastTurn?.assistant ?? '',
    ...(run.agentRevision?.version !== undefined ? { agentVersion: run.agentRevision.version } : {}),
  };
}

/** Merge per-campaign compliance metadata: first defined value wins per field. */
function mergeCompliance(metas: CampaignComplianceMeta[]): CampaignComplianceMeta {
  const out: CampaignComplianceMeta = {};
  for (const m of metas) {
    out.riskTier ??= m.riskTier;
    out.intendedPurpose ??= m.intendedPurpose;
    out.systemCardUrl ??= m.systemCardUrl;
    out.deployer ??= m.deployer;
    out.provider ??= m.provider;
    out.notes ??= m.notes;
  }
  return out;
}

export interface BuildReportOptions {
  projectId?: string;
  /** Cap on completed runs pulled into the report (newest first). Default 100. */
  limit?: number;
}

/**
 * Build the EU AI Act compliance report for a project's red-team evidence.
 * Returns an empty-but-valid report (with a disclaimer) when no completed scans
 * exist, so the caller can always render something honest.
 */
export async function buildComplianceReport(
  tenantDbName: string,
  generatedAt: Date,
  options: BuildReportOptions = {},
): Promise<EuComplianceReport> {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);
  // A scan of an unpublished draft shows how a candidate holds up, not how the
  // system in service does, so it is not evidence about the latter. Drafts are
  // skipped while reading, so they do not use up the report's `limit`.
  const limit = normalizeRunLimit(options.limit);
  const runs: IRedTeamRun[] = [];
  let draftRunsExcluded = 0;
  let skip = 0;
  for (let page = 0; page < MAX_RUN_PAGES && runs.length < limit; page += 1) {
    const chunk = Math.min(limit - runs.length, RUN_LIST_PAGE_SIZE);
    const batch = await db.listRedTeamRuns({
      projectId: options.projectId,
      status: 'completed',
      limit: chunk,
      skip,
      omitAttempts: true,
    });
    skip += batch.length;
    for (const run of batch) {
      if (runs.length >= limit) break;
      if (run.agentRevision?.requested === 'draft') draftRunsExcluded += 1;
      else runs.push(run);
    }
    if (batch.length < chunk) break;
  }

  const disclaimers: string[] = [
    'Automated adversarial-testing evidence only; it does not by itself constitute a conformity assessment.',
    'Coverage is limited to the probes selected in the referenced campaigns; absence of a finding is not proof of safety.',
    'LLM-judge verdicts are probabilistic; human-in-the-loop reviews, where present, override machine verdicts.',
  ];

  if (draftRunsExcluded > 0) {
    disclaimers.push(
      `${draftRunsExcluded} scan${draftRunsExcluded === 1 ? '' : 's'} of an unpublished agent draft ${draftRunsExcluded === 1 ? 'was' : 'were'} excluded: a draft is not the system in service.`,
    );
  }

  // ── Which scans are the posture ────────────────────────────────────
  // Per campaign, the latest completed scan whose rates can be trusted is its current posture; older
  // completed scans of it are history (counts only), and a scan whose rates cannot be trusted (it lost
  // its judge, or the target kept failing) is never posture, only listed with its reasons. `runs` is
  // newest first.
  const posture: IRedTeamRun[] = [];
  const history = new Map<string, { campaignKey: string; runs: number; attempts: number; vulnerable: number }>();
  const inconclusiveRuns: ComplianceInconclusiveRun[] = [];
  const currentOf = new Set<string>();
  for (const run of runs) {
    const agg = run.aggregate;
    if (!agg) continue;
    const reasons = inconclusiveReasonsOf(agg);
    if (reasons.length > 0) {
      inconclusiveRuns.push({
        runId: runIdOf(run),
        campaignKey: run.campaignKey,
        ...(run.finishedAt ? { finishedAt: new Date(run.finishedAt).toISOString() } : {}),
        reasons,
      });
      continue;
    }
    const scope = `${run.projectId ?? ''}\u0000${run.campaignKey}`;
    if (!currentOf.has(scope)) {
      currentOf.add(scope);
      posture.push(run);
      continue;
    }
    const entry = history.get(scope) ?? { campaignKey: run.campaignKey, runs: 0, attempts: 0, vulnerable: 0 };
    entry.runs += 1;
    entry.attempts += agg.total;
    entry.vulnerable += agg.vulnerable;
    history.set(scope, entry);
  }
  if (inconclusiveRuns.length > 0) {
    disclaimers.push(
      `${inconclusiveRuns.length} completed scan${inconclusiveRuns.length === 1 ? ' was' : 's were'} left out of the posture because ${inconclusiveRuns.length === 1 ? 'its' : 'their'} results could not be trusted (see inconclusiveRuns).`,
    );
  }

  // ── System header: gather campaign metadata + targets ──────────────
  const campaignKeys = [...new Set(posture.map((r) => r.campaignKey))];
  const complianceMetas: CampaignComplianceMeta[] = [];
  const targets = new Set<string>();
  for (const key of campaignKeys) {
    const campaign = await db.findRedTeamCampaignByKey(key, options.projectId);
    if (!campaign) continue;
    const target = campaign.agentKey || campaign.modelKey;
    if (target) targets.add(target);
    const meta = (campaign.metadata?.compliance ?? undefined) as CampaignComplianceMeta | undefined;
    if (meta) complianceMetas.push(meta);
  }
  for (const r of posture) if (r.targetRef) targets.add(r.targetRef);

  // ── Posture + per-OWASP rollup from persisted aggregates ───────────
  const bySeverity: Record<string, number> = { low: 0, medium: 0, high: 0, critical: 0 };
  const owaspMap = new Map<string, { category: string; total: number; completed: number; vulnerable: number; needsReview: number }>();
  let totalAttempts = 0;
  let completed = 0;
  let vulnerable = 0;
  let needsReview = 0;
  for (const run of posture) {
    const agg = run.aggregate!;
    totalAttempts += agg.total;
    completed += agg.completed;
    vulnerable += agg.vulnerable;
    needsReview += agg.needsReview;
    for (const sev of Object.keys(bySeverity)) bySeverity[sev] += agg.bySeverity?.[sev] ?? 0;
    for (const [cat, bucket] of Object.entries(agg.byCategory ?? {})) {
      const key = normalizeOwaspCategory(cat);
      const e = owaspMap.get(key) ?? { category: key, total: 0, completed: 0, vulnerable: 0, needsReview: 0 };
      e.total += bucket.total;
      e.completed += completedInBucket(bucket);
      e.vulnerable += bucket.vulnerable;
      e.needsReview += bucket.needsReview;
      owaspMap.set(key, e);
    }
  }
  // A category none of whose attempts completed has no rate to show; it is a coverage gap below.
  const byOwaspCategory = [...owaspMap.values()]
    .filter((c) => c.completed > 0)
    .map(({ completed: done, ...c }) => ({
      ...c,
      label: owaspCategoryLabel(c.category),
      resilience: (done - c.vulnerable) / done,
    }))
    .sort((a, b) => a.resilience - b.resilience || b.vulnerable - a.vulnerable);

  // ── Gather candidate evidence samples grouped by EU family ─────────
  const samplesByEu = new Map<EuRiskCategory, ComplianceEvidenceSample[]>();
  const findingsMap = new Map<string, ComplianceFinding>();
  for (const run of posture) {
    // A list read leaves embedded attempts out, so a run from before attempt rows is read whole.
    const whole = run.attemptStore === 'collection' ? run : ((await db.findRedTeamRunById(runIdOf(run))) ?? run);
    for (const a of await loadRunAttempts(db, whole)) {
      // An attempt the target never answered says nothing about the system.
      if (isFailedAttempt(a)) continue;
      // Over-refusal attempts measure unhelpfulness on harmless prompts; they are neither evidence nor findings.
      if (a.polarity === 'over-refusal') continue;
      // An exported document: an attempt that handed on passages of knowledge base documents not open to everyone
      // never becomes evidence text (its finding is still counted below).
      const sample = restrictedKnowledgeTagsOf(a.kbRestricted).length > 0 ? undefined : toSample(run, a);
      const category = normalizeOwaspCategory(a.category);
      const euCats = mapOwaspToEu(category);
      for (const eu of sample ? euCats : []) {
        const arr = samplesByEu.get(eu) ?? [];
        arr.push(sample!);
        samplesByEu.set(eu, arr);
      }
      if (effectiveOutcome(a) === 'vulnerable') {
        const fk = `${a.probeKey}`;
        const existing = findingsMap.get(fk);
        if (existing) {
          existing.count += 1;
          existing.example ??= sample;
        } else {
          findingsMap.set(fk, {
            owaspCategory: category,
            euCategories: euCats,
            probeKey: a.probeKey,
            severity: a.severity,
            count: 1,
            example: sample,
          });
        }
      }
    }
  }

  // ── EU-category posture (fold OWASP rollup + attach evidence) ───────
  const euAgg = new Map<EuRiskCategory, { total: number; completed: number; vulnerable: number; needsReview: number }>();
  for (const c of owaspMap.values()) {
    if (c.completed === 0) continue;
    for (const eu of mapOwaspToEu(c.category)) {
      const e = euAgg.get(eu) ?? { total: 0, completed: 0, vulnerable: 0, needsReview: 0 };
      e.total += c.total;
      e.completed += c.completed;
      e.vulnerable += c.vulnerable;
      e.needsReview += c.needsReview;
      euAgg.set(eu, e);
    }
  }
  const byEuCategory: ComplianceEuCategoryPosture[] = [...euAgg.entries()]
    .map(([eu, e]) => {
      const meta = EU_RISK_CATEGORIES[eu];
      const candidates = samplesByEu.get(eu) ?? [];
      // Prefer surfacing vulnerable evidence first, then fill with safe samples.
      const vuln = candidates.filter((s) => s.outcome === 'vulnerable');
      const rest = candidates.filter((s) => s.outcome !== 'vulnerable');
      const evidence = [
        ...pickEvenly(vuln, SAMPLES_PER_CATEGORY),
        ...pickEvenly(rest, Math.max(0, SAMPLES_PER_CATEGORY - Math.min(vuln.length, SAMPLES_PER_CATEGORY))),
      ].slice(0, SAMPLES_PER_CATEGORY);
      return {
        category: eu,
        label: meta.label,
        description: meta.description,
        total: e.total,
        vulnerable: e.vulnerable,
        needsReview: e.needsReview,
        // Over the attempts the target answered: a category's failed attempts say nothing about the system.
        resilience: e.completed > 0 ? (e.completed - e.vulnerable) / e.completed : 1,
        articleRefs: meta.articleRefs,
        evidence,
      };
    })
    .sort((a, b) => a.resilience - b.resilience || b.vulnerable - a.vulnerable);

  // ── Coverage gaps: every category of the list the posture never exercised ─
  const exercised = new Set([...owaspMap.values()].filter((c) => c.completed > 0).map((c) => c.category));
  const coverageGaps = OWASP_LLM_CATEGORIES
    .filter((cat) => !exercised.has(cat))
    .map((cat) => ({
      owaspCategory: cat,
      label: owaspCategoryLabel(cat),
      reason: 'No scan of the current posture exercised this category.',
    }));
  if (posture.length === 0) {
    disclaimers.unshift('No completed red-team scans were found for this scope; this report has no evidentiary content yet.');
  }

  const findings = [...findingsMap.values()].sort((a, b) => {
    const order = { critical: 0, high: 1, medium: 2, low: 3 } as const;
    return order[a.severity] - order[b.severity] || b.count - a.count;
  });

  // Scan window from the posture scans' timestamps.
  const times = posture.map((r) => r.finishedAt).filter((d): d is Date => !!d).map((d) => new Date(d).getTime());
  const scanWindow = times.length
    ? { from: new Date(Math.min(...times)).toISOString(), to: new Date(Math.max(...times)).toISOString() }
    : undefined;

  const historyRows = [...history.values()];

  return {
    generatedAt: generatedAt.toISOString(),
    scope: { projectId: options.projectId, runsConsidered: posture.length, scanWindow },
    owaspReference: {
      name: OWASP_LIST_NAME,
      version: OWASP_LLM_VERSION,
      label: `${OWASP_LIST_NAME} (${OWASP_LLM_VERSION})`,
    },
    system: { ...mergeCompliance(complianceMetas), campaigns: campaignKeys, targets: [...targets].filter(Boolean) },
    posture: {
      totalAttempts,
      completed,
      vulnerable,
      needsReview,
      attackSuccessRate: completed > 0 ? vulnerable / completed : null,
      resilienceScore: completed > 0 ? 1 - vulnerable / completed : null,
      bySeverity,
    },
    byOwaspCategory,
    byEuCategory,
    findings,
    coverageGaps,
    history: { runs: historyRows.reduce((n, h) => n + h.runs, 0), byCampaign: historyRows },
    inconclusiveRuns,
    regulatoryBasis: [
      { source: 'AI Act Art. 55', note: 'Adversarial testing / model evaluation of systemic risk (GPAI).' },
      { source: 'AI Act Art. 15', note: 'Accuracy, robustness and cybersecurity of high-risk systems.' },
      { source: 'GPAI Code of Practice — Safety & Security', note: 'Model evaluations and Model Report structure.' },
    ],
    disclaimers,
  };
}
