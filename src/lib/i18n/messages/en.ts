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
};
