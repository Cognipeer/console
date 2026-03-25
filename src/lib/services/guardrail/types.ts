import type { IGuardrail, GuardrailAction, GuardrailTarget, GuardrailType } from '@/lib/database';

// ── PII Category definitions ─────────────────────────────────────────────

export interface PiiCategoryDefinition {
  id: string;
  label: string;
  description: string;
  defaultEnabled: boolean;
}

export const PII_CATEGORIES: PiiCategoryDefinition[] = [
  {
    id: 'email',
    label: 'Email addresses',
    description: 'Detects RFC-style email addresses.',
    defaultEnabled: true,
  },
  {
    id: 'phone',
    label: 'Phone numbers',
    description: 'Validates international phone number patterns.',
    defaultEnabled: true,
  },
  {
    id: 'creditCard',
    label: 'Credit card numbers',
    description: 'Detects potential credit card number patterns.',
    defaultEnabled: true,
  },
  {
    id: 'iban',
    label: 'IBAN numbers',
    description: 'Detects IBAN formatted bank accounts.',
    defaultEnabled: false,
  },
  {
    id: 'swift',
    label: 'SWIFT/BIC codes',
    description: 'Detects international bank identifier codes.',
    defaultEnabled: false,
  },
  {
    id: 'nationalId',
    label: 'National ID numbers',
    description: 'Detects national ID formats such as SSN-style patterns.',
    defaultEnabled: false,
  },
  {
    id: 'passport',
    label: 'Passport numbers',
    description: 'Detects common passport number formats.',
    defaultEnabled: false,
  },
  {
    id: 'birthDate',
    label: 'Birth dates',
    description: 'Detects common birth date formats.',
    defaultEnabled: false,
  },
  {
    id: 'address',
    label: 'Street addresses',
    description: 'Detects physical address patterns.',
    defaultEnabled: false,
  },
  {
    id: 'ipAddress',
    label: 'IP addresses',
    description: 'Detects IPv4 and IPv6 addresses.',
    defaultEnabled: false,
  },
  {
    id: 'url',
    label: 'URLs',
    description: 'Detects HTTP/HTTPS and www URLs.',
    defaultEnabled: false,
  },
  {
    id: 'socialHandle',
    label: 'Social media handles',
    description: 'Detects @username style social handles.',
    defaultEnabled: false,
  },
  {
    id: 'apiKey',
    label: 'API tokens & secrets',
    description: 'Detects long random tokens that resemble API keys or secrets.',
    defaultEnabled: true,
  },
  {
    id: 'cryptoWallet',
    label: 'Crypto wallet addresses',
    description: 'Detects Bitcoin/Ethereum wallet style addresses.',
    defaultEnabled: false,
  },
];

// ── Moderation Category definitions ──────────────────────────────────────

export interface ModerationCategoryDefinition {
  id: string;
  label: string;
  defaultEnabled: boolean;
}

export const MODERATION_CATEGORIES: ModerationCategoryDefinition[] = [
  { id: 'harassment', label: 'Harassment', defaultEnabled: true },
  { id: 'harassment/threatening', label: 'Harassment (Threatening)', defaultEnabled: true },
  { id: 'hate', label: 'Hate speech', defaultEnabled: true },
  { id: 'hate/threatening', label: 'Hate (Threatening)', defaultEnabled: true },
  { id: 'illicit', label: 'Illicit Activity', defaultEnabled: true },
  { id: 'illicit/violent', label: 'Illicit (Violent)', defaultEnabled: true },
  { id: 'self-harm', label: 'Self Harm', defaultEnabled: true },
  { id: 'self-harm/intent', label: 'Self Harm (Intent)', defaultEnabled: true },
  { id: 'self-harm/instructions', label: 'Self Harm (Instructions)', defaultEnabled: true },
  { id: 'sexual', label: 'Sexual Content', defaultEnabled: true },
  { id: 'sexual/minors', label: 'Sexual Content (Minors)', defaultEnabled: true },
  { id: 'violence', label: 'Violence', defaultEnabled: true },
  { id: 'violence/graphic', label: 'Graphic Violence', defaultEnabled: true },
  { id: 'terrorism', label: 'Terrorism & Extremism', defaultEnabled: true },
  { id: 'weapons', label: 'Weapons & Weapon Crafting', defaultEnabled: true },
  { id: 'fraud', label: 'Fraud & Scams', defaultEnabled: true },
  { id: 'drugs', label: 'Illegal Drugs', defaultEnabled: true },
  { id: 'cybercrime', label: 'Cybercrime & Malware', defaultEnabled: true },
  { id: 'child_safety', label: 'Child Safety & Grooming', defaultEnabled: true },
  { id: 'misinformation', label: 'Medical/Health Misinformation', defaultEnabled: true },
  { id: 'privacy_violation', label: 'Privacy Violations & Doxxing', defaultEnabled: true },
  { id: 'impersonation', label: 'Identity Impersonation', defaultEnabled: true },
  { id: 'manipulation', label: 'Psychological Manipulation', defaultEnabled: true },
  { id: 'radicalization', label: 'Radicalization Content', defaultEnabled: true },
  { id: 'financial_advice', label: 'Unauthorized Financial Advice', defaultEnabled: false },
  { id: 'animal_cruelty', label: 'Animal Abuse & Cruelty', defaultEnabled: true },
];

// ── Prompt Shield issue definitions ──────────────────────────────────────

export interface PromptShieldIssueDefinition {
  id: string;
  label: string;
}

export const PROMPT_SHIELD_ISSUES: PromptShieldIssueDefinition[] = [
  { id: 'prompt_injection', label: 'Prompt injection attempt' },
  { id: 'system_override', label: 'Attempt to override instructions' },
  { id: 'role_play', label: 'Role-playing to bypass policies' },
  { id: 'social_engineering', label: 'Social engineering' },
  { id: 'data_exfiltration', label: 'Attempt to exfiltrate secrets' },
  { id: 'jailbreak_persona', label: 'DAN or jailbreak persona' },
  { id: 'hypothetical_scenario', label: 'Hypothetical scenario attack' },
  { id: 'payload_splitting', label: 'Payload splitting/smuggling' },
  { id: 'context_poisoning', label: 'Context poisoning attempt' },
  { id: 'privilege_escalation', label: 'Privilege escalation attempt' },
  { id: 'policy_circumvention', label: 'Policy circumvention technique' },
  { id: 'recursive_prompting', label: 'Recursive or meta-prompting' },
  { id: 'encoding_obfuscation', label: 'Encoding/obfuscation attack' },
  { id: 'multi_language_evasion', label: 'Multi-language evasion' },
  { id: 'other', label: 'Other jailbreak technique' },
];

// ── Evaluation result types ───────────────────────────────────────────────

export interface GuardrailFinding {
  type: 'pii' | 'moderation' | 'prompt_shield' | 'custom';
  category: string;
  severity: 'low' | 'medium' | 'high';
  message: string;
  action: GuardrailAction;
  block: boolean;
  value?: string;
}

export interface GuardrailEvaluationResult {
  passed: boolean;
  guardrailKey: string;
  guardrailName: string;
  action: GuardrailAction;
  findings: GuardrailFinding[];
}

// ── Service input/output types ────────────────────────────────────────────

export interface CreateGuardrailInput {
  name: string;
  description?: string;
  type: GuardrailType;
  target: GuardrailTarget;
  action: GuardrailAction;
  enabled?: boolean;
  modelKey?: string;
  policy?: IGuardrail['policy'];
  customPrompt?: string;
  projectId?: string;
}

export interface UpdateGuardrailInput {
  name?: string;
  description?: string;
  target?: GuardrailTarget;
  action?: GuardrailAction;
  enabled?: boolean;
  modelKey?: string;
  policy?: IGuardrail['policy'];
  customPrompt?: string;
}

export interface GuardrailView {
  id: string;
  tenantId: string;
  projectId?: string;
  key: string;
  name: string;
  description?: string;
  type: GuardrailType;
  target: GuardrailTarget;
  action: GuardrailAction;
  enabled: boolean;
  modelKey?: string;
  policy?: IGuardrail['policy'];
  customPrompt?: string;
  createdBy: string;
  updatedBy?: string;
  createdAt?: Date | string;
  updatedAt?: Date | string;
}

export interface EvaluateGuardrailInput {
  guardrailKey: string;
  text: string;
  tenantDbName: string;
  tenantId: string;
  projectId?: string;
}
