/**
 * The PII protection picker (`components/pii/PiiProtectionField`) on the model edit page, the agent Build tab and an
 * MCP server's Security tab.
 * Registered in `en.ts` as `piiProtection`; the twin is `piiProtection.tr.ts`.
 */
export const piiProtectionEn = {
  title: 'PII protection',
  model: {
    description:
      'Personal data never reaches the provider: each value the PII policy finds goes out as a token, and the answer comes back with the real value. Applies to every call to this model.',
  },
  agent: {
    description: 'The model sees tokens; tools, the conversation and the user see the real values.',
    inherited: 'The model {model} already protects every call with the policy {policy}. A policy chosen here replaces it for this agent.',
    replaces: 'Replaces the policy {policy} of the model {model} for this agent.',
  },
  mcp: {
    description:
      'The upstream never sees personal data: each value the PII policy finds in a call’s arguments goes out as a token, and tokens in the result come back as the real values. Callers and agents see the values as before.',
  },
  policy: {
    label: 'PII policy',
    hint: 'What to look for is set on the policy, under PII. Off sends the text as it is.',
    placeholder: 'Off',
    loading: 'Loading policies…',
    failed: 'The PII policies could not be loaded.',
    none: 'No PII policy in this project yet.',
    create: 'Create a PII policy',
    new: 'New PII policy',
    noneReadOnly: 'Someone who can edit PII has to create one.',
    open: 'Open the policy',
    missing: 'The policy “{key}” is not in this project any more. Calls fail until another one is chosen or protection is turned off.',
    disabled: 'This policy is turned off, so calls go out unprotected until it is turned on again.',
    disabledSuffix: 'off',
  },
  limits: {
    media: 'Images, files and audio are refused while protection is on.',
    logs: 'Usage logs keep the tokens, not the values.',
    session: 'A value keeps the same token for the whole session.',
    mcpText: 'Only text values in the arguments are checked. A tool that needs the real values can be listed below.',
    mcpLogs: 'The server’s request logs keep the tokens, not the values.',
    mcpStable: 'A value always gets the same token on this server, so the upstream can still find a record by it.',
  },
};
