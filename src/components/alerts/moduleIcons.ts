import {
  IconApps,
  IconBrain,
  IconBug,
  IconChartBar,
  IconChecklist,
  IconDatabase,
  IconPlug,
  IconRobot,
  IconServer,
  IconShieldCheck,
  IconTool,
  type Icon,
} from '@tabler/icons-react';
import { normalizeModule } from './alertCatalog';

const MODULE_ICONS: Record<string, Icon> = {
  agents: IconRobot,
  models: IconBrain,
  rag: IconDatabase,
  mcp: IconPlug,
  tools: IconTool,
  guardrails: IconShieldCheck,
  inference: IconServer,
  evaluation: IconChecklist,
  analysis: IconChartBar,
  redteam: IconBug,
  'ai-app-gateway': IconApps,
};

export function moduleIcon(module: string | undefined | null): Icon {
  const normalized = normalizeModule(module);
  return (normalized && MODULE_ICONS[normalized]) || IconApps;
}
