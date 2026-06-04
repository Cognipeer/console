import type { Metadata } from "next";
import { Lexend_Deca, JetBrains_Mono } from "next/font/google";
import "@mantine/core/styles.css";
import '@mantine/dates/styles.css';
import "@mantine/notifications/styles.css";
import "./globals.css";
import { ColorSchemeScript, MantineProvider } from "@mantine/core";
import { Notifications } from "@mantine/notifications";
import { ReactQueryProvider } from "@/components/providers/ReactQueryProvider";
import LicenseErrorHandler from "@/components/providers/LicenseErrorHandler";
import { I18nProvider } from "@/lib/i18n";
import { theme } from "@/theme/theme";

const lexendDeca = Lexend_Deca({
  subsets: ["latin"],
  display: "swap",
  weight: ["300", "400", "500", "600", "700"],
  variable: "--font-lexend-deca",
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  display: "swap",
  weight: ["400", "500", "600"],
  variable: "--font-jetbrains-mono",
});

export const metadata: Metadata = {
  title: "Cognipeer Console",
  description: "Multi-tenant AI and agentic services platform",
  icons: {
    icon: [
      {
        url: '/images/cognipeer-icon.png',
        type: 'image/png',
        sizes: '128x128',
      },
    ],
    apple: [
      {
        url: '/images/cognipeer-icon.png',
        type: 'image/png',
        sizes: '128x128',
      },
    ],
    shortcut: '/images/cognipeer-icon.png',
  },
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
      className={`${lexendDeca.variable} ${jetbrainsMono.variable}`}
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
              {children}
            </ReactQueryProvider>
          </I18nProvider>
        </MantineProvider>
      </body>
    </html>
  );
}
