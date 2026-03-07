import type { Metadata } from "next";
import { Lexend_Deca } from "next/font/google";
import "@mantine/core/styles.css";
import '@mantine/dates/styles.css';
import "@mantine/notifications/styles.css";
import "@mantine/spotlight/styles.css";
import "mantine-datatable/styles.css";
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
  variable: "--font-lexend-deca",
});

export const metadata: Metadata = {
  title: "CognipeerAI Gateway",
  description: "AI and Agentic Services Platform",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning className={lexendDeca.variable}>
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
