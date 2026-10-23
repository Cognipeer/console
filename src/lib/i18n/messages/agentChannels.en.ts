/**
 * Agent channels (Enterprise): agents answering in Slack and Microsoft Teams. The words every screen of the
 * feature shares (platforms, states, health and check codes, server refusals). Each screen keeps its own
 * strings in its own file (agentChannelsList / Setup / Deploy; the Link file is empty since the account-link flow was removed); all of them are spread into the
 * `agentChannels` namespace in `en.ts`.
 */
export const agentChannelsEn = {
  common: {
    title: 'Channels',
    platforms: {
      slack: 'Slack',
      teams: 'Microsoft Teams',
    },
    states: {
      draft: 'Setup not finished',
      connected: 'Connected',
      error: 'Error',
      waiting: 'Waiting for the first message',
      disabled: 'Disabled',
    },
    locales: {
      en: 'English',
      tr: 'Turkish',
    },
    agentStates: {
      ready: 'Ready',
      not_found: 'Agent deleted',
      inactive: 'Agent inactive',
      unpublished: 'Not published',
    },
    // Why a connection is in error (`health.code`). Unknown codes fall back to `health.message` / `unknown`.
    health: {
      unknown: 'Something went wrong. Verify the connection to see the details.',
      socket_disconnected: 'The Socket Mode connection to Slack is down. Console keeps trying to reconnect.',
      secrets_unavailable: 'The stored tokens cannot be read on this server. Enter them again.',
      invalid_auth: 'Slack rejected a token. Copy the tokens again and save them.',
      not_authed: 'Slack rejected a token. Copy the tokens again and save them.',
      token_revoked: 'A token was revoked in Slack. Create a new one and save it.',
      token_expired: 'A token expired. Create a new one and save it.',
      account_inactive: 'The Slack app or workspace is no longer active.',
      not_allowed_token_type: 'The app-level token is not an app-level token (xapp-…).',
      missing_scope: 'The app-level token needs the connections:write scope.',
      link_disabled: 'Socket Mode is turned off for this Slack app. Turn it on under Socket Mode.',
      service_principal_missing: 'The bot has no service principal in your Azure directory (AADSTS7000229).',
      invalid_secret: 'Azure rejected the client secret. Create a new one and save it.',
      secret_expired: 'The client secret expired. Create a new one and save it.',
      app_not_found: 'Azure does not know this App ID in this directory.',
      tenant_not_found: 'Azure does not know this Tenant ID.',
      token_failed: 'Azure did not issue a token for the bot.',
      network_error: 'The platform could not be reached from Console.',
    },
    // Platform checks of a credentials save / verify (`checks[].id`).
    checks: {
      bot_token: 'Bot token (xoxb-…)',
      app_token: 'App-level token (xapp-…)',
      socket: 'Socket Mode connection',
      scopes: 'Permissions (scopes)',
      same_app: 'Both tokens belong to the same app',
      app_id: 'App ID',
      tenant_id: 'Tenant ID',
      token: 'Token from Azure',
      passed: 'Passed',
      failed: 'Failed',
      unconfirmed: 'Not confirmed',
      // A check that passed only because Slack did not give what it needs (`code: 'unconfirmed'`), by `checks[].id`.
      unconfirmedWhy: {
        scopes: "Slack did not report the bot token's permissions, so they could not be checked.",
        same_app: 'Slack did not say which app each token belongs to, so this could not be checked.',
      },
    },
    // Why a check failed (`checks[].code`) when the health wording above does not fit; a failed verify also stores
    // the code as `health.code`.
    checkCodes: {
      invalid_guid: 'This must be a GUID such as 00000000-0000-0000-0000-000000000000.',
      missing_secret: 'Enter the client secret.',
      not_checked: 'Not checked: fix the fields above first.',
      chat_write_missing: 'The bot token lacks the chat:write permission, so it cannot post answers. Install the app again from the manifest.',
      app_mismatch: 'The two tokens belong to different Slack apps. Copy both from the same app.',
      invalid_socket_url: 'Slack returned an unexpected Socket Mode address.',
    },
    // Slack's warnings after a credentials check. The server sends English sentences (for API callers); the
    // screens match the known ones (_lib/ui/warnings.ts) and show the server's sentence for anything else.
    warnings: {
      emailScope: 'The users:read.email scope is missing: email matching stays off, so people cannot be matched to Console users.',
      scopeMissing: 'The {scope} scope is missing: {feature} will not work.',
      sameAppUnconfirmed: 'Could not confirm that both tokens belong to the same Slack app. Make sure you copied them from the same app.',
      features: {
        mentions: 'answering @mentions in channels',
        post: 'posting answers',
        dm: 'answering direct messages',
        people: 'looking people up (guest and workspace checks)',
        publicChannels: 'listing public channels when choosing where an agent answers',
        privateChannels: 'listing private channels when choosing where an agent answers',
      },
    },
    // Refusals of the admin API (`code`). Unknown codes show the server's own message.
    errors: {
      generic: 'Something went wrong. Try again.',
      enterpriseRequired: 'Channels needs an active Enterprise license.',
      sessionEnded: 'Your session ended. Sign in again.',
      loadFailed: 'The channels could not be loaded.',
      FORBIDDEN: 'Only a workspace owner or admin can manage channels.',
      NOT_FOUND: 'This channel no longer exists.',
      VALIDATION_ERROR: 'Check the highlighted field.',
      workspace_changed: 'These tokens belong to another Slack workspace or Azure app. A channel stays with the workspace it was set up for: create a new channel instead.',
      credentials_required: 'Save the credentials first.',
      credentials_unavailable: 'The stored credentials cannot be read. Enter them again.',
      credentials_not_verified: 'The credentials could not be verified, so the channel was not turned on.',
      not_active: 'A channel whose setup was never finished cannot be disabled.',
      platform_unavailable: 'The platform could not be reached. Try again in a moment.',
      // Slack refused the channel list with `missing_scope` (`platformCode`): the bot token's scopes, not the app-level token's.
      conversationsScope: 'The bot token lacks the channels:read and groups:read permissions, so Slack does not list the channels. Install the app again from the manifest.',
      agent_not_found: 'This agent no longer exists.',
      agent_not_published: 'Publish the agent first: channels always run the published version.',
      user_not_found: 'Some people on the list no longer exist.',
      group_not_found: 'Some groups on the list no longer exist.',
      immutable_field: 'The agent of a channel cannot be changed. Create a new channel for the other agent.',
      service_disabled: 'Channels are turned off on this installation.',
      invalid_identity: 'Every email domain must look like example.com.',
      invalid_credentials: 'Check the credentials you entered.',
    },
    actions: {
      save: 'Save',
      cancel: 'Cancel',
      close: 'Close',
      back: 'Back',
      next: 'Next',
      done: 'Done',
      retry: 'Try again',
      copy: 'Copy',
      copied: 'Copied',
      download: 'Download',
      verify: 'Verify',
      edit: 'Edit',
      remove: 'Remove',
      delete: 'Delete',
      openGuide: 'Open the setup guide',
    },
  },
};
