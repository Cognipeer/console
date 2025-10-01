export const en = {
  common: {
    appName: 'CognipeerAI Gateway',
    loading: 'Loading',
    error: 'Error',
    success: 'Success',
    status: {
      success: 'Success',
    },
  },
  layout: {
    brandTitle: '🚀 CognipeerAI Gateway',
    defaultUser: {
      name: 'User',
      email: 'user@example.com',
      license: 'FREE',
    },
  },
  navigation: {
    models: 'Models',
    agentTracing: 'Agent Tracing',
    settings: 'Settings',
  },
  notifications: {
    logoutSuccessTitle: 'Logged Out',
    logoutSuccessMessage: 'You have been logged out successfully',
    logoutErrorTitle: 'Error',
    logoutErrorMessage: 'Failed to logout',
    loginFailedTitle: 'Login Failed',
    invalidCredentials: 'Invalid credentials',
    loginSuccess: 'Login successful!',
    errorTitle: 'Error',
    loginGenericError: 'An error occurred during login',
    registrationFailedTitle: 'Registration Failed',
    registrationFailedMessage: 'Failed to create account',
    registrationSuccess: 'Account created successfully!',
    registrationGenericError: 'An error occurred during registration',
  },
  account: {
    menuLabel: 'Account',
    settings: 'Settings',
    logout: 'Logout',
  },
  breadcrumbs: {
    dashboard: 'Dashboard',
    tracing: 'Agent Tracing',
  models: 'Models',
    sessions: 'Sessions',
    agents: 'Agents',
    settings: 'Settings',
  },
  validation: {
    companySlugRequired: 'Company slug is required',
    invalidEmail: 'Invalid email',
    passwordMinLength: 'Password must be at least 8 characters',
    nameMinLength: 'Name must be at least 2 characters',
    companyNameMinLength: 'Company name must be at least 2 characters',
    passwordsDoNotMatch: 'Passwords do not match',
    tokenLabelMinLength: 'Label must be at least 3 characters',
    roleRequired: 'Please select a role',
  },
  login: {
    hero: {
      emoji: '🚀',
      title: 'Welcome Back',
      subtitle: 'Sign in to your CognipeerAI Gateway account',
    },
    form: {
      slug: {
        label: 'Company Slug',
        placeholder: 'acme-corporation',
        description: "Your company's unique identifier",
      },
      email: {
        label: 'Email',
        placeholder: 'your@email.com',
      },
      password: {
        label: 'Password',
        placeholder: 'Your password',
      },
      submit: 'Sign In',
    },
    footer: {
      cta: "Don't have an account?",
      link: 'Create account',
    },
  },
  register: {
    hero: {
      emoji: '🚀',
      title: 'Create Account',
      subtitle: 'Join CognipeerAI Gateway and access powerful AI services',
    },
    form: {
      name: {
        label: 'Full Name',
        placeholder: 'John Doe',
      },
      email: {
        label: 'Email',
        placeholder: 'your@email.com',
      },
      companyName: {
        label: 'Company Name',
        placeholder: 'Acme Corporation',
        description: "This will be used to create your company's unique URL",
      },
      password: {
        label: 'Password',
        placeholder: 'Create a password',
      },
      confirmPassword: {
        label: 'Confirm Password',
        placeholder: 'Confirm your password',
      },
      license: {
        label: 'License Type',
        placeholder: 'Select a license',
        options: {
          free: 'Free Tier',
          starter: 'Starter Plan',
          professional: 'Professional Plan',
          enterprise: 'Enterprise Plan',
        },
      },
      submit: 'Create Account',
    },
    footer: {
      cta: 'Already have an account?',
      link: 'Sign in',
    },
  },
  settings: {
    title: 'Settings',
    subtitle: 'Manage workspace members and API access tokens',
    tabs: {
      users: 'User Management',
      tokens: 'API Tokens',
    },
    userManagement: {
      header: {
        title: 'Team Members',
        subtitle: 'Manage users who have access to your organization',
      },
      actions: {
        invite: 'Invite User',
      },
      table: {
        name: 'Name',
        role: 'Role',
        joined: 'Joined',
        status: 'Status',
        actions: 'Actions',
        empty: 'No users found',
      },
      roles: {
        owner: 'Owner',
        admin: 'Admin',
        user: 'User',
      },
      status: {
        invited: 'Invited',
        active: 'Active',
        invitedAt: 'Invited at {date}',
      },
      errors: {
        fetch: 'Failed to fetch users',
        load: 'Failed to load users',
        delete: 'Failed to delete user',
      },
      messages: {
        deleteSuccess: 'User deleted successfully',
      },
      deleteModal: {
        title: 'Delete User',
        description: 'Are you sure you want to delete {name} ({email})? This action cannot be undone.',
        cancel: 'Cancel',
        confirm: 'Delete',
      },
    },
    tokenManagement: {
      header: {
        title: 'API Tokens',
        subtitle: 'Manage API tokens for programmatic access',
      },
      actions: {
        create: 'Create Token',
      },
      table: {
        label: 'Label',
        created: 'Created',
        lastUsed: 'Last Used',
        actions: 'Actions',
        empty: 'No API tokens found',
        never: 'Never',
      },
      copy: {
        copyToken: 'Copy token',
        copied: 'Copied!',
      },
      errors: {
        fetch: 'Failed to fetch tokens',
        load: 'Failed to load API tokens',
        delete: 'Failed to delete API token',
      },
      messages: {
        deleteSuccess: 'API token deleted successfully',
      },
      deleteModal: {
        title: 'Delete API Token',
        description: 'Are you sure you want to delete the token {label}? Applications using this token will lose access immediately.',
        cancel: 'Cancel',
        confirm: 'Delete',
      },
      createModal: {
        titles: {
          createToken: 'Create API Token',
          newToken: 'Your New API Token',
        },
        form: {
          label: 'Token Label',
          placeholder: 'Production API, Development, CI/CD, etc.',
          description: 'A friendly name to identify this token',
          submit: 'Create Token',
        },
        important: {
          title: 'Important!',
          message: "This is the only time you'll see this token. Make sure to copy it now!",
        },
        display: {
          label: 'Your API Token:',
        },
        copy: {
          copyToClipboard: 'Copy to clipboard',
          copied: 'Copied!',
        },
        usage: {
          instructions: 'Use this token in your API requests by adding it to the Authorization header:',
          example: 'Authorization: Bearer your-token',
        },
        actions: {
          copied: "I've Copied My Token",
        },
        errors: {
          create: 'Failed to create token',
        },
        messages: {
          createSuccess: 'API token created successfully',
        },
      },
    },
    inviteModal: {
      title: 'Invite User',
      form: {
        name: {
          label: 'Full Name',
          placeholder: 'John Doe',
        },
        email: {
          label: 'Email Address',
          placeholder: 'john@example.com',
        },
        role: {
          label: 'Role',
          placeholder: 'Select a role',
          options: {
            user: 'User — Basic access',
            admin: 'Admin — Full access except billing',
          },
        },
        submit: 'Send Invitation',
      },
      errors: {
        invite: 'Failed to invite user',
      },
      messages: {
        inviteSuccess: 'Invitation sent to {email}',
      },
    },
  },
  dashboard: {
    mockUser: {
      name: 'Demo User',
      email: 'demo@example.com',
      licenseType: 'PROFESSIONAL',
      features: {
        llmChat: 'LLM_CHAT',
        agentOrchestration: 'AGENT_ORCHESTRATION',
        analytics: 'ANALYTICS',
      },
    },
    hero: {
      title: 'Welcome back, {name}! 👋',
      subtitle: "Here's what's happening with your AI services today.",
    },
    stats: {
      apiRequests: 'API Requests',
      activeAgents: 'Active Agents',
      vectorStores: 'Vector Stores',
      llmCalls: 'LLM Calls',
    },
    recentActivity: {
      title: 'Recent Activity',
      table: {
        service: 'Service',
        endpoint: 'Endpoint',
        status: 'Status',
        time: 'Time',
      },
      items: {
        llmChat: {
          service: 'LLM Chat',
          timestamp: '2 min ago',
        },
        agentRun: {
          service: 'Agent Run',
          timestamp: '5 min ago',
        },
        vectorQuery: {
          service: 'Vector Query',
          timestamp: '12 min ago',
        },
        embeddings: {
          service: 'Embeddings',
          timestamp: '18 min ago',
        },
        analytics: {
          service: 'Analytics',
          timestamp: '25 min ago',
        },
      },
    },
    plan: {
      title: 'Your Plan',
      licenseLabel: 'License Type',
      featuresLabel: 'Active Features',
      upgradeCta: 'Upgrade Plan',
    },
  },
  models: {
    list: {
      subtitle: 'Manage orchestrated models and provider configurations',
      columns: {
        name: 'Model',
        provider: 'Provider',
        key: 'Key',
        modelId: 'Provider Model ID',
        capabilities: 'Capabilities',
        pricing: 'Pricing (per 1M tokens)',
        actions: 'Actions',
      },
      empty: 'No models have been added yet.',
      sections: {
        llm: 'Chat & Reasoning Models',
        embedding: 'Embedding Models',
      },
      pricing: {
        prompt: 'Input: {price} {currency}',
        completion: 'Output: {price} {currency}',
        cached: 'Cached: {price} {currency}',
      },
      badges: {
        llm: 'LLM',
        embedding: 'Embedding',
      },
      capabilities: {
        multimodal: 'Supports multi-modal inputs',
        tools: 'Supports tool/function calls',
      },
    },
    actions: {
      create: 'Create Model',
      refresh: 'Refresh',
      viewDetails: 'View details',
      edit: 'Edit model',
    },
    metrics: {
      totalModels: 'Total models',
      llmModels: 'LLM models',
      embeddingModels: 'Embedding models',
      providers: 'Providers',
    },
  },
  modelWizard: {
    title: 'Register a new model',
    subtitle: 'Connect provider credentials, configure pricing, and make this model available across your tenant.',
    steps: {
      provider: {
        label: 'Select provider',
        description: 'Choose which provider and model category you want to configure',
        selectProvider: 'Select your provider',
      },
      credentials: {
        label: 'Credentials',
        description: 'Add the credentials required to access this provider',
        noCredentials: 'This provider does not require additional credentials. Continue to the next step.',
      },
      configuration: {
        label: 'Configuration',
        description: 'Name your model, set pricing, and fine-tune capabilities',
        basicInfo: 'Basic information',
        capabilities: 'Capabilities',
      },
    },
    fields: {
      category: {
        label: 'Model category',
        description: 'This determines which workflows can consume the model.',
        options: {
          llm: 'Chat & reasoning model',
          embedding: 'Embedding model',
        },
      },
      name: {
        label: 'Model name',
        placeholder: 'E.g. Production Claude Sonnet',
      },
      key: {
        label: 'Model key',
        placeholder: 'auto-generated-from-name',
      },
      description: {
        label: 'Description',
        placeholder: 'Optional notes about usage, limits, or team ownership',
      },
      modelId: {
        label: 'Provider model ID',
        placeholder: 'anthropic.claude-3-5-sonnet-20241022-v1:0',
      },
      currency: {
        label: 'Billing currency',
      },
      pricing: {
        title: 'Pricing per 1M tokens',
        prompt: 'Input tokens',
        completion: 'Output tokens',
        cached: 'Cached tokens',
      },
      isMultimodal: {
        label: 'Supports multimodal inputs',
        description: 'Enable when the provider model accepts images or audio alongside text.',
      },
      supportsToolCalls: {
        label: 'Supports tool calls',
        description: 'Expose function/tool invocation in OpenAI-compatible APIs when available.',
      },
    },
    review: {
      title: 'Review configuration',
      subtitle: 'Double-check the key details before provisioning your model.',
      fields: {
        name: 'Model name',
        provider: 'Provider',
        modelId: 'Provider model ID',
        key: 'Model key',
        pricing: 'Pricing',
        modelDetails: 'Model details',
        capabilities: 'Capabilities',
      },
      autoGenerated: 'Will be generated automatically',
    },
    actions: {
      back: 'Back',
      next: 'Next',
      createModel: 'Create model',
    },
    notifications: {
      errorTitle: 'Something went wrong',
      loadProvidersError: 'Failed to load providers. Please try again later.',
      successTitle: 'Model created',
      successMessage: 'Your model is now available for use across the workspace.',
      genericError: 'An unexpected error occurred. Please try again.',
      pricingError: 'Pricing values cannot be negative.',
    },
    validation: {
      provider: 'Please choose a provider to continue.',
      name: 'Model name is required.',
      modelId: 'Provider model ID is required.',
    },
  },
  modelDetail: {
    actions: {
      backToList: 'Back to models',
      refresh: 'Refresh data',
      edit: 'Edit model',
    },
    notifications: {
      refreshedTitle: 'Data refreshed',
      refreshedMessage: 'Latest usage metrics and logs are now visible.',
      errorTitle: 'Unable to load model',
      errorMessage: 'We could not load the model detail. Please try again shortly.',
    },
    pricing: {
      title: 'Pricing per 1M tokens',
    },
    sections: {
      overview: 'Model overview',
      usage: 'Usage insights',
      settings: 'Provider settings',
      logs: 'Recent requests',
      timeseries: 'Usage over time',
    },
    fields: {
      key: 'Model key',
      provider: 'Provider',
      modelId: 'Provider model ID',
      createdAt: 'Created at',
      updatedAt: 'Last updated',
    },
    stats: {
      totalCalls: 'Total calls',
      successRate: 'Success rate',
      totalTokens: 'Total tokens',
      avgLatency: 'Average latency',
      cost: {
        title: 'Cost summary',
        total: 'Total cost: {amount}',
      },
      noUsage: 'No usage has been recorded for this model yet.',
    },
    timeseries: {
      period: 'Period',
      calls: 'Calls',
      tokens: 'Tokens',
      cost: 'Cost',
      empty: 'No usage recorded for the selected range.',
    },
    logs: {
      timestamp: 'Timestamp',
      route: 'Route',
      status: 'Status',
      latency: 'Latency',
      tokens: 'Tokens',
      success: 'Success',
      error: 'Error',
      empty: 'No requests have been logged yet.',
      tokenSummary: 'In: {input} • Out: {output}',
      viewAndEdit: 'Need to adjust credentials? Jump to the edit page.',
    },
    settings: {
      empty: 'No provider settings have been configured.',
    },
    errors: {
      notFound: 'We could not find this model.',
    },
  },
  modelEdit: {
    title: 'Edit {name}',
    subtitle: 'Update display information, pricing, and provider credentials.',
    sections: {
      credentials: 'Provider credentials',
    },
    actions: {
      backToDetail: 'Back to detail',
      reload: 'Reload',
      save: 'Save changes',
      cancel: 'Cancel',
    },
    notifications: {
      loadedTitle: 'Model loaded',
      loadedMessage: 'Latest model configuration ready to edit.',
      savedTitle: 'Model updated',
      savedMessage: 'Changes have been saved successfully.',
      errorTitle: 'Update failed',
      errorMessage: 'We could not apply your changes. Please try again.',
    },
    errors: {
      notFound: 'This model could not be found.',
    },
  },
};
