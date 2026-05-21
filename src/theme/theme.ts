import { createTheme, MantineColorsTuple, MantineThemeOverride, rem } from '@mantine/core';

// Cognipeer Design System teal scale (50 → 900) mapped to the Mantine 10-stop tuple.
// Shade 5 is the canonical accent (#0fba94); shade 6 is the strong/hover variant.
const tealPalette: MantineColorsTuple = [
  '#ecfdf6',
  '#d1faea',
  '#a4f3d5',
  '#6ce7bc',
  '#2fd49e',
  '#0fba94',
  '#0a9978',
  '#0a7b62',
  '#0b6151',
  '#0a4a40',
];

const sharedFontStack =
  'var(--font-lexend-deca), "Lexend Deca", ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';

const monoFontStack =
  'var(--font-jetbrains-mono), "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';

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
    xs: rem(6),
    sm: rem(8),
    md: rem(10),
    lg: rem(14),
    xl: rem(18),
  },
  shadow: {
    xs: '0 1px 0 rgba(20, 30, 40, 0.04), 0 1px 2px rgba(20, 30, 40, 0.04)',
    sm: '0 4px 12px rgba(20, 30, 40, 0.06), 0 1px 2px rgba(20, 30, 40, 0.04)',
    md: '0 24px 48px -16px rgba(20, 30, 40, 0.18), 0 2px 8px rgba(20, 30, 40, 0.06)',
  },
  motion: {
    fast: '150ms',
    base: '200ms',
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
  // Canonical accent is teal-500 (shade 5 in the tuple).
  primaryShade: 5,
  defaultGradient: {
    from: 'teal.5',
    to: 'teal.7',
    deg: 135,
  },
  fontFamily: sharedFontStack,
  fontFamilyMonospace: monoFontStack,
  fontSizes: {
    xs: rem(11.5),
    sm: rem(13),
    md: rem(15.5),
    lg: rem(17),
    xl: rem(20),
  },
  // Headings: display weight 500 (not 700) per Cognipeer DS — bold reads as a subtle emphasis.
  headings: {
    fontFamily: sharedFontStack,
    fontWeight: '500',
    sizes: {
      h1: { fontSize: rem(40), lineHeight: '1.06', fontWeight: '500' },
      h2: { fontSize: rem(28), lineHeight: '1.12', fontWeight: '500' },
      h3: { fontSize: rem(20), lineHeight: '1.35', fontWeight: '600' },
      h4: { fontSize: rem(15), lineHeight: '1.4', fontWeight: '600' },
      h5: { fontSize: rem(14), lineHeight: '1.4', fontWeight: '600' },
      h6: { fontSize: rem(13), lineHeight: '1.45', fontWeight: '600' },
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
  black: '#0c1118',
  white: '#ffffff',
  defaultRadius: 'sm',
  cursorType: 'pointer',
  components: componentDefaults,
});
