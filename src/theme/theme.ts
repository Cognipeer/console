import { createTheme, MantineColorsTuple, MantineThemeOverride } from '@mantine/core';

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

const sharedFontStack = 'var(--font-lexend), "Lexend Deca", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';

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
      radius: 'md',
      shadow: 'sm',
      withBorder: true,
    },
  },
  Drawer: {
    defaultProps: {
      size: 'lg',
      position: 'right',
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
  Menu: {
    defaultProps: {
      radius: 'md',
    },
  },
};

export const theme = createTheme({
  primaryColor: 'teal',
  colors: {
    teal: tealPalette,
  },
  primaryShade: 6,
  fontFamily: sharedFontStack,
  headings: {
    fontFamily: sharedFontStack,
    fontWeight: '600',
  },
  black: '#444',
  white: '#fff',
  defaultRadius: 'md',
  cursorType: 'pointer',
  components: componentDefaults,
});
