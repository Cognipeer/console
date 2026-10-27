/**
 * The `agentTemplates` namespace (the agent template gallery: names, summaries
 * and use cases of the catalog templates, the category / capability / surface
 * labels, the availability and setup messages). The Turkish counterpart in
 * agentTemplates.tr.ts must keep the same keys. The system prompts of the
 * templates are model-facing and are NOT translated (see
 * src/lib/services/agents/templates/items).
 *
 * `items.<template key>` holds `name`, `summary` (at most 90 characters),
 * `description` and `useCases` (three bullets, read as `useCases.0` ...).
 */

export const agentTemplatesEn = {
  categories: {
    support: 'Support',
    knowledge: 'Knowledge',
    engineering: 'Engineering',
    research: 'Research',
    sales_marketing: 'Sales & marketing',
    operations: 'Operations',
    multi_agent: 'Multi-agent',
  },
  capabilities: {
    knowledge: 'Knowledge base',
    web_search: 'Web search',
    mcp: 'MCP',
    client_tools: 'Client tools',
    approval: 'Approval',
    ask_user: 'Asks questions',
    subagents: 'Sub-agents',
    skills: 'Skills',
    structured_output: 'Structured output',
    variables: 'Variables',
    schedule: 'Schedule',
    webhook: 'Webhook',
    sandbox: 'Sandbox',
    guardrails: 'Guardrails',
  },
  surfaces: {
    chat: 'Chat',
    api: 'API',
    trigger: 'Trigger',
  },
  modelHints: {
    fast: 'A fast, low-cost chat model is enough.',
    balanced: 'Works well with a balanced, general-purpose chat model.',
    reasoning: 'Works best with a reasoning model.',
  },
  availability: {
    status: {
      ready: 'Ready',
      needs_setup: 'Needs setup',
      unavailable: 'Unavailable',
    },
    items: {
      no_llm_model: 'This project has no chat model yet. Add one in the Model Hub first.',
      sandbox_unavailable: 'This template needs the sandbox, an Enterprise feature.',
      sandbox_template_missing: 'The sandbox has no templates yet. Create a sandbox template first.',
      web_search_unavailable: 'No web search provider is active in this project. Add one under Providers.',
      knowledge_missing:
        'This project has no knowledge base yet. Create one so the agent can answer from your documents.',
    },
    sandboxReasons: {
      edition: 'This edition does not include the sandbox module.',
      license: 'This workspace has no Enterprise license.',
    },
  },
  setup: {
    knowledge_not_bound:
      'Attach a knowledge base in the agent settings so it can answer from your documents.',
    web_search_unavailable:
      'No web search provider is active in this project, so the agent cannot search the web yet. Add one under Providers.',
    guardrails_recommended:
      'Attach a guardrail in the agent settings before exposing this agent to end users.',
    client_tools:
      'This agent asks your app to run {tools}. Connect it through the API or SDK, or a portal, before going live. In the playground you answer the call yourself.',
    publish_needed: 'The API, triggers and A2A run the published version: publish the agent to use them.',
    triggers_disabled:
      'The suggested triggers ({names}) were created disabled. Review them, publish the agent, then enable them.',
    webhook_secret: 'Copy each webhook secret now. It is shown only once.',
  },
  hints: {
    clientTools:
      'This agent asks your app to run {tools}. Connect it through the API or SDK, or a portal, before going live. In the playground you answer the call yourself.',
  },
  ui: {
    entry: {
      menuTitle: 'From template',
      menuDescription: 'Start from a ready-made agent',
      browse: 'Browse templates',
      link: 'Templates',
    },
    page: {
      eyebrow: 'Build · Agents · Templates',
      title: 'Agent templates',
      subtitle: 'Start from a ready-made agent, then change anything in Studio.',
      count: '{count} templates · catalog v{version}',
      back: 'Back to agents',
      searchPlaceholder: 'Search templates…',
      searchLabel: 'Search templates',
      categoryFilter: 'Category',
      capabilityFilter: 'Capabilities',
      all: 'All',
      featured: 'Featured',
      noResults: 'No templates match',
      noResultsHint: 'Try another word, or clear the filters.',
      clearFilters: 'Clear filters',
      loadFailed: 'Could not load the templates',
      retry: 'Try again',
      moreCapabilities: '+{count}',
      openTemplate: 'Open {name}',
    },
    drawer: {
      version: 'v{version}',
      close: 'Close',
      useTemplate: 'Use template',
      useCases: 'Use cases',
      whatYouGet: 'What you get',
      model: 'Model',
      modelLine: 'You pick one. {hint}',
      tools: 'Tools',
      knowledge: 'Knowledge base',
      knowledgeRequired: 'Needs a knowledge base',
      knowledgeOptional: 'Optional, answers from your documents when attached',
      skills: 'Skills',
      subagents: 'Sub-agents',
      structuredOutput: 'Structured output',
      guardrails: 'Guardrails',
      guardrailsRecommended: 'Recommended before real users reach it',
      sandbox: 'Sandbox',
      sandboxRequired: 'Runs code in a sandbox template',
      webSearch: 'Web search',
      variables: 'Variables',
      variableName: 'Name',
      variableType: 'Type',
      variableDefault: 'Default',
      noDefault: '—',
      fromWebhook: 'from the webhook',
      triggers: 'Suggested triggers',
      triggersNote: 'Created disabled. You enable them after reviewing.',
      triggersConnectorNote: 'Connector events listen to one of the project\'s connectors, which you pick when you use the template. Without one they are not created.',
      setup: 'Setup for this project',
      setupReady: 'Everything this template needs is in place',
      systemPrompt: 'System prompt (preview)',
      loading: 'Loading the template…',
      loadFailed: 'Could not load the template',
      unavailable: 'This template cannot be used here',
      surfaces: 'Works through',
    },
    trigger: {
      schedule: 'Schedule · {cron}',
      webhook: 'Webhook · {preset}',
      connector: 'Connector event · {package} · {trigger}',
      manual: 'Manual',
      events: 'events: {events}',
    },
    form: {
      title: 'New agent from template',
      subtitle: '{name} · v{version}',
      loading: 'Loading the project…',
      basics: 'Basics',
      basicsDesc: 'Name the agent. The key is its address in the API.',
      name: 'Name',
      key: 'Key',
      keyHint: 'Leave empty to use "{key}" (a number is added when it is taken). Lower case letters, digits, "-" or "_".',
      keyInvalid: 'The key may only use lower case letters, digits, "-" and "_".',
      description: 'Description',
      model: 'Model',
      modelDesc: 'The chat model the agent runs on. Only this project\'s chat models are listed.',
      modelPlaceholder: 'Pick a model',
      modelNone: 'This project has no chat model yet. Add one in the Model Hub first.',
      knowledge: 'Knowledge',
      knowledgeDesc: 'The agent answers from the knowledge bases you attach.',
      knowledgePlaceholder: 'Pick knowledge bases…',
      knowledgeNone: 'No knowledge base yet.',
      knowledgeCreate: 'Create one',
      knowledgeLater: 'Set up later',
      knowledgeLaterHint: 'The agent is created without a knowledge base. Attach one in its settings.',
      sandbox: 'Sandbox',
      sandboxDesc: 'The agent runs code in a sandbox. Pick the sandbox template it starts from.',
      sandboxTemplate: 'Sandbox template',
      sandboxPlaceholder: 'Pick a sandbox template',
      sandboxNone: 'The sandbox has no templates yet.',
      sandboxCreate: 'Open sandbox templates',
      tools: 'Tools & safety',
      toolsDesc: 'Web search and guardrails for this agent.',
      webSearchOk: 'Web search: a provider is active',
      webSearchMissing: 'Web search: no provider is active in this project. Add one under Providers.',
      webSearchUnused: 'Web search: not used by this template',
      guardrails: 'Guardrails',
      guardrailsRecommendedHint: 'Recommended for this template.',
      guardrailsOptionalHint: 'Optional.',
      guardrailsPlaceholder: 'Pick guardrails…',
      triggers: 'Triggers',
      triggersDesc: 'Suggested triggers are created disabled, so nothing fires before you have reviewed them.',
      createTriggers: 'Create the suggested triggers (disabled)',
      connectorLabel: 'Connector for {package}',
      connectorHint: 'The suggested triggers of this package listen to this connector. Leave it empty to skip them.',
      connectorPlaceholder: 'Pick a connector',
      connectorNone: 'This project has no {package} connector yet. The triggers that need it are skipped; add them from the agent once you have one.',
      connectorUnavailable: 'Connector triggers need the Connectors module. The triggers that need a connector are skipped.',
      timezone: 'Timezone',
      timezoneHint: 'Used by the schedules. Your browser\'s timezone by default.',
      publish: 'Publish now',
      publishDesc: 'Needed for the API, triggers and A2A. Off: the agent stays a draft you can test in the playground.',
      summary: 'Summary',
      summaryTemplate: 'Template',
      summaryModel: 'Model',
      summaryKnowledge: 'Knowledge',
      summarySkills: 'Skills',
      summarySubagents: 'Sub-agents',
      summaryVariables: 'Variables',
      summaryStructured: 'Structured output',
      summaryTriggers: 'Triggers',
      summaryState: 'State',
      yes: 'Yes',
      none: 'None',
      created: '{count} (created)',
      triggersDisabled: '{count} · disabled',
      stateDraft: 'Draft',
      statePublished: 'Published',
      ready: 'Ready to create',
      create: 'Create agent',
      cancel: 'Cancel',
      createFailed: 'Could not create the agent',
      blockerName: 'Give the agent a name',
      blockerModel: 'Pick a model',
      blockerKnowledge: 'Pick a knowledge base or choose "Set up later"',
      blockerSandbox: 'Pick a sandbox template',
      blockerKey: 'Fix the key',
      blockerUnavailable: 'This template cannot be used here',
    },
    created: {
      title: '{name} is ready',
      summaryDraft: 'Created as a draft',
      summaryPublished: 'Created and published',
      summarySkills: '{count} skills created',
      summaryTriggers: '{count} triggers created (disabled)',
      nextSteps: 'Next steps',
      webhook: 'Webhook for the trigger "{name}"',
      payloadUrl: 'Payload URL',
      secret: 'Secret',
      secretOnce: 'The secret is shown only once. Copy it now. Lost it? Rotate it from the agent\'s Triggers section.',
      secretGone: 'The secret was not returned.',
      skippedTitle: 'Triggers not created',
      skipped: '{name} needs a {package} connector',
      skippedHint: 'The agent was created without them. Once there is a connector, add the trigger from the agent\'s Triggers section.',
      connector: 'Connector trigger "{name}"',
      callbackUrl: 'Callback URL',
      copy: 'Copy',
      copied: 'Copied',
      tryIt: 'A first message to try',
      openAgent: 'Open agent',
      backToTemplates: 'Back to templates',
      warnings: 'Notes from validation',
      setupTitle: 'Still to do',
    },
  },
  items: {
    'customer-support': {
      name: 'Customer Support Agent',
      summary: 'Answers from your knowledge base, asks what it needs, and escalates with a ticket.',
      description:
        'A friendly front-line support agent that searches your Knowledge base, asks one focused question at a time and cites its sources. When it cannot solve a problem it drafts a ticket for a colleague, and a person approves the ticket before it is created.',
      useCases: [
        'Answer product and policy questions from your help center',
        'Collect the details a human agent needs before escalating',
        'Create tickets in your helpdesk after an Approval',
      ],
    },
    'support-triage': {
      name: 'Support Ticket Triage',
      summary: 'Classifies every new ticket: category, priority, sentiment, team and a draft reply.',
      description:
        'Reads an incoming ticket and returns a Structured output with its category, priority, sentiment, language, summary and the team that should own it. It flags tickets that need a human and drafts a first reply. Point your helpdesk webhook at its Trigger or call it from the API.',
      useCases: [
        'Route new tickets to the right team automatically',
        'Surface urgent and angry customers first',
        'Pre-fill replies for agents to review',
      ],
    },
    'it-helpdesk': {
      name: 'IT Helpdesk Assistant',
      summary: 'Diagnoses device and access issues step by step and opens complete IT tickets.',
      description:
        'A first-line IT assistant that asks for the device, operating system and exact error before suggesting safe fixes, using your Knowledge base when one is attached. If self-service fails it prepares a complete IT ticket, and a person approves it before it is created.',
      useCases: [
        'Walk employees through Wi-Fi, VPN, email and printer problems',
        'Reduce back-and-forth by collecting device, OS and error details up front',
        'Escalate suspected phishing or lost devices as urgent tickets',
      ],
    },
    'refund-approval': {
      name: 'Refund Approval Assistant',
      summary: 'Checks refund eligibility against your policy and asks a person to approve every refund.',
      description:
        'Looks up the order, checks it against the refund window, amount and currency you set as Variables, and explains the outcome to the customer. The refund itself is only issued after a person gives Approval, so money never moves on the model\'s word alone.',
      useCases: [
        'Handle refund requests with a consistent policy check',
        'Give approvers the facts they need in one place',
        'Keep a human in control of every payout',
      ],
    },
    'knowledge-qa': {
      name: 'Knowledge Q&A',
      summary: 'Answers questions from your knowledge base with sources, and says so when it can\'t.',
      description:
        'A grounded question-answering assistant that searches your connected knowledge base, cites the documents it used and refuses to guess. When nothing relevant is found it says so and suggests where to look next.',
      useCases: [
        'Internal wiki and handbook search',
        'Product documentation assistant for customers',
        'Answer API behind an intranet or help center',
      ],
    },
    'hr-policy-assistant': {
      name: 'HR Policy Assistant',
      summary: 'Explains HR policies from your documents and routes sensitive cases to people.',
      description:
        'Answers employee questions about leave, benefits and HR processes strictly from your policy documents, and tells people what to do next. It avoids personal data, gives no legal or medical advice and escalates sensitive matters to HR. Attaching a PII guardrail is recommended.',
      useCases: [
        'Leave, benefits and expense policy questions',
        'New-hire onboarding FAQ',
        'First line of HR support before a ticket is opened',
      ],
    },
    'pr-reviewer': {
      name: 'Pull Request Reviewer',
      summary: 'Reviews every new pull request and returns structured findings, risk and a verdict.',
      description:
        'Receives a GitHub pull request event, checks the change against a review checklist and returns a structured review: summary, risk, findings with severity, suggested tests and a verdict. When the diff is not available it says what is missing instead of guessing.',
      useCases: [
        'Get a first-pass review on every opened or updated pull request',
        'Post structured findings to a CI step or chat channel through the runs API',
        'Review a pasted diff before asking a teammate',
      ],
    },
    'ci-failure-triage': {
      name: 'CI Failure Triage',
      summary: 'Diagnoses failed pipeline runs: failing step, likely root cause, fix and flakiness.',
      description:
        'Listens for failed GitHub Actions runs, or any CI system through a generic webhook, and turns the failure into a structured diagnosis. It names the failing step, classifies the cause, rates its own confidence and says when it needs the log.',
      useCases: [
        'Post a one-line root cause next to every red build',
        'Separate flaky tests from real regressions',
        'Paste a failing log into the playground and get ordered next steps',
      ],
    },
    'release-notes-writer': {
      name: 'Release Notes Writer',
      summary: 'Turns commits and pull requests into clear release notes for the audience you choose.',
      description:
        'Paste commits, pull request titles or changelog fragments and get grouped Markdown release notes: Added, Changed, Fixed and Security, with breaking changes called out first. It rewrites each change for the audience and never invents features or numbers.',
      useCases: [
        'Draft customer-facing release notes at the end of a sprint',
        'Write a developer changelog with migration steps for breaking changes',
        'Summarize a release for an internal announcement',
      ],
    },
    'incident-postmortem': {
      name: 'Incident Postmortem',
      summary: 'Turns incident notes into a blameless postmortem with timeline, root cause and actions.',
      description:
        'Paste chat logs, alerts and notes from an incident and get a blameless postmortem: summary, impact, UTC timeline, root cause and contributing factors, what went well and poorly, and owned action items. It marks inferences as such and asks questions instead of guessing missing facts.',
      useCases: [
        'Draft a postmortem within hours of resolving an outage',
        'Turn a noisy incident channel into a clean timeline',
        'Check that action items are specific, owned and verifiable',
      ],
    },
    'sql-assistant': {
      name: 'SQL Assistant',
      summary: 'Writes and explains read-only SQL for your dialect and schema, and flags every assumption.',
      description:
        'Describe the question in plain language and get a readable query for Postgres, MySQL, SQL Server, SQLite, BigQuery or Snowflake. It sticks to the schema you provide, stays read-only unless you explicitly ask otherwise, explains each step and lists the assumptions to verify.',
      useCases: [
        'Turn a business question into a query without guessing table names',
        'Understand and review a long query someone else wrote',
        'Port a query from one SQL dialect to another',
      ],
    },
    'deep-research': {
      name: 'Deep Research',
      summary: 'Plans, searches the web in parallel, fact-checks and writes a cited report.',
      description:
        'A research lead that breaks your question into sub-questions, sends web researchers out in parallel, has a fact checker verify the key claims and then writes a structured report with numbered sources. Conflicts and gaps are reported openly instead of being smoothed over. Requires a web search provider.',
      useCases: [
        'Market and competitor landscape briefs',
        'Technology comparisons before a build-or-buy decision',
        'Background research on a topic, person or regulation',
      ],
    },
    'competitor-monitor': {
      name: 'Competitor Monitor',
      summary: 'Weekly digest of competitor pricing, launches, hiring and funding, with sources.',
      description:
        'Tracks the competitors you name across the open web and reports only verified changes from the past week. Each finding is rated by impact and linked to its source, and quiet weeks are reported as quiet. Run it on a weekly Schedule trigger or ask it ad hoc in chat.',
      useCases: [
        'Monday-morning competitor digest for the sales and product teams',
        'Spot a rival\'s price change or new launch within days',
        'Prepare for a board or strategy review with fresh market signals',
      ],
    },
    'daily-briefing': {
      name: 'Daily Briefing',
      summary: 'A ranked, source-linked morning news briefing on the topics you follow.',
      description:
        'Searches the web every morning for what happened in your topics over the last 24 hours, merges duplicates and ranks stories by significance. You choose the topics, the language and how many items to include through Variables. Schedule it on weekdays or ask for a briefing on demand.',
      useCases: [
        'Start the workday with a five-minute briefing on your industry',
        'Keep leadership informed on AI, regulation or market news',
        'Get a one-off briefing on a topic before a meeting',
      ],
    },
    'data-analyst': {
      name: 'Data Analyst',
      summary: 'Answers data questions by running code in a sandbox, so every number is computed.',
      description:
        'Profiles your data, runs Python in an isolated sandbox and reports the answer with its method and caveats. It never estimates numbers from memory and says exactly what is missing when the data cannot answer the question. Requires the Enterprise sandbox module.',
      useCases: [
        'Ask which segment grew fastest in a pasted CSV',
        'Clean a messy export and check it for duplicates and outliers',
        'Get a verified summary before presenting numbers to your team',
      ],
    },
    'lead-qualifier': {
      name: 'Lead Qualifier',
      summary: 'Scores leads against your ideal customer profile and returns a structured scorecard.',
      description:
        'Researches a company, scores its fit from 0 to 100 against your ideal customer profile and returns Structured output with reasons, risks, buying signals, sources and a recommended next step. Connect the suggested Webhook trigger to your form or CRM to score every new lead automatically, or use it in chat and over the API.',
      useCases: [
        'Score every new demo request before it reaches a salesperson',
        'Prioritize an imported lead list by fit',
        'Decide quickly whether a company is worth an outbound sequence',
      ],
    },
    'meeting-prep': {
      name: 'Meeting Prep',
      summary: 'One-page brief with talking points, questions and likely objections for a meeting.',
      description:
        'Researches the company and attendees from public sources and turns the findings into a one-page brief around your meeting goal. It includes an agenda, talking points, discovery questions, likely objections and a list of items to verify. Works with or without web search.',
      useCases: [
        'Prepare for a first discovery call in five minutes',
        'Brief a colleague who is joining a customer meeting',
        'Get ready for a partner or investor conversation',
      ],
    },
    'content-writer': {
      name: 'Content writer',
      summary: 'Turns a brief into an outline, a full draft and SEO title and meta description.',
      description:
        'Give it a topic and it proposes an outline, writes a draft in your chosen tone and length, and finishes with an SEO title, meta description and slug. Variables set the audience, tone, length and keywords once, so every piece stays consistent.',
      useCases: [
        'Blog posts and announcements from a short brief',
        'Landing page and product description copy',
        'Consistent brand tone across a content team',
      ],
    },
    'content-repurposer': {
      name: 'Content repurposer',
      summary: 'Turns one article into a LinkedIn post, an X thread, a newsletter blurb and quotes.',
      description:
        'Send a long-form source and get channel-ready assets back as one structured JSON object. Quotes are copied word for word from the source and nothing new is invented. A brand voice variable keeps the tone consistent across channels.',
      useCases: [
        'Promote every blog post on social media in minutes',
        'Feed a content pipeline through the API',
        'Pull verbatim quotes from reports and transcripts',
      ],
    },
    'meeting-notes': {
      name: 'Meeting notes',
      summary: 'Turns a transcript into a summary, decisions, action items with owners, and risks.',
      description:
        'Paste a transcript or rough notes and get structured minutes as JSON: summary, decisions, action items with owner and due date, open questions and risks. It only records what was actually said, and marks unknown owners as unassigned instead of guessing.',
      useCases: [
        'Minutes and follow-ups right after a call',
        'Push action items into a task tool through the API',
        'Weekly team sync summaries',
      ],
    },
    'email-triage': {
      name: 'Email triage',
      summary: 'Classifies each incoming email, sets priority, and drafts a safe reply when one is needed.',
      description:
        'Receives emails through a webhook trigger or the API and returns a structured result: category, priority, whether a reply is needed, the sender\'s intent, a summary and an optional draft reply. Drafts never promise prices, dates or refunds, and email text is treated as information, never as instructions.',
      useCases: [
        'Route a shared inbox to the right team automatically',
        'Surface urgent and high-priority emails first',
        'Pre-write polite replies for a person to review',
      ],
    },
    'document-extractor': {
      name: 'Document extractor',
      summary: 'Turn invoices, receipts and orders into clean JSON with confidence scores.',
      description:
        'Reads the text of a business document and returns typed fields, line items, missing fields and warnings as strict JSON. Values are copied as printed, uncertain ones get a lower confidence, and nothing is guessed.',
      useCases: [
        'Capture invoice data for accounting or ERP import',
        'Pre-fill purchase order forms from supplier emails',
        'Flag documents with missing fields or totals that do not add up',
      ],
    },
    'contract-reviewer': {
      name: 'Contract reviewer',
      summary: 'First-pass contract review: key terms, risky clauses, suggested redlines.',
      description:
        'Reads a commercial agreement and returns its parties, term, renewal, termination and liability cap, then flags risky clauses with severity and a proposed redline. It also lists standard protections that are missing. Output is a first pass for a human reviewer, not legal advice.',
      useCases: [
        'Triage vendor and SaaS contracts before they reach legal',
        'Compare a counterparty\'s draft against your standard positions',
        'Prepare negotiation points with ready-to-use redline wording',
      ],
    },
    translator: {
      name: 'Translator',
      summary: 'Faithful, natural translation that keeps formatting, placeholders and glossary terms.',
      description:
        'Translates text into the language and tone you set, applies your glossary strictly and leaves Markdown, HTML, code, placeholders and URLs untouched. Ambiguities are flagged in short notes instead of being silently guessed.',
      useCases: [
        'Localize app strings and email templates without breaking placeholders',
        'Translate support replies or documentation in a consistent brand tone',
        'Keep product and legal terminology consistent with a glossary',
      ],
    },
    'support-router': {
      name: 'Support Router',
      summary: 'Routes each request to a billing, technical or sales specialist and merges the answer.',
      description:
        'A front-desk agent that classifies incoming customer messages and delegates them to three specialist sub-agents, in parallel when a message covers several topics. It asks a clarifying question when the request is ambiguous and returns one merged answer. Attach a knowledge base to ground the answers.',
      useCases: [
        'Single entry point for a support chat or inbox',
        'Splitting mixed requests such as a billing issue plus a plan question',
        'Starting point for your own multi-agent support team',
      ],
    },
  },
};
