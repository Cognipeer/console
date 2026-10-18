import type { ComponentType } from 'react';
import {
  IconBinoculars, IconBooks, IconCalendarEvent, IconChartBar, IconDatabase, IconDeviceDesktopCog, IconFileInvoice,
  IconFlame, IconGitPullRequest, IconHeadset, IconInbox, IconLanguage, IconMail, IconNews, IconNotes, IconReceiptRefund,
  IconRobot, IconRoute, IconScale, IconTargetArrow, IconTelescope, IconTestPipe, IconTransform, IconUsers, IconWriting,
} from '@tabler/icons-react';

const ICONS: Record<string, ComponentType<{ size?: number; stroke?: number }>> = {
  IconBinoculars, IconBooks, IconCalendarEvent, IconChartBar, IconDatabase, IconDeviceDesktopCog, IconFileInvoice,
  IconFlame, IconGitPullRequest, IconHeadset, IconInbox, IconLanguage, IconMail, IconNews, IconNotes, IconReceiptRefund,
  IconRoute, IconScale, IconTargetArrow, IconTelescope, IconTestPipe, IconTransform, IconUsers, IconWriting,
};

/** The icon a template names (a `@tabler/icons-react` component); the robot when the name is not known here. */
export function TemplateIcon({ name, size = 18 }: { name: string; size?: number }) {
  const Icon = ICONS[name] ?? IconRobot;
  return <Icon size={size} stroke={1.7} />;
}
