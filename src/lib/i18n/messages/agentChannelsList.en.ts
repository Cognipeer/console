/**
 * Agent channels: a channel's modal and the Channels section of an agent's Ship tab (there is no Channels page).
 * Spread into the `agentChannels` namespace in `en.ts`; the shared words are in agentChannels.en.ts (`common`).
 */
export const agentChannelsListEn = {
  list: {
    // Names the thing in the shared delete dialog ("Delete channel?").
    noun: 'channel',
    disable: {
      title: 'Disable {name}?',
      message: 'The connection closes and the bot stops answering until you enable the channel again.',
      confirm: 'Disable',
    },
    enable: {
      title: 'Enable {name}?',
      message: 'Console first checks the connection with the stored credentials.',
      confirm: 'Enable',
    },
    delete: {
      warning: 'The channel record is deleted. Session history stays in Console.',
    },
    notify: {
      enabled: 'Channel enabled',
      disabled: 'Channel disabled',
      deleted: 'Channel deleted',
    },
  },
  detail: {
    loading: 'Loading channel…',
    meta: {
      connectionsOne: '1 connection open',
      connectionsOther: '{count} connections open',
      lastMessage: 'Last message {time}',
      noMessage: 'No message yet',
    },
    actions: {
      guide: 'Setup guide',
      disable: 'Disable',
      enable: 'Enable',
      more: 'More actions',
      edit: 'Edit details',
      delete: 'Delete',
    },
    // What a failed action says in its notification (the reason follows from the server's code).
    errors: {
      save: 'The change could not be saved',
      switch: 'The channel could not be switched on',
      verify: 'The checks could not run',
    },
    banner: {
      draft: {
        title: 'Setup not finished',
        text: 'This channel is not connected yet. Finish the setup: the bot starts answering once its credentials are verified.',
        action: 'Continue setup',
      },
      error: {
        title: 'The connection has a problem',
      },
      waiting: {
        title: 'No message has arrived yet',
        text: 'Console has not received anything from Teams yet. Check these three things:',
        endpoint: 'The messaging endpoint is set on your Azure Bot.',
        channel: 'The Microsoft Teams channel is turned on for the bot.',
        package: 'The app package is uploaded to Teams.',
      },
    },
    notice: {
      verified: 'All checks passed',
      failed: 'Some checks failed',
      dismiss: 'Dismiss',
    },
    access: {
      title: 'Where and who',
      where: 'Where it answers',
      who: 'Who may use it',
    },
    people: {
      title: 'People matching',
      emailMatch: {
        label: 'Match by email automatically',
        hint: 'A person whose email is verified by {platform} is matched to the Console user with the same email.',
      },
      domains: {
        label: 'Allowed email domains',
        empty: '(empty = all)',
        hint: 'Leave empty to allow every verified email. Up to {max} domains.',
        placeholder: 'example.com',
        invalid: '“{value}” is not a domain name. Use something like example.com.',
      },
      notes: {
        noAccount: 'A person who cannot be matched to a Console user is told to ask their admin.',
      },
      saved: 'People matching updated',
    },
    connection: {
      title: 'Connection',
      changeTokens: 'Change tokens',
      renewSecret: 'Renew secret',
      addTokens: 'Add tokens',
      addCredentials: 'Add credentials',
      downloadManifest: 'Download manifest',
      downloadPackage: 'Download Teams package',
      downloadFailed: 'The file could not be downloaded',
      noCredentials: 'No credentials are saved yet.',
      bot: 'Bot',
      workspace: 'Workspace',
      appToken: 'App-level token',
      botToken: 'Bot token',
      mode: 'Connection mode',
      socketMode: 'Socket Mode (outbound connection)',
      scopes: 'Granted permissions ({count})',
      createdBy: 'Created by',
      appId: 'App ID',
      tenantId: 'Tenant ID',
      secret: 'Client secret',
      secretUpdated: 'updated {date}',
      endpoint: 'Messaging endpoint',
      knownTeams: 'Teams the bot is in',
    },
    edit: {
      title: 'Edit channel',
      subtitle: "Name, description and the language of the bot's own messages.",
      sectionDetails: 'Details',
      sectionDetailsHint: 'How this channel is named in Console.',
      name: 'Name',
      nameHint: 'Only the name in Console changes. The app in {platform} keeps its own name.',
      nameRequired: 'Enter a name.',
      nameTooLong: 'At most {max} characters.',
      nameAria: 'Channel name',
      description: 'Description',
      descriptionAria: 'Channel description',
      optional: 'optional',
      descriptionTooLong: 'At most {max} characters.',
      sectionLanguage: 'Bot language',
      sectionLanguageHint: "The language of the bot's own messages.",
      language: 'Language',
      languageAria: 'Bot language',
      languageHint: "The bot writes its own messages (such as refusals) in this language. Answers come in the agent's language.",
      summary: {
        channel: 'Channel',
        platform: 'Platform',
        workspace: 'Workspace',
        state: 'State',
        ready: 'Ready to save',
      },
      checklist: {
        name: 'Name entered',
        changed: 'Something to save',
      },
      ready: '{done} of {total} ready',
      saved: 'Channel updated',
    },
  },
  // The cells the list and the channel page share (agent, where, who).
  cells: {
    agent: {
      skipped: 'This agent is not ready: the channel does not answer until it is.',
    },
    where: {
      dm: 'DM',
      dmOnly: 'Direct messages only',
      allChannels: 'All channels',
      nowhere: 'Nowhere',
    },
    who: {
      everyone: 'Everyone',
      nobody: 'Nobody',
      group: '{name} (group)',
      unknownGroup: 'A group',
      unknownPerson: 'A person',
    },
    more: '+{count}',
    moreAria: '{count} more: {names}',
  },
  // The Channels section of an agent's Ship tab.
  ship: {
    title: 'Channels',
    description: 'Slack and Microsoft Teams channels where this agent answers.',
    add: 'Add channel',
    empty: 'This agent is not connected to Slack or Microsoft Teams yet.',
    loadFailed: 'The channels could not be loaded.',
    retry: 'Try again',
    openAria: 'Open {name}',
  },
};
