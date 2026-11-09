export interface SkillView {
  _id: string;
  key: string;
  title: string;
  header: string;
  body: string;
  minModelTier?: 'small' | 'large';
  status: 'active' | 'inactive';
  /** Who may use the skill in agent runs; absent on an older server, which reads as everyone. */
  access?: { mode: 'all' | 'selected'; userIds: string[]; groupIds: string[] };
  createdAt?: string;
  updatedAt?: string;
}
