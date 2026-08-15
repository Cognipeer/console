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

// Off-white neutral scale (light surfaces + text) per the DS.
// Used by every Mantine component that pulls var(--mantine-color-gray-N).
const grayPalette: MantineColorsTuple = [
  '#fbfbfa', // 0 — page bg
  '#f7f7f4', // 1
  '#f4f4f1', // 2 — chip wash
  '#efefea', // 3 — hairline
  '#e8e8e3', // 4 — border
  '#d9d9d2', // 5 — border-strong
  '#98a1ad', // 6 — text-faint
  '#6b7280', // 7 — text-muted
  '#4a5260', // 8 — text-soft (body)
  '#0c1118', // 9 — text
];

// Dark surfaces — Mantine convention is 0 = lightest text → 9 = darkest bg.
const darkPalette: MantineColorsTuple = [
  '#ecf1f6', // 0 — text
  '#b4bcc7', // 1 — text-soft
  '#8a939f', // 2 — text-muted
  '#5a6473', // 3 — text-faint
  '#2a323d', // 4 — border-strong
  '#1d242d', // 5 — border
  '#181e26', // 6 — hairline
  '#161c24', // 7 — soft surface
  '#11161d', // 8 — raised surface (cards, nav)
  '#0a0e13', // 9 — page bg
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

// A form row only reads as aligned when every column puts its control the
// same distance below its label. Mantine's stock part order (label →
// description → input) breaks that as soon as one field carries helper text
// and its neighbour doesn't: the described field's input drops by the height
// of the description, so two fields sharing a SimpleGrid/Grid row end up
// visibly staggered. Rendering helper text *under* the control instead makes
// label → input a fixed two-row block, so side-by-side fields line up whether
// or not they have a description — and a description that wraps to two lines
// can no longer push its own control out of line either.
export const FIELD_WRAPPER_ORDER = ['label', 'input', 'description', 'error'];

// Every Input.Wrapper-based control (@mantine/core + @mantine/dates),
// including ones no call site uses yet so the rule also holds for new forms.
// Mantine derives the gap between the control and its helper text from the
// order itself (--input-margin-top vs --input-margin-bottom), so nothing else
// needs restyling.
//
// Deliberately excludes the *.Group wrappers (Checkbox/Radio/Switch/Chip):
// there the description introduces the option list below it, and a group
// never has this column-alignment problem to begin with.
export const FIELD_CONTROLS = [
  'Autocomplete',
  'ColorInput',
  'FileInput',
  'JsonInput',
  'MultiSelect',
  'NativeSelect',
  'NumberInput',
  'PasswordInput',
  'PillsInput',
  'Select',
  'TagsInput',
  'Textarea',
  'TextInput',
  'DateInput',
  'DatePickerInput',
  'DateTimePicker',
  'MonthPickerInput',
  'TimeInput',
  'YearPickerInput',
];

// Merges FIELD_WRAPPER_ORDER into every field control without disturbing the
// defaults a control already declares above (radius/size).
export function withHelperTextBelowControl(
  defaults: MantineThemeOverride['components'],
): MantineThemeOverride['components'] {
  const merged = { ...defaults };

  for (const name of FIELD_CONTROLS) {
    merged[name] = {
      ...merged[name],
      defaultProps: {
        ...merged[name]?.defaultProps,
        inputWrapperOrder: FIELD_WRAPPER_ORDER,
      },
    };
  }

  return merged;
}

const explicitComponentDefaults: MantineThemeOverride['components'] = {
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

const componentDefaults = withHelperTextBelowControl(explicitComponentDefaults);

export const theme = createTheme({
  primaryColor: 'teal',
  colors: {
    teal: tealPalette,
    gray: grayPalette,
    dark: darkPalette,
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
