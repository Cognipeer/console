import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import "@mantine/core/styles.css";
import '@mantine/dates/styles.css';
import "@mantine/notifications/styles.css";
import "@mantine/charts/styles.css";
import "./globals.css";
import { ColorSchemeScript, MantineProvider } from "@mantine/core";
import { Notifications } from "@mantine/notifications";
import { ReactQueryProvider } from "@/components/providers/ReactQueryProvider";
import LicenseErrorHandler from "@/components/providers/LicenseErrorHandler";
import { I18nProvider } from "@/lib/i18n";
import { ConfirmProvider } from "@/components/common/confirm/ConfirmProvider";
import { theme } from "@/theme/theme";

// Self-hosted (OFL, see ./fonts/LICENSE-*): next/font/google downloads at build time and
// broke release builds whenever the fetch returned an unexpected response.
const lexendDeca = localFont({
  display: "swap",
  variable: "--font-lexend-deca",
  src: [
    { path: "./fonts/lexend-deca-latin-300-normal.woff2", weight: "300", style: "normal" },
    { path: "./fonts/lexend-deca-latin-400-normal.woff2", weight: "400", style: "normal" },
    { path: "./fonts/lexend-deca-latin-500-normal.woff2", weight: "500", style: "normal" },
    { path: "./fonts/lexend-deca-latin-600-normal.woff2", weight: "600", style: "normal" },
    { path: "./fonts/lexend-deca-latin-700-normal.woff2", weight: "700", style: "normal" },
  ],
});

const jetbrainsMono = localFont({
  display: "swap",
  variable: "--font-jetbrains-mono",
  src: [
    { path: "./fonts/jetbrains-mono-latin-400-normal.woff2", weight: "400", style: "normal" },
    { path: "./fonts/jetbrains-mono-latin-500-normal.woff2", weight: "500", style: "normal" },
    { path: "./fonts/jetbrains-mono-latin-600-normal.woff2", weight: "600", style: "normal" },
  ],
});

// latin-ext carries Turkish ğ Ğ ş Ş İ, which the latin files lack. The ext families must come
// FIRST in the font stacks (globals.css / theme.ts): next/font/local appends an Arial-based
// "<name> Fallback" face to every family it generates, and Arial has these glyphs, so with
// latin first they rendered in Arial and the ext files were never reached. unicode-range keeps
// the ext families to their own code points (same range Google Fonts serves for latin-ext), so
// all other text still uses the latin files, and adjustFontFallback is off so the ext families
// add no Arial face of their own. (next/font only accepts literal options, hence the repeated
// range string.)
const lexendDecaExt = localFont({
  display: "swap",
  variable: "--font-lexend-deca-ext",
  adjustFontFallback: false,
  declarations: [
    {
      prop: "unicode-range",
      value:
        "U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C0, U+2113, U+2C60-2C7F, U+A720-A7FF",
    },
  ],
  src: [
    { path: "./fonts/lexend-deca-latin-ext-300-normal.woff2", weight: "300", style: "normal" },
    { path: "./fonts/lexend-deca-latin-ext-400-normal.woff2", weight: "400", style: "normal" },
    { path: "./fonts/lexend-deca-latin-ext-500-normal.woff2", weight: "500", style: "normal" },
    { path: "./fonts/lexend-deca-latin-ext-600-normal.woff2", weight: "600", style: "normal" },
    { path: "./fonts/lexend-deca-latin-ext-700-normal.woff2", weight: "700", style: "normal" },
  ],
});

const jetbrainsMonoExt = localFont({
  display: "swap",
  variable: "--font-jetbrains-mono-ext",
  adjustFontFallback: false,
  declarations: [
    {
      prop: "unicode-range",
      value:
        "U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C0, U+2113, U+2C60-2C7F, U+A720-A7FF",
    },
  ],
  src: [
    { path: "./fonts/jetbrains-mono-latin-ext-400-normal.woff2", weight: "400", style: "normal" },
    { path: "./fonts/jetbrains-mono-latin-ext-500-normal.woff2", weight: "500", style: "normal" },
    { path: "./fonts/jetbrains-mono-latin-ext-600-normal.woff2", weight: "600", style: "normal" },
  ],
});

export const metadata: Metadata = {
  title: "Cognipeer Console",
  description: "Multi-tenant AI and agentic services platform",
  icons: {
    icon: [
      {
        url: '/images/cognipeer-icon-32.png',
        type: 'image/png',
        sizes: '32x32',
      },
      {
        url: '/images/cognipeer-icon.png',
        type: 'image/png',
        sizes: '128x128',
      },
    ],
    apple: [
      {
        url: '/images/cognipeer-icon-180.png',
        type: 'image/png',
        sizes: '180x180',
      },
    ],
    shortcut: '/images/cognipeer-icon-32.png',
  },
};

// Disables pinch-to-zoom on mobile/touch viewports (the app has its own
// responsive layouts, not a zoomable canvas).
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${lexendDeca.variable} ${lexendDecaExt.variable} ${jetbrainsMono.variable} ${jetbrainsMonoExt.variable}`}
    >
      <head>
        <ColorSchemeScript defaultColorScheme="light" />
      </head>
      <body className={lexendDeca.className}>
        <MantineProvider theme={theme} defaultColorScheme="light">
          <I18nProvider locale="en">
            <ReactQueryProvider>
              <Notifications position="top-right" />
              <LicenseErrorHandler />
              <ConfirmProvider>{children}</ConfirmProvider>
            </ReactQueryProvider>
          </I18nProvider>
        </MantineProvider>
      </body>
    </html>
  );
}
