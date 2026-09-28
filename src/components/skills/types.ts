export interface SkillView {
  _id: string;
  key: string;
  title: string;
  header: string;
  body: string;
  minModelTier?: 'small' | 'large';
  status: 'active' | 'inactive';
  createdAt?: string;
  updatedAt?: string;
}
