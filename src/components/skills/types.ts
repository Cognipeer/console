export interface SkillView {
  _id: string;
  key: string;
  title: string;
  header: string;
  body: string;
  minModelTier?: 'small' | 'large';
  status: 'active' | 'inactive';
  /** Present for a skill created inside an agent: only that agent uses and manages it. */
  owner?: { kind: 'agent'; agentId: string };
  createdAt?: string;
  updatedAt?: string;
}
