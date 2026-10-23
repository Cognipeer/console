/**
 * Agent channels: the login-link page (/channels/link/:token) and the linked chat accounts on My account.
 * Spread into the `agentChannels` namespace in `en.ts`; the shared words are in agentChannels.en.ts (`common`).
 *
 * Every state of the link page keeps its own `title` / `subtitle` / `body`: `title` and `subtitle` fill the intro
 * pane of the page, `accent` is the part of `title` shown in the accent colour (it must be a substring of it) and
 * `body` is what the person reads in the panel. `{platform}` is the platform name (Slack, Microsoft Teams).
 */
export const agentChannelsLinkEn = {
  link: {
    eyebrow: 'Chat account',
    loading: 'Checking your link…',
    hero: {
      title: 'Link your {platform} account',
      titleGeneric: 'Link your chat account',
      accentGeneric: 'chat account',
      subtitle: 'Confirm that this chat account is yours, then finish with a code in the chat.',
      linkedTitle: 'Account linked',
      linkedAccent: 'linked',
      linkedSubtitle: 'Your {platform} account is now linked to your Console account.',
      // A link that finished carries no details, so after a reload the platform is not known.
      linkedSubtitleGeneric: 'Your chat account is now linked to your Console account.',
    },
    highlights: {
      readOnly: 'Opening this page changes nothing.',
      singleUse: 'The link works once and for {minutes} minutes.',
      code: 'You finish by sending a code to the bot in the chat.',
    },
    // The two accounts side by side: the chat account that will be linked, and the Console account signed in here.
    pair: {
      label: 'The two accounts that will be linked',
      console: 'Console',
      noName: 'Unnamed chat account',
      workspaceSlack: 'Workspace {id}',
      workspaceTeams: 'Tenant {id}',
      channel: 'Channel {name}',
      consoleLoading: 'Loading your Console account…',
      consoleFailed: 'Your Console account could not be loaded.',
    },
    ready: {
      effect: 'From now on, messages from this chat account run the agents in your name and with your permissions. Usage and cost are recorded to your account.',
      securityTitle: 'Before you link',
      // Required security copy: keep all three sentences.
      security: 'Make sure this is your own chat account. You will type a code to the bot from that account. Never give the code to anyone.',
      // Display names are chosen by whoever owns the chat account: they prove nothing (phishing guard).
      nameNote: 'The name shown is set by the chat account itself. It proves nothing about who owns the account.',
      confirm: 'Link',
      cancel: 'Cancel',
      notYou: 'Not you?',
      signOut: 'Sign out',
      notYouRest: 'and sign in with the right account.',
    },
    // After "Link": the 6-digit code to send to the bot in a direct chat. `{bot}` is the channel's name.
    code: {
      title: 'Last step: send the code in the chat',
      slack: 'In Slack, open a direct message with {bot} and send this code from the account above.',
      teams: 'In Microsoft Teams, open a 1:1 chat with {bot} and send this code from the account above.',
      generic: 'In your chat app, open a direct message with {bot} and send this code from the account above.',
      bot: 'the bot',
      label: 'Your code',
      valid: 'Valid for {time}',
      checking: 'Checking whether the code is still valid…',
      attempts: 'The bot accepts at most {count} attempts.',
      waiting: 'Waiting for the code in the chat…',
      warning: 'Only you should see this code. Never give it to anyone.',
      newCode: 'Get a new code',
      newCodeHint: 'Code not accepted, or too many attempts? A new code replaces this one.',
    },
    // Back on the page after confirming (a reload): the code is shown only once.
    waiting: {
      title: 'You already confirmed this link',
      body: 'The code is shown only once, so it cannot be shown again. Get a new code to finish: the previous code stops working.',
    },
    linked: {
      title: 'Linked',
      body: 'Go back to the chat. A message that was waiting for the link is being answered there, and you can keep writing to the bot.',
    },
    openConsole: 'Open Console',
    expired: {
      title: 'This link has expired',
      accent: 'expired',
      subtitle: 'Links work once and for {minutes} minutes.',
      body: 'Write to the bot in your chat again. It will send you a new link.',
    },
    used: {
      title: 'This link was already used',
      accent: 'already used',
      subtitle: 'Links work only once.',
      body: 'If you still need to link a chat account, write to the bot in your chat again. It will send you a new link.',
    },
    invalid: {
      title: 'This link is not valid',
      accent: 'not valid',
      subtitle: 'It may have been copied incompletely.',
      body: 'Write to the bot in your chat again to get a new link.',
    },
    otherTenant: {
      title: 'This link is for another workspace',
      accent: 'another workspace',
      subtitle: 'You are signed in to a different workspace.',
      // a colon, not a full stop: a company name often ends with one ("Beta Ltd.")
      body: 'This link is for {company}: sign out and sign in to that workspace.',
      bodyUnknown: 'This link belongs to another workspace. Sign out and sign in to the workspace of the bot.',
      signOut: 'Sign out',
    },
    unavailable: {
      title: 'Agent channels are not available',
      accent: 'not available',
      subtitle: 'This workspace does not use agents in chat.',
      body: 'Ask your administrator to turn on agent channels.',
    },
    blocked: {
      title: 'This account cannot be linked',
      accent: 'cannot be linked',
      subtitle: 'Your Console account cannot be used for this right now.',
      body: 'Contact your administrator.',
    },
    signedOut: {
      title: 'Your session ended',
      accent: 'ended',
      subtitle: 'Sign in again to continue with this link.',
      body: 'After you sign in you come back to this page.',
      action: 'Sign in',
    },
    loadFailed: {
      title: 'We could not check this link',
      accent: 'could not',
      subtitle: 'The server did not answer as expected.',
      body: 'Check your connection and try again.',
    },
    // Refusals of a confirmation, shown beside the buttons (the page stays as it is).
    errors: {
      rateLimited: 'Too many attempts. Try again in {seconds} seconds.',
      crossSite: 'Your browser says this request came from another site, so it was refused. Open the link directly in your browser and try again.',
      generic: 'Something went wrong. Try again.',
    },
  },
  // "Linked chat accounts" on My account.
  account: {
    title: 'Linked chat accounts',
    hint: 'When these accounts write to a Console agent, the agent works in your name.',
    columns: {
      platform: 'Platform',
      account: 'Account',
      channel: 'Channel',
      linked: 'Linked',
      actions: 'Actions',
    },
    noName: 'Unnamed chat account',
    workspaceSlack: 'Workspace {id}',
    workspaceTeams: 'Tenant {id}',
    lastSeen: 'Last seen {time}',
    unlink: 'Unlink',
    unlinkAria: 'Unlink {account}',
    confirm: {
      title: 'Unlink this chat account?',
      message: '{account} will no longer be linked to your Console account. Its next message to the bot asks to match or sign in again.',
    },
    unlinked: 'Chat account unlinked',
    empty: {
      title: 'No chat accounts linked yet',
      body: 'When you write to a Console agent in Slack or Teams, that chat account is linked and appears here.',
    },
    notes: {
      relink: 'After you unlink, the next message from that chat account asks to match or sign in again. Sending “logout” to the bot in chat does the same.',
      disabled: 'If your Console account is disabled, its links stop working and the agents do not answer.',
    },
    errors: {
      load: 'Your linked chat accounts could not be loaded.',
      unlink: 'The chat account could not be unlinked. Try again.',
      crossSite: 'Your browser says this request came from another site, so it was refused. Reload the page and try again.',
    },
  },
};
