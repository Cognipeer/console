export {
  // Group operations
  createConfigGroup,
  updateConfigGroup,
  deleteConfigGroup,
  getConfigGroup,
  getConfigGroupByKey,
  getConfigGroupWithItems,
  listConfigGroups,
  countConfigGroups,
  // Item operations
  createConfigItem,
  updateConfigItem,
  deleteConfigItem,
  getConfigItem,
  getConfigItemById,
  listConfigItems,
  // Resolve & audit
  resolveConfigValues,
  listConfigAuditLogs,
  countConfigItems,
} from './configService';

export type {
  // Group types
  IConfigGroup,
  CreateConfigGroupRequest,
  UpdateConfigGroupRequest,
  ConfigGroupView,
  // Item types
  CreateConfigItemRequest,
  UpdateConfigItemRequest,
  ConfigItemView,
  // Resolve types
  ResolveConfigRequest,
  ResolvedConfigMap,
} from './types';
