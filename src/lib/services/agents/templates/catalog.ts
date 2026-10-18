/**
 * The agent template catalog (v1). One file per template under `items/`; this
 * file lists them in the order the gallery shows them (by category, then by
 * how a person would reach for them).
 *
 * Raise `AGENT_TEMPLATE_CATALOG_VERSION` when a template is added or removed,
 * and a template's own `version` when its content changes.
 */

import type { AgentTemplate } from './types';

import { customerSupportTemplate } from './items/customer-support';
import { supportTriageTemplate } from './items/support-triage';
import { itHelpdeskTemplate } from './items/it-helpdesk';
import { refundApprovalTemplate } from './items/refund-approval';
import { knowledgeQaTemplate } from './items/knowledge-qa';
import { hrPolicyAssistantTemplate } from './items/hr-policy-assistant';
import { prReviewerTemplate } from './items/pr-reviewer';
import { ciFailureTriageTemplate } from './items/ci-failure-triage';
import { releaseNotesWriterTemplate } from './items/release-notes-writer';
import { incidentPostmortemTemplate } from './items/incident-postmortem';
import { sqlAssistantTemplate } from './items/sql-assistant';
import { deepResearchTemplate } from './items/deep-research';
import { competitorMonitorTemplate } from './items/competitor-monitor';
import { dailyBriefingTemplate } from './items/daily-briefing';
import { dataAnalystTemplate } from './items/data-analyst';
import { leadQualifierTemplate } from './items/lead-qualifier';
import { meetingPrepTemplate } from './items/meeting-prep';
import { contentWriterTemplate } from './items/content-writer';
import { contentRepurposerTemplate } from './items/content-repurposer';
import { meetingNotesTemplate } from './items/meeting-notes';
import { emailTriageTemplate } from './items/email-triage';
import { documentExtractorTemplate } from './items/document-extractor';
import { contractReviewerTemplate } from './items/contract-reviewer';
import { translatorTemplate } from './items/translator';
import { supportRouterTemplate } from './items/support-router';

export const AGENT_TEMPLATE_CATALOG_VERSION = 1;

export const AGENT_TEMPLATES: AgentTemplate[] = [
  // support
  customerSupportTemplate,
  supportTriageTemplate,
  itHelpdeskTemplate,
  refundApprovalTemplate,
  // knowledge
  knowledgeQaTemplate,
  hrPolicyAssistantTemplate,
  // engineering
  prReviewerTemplate,
  ciFailureTriageTemplate,
  releaseNotesWriterTemplate,
  incidentPostmortemTemplate,
  sqlAssistantTemplate,
  // research
  deepResearchTemplate,
  competitorMonitorTemplate,
  dailyBriefingTemplate,
  dataAnalystTemplate,
  // sales_marketing
  leadQualifierTemplate,
  meetingPrepTemplate,
  contentWriterTemplate,
  contentRepurposerTemplate,
  // operations
  meetingNotesTemplate,
  emailTriageTemplate,
  documentExtractorTemplate,
  contractReviewerTemplate,
  translatorTemplate,
  // multi_agent
  supportRouterTemplate,
];

const TEMPLATES_BY_KEY = new Map(AGENT_TEMPLATES.map((template) => [template.key, template]));

export function findAgentTemplate(key: string): AgentTemplate | undefined {
  return TEMPLATES_BY_KEY.get(key);
}
