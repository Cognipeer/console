'use client';

import { Container, Paper, Stack, Text, Title } from '@mantine/core';
import { ReactNode } from 'react';
import classes from './AuthShell.module.css';

interface AuthShellProps {
  title: string;
  subtitle: string;
  children: ReactNode;
  footer?: ReactNode;
}

export default function AuthShell({ title, subtitle, children, footer }: AuthShellProps) {
  return (
    <div className={classes.page}>
      <Container size="lg" className={classes.container}>
        <div className={classes.shell}>
          <Stack className={classes.intro}>
            <Text className={classes.brand}>Cognipeer Console</Text>
            <Stack gap="md">
              <Title order={1} className={classes.introTitle}>
                {title}
              </Title>
              <Text size="lg" c="dimmed" className={classes.introText}>
                {subtitle}
              </Text>
            </Stack>
          </Stack>

          <Paper p={{ base: 'lg', sm: 'xl' }} className={classes.panel}>
            <Stack gap="md">
              {children}
              {footer ? <div className={classes.footer}>{footer}</div> : null}
            </Stack>
          </Paper>
        </div>
      </Container>
    </div>
  );
}