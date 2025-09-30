import type { Metadata } from "next";
import { Lexend_Deca } from "next/font/google";
import "@mantine/core/styles.css";
import "@mantine/notifications/styles.css";
import "mantine-datatable/styles.css";
import "./globals.css";
import { ColorSchemeScript, MantineProvider } from "@mantine/core";
import { Notifications } from "@mantine/notifications";
import { theme } from "@/theme/theme";
import { I18nProvider } from "@/lib/i18n";

const lexend = Lexend_Deca({
  variable: "--font-lexend",
  subsets: ["latin"],
  weight: ["100", "200", "300", "400", "500", "600", "700"],
  display: "swap",
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
    <html lang="en" suppressHydrationWarning>
      <head>
        <ColorSchemeScript defaultColorScheme="light" />
      </head>
      <body className={lexend.variable}>
        <MantineProvider theme={theme} defaultColorScheme="light">
          <I18nProvider locale="en">
            <Notifications position="top-right" />
            {children}
          </I18nProvider>
        </MantineProvider>
      </body>
    </html>
  );
}
