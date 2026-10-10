/**
 * Markdown rendering of the report (and the short summary printed to the
 * terminal). Pure: a report goes in, text comes out.
 */

import type { AccessChange } from './access';
import type { PrincipalChange, ServiceChange } from './accumulate';
import { CAUSE_EXPLANATIONS, CAUSE_TITLES, CHANGE_CAUSES, type Cause } from './model';
import { integrityProblem, type PreflightReport, type TenantReport } from './report';
import { METRICS_EXPORT } from './surfaces';

const num = (n: number): string => n.toLocaleString('en-US');
const esc = (text: string): string => text.replace(/\|/g, '\\|');
const plural = (n: number, one: string, many: string): string => `${num(n)} ${n === 1 ? one : many}`;

const ACCESS_TITLES: Record<AccessChange, string> = {
  same: 'unchanged',
  'gains-project-access': 'gain access to a project (it used to answer "No project assigned")',
  'loses-project-access': 'lose access to a project',
  'different-active-project': 'land in a different project',
  'different-result': 'get a different answer',
};

function listProjects(projects: readonly string[]): string {
  return projects.length <= 4 ? projects.join(', ') : `${projects.slice(0, 4).join(', ')} and ${projects.length - 4} more`;
}

function changeLine(c: ServiceChange): string {
  const arrow = c.direction === 'tighten' ? 'loses' : 'gains';
  return `${c.service}: ${c.before} -> ${c.after} (${arrow}) in ${listProjects(c.projects)}`;
}

function tenantHeadline(t: TenantReport): string {
  const parts = [
    `${num(t.principals.users)} people`,
    `${num(t.principals.tokens)} tokens`,
    `${num(t.contexts)} project contexts`,
    `${num(t.decisions)} decisions`,
  ];
  return `${parts.join(', ')}; ${num(t.differs)} differ (tighten ${num(t.tighten)}, loosen ${num(t.loosen)})`;
}

export function renderSummary(report: PreflightReport): string {
  const t = report.totals;
  const lines: string[] = [];
  lines.push(`Workspaces ${t.tenants}; people ${num(t.users)}; API tokens ${num(t.tokens)}; project contexts ${num(t.contexts)}; decisions compared ${num(t.decisions)}`);
  lines.push(`Unchanged ${num(t.same + t.masked)}; changed ${num(t.differs)} (tighten ${num(t.tighten)}, loosen ${num(t.loosen)})`);
  lines.push(`People whose access changes ${num(t.principalsChanged.users)}; API tokens ${num(t.principalsChanged.tokens)}`);
  for (const cause of CHANGE_CAUSES) {
    const v = t.byCause[cause];
    if (v) lines.push(`  - ${CAUSE_TITLES[cause]}: ${num(v.principals)} principals, ${num(v.decisions)} decisions (tighten ${num(v.tighten)}, loosen ${num(v.loosen)})`);
  }
  const lost = t.newlyGated.filter((s) => s.principals > 0);
  if (lost.length > 0) lines.push(`Newly gated surfaces people lose: ${lost.map((s) => `${s.title} (${num(s.principals)})`).join('; ')}`);
  const gains = t.projectAccess['gains-project-access'] ?? 0;
  const moved = t.projectAccess['different-active-project'] ?? 0;
  if (gains + moved > 0) lines.push(`Project access: ${num(gains)} scenarios gain access through a group, ${num(moved)} land in a different project`);
  if (t.deferred.entries > 0) lines.push(`Deferred: ${num(t.deferred.principals)} principals carry a "No access" that is ignored until its row is saved again (${num(t.deferred.entries)} entries)`);
  if (t.scopedTokens > 0) lines.push(`${num(t.scopedTokens)} tokens carry a service scope and are refused on the tenant-wide metrics export`);
  lines.push(
    integrityProblem(t.integrity)
      ? `INTEGRITY PROBLEM: engine failures ${t.integrity.engineFailures}, independent-check mismatches ${t.integrity.oracleMismatches}, parity ${t.integrity.parityMismatches}, unexplained ${t.integrity.unexplained}. Do not rely on this report.`
      : 'Integrity: the engine agrees with the rules it is checked against on every decision.',
  );
  return lines.join('\n');
}

function renderCauseSection(t: TenantReport, cause: Cause, maxListed: number): string[] {
  const summary = t.byCause[cause];
  if (!summary) return [];
  const lines: string[] = [];
  lines.push(`#### ${CAUSE_TITLES[cause]}`);
  lines.push('');
  lines.push(CAUSE_EXPLANATIONS[cause]);
  lines.push('');
  lines.push(`${plural(summary.principals, 'principal', 'principals')}, ${plural(summary.decisions, 'decision', 'decisions')} (tighten ${num(summary.tighten)}, loosen ${num(summary.loosen)}), ${plural(summary.principalServicePairs, 'distinct person x service pair', 'distinct person x service pairs')}. Services: ${summary.services.join(', ') || '-'}.`);
  const affected: Array<{ p: PrincipalChange; changes: ServiceChange[] }> = [];
  for (const p of t.principalChanges) {
    const changes = p.changes.filter((c) => c.cause === cause);
    if (changes.length > 0) affected.push({ p, changes });
  }
  if (affected.length === 0) {
    // An integrity finding is a count of decisions, not a change to list.
    if (cause === 'parity-mismatch' || cause === 'unexplained') return lines;
    lines.push('');
    lines.push('(per-person lists are not part of this report; run without --summary-only)');
    return lines;
  }
  lines.push('');
  for (const { p, changes } of affected.slice(0, maxListed)) {
    lines.push(`- **${p.principal}** (${p.kind === 'token' ? `token of ${p.owner ?? '?'}, ` : ''}role ${p.role || '-'})`);
    for (const c of changes.slice(0, 12)) lines.push(`  - ${changeLine(c)}`);
    if (changes.length > 12) lines.push(`  - ... ${changes.length - 12} more`);
  }
  if (affected.length > maxListed) lines.push(`- ... ${affected.length - maxListed} more (the JSON file lists all)`);
  return lines;
}

function renderTenant(t: TenantReport, maxListed: number): string[] {
  const lines: string[] = [];
  lines.push(`## Workspace ${t.slug}`);
  lines.push('');
  lines.push(tenantHeadline(t));
  lines.push('');
  lines.push(`Activation instant for project permissions: ${t.activation.since} (${t.activation.origin === 'stored' ? 'already recorded in this workspace' : t.activation.origin === 'option' ? 'from --since' : 'the time of this run'}).`);
  if (t.customPolicies.inForce > 0 || t.customPolicies.skipped > 0) {
    lines.push(`Custom policies in this copy: ${t.customPolicies.inForce} statements in force${t.customPolicies.skipped > 0 ? `, ${t.customPolicies.skipped} could not be loaded` : ''}. Differences may include their effect; IP and time conditions are not evaluated here.`);
  }
  if (t.principals.truncated) {
    lines.push(`Only part of the directory was evaluated (--max-principals): ${num(t.principals.users)} of ${num(t.principals.totalUsers)} people and ${num(t.principals.tokens)} of ${num(t.principals.totalTokens)} tokens.`);
  }
  if (t.principals.skipped.length > 0) {
    lines.push('');
    lines.push(`Not compared because authentication refuses them before any permission is asked (${t.principals.skipped.length}):`);
    for (const s of t.principals.skipped.slice(0, 20)) lines.push(`- ${s.label}: ${s.reason}`);
    if (t.principals.skipped.length > 20) lines.push(`- ... ${t.principals.skipped.length - 20} more`);
  }
  lines.push('');

  const causes = Object.keys(t.byCause) as Cause[];
  const shown = CHANGE_CAUSES.filter((c) => t.byCause[c]);
  const integrity = causes.filter((c) => c === 'parity-mismatch' || c === 'unexplained');
  if (shown.length === 0 && integrity.length === 0) {
    lines.push('No person or token gets a different answer from the workspace rules of the previous release.');
    lines.push('');
  } else {
    lines.push('### What changes on the first request');
    lines.push('');
    lines.push('| Cause | Principals | Decisions | Tighten | Loosen | Services |');
    lines.push('|---|---:|---:|---:|---:|---|');
    for (const cause of [...shown, ...integrity]) {
      const v = t.byCause[cause];
      if (v) lines.push(`| ${esc(CAUSE_TITLES[cause])} | ${num(v.principals)} | ${num(v.decisions)} | ${num(v.tighten)} | ${num(v.loosen)} | ${esc(v.services.slice(0, 8).join(', '))}${v.services.length > 8 ? ', ...' : ''} |`);
    }
    lines.push('');
    for (const cause of [...shown, ...integrity]) {
      lines.push(...renderCauseSection(t, cause, maxListed));
      lines.push('');
    }

    const projects = Object.entries(t.byProject);
    if (projects.length > 0) {
      lines.push('### By project');
      lines.push('');
      lines.push('| Project | People and tokens | Services | Tighten | Loosen |');
      lines.push('|---|---:|---:|---:|---:|');
      for (const [name, v] of projects.slice(0, 50)) lines.push(`| ${esc(name)} | ${num(v.principals)} | ${num(v.services)} | ${num(v.tighten)} | ${num(v.loosen)} |`);
      lines.push('');
    }
    const services = Object.entries(t.byService);
    if (services.length > 0) {
      lines.push('### By service');
      lines.push('');
      lines.push('| Service | People and tokens | Projects | Tighten | Loosen |');
      lines.push('|---|---:|---:|---:|---:|');
      const byImpact = [...services].sort((a, b) => b[1].principals - a[1].principals || a[0].localeCompare(b[0]));
      for (const [name, v] of byImpact.slice(0, 25)) lines.push(`| ${name} | ${num(v.principals)} | ${num(v.projects)} | ${num(v.tighten)} | ${num(v.loosen)} |`);
      if (byImpact.length > 25) lines.push(`| ... ${byImpact.length - 25} more services (the JSON file lists all) | | | | |`);
      lines.push('');
    }
  }

  const gated = t.newlyGated.filter((s) => s.count > 0);
  lines.push('### Surfaces that now check a permission');
  lines.push('');
  if (gated.length === 0) {
    lines.push('Everyone who could use them keeps them.');
    lines.push('');
  } else {
    for (const s of gated) {
      lines.push(`- **${s.title}**${s.edition === 'enterprise' ? ' (Enterprise)' : ''} now needs ${s.level} on \`${s.service}\` (${s.routes.join(', ')}). ${s.count === 1 ? '1 person loses it' : `${num(s.count)} people lose it`}:`);
      for (const p of s.principals.slice(0, Math.min(maxListed, 25))) lines.push(`  - ${p.principal} (role ${p.role || '-'}; ${listProjects(p.projects)})`);
      if (s.count > Math.min(maxListed, 25) && s.principals.length > 0) lines.push(`  - ... ${s.count - Math.min(maxListed, 25)} more`);
    }
    lines.push('');
  }
  if (t.metricsExport.count > 0) {
    lines.push(`- **Tenant-wide metrics export** (\`${METRICS_EXPORT.route}\`) refuses tokens that carry a service scope. ${num(t.metricsExport.count)} tokens in this workspace do; if one of them feeds a scraper, replace it with an unscoped token:`);
    for (const tok of t.metricsExport.tokens.slice(0, 15)) lines.push(`  - ${tok.token} (owner ${tok.owner})`);
    if (t.metricsExport.count > Math.min(15, t.metricsExport.tokens.length) && t.metricsExport.tokens.length > 0) lines.push(`  - ... ${t.metricsExport.count - Math.min(15, t.metricsExport.tokens.length)} more`);
    lines.push('');
  }

  lines.push('### Project access');
  lines.push('');
  const access = t.projectAccess;
  const accessBits = (Object.entries(access.summary) as Array<[AccessChange, number]>).filter(([k]) => k !== 'same');
  lines.push(`${num(access.members)} members who are not owners or admins, ${num(access.scenarios)} scenarios (no project cookie, and a cookie for each project they can open).`);
  if (accessBits.length === 0) {
    lines.push('Nobody opens a different project than before.');
  } else {
    for (const [change, n] of accessBits) lines.push(`- ${plural(n, 'scenario', 'scenarios')}: members ${ACCESS_TITLES[change]}`);
    lines.push('');
    for (const m of access.changes.slice(0, maxListed)) {
      lines.push(`- **${m.user}** (role ${m.role || '-'})`);
      for (const sc of m.scenarios.slice(0, 6)) lines.push(`  - project cookie ${sc.cookie}: ${sc.before} -> ${sc.after}`);
      if (m.scenarios.length > 6) lines.push(`  - ... ${m.scenarios.length - 6} more`);
    }
    if (access.changes.length > maxListed) lines.push(`- ... ${access.changes.length - maxListed} more members (the JSON file lists all)`);
  }
  lines.push('');

  lines.push('### Deferred: a "No access" that is ignored until its row is saved again');
  lines.push('');
  if (t.deferred.list.length === 0) {
    lines.push('No project assignment carries an explicit "No access" that would lower someone\'s level.');
  } else {
    lines.push(
      'An explicit "No access" on a project assignment saved before the activation instant is read as "not set" (older screens showed every unset service as "None"). '
      + 'The row\'s other levels apply. If someone saves the assignment again - even to change the project role - its "No access" entries start to apply and these people lose the services below.',
    );
    lines.push('');
    for (const d of t.deferred.list.slice(0, maxListed)) {
      lines.push(`- **${d.principal}** (${d.kind === 'token' ? `token of ${d.owner ?? '?'}, ` : ''}role ${d.role || '-'})`);
      for (const c of d.changes.slice(0, 12)) lines.push(`  - ${c.service}: ${c.from} -> ${c.to} in ${listProjects(c.projects)}`);
      if (d.changes.length > 12) lines.push(`  - ... ${d.changes.length - 12} more`);
    }
    if (t.deferred.list.length > maxListed) lines.push(`- ... ${t.deferred.list.length - maxListed} more (the JSON file lists all)`);
  }
  lines.push('');

  lines.push('### Census');
  lines.push('');
  lines.push('```json');
  lines.push(JSON.stringify(t.census, null, 2));
  lines.push('```');
  lines.push('');
  return lines;
}

export function renderMarkdown(report: PreflightReport, maxListed: number): string {
  const t = report.totals;
  const lines: string[] = [];
  lines.push('# Access changes when the policy engine takes over');
  lines.push('');
  lines.push(`Generated ${report.generatedAt} from ${report.source.provider} (${report.source.location}).${report.redacted ? ' Names, emails, token labels and project names are hashed.' : ''}`);
  lines.push('');
  lines.push(
    'This report compares, for every person and API token, what the **previous release** allowed - the workspace rules only: role, own and group service permissions, token scope; '
    + 'no project permissions, and no group grants for tokens - with what the **policy engine** decides from its first request. It only reads the copy it was given.',
  );
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  lines.push(`- Workspaces: ${t.tenants}; people: ${num(t.users)}; API tokens: ${num(t.tokens)}; project contexts: ${num(t.contexts)}; decisions compared: ${num(t.decisions)} (${report.services.compared} services; ${report.services.addedWithEngine.join(', ')} are new with the engine and have nothing to compare).`);
  lines.push(`- Unchanged: ${num(t.same + t.masked)}. Changed: ${num(t.differs)} - tighten ${num(t.tighten)}, loosen ${num(t.loosen)}.`);
  lines.push(`- Principals whose access changes: ${num(t.principalsChanged.users)} people, ${num(t.principalsChanged.tokens)} API tokens.`);
  lines.push(
    integrityProblem(t.integrity)
      ? `- **INTEGRITY PROBLEM**: engine failures ${t.integrity.engineFailures}, independent-check mismatches ${t.integrity.oracleMismatches}, parity mismatches ${t.integrity.parityMismatches}, unexplained ${t.integrity.unexplained}. The engine disagrees with the rules it is checked against; do not rely on this report, and tell support.`
      : '- Integrity: the engine agrees with the rules it is checked against on every decision (the independent arithmetic check, and the attribution checks on every differing decision).',
  );
  lines.push('');
  if (Object.keys(t.byCause).length > 0) {
    lines.push('| Cause | Principals | Decisions | Tighten | Loosen |');
    lines.push('|---|---:|---:|---:|---:|');
    for (const cause of CHANGE_CAUSES) {
      const v = t.byCause[cause];
      if (v) lines.push(`| ${esc(CAUSE_TITLES[cause])} | ${num(v.principals)} | ${num(v.decisions)} | ${num(v.tighten)} | ${num(v.loosen)} |`);
    }
    lines.push('');
  }
  const gains = t.projectAccess['gains-project-access'] ?? 0;
  const moved = t.projectAccess['different-active-project'] ?? 0;
  lines.push(`- Project access: ${plural(gains, 'scenario', 'scenarios')} where a member gains a project through a group; ${num(moved)} where the active project differs.`);
  lines.push(`- Deferred "No access" entries (ignored until their row is saved again): ${num(t.deferred.entries)} entries, ${num(t.deferred.principals)} principals.`);
  const lost = t.newlyGated.filter((s) => s.principals > 0);
  lines.push(lost.length === 0
    ? '- Surfaces that now check a permission: nobody loses one.'
    : `- Surfaces that now check a permission: ${lost.map((s) => `${s.title} - ${s.principals === 1 ? '1 person' : `${num(s.principals)} people`}`).join('; ')}.`);
  lines.push('');
  for (const tenant of report.tenants) lines.push(...renderTenant(tenant, maxListed));
  return `${lines.join('\n')}\n`;
}
