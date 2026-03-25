import { createTheme, MantineColorsTuple, MantineThemeOverride, rem } from '@mantine/core';

const tealPalette: MantineColorsTuple = [
  '#e6fbfa',
  '#c9f3f1',
  '#9ee9e5',
  '#70ded8',
  '#48d1ca',
  '#27c3bb',
  '#16b3ab',
  '#109d95',
  '#0d8680',
  '#0a706b',
];

const sharedFontStack =
  'var(--font-lexend-deca), "Segoe UI", -apple-system, BlinkMacSystemFont, Roboto, Helvetica, Arial, sans-serif';

export const designTokens = {
  spacing: {
    xs: rem(8),
    sm: rem(12),
    md: rem(16),
    lg: rem(24),
    xl: rem(32),
    xxl: rem(48),
  },
  radius: {
    xs: rem(8),
    sm: rem(12),
    md: rem(16),
    lg: rem(20),
    xl: rem(28),
  },
  shadow: {
    xs: '0 1px 2px rgba(15, 23, 42, 0.05), 0 8px 20px rgba(15, 23, 42, 0.04)',
    sm: '0 10px 30px rgba(15, 23, 42, 0.08), 0 2px 10px rgba(15, 23, 42, 0.04)',
    md: '0 18px 40px rgba(15, 23, 42, 0.12), 0 6px 16px rgba(15, 23, 42, 0.06)',
  },
  motion: {
    fast: '120ms',
    base: '180ms',
    slow: '260ms',
  },
  layout: {
    headerHeight: 68,
    docsAsideWidth: 560,
    authMaxWidth: rem(1180),
  },
} as const;

const componentDefaults: MantineThemeOverride['components'] = {
  Button: {
    defaultProps: {
      radius: 'md',
      size: 'sm',
    },
  },
  ActionIcon: {
    defaultProps: {
      radius: 'md',
      size: 'sm',
    },
  },
  Avatar: {
    defaultProps: {
      radius: 'md',
    },
  },
  Card: {
    defaultProps: {
      radius: 'lg',
      shadow: 'xs',
      withBorder: true,
    },
  },
  Paper: {
    defaultProps: {
      radius: 'lg',
      withBorder: true,
    },
  },
  Drawer: {
    defaultProps: {
      size: 'lg',
      position: 'right',
    },
  },
  Modal: {
    defaultProps: {
      centered: true,
      radius: 'lg',
      overlayProps: {
        backgroundOpacity: 0.45,
        blur: 6,
      },
    },
  },
  LoadingOverlay: {
    defaultProps: {
      overlayProps: { backgroundOpacity: 0.1 },
      loaderProps: {
        size: 25,
        color: 'var(--mantine-primary-color-6)',
        type: 'dots',
      },
    },
  },
  TextInput: {
    defaultProps: {
      radius: 'md',
      size: 'sm',
    },
  },
  PasswordInput: {
    defaultProps: {
      radius: 'md',
      size: 'sm',
    },
  },
  Select: {
    defaultProps: {
      radius: 'md',
      size: 'sm',
    },
  },
  Table: {
    defaultProps: {
      highlightOnHover: true,
      striped: 'odd',
      verticalSpacing: 'sm',
      horizontalSpacing: 'md',
    },
  },
  Menu: {
    defaultProps: {
      radius: 'lg',
      shadow: 'sm',
    },
  },
  Notification: {
    defaultProps: {
      radius: 'lg',
      withBorder: true,
    },
  },
  Tooltip: {
    defaultProps: {
      withArrow: true,
      transitionProps: { duration: 120 },
    },
  },
};

export const theme = createTheme({
  primaryColor: 'teal',
  colors: {
    teal: tealPalette,
  },
  primaryShade: 6,
  defaultGradient: {
    from: 'teal',
    to: 'cyan',
    deg: 135,
  },
  fontFamily: sharedFontStack,
  fontSizes: {
    xs: rem(12),
    sm: rem(14),
    md: rem(16),
    lg: rem(18),
    xl: rem(22),
  },
  headings: {
    fontFamily: sharedFontStack,
    fontWeight: '600',
    sizes: {
      h1: { fontSize: rem(40), lineHeight: '1.08' },
      h2: { fontSize: rem(32), lineHeight: '1.12' },
      h3: { fontSize: rem(24), lineHeight: '1.18' },
      h4: { fontSize: rem(20), lineHeight: '1.24' },
      h5: { fontSize: rem(18), lineHeight: '1.28' },
      h6: { fontSize: rem(16), lineHeight: '1.3' },
    },
  },
  spacing: designTokens.spacing,
  radius: designTokens.radius,
  shadows: designTokens.shadow,
  breakpoints: {
    xs: '36em',
    sm: '48em',
    md: '64em',
    lg: '75em',
    xl: '90em',
  },
  black: '#444',
  white: '#fff',
  defaultRadius: 'md',
  cursorType: 'pointer',
  components: componentDefaults,
});
