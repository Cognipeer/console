import { createTheme, MantineColorsTuple, MantineThemeOverride } from '@mantine/core';

const tealPalette: MantineColorsTuple = [
  '#b0fff6',
  '#a7fcf5',
  '#82eedf',
  '#07e3d0',
  '#01dac7',
  '#03c2b1',
  '#00b5a5',
  '#009689',
  '#007c70',
  '#005d52',
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
