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
import type { IRedTeamAttemptResult, IRedTeamRun, RedTeamOutcome } from '@/lib/database';
import { BUILTIN_PROBE_KEYS, PROBE_REGISTRY } from '../probes';
import { EU_RISK_CATEGORIES, mapOwaspToEu, type EuRiskCategory } from '../euTaxonomy';
import type {
  CampaignComplianceMeta,
  ComplianceEvidenceSample,
  ComplianceEuCategoryPosture,
  ComplianceFinding,
  EuComplianceReport,
} from './types';

/** Evidence samples surfaced per EU risk family (CoP asks for ~5). */
const SAMPLES_PER_CATEGORY = 5;

/** Effective outcome honouring any human-in-the-loop override. */
function effectiveOutcome(a: IRedTeamAttemptResult): RedTeamOutcome {
  return a.review?.outcome ?? a.outcome;
}

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
    owaspCategory: a.category,
    outcome: effectiveOutcome(a),
    input: lastTurn?.user ?? a.transcript[0]?.user ?? '',
    output: lastTurn?.assistant ?? '',
  };
}

/** All OWASP categories the built-in catalog can exercise (for gap detection). */
function builtinCategories(): Set<string> {
  const cats = new Set<string>();
  for (const key of BUILTIN_PROBE_KEYS) cats.add(PROBE_REGISTRY[key]().category);
  return cats;
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
  const runs = await db.listRedTeamRuns({
    projectId: options.projectId,
    status: 'completed',
    limit: options.limit ?? 100,
  });

  const disclaimers: string[] = [
    'Automated adversarial-testing evidence only; it does not by itself constitute a conformity assessment.',
    'Coverage is limited to the probes selected in the referenced campaigns; absence of a finding is not proof of safety.',
    'LLM-judge verdicts are probabilistic; human-in-the-loop reviews, where present, override machine verdicts.',
  ];

  // ── System header: gather campaign metadata + targets ──────────────
  const campaignKeys = [...new Set(runs.map((r) => r.campaignKey))];
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
  for (const r of runs) if (r.targetRef) targets.add(r.targetRef);

  // ── Posture + per-OWASP rollup from persisted aggregates ───────────
  const bySeverity: Record<string, number> = { low: 0, medium: 0, high: 0, critical: 0 };
  const owaspMap = new Map<string, { category: string; total: number; vulnerable: number; needsReview: number }>();
  let totalAttempts = 0;
  let completed = 0;
  let vulnerable = 0;
  let needsReview = 0;
  for (const run of runs) {
    const agg = run.aggregate;
    if (!agg) continue;
    totalAttempts += agg.total;
    completed += agg.completed;
    vulnerable += agg.vulnerable;
    needsReview += agg.needsReview;
    for (const sev of Object.keys(bySeverity)) bySeverity[sev] += agg.bySeverity?.[sev] ?? 0;
    for (const [cat, bucket] of Object.entries(agg.byCategory ?? {})) {
      const e = owaspMap.get(cat) ?? { category: cat, total: 0, vulnerable: 0, needsReview: 0 };
      e.total += bucket.total;
      e.vulnerable += bucket.vulnerable;
      e.needsReview += bucket.needsReview;
      owaspMap.set(cat, e);
    }
  }
  const byOwaspCategory = [...owaspMap.values()]
    .map((c) => ({ ...c, resilience: c.total > 0 ? (c.total - c.vulnerable) / c.total : 1 }))
    .sort((a, b) => a.resilience - b.resilience || b.vulnerable - a.vulnerable);

  // ── Gather candidate evidence samples grouped by EU family ─────────
  const samplesByEu = new Map<EuRiskCategory, ComplianceEvidenceSample[]>();
  const findingsMap = new Map<string, ComplianceFinding>();
  for (const run of runs) {
    for (const a of run.attempts) {
      const sample = toSample(run, a);
      const euCats = mapOwaspToEu(a.category);
      for (const eu of euCats) {
        const arr = samplesByEu.get(eu) ?? [];
        arr.push(sample);
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
            owaspCategory: a.category,
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
  const euAgg = new Map<EuRiskCategory, { total: number; vulnerable: number; needsReview: number }>();
  for (const c of byOwaspCategory) {
    for (const eu of mapOwaspToEu(c.category)) {
      const e = euAgg.get(eu) ?? { total: 0, vulnerable: 0, needsReview: 0 };
      e.total += c.total;
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
        resilience: e.total > 0 ? (e.total - e.vulnerable) / e.total : 1,
        articleRefs: meta.articleRefs,
        evidence,
      };
    })
    .sort((a, b) => a.resilience - b.resilience || b.vulnerable - a.vulnerable);

  // ── Coverage gaps: built-in categories never exercised ─────────────
  const exercised = new Set(owaspMap.keys());
  const coverageGaps = [...builtinCategories()]
    .filter((cat) => !exercised.has(cat))
    .map((cat) => ({ owaspCategory: cat, reason: 'No completed scan exercised this category in the report window.' }));
  if (runs.length === 0) {
    disclaimers.unshift('No completed red-team scans were found for this scope; this report has no evidentiary content yet.');
  }

  const findings = [...findingsMap.values()].sort((a, b) => {
    const order = { critical: 0, high: 1, medium: 2, low: 3 } as const;
    return order[a.severity] - order[b.severity] || b.count - a.count;
  });

  // Scan window from run timestamps.
  const times = runs.map((r) => r.finishedAt).filter((d): d is Date => !!d).map((d) => new Date(d).getTime());
  const scanWindow = times.length
    ? { from: new Date(Math.min(...times)).toISOString(), to: new Date(Math.max(...times)).toISOString() }
    : undefined;

  return {
    generatedAt: generatedAt.toISOString(),
    scope: { projectId: options.projectId, runsConsidered: runs.length, scanWindow },
    system: { ...mergeCompliance(complianceMetas), campaigns: campaignKeys, targets: [...targets].filter(Boolean) },
    posture: {
      totalAttempts,
      completed,
      vulnerable,
      needsReview,
      attackSuccessRate: completed > 0 ? vulnerable / completed : 0,
      resilienceScore: completed > 0 ? 1 - vulnerable / completed : 1,
      bySeverity,
    },
    byOwaspCategory,
    byEuCategory,
    findings,
    coverageGaps,
    regulatoryBasis: [
      { source: 'AI Act Art. 55', note: 'Adversarial testing / model evaluation of systemic risk (GPAI).' },
      { source: 'AI Act Art. 15', note: 'Accuracy, robustness and cybersecurity of high-risk systems.' },
      { source: 'GPAI Code of Practice — Safety & Security', note: 'Model evaluations and Model Report structure.' },
    ],
    disclaimers,
  };
}
